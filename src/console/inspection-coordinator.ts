import { setTimeout as delay } from 'node:timers/promises';
import { createNetworkClient } from '../network.js';
import { classifyImages, ForwardNsfwError } from '../plugins/forward-nsfw/inspect.js';
import { fingerprint, logEvent } from '../logging.js';
import type { Logger } from '../types.js';
import type { ConsoleDatabase } from './database.js';
import type { ConsoleImagePrefetch } from './incoming-images.js';
import type { NapcatGateway } from './napcat-gateway.js';
import type { InspectionJob, InspectionNotification } from './forward-inspections.js';
import { isNapcatSendResult } from '../transport-protocol.js';
import { InspectionRequestLimiter } from './inspection-request-limiter.js';
import { activity, withActivityReporter } from '../activity.js';
import type { ActivityEvent } from '../activity-contract.js';

/** This queue never uses the chat agent's busy flag or Worker context path. */
export class ForwardInspectionCoordinator {
  private readonly controller = new AbortController();
  private readonly active = new Map<string, {botId: string; controller: AbortController; done: Promise<void>}>();
  private readonly sending = new Map<string, Promise<void>>();
  private readonly requests = new InspectionRequestLimiter(2);
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  constructor(private readonly options: {db: ConsoleDatabase; images: ConsoleImagePrefetch; gateway: NapcatGateway; logger: Logger; fetch?: typeof globalThis.fetch; observe?:(job:InspectionJob,event:ActivityEvent)=>void}) {
    options.db.plugins.inspections.recover();
  }
  start(timers = true): void {
    if (timers && !this.timer) { this.timer = setInterval(() => this.tick(), 500); this.timer.unref(); }
    this.tick();
  }
  tick(): void {
    if (this.controller.signal.aborted || this.ticking) return;
    this.ticking = true;
    try {
      const {db} = this.options, store = db.plugins.inspections;
      for (const [id, flight] of this.active) if (!store.active(id)) flight.controller.abort();
      for (const item of store.retention()) { db.images.releaseConsumer(item.botId, item.consumer); store.released(item.consumer); }
      while (this.active.size < 2) {
        const job = store.claim(new Set([...this.active.values()].map(item => item.botId))); if (!job) break;
        const controller = new AbortController();
        const done = Promise.resolve().then(() => this.run(job, AbortSignal.any([controller.signal, this.controller.signal, AbortSignal.timeout(Math.max(1, job.expiresAt - Date.now()))])))
          .catch(() => logEvent(this.options.logger, 'warn', 'plugin.inspection.failed', {bot_id: job.botId, item_ref: job.id, code: 'PLUGIN_STORAGE_ERROR'}))
          .finally(() => { if (!store.active(job.id)) db.images.releaseConsumer(job.botId, job.id); this.active.delete(job.id); this.tick(); });
        this.active.set(job.id, {botId: job.botId, controller, done});
      }
      for (const notification of store.pendingNotifications()) {
        if (this.sending.size >= 2) break;
        if (this.sending.has(notification.jobId)) continue;
        const done = this.send(notification).catch(() => logEvent(this.options.logger, 'warn', 'plugin.notification.failed', {bot_id: notification.botId, code: 'PLUGIN_STORAGE_ERROR'}))
          .finally(() => { this.sending.delete(notification.jobId); });
        this.sending.set(notification.jobId, done);
      }
    } finally { this.ticking = false; }
  }
  private async run(job: InspectionJob, signal: AbortSignal): Promise<void> {
    return withActivityReporter(event=>this.options.observe?.(job,event),undefined,()=>activity('plugin','inspect',()=>this.runObserved(job,signal),signal));
  }
  private async runObserved(job: InspectionJob, signal: AbortSignal): Promise<void> {
    const {db, images, logger} = this.options, started = Date.now();
    const bot = db.getBot(job.botId); if (!bot) return;
    const client = createNetworkClient({enabled: bot.config.proxyEnabled, url: bot.config.proxyUrl, username: bot.config.proxyUsername,
      password: bot.config.proxyPassword, noProxy: bot.config.proxyNoProxy, forTools: true}, logger, 'plugin.inspection');
    const unavailable: Array<{sourceKey: string; code: string}> = [];
    const logFailures = (failures: Array<{sourceKey: string; code: string; httpStatus?: number}>) => {
      for (const failure of failures) logEvent(logger, 'warn', 'plugin.inspection.image_failed', {bot_id: job.botId, item_ref: job.id,
        source_ref: fingerprint(failure.sourceKey), code: failure.code, http_status: failure.httpStatus});
    };
    try {
      logEvent(logger, 'info', 'plugin.inspection.started', {bot_id: job.botId, item_ref: job.id, message_ref: fingerprint(job.sourceMessageId), image_count: job.samples.length});
      const pending = new Set(job.samples.filter(item => item.attachmentId).map(item => item.attachmentId!));
      const readable = new Set<string>();
      const imageDeadline = Math.min(job.expiresAt, Date.now() + 20_000);
      while (pending.size && Date.now() < imageDeadline) {
        signal.throwIfAborted();
        for (const id of pending) {
          const descriptor = db.images.get(job.botId, id);
          if (['failed', 'expired'].includes(descriptor.status)) { pending.delete(id); continue; }
          if (!['ready', 'transferred'].includes(descriptor.status)) continue;
          readable.add(id);
          pending.delete(id);
        }
        if (pending.size) await delay(100, undefined, {signal});
      }
      signal.throwIfAborted();
      if (!db.plugins.inspections.active(job.id)) return;
      unavailable.push(...job.samples.filter(sample => !sample.attachmentId || !readable.has(sample.attachmentId))
        .map(sample => ({sourceKey: sample.sourceKey, code: 'IMAGE_UNAVAILABLE'})));
      const candidates = job.samples.flatMap(sample => sample.attachmentId && readable.has(sample.attachmentId)
        ? [{sourceKey: sample.sourceKey, sha256: db.images.get(job.botId, sample.attachmentId).sha256,
          read: () => images.contentForConsumer(job.botId, sample.attachmentId!, job.id)}] : []);
      if (!candidates.length) throw new ForwardNsfwError('NSFW_NO_VALID_IMAGES');
      const result = await activity('model','model_request',()=>classifyImages(job.config, candidates, this.options.fetch ?? client.fetch, signal,
        db.plugins.inspections.classificationCache(job.botId), {acquireRequest: signal => this.requests.acquire(signal)}),signal);
      const failures = [...unavailable, ...result.failures];
      logFailures(failures);
      db.plugins.inspections.finish(job.id, result.scores, result.scores.length < job.samples.length ? 'PARTIAL_IMAGE_COVERAGE' : undefined,
        Date.now(), {failures, requestCount: result.requestCount, cacheHits: result.cacheHits, preparedCacheHits: result.preparedCacheHits});
      logEvent(logger, 'info', 'plugin.inspection.completed', {bot_id: job.botId, item_ref: job.id, image_count: job.samples.length,
        count: result.scores.length, outcome: db.plugins.inspections.view(job.id)?.outcome, duration_ms: Date.now() - started,
        bytes: result.requestBytes, request_count: result.requestCount, cache_hits: result.cacheHits,
        prepared_cache_hits: result.preparedCacheHits, failure_count: failures.length,
        input_tokens: result.usage?.inputTokens, output_tokens: result.usage?.outputTokens});
    } catch (error) {
      if (this.controller.signal.aborted) return;
      const code = signal.aborted ? 'PLUGIN_JOB_CANCELLED' : error instanceof ForwardNsfwError ? error.code : 'NSFW_NETWORK_ERROR';
      const failures = [...unavailable, ...(error instanceof ForwardNsfwError ? error.failures : [])];
      logFailures(failures);
      db.plugins.inspections.finish(job.id, [], code, Date.now(), error instanceof ForwardNsfwError
        ? {failures, requestCount: error.metrics?.requestCount, cacheHits: error.metrics?.cacheHits, preparedCacheHits: error.metrics?.preparedCacheHits}
        : {failures});
      logEvent(logger, 'warn', 'plugin.inspection.failed', {bot_id: job.botId, item_ref: job.id, code, duration_ms: Date.now() - started,
        ...(error instanceof ForwardNsfwError ? {http_status: error.httpStatus} : {})});
    } finally { await client.close(); }
  }
  private async send(notification: InspectionNotification): Promise<void> {
    const {db, gateway, logger} = this.options, store = db.plugins.inspections;
    const previous = db.getNapcatDelivery(notification.botId, notification.deliveryId);
    if (previous) {
      store.finishNotification(notification.jobId, isNapcatSendResult(previous.result) ? previous.result
        : {ok: false, code: 'NAPCAT_SEND_UNCONFIRMED', deliveryStatus: 'unconfirmed'});
      return;
    }
    const allowed = () => {
      const bot = db.getBot(notification.botId);
      const account = bot ? db.getNapcatConnection(bot.connectionId)?.accountId : undefined;
      return !!account && store.notificationAllowed(notification.jobId, account) && !db.messageState.get(notification.botId, notification.replyTo)?.recalled;
    };
    if (!allowed()) { store.finishNotification(notification.jobId, {ok: false, code: 'PLUGIN_NOTIFICATION_CANCELLED', deliveryStatus: 'failed'}); return; }
    store.startNotification(notification.jobId);
    const result = await gateway.send(notification.botId, {kind: 'text', text: notification.text, replyTo: notification.replyTo,
      deliveryId: notification.deliveryId, deadline: notification.expiresAt}, allowed);
    store.finishNotification(notification.jobId, result);
    logEvent(logger, result.ok ? 'info' : 'warn', 'plugin.notification.completed', {bot_id: notification.botId, item_ref: notification.jobId,
      outcome: result.ok ? 'acknowledged' : result.deliveryStatus, ...(result.ok ? {} : {code: result.code})});
  }
  async close(): Promise<void> {
    clearInterval(this.timer); this.controller.abort();
    await Promise.allSettled([...this.active.values()].map(item => item.done));
    await Promise.allSettled([...this.sending.values()]);
  }
}
