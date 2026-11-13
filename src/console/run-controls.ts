import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyReply } from 'fastify';
import type { ConsoleEvent } from './contracts.js';
import { runIdentity, type ActiveReplyRun, type RunCancellation, type RunControlView } from '../run-control-contract.js';

interface Host { requireBot(id: string): unknown; change(id: string, type: string): void; }
interface Row { id: string; run_id: string; status: RunCancellation['status']; created_at: number; }
const command = (row: Row): RunCancellation => ({id: row.id, runId: row.run_id, status: row.status, createdAt: row.created_at});

/** Durable, run-scoped commands. Delivery fences survive Console and Worker restarts. */
export class RunControls {
  constructor(private readonly db: DatabaseSync, private readonly host: Host) {
    db.exec(`CREATE TABLE IF NOT EXISTS reply_run_state (
      bot_id TEXT PRIMARY KEY REFERENCES bots(id), supported INTEGER NOT NULL DEFAULT 0,
      worker_seq INTEGER NOT NULL DEFAULT 0, active_json TEXT
    ); CREATE TABLE IF NOT EXISTS reply_run_cancellations (
      id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id), run_id TEXT NOT NULL,
      request_id TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL,
      UNIQUE(bot_id,run_id), UNIQUE(bot_id,request_id)
    );`);
  }
  capability(botId: string, supported: boolean): void {
    const before = this.view(botId).supported;
    this.db.prepare(`INSERT INTO reply_run_state(bot_id,supported) VALUES(?,?)
      ON CONFLICT(bot_id) DO UPDATE SET supported=excluded.supported`).run(botId, supported ? 1 : 0);
    if (before !== supported) this.host.change(botId, 'run.control');
  }
  view(botId: string): RunControlView {
    const row = this.db.prepare('SELECT supported,active_json FROM reply_run_state WHERE bot_id=?').get(botId);
    const active = row?.active_json ? JSON.parse(String(row.active_json)) as ActiveReplyRun : null;
    const cancel = this.db.prepare(`SELECT * FROM reply_run_cancellations WHERE bot_id=?
      ORDER BY created_at DESC,rowid DESC LIMIT 1`).get(botId) as unknown as Row | undefined;
    return {supported: Boolean(row?.supported), active, cancellation: cancel ? command(cancel) : null};
  }
  observe(botId: string, event: ConsoleEvent): void {
    if (!['run.started','run.progress','run.completed','run.failed','run.cancelled','batch.abandoned'].includes(event.type)) return;
    const previous = this.db.prepare('SELECT worker_seq,active_json FROM reply_run_state WHERE bot_id=?').get(botId);
    if (Number(previous?.worker_seq ?? 0) >= event.seq) return;
    let active = previous?.active_json ? JSON.parse(String(previous.active_json)) as ActiveReplyRun : null;
    if (event.type === 'run.started' && runIdentity(event.runId) && event.conversationId) {
      active = {runId:event.runId,conversationId:event.conversationId,throughSeq:Number(event.payload.throughSeq),startedAt:event.time,phase:'preparing'};
    } else if (active && event.runId === active.runId && event.type === 'run.progress') {
      const phase = event.payload.phase;
      if (['preparing','generating','sending','cancelling'].includes(String(phase))) active.phase = phase as ActiveReplyRun['phase'];
    } else if (active && (event.runId === active.runId || event.type === 'batch.abandoned' && event.payload.throughSeq === active.throughSeq)) {
      if (event.type !== 'run.progress' && event.type !== 'run.started') {
        this.finishRun(botId, active.runId, event.type === 'run.cancelled' ? 'cancelled' : 'already_finished');
        active = null;
      }
    }
    this.db.prepare(`INSERT INTO reply_run_state(bot_id,worker_seq,active_json) VALUES(?,?,?)
      ON CONFLICT(bot_id) DO UPDATE SET worker_seq=excluded.worker_seq,active_json=excluded.active_json`)
      .run(botId,event.seq,active ? JSON.stringify(active) : null);
    this.host.change(botId, 'run.control');
  }
  request(botId: string, runId: string, requestId: unknown): RunCancellation {
    this.host.requireBot(botId);
    if (!runIdentity(runId) || !runIdentity(requestId)) throw new Error('停止请求标识无效');
    const reused = this.db.prepare('SELECT * FROM reply_run_cancellations WHERE bot_id=? AND request_id=?').get(botId,requestId) as unknown as Row | undefined;
    if (reused && reused.run_id !== runId) throw Object.assign(new Error('停止请求标识已用于其他轮次'),{statusCode:409});
    const old = reused ?? this.db.prepare('SELECT * FROM reply_run_cancellations WHERE bot_id=? AND run_id=?').get(botId,runId) as unknown as Row | undefined;
    if (old) return command(old);
    const view = this.view(botId);
    if (!view.supported) throw Object.assign(new Error('更新实例后可使用停止当前回复'),{statusCode:409});
    if (view.active?.runId !== runId) throw Object.assign(new Error('该轮回复已结束，请刷新当前会话'),{statusCode:409});
    const result: RunCancellation = {id:randomUUID(),runId,status:'requested',createdAt:Date.now()};
    this.db.prepare('INSERT INTO reply_run_cancellations(id,bot_id,run_id,request_id,status,created_at) VALUES(?,?,?,?,?,?)')
      .run(result.id,botId,runId,requestId,result.status,result.createdAt);
    this.host.change(botId,'run.control');
    return result;
  }
  pending(botId: string): RunCancellation[] {
    return (this.db.prepare("SELECT * FROM reply_run_cancellations WHERE bot_id=? AND status IN ('requested','received') ORDER BY created_at LIMIT 100").all(botId) as unknown as Row[]).map(command);
  }
  acknowledge(botId: string, value: unknown): void {
    const body = value as Partial<RunCancellation> | null;
    if (!body || !runIdentity(body.id) || !runIdentity(body.runId) || !['received','cancelled','already_finished'].includes(String(body.status))) throw new Error('停止回执无效');
    const row = this.db.prepare('SELECT * FROM reply_run_cancellations WHERE bot_id=? AND id=?').get(botId,body.id) as unknown as Row | undefined;
    if (!row || row.run_id !== body.runId) throw new Error('停止回执所属轮次不匹配');
    if (row.status === 'cancelled' || row.status === 'already_finished') return;
    this.db.prepare('UPDATE reply_run_cancellations SET status=? WHERE bot_id=? AND id=?').run(body.status!,botId,body.id);
    this.host.change(botId,'run.control');
  }
  isCancelled(botId: string, runId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM reply_run_cancellations WHERE bot_id=? AND run_id=?').get(botId,runId);
  }
  private finishRun(botId: string, runId: string, status: 'cancelled' | 'already_finished'): void {
    this.db.prepare(`UPDATE reply_run_cancellations SET status=? WHERE bot_id=? AND run_id=?
      AND (status IN ('requested','received') OR ?='cancelled')`).run(status,botId,runId,status);
  }
}

/** Dedicated connection; chat event ACKs and model streams cannot block cancellation. */
export class RunControlStreams {
  private clients = new Set<{botId:string; flush():void; close():void}>();
  constructor(private readonly controls: RunControls) {}
  open(botId: string, reply: FastifyReply): void {
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache',Connection:'keep-alive','X-Accel-Buffering':'no'});
    const sent = new Set<string>(); let closed = false;
    const flush = () => {
      if (closed || response.writableNeedDrain) return;
      for (const value of this.controls.pending(botId)) {
        if (sent.has(value.id)) continue;
        sent.add(value.id);
        if (!response.write(`event: cancel-run\ndata: ${JSON.stringify(value)}\n\n`)) break;
      }
    };
    const close = () => {if(closed)return;closed=true;clearInterval(timer);this.clients.delete(client);response.removeListener('drain',flush);response.end();};
    const client = {botId,flush,close};
    const timer = setInterval(()=>{if(response.destroyed||response.writableLength>64*1024){close();return;}if(!response.writableNeedDrain)response.write(': heartbeat\n\n');flush();},5000);
    timer.unref();this.clients.add(client);response.once('close',close);response.on('drain',flush);
    response.write(': connected\n\n');flush();
  }
  notify(botId: string): void {for(const client of this.clients)if(client.botId===botId)client.flush();}
  close(): void {for(const client of this.clients)client.close();}
}
