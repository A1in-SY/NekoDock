import type { DatabaseSync } from 'node:sqlite';
import { FORWARD_LIMITS, isForwardSnapshot, type ForwardContent, type ForwardSnapshot } from '../forward-contract.js';
import { pendingForwardContents } from '../forward-resolver.js';
import type { BotRecord } from './contracts.js';

interface Row { bot_id: string; message_id: string; connection_id: string; account_id: string; state: string; event_cipher: string | null; snapshot_cipher: string; created_at: number; deadline: number; }
interface Dependencies {
  requireBot(id: string): BotRecord;
  encrypt(value: unknown): string;
  decrypt(value: string): unknown;
  transaction<T>(fn: () => T): T;
  updated(botId: string, snapshot: ForwardSnapshot): boolean;
}
export interface ForwardJob { botId: string; messageId: string; connectionId: string; accountId: string; event: unknown; deadline: number; }

/** Durable content belongs to its original delivery, independently of the delivery ACK. */
export class ConsoleIncomingForwards {
  private readonly listeners = new Set<() => void>();
  constructor(private readonly db: DatabaseSync, private readonly deps: Dependencies) {
    db.exec(`CREATE TABLE IF NOT EXISTS console_incoming_forwards (
      bot_id TEXT NOT NULL REFERENCES bots(id), message_id TEXT NOT NULL, connection_id TEXT NOT NULL,
      account_id TEXT NOT NULL, state TEXT NOT NULL, event_cipher TEXT, snapshot_cipher TEXT NOT NULL,
      created_at INTEGER NOT NULL, deadline INTEGER NOT NULL, published INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(bot_id,message_id)
    ); CREATE INDEX IF NOT EXISTS console_incoming_forwards_pending ON console_incoming_forwards(state,created_at);`);
  }
  register(botId: string, event: unknown, accountId: string, now = Date.now()): void {
    const packet = event && typeof event === 'object' ? event as Record<string, unknown> : null;
    const value = packet?.message_id;
    const messageId = typeof value === 'string' && value && value.length <= 200 ? value : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : null;
    if (!messageId) return;
    const contents = pendingForwardContents(event);
    if (!contents.length) return;
    const bot = this.deps.requireBot(botId);
    const deadline = now + FORWARD_LIMITS.timeoutMs;
    const snapshot: ForwardSnapshot = { messageId, revision: 1, contents, deadline };
    const inserted = this.db.prepare(`INSERT OR IGNORE INTO console_incoming_forwards
      (bot_id,message_id,connection_id,account_id,state,event_cipher,snapshot_cipher,created_at,deadline) VALUES(?,?,?,?,'queued',?,?,?,?)`)
      .run(botId, messageId, bot.connectionId, accountId, this.deps.encrypt(event), this.deps.encrypt(snapshot), now, deadline).changes;
    if (inserted) this.notify();
  }
  get(botId: string, messageId: string): ForwardSnapshot | null {
    this.deps.requireBot(botId);
    if (!messageId || messageId.length > 200) return null;
    const row = this.db.prepare('SELECT snapshot_cipher FROM console_incoming_forwards WHERE bot_id=? AND message_id=?').get(botId, messageId) as {snapshot_cipher: string} | undefined;
    return row ? this.deps.decrypt(row.snapshot_cipher) as ForwardSnapshot : null;
  }
  recover(): void { this.db.prepare("UPDATE console_incoming_forwards SET state='queued' WHERE state='running'").run(); }
  pending(connectionIds?: readonly string[]): ForwardJob[] {
    const rows = connectionIds === undefined
      ? this.db.prepare("SELECT * FROM console_incoming_forwards WHERE state='queued' ORDER BY created_at,bot_id,message_id LIMIT 1000").all() as unknown as Row[]
      : connectionIds.flatMap(connectionId => this.db.prepare("SELECT * FROM console_incoming_forwards WHERE state='queued' AND connection_id=? ORDER BY created_at,bot_id,message_id LIMIT 2").all(connectionId) as unknown as Row[]);
    return rows.map(row => ({ botId: row.bot_id, messageId: row.message_id, connectionId: row.connection_id, accountId: row.account_id,
      event: row.event_cipher ? this.deps.decrypt(row.event_cipher) : null, deadline: row.deadline }));
  }
  claim(job: ForwardJob): boolean { return this.db.prepare("UPDATE console_incoming_forwards SET state='running' WHERE bot_id=? AND message_id=? AND state='queued'").run(job.botId, job.messageId).changes === 1; }
  reset(job: ForwardJob): void { this.db.prepare("UPDATE console_incoming_forwards SET state='queued' WHERE bot_id=? AND message_id=? AND state='running'").run(job.botId, job.messageId); }
  complete(job: ForwardJob, contents: ForwardContent[]): void {
    this.deps.transaction(() => {
      const current = this.get(job.botId, job.messageId);
      if (!current) return;
      const snapshot = { ...current, revision: current.revision + 1, contents };
      if (!isForwardSnapshot(snapshot)) throw new Error('Invalid resolved forward content.');
      if (!this.db.prepare("UPDATE console_incoming_forwards SET state='complete',event_cipher=NULL,snapshot_cipher=? WHERE bot_id=? AND message_id=? AND state='running'")
        .run(this.deps.encrypt(snapshot), job.botId, job.messageId).changes) return;
      if (this.deps.updated(job.botId, snapshot)) this.db.prepare('UPDATE console_incoming_forwards SET published=1 WHERE bot_id=? AND message_id=?').run(job.botId, job.messageId);
    });
    this.notify();
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  publishPending(): void {
    const bots = this.db.prepare("SELECT DISTINCT bot_id FROM console_incoming_forwards WHERE state='complete' AND published=0").all() as Array<{bot_id: string}>;
    for (const bot of bots) {
      const rows = this.db.prepare("SELECT message_id,snapshot_cipher FROM console_incoming_forwards WHERE bot_id=? AND state='complete' AND published=0 ORDER BY created_at LIMIT 100").all(bot.bot_id) as Array<{message_id: string; snapshot_cipher: string}>;
      for (const row of rows) {
        const published = this.deps.transaction(() => {
          const snapshot = this.deps.decrypt(row.snapshot_cipher) as ForwardSnapshot;
          if (!this.deps.updated(bot.bot_id, snapshot)) return false;
          this.db.prepare('UPDATE console_incoming_forwards SET published=1 WHERE bot_id=? AND message_id=?').run(bot.bot_id, row.message_id);
          return true;
        });
        if (!published) break;
      }
    }
  }
  private notify(): void { for (const listener of this.listeners) listener(); }
}
