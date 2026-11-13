import { randomBytes, randomUUID, createCipheriv, createDecipheriv, createHmac, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { NAPCAT_EVENT_MAX_BYTES } from '../transport-protocol.js';
import { SECRET_FIELDS, type BotRecord, type BotSettings, type ConsoleEvent, type ConversationView, type ConversationUpdate, type DesiredState, type PublicBot, type RuntimeState, type Statistics, type WorkerHeartbeat, type WorkerSnapshot, type NapcatConnectionInput, type NapcatConnectionRecord, type PublicNapcatConnection, type NapcatQueuedEvent, type NapcatDeliveryRecord, type NapcatDeliveryState } from './contracts.js';
import { normalizeNapcatUrl, normalizeSettings, settingsToEnv, validateNapcatConnection, validateSettings } from './settings.js';
import { proxySecrets } from '../network.js';
import { ConsoleMemory } from './memory.js';
import { ScheduledTasks } from './scheduled-tasks.js';
import { ConsoleIncomingImages } from './incoming-images.js';
import { ConsoleIncomingForwards } from './incoming-forwards.js';
import type { ForwardSnapshot } from '../forward-contract.js';
import { ConsolePlugins } from './plugins.js';
import { ConsolePluginAssets } from './plugin-assets.js';
import { ConsoleMessageState } from './message-state.js';
import type { ChatRecallEvent } from '../chat-context-contract.js';
import { RunControls } from './run-controls.js';

export interface RuntimeRecord {
  state: RuntimeState; connected: boolean; processing: boolean; drained: boolean; lastHeartbeat: number | null; error?: string;
}
export interface ConsoleChange { seq: number; botId: string; type: string; time: number; payload: Record<string, unknown> }
interface BotRow {
  id: string; name: string; description: string; target_type: 'group' | 'private'; target_id: string; connection_id: string;
  desired_revision: number; applied_revision: number; desired_state: DesiredState; volume: string; worker_token: string;
  created_at: number; updated_at: number; imported: number; config_cipher: string;
}
interface RuntimeRow {
  state: RuntimeState; connected: number; processing: number; drained: number; last_heartbeat: number | null; error: string | null; conversation_id: string | null;
}
interface EventRow { worker_seq: number; type: string; time: number; conversation_id: string | null; run_id: string | null; item_id: string | null; payload: string }
interface ConnectionRow { media_base_url?:string; id: string; name: string; ws_url: string; token_cipher: string; reconnect_seconds: number; action_timeout: number; enabled: number; revision: number; account_id: string | null; created_at: number; updated_at: number; }
interface DeliveryRow { bot_id: string; delivery_id: string; payload_hash: string; state: NapcatDeliveryState; result_cipher: string | null; created_at: number; updated_at: number; }
export const NAPCAT_QUEUE_LIMITS = { messages: 1000, bytes: 32 * 1024 * 1024, retentionMs: 24 * 3600_000, dedupMessages: 10_000 } as const;

export class ConsoleDatabase {
  private readonly db: DatabaseSync;
  private readonly key: Buffer;
  readonly tasks: ScheduledTasks;
  readonly memory: ConsoleMemory;
  readonly images: ConsoleIncomingImages;
  readonly forwards: ConsoleIncomingForwards;
  readonly plugins: ConsolePlugins;
  readonly pluginAssets: ConsolePluginAssets;
  readonly messageState: ConsoleMessageState;
  readonly runControls: RunControls;

  constructor(path: string, keyPath: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    mkdirSync(dirname(keyPath), { recursive: true });
    if (!existsSync(keyPath)) {
      try { writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' }); }
      catch (error) { if (!existsSync(keyPath)) throw error; }
    }
    this.key = readFileSync(keyPath);
    if (this.key.length !== 32) throw new Error('控制台主密钥格式无效');
    chmodSync(keyPath, 0o600);
    this.db = new DatabaseSync(path);
    try {
      this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;`);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS napcat_connections (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, ws_url TEXT NOT NULL, token_cipher TEXT NOT NULL, endpoint_key TEXT NOT NULL UNIQUE,
          reconnect_seconds REAL NOT NULL, action_timeout REAL NOT NULL, enabled INTEGER NOT NULL, revision INTEGER NOT NULL,
          account_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS bots (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, target_type TEXT NOT NULL CHECK(target_type IN ('group','private')),
          target_id TEXT NOT NULL, desired_revision INTEGER NOT NULL, applied_revision INTEGER NOT NULL DEFAULT 0,
          desired_state TEXT NOT NULL CHECK(desired_state IN ('running','stopped')), volume TEXT NOT NULL UNIQUE,
          worker_token TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, imported INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS config_revisions (
          bot_id TEXT NOT NULL REFERENCES bots(id), revision INTEGER NOT NULL, config_cipher TEXT NOT NULL,
          created_at INTEGER NOT NULL, PRIMARY KEY(bot_id,revision)
        );
        CREATE TABLE IF NOT EXISTS runtime (
          bot_id TEXT PRIMARY KEY REFERENCES bots(id), state TEXT NOT NULL DEFAULT 'stopped', connected INTEGER NOT NULL DEFAULT 0,
          processing INTEGER NOT NULL DEFAULT 0, drained INTEGER NOT NULL DEFAULT 1, last_heartbeat INTEGER,
          error TEXT, conversation_id TEXT
        );
        CREATE TABLE IF NOT EXISTS operations (
          id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id), kind TEXT NOT NULL, phase TEXT NOT NULL,
          revision INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS conversations (
          bot_id TEXT NOT NULL REFERENCES bots(id), id TEXT NOT NULL, agent_session_id TEXT, started_at INTEGER NOT NULL,
          PRIMARY KEY(bot_id,id)
        );
        CREATE TABLE IF NOT EXISTS event_projection (
          bot_id TEXT NOT NULL REFERENCES bots(id), worker_seq INTEGER NOT NULL, type TEXT NOT NULL, time INTEGER NOT NULL,
          conversation_id TEXT, run_id TEXT, item_id TEXT, payload TEXT NOT NULL, PRIMARY KEY(bot_id,worker_seq)
        );
        CREATE INDEX IF NOT EXISTS event_conversation ON event_projection(bot_id,conversation_id,worker_seq);
        CREATE INDEX IF NOT EXISTS event_thinking ON event_projection(bot_id,conversation_id,run_id,item_id,worker_seq) WHERE type='thinking.updated';
        CREATE INDEX IF NOT EXISTS event_incoming_images ON event_projection(bot_id,conversation_id,json_extract(payload,'$.messageId'),worker_seq) WHERE type='message.images.updated';
        CREATE INDEX IF NOT EXISTS event_incoming_content ON event_projection(bot_id,conversation_id,json_extract(payload,'$.messageId'),worker_seq) WHERE type='message.content.updated';
        CREATE INDEX IF NOT EXISTS event_message_recalled ON event_projection(bot_id,conversation_id,json_extract(payload,'$.messageId'),worker_seq) WHERE type='message.recalled';
        CREATE INDEX IF NOT EXISTS event_delivery_request ON event_projection(bot_id,conversation_id,json_extract(payload,'$.requestId'),worker_seq) WHERE type='delivery.acknowledged';
        CREATE INDEX IF NOT EXISTS event_cancelled_request ON event_projection(bot_id,conversation_id,json_extract(payload,'$.requestId'),worker_seq) WHERE type='delivery.cancelled';
        CREATE INDEX IF NOT EXISTS event_quote_source ON event_projection(bot_id,conversation_id,json_extract(payload,'$.messageId'),worker_seq) WHERE type IN ('message.received','incoming','plugin.message.sent');
        CREATE TABLE IF NOT EXISTS counters (
          bot_id TEXT NOT NULL REFERENCES bots(id), kind TEXT NOT NULL, identity TEXT NOT NULL, time INTEGER NOT NULL,
          count INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(bot_id,kind,identity)
        );
        CREATE INDEX IF NOT EXISTS counter_time ON counters(bot_id,kind,time);
        CREATE TABLE IF NOT EXISTS changes (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT NOT NULL, type TEXT NOT NULL, time INTEGER NOT NULL, payload TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS napcat_inbound (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT NOT NULL REFERENCES bots(id), event_cipher TEXT NOT NULL,
          bytes INTEGER NOT NULL, created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS napcat_inbound_bot ON napcat_inbound(bot_id,seq);
        CREATE TABLE IF NOT EXISTS napcat_inbound_dedup (
          bot_id TEXT NOT NULL REFERENCES bots(id), dedup_key TEXT NOT NULL, created_at INTEGER NOT NULL,
          PRIMARY KEY(bot_id,dedup_key)
        );
        CREATE TABLE IF NOT EXISTS napcat_queue_state (
          bot_id TEXT PRIMARY KEY REFERENCES bots(id), acknowledged_seq INTEGER NOT NULL DEFAULT 0,
          dropped INTEGER NOT NULL DEFAULT 0, expired INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS napcat_deliveries (
          bot_id TEXT NOT NULL REFERENCES bots(id), delivery_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('started','acknowledged','failed','unconfirmed')),
          result_cipher TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(bot_id,delivery_id)
        );
      `);
      const connectionColumns=this.db.prepare('PRAGMA table_info(napcat_connections)').all() as Array<{name:string}>;
      if(!connectionColumns.some(c=>c.name==='media_base_url'))this.db.exec("ALTER TABLE napcat_connections ADD COLUMN media_base_url TEXT NOT NULL DEFAULT ''");
      const conversationColumns = this.db.prepare('PRAGMA table_info(conversations)').all() as Array<{name: string}>;
      if (!conversationColumns.some(column => column.name === 'agent_session_id')) this.db.exec('ALTER TABLE conversations ADD COLUMN agent_session_id TEXT');
      const inboundColumns = this.db.prepare('PRAGMA table_info(napcat_inbound)').all() as Array<{name: string}>;
      if (!inboundColumns.some(column => column.name === 'content_update')) this.db.exec('ALTER TABLE napcat_inbound ADD COLUMN content_update INTEGER NOT NULL DEFAULT 0');
      if (path !== ':memory:') chmodSync(path, 0o600);
      // Detect a missing/replaced master key before allowing updates to an existing database.
      const first = this.db.prepare('SELECT config_cipher FROM config_revisions LIMIT 1').get() as { config_cipher: string } | undefined;
      if (first) this.decrypt(first.config_cipher);
      const firstConnection = this.db.prepare('SELECT token_cipher FROM napcat_connections LIMIT 1').get() as {token_cipher: string} | undefined;
      if (firstConnection) this.decrypt(firstConnection.token_cipher);
      const botColumns = this.db.prepare('PRAGMA table_info(bots)').all() as Array<{name: string}>;
      if (!botColumns.some(column => column.name === 'connection_id')) this.db.exec('ALTER TABLE bots ADD COLUMN connection_id TEXT REFERENCES napcat_connections(id)');
      this.migrateNapcatConnections();
      this.messageState=new ConsoleMessageState(this.db,{requireBot:id=>this.requireBot(id),connection:id=>this.getNapcatConnection(id)});
      this.runControls=new RunControls(this.db,{requireBot:id=>this.requireBot(id),change:(id,type)=>this.change(id,type)});
      this.memory = new ConsoleMemory(this.db, {requireBot:id=>this.requireBot(id),encrypt:value=>this.encrypt(value),decrypt:value=>this.decrypt(value),transaction:fn=>this.transaction(fn),change:(id,type)=>this.change(id,type)});
      this.tasks = new ScheduledTasks(this.db, {
        requireBot: id => this.requireBot(id), encrypt: value => this.encrypt(value), decrypt: value => this.decrypt(value),
        transaction: fn => this.transaction(fn), change: (id, type) => this.change(id, type),
      });
      this.images = new ConsoleIncomingImages(this.db, {
        requireBot: id => this.requireBot(id), encrypt: value => this.encrypt(value), decrypt: value => this.decrypt(value),
        transaction: fn => this.transaction(fn),
      });
      this.forwards = new ConsoleIncomingForwards(this.db, {
        requireBot: id => this.requireBot(id), encrypt: value => this.encrypt(value), decrypt: value => this.decrypt(value),
        transaction: fn => this.transaction(fn), updated: (botId, snapshot) => this.enqueueForwardUpdate(botId, snapshot),
      });
      this.plugins = new ConsolePlugins(this.db,{requireBot:id=>this.requireBot(id),encrypt:value=>this.encrypt(value),decrypt:value=>this.decrypt(value),transaction:fn=>this.transaction(fn),change:(id,type)=>this.change(id,type)});
      this.pluginAssets = new ConsolePluginAssets(this.db,value=>createHmac('sha256',this.key).update('plugin-media\n'+value).digest('hex'));
    } catch (error) { this.db.close(); throw error; }
  }

  listNapcatConnections(): NapcatConnectionRecord[] {
    return (this.db.prepare('SELECT * FROM napcat_connections ORDER BY created_at,id').all() as unknown as ConnectionRow[]).map(row => this.connectionRecord(row));
  }

  getNapcatConnection(id: string): NapcatConnectionRecord | null {
    const row = this.db.prepare('SELECT * FROM napcat_connections WHERE id=?').get(id) as unknown as ConnectionRow | undefined;
    return row ? this.connectionRecord(row) : null;
  }

  getPublicNapcatConnection(id: string): PublicNapcatConnection | null {
    const connection = this.getNapcatConnection(id);
    if (!connection) return null;
    const { token, ...metadata } = connection;
    const botIds = (this.db.prepare('SELECT id FROM bots WHERE connection_id=? ORDER BY created_at,id').all(id) as Array<{id: string}>).map(row => row.id);
    return { ...metadata, tokenConfigured: Boolean(token), botIds };
  }

  listPublicNapcatConnections(): PublicNapcatConnection[] {
    return this.listNapcatConnections().map(connection => this.getPublicNapcatConnection(connection.id)!);
  }

  createNapcatConnection(input: NapcatConnectionInput): NapcatConnectionRecord {
    return this.transaction(() => this.insertNapcatConnection(input));
  }

  updateNapcatConnection(id: string, input: Partial<NapcatConnectionInput> & {expectedRevision?: number}): NapcatConnectionRecord {
    return this.transaction(() => {
      const current = this.requireConnection(id);
      if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision) throw new Error('连接配置版本冲突，请刷新后重试');
      const config = validateNapcatConnection(input, current);
      const changed = JSON.stringify(config) !== JSON.stringify({ name: current.name, wsUrl: current.wsUrl, token: current.token, reconnectSeconds: current.reconnectSeconds, actionTimeout: current.actionTimeout, enabled: current.enabled,...(current.mediaBaseUrl?{mediaBaseUrl:current.mediaBaseUrl}:{}) });
      if (!changed) return current;
      const endpointKey = this.connectionKey(config.wsUrl, config.token);
      if (this.db.prepare('SELECT 1 FROM napcat_connections WHERE endpoint_key=? AND id<>?').get(endpointKey, id)) throw new Error('相同 NapCat 地址和 Token 已有连接');
      this.db.prepare(`UPDATE napcat_connections SET name=?,ws_url=?,token_cipher=?,endpoint_key=?,reconnect_seconds=?,action_timeout=?,enabled=?,media_base_url=?,revision=revision+1,account_id=?,updated_at=? WHERE id=?`)
        .run(config.name, config.wsUrl, this.encrypt(config.token ?? ''), endpointKey, config.reconnectSeconds, config.actionTimeout, config.enabled ? 1 : 0, config.mediaBaseUrl??'', current.accountId, Date.now(), id);
      // Only the send deadline is also consumed by a Worker runtime. Other
      // resource changes are applied centrally without replacing its session.
      if (config.actionTimeout !== current.actionTimeout) {
        for (const bot of this.listBots().filter(candidate => candidate.connectionId === id)) {
          const revision = bot.desiredRevision + 1; const now = Date.now();
          this.db.prepare('INSERT INTO config_revisions(bot_id,revision,config_cipher,created_at) VALUES (?,?,?,?)').run(bot.id, revision, this.encrypt(this.managedSettings(bot.config)), now);
          this.db.prepare('UPDATE bots SET desired_revision=?,updated_at=? WHERE id=?').run(revision, now, bot.id);
          this.change(bot.id, 'bot.updated', {revision});
        }
      }
      this.change('', 'napcat.updated', { connectionId: id, revision: current.revision + 1 });
      return this.requireConnection(id);
    });
  }

  deleteNapcatConnection(id: string): void {
    this.transaction(() => {
      this.requireConnection(id);
      if (this.db.prepare('SELECT 1 FROM bots WHERE connection_id=? LIMIT 1').get(id)) throw new Error('NapCat 连接仍被实例引用，不能删除');
      this.db.prepare('DELETE FROM napcat_connections WHERE id=?').run(id);
      this.change('', 'napcat.deleted', { connectionId: id });
    });
  }

  /** Validate account ownership before the gateway accepts upstream events. */
  bindNapcatAccount(id: string, accountId: string): void {
    if (typeof accountId !== 'string' || !/^[1-9]\d{0,30}$/u.test(accountId)) throw new Error('NapCat 登录账号无效');
    this.transaction(() => {
      const connection = this.requireConnection(id);
      if (connection.accountId !== null && connection.accountId !== accountId) throw new Error('NapCat 登录账号已改变，请新建连接和实例');
      for (const bot of this.listBots().filter(candidate => candidate.connectionId === id)) {
        if (this.botActive(bot)) this.assertNoActiveDuplicate(bot.id, bot.targetType, bot.targetId, id, accountId);
      }
      if (connection.accountId === accountId) return;
      this.db.prepare('UPDATE napcat_connections SET account_id=?,updated_at=? WHERE id=?').run(accountId, Date.now(), id);
      this.change('', 'napcat.account', { connectionId: id, accountId });
    });
  }

  /** Commit before exposing the event to a Worker; stopped instances do not accumulate new messages. */
  enqueueNapcatEvent(botId: string, event: unknown, dedupKey: string): number | null {
    if (typeof dedupKey !== 'string' || !dedupKey || dedupKey.length > 1024) throw new Error('NapCat 消息去重标识无效');
    const serialized = JSON.stringify(event);
    if (serialized === undefined) throw new Error('NapCat 消息无效');
    const bytes = Buffer.byteLength(serialized);
    return this.transaction(() => {
      const bot = this.requireBot(botId);
      if (bot.desiredState !== 'running' || !this.requireConnection(bot.connectionId).enabled) return null;
      this.pruneNapcatQueue(botId);
      if (this.db.prepare('SELECT 1 FROM napcat_inbound_dedup WHERE bot_id=? AND dedup_key=?').get(botId, dedupKey)) return null;
      const size = this.db.prepare('SELECT COUNT(*) AS count,COALESCE(SUM(bytes),0) AS bytes FROM napcat_inbound WHERE bot_id=?').get(botId) as {count: number; bytes: number};
      if (bytes > NAPCAT_EVENT_MAX_BYTES || size.count >= NAPCAT_QUEUE_LIMITS.messages || size.bytes + bytes > NAPCAT_QUEUE_LIMITS.bytes) {
        this.db.prepare('INSERT INTO napcat_queue_state(bot_id,dropped) VALUES (?,1) ON CONFLICT(bot_id) DO UPDATE SET dropped=dropped+1').run(botId);
        return null;
      }
      const now = Date.now();
      const result = this.db.prepare('INSERT INTO napcat_inbound(bot_id,event_cipher,bytes,created_at) VALUES (?,?,?,?)').run(botId, this.encrypt(event), bytes, now);
      this.db.prepare('INSERT INTO napcat_inbound_dedup(bot_id,dedup_key,created_at) VALUES (?,?,?)').run(botId, dedupKey, now);
      this.db.prepare('DELETE FROM napcat_inbound_dedup WHERE bot_id=? AND rowid NOT IN (SELECT rowid FROM napcat_inbound_dedup WHERE bot_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?)').run(botId, botId, NAPCAT_QUEUE_LIMITS.dedupMessages);
      this.images.register(botId, event, now);
      this.forwards.register(botId, event, this.requireConnection(bot.connectionId).accountId ?? '', now);
      this.plugins.register(botId,event,now);
      return Number(result.lastInsertRowid);
    });
  }

  pendingNapcatEvents(botId: string, limit = 100): NapcatQueuedEvent[] {
    this.requireBot(botId); this.pruneNapcatQueue(botId);
    this.publishRecalls(botId);
    const count = Math.min(1000, Math.max(1, Number.isSafeInteger(limit) ? limit : 100));
    return (this.db.prepare('SELECT seq,event_cipher,content_update FROM napcat_inbound WHERE bot_id=? ORDER BY seq LIMIT ?').all(botId, count) as Array<{seq: number; event_cipher: string; content_update: number}>).map(row => {
      const event = this.decrypt(row.event_cipher);
      if(row.content_update===2)return {seq:row.seq,event:null,recall:(event as {recall:ChatRecallEvent}).recall};
      if (row.content_update === 1) {
        const update = (event as {snapshot: ForwardSnapshot}).snapshot;
        return {seq: row.seq, event: null, update, attachments: this.images.forMessage(botId, update.messageId)};
      }
      const packet=record(event)?event:null,bot=this.requireBot(botId),accountId=this.getNapcatConnection(bot.connectionId)?.accountId;
      if(packet?.post_type==='message'&&accountId&&String(packet.self_id)===accountId&&packet.message_type===bot.targetType
        &&String(bot.targetType==='group'?packet.group_id:packet.user_id)===bot.targetId&&packet.message_id!==undefined&&packet.user_id!==undefined
        &&!this.messageState.get(botId,String(packet.message_id))?.registered)
        this.messageState.register(botId,String(packet.message_id),String(packet.user_id),'human');
      const messageId = event && typeof event === 'object' && !Array.isArray(event) ? (event as Record<string, unknown>).message_id : undefined;
      const attachments = messageId === undefined ? [] : this.images.forMessage(botId, String(messageId));
      const dispatch=messageId===undefined?undefined:this.plugins.dispatch(botId,String(messageId));
      const forwards = messageId === undefined ? null : this.forwards.get(botId, String(messageId));
      return { seq: row.seq, event, ...(attachments.length ? { attachments } : {}),...(dispatch?{dispatch}:{}), ...(forwards ? {forwards} : {}) };
    });
  }

  publishRecalls(botId:string):void {
    const pending=this.messageState.pending(botId);if(!pending.length)return;
    this.transaction(()=>{for(const recall of pending) {
      const serialized=JSON.stringify({recall});
      const size=this.db.prepare('SELECT COUNT(*) n,COALESCE(SUM(bytes),0) bytes FROM napcat_inbound WHERE bot_id=?').get(botId) as {n:number;bytes:number};
      if(size.n>=NAPCAT_QUEUE_LIMITS.messages||size.bytes+Buffer.byteLength(serialized)>NAPCAT_QUEUE_LIMITS.bytes)break;
      const row=this.db.prepare('INSERT INTO napcat_inbound(bot_id,event_cipher,bytes,created_at,content_update) VALUES(?,?,?,?,2)').run(botId,this.encrypt({recall}),Buffer.byteLength(serialized),Date.now());
      this.messageState.queued(recall.eventId,Number(row.lastInsertRowid));
    }});
  }

  private enqueueForwardUpdate(botId: string, snapshot: ForwardSnapshot): boolean {
    const event = {snapshot};
    const serialized = JSON.stringify(event);
    this.pruneNapcatQueue(botId);
    const size = this.db.prepare('SELECT COUNT(*) AS count,COALESCE(SUM(bytes),0) AS bytes FROM napcat_inbound WHERE bot_id=?').get(botId) as {count: number; bytes: number};
    if (size.count >= NAPCAT_QUEUE_LIMITS.messages || size.bytes + Buffer.byteLength(serialized) > NAPCAT_QUEUE_LIMITS.bytes) return false;
    this.db.prepare('INSERT INTO napcat_inbound(bot_id,event_cipher,bytes,created_at,content_update) VALUES (?,?,?,?,1)')
      .run(botId, this.encrypt(event), Buffer.byteLength(serialized), Date.now());
    return true;
  }

  ackNapcatEvents(botId: string, seq: number): void {
    this.requireBot(botId);
    if (!Number.isSafeInteger(seq) || seq < 1) throw new Error('NapCat 消息确认序号无效');
    this.transaction(() => {
      this.messageState.acknowledge(botId,seq);
      this.db.prepare('DELETE FROM napcat_inbound WHERE bot_id=? AND seq<=?').run(botId, seq);
      this.db.prepare('INSERT INTO napcat_queue_state(bot_id,acknowledged_seq) VALUES (?,?) ON CONFLICT(bot_id) DO UPDATE SET acknowledged_seq=MAX(acknowledged_seq,excluded.acknowledged_seq)').run(botId, seq);
    });
    this.forwards.publishPending();
  }

  napcatAcknowledgedSeq(botId: string): number {
    this.requireBot(botId);
    return (this.db.prepare('SELECT acknowledged_seq FROM napcat_queue_state WHERE bot_id=?').get(botId) as {acknowledged_seq: number} | undefined)?.acknowledged_seq ?? 0;
  }

  getNapcatQueueStats(botId: string): {pending: number; bytes: number; dropped: number; expired: number; acknowledgedSeq: number} {
    this.requireBot(botId); this.pruneNapcatQueue(botId);
    const size = this.db.prepare('SELECT COUNT(*) AS pending,COALESCE(SUM(bytes),0) AS bytes FROM napcat_inbound WHERE bot_id=?').get(botId) as {pending: number; bytes: number};
    const stats = this.db.prepare('SELECT dropped,expired,acknowledged_seq FROM napcat_queue_state WHERE bot_id=?').get(botId) as {dropped: number; expired: number; acknowledged_seq: number} | undefined;
    return {...size, dropped: stats?.dropped ?? 0, expired: stats?.expired ?? 0, acknowledgedSeq: stats?.acknowledged_seq ?? 0};
  }

  pendingNapcatEventCount(botId: string): number {
    this.requireBot(botId); this.pruneNapcatQueue(botId);
    return (this.db.prepare('SELECT COUNT(*) AS count FROM napcat_inbound WHERE bot_id=?').get(botId) as {count: number}).count;
  }

  beginNapcatDelivery(botId: string, deliveryId: string, payloadHash: string): {created: boolean; record: NapcatDeliveryRecord} {
    if (typeof deliveryId !== 'string' || !deliveryId || deliveryId.length > 256 || typeof payloadHash !== 'string' || !/^[a-f0-9]{64}$/u.test(payloadHash)) throw new Error('NapCat 发送标识无效');
    return this.transaction(() => {
      this.requireBot(botId);
      const existing = this.getNapcatDelivery(botId, deliveryId);
      if (existing) {
        if (existing.payloadHash !== payloadHash) throw new Error('同一发送标识不能用于不同内容');
        return { created: false, record: existing };
      }
      const now = Date.now();
      this.db.prepare("INSERT INTO napcat_deliveries(bot_id,delivery_id,payload_hash,state,created_at,updated_at) VALUES (?,?,?,'started',?,?)").run(botId, deliveryId, payloadHash, now, now);
      return { created: true, record: this.getNapcatDelivery(botId, deliveryId)! };
    });
  }

  getNapcatDelivery(botId: string, deliveryId: string): NapcatDeliveryRecord | null {
    const row = this.db.prepare('SELECT * FROM napcat_deliveries WHERE bot_id=? AND delivery_id=?').get(botId, deliveryId) as unknown as DeliveryRow | undefined;
    if (!row) return null;
    return { botId: row.bot_id, deliveryId: row.delivery_id, payloadHash: row.payload_hash, state: row.state,
      ...(row.result_cipher ? {result: this.decrypt(row.result_cipher)} : {}), createdAt: row.created_at, updatedAt: row.updated_at };
  }

  finishNapcatDelivery(botId: string, deliveryId: string, state: Exclude<NapcatDeliveryState, 'started'>, result?: unknown): void {
    if (!['acknowledged', 'failed', 'unconfirmed'].includes(state)) throw new Error('NapCat 发送结果无效');
    if (result !== undefined && Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024) throw new Error('NapCat 发送结果过大');
    const existing = this.getNapcatDelivery(botId, deliveryId);
    if (!existing) throw new Error('NapCat 发送记录不存在');
    if (existing.state !== 'started') return;
    this.db.prepare("UPDATE napcat_deliveries SET state=?,result_cipher=?,updated_at=? WHERE bot_id=? AND delivery_id=? AND state='started'")
      .run(state, result === undefined ? null : this.encrypt(result), Date.now(), botId, deliveryId);
  }

  pendingNapcatDeliveryCount(botId: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS count FROM napcat_deliveries WHERE bot_id=? AND state='started'").get(botId) as {count: number}).count;
  }

  /** Called once when the gateway takes ownership, never by read-only DB clients. */
  recoverNapcatDeliveries(connectionId?: string): number {
    return Number((connectionId === undefined
      ? this.db.prepare("UPDATE napcat_deliveries SET state='unconfirmed',updated_at=? WHERE state='started'").run(Date.now())
      : this.db.prepare("UPDATE napcat_deliveries SET state='unconfirmed',updated_at=? WHERE state='started' AND bot_id IN (SELECT id FROM bots WHERE connection_id=?)").run(Date.now(), connectionId)).changes);
  }

  listBots(): BotRecord[] {
    const rows = this.db.prepare(`${this.selectBot()} ORDER BY b.created_at,b.id`).all() as unknown as BotRow[];
    return rows.map(row => this.botRecord(row));
  }

  getBot(id: string): BotRecord | null {
    const row = this.db.prepare(`${this.selectBot()} WHERE b.id=?`).get(id) as unknown as BotRow | undefined;
    return row ? this.botRecord(row) : null;
  }

  createBot(input: { name: string; description?: string; targetType: 'group' | 'private'; targetId: string; connectionId?: string; config: unknown; volume?: string; imported?: boolean }): BotRecord {
    const name = validName(input.name);
    const description = validDescription(input.description ?? '');
    validTarget(input.targetType, input.targetId);
    const config = validateSettings(input.config);
    const id = randomUUID();
    const volume = input.volume ?? `napcat-console-bot-${id}`;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,200}$/u.test(volume)) throw new Error('数据卷名称无效');
    const now = Date.now();
    this.transaction(() => {
      const connectionId = input.connectionId === undefined ? this.legacyConnection(config, name).id : this.requireConnection(input.connectionId).id;
      this.db.prepare(`INSERT INTO bots (id,name,description,target_type,target_id,connection_id,desired_revision,desired_state,volume,worker_token,created_at,updated_at,imported)
        VALUES (?,?,?,?,?,?,1,'stopped',?,?,?,?,?)`).run(id, name, description, input.targetType, input.targetId, connectionId, volume, this.encrypt(randomBytes(32).toString('hex')), now, now, input.imported ? 1 : 0);
      this.db.prepare('INSERT INTO config_revisions(bot_id,revision,config_cipher,created_at) VALUES (?,1,?,?)').run(id, this.encrypt(this.managedSettings(config)), now);
      this.db.prepare('INSERT INTO runtime(bot_id) VALUES (?)').run(id);
      this.change(id, 'bot.created');
    });
    return this.requireBot(id);
  }

  updateBot(id: string, input: { name?: string; description?: string; connectionId?: string; config?: unknown; targetType?: string; targetId?: string; expectedRevision?: number }): BotRecord {
    return this.transaction(() => {
      const bot = this.requireBot(id);
      if ((input.targetType !== undefined && input.targetType !== bot.targetType) || (input.targetId !== undefined && input.targetId !== bot.targetId)) throw new Error('实例创建后不能修改群聊／私聊类型或目标号码');
      if (input.expectedRevision !== undefined && input.expectedRevision !== bot.desiredRevision) throw new Error('配置版本冲突，请刷新后重试');
      const name = input.name === undefined ? bot.name : validName(input.name);
      const description = input.description === undefined ? bot.description : validDescription(input.description);
      const config = input.config === undefined ? bot.config : validateSettings(input.config, bot.config);
      let connectionId = bot.connectionId;
      const configPatch = input.config;
      if (input.connectionId !== undefined) connectionId = this.requireConnection(input.connectionId).id;
      else if (record(configPatch) && ['wsUrl', 'napcatToken', 'reconnectSeconds', 'actionTimeout'].some(field => configPatch[field] !== undefined)) {
        const connection = this.requireConnection(connectionId);
        if (config.wsUrl !== connection.wsUrl || config.napcatToken !== connection.token) connectionId = this.legacyConnection(config, name).id;
      }
      if (connectionId !== bot.connectionId) {
        const runtime = this.getRuntime(bot.id);
        if (bot.desiredState !== 'stopped' || runtime.state !== 'stopped' || !runtime.drained || runtime.processing || this.pendingNapcatDeliveryCount(bot.id)) throw new Error('修改 NapCat 连接前必须完全停止实例');
        const previous = this.requireConnection(bot.connectionId); const next = this.requireConnection(connectionId);
        if (previous.accountId === null || next.accountId === null) throw new Error('新旧 NapCat 连接必须先验证登录账号');
        if (previous.accountId !== next.accountId) throw new Error('不能将现有实例切换到其他 QQ 账号，请新建实例');
      }
      if (this.botActive(bot)) this.assertNoActiveDuplicate(bot.id, bot.targetType, bot.targetId, connectionId);
      const configChanged = connectionId !== bot.connectionId || JSON.stringify(this.managedSettings(config)) !== JSON.stringify(this.managedSettings(bot.config));
      const revision = bot.desiredRevision + (configChanged ? 1 : 0);
      const now = Date.now();
      if (configChanged) this.db.prepare('INSERT INTO config_revisions(bot_id,revision,config_cipher,created_at) VALUES (?,?,?,?)').run(id, revision, this.encrypt(this.managedSettings(config)), now);
      this.db.prepare('UPDATE bots SET name=?,description=?,connection_id=?,desired_revision=?,updated_at=? WHERE id=?').run(name, description, connectionId, revision, now, id);
      this.change(id, 'bot.updated', { revision });
      return this.requireBot(id);
    });
  }

  setDesiredState(id: string, state: DesiredState): void {
    if (state !== 'running' && state !== 'stopped') throw new Error('实例目标状态无效');
    this.transaction(() => {
      const bot = this.requireBot(id);
      if (state === 'running') {
        if (!this.requireConnection(bot.connectionId).enabled) throw new Error('NapCat 连接已停用');
        this.assertNoActiveDuplicate(id, bot.targetType, bot.targetId, bot.connectionId);
      }
      this.db.prepare('UPDATE bots SET desired_state=?,updated_at=? WHERE id=?').run(state, Date.now(), id);
      this.change(id, 'bot.desired_state', { state });
    });
  }

  markApplied(id: string, revision: number): void {
    const bot = this.requireBot(id);
    if (!Number.isSafeInteger(revision) || revision < 1 || revision > bot.desiredRevision || !this.db.prepare('SELECT 1 FROM config_revisions WHERE bot_id=? AND revision=?').get(id, revision)) throw new Error('生效配置版本无效');
    this.db.prepare('UPDATE bots SET applied_revision=MAX(applied_revision,?) WHERE id=?').run(revision, id);
  }

  getPublicBot(id: string): PublicBot | null {
    const bot = this.getBot(id);
    if (!bot) return null;
    const { workerToken: _token, config, ...metadata } = bot;
    const publicConfig = { ...config };
    const configuredSecrets = Object.fromEntries(SECRET_FIELDS.map(field => [field, Boolean(config[field]?.trim())])) as PublicBot['configuredSecrets'];
    for (const field of SECRET_FIELDS) delete publicConfig[field];
    for (const field of ['wsUrl', 'reconnectSeconds', 'actionTimeout'] as const) delete (publicConfig as Partial<BotSettings>)[field];
    const { drained: _drained, ...runtime } = this.getRuntime(id);
    return { ...metadata, config: publicConfig, configuredSecrets, statistics: this.statistics(id, bot.createdAt), ...runtime, runControl: this.runControls.view(id) };
  }

  listPublicBots(): PublicBot[] { return this.listBots().map(bot => this.getPublicBot(bot.id)!); }

  getWorkerSnapshot(id: string): WorkerSnapshot {
    const bot = this.requireBot(id);
    const target = { type: bot.targetType, id: bot.targetId };
    const env = settingsToEnv(this.managedSettings(bot.config), target);
    env.ACTION_TIMEOUT_MS = String(this.requireConnection(bot.connectionId).actionTimeout * 1000);
    return { botId: id, revision: bot.desiredRevision, connectionId: bot.connectionId, transport: 'console', target, env, persona: bot.config.persona };
  }

  verifyWorkerToken(id: string, token: string): boolean {
    const bot = this.getBot(id);
    if (!bot || typeof token !== 'string') return false;
    const actual = Buffer.from(token); const expected = Buffer.from(bot.workerToken);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  getRuntime(id: string): RuntimeRecord {
    const row = this.db.prepare('SELECT * FROM runtime WHERE bot_id=?').get(id) as unknown as RuntimeRow | undefined;
    if (!row) throw new Error('实例不存在');
    return { state: row.state, connected: Boolean(row.connected), processing: Boolean(row.processing), drained: Boolean(row.drained), lastHeartbeat: row.last_heartbeat, ...(row.error ? { error: row.error } : {}) };
  }

  setRuntime(id: string, patch: Partial<Omit<RuntimeRecord, 'lastHeartbeat' | 'error'>> & { error?: string | null }): void {
    this.transaction(() => {
      const bot = this.requireBot(id); const current = this.getRuntime(id);
      const state = patch.state ?? current.state;
      if (!['running', 'stopped', 'starting', 'stopping', 'error', 'unknown'].includes(state)) throw new Error('运行状态无效');
      const error = patch.error === undefined ? current.error ?? null : patch.error === null ? null : this.sanitize(patch.error, bot).slice(0, 2000);
      this.db.prepare('UPDATE runtime SET state=?,connected=?,processing=?,drained=?,error=? WHERE bot_id=?').run(state, (patch.connected ?? current.connected) ? 1 : 0, (patch.processing ?? current.processing) ? 1 : 0, (patch.drained ?? current.drained) ? 1 : 0, error, id);
      this.change(id, 'bot.runtime');
    });
  }

  ingestHeartbeat(id: string, heartbeat: WorkerHeartbeat): number {
    return this.transaction(() => {
      const bot = this.requireBot(id);
      if (!Number.isSafeInteger(heartbeat.revision) || heartbeat.revision < 1 || heartbeat.revision > bot.desiredRevision
        || typeof heartbeat.connected !== 'boolean' || typeof heartbeat.processing !== 'boolean' || typeof heartbeat.drained !== 'boolean'
        || (heartbeat.supportsRunCancellation !== undefined && typeof heartbeat.supportsRunCancellation !== 'boolean')
        || (heartbeat.error !== undefined && (typeof heartbeat.error !== 'string' || heartbeat.error.length > 16000))
        || !Array.isArray(heartbeat.events) || heartbeat.events.length > 1000) throw new Error('Worker heartbeat 无效');
      if (heartbeat.conversationId !== undefined && (typeof heartbeat.conversationId !== 'string' || heartbeat.conversationId.length > 256)) throw new Error('会话 ID 无效');
      for (const event of heartbeat.events) this.ingestEvent(bot, event);
      this.runControls.capability(id, heartbeat.supportsRunCancellation === true);
      const error = heartbeat.error ? this.sanitize(heartbeat.error, bot).slice(0, 2000) : null;
      this.db.prepare(`UPDATE runtime SET state=CASE WHEN state='stopping' THEN 'stopping' ELSE 'running' END,connected=?,processing=?,drained=?,last_heartbeat=?,error=?,conversation_id=COALESCE(conversation_id,?) WHERE bot_id=?`)
        .run(heartbeat.connected ? 1 : 0, heartbeat.processing ? 1 : 0, heartbeat.drained ? 1 : 0, Date.now(), error, heartbeat.conversationId ?? null, id);
      this.markApplied(id, heartbeat.revision);
      this.change(id, 'bot.heartbeat');
      return this.workerCursor(id);
    });
  }

  /** Event upload is independent of runtime heartbeats and commits before ACK. */
  ingestEvents(id: string, events: ConsoleEvent[]): number {
    return this.transaction(() => {
      const bot = this.requireBot(id);
      if (!Array.isArray(events) || events.length > 1000) throw new Error('Worker 事件批次无效');
      let previous = 0;
      for (const event of events) {
        if (!record(event) || !Number.isSafeInteger(event.seq) || event.seq <= previous) throw new Error('Worker 事件顺序无效');
        previous = event.seq;
        this.ingestEvent(bot, event);
      }
      return this.workerCursor(id);
    });
  }

  getConversation(id: string, before?: number, limit = 100): ConversationView | null {
    const bot = this.requireBot(id);
    const runtime = this.db.prepare('SELECT conversation_id FROM runtime WHERE bot_id=?').get(id) as { conversation_id: string | null };
    const conversation = (runtime.conversation_id
      ? this.db.prepare('SELECT * FROM conversations WHERE bot_id=? AND id=?').get(id, runtime.conversation_id)
      : this.db.prepare('SELECT * FROM conversations WHERE bot_id=? ORDER BY started_at DESC,rowid DESC LIMIT 1').get(id)) as { id: string; agent_session_id: string | null; started_at: number } | undefined;
    if (!conversation) return null;
    const pageSize = Math.min(500, Math.max(1, Number.isSafeInteger(limit) ? limit : 100));
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) throw new Error('会话分页游标无效');
    const rows = this.db.prepare('SELECT * FROM event_projection WHERE bot_id=? AND conversation_id=? AND worker_seq<? ORDER BY worker_seq DESC LIMIT ?')
      .all(id, conversation.id, before ?? Number.MAX_SAFE_INTEGER, pageSize + 1) as unknown as EventRow[];
    let more = rows.length > pageSize;
    if (more) rows.pop();
    let items: ConsoleEvent[] = []; let bytes = 0;
    const replyPreview=(messageId:string):Record<string,unknown>|undefined=>{
      const source=this.db.prepare("SELECT payload FROM event_projection WHERE bot_id=? AND conversation_id=? AND type IN ('message.received','incoming','plugin.message.sent') AND json_extract(payload,'$.messageId')=? ORDER BY worker_seq LIMIT 1").get(id,conversation.id,messageId) as {payload:string}|undefined;
      const withdrawn=this.db.prepare("SELECT 1 FROM event_projection WHERE bot_id=? AND conversation_id=? AND type='message.recalled' AND json_extract(payload,'$.messageId')=? LIMIT 1").get(id,conversation.id,messageId);
      if(!source)return undefined;
      const value=JSON.parse(source.payload);return {messageId,...(typeof value.senderName==='string'?{senderName:value.senderName}:{}),...(typeof value.text==='string'?{text:value.text.slice(0,300)}:{}),recalled:!!withdrawn};
    };
    const hydrateState=(item:ConsoleEvent):ConsoleEvent=>{
      const messageId=item.payload.messageId;
      if(typeof messageId==='string'){
        const recall=this.db.prepare("SELECT payload FROM event_projection WHERE bot_id=? AND conversation_id=? AND type='message.recalled' AND json_extract(payload,'$.messageId')=? ORDER BY worker_seq DESC LIMIT 1").get(id,conversation.id,messageId) as {payload:string}|undefined;
        if(recall){const state=JSON.parse(recall.payload);item.payload={...item.payload,recalled:true,recalledAt:state.time??state.recalledAt};}
      }
      if(typeof item.payload.replyTo==='string'){
        const preview=replyPreview(item.payload.replyTo);if(preview)item.payload={...item.payload,replyPreview:preview};
      }
      if(item.type==='reply.accepted'&&Array.isArray(item.payload.messages)){
        const requestId=item.payload.requestId;
        const counts=typeof requestId==='string'?this.db.prepare(`SELECT COALESCE(json_extract(a.payload,'$.logicalMessageIndex'),0) logical_index,COUNT(*) acknowledged,
          SUM(CASE WHEN EXISTS(SELECT 1 FROM event_projection r WHERE r.bot_id=a.bot_id AND r.conversation_id=a.conversation_id AND r.type='message.recalled'
            AND json_extract(r.payload,'$.messageId')=json_extract(a.payload,'$.messageId')) THEN 1 ELSE 0 END) recalled
          FROM event_projection a WHERE a.bot_id=? AND a.conversation_id=? AND a.type='delivery.acknowledged' AND json_extract(a.payload,'$.requestId')=?
          GROUP BY COALESCE(json_extract(a.payload,'$.logicalMessageIndex'),0)`).all(id,conversation.id,requestId) as Array<{logical_index:number;acknowledged:number;recalled:number}>:[];
        const cancellations=typeof requestId==='string'?this.db.prepare(`SELECT COALESCE(json_extract(payload,'$.logicalMessageIndex'),0) logical_index,
          COUNT(DISTINCT json_extract(payload,'$.partIndex')) cancelled FROM event_projection
          WHERE bot_id=? AND conversation_id=? AND type='delivery.cancelled' AND json_extract(payload,'$.requestId')=?
          GROUP BY COALESCE(json_extract(payload,'$.logicalMessageIndex'),0)`).all(id,conversation.id,requestId) as Array<{logical_index:number;cancelled:number}>:[];
        const expected=Array.isArray(item.payload.partCounts)?item.payload.partCounts:[];
        item.payload={...item.payload,messages:item.payload.messages.map((message,index)=>{
          if(!record(message))return message;
          const preview=typeof message.replyTo==='string'?replyPreview(message.replyTo):undefined;
          const count=counts.find(value=>value.logical_index===index),total=expected[index];
          const totalKnown=Number.isSafeInteger(total)&&Number(total)>0;
          return {...message,...(preview?{replyPreview:preview}:{}),deliverySummary:{totalParts:totalKnown?total:null,totalKnown,acknowledgedParts:count?.acknowledged??0,recalledParts:count?.recalled??0,cancelledParts:cancellations.find(value=>value.logical_index===index)?.cancelled??0}};
        })};
      }
      return item;
    };
    for (const row of rows) {
      const item = hydrateState(this.eventRecord(row));
      if ((item.type === 'message.received' || item.type === 'incoming') && typeof item.payload.messageId === 'string') {
        const latest = this.db.prepare(`SELECT worker_seq,payload FROM event_projection WHERE bot_id=? AND conversation_id=?
          AND type='message.images.updated' AND json_extract(payload,'$.messageId')=? ORDER BY worker_seq DESC LIMIT 1`)
          .get(id, conversation.id, item.payload.messageId) as { worker_seq: number; payload: string } | undefined;
        if (latest) item.payload = { ...item.payload, images: JSON.parse(latest.payload).images, imagesUpdatedSeq: latest.worker_seq };
        const content=this.db.prepare(`SELECT worker_seq,payload FROM event_projection WHERE bot_id=? AND conversation_id=? AND type='message.content.updated' AND json_extract(payload,'$.messageId')=? ORDER BY worker_seq DESC LIMIT 1`)
          .get(id,conversation.id,String(item.payload.messageId)) as {worker_seq:number;payload:string}|undefined;
        if(content) {const value=JSON.parse(content.payload);item.payload={...item.payload,...(Array.isArray(value.contents)?{contents:value.contents}:{}),...(typeof value.text==='string'?{text:value.text}:{}),contentUpdatedSeq:content.worker_seq};}
      }
      const size = Buffer.byteLength(JSON.stringify(item));
      if (items.length && bytes + size > 512 * 1024) { more = true; break; }
      items.push(item); bytes += size;
    }
    items.reverse();
    const nextBefore = more ? items[0]?.seq ?? null : null;
    const pageStart = items[0]?.seq; const pageEnd = items.at(-1)?.seq;
    // Logical replies need their actual QQ part IDs even if ACKs fell on another page.
    for(const accepted of [...items].filter(item=>item.type==='reply.accepted')){
      const requestId=accepted.payload.requestId;if(typeof requestId!=='string')continue;
      const receipts=this.db.prepare("SELECT * FROM event_projection WHERE bot_id=? AND conversation_id=? AND type='delivery.acknowledged' AND json_extract(payload,'$.requestId')=? ORDER BY worker_seq LIMIT 100").all(id,conversation.id,requestId) as unknown as EventRow[];
      for(const row of receipts){if(items.some(item=>item.seq===row.worker_seq))continue;const item=hydrateState(this.eventRecord(row)),size=Buffer.byteLength(JSON.stringify(item));if(bytes+size>512*1024)break;items.push(item);bytes+=size;}
    }
    items.sort((a,b)=>a.seq-b.seq);
    const seenThinking = new Set<string>();
    // A snapshot needs only the latest cumulative version of each model
    // message. Keep the raw event cursor for durable incremental replay.
    items = items.toReversed().filter(item => {
      if (item.type !== 'thinking.updated') return true;
      const key = JSON.stringify([item.runId, item.itemId ?? item.seq]);
      if (seenThinking.has(key)) return false;
      seenThinking.add(key); return true;
    }).reverse();
    const runs = [...new Set(items.map(item => item.runId).filter((value): value is string => !!value))];
    if (runs.length && pageStart !== undefined && pageEnd !== undefined) {
      // Include earlier model calls belonging to a visible run, even when
      // tool events have pushed their final thinking snapshot off this page.
      const earlier = this.db.prepare(`SELECT p.* FROM event_projection p WHERE p.bot_id=? AND p.conversation_id=?
        AND p.type='thinking.updated' AND p.run_id IN (${runs.map(() => '?').join(',')}) AND p.worker_seq<?
        AND NOT EXISTS (SELECT 1 FROM event_projection n WHERE n.bot_id=p.bot_id AND n.conversation_id=p.conversation_id
          AND n.type='thinking.updated' AND n.run_id=p.run_id AND n.item_id IS p.item_id AND n.worker_seq>p.worker_seq AND n.worker_seq<=?)
        ORDER BY p.worker_seq DESC LIMIT 500`).all(id, conversation.id, ...runs, pageStart, pageEnd) as unknown as EventRow[];
      bytes = items.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0);
      for (const row of earlier) {
        const item = this.eventRecord(row); const size = Buffer.byteLength(JSON.stringify(item));
        if (bytes + size > 512 * 1024) break;
        items.push(item); bytes += size;
      }
      items.sort((a, b) => a.seq - b.seq);
    }
    const usageRows = this.db.prepare("SELECT * FROM event_projection WHERE bot_id=? AND conversation_id=? AND type IN ('usage.recorded','run.usage') ORDER BY worker_seq").all(id, conversation.id) as unknown as EventRow[];
    const uniqueUsage = new Map<string, Record<string, unknown>>();
    for (const row of usageRows) {
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      uniqueUsage.set(String(payload.usageId ?? row.run_id ?? row.worker_seq), payload);
    }
    const entries = [...uniqueUsage.values()];
    const sum = (names: string[]): number | null => {
      if (!entries.length) return null;
      let total = 0;
      for (const payload of entries) {
        const value = names.map(name => payload[name]).find(value => value !== undefined);
        if (!validCounter(value)) return null;
        total += value;
      }
      return total;
    };
    const input = sum(['input_tokens', 'input']); const cached = sum(['cached_input_tokens', 'cached']); const output = sum(['output_tokens', 'output']);
    const contextRow = this.db.prepare("SELECT * FROM event_projection WHERE bot_id=? AND conversation_id=? AND type='context.updated' ORDER BY worker_seq DESC LIMIT 1").get(id, conversation.id) as unknown as EventRow | undefined;
    const context = contextRow ? JSON.parse(contextRow.payload) as Record<string, unknown> : {};
    return {
      id: conversation.id, agentSessionId: conversation.agent_session_id, startedAt: conversation.started_at, items, cursor: this.workerCursor(id),
      nextBefore,
      usage: { input, cached, output, total: input === null || output === null ? null : input + output },
      context: { used: validCounter(context.used) ? context.used : null, window: validCounter(context.window) ? context.window : bot.config.contextWindow, compactLimit: validCounter(context.compactLimit) ? context.compactLimit : bot.config.compactLimit, ...(typeof context.estimated === 'boolean' ? { estimated: context.estimated } : {}) },
    };
  }

  getConversationCursor(id: string): number { this.requireBot(id); return this.workerCursor(id); }

  getConversationUpdate(id: string, after: number, limit = 100): ConversationUpdate {
    this.requireBot(id);
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('会话增量游标无效');
    const latest = this.workerCursor(id);
    // A new conversation or moved queued input can change events before the
    // client's cursor. Rebase atomically to the current page in those cases.
    const boundary = this.db.prepare("SELECT 1 FROM event_projection WHERE bot_id=? AND worker_seq>? AND type IN ('conversation.started','conversation.messages_moved','runtime.activated') LIMIT 1").get(id, after);
    if (after > latest || boundary) return { cursor: latest, reset: true, view: this.getConversation(id) };
    const rows = this.db.prepare('SELECT * FROM event_projection WHERE bot_id=? AND worker_seq>? ORDER BY worker_seq LIMIT ?')
      .all(id, after, Math.min(500, Math.max(1, limit))) as unknown as EventRow[];
    const items: ConsoleEvent[] = []; let bytes = 0; let cursor = after;
    for (const row of rows) {
      const item = this.eventRecord(row); const size = Buffer.byteLength(JSON.stringify(item));
      if (items.length && bytes + size > 512 * 1024) break;
      items.push(item); bytes += size; cursor = item.seq;
    }
    const view = this.getConversation(id, undefined, 1);
    return { cursor, reset: false, view: view ? { ...view, cursor, items: items.filter(item => item.conversationId === view.id), nextBefore: null } : null };
  }

  importIncomingCounts(id: string, rows: Array<{ time: number; count: number }>): void {
    this.transaction(() => {
      this.requireBot(id);
      for (const row of rows) {
        if (!Number.isSafeInteger(row.count) || row.count < 0 || !Number.isFinite(row.time)) throw new Error('历史消息统计无效');
        this.db.prepare("INSERT OR IGNORE INTO counters(bot_id,kind,identity,time,count) VALUES (?,'incoming',?,?,?)")
          .run(id, `legacy-count:${row.time}`, milliseconds(row.time), row.count);
      }
      this.change(id, 'bot.statistics');
    });
  }

  getEventCursor(): number { return (this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM changes').get() as { seq: number }).seq; }
  listChanges(after: number, limit = 200): ConsoleChange[] {
    return (this.db.prepare('SELECT seq,bot_id,type,time,payload FROM changes WHERE seq>? ORDER BY seq LIMIT ?').all(after, Math.min(1000, Math.max(1, limit))) as unknown as Array<{ seq: number; bot_id: string; type: string; time: number; payload: string }>)
      .map(row => ({ seq: row.seq, botId: row.bot_id, type: row.type, time: row.time, payload: JSON.parse(row.payload) as Record<string, unknown> }));
  }
  getLatencyP95(id: string, since: number): number | null {
    const rows = this.db.prepare("SELECT payload FROM event_projection WHERE bot_id=? AND type='batch.completed' AND time>=?").all(id, since) as Array<{ payload: string }>;
    const samples = rows.map(row => (JSON.parse(row.payload) as Record<string, unknown>).durationMs)
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
    return samples.length ? samples[Math.ceil(samples.length * 0.95) - 1]! / 1000 : null;
  }
  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }
  setSetting(key: string, value: string | undefined): void {
    if (value === undefined) { this.db.prepare('DELETE FROM settings WHERE key=?').run(key); return; }
    this.db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  }
  pluginRunnerToken():string {return createHmac('sha256',this.key).update('nekodock.plugin-runner.v1').digest('hex');}
  close(): void { this.db.close(); }

  private ingestEvent(bot: BotRecord, event: ConsoleEvent): void {
    if (!record(event) || !Number.isSafeInteger(event.seq) || event.seq < 1 || typeof event.type !== 'string' || !/^[a-zA-Z0-9_.-]{1,100}$/u.test(event.type)
      || !Number.isSafeInteger(event.time) || event.time < 0 || !record(event.payload)) throw new Error('Worker 事件无效');
    for (const value of [event.conversationId, event.runId, event.itemId]) if (value !== undefined && (typeof value !== 'string' || value.length > 512)) throw new Error('Worker 事件标识无效');
    if (Buffer.byteLength(JSON.stringify(event.payload)) > 512_000) throw new Error('Worker 事件超过大小限制');
    const sanitized = sanitizeKeys(event.payload, value => this.sanitize(value, bot)) as Record<string, unknown>;
    const payload = sanitized;
    const runtime = this.db.prepare('SELECT conversation_id FROM runtime WHERE bot_id=?').get(bot.id) as { conversation_id: string | null };
    const conversationId = event.conversationId ?? runtime.conversation_id;
    const result = this.db.prepare('INSERT OR IGNORE INTO event_projection(bot_id,worker_seq,type,time,conversation_id,run_id,item_id,payload) VALUES (?,?,?,?,?,?,?,?)')
      .run(bot.id, event.seq, event.type, event.time, conversationId, event.runId ?? null, event.itemId ?? null, JSON.stringify(sanitized));
    if (!result.changes) return;
    this.plugins.observe(bot.id,{...event,conversationId:conversationId??undefined});
    this.runControls.observe(bot.id,{...event,conversationId:conversationId??undefined});
    if (event.type.startsWith('schedule.')) this.tasks.ingest(bot.id, {...event, payload: sanitized});
    if (conversationId) {
      this.db.prepare('INSERT OR IGNORE INTO conversations(bot_id,id,started_at) VALUES (?,?,?)').run(bot.id, conversationId, event.time);
      if (event.type === 'conversation.started') this.db.prepare('UPDATE runtime SET conversation_id=? WHERE bot_id=?').run(conversationId, bot.id);
      const sessionId = payload.agentSessionId ?? payload.sessionId;
      if ((event.type === 'session.established' || event.type === 'conversation.session' || event.type === 'conversation.started') && typeof sessionId === 'string') {
        this.db.prepare('UPDATE conversations SET agent_session_id=? WHERE bot_id=? AND id=?').run(sessionId.slice(0, 256), bot.id, conversationId);
      }
      if (event.type === 'conversation.messages_moved' && Array.isArray(payload.messageIds)) {
        for (const messageId of payload.messageIds) {
          if (typeof messageId !== 'string') continue;
          this.db.prepare("UPDATE event_projection SET conversation_id=? WHERE bot_id=? AND type IN ('message.received','incoming','message.images.updated','message.content.updated') AND json_extract(payload,'$.messageId')=?").run(conversationId, bot.id, messageId);
        }
      }
    }
    if ((event.type === 'incoming' || event.type === 'message.received') && typeof payload.messageId === 'string' && !payload.command) {
      const time = typeof payload.messageTime === 'number' ? milliseconds(payload.messageTime) : typeof payload.time === 'number' ? milliseconds(payload.time) : event.time;
      const counted = this.db.prepare("INSERT OR IGNORE INTO counters(bot_id,kind,identity,time) VALUES (?,'incoming',?,?)").run(bot.id, payload.messageId, time);
      if (counted.changes) this.change(bot.id, 'bot.statistics');
    }
    if ((event.type === 'delivery.acknowledged' || event.type === 'reply.ack') && payload.normal === true && typeof payload.deliveryId === 'string') {
      const counted = this.db.prepare("INSERT OR IGNORE INTO counters(bot_id,kind,identity,time) VALUES (?,'reply',?,?)").run(bot.id, payload.deliveryId, event.time);
      if (counted.changes) this.change(bot.id, 'bot.statistics');
    }
    this.change(bot.id, 'conversation.event', { workerSeq: event.seq, type: event.type, conversationId });
  }

  private statistics(id: string, createdAt: number): Statistics {
    const today = Date.parse(`${new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)}T00:00:00+08:00`);
    const counts = this.db.prepare('SELECT kind,SUM(count) AS total,SUM(CASE WHEN time>=? AND time<? THEN count ELSE 0 END) AS today FROM counters WHERE bot_id=? GROUP BY kind')
      .all(today, today + 86400_000, id) as unknown as Array<{ kind: string; total: number; today: number }>;
    const incoming = counts.find(row => row.kind === 'incoming'); const replies = counts.find(row => row.kind === 'reply');
    return { todayMessages: incoming?.today ?? 0, totalMessages: incoming?.total ?? 0, todayReplies: replies?.today ?? 0, totalReplies: replies?.total ?? 0, replyCountSince: createdAt };
  }
  private workerCursor(id: string): number { return (this.db.prepare('SELECT COALESCE(MAX(worker_seq),0) AS seq FROM event_projection WHERE bot_id=?').get(id) as { seq: number }).seq; }
  private assertNoActiveDuplicate(id: string, targetType: string, targetId: string, connectionId: string, accountId?: string): void {
    const connection = this.requireConnection(connectionId);
    const account = accountId ?? connection.accountId;
    for (const other of this.listBots()) {
      if (other.id === id || !this.botActive(other) || other.targetType !== targetType || other.targetId !== targetId) continue;
      const otherConnection = this.requireConnection(other.connectionId);
      if (connectionId === other.connectionId || (account && otherConnection.accountId === account)) throw new Error('相同 NapCat 连接或登录账号和目标已有运行中的实例');
    }
  }
  private botActive(bot: BotRecord): boolean { return bot.desiredState === 'running' || this.getRuntime(bot.id).state !== 'stopped'; }
  private requireConnection(id: string): NapcatConnectionRecord {
    if (typeof id !== 'string') throw new Error('NapCat 连接不存在');
    const connection = this.getNapcatConnection(id); if (!connection) throw new Error('NapCat 连接不存在'); return connection;
  }
  private connectionRecord(row: ConnectionRow): NapcatConnectionRecord {
    const token = this.decrypt(row.token_cipher) as string;
    return { id: row.id, name: row.name, wsUrl: row.ws_url, ...(token ? {token} : {}), reconnectSeconds: row.reconnect_seconds,
      actionTimeout: row.action_timeout,...(row.media_base_url?{mediaBaseUrl:row.media_base_url}:{}), enabled: Boolean(row.enabled), revision: row.revision, accountId: row.account_id, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  private connectionKey(wsUrl: string, token?: string): string {
    return createHmac('sha256', this.key).update(JSON.stringify([normalizeNapcatUrl(wsUrl), token ?? ''])).digest('hex');
  }
  private insertNapcatConnection(input: NapcatConnectionInput): NapcatConnectionRecord {
    const config = validateNapcatConnection(input); const id = randomUUID(); const now = Date.now();
    const key = this.connectionKey(config.wsUrl, config.token);
    if (this.db.prepare('SELECT 1 FROM napcat_connections WHERE endpoint_key=?').get(key)) throw new Error('相同 NapCat 地址和 Token 已有连接');
    this.db.prepare(`INSERT INTO napcat_connections(id,name,ws_url,token_cipher,endpoint_key,reconnect_seconds,action_timeout,enabled,media_base_url,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,1,?,?)`)
      .run(id, config.name, config.wsUrl, this.encrypt(config.token ?? ''), key, config.reconnectSeconds, config.actionTimeout, config.enabled ? 1 : 0, config.mediaBaseUrl??'', now, now);
    this.change('', 'napcat.created', {connectionId: id});
    return this.requireConnection(id);
  }
  private legacyConnection(config: BotSettings, name: string): NapcatConnectionRecord {
    const wsUrl = normalizeNapcatUrl(config.wsUrl); const key = this.connectionKey(wsUrl, config.napcatToken);
    const row = this.db.prepare('SELECT * FROM napcat_connections WHERE endpoint_key=?').get(key) as unknown as ConnectionRow | undefined;
    return row ? this.connectionRecord(row) : this.insertNapcatConnection({name: `${name.slice(0, 70)} · NapCat`, wsUrl, token: config.napcatToken, reconnectSeconds: config.reconnectSeconds, actionTimeout: config.actionTimeout});
  }
  private managedSettings(config: BotSettings): BotSettings {
    const result = {...config, wsUrl: 'ws://console.invalid/', reconnectSeconds: 3, actionTimeout: 15};
    delete result.napcatToken;
    return result;
  }
  private migrateNapcatConnections(): void {
    this.transaction(() => {
      const rows = this.db.prepare(`${this.selectBot()} WHERE b.connection_id IS NULL`).all() as unknown as BotRow[];
      for (const row of rows) {
        const config = normalizeSettings(this.decrypt(row.config_cipher));
        const connection = this.legacyConnection(config, row.name);
        this.db.prepare('UPDATE bots SET connection_id=? WHERE id=?').run(connection.id, row.id);
      }
    });
  }
  private pruneNapcatQueue(botId: string): void {
    const cutoff = Date.now() - NAPCAT_QUEUE_LIMITS.retentionMs;
    const expired = Number(this.db.prepare('DELETE FROM napcat_inbound WHERE bot_id=? AND created_at<?').run(botId, cutoff).changes);
    if (expired) this.db.prepare('INSERT INTO napcat_queue_state(bot_id,expired) VALUES (?,?) ON CONFLICT(bot_id) DO UPDATE SET expired=expired+excluded.expired').run(botId, expired);
    this.db.prepare('DELETE FROM napcat_inbound_dedup WHERE bot_id=? AND created_at<?').run(botId, cutoff);
  }
  private requireBot(id: string): BotRecord { const bot = this.getBot(id); if (!bot) throw new Error('实例不存在'); return bot; }
  private selectBot(): string { return 'SELECT b.*,c.config_cipher FROM bots b JOIN config_revisions c ON c.bot_id=b.id AND c.revision=b.desired_revision'; }
  private botRecord(row: BotRow): BotRecord {
    const connection = this.requireConnection(row.connection_id);
    const config = normalizeSettings(this.decrypt(row.config_cipher));
    config.wsUrl = connection.wsUrl; config.napcatToken = connection.token; config.reconnectSeconds = connection.reconnectSeconds; config.actionTimeout = connection.actionTimeout;
    return { id: row.id, name: row.name, description: row.description, targetType: row.target_type, targetId: row.target_id, connectionId: row.connection_id,
      desiredRevision: row.desired_revision, appliedRevision: row.applied_revision, desiredState: row.desired_state,
      volume: row.volume, workerToken: this.decrypt(row.worker_token) as string, createdAt: row.created_at, updatedAt: row.updated_at,
      imported: Boolean(row.imported), config };
  }
  private eventRecord(row: EventRow): ConsoleEvent {
    return { seq: row.worker_seq, type: row.type, time: row.time,
      ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
      ...(row.run_id ? { runId: row.run_id } : {}), ...(row.item_id ? { itemId: row.item_id } : {}),
      payload: JSON.parse(row.payload) as Record<string, unknown> };
  }
  private change(botId: string, type: string, payload: Record<string, unknown> = {}): void { this.db.prepare('INSERT INTO changes(bot_id,type,time,payload) VALUES (?,?,?,?)').run(botId, type, Date.now(), JSON.stringify(payload)); }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private encrypt(value: unknown): string {
    const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64');
  }
  private decrypt(value: string): unknown {
    try {
      const bytes = Buffer.from(value, 'base64'); const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')) as unknown;
    } catch { throw new Error('控制台数据解密失败，请恢复匹配的主密钥'); }
  }
  private sanitize(value: string, bot: BotRecord): string {
    let safe = value;
    for (const secret of [...proxySecrets({enabled:bot.config.proxyEnabled,url:bot.config.proxyUrl,username:bot.config.proxyUsername,password:bot.config.proxyPassword,noProxy:bot.config.proxyNoProxy,forTools:bot.config.proxyForTools}),bot.workerToken, ...SECRET_FIELDS.map(field => bot.config[field])].filter((value):value is string=>!!value).sort((a,b)=>b.length-a.length)) {
      if (secret) safe = safe.split(secret).join('[REDACTED]');
    }
    return safe.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/giu, 'Bearer [REDACTED]').replace(/\bsk-[A-Za-z0-9_-]{10,}/gu, '[REDACTED]');
  }
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function validCounter(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function milliseconds(time: number): number { return Math.round(time < 1_000_000_000_000 ? time * 1000 : time); }
function validTarget(type: string, id: string): void { if (!['group', 'private'].includes(type) || typeof id !== 'string' || !/^[1-9]\d{0,30}$/u.test(id)) throw new Error('群聊／私聊类型或目标号码无效'); }
function validName(value: string): string { if (typeof value !== 'string' || !value.trim() || value.length > 80) throw new Error('实例名称必须为 1 至 80 字符'); return value.trim(); }
function validDescription(value: string): string { if (typeof value !== 'string' || value.length > 1000) throw new Error('实例备注不能超过 1000 字符'); return value; }
function sanitizeKeys(value: unknown, sanitize: (value: string) => string): unknown {
  if (typeof value === 'string') return sanitize(value);
  if (Array.isArray(value)) return value.map(item => sanitizeKeys(item, sanitize));
  if (!record(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (/(?:^token$|api[-_]?key|authorization|password|secret|cookie|access[-_]?token|worker[-_]?token|napcat[-_]?token)/iu.test(key)) continue;
    result[key] = sanitizeKeys(item, sanitize);
  }
  return result;
}
