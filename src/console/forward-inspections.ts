import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { BotRecord } from './contracts.js';
import type { ForwardInspectionView, PluginJobView, PluginSettings } from '../plugin-contract.js';
import type { ForwardNsfwConfig } from '../plugins/forward-nsfw/config.js';
import type { NapcatSendResult } from '../transport-protocol.js';
import type { NsfwClassificationCache } from '../plugins/forward-nsfw/inspect.js';
import { ConsoleInspectionCache } from './inspection-cache.js';

export const FORWARD_NSFW_PLUGIN = 'forward-nsfw';
export interface InspectionSample { sourceKey: string; attachmentId?: string; }
interface InspectionData {
  view: ForwardInspectionView; samples: InspectionSample[]; resolved: boolean;
  connectionId: string; accountId: string;
}
interface Row {
  id: string; bot_id: string; source_message_id: string; config_revision: number; state: string;
  expires_at: number; inspection_cipher: string; notification_state: string | null; notification_cipher: string | null; error?: string | null;
}
interface Host {
  requireBot(id: string): BotRecord; encrypt(value: unknown): string; decrypt(value: string): unknown;
  configuration(botId: string): { enabled: boolean; revision: number; settings: PluginSettings };
  change(botId: string, type: string): void;
  transaction<T>(fn: () => T): T;
  recordReply(notification: InspectionNotification, result: Extract<NapcatSendResult, {ok: true}>): void;
}
export interface InspectionJob {
  id: string; botId: string; sourceMessageId: string; expiresAt: number;
  config: ForwardNsfwConfig; samples: InspectionSample[];
}
export interface InspectionNotification {
  kind: 'notification'; contextPolicy: 'chat'; deliveryId: string; text: string; replyTo: string;
  jobId: string; botId: string; expiresAt: number;
  result?: NapcatSendResult;
}

/** Only acknowledged reminder text becomes a chat fact; inspection data remains private. */
export class ConsoleForwardInspections {
  private readonly cache: ConsoleInspectionCache;
  constructor(private readonly db: DatabaseSync, private readonly host: Host) {
    this.cache = new ConsoleInspectionCache(db, host);
    const columns = db.prepare('PRAGMA table_info(plugin_jobs)').all() as Array<{name: string}>;
    for (const name of ['inspection_cipher', 'notification_state', 'notification_cipher']) {
      if (!columns.some(column => column.name === name)) db.exec(`ALTER TABLE plugin_jobs ADD COLUMN ${name} TEXT`);
    }
    if (!columns.some(column => column.name === 'inspection_released')) db.exec('ALTER TABLE plugin_jobs ADD COLUMN inspection_released INTEGER NOT NULL DEFAULT 0');
    db.exec("CREATE INDEX IF NOT EXISTS plugin_inspection_queue ON plugin_jobs(state,created_at) WHERE operation='inspect';");
  }
  private row(id: string): Row | undefined {
    return this.db.prepare("SELECT * FROM plugin_jobs WHERE id=? AND operation='inspect'").get(id) as unknown as Row | undefined;
  }
  private data(row: Row): InspectionData { return this.host.decrypt(row.inspection_cipher) as InspectionData; }
  private config(row: Row): ForwardNsfwConfig | null {
    const bot = this.host.requireBot(row.bot_id), conf = this.host.configuration(row.bot_id);
    if (bot.targetType !== 'group' || bot.desiredState !== 'running' || !conf.enabled || conf.revision !== row.config_revision
      || this.data(row).connectionId !== bot.connectionId) return null;
    return conf.settings as ForwardNsfwConfig;
  }
  begin(botId: string, messageId: string, accountId: string, now = Date.now()): {id: string; maxImages: number; minImages: number; expiresAt: number} | null {
    const bot = this.host.requireBot(botId), conf = this.host.configuration(botId);
    if (!conf.enabled || bot.targetType !== 'group' || bot.desiredState !== 'running') return null;
    const existing = this.db.prepare("SELECT * FROM plugin_jobs WHERE bot_id=? AND plugin_id=? AND source_message_id=? AND operation='inspect'")
      .get(botId, FORWARD_NSFW_PLUGIN, messageId) as unknown as Row | undefined;
    const config = conf.settings as ForwardNsfwConfig;
    if (existing) {
      if (existing.state !== 'resolving' || !this.config(existing) || existing.expires_at <= now) return null;
      return {id: existing.id, maxImages: config.maxImages, minImages: config.minImages, expiresAt: existing.expires_at};
    }
    const count = this.db.prepare("SELECT COUNT(*) AS n FROM plugin_jobs WHERE operation='inspect' AND state IN ('resolving','queued','running')").get() as {n: number};
    if (count.n >= 1000) return null;
    const id = randomUUID(), expiresAt = now + Math.min(10 * 60_000, 120_000 + Math.ceil(config.maxImages / 2) * config.timeoutSeconds * 1000);
    const data: InspectionData = {resolved: false, connectionId: bot.connectionId, accountId, samples: [],
      view: {messageCount: 0, imageMessageCount: 0, imageCount: 0, ratioPercent: 0, sampledCount: 0, checkedCount: 0, structuralComplete: false, outcome: 'pending'}};
    this.db.prepare(`INSERT INTO plugin_jobs(id,bot_id,plugin_id,source_message_id,operation,resource_key,resource_cipher,config_revision,command_kind,automatic,state,created_at,expires_at,inspection_cipher)
      VALUES(?,?,?,?,'inspect','forward',?,?,'inspect',1,'resolving',?,?,?)`)
      .run(id, botId, FORWARD_NSFW_PLUGIN, messageId, this.host.encrypt(null), conf.revision, now, expiresAt, this.host.encrypt(data));
    this.host.change(botId, 'plugin.inspection');
    return {id, maxImages: config.maxImages, minImages: config.minImages, expiresAt};
  }
  complete(id: string, summary: {messageCount: number; imageMessageCount: number; imageCount: number; structuralComplete: boolean; samples: readonly InspectionSample[]}): void {
    const row = this.row(id); if (!row || row.state !== 'resolving') return;
    const data = this.data(row), config = this.config(row);
    data.resolved = true;
    data.samples = summary.samples.map(({sourceKey, attachmentId}) => ({sourceKey, ...(attachmentId ? {attachmentId} : {})}));
    const ratioPercent = summary.messageCount ? summary.imageMessageCount * 100 / summary.messageCount : 0;
    const reason = !config ? 'PLUGIN_CONFIGURATION_CHANGED' : !summary.structuralComplete ? 'FORWARD_INCOMPLETE'
      : !summary.imageCount ? 'NO_IMAGES' : summary.imageCount < config.minImages ? 'IMAGE_COUNT_BELOW_THRESHOLD' : undefined;
    data.view = {messageCount: summary.messageCount, imageMessageCount: summary.imageMessageCount, imageCount: summary.imageCount,
      structuralComplete: summary.structuralComplete, ratioPercent, sampledCount: summary.samples.length, checkedCount: 0,
      outcome: reason ? 'skipped' : 'pending', ...(reason ? {reason} : {})};
    this.db.prepare('UPDATE plugin_jobs SET inspection_cipher=?,state=?,finished_at=? WHERE id=?')
      .run(this.host.encrypt(data), reason ? 'completed' : 'queued', reason ? Date.now() : null, id);
    this.host.change(row.bot_id, 'plugin.inspection');
  }
  recover(): void {
    this.db.prepare("UPDATE plugin_jobs SET state='queued' WHERE operation='inspect' AND state='running'").run();
  }
  active(id: string, now = Date.now()): boolean {
    const row = this.row(id); return !!row && ['queued', 'running', 'resolving'].includes(row.state) && row.expires_at > now && !!this.config(row);
  }
  claim(excludedBots: ReadonlySet<string>, now = Date.now()): InspectionJob | null {
    const rows = this.db.prepare("SELECT * FROM plugin_jobs WHERE operation='inspect' AND state IN ('resolving','queued','running') ORDER BY created_at,id LIMIT 1000").all() as unknown as Row[];
    for (const row of rows) {
      const config = this.config(row);
      if (!config || row.expires_at <= now) { this.cancel(row.id, config ? 'PLUGIN_JOB_EXPIRED' : 'PLUGIN_CONFIGURATION_CHANGED'); continue; }
      if (row.state !== 'queued' || excludedBots.has(row.bot_id)) continue;
      if (!this.db.prepare("UPDATE plugin_jobs SET state='running',attempts=attempts+1 WHERE id=? AND state='queued'").run(row.id).changes) continue;
      return {id: row.id, botId: row.bot_id, sourceMessageId: row.source_message_id, expiresAt: row.expires_at, config, samples: this.data(row).samples};
    }
    return null;
  }
  classificationCache(botId: string): NsfwClassificationCache { return this.cache.forBot(botId); }
  finish(id: string, scores: Array<{sourceKey: string; score: number}>, reason?: string, now = Date.now(),
    details?: Pick<ForwardInspectionView, 'failures' | 'requestCount' | 'cacheHits' | 'preparedCacheHits'>): void {
    const row = this.row(id); if (!row || row.state !== 'running') return;
    const config = this.config(row); if (!config || row.expires_at <= now) { this.cancel(id, config ? 'PLUGIN_JOB_EXPIRED' : 'PLUGIN_CONFIGURATION_CHANGED'); return; }
    const data = this.data(row), detected = scores.some(item => item.score >= config.nsfwThresholdPercent / 100);
    data.view = {...data.view, ...details, checkedCount: scores.length, scores, outcome: detected ? 'detected' : scores.length ? 'not_detected' : 'unknown',
      ...(reason ? {reason} : {})};
    const notification: InspectionNotification | null = detected ? {kind: 'notification', contextPolicy: 'chat', jobId: id, botId: row.bot_id,
      deliveryId: `plugin:${id}:notification`, text: config.warningText, replyTo: row.source_message_id, expiresAt: row.expires_at} : null;
    this.db.prepare("UPDATE plugin_jobs SET state=?,finished_at=?,error=?,inspection_cipher=?,notification_state=?,notification_cipher=? WHERE id=?")
      .run(scores.length ? 'completed' : 'failed', now, scores.length ? null : reason ?? 'NSFW_NO_VALID_IMAGES', this.host.encrypt(data),
        notification ? 'pending' : null, notification ? this.host.encrypt(notification) : null, id);
    this.host.change(row.bot_id, 'plugin.inspection');
  }
  cancel(id: string, reason: string): void {
    const row = this.row(id); if (!row || !['resolving', 'queued', 'running'].includes(row.state)) return;
    const data = this.data(row); data.view = {...data.view, outcome: 'skipped', reason};
    this.db.prepare("UPDATE plugin_jobs SET state='cancelled',finished_at=?,error=?,inspection_cipher=? WHERE id=?")
      .run(Date.now(), reason, this.host.encrypt(data), id);
    this.host.change(row.bot_id, 'plugin.inspection');
  }
  view(id: string): ForwardInspectionView | undefined {
    const row = this.row(id); if (!row) return undefined;
    const view = this.data(row).view;
    return row.state === 'cancelled' && view.outcome === 'pending' ? {...view, outcome: 'skipped', reason: row.error ?? 'PLUGIN_CONFIGURATION_CHANGED'} : view;
  }
  retention(): Array<{botId: string; consumer: string}> {
    return (this.db.prepare("SELECT id,bot_id FROM plugin_jobs WHERE operation='inspect' AND inspection_released=0 AND state NOT IN ('resolving','queued','running') LIMIT 1000").all() as Array<{id: string; bot_id: string}>)
      .map(row => ({botId: row.bot_id, consumer: row.id}));
  }
  released(id: string): void { this.db.prepare('UPDATE plugin_jobs SET inspection_released=1 WHERE id=?').run(id); }
  pendingNotifications(): InspectionNotification[] {
    const rows = this.db.prepare("SELECT * FROM plugin_jobs WHERE operation='inspect' AND notification_state IN ('pending','sending') ORDER BY created_at,id LIMIT 100").all() as unknown as Row[];
    return rows.map(row => this.host.decrypt(row.notification_cipher!) as InspectionNotification);
  }
  notificationAllowed(id: string, accountId?: string): boolean {
    const row = this.row(id); if (!row || !['pending', 'sending'].includes(row.notification_state ?? '') || !this.config(row) || row.expires_at <= Date.now()) return false;
    return accountId === undefined || this.data(row).accountId === accountId;
  }
  startNotification(id: string): void { this.db.prepare("UPDATE plugin_jobs SET notification_state='sending' WHERE id=? AND notification_state='pending'").run(id); }
  finishNotification(id: string, result: NapcatSendResult): void {
    this.host.transaction(() => {
      const row = this.row(id); if (!row?.notification_cipher || !['pending', 'sending'].includes(row.notification_state ?? '')) return;
      const value = this.host.decrypt(row.notification_cipher) as InspectionNotification; value.result = result;
      this.db.prepare('UPDATE plugin_jobs SET notification_state=?,notification_cipher=? WHERE id=?')
        .run(result.ok ? 'acknowledged' : result.deliveryStatus, this.host.encrypt(value), id);
      if(result.ok)this.host.recordReply(value,result);
      this.host.change(row.bot_id, 'plugin.delivery');
    });
  }
  deliveries(id: string): PluginJobView['deliveries'] {
    const row = this.row(id); if (!row?.notification_state || !row.notification_cipher) return [];
    const notification = this.host.decrypt(row.notification_cipher) as InspectionNotification;
    const gateway = this.db.prepare('SELECT state,result_cipher FROM napcat_deliveries WHERE bot_id=? AND delivery_id=?')
      .get(row.bot_id, notification.deliveryId) as {state: string; result_cipher: string | null} | undefined;
    const result = gateway?.result_cipher ? this.host.decrypt(gateway.result_cipher) as NapcatSendResult : notification.result;
    const status = result ? result.ok ? 'acknowledged' : result.deliveryStatus : gateway?.state === 'started' ? 'sending' : gateway?.state === 'unconfirmed' ? 'unconfirmed' : row.notification_state;
    return [{kind: 'notification', status: status as PluginJobView['deliveries'][number]['status'],
      ...(result?.ok && result.messageId ? {messageId: result.messageId} : {}), ...(!result?.ok && result?.code ? {code: result.code} : {})}];
  }
}
