import { randomBytes, randomUUID, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SECRET_FIELDS, type BotRecord, type BotSettings, type ConsoleEvent, type ConversationView, type ConversationUpdate, type DesiredState, type PublicBot, type RuntimeState, type Statistics, type WorkerHeartbeat, type WorkerSnapshot } from './contracts.js';
import { normalizeSettings, settingsToEnv, validateSettings } from './settings.js';

export interface RuntimeRecord {
  state: RuntimeState; connected: boolean; processing: boolean; drained: boolean; lastHeartbeat: number | null; error?: string;
}
export interface ConsoleChange { seq: number; botId: string; type: string; time: number; payload: Record<string, unknown> }
interface BotRow {
  id: string; name: string; description: string; target_type: 'group' | 'private'; target_id: string;
  desired_revision: number; applied_revision: number; desired_state: DesiredState; volume: string; worker_token: string;
  created_at: number; updated_at: number; imported: number; config_cipher: string;
}
interface RuntimeRow {
  state: RuntimeState; connected: number; processing: number; drained: number; last_heartbeat: number | null; error: string | null; conversation_id: string | null;
}
interface EventRow { worker_seq: number; type: string; time: number; conversation_id: string | null; run_id: string | null; item_id: string | null; payload: string }

export class ConsoleDatabase {
  private readonly db: DatabaseSync;
  private readonly key: Buffer;

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
        CREATE TABLE IF NOT EXISTS counters (
          bot_id TEXT NOT NULL REFERENCES bots(id), kind TEXT NOT NULL, identity TEXT NOT NULL, time INTEGER NOT NULL,
          count INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(bot_id,kind,identity)
        );
        CREATE INDEX IF NOT EXISTS counter_time ON counters(bot_id,kind,time);
        CREATE TABLE IF NOT EXISTS changes (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT NOT NULL, type TEXT NOT NULL, time INTEGER NOT NULL, payload TEXT NOT NULL
        );
      `);
      const conversationColumns = this.db.prepare('PRAGMA table_info(conversations)').all() as Array<{name: string}>;
      if (!conversationColumns.some(column => column.name === 'agent_session_id')) this.db.exec('ALTER TABLE conversations ADD COLUMN agent_session_id TEXT');
      if (path !== ':memory:') chmodSync(path, 0o600);
      // Detect a missing/replaced master key before allowing updates to an existing database.
      const first = this.db.prepare('SELECT config_cipher FROM config_revisions LIMIT 1').get() as { config_cipher: string } | undefined;
      if (first) this.decrypt(first.config_cipher);
    } catch (error) { this.db.close(); throw error; }
  }

  listBots(): BotRecord[] {
    const rows = this.db.prepare(`${this.selectBot()} ORDER BY b.created_at,b.id`).all() as unknown as BotRow[];
    return rows.map(row => this.botRecord(row));
  }

  getBot(id: string): BotRecord | null {
    const row = this.db.prepare(`${this.selectBot()} WHERE b.id=?`).get(id) as unknown as BotRow | undefined;
    return row ? this.botRecord(row) : null;
  }

  createBot(input: { name: string; description?: string; targetType: 'group' | 'private'; targetId: string; config: unknown; volume?: string; imported?: boolean }): BotRecord {
    const name = validName(input.name);
    const description = validDescription(input.description ?? '');
    validTarget(input.targetType, input.targetId);
    const config = validateSettings(input.config);
    const id = randomUUID();
    const volume = input.volume ?? `napcat-console-bot-${id}`;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,200}$/u.test(volume)) throw new Error('数据卷名称无效');
    const now = Date.now();
    this.transaction(() => {
      this.db.prepare(`INSERT INTO bots (id,name,description,target_type,target_id,desired_revision,desired_state,volume,worker_token,created_at,updated_at,imported)
        VALUES (?,?,?,?,?,1,'stopped',?,?,?,?,?)`).run(id, name, description, input.targetType, input.targetId, volume, this.encrypt(randomBytes(32).toString('hex')), now, now, input.imported ? 1 : 0);
      this.db.prepare('INSERT INTO config_revisions(bot_id,revision,config_cipher,created_at) VALUES (?,1,?,?)').run(id, this.encrypt(config), now);
      this.db.prepare('INSERT INTO runtime(bot_id) VALUES (?)').run(id);
      this.change(id, 'bot.created');
    });
    return this.requireBot(id);
  }

  updateBot(id: string, input: { name?: string; description?: string; config?: unknown; targetType?: string; targetId?: string; expectedRevision?: number }): BotRecord {
    return this.transaction(() => {
      const bot = this.requireBot(id);
      if ((input.targetType !== undefined && input.targetType !== bot.targetType) || (input.targetId !== undefined && input.targetId !== bot.targetId)) throw new Error('实例创建后不能修改群聊／私聊类型或目标号码');
      if (input.expectedRevision !== undefined && input.expectedRevision !== bot.desiredRevision) throw new Error('配置版本冲突，请刷新后重试');
      const name = input.name === undefined ? bot.name : validName(input.name);
      const description = input.description === undefined ? bot.description : validDescription(input.description);
      const config = input.config === undefined ? bot.config : validateSettings(input.config, bot.config);
      if (bot.desiredState === 'running') this.assertNoActiveDuplicate(bot.id, bot.targetType, bot.targetId, config.wsUrl);
      const configChanged = JSON.stringify(config) !== JSON.stringify(bot.config);
      const revision = bot.desiredRevision + (configChanged ? 1 : 0);
      const now = Date.now();
      if (configChanged) this.db.prepare('INSERT INTO config_revisions(bot_id,revision,config_cipher,created_at) VALUES (?,?,?,?)').run(id, revision, this.encrypt(config), now);
      this.db.prepare('UPDATE bots SET name=?,description=?,desired_revision=?,updated_at=? WHERE id=?').run(name, description, revision, now, id);
      this.change(id, 'bot.updated', { revision });
      return this.requireBot(id);
    });
  }

  setDesiredState(id: string, state: DesiredState): void {
    if (state !== 'running' && state !== 'stopped') throw new Error('实例目标状态无效');
    this.transaction(() => {
      const bot = this.requireBot(id);
      if (state === 'running') this.assertNoActiveDuplicate(id, bot.targetType, bot.targetId, bot.config.wsUrl);
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
    const { drained: _drained, ...runtime } = this.getRuntime(id);
    return { ...metadata, config: publicConfig, configuredSecrets, statistics: this.statistics(id, bot.createdAt), ...runtime };
  }

  listPublicBots(): PublicBot[] { return this.listBots().map(bot => this.getPublicBot(bot.id)!); }

  getWorkerSnapshot(id: string): WorkerSnapshot {
    const bot = this.requireBot(id);
    const target = { type: bot.targetType, id: bot.targetId };
    return { botId: id, revision: bot.desiredRevision, target, env: settingsToEnv(bot.config, target), persona: bot.config.persona };
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
        || (heartbeat.error !== undefined && (typeof heartbeat.error !== 'string' || heartbeat.error.length > 16000))
        || !Array.isArray(heartbeat.events) || heartbeat.events.length > 1000) throw new Error('Worker heartbeat 无效');
      if (heartbeat.conversationId !== undefined && (typeof heartbeat.conversationId !== 'string' || heartbeat.conversationId.length > 256)) throw new Error('会话 ID 无效');
      for (const event of heartbeat.events) this.ingestEvent(bot, event);
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
    for (const row of rows) {
      const item = this.eventRecord(row); const size = Buffer.byteLength(JSON.stringify(item));
      if (items.length && bytes + size > 512 * 1024) { more = true; break; }
      items.push(item); bytes += size;
    }
    items.reverse();
    const nextBefore = more ? items[0]?.seq ?? null : null;
    const pageStart = items[0]?.seq; const pageEnd = items.at(-1)?.seq;
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
          this.db.prepare("UPDATE event_projection SET conversation_id=? WHERE bot_id=? AND type IN ('message.received','incoming') AND json_extract(payload,'$.messageId')=?").run(conversationId, bot.id, messageId);
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
  private assertNoActiveDuplicate(id: string, targetType: string, targetId: string, wsUrl: string): void {
    // The normalized NapCat address is the account identity available before connecting.
    for (const other of this.listBots()) {
      if (other.id !== id && (other.desiredState === 'running' || this.getRuntime(other.id).state !== 'stopped') && other.targetType === targetType && other.targetId === targetId
        && other.config.wsUrl === wsUrl) throw new Error('相同 NapCat 连接和目标已有运行中的实例');
    }
  }
  private requireBot(id: string): BotRecord { const bot = this.getBot(id); if (!bot) throw new Error('实例不存在'); return bot; }
  private selectBot(): string { return 'SELECT b.*,c.config_cipher FROM bots b JOIN config_revisions c ON c.bot_id=b.id AND c.revision=b.desired_revision'; }
  private botRecord(row: BotRow): BotRecord {
    return { id: row.id, name: row.name, description: row.description, targetType: row.target_type, targetId: row.target_id,
      desiredRevision: row.desired_revision, appliedRevision: row.applied_revision, desiredState: row.desired_state,
      volume: row.volume, workerToken: this.decrypt(row.worker_token) as string, createdAt: row.created_at, updatedAt: row.updated_at,
      imported: Boolean(row.imported), config: normalizeSettings(this.decrypt(row.config_cipher)) };
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
    for (const secret of [bot.workerToken, ...SECRET_FIELDS.map(field => bot.config[field])]) {
      if (secret && secret.length >= 4) safe = safe.split(secret).join('[REDACTED]');
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
