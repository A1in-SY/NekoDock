import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { MemoryControl, MemoryView } from '../memory-contract.js';

export interface MemoryControlRecord extends MemoryControl {
  status: 'pending' | 'completed' | 'failed'; error: string | null; createdAt: number; finishedAt: number | null;
}
interface Dependencies {
  requireBot(id: string): unknown;
  encrypt(value: unknown): string;
  decrypt(value: string): unknown;
  transaction<T>(fn: () => T): T;
  change(id: string, type: string): void;
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const identity = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,200}$/u.test(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** Encrypted presentation snapshots and durable controls; the Worker owns memory mutations. */
export class ConsoleMemory {
  constructor(private db: DatabaseSync, private deps: Dependencies) {
    db.exec(`CREATE TABLE IF NOT EXISTS memory_projection (
      bot_id TEXT PRIMARY KEY REFERENCES bots(id), view_cipher TEXT NOT NULL, version INTEGER NOT NULL, updated_at INTEGER NOT NULL
    ); CREATE TABLE IF NOT EXISTS memory_controls (
      id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id), request_cipher TEXT NOT NULL,
      status TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL, finished_at INTEGER
    ); CREATE INDEX IF NOT EXISTS memory_controls_bot ON memory_controls(bot_id,status,created_at);`);
  }
  view(botId: string): { view: MemoryView | null; updatedAt: number | null; controls: MemoryControlRecord[] } {
    this.deps.requireBot(botId);
    const row = this.db.prepare('SELECT * FROM memory_projection WHERE bot_id=?').get(botId) as {view_cipher:string; updated_at:number} | undefined;
    const controls = this.db.prepare("SELECT * FROM memory_controls WHERE bot_id=? ORDER BY (status='pending') DESC,created_at DESC,id DESC LIMIT 100").all(botId) as Array<{request_cipher:string;status:MemoryControlRecord['status'];error:string|null;created_at:number;finished_at:number|null}>;
    return { view: row ? this.deps.decrypt(row.view_cipher) as MemoryView : null, updatedAt: row?.updated_at ?? null,
      controls: controls.map(control => ({...this.deps.decrypt(control.request_cipher) as MemoryControl, status: control.status, error: control.error, createdAt: control.created_at, finishedAt: control.finished_at})) };
  }
  request(botId: string, value: unknown): MemoryControlRecord {
    if (!record(value)) throw new Error('记忆操作无效');
    const allowed = ['operation','memoryId','expectedRevision','content','restore','from','to','jobId'];
    if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('记忆操作包含未知字段');
    if (!['run','backfill','cancel','update','disable','retry'].includes(String(value.operation))) throw new Error('记忆操作无效');
    const operation = value.operation as MemoryControl['operation'];
    const input: MemoryControl = {id:randomUUID(),operation};
    if (operation === 'retry') {
      if (!identity(value.jobId)) throw new Error('记忆作业无效');
      input.jobId = value.jobId;
    }
    if (value.restore !== undefined) {
      if (operation !== 'update' || typeof value.restore !== 'boolean') throw new Error('记忆恢复标记无效');
      input.restore = value.restore;
    }
    if (operation === 'update' || operation === 'disable') {
      if (!identity(value.memoryId) || !count(value.expectedRevision) || value.expectedRevision < 1) throw new Error('记忆版本无效，请刷新后重试');
      input.memoryId = value.memoryId; input.expectedRevision = value.expectedRevision;
      if (operation === 'update') {
        if (typeof value.content !== 'string' || !value.content.trim() || value.content.length > 4000) throw new Error('记忆内容必须为 1 至 4000 字符');
        input.content = value.content.trim();
      }
    }
    if (operation === 'backfill') {
      if (!count(value.from) || !count(value.to) || value.to <= value.from || value.to > Date.now() + 60_000) throw new Error('记忆回填时间范围无效');
      input.from = value.from; input.to = value.to;
    }
    return this.deps.transaction(() => {
      this.deps.requireBot(botId);
      const pending = Number(this.db.prepare("SELECT COUNT(*) AS n FROM memory_controls WHERE bot_id=? AND status='pending'").get(botId)!.n);
      if (pending >= 100) throw new Error('记忆待处理操作过多，请等待实例处理');
      if (input.jobId) {
        const job = this.view(botId).view?.jobs.find(job => job.id === input.jobId);
        if (!job || job.status !== 'failed') throw new Error('记忆作业不存在或尚未失败，请刷新后重试');
      }
      if (input.memoryId) {
        const item = this.view(botId).view?.items.find(item => item.id === input.memoryId);
        if (!item) throw new Error('记忆不存在或尚未同步');
        if (item.revision !== input.expectedRevision) throw new Error('记忆版本冲突，请刷新后重试');
      }
      const createdAt = Date.now();
      this.db.prepare("INSERT INTO memory_controls(id,bot_id,request_cipher,status,created_at) VALUES(?,?,?,'pending',?)").run(input.id,botId,this.deps.encrypt(input),createdAt);
      this.deps.change(botId,'memory.control_requested');
      return {...input,status:'pending',error:null,createdAt,finishedAt:null};
    });
  }
  snapshot(botId: string): {controls: MemoryControl[]} {
    this.deps.requireBot(botId);
    const rows = this.db.prepare("SELECT request_cipher FROM memory_controls WHERE bot_id=? AND status='pending' ORDER BY created_at,id LIMIT 100").all(botId) as Array<{request_cipher:string}>;
    return {controls:rows.map(row => this.deps.decrypt(row.request_cipher) as MemoryControl)};
  }
  sync(botId: string, value: unknown): {ok: true} {
    if (!record(value) || !record(value.view) || !Array.isArray(value.receipts) || value.receipts.length > 100) throw new Error('记忆同步数据无效');
    const view = value.view;
    if (typeof view.enabled !== 'boolean' || !count(view.version) || !count(view.cursor) || !count(view.highWater) || view.cursor > view.highWater ||
      !Array.isArray(view.items) || view.items.length > 10_000 || !Array.isArray(view.jobs) || view.jobs.length > 200 || !Array.isArray(view.events) || view.events.length > 500) throw new Error('记忆同步数据无效');
    for (const item of view.items) {
      if (!record(item) || !identity(item.id) || !count(item.revision) || typeof item.content !== 'string' || item.content.length > 4000 || !Array.isArray(item.sources) || item.sources.length > 50 ||
        !['active','superseded','disabled'].includes(String(item.status)) || !['fact','preference','event'].includes(String(item.kind)) || !['person','conversation'].includes(String(item.scope)) ||
        typeof item.topic !== 'string' || item.topic.length > 500 || !(item.subjectUserId === null || typeof item.subjectUserId === 'string') || !count(item.createdAt) || !count(item.updatedAt)) throw new Error('记忆条目同步数据无效');
      for (const source of item.sources) if (!record(source) || typeof source.sourceId !== 'string' || source.sourceId.length > 300 || typeof source.quote !== 'string' || source.quote.length > 8000) throw new Error('记忆来源同步数据无效');
    }
    for (const job of view.jobs) if (!record(job) || !identity(job.id) || !['pending','running','completed','failed','cancelled'].includes(String(job.status)) || !count(job.fromSeq) || !count(job.throughSeq) || !count(job.processedSeq) || !count(job.createdAt)) throw new Error('记忆作业同步数据无效');
    for (const event of view.events) if (!record(event) || !count(event.seq) || !identity(event.jobId) || !count(event.time) || typeof event.type !== 'string' || event.type.length > 100 || !record(event.payload)) throw new Error('记忆事件同步数据无效');
    if (Buffer.byteLength(JSON.stringify(view)) > 3 * 1024 * 1024) throw new Error('记忆同步内容过大');
    for (const receipt of value.receipts) if (!record(receipt) || !identity(receipt.id) || typeof receipt.ok !== 'boolean') throw new Error('记忆操作确认无效');
    const revision = view.version as number; const receipts = value.receipts as Array<{id:string;ok:boolean;error?:string}>;
    return this.deps.transaction(() => {
      this.deps.requireBot(botId); let changed = false;
      const previous = this.db.prepare('SELECT version,view_cipher FROM memory_projection WHERE bot_id=?').get(botId) as {version:number;view_cipher:string} | undefined;
      if ((!previous || revision >= previous.version) && (!previous || JSON.stringify(view) !== JSON.stringify(this.deps.decrypt(previous.view_cipher)))) {
        this.db.prepare('INSERT INTO memory_projection(bot_id,view_cipher,version,updated_at) VALUES(?,?,?,?) ON CONFLICT(bot_id) DO UPDATE SET view_cipher=excluded.view_cipher,version=excluded.version,updated_at=excluded.updated_at').run(botId,this.deps.encrypt(view),view.version as number,Date.now()); changed = true;
      }
      for (const raw of receipts) {
        const receipt = raw as {id:string;ok:boolean;error?:string};
        const control = this.db.prepare('SELECT status FROM memory_controls WHERE id=? AND bot_id=?').get(receipt.id,botId);
        if (!control) throw new Error('记忆操作确认不属于本实例');
        if (control.status === 'pending') {
          const error = receipt.ok ? null : (typeof receipt.error === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/u.test(receipt.error) ? receipt.error : 'MEMORY_CONTROL_FAILED');
          this.db.prepare('UPDATE memory_controls SET status=?,error=?,finished_at=? WHERE id=? AND bot_id=?').run(receipt.ok?'completed':'failed',error,Date.now(),receipt.id,botId); changed = true;
        }
      }
      if (changed) this.deps.change(botId,'memory.updated');
      return {ok:true};
    });
  }
}
