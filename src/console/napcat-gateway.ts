import { createHash } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { isMp3Snapshot } from '../audio.js';
import { fingerprint, logEvent } from '../logging.js';
import { isSegmentMessage } from '../messages.js';
import { NapCatClient } from '../napcat.js';
import { NAPCAT_MEDIA_MAX_BYTES, NAPCAT_SSE_MAX_BYTES, isNapcatSendResult, type NapcatChannelStatus, type NapcatOutgoingMessage, type NapcatSendRequest, type NapcatSendResult } from '../transport-protocol.js';
import type { Logger, OutgoingDeliveryMetadata, RecallResult } from '../types.js';
import type { NapcatConnectionRecord } from './contracts.js';
import type { ConsoleDatabase } from './database.js';
import { FORWARD_LIMITS } from '../forward-contract.js';
import { resolveForwardContents } from '../forward-resolver.js';
import type { ForwardJob } from './incoming-forwards.js';
import { ForwardInspectionCollector } from '../forward-inspection.js';
import { runIdentity } from '../run-control-contract.js';

export interface NapcatGatewayOptions {
  db: ConsoleDatabase; logger: Logger;
  canDeliver?: (botId: string) => boolean;
  maxConcurrentSends?: number; heartbeatMs?: number; healthIntervalMs?: number; shutdownTimeoutMs?: number;
}
export interface NapcatConnectionStatus {
  connected: boolean; online: boolean; accountId: string | null; error?: string; lastProbeAt: number | null;
}
interface Upstream {
  config: NapcatConnectionRecord; client: NapCatClient; retiring: boolean; status: NapcatConnectionStatus; probing: boolean;
  controller: AbortController; timer: ReturnType<typeof setInterval>;
}
interface Stream {
  botId: string; response: ServerResponse; inFlight: number | null; lastStatus: string;
  supportsRecall:boolean;
  timer: ReturnType<typeof setInterval>;
}
interface SendJob { botId: string; deadline: number; resolve: () => void; reject: () => void; timer: ReturnType<typeof setTimeout> }

const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const id = (value: unknown): string | null => typeof value === 'string' && value.length > 0 && value.length <= 200 ? value
  : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : null;
const failed = (code: string, deliveryStatus: 'failed' | 'unconfirmed' = 'failed'): NapcatSendResult => ({ ok: false, code, deliveryStatus });

/** A single upstream per connection resource; workers retain all conversation policy. */
export class NapcatGateway {
  private readonly db: ConsoleDatabase;
  private readonly upstreams = new Map<string, Upstream>();
  private readonly streams = new Map<string, Stream>();
  private readonly sending = new Map<string, Promise<NapcatSendResult>>();
  private readonly recalling=new Map<string,Promise<RecallResult>>();
  private readonly recallDeadlines=new Map<string,number>();
  private readonly deliveryConnections = new Map<string, string>();
  private readonly deliveryDeadlines = new Map<string, number>();
  private readonly deliveryBytes = new Map<string, number>();
  private readonly routes = new Map<string, string[]>();
  private readonly sendControllers = new Set<AbortController>();
  private readonly activeBots = new Set<string>();
  private readonly sendQueue: SendJob[] = [];
  private activeSends = 0;
  private closing = false;
  private reconciling: Promise<void> | null = null;
  private readonly forwardJobs = new Map<string, {connectionId: string; done: Promise<void>}>();
  private readonly forwardFetches = new Map<string, {expires: number; promise: Promise<unknown>}>();
  private readonly unsubscribeForwards: () => void;
  private forwardsScheduled = false;

  constructor(private readonly options: NapcatGatewayOptions) {
    this.db = options.db;
    this.db.forwards.recover();
    this.unsubscribeForwards = this.db.forwards.subscribe(() => this.scheduleForwards());
    const recovered = this.db.recoverNapcatDeliveries();
    if (recovered) logEvent(options.logger, 'warn', 'console.napcat.deliveries_recovered', { count: recovered });
  }

  reconcile(): Promise<void> {
    if (this.closing) return Promise.resolve();
    if (this.reconciling) return this.reconciling;
    this.reconciling = this.reconcileConnections().finally(() => { this.reconciling = null; });
    return this.reconciling;
  }

  private async reconcileConnections(): Promise<void> {
    this.routes.clear();
    for (const bot of this.db.listBots()) {
      if (bot.desiredState !== 'running') continue;
      const key = `${bot.connectionId}:${bot.targetType}:${bot.targetId}`;
      const bots = this.routes.get(key) ?? []; bots.push(bot.id); this.routes.set(key, bots);
    }
    const resources = this.db.listNapcatConnections();
    const configured = new Map(resources.filter(connection => connection.enabled).map(connection => [connection.id, connection]));
    for (const [connectionId, upstream] of this.upstreams) {
      const next = configured.get(connectionId);
      if (next && next.wsUrl === upstream.config.wsUrl && next.token === upstream.config.token
        && next.reconnectSeconds === upstream.config.reconnectSeconds && next.actionTimeout === upstream.config.actionTimeout) {
        upstream.config = next; continue;
      }
      upstream.retiring = true;
      const deliveries = [...this.sending].filter(([key]) => this.deliveryConnections.get(key) === connectionId);
      const recalls=[...this.recalling].filter(([key])=>this.db.getBot(key.slice(0,key.indexOf(':')))?.connectionId===connectionId);
      const pending = [...deliveries.map(([,value])=>value),...recalls.map(([,value])=>value)];
      if (pending.length) {
        logEvent(this.options.logger, 'info', 'console.napcat.connection_draining', { connection_id: connectionId, pending_count: pending.length });
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([Promise.allSettled(pending), new Promise<void>(resolve => {
          const deadline = Math.max(...deliveries.map(([key]) => this.deliveryDeadlines.get(key)!),...recalls.map(([key])=>this.recallDeadlines.get(key)!));
          timer = setTimeout(resolve, Math.max(0, deadline - Date.now()) + 1000);
        })]);
        if (timer) clearTimeout(timer);
      }
      this.upstreams.delete(connectionId);
      clearInterval(upstream.timer); upstream.controller.abort();
      await upstream.client.stop();
      this.publishStatuses();
    }
    for (const config of configured.values()) {
      if (this.closing || this.upstreams.has(config.id)) continue;
      const controller = new AbortController();
      const upstream = {
        config, controller, probing: false, retiring: false,
        status: { connected: false, online: false, accountId: null, lastProbeAt: null },
      } as Upstream;
      const logger: Logger = Object.fromEntries((['info', 'warn', 'error'] as const).map(level => [level,
        (message: string) => this.options.logger[level](`${message} connection_id=${JSON.stringify(config.id)}`),
      ])) as unknown as Logger;
      upstream.client = new NapCatClient({
        url: config.wsUrl, token: config.token ?? '', target: { type: 'private', id: '0' }, logger,
        reconnectMs: config.reconnectSeconds * 1000, actionTimeoutMs: config.actionTimeout * 1000,
        onEvent: event => this.receive(config.id, event),
        onConnectionChange: connected => {
          if (this.upstreams.get(config.id) !== upstream) return;
          upstream.status.connected = connected; upstream.status.online = false;
          if (!connected) upstream.status.error = 'NAPCAT_CONNECTION_UNAVAILABLE';
          this.publishStatuses();
          if (connected) void this.probe(upstream);
        },
      });
      upstream.timer = setInterval(() => { void this.probe(upstream); }, this.options.healthIntervalMs ?? 15000);
      upstream.timer.unref();
      this.upstreams.set(config.id, upstream);
      upstream.client.start();
      logEvent(this.options.logger, 'info', 'console.napcat.connection_started', { connection_id: config.id, revision: config.revision });
    }
    for (const stream of this.streams.values()) { this.publishStatus(stream); this.pump(stream); }
  }

  private async probe(upstream: Upstream): Promise<void> {
    if (this.closing || upstream.probing || !upstream.client.connected) return;
    upstream.probing = true;
    try {
      const [status, login] = await Promise.all([
        upstream.client.inspect('get_status', upstream.controller.signal),
        upstream.client.inspect('get_login_info', upstream.controller.signal),
      ]);
      if (this.upstreams.get(upstream.config.id) !== upstream) return;
      const accountId = id(object(login)?.user_id);
      if (!accountId) throw new Error('NAPCAT_LOGIN_UNAVAILABLE');
      try { this.db.bindNapcatAccount(upstream.config.id, accountId); }
      catch { throw new Error('NAPCAT_ACCOUNT_TARGET_CONFLICT'); }
      upstream.status.accountId = accountId;
      this.scheduleForwards();
      upstream.status.online = object(status)?.online === true && object(status)?.good !== false;
      upstream.status.error = upstream.status.online ? undefined : 'NAPCAT_QQ_OFFLINE';
    } catch (error) {
      if (this.upstreams.get(upstream.config.id) !== upstream) return;
      upstream.status.online = false;
      upstream.status.error = error instanceof Error && ['NAPCAT_LOGIN_UNAVAILABLE', 'NAPCAT_ACCOUNT_TARGET_CONFLICT'].includes(error.message)
        ? error.message : 'NAPCAT_HEALTH_CHECK_FAILED';
      logEvent(this.options.logger, 'warn', 'console.napcat.health_failed', { connection_id: upstream.config.id, code: upstream.status.error });
    } finally {
      upstream.probing = false;
      upstream.status.lastProbeAt = Date.now();
      if (this.upstreams.get(upstream.config.id) === upstream) this.publishStatuses();
    }
  }

  getConnectionStatus(connectionId: string): NapcatConnectionStatus {
    const upstream = this.upstreams.get(connectionId);
    return upstream ? { ...upstream.status, connected: upstream.client.connected }
      : { connected: false, online: false, accountId: this.db.getNapcatConnection(connectionId)?.accountId ?? null, lastProbeAt: null };
  }

  getBotStatus(botId: string): NapcatChannelStatus & { channelConnected: boolean } {
    const bot = this.db.getBot(botId);
    const status = bot ? this.getConnectionStatus(bot.connectionId) : { connected: false, online: false };
    return { connected: status.connected, online: status.online, paused: !this.deliverable(botId), channelConnected: this.streams.has(botId) };
  }

  private deliverable(botId: string): boolean {
    if (this.closing) return false;
    if (this.options.canDeliver) return this.options.canDeliver(botId);
    const bot = this.db.getBot(botId);
    return bot?.desiredState === 'running' && this.db.getRuntime(botId).state !== 'stopped';
  }

  private receive(connectionId: string, event: unknown): void {
    const upstream = this.upstreams.get(connectionId);
    if (this.closing || !upstream?.client.connected || !upstream.status.accountId
      || upstream.status.error === 'NAPCAT_ACCOUNT_TARGET_CONFLICT') return;
    const packet = object(event);
    if(packet?.post_type==='notice'&&['group_recall','friend_recall'].includes(String(packet.notice_type))) {
      const messageId=id(packet.message_id),selfId=id(packet.self_id),authorId=id(packet.user_id),operatorId=id(packet.operator_id);
      if(!messageId||!authorId||selfId!==upstream.status.accountId||typeof packet.time!=='number'||!Number.isFinite(packet.time)||packet.time<0)return;
      const matches=this.db.listBots().filter(bot=>bot.connectionId===connectionId&&(
        packet.notice_type==='group_recall'?bot.targetType==='group'&&bot.targetId===id(packet.group_id):
        bot.targetType==='private'&&(bot.targetId===authorId||!!this.db.messageState.get(bot.id,messageId)?.registered)));
      // A private recall has no target field; ambiguous IDs must not cross private chats.
      if(packet.notice_type==='friend_recall'&&new Set(matches.map(bot=>bot.targetId)).size!==1)return;
      for(const bot of matches){
        const recalled=this.db.messageState.recalled(bot.id,messageId,packet.time,operatorId??undefined,authorId??undefined);
        if(!recalled)continue;
        this.db.publishRecalls(bot.id);
        const stream=this.streams.get(bot.id);if(stream)this.pump(stream);
        logEvent(this.options.logger,'info','console.napcat.message_recalled',{bot_id:bot.id,message_ref:fingerprint(messageId)});
      }return;
    }
    if (!packet || packet.post_type !== 'message' || !['group', 'private'].includes(String(packet.message_type))) return;
    const senderId = id(packet.user_id); const selfId = id(packet.self_id); const messageId = id(packet.message_id);
    if (!senderId || !messageId || senderId === selfId || selfId !== upstream.status.accountId) return;
    const targetId = id(packet.message_type === 'group' ? packet.group_id : packet.user_id);
    if (!targetId) return;
    const routes = this.routes.get(`${connectionId}:${packet.message_type}:${targetId}`) ?? [];
    for (const botId of routes) {
      const bot = this.db.getBot(botId);
      if (!bot || bot.connectionId !== connectionId || bot.desiredState !== 'running') continue;
      try {
        this.db.messageState.register(botId,messageId,senderId,'human');
        const previous = this.db.getNapcatQueueStats(botId);
        const seq = this.db.enqueueNapcatEvent(botId, event, `${connectionId}:${selfId}:${packet.message_type}:${targetId}:${messageId}`);
        if (seq === null) {
          const current = this.db.getNapcatQueueStats(botId);
          if (current.dropped > previous.dropped) logEvent(this.options.logger, 'warn', 'console.napcat.queue_overflow', {
            connection_id: connectionId, bot_id: botId, pending_count: current.pending, queued_bytes: current.bytes, dropped: current.dropped,
          });
          continue;
        }
        logEvent(this.options.logger, 'info', 'console.napcat.event_enqueued', { connection_id: connectionId, bot_id: botId, seq });
        const stream = this.streams.get(botId); if (stream) this.pump(stream);
      } catch {
        logEvent(this.options.logger, 'warn', 'console.napcat.event_dropped', { connection_id: connectionId, bot_id: botId });
      }
    }
  }

  /** Caller authenticates the Worker token before allowing a stream. */
  openStream(botId: string, request: FastifyRequest, reply: FastifyReply): void {
    if (!this.db.getBot(botId) || this.closing) throw new Error('实例不存在或网关正在关闭');
    const previous = this.streams.get(botId); if (previous) this.removeStream(previous);
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const stream = { botId, response, inFlight: null, lastStatus: '',supportsRecall:String(request.headers['x-nekodock-capabilities']??'').split(',').map(value=>value.trim()).includes('recall-v1') } as Stream;
    stream.timer = setInterval(() => {
      if (!this.writable(stream)) return;
      this.publishStatus(stream);
      if (!response.writableNeedDrain) response.write(': heartbeat\n\n');
      this.pump(stream);
    }, this.options.heartbeatMs ?? 5000);
    stream.timer.unref(); this.streams.set(botId, stream);
    request.raw.once('close', () => this.removeStream(stream));
    response.once('close', () => this.removeStream(stream));
    response.on('drain', () => this.pump(stream));
    this.publishStatus(stream); this.pump(stream);
    logEvent(this.options.logger, 'info', 'console.napcat.channel_opened', { bot_id: botId });
  }

  private writable(stream: Stream): boolean {
    if (this.streams.get(stream.botId) !== stream) return false;
    if (stream.response.destroyed || stream.response.writableEnded || stream.response.writableLength > NAPCAT_SSE_MAX_BYTES + 1024) {
      if (stream.response.writableLength > NAPCAT_SSE_MAX_BYTES + 1024) stream.response.destroy();
      this.removeStream(stream); return false;
    }
    return true;
  }
  private removeStream(stream: Stream): void {
    clearInterval(stream.timer);
    if (this.streams.get(stream.botId) === stream) this.streams.delete(stream.botId);
    if (!stream.response.destroyed && !stream.response.writableEnded) stream.response.end();
  }
  private publishStatuses(): void { for (const stream of this.streams.values()) this.publishStatus(stream); }
  private publishStatus(stream: Stream): void {
    if (!this.writable(stream) || stream.response.writableNeedDrain) return;
    const { channelConnected: _channel, ...status } = this.getBotStatus(stream.botId);
    const data = JSON.stringify(status);
    if (data !== stream.lastStatus) { stream.lastStatus = data; stream.response.write(`event: status\ndata: ${data}\n\n`); }
  }
  private pump(stream: Stream): void {
    if (!this.writable(stream) || stream.inFlight !== null || stream.response.writableNeedDrain || !this.deliverable(stream.botId)) return;
    const pending = this.db.pendingNapcatEvents(stream.botId, 1)[0];
    if (!pending) return;
    // Old Workers cannot ACK this event; leave it durable without blocking their drain.
    if(pending.recall&&!stream.supportsRecall)return;
    stream.inFlight = pending.seq;
    stream.response.write(`id: ${pending.seq}\nevent: ${pending.recall?'recall':pending.update ? 'content-update' : 'message'}\ndata: ${JSON.stringify(pending)}\n\n`);
  }

  private scheduleForwards(): void {
    if (this.closing || this.forwardsScheduled) return;
    this.forwardsScheduled = true;
    queueMicrotask(() => { this.forwardsScheduled = false; this.processForwards(); });
  }

  private processForwards(): void {
    if (this.closing) return;
    this.db.forwards.publishPending();
    for (const stream of this.streams.values()) this.pump(stream);
    const eligible = [...this.upstreams].filter(([connectionId, upstream]) => upstream.client.connected && upstream.status.accountId && !upstream.retiring
      && [...this.forwardJobs.values()].filter(active => active.connectionId === connectionId).length < FORWARD_LIMITS.concurrency).map(([connectionId]) => connectionId);
    for (const job of this.db.forwards.pending(eligible)) {
      const upstream = this.upstreams.get(job.connectionId);
      if (!upstream || !upstream.client.connected || !upstream.status.accountId || upstream.retiring) continue;
      if ([...this.forwardJobs.values()].filter(active => active.connectionId === job.connectionId).length >= FORWARD_LIMITS.concurrency) continue;
      if (!this.db.forwards.claim(job)) continue;
      const key = `${job.botId}:${job.messageId}`;
      const done = this.resolveForwardJob(job, upstream).catch(() => {
        if (this.closing || upstream.controller.signal.aborted) this.db.forwards.reset(job);
        else {
          const contents = (this.db.forwards.get(job.botId, job.messageId)?.contents ?? []).map(content => ({...content, status: 'failed' as const, nodes: [], error: '转发内容读取失败'}));
          this.db.forwards.complete(job, contents);
          logEvent(this.options.logger, 'warn', 'console.forward.resolve_failed', {bot_id: job.botId, message_ref: fingerprint(job.messageId)});
        }
      }).finally(() => { this.forwardJobs.delete(key); this.scheduleForwards(); });
      this.forwardJobs.set(key, {connectionId: job.connectionId, done});
    }
  }

  private async resolveForwardJob(job: ForwardJob, upstream: Upstream): Promise<void> {
    const started = Date.now();
    const inspection = this.db.plugins.inspections.begin(job.botId, job.messageId, job.accountId);
    const collector = inspection ? new ForwardInspectionCollector(inspection.maxImages, {sample: (added, removed) => {
      if (removed?.attachmentId) this.db.images.release(job.botId, removed.attachmentId, inspection.id);
      if (added.attachmentId && !this.db.images.pin(job.botId, added.attachmentId, inspection.id, inspection.expiresAt)) delete added.attachmentId;
    }}) : undefined;
    logEvent(this.options.logger, 'info', 'console.forward.resolve_started', {bot_id: job.botId, connection_id: job.connectionId, message_ref: fingerprint(job.messageId)});
    const contents = job.accountId && job.accountId !== upstream.status.accountId
      ? (this.db.forwards.get(job.botId, job.messageId)?.contents ?? []).map(content => ({...content, status: 'failed' as const, error: 'NapCat 登录账号已改变，无法读取此转发'}))
      : await resolveForwardContents(job.event, {
        signal: upstream.controller.signal, deadline: job.deadline,
        fetch: (resourceId, signal, deadline) => {
          const cacheKey = `${job.connectionId}:${upstream.status.accountId}:${resourceId}`;
          const cached = this.forwardFetches.get(cacheKey);
          if (cached && cached.expires > Date.now()) return cached.promise;
          for (const [key, value] of this.forwardFetches) if (value.expires <= Date.now()) this.forwardFetches.delete(key);
          const promise = upstream.client.getForwardMessage(resourceId, signal, deadline);
          this.forwardFetches.set(cacheKey, {expires: deadline, promise});
          return promise;
        },
        image: (sourceKey, source) => this.db.images.registerForwardSource(job.botId, job.messageId, sourceKey, source)?.id ?? null,
        ...(collector ? {observer: collector} : {}),
      });
    if (collector && inspection && job.accountId !== upstream.status.accountId) collector.incomplete('ACCOUNT_CHANGED');
    const summary = collector?.summary();
    if (summary && inspection && summary.structuralComplete && summary.imageCount >= inspection.minImages) {
      for (const sample of summary.samples) if (!sample.attachmentId && sample.source) {
        sample.attachmentId = this.db.images.registerInspectionSource(job.botId, job.messageId, sample.sourceKey, sample.source, inspection.id, inspection.expiresAt)?.id;
      }
    }
    this.db.forwards.complete(job, contents, () => { if (inspection && summary) this.db.plugins.inspections.complete(inspection.id, summary); });
    if (inspection && !this.db.plugins.inspections.active(inspection.id)) this.db.images.releaseConsumer(job.botId, inspection.id);
    logEvent(this.options.logger, 'info', 'console.forward.resolved', {bot_id: job.botId, message_ref: fingerprint(job.messageId), duration_ms: Date.now() - started,
      status: contents.every(content => content.status === 'ready') ? 'ready' : contents.some(content => content.nodes.length) ? 'partial' : 'failed'});
  }
  acknowledge(botId: string, seq: number): void {
    if (!Number.isSafeInteger(seq) || seq < 1) throw new Error('请求投递确认序号无效');
    if (seq <= this.db.napcatAcknowledgedSeq(botId)) return;
    const stream = this.streams.get(botId);
    if (!stream || seq !== stream.inFlight) throw new Error('请求投递确认序号无效');
    this.db.ackNapcatEvents(botId, seq); stream.inFlight = null;
    logEvent(this.options.logger, 'info', 'console.napcat.event_acknowledged', { bot_id: botId, seq });
    this.pump(stream);
  }

  async send(botId: string, input: unknown, guard?: () => boolean): Promise<NapcatSendResult> {
    const bot = this.db.getBot(botId);
    if (!bot || this.closing) return failed('NAPCAT_GATEWAY_UNAVAILABLE');
    const request = validateSend(input, bot.config.imageMaxMiB * 1024 * 1024, bot.config.ttsMaxMiB * 1024 * 1024, bot.targetType);
    if (!request) return failed('NAPCAT_INVALID_SEND_REQUEST');
    if(request.kind==='video'&&!this.db.pluginAssets.verifiesUrl(botId,request.file,this.db.getNapcatConnection(bot.connectionId)?.mediaBaseUrl??''))return failed('NAPCAT_INVALID_VIDEO_ASSET');
    const { deliveryId, deadline: requestedDeadline,metadata, ...message } = request;
    const resourceTimeout = request.kind==='video'?120_000:(this.db.getNapcatConnection(bot.connectionId)?.actionTimeout ?? 15) * 1000;
    const deadline = Math.min(requestedDeadline, Date.now() + resourceTimeout);
    const serialized = JSON.stringify({ connectionId: bot.connectionId, targetType: bot.targetType, targetId: bot.targetId, message,...(metadata?{metadata}:{}) });
    const hash = createHash('sha256').update(serialized).digest('hex');
    let claimed;
    try { claimed = this.db.beginNapcatDelivery(botId, deliveryId, hash); }
    catch { return failed('NAPCAT_DELIVERY_ID_CONFLICT'); }
    const key = `${botId}:${deliveryId}`;
    if (!claimed.created) {
      const pending = this.sending.get(key); if (pending) return pending;
      if (isNapcatSendResult(claimed.record.result)) return claimed.record.result;
      return failed('NAPCAT_SEND_UNCONFIRMED', 'unconfirmed');
    }
    if(metadata?.runId&&this.db.runControls.isCancelled(botId,metadata.runId)) {
      const result=failed('RUN_CANCELLED');
      this.db.finishNapcatDelivery(botId,deliveryId,'failed',result);return result;
    }
    const bytes = Buffer.byteLength(serialized);
    if (this.sending.size >= 128 || bytes + [...this.deliveryBytes.values()].reduce((total, size) => total + size, 0) > 64 * 1024 * 1024) {
      const result = failed('NAPCAT_SEND_QUEUE_FULL');
      this.db.finishNapcatDelivery(botId, deliveryId, 'failed', result); return result;
    }
    this.deliveryConnections.set(key, bot.connectionId); this.deliveryBytes.set(key, bytes);
    this.deliveryDeadlines.set(key, deadline);
    const attempt = this.sendAttempt(botId, deadline, message, bot.connectionId,metadata,guard).catch(() => failed('NAPCAT_SEND_UNCONFIRMED', 'unconfirmed'));
    this.sending.set(key, attempt);
    try {
      const result = await attempt;
      this.db.finishNapcatDelivery(botId, deliveryId, result.ok ? 'acknowledged' : result.deliveryStatus, result);
      logEvent(this.options.logger, result.ok ? 'info' : 'warn', 'console.napcat.delivery_finished', {
        bot_id: botId, delivery_id: deliveryId, outcome: result.ok ? 'acknowledged' : result.deliveryStatus, code: result.ok ? undefined : result.code,
      });
      return result;
    } finally { this.sending.delete(key); this.deliveryConnections.delete(key); this.deliveryDeadlines.delete(key); this.deliveryBytes.delete(key); }
  }

  private async sendAttempt(botId: string, deadline: number, message: NapcatOutgoingMessage, connectionId: string,metadata?:OutgoingDeliveryMetadata,guard?:()=>boolean): Promise<NapcatSendResult> {
    let acquired = false;
    try {
      await this.acquire(botId, deadline); acquired = true;
      if(metadata?.runId&&this.db.runControls.isCancelled(botId,metadata.runId))return failed('RUN_CANCELLED');
      if(guard&&!guard())return failed('PLUGIN_NOTIFICATION_CANCELLED');
      const bot = this.db.getBot(botId);
      if (!bot || this.db.getRuntime(botId).state === 'stopped') return failed('NAPCAT_INSTANCE_STOPPED');
      if (bot.connectionId !== connectionId) return failed('NAPCAT_BINDING_CHANGED');
      const upstream = this.upstreams.get(connectionId);
      if (upstream?.retiring) return failed('NAPCAT_CONNECTION_RECONFIGURING');
      if (!upstream?.status.online || !upstream.client.connected) return failed('NAPCAT_CONNECTION_UNAVAILABLE');
      if((message.kind==='text'||message.kind==='message')&&message.replyTo) {
        const validation=this.db.messageState.validate(botId,[message.replyTo]);if(!validation.ok)return failed(validation.code);
      }
      const effectiveDeadline = Math.min(deadline, Date.now() + (message.kind==='video'?120_000:upstream.config.actionTimeout * 1000));
      if (effectiveDeadline <= Date.now()) return failed('NAPCAT_SEND_DEADLINE_EXPIRED');
      const controller = new AbortController(); this.sendControllers.add(controller);
      try {
        const receipt = await upstream.client.sendTo({ type: bot.targetType, id: bot.targetId }, message, controller.signal, effectiveDeadline);
        if(receipt.messageId&&upstream.status.accountId)this.db.messageState.register(botId,receipt.messageId,upstream.status.accountId,metadata?'model':'system',metadata);
        return { ok: true, ...receipt };
      } catch (error) {
        const detail = object(error);
        return failed(typeof detail?.code === 'string' && /^NAPCAT_[A-Z_]+$/.test(detail.code) ? detail.code : 'NAPCAT_SEND_UNCONFIRMED',
          detail?.deliveryStatus === 'failed' ? 'failed' : 'unconfirmed');
      } finally { this.sendControllers.delete(controller); }
    } catch { return failed(this.closing ? 'NAPCAT_GATEWAY_UNAVAILABLE' : 'NAPCAT_SEND_DEADLINE_EXPIRED'); }
    finally { if (acquired) { this.activeSends--; this.activeBots.delete(botId); this.dispatch(); } }
  }

  validateQuotes(botId:string,input:unknown):{ok:true}|{ok:false;code:string;messageId?:string} {
    const ids=object(input)?.messageIds;
    if(!Array.isArray(ids)||ids.length>10||ids.some(value=>typeof value!=='string'||!value||value.length>200))return {ok:false,code:'QUOTE_TARGET_UNKNOWN'};
    return this.db.messageState.validate(botId,ids as string[]);
  }

  async recall(botId:string,input:unknown):Promise<RecallResult> {
    const body=object(input),messageRef=id(body?.messageRef),operationId=id(body?.operationId);
    if(!messageRef||!operationId||typeof body?.deadline!=='number'||!Number.isSafeInteger(body.deadline))return {messageRef:messageRef??'',status:'failed',parts:[],code:'NAPCAT_INVALID_RECALL_REQUEST'};
    const key=`${botId}:${operationId}`,active=this.recalling.get(key);if(active)return active;
    let claim;try{claim=this.db.messageState.beginOperation(botId,operationId,messageRef);}catch{return {messageRef,status:'failed',parts:[],code:'NAPCAT_RECALL_ID_CONFLICT'};}
    if(!claim.created)return claim.result as RecallResult??{messageRef,status:'unconfirmed',parts:[],code:'NAPCAT_RECALL_UNCONFIRMED'};
    const deadline=Math.min(body.deadline,Date.now()+120_000);
    const attempt=this.recallAttempt(botId,messageRef,deadline).catch(()=>({messageRef,status:'unconfirmed' as const,parts:[],code:'NAPCAT_RECALL_UNCONFIRMED'}));
    this.recalling.set(key,attempt);
    this.recallDeadlines.set(key,deadline);
    try{const result=await attempt;this.db.messageState.finishOperation(botId,operationId,result);return result;}
    finally{this.recalling.delete(key);this.recallDeadlines.delete(key);}
  }
  private async recallAttempt(botId:string,messageRef:string,deadline:number):Promise<RecallResult> {
    let acquired=false;
    const parts:RecallResult['parts']=[],events:NonNullable<RecallResult['events']>=[];
    try{
      await this.acquire(botId,deadline);acquired=true;
      const bot=this.db.getBot(botId),upstream=bot?this.upstreams.get(bot.connectionId):undefined;
      if(!bot||this.db.getRuntime(botId).state==='stopped'||!upstream?.status.online||!upstream.client.connected)return {messageRef,status:'failed',parts,code:'NAPCAT_CONNECTION_UNAVAILABLE'};
      if(upstream.retiring)return {messageRef,status:'failed',parts,code:'NAPCAT_CONNECTION_RECONFIGURING'};
      const rows=this.db.messageState.owned(botId,messageRef);
      if(!rows.length)return {messageRef,status:'failed',parts,code:'NAPCAT_RECALL_TARGET_UNKNOWN'};
      for(const row of rows){
        if(row.recalled){parts.push({messageId:row.message_id,partIndex:row.part_index,status:'already_recalled'});continue;}
        try{
          await upstream.client.recall(row.message_id,upstream.controller.signal,Math.min(deadline,Date.now()+upstream.config.actionTimeout*1000));
          const event=this.db.messageState.recalled(botId,row.message_id,Date.now()/1000,upstream.status.accountId??undefined,upstream.status.accountId??undefined);
          if(event)events.push(event);
          parts.push({messageId:row.message_id,partIndex:row.part_index,status:'recalled'});
        }catch(error){
          const confirmed=this.db.messageState.get(botId,row.message_id)?.recalled;
          const detail=object(error),code=typeof detail?.code==='string'?detail.code:'NAPCAT_RECALL_UNCONFIRMED';
          parts.push({messageId:row.message_id,partIndex:row.part_index,status:confirmed?'recalled':detail?.deliveryStatus==='failed'?'failed':'unconfirmed',...(!confirmed?{code}:{})});
        }
      }
      this.db.publishRecalls(botId);const stream=this.streams.get(botId);if(stream)this.pump(stream);
      const success=parts.filter(part=>part.status==='recalled'||part.status==='already_recalled').length;
      const status=success===parts.length?parts.every(part=>part.status==='already_recalled')?'already_recalled':'recalled':success?'partial':parts.some(part=>part.status==='unconfirmed')?'unconfirmed':'failed';
      logEvent(this.options.logger,'info','console.napcat.recall_finished',{bot_id:botId,message_ref:fingerprint(messageRef),status,part_count:parts.length});
      return {messageRef,status,parts,...(events.length?{events}:{})};
    }catch{return {messageRef,status:'failed',parts,code:'NAPCAT_RECALL_DEADLINE_EXPIRED'};}
    finally{if(acquired){this.activeSends--;this.activeBots.delete(botId);this.dispatch();}}
  }
  async probeMedia(connectionId:string,url:string):Promise<{reachable:boolean;error?:string}> {
    const upstream=this.upstreams.get(connectionId);if(!upstream?.status.online||!upstream.client.connected)return {reachable:false,error:'NAPCAT_CONNECTION_UNAVAILABLE'};
    try {const result=await upstream.client.downloadMediaProbe(url,AbortSignal.timeout(15000));return object(result)?.file?{reachable:true}:{reachable:false,error:'NAPCAT_MEDIA_PROBE_FAILED'};}
    catch{return {reachable:false,error:'NAPCAT_MEDIA_PROBE_FAILED'};}
  }

  private acquire(botId: string, deadline: number): Promise<void> {
    if (this.closing || Date.now() >= deadline || this.sendQueue.length >= 1000) return Promise.reject(new Error('Send unavailable'));
    return new Promise<void>((resolve, reject) => {
      const job: SendJob = { botId, deadline, resolve, reject: () => reject(new Error('Send expired')), timer: setTimeout(() => {
        const index = this.sendQueue.indexOf(job); if (index >= 0) this.sendQueue.splice(index, 1);
        job.reject(); this.dispatch();
      }, Math.min(2_147_483_647, Math.max(0, deadline - Date.now()))) };
      this.sendQueue.push(job); this.dispatch();
    });
  }
  private dispatch(): void {
    if (this.closing) return;
    while (this.activeSends < (this.options.maxConcurrentSends ?? 4)) {
      const index = this.sendQueue.findIndex(job => !this.activeBots.has(job.botId));
      if (index < 0) return;
      const job = this.sendQueue.splice(index, 1)[0]!; clearTimeout(job.timer);
      if (Date.now() >= job.deadline) { job.reject(); continue; }
      this.activeSends++; this.activeBots.add(job.botId); job.resolve();
    }
  }

  pendingSends(botId: string): number {
    return [...this.sending.keys(),...this.recalling.keys()].filter(key => key.startsWith(`${botId}:`)).length;
  }
  pendingInbound(botId: string): number { return this.streams.get(botId)?.inFlight === null || !this.streams.has(botId) ? 0 : 1; }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.unsubscribeForwards();
    for (const job of this.sendQueue.splice(0)) { clearTimeout(job.timer); job.reject(); }
    for (const stream of this.streams.values()) this.removeStream(stream);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.allSettled([...this.sending.values(),...this.recalling.values()]), new Promise<void>(resolve => {
      timer = setTimeout(resolve, this.options.shutdownTimeoutMs ?? 10000);
    })]);
    if (timer) clearTimeout(timer);
    for (const controller of this.sendControllers) controller.abort();
    await Promise.all([...this.upstreams.values()].map(async upstream => {
      clearInterval(upstream.timer); upstream.controller.abort(); await upstream.client.stop();
    }));
    await Promise.allSettled(this.sending.values());
    await Promise.allSettled([...this.forwardJobs.values()].map(job => job.done));
    this.forwardFetches.clear();
    this.upstreams.clear();
  }
}

function validateSend(input: unknown, imageMaxBytes: number, voiceMaxBytes: number, targetType: 'group' | 'private'): NapcatSendRequest | null {
  imageMaxBytes = Math.min(imageMaxBytes, NAPCAT_MEDIA_MAX_BYTES);
  const value = object(input);
  if (!value || typeof value.deliveryId !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(value.deliveryId)
    || typeof value.deadline !== 'number' || !Number.isSafeInteger(value.deadline) || value.deadline <= 0) return null;
  const kind = value.kind;
  const fields = kind === 'text' ? ['text', 'replyTo'] : kind === 'video' || kind === 'image' || kind === 'voice' ? ['file'] : kind === 'message' ? ['segments','replyTo'] : null;
  if (!fields || Object.keys(value).some(key => !['deliveryId', 'deadline', 'kind','metadata', ...fields].includes(key))) return null;
  if(value.metadata!==undefined){const meta=object(value.metadata);
    if(!meta||Object.keys(meta).some(key=>!['messageRef','conversationId','origin','logicalMessageIndex','partIndex','runId'].includes(key))||meta.origin!=='model'
      ||meta.runId!==undefined&&!runIdentity(meta.runId)
      ||!id(meta.messageRef)||!id(meta.conversationId)||!Number.isSafeInteger(meta.logicalMessageIndex)||(meta.logicalMessageIndex as number)<0
      ||!Number.isSafeInteger(meta.partIndex)||(meta.partIndex as number)<0)return null;
  }
  if (kind === 'text') return typeof value.text === 'string' && value.text.length > 0 && value.text.length <= 1000000
    && (value.replyTo === undefined || typeof value.replyTo === 'string' && value.replyTo.length > 0) ? value as NapcatSendRequest : null;
  if (kind === 'message') return targetType === 'group' && isSegmentMessage({ type: 'message', segments: value.segments })
    && JSON.stringify(value.segments).length <= 1000000 && (value.replyTo===undefined||!!id(value.replyTo)) ? value as NapcatSendRequest : null;
  if (kind === 'voice') return isMp3Snapshot(value.file) && Buffer.byteLength(value.file.slice(9), 'base64') <= voiceMaxBytes ? value as NapcatSendRequest : null;
  if(kind==='video')return typeof value.file==='string'&&value.file.length<=4096&&/^https?:\/\//u.test(value.file)?value as NapcatSendRequest:null;
  if (typeof value.file !== 'string' || !value.file.startsWith('base64://')) return null;
  const encoded = value.file.slice(9);
  if (!encoded || encoded.length > Math.ceil(imageMaxBytes / 3) * 4 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null;
  const bytes = Buffer.from(encoded, 'base64');
  return bytes.length <= imageMaxBytes && bytes.toString('base64') === encoded ? value as NapcatSendRequest : null;
}
