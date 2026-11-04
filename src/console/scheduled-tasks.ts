import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { BotRecord, ConsoleEvent } from './contracts.js';
import type { ScheduledRun, ScheduledTask, ScheduledTaskInput, TaskRunDetail, TaskState, TaskToolRequest } from '../scheduled-contract.js';
import { nextTaskTime, validateSchedule, validateTask } from '../schedule.js';

interface TaskRow { id: string; bot_id: string; revision: number; creator_id: string | null; created_at: number; updated_at: number; deleted_at: number | null; definition_cipher: string; applied_revision: number; next_run_at: number | null }
export interface TaskTicket { id: string; taskId: string; operation: 'run' | 'reset-state'; createdAt: number }
interface Dependencies {
  requireBot(id: string): BotRecord;
  encrypt(value: unknown): string;
  decrypt(value: string): unknown;
  transaction<T>(fn: () => T): T;
  change(botId: string, type: string): void;
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function revision(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error('任务版本无效'); return value as number; }
function identity(value: unknown): string { if (typeof value !== 'string' || !value || value.length > 256) throw new Error('任务标识无效'); return value; }

/** Definitions are authoritative here; the worker owns occurrence execution and business state. */
export class ScheduledTasks {
  constructor(private readonly db: DatabaseSync, private readonly deps: Dependencies) {
    db.exec(`CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id), revision INTEGER NOT NULL,
      creator_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER,
      definition_cipher TEXT NOT NULL, applied_revision INTEGER NOT NULL DEFAULT 0, next_run_at INTEGER
    ); CREATE INDEX IF NOT EXISTS scheduled_tasks_bot ON scheduled_tasks(bot_id,created_at);
    CREATE TABLE IF NOT EXISTS scheduled_task_revisions (
      task_id TEXT NOT NULL REFERENCES scheduled_tasks(id), revision INTEGER NOT NULL, definition_cipher TEXT NOT NULL,
      created_at INTEGER NOT NULL, PRIMARY KEY(task_id,revision)
    );
    CREATE TABLE IF NOT EXISTS scheduled_task_receipts (
      bot_id TEXT NOT NULL REFERENCES bots(id), operation_id TEXT NOT NULL, request_hash TEXT NOT NULL, result_cipher TEXT NOT NULL,
      created_at INTEGER NOT NULL, PRIMARY KEY(bot_id,operation_id)
    ); CREATE TABLE IF NOT EXISTS scheduled_task_tickets (
      id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id), task_id TEXT NOT NULL REFERENCES scheduled_tasks(id),
      operation TEXT NOT NULL CHECK(operation IN ('run','reset-state')), created_at INTEGER NOT NULL, acknowledged_at INTEGER
    ); CREATE INDEX IF NOT EXISTS scheduled_task_tickets_pending ON scheduled_task_tickets(bot_id,acknowledged_at,created_at);
    CREATE TABLE IF NOT EXISTS scheduled_run_projection (
      bot_id TEXT NOT NULL REFERENCES bots(id), id TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES scheduled_tasks(id),
      scheduled_at INTEGER NOT NULL, last_seq INTEGER NOT NULL, run_cipher TEXT NOT NULL, PRIMARY KEY(bot_id,id)
    ); CREATE INDEX IF NOT EXISTS scheduled_run_task ON scheduled_run_projection(bot_id,task_id,scheduled_at);
    CREATE TABLE IF NOT EXISTS scheduled_run_events (
      bot_id TEXT NOT NULL REFERENCES bots(id), worker_seq INTEGER NOT NULL, run_id TEXT NOT NULL,
      type TEXT NOT NULL, time INTEGER NOT NULL, payload_cipher TEXT NOT NULL, PRIMARY KEY(bot_id,worker_seq)
    ); CREATE INDEX IF NOT EXISTS scheduled_run_events_run ON scheduled_run_events(bot_id,run_id,worker_seq);
    CREATE TABLE IF NOT EXISTS scheduled_state_projection (
      bot_id TEXT NOT NULL REFERENCES bots(id), task_id TEXT NOT NULL REFERENCES scheduled_tasks(id),
      state_cipher TEXT NOT NULL, PRIMARY KEY(bot_id,task_id)
    );
    INSERT OR IGNORE INTO scheduled_task_revisions(task_id,revision,definition_cipher,created_at)
      SELECT id,revision,definition_cipher,updated_at FROM scheduled_tasks;`);
  }

  list(botId: string, includeDeleted = false): ScheduledTask[] {
    this.deps.requireBot(botId);
    return (this.db.prepare(`SELECT * FROM scheduled_tasks WHERE bot_id=? ${includeDeleted ? '' : 'AND deleted_at IS NULL'} ORDER BY created_at,id`).all(botId) as unknown as TaskRow[]).map(row => this.task(row));
  }
  get(botId: string, taskId: string): ScheduledTask | null {
    this.deps.requireBot(botId);
    const row = this.db.prepare('SELECT * FROM scheduled_tasks WHERE bot_id=? AND id=?').get(botId, taskId) as unknown as TaskRow | undefined;
    return row ? this.task(row) : null;
  }
  preview(botId: string, input: unknown): { task: ScheduledTaskInput; nextRuns: number[] } {
    const task = validateTask(input, this.deps.requireBot(botId).config.allowCommands);
    const nextRuns: number[] = []; let after = Date.now();
    for (let i = 0; i < 3; i++) { const next = nextTaskTime(task, after); if (next === null) break; nextRuns.push(next); after = next; }
    return { task, nextRuns };
  }
  create(botId: string, input: unknown, creatorId: string | null = null): ScheduledTask {
    return this.deps.transaction(() => this.insert(botId, input, creatorId));
  }
  update(botId: string, taskId: string, expectedRevision: unknown, patch: unknown): ScheduledTask {
    return this.deps.transaction(() => this.edit(botId, taskId, expectedRevision, patch));
  }
  delete(botId: string, taskId: string, expectedRevision: unknown): ScheduledTask {
    return this.deps.transaction(() => this.remove(botId, taskId, expectedRevision));
  }
  manage(botId: string, operationId: unknown, request: unknown, actorId: unknown): unknown {
    const op = identity(operationId);
    if (typeof actorId !== 'string' || !/^[1-9]\d{0,30}$/.test(actorId)) throw new Error('任务创建者无效');
    if (!record(request) || !['create','list','update','delete'].includes(String(request.operation)) || typeof request.sourceMessageId !== 'string' || !request.sourceMessageId) throw new Error('任务操作无效');
    if (Object.keys(request).some(key => !['operation','sourceMessageId','taskId','expectedRevision','task'].includes(key))) throw new Error('任务操作包含未知字段');
    const input = request as unknown as TaskToolRequest;
    const hash = createHash('sha256').update(JSON.stringify({ request, actorId })).digest('hex');
    return this.deps.transaction(() => {
      const creatorOnly = this.deps.requireBot(botId).config.taskCreatorOnly !== false;
      const receipt = this.db.prepare('SELECT request_hash,result_cipher FROM scheduled_task_receipts WHERE bot_id=? AND operation_id=?').get(botId, op) as {request_hash: string; result_cipher: string} | undefined;
      if (receipt) { if (receipt.request_hash !== hash) throw new Error('任务操作标识已用于不同请求'); return this.deps.decrypt(receipt.result_cipher); }
      let result: unknown;
      if (input.operation === 'list') result = this.list(botId).map(task => {
        if(!creatorOnly||task.creatorId===actorId)return task;
        const {id,name,kind,enabled,schedule,revision,creatorId,nextRunAt}=task;
        return {id,name,kind,enabled,schedule,revision,creatorId,nextRunAt};
      });
      else if (input.operation === 'create') result = this.insert(botId, input.task, actorId);
      else {
        const task = this.requireTask(botId, identity(input.taskId));
        if (creatorOnly && task.creatorId !== actorId) throw new Error('任务只允许创建者修改或删除，请通过控制台管理其他任务');
        result = input.operation === 'update' ? this.edit(botId, task.id, input.expectedRevision, input.task) : this.remove(botId, task.id, input.expectedRevision);
      }
      this.db.prepare('INSERT INTO scheduled_task_receipts(bot_id,operation_id,request_hash,result_cipher,created_at) VALUES (?,?,?,?,?)').run(botId, op, hash, this.deps.encrypt(result), Date.now());
      return result;
    });
  }
  request(botId: string, taskId: string, operation: 'run' | 'reset-state'): {accepted: true; ticketId: string} {
    return this.deps.transaction(() => {
      const task = this.requireTask(botId, taskId);
      if (task.deletedAt !== null) throw new Error('任务已删除');
      if (operation === 'run' && !task.enabled) throw new Error('任务已暂停，请先启用后运行');
      if (operation === 'run' && task.kind === 'script' && !this.deps.requireBot(botId).config.allowCommands) throw new Error('任务脚本需要先启用实例的命令执行权限');
      if (operation === 'run' && this.deps.requireBot(botId).desiredState !== 'running') throw new Error('任务所属实例未启动');
      if (Number(this.db.prepare('SELECT COUNT(*) AS n FROM scheduled_task_tickets WHERE bot_id=? AND acknowledged_at IS NULL').get(botId)!.n) >= 100) throw new Error('任务待处理操作过多，请等待 Worker 处理');
      const ticketId = randomUUID();
      this.db.prepare('INSERT INTO scheduled_task_tickets(id,bot_id,task_id,operation,created_at) VALUES (?,?,?,?,?)').run(ticketId,botId,taskId,operation,Date.now());
      this.deps.change(botId, 'schedule.control_requested'); return {accepted:true,ticketId};
    });
  }
  snapshot(botId: string): {tasks: ScheduledTask[]; tickets: TaskTicket[]} {
    return { tasks: this.list(botId, true), tickets: (this.db.prepare('SELECT id,task_id,operation,created_at FROM scheduled_task_tickets WHERE bot_id=? AND acknowledged_at IS NULL ORDER BY created_at,id LIMIT 100').all(botId) as Array<{id:string; task_id:string; operation:'run'|'reset-state'; created_at:number}>).map(row => ({id:row.id,taskId:row.task_id,operation:row.operation,createdAt:row.created_at})) };
  }
  authorize(botId: string, taskId: unknown, expectedRevision: unknown): {authorized: boolean} {
    const bot = this.deps.requireBot(botId); const task = this.get(botId, identity(taskId));
    return { authorized: bot.desiredState === 'running' && !!task && task.deletedAt === null && task.enabled && task.revision === revision(expectedRevision) && (task.kind !== 'script' || bot.config.allowCommands) };
  }
  applied(botId: string, value: unknown): {ok: true} {
    if (!record(value) || !Array.isArray(value.tasks) || value.tasks.length > 1000 || !Array.isArray(value.acknowledgedTickets) || value.acknowledgedTickets.length > 100) throw new Error('任务同步数据无效');
    return this.deps.transaction(() => {
      this.deps.requireBot(botId); let changed = false;
      for (const entry of value.tasks as unknown[]) {
        if (!record(entry) || typeof entry.id !== 'string' || !Number.isSafeInteger(entry.revision) || (entry.nextRunAt !== null && (!Number.isSafeInteger(entry.nextRunAt) || (entry.nextRunAt as number) < 0))) throw new Error('任务应用版本无效');
        const task = this.requireTask(botId,entry.id);
        if ((entry.revision as number) > task.revision || (entry.revision as number) < task.appliedRevision!) throw new Error('任务应用版本无效');
        if (entry.revision !== task.appliedRevision || entry.nextRunAt !== task.nextRunAt) {
          this.db.prepare('UPDATE scheduled_tasks SET applied_revision=?,next_run_at=? WHERE bot_id=? AND id=?').run(entry.revision as number,entry.nextRunAt as number|null,botId,entry.id); changed = true;
        }
      }
      for (const id of value.acknowledgedTickets as unknown[]) {
        identity(id);
        const result = this.db.prepare('UPDATE scheduled_task_tickets SET acknowledged_at=? WHERE bot_id=? AND id=? AND acknowledged_at IS NULL').run(Date.now(),botId,id as string);
        if (result.changes) changed = true;
      }
      if (changed) this.deps.change(botId, 'schedule.applied');
      return {ok:true};
    });
  }
  runs(botId: string, taskId: string): ScheduledRun[] {
    this.requireTask(botId, taskId);
    return (this.db.prepare('SELECT run_cipher FROM scheduled_run_projection WHERE bot_id=? AND task_id=? ORDER BY scheduled_at DESC,id DESC LIMIT 100').all(botId,taskId) as Array<{run_cipher:string}>).map(row => this.deps.decrypt(row.run_cipher) as ScheduledRun);
  }
  detail(botId: string, runId: string, after?: number): TaskRunDetail | null {
    this.deps.requireBot(botId);
    if(after!==undefined&&(!Number.isSafeInteger(after)||after<0))throw new Error('任务事件游标无效');
    const row = this.db.prepare('SELECT task_id,run_cipher FROM scheduled_run_projection WHERE bot_id=? AND id=?').get(botId,runId) as {task_id:string;run_cipher:string}|undefined;
    if (!row) return null;
    const latest=Number(this.db.prepare('SELECT COALESCE(MAX(worker_seq),0) AS seq FROM scheduled_run_events WHERE bot_id=? AND run_id=?').get(botId,runId)!.seq);
    const rawRows=(after===undefined
      ?this.db.prepare('SELECT worker_seq,type,time,payload_cipher FROM scheduled_run_events WHERE bot_id=? AND run_id=? ORDER BY worker_seq DESC LIMIT 500').all(botId,runId)
      :this.db.prepare('SELECT worker_seq,type,time,payload_cipher FROM scheduled_run_events WHERE bot_id=? AND run_id=? AND worker_seq>? ORDER BY worker_seq LIMIT 500').all(botId,runId,after)) as Array<{worker_seq:number;type:string;time:number;payload_cipher:string}>;
    const selected:TaskRunDetail['events']=[];let bytes=0;
    for(const event of rawRows){
      const decoded={seq:event.worker_seq,type:event.type,time:event.time,payload:this.deps.decrypt(event.payload_cipher) as Record<string,unknown>};
      const size=Buffer.byteLength(JSON.stringify(decoded));if(selected.length&&bytes+size>512*1024)break;
      selected.push(decoded);bytes+=size;
    }
    // Only progress to the end of the examined raw batch. Collapsing cumulative
    // thinking snapshots must not skip unseen events on the following page.
    const cursor=after===undefined?latest:after>latest?latest:selected.at(-1)?.seq??after;
    if(after===undefined)selected.reverse();
    const latestThinking=new Map<string,number>();
    selected.forEach((event,index)=>{if(event.type==='thinking.updated'&&typeof event.payload.itemId==='string')latestThinking.set(event.payload.itemId,index);});
    const events=selected.filter((event,index)=>event.type!=='thinking.updated'||typeof event.payload.itemId!=='string'||latestThinking.get(event.payload.itemId)===index);
    const state = this.db.prepare('SELECT state_cipher FROM scheduled_state_projection WHERE bot_id=? AND task_id=?').get(botId,row.task_id) as {state_cipher:string}|undefined;
    return {run:this.deps.decrypt(row.run_cipher) as ScheduledRun,events,cursor,hasMore:after!==undefined&&cursor<latest,...(state?{taskState:this.deps.decrypt(state.state_cipher) as TaskState}:{})};
  }

  /** Called inside the event-ingest transaction after sanitization and deduplication. */
  ingest(botId: string, event: ConsoleEvent): void {
    const payload=event.payload;
    if (event.type === 'schedule.run.updated') {
      const run = payload.run;
      if (!record(run) || typeof run.id !== 'string' || typeof run.taskId !== 'string' || !['queued','running','completed','failed','interrupted','missed'].includes(String(run.status)) || !['none','pending','acknowledged','failed','unconfirmed','partial'].includes(String(run.deliveryStatus)) || !Number.isSafeInteger(run.scheduledAt) || !Number.isSafeInteger(run.taskRevision) || !Number.isSafeInteger(run.acceptedMessages) || !Number.isSafeInteger(run.acknowledgedMessages)) throw new Error('任务运行事件无效');
      const task=this.requireTask(botId,run.taskId);
      if ((run.taskRevision as number)<1 || (run.taskRevision as number)>task.revision) throw new Error('任务运行版本无效');
      this.db.prepare(`INSERT INTO scheduled_run_projection(bot_id,id,task_id,scheduled_at,last_seq,run_cipher) VALUES (?,?,?,?,?,?)
        ON CONFLICT(bot_id,id) DO UPDATE SET last_seq=excluded.last_seq,run_cipher=excluded.run_cipher WHERE excluded.last_seq>scheduled_run_projection.last_seq`).run(botId,run.id,run.taskId,run.scheduledAt as number,event.seq,this.deps.encrypt(run));
    } else if (event.type === 'schedule.state.updated') {
      if (typeof payload.taskId !== 'string' || !record(payload.state) || !Number.isSafeInteger(payload.state.version) || (payload.state.version as number)<0 || !record(payload.state.data) || Buffer.byteLength(JSON.stringify(payload.state))>20*1024) throw new Error('任务状态事件无效');
      this.requireTask(botId,payload.taskId);
      this.db.prepare('INSERT INTO scheduled_state_projection(bot_id,task_id,state_cipher) VALUES (?,?,?) ON CONFLICT(bot_id,task_id) DO UPDATE SET state_cipher=excluded.state_cipher').run(botId,payload.taskId,this.deps.encrypt(payload.state));
    }
    if (event.runId) {
      const type = event.type === 'schedule.run.event' && typeof payload.eventType==='string' ? payload.eventType : event.type;
      const body = event.type === 'schedule.run.event' && record(payload.eventPayload) ? payload.eventPayload : payload;
      this.db.prepare('INSERT OR IGNORE INTO scheduled_run_events(bot_id,worker_seq,run_id,type,time,payload_cipher) VALUES (?,?,?,?,?,?)').run(botId,event.seq,event.runId,type,event.time,this.deps.encrypt(body));
    }
    this.deps.change(botId,'schedule.event');
  }
  private task(row: TaskRow): ScheduledTask {
    return {...this.deps.decrypt(row.definition_cipher) as ScheduledTaskInput,id:row.id,botId:row.bot_id,revision:row.revision,creatorId:row.creator_id,createdAt:row.created_at,updatedAt:row.updated_at,deletedAt:row.deleted_at,appliedRevision:row.applied_revision,nextRunAt:row.next_run_at};
  }
  private requireTask(botId: string, id: string): ScheduledTask {const task=this.get(botId,id);if(!task)throw new Error('任务不存在');return task;}
  private insert(botId: string, value: unknown, creatorId: string|null): ScheduledTask {
    const bot=this.deps.requireBot(botId);const task=validateTask(value,bot.config.allowCommands);
    if (this.list(botId).length>=100) throw new Error('任务数量不能超过 100');
    const id=randomUUID(),now=Date.now();
    this.db.prepare('INSERT INTO scheduled_tasks(id,bot_id,revision,creator_id,created_at,updated_at,definition_cipher) VALUES (?,?,1,?,?,?,?)').run(id,botId,creatorId,now,now,this.deps.encrypt(task));
    this.db.prepare('INSERT INTO scheduled_task_revisions(task_id,revision,definition_cipher,created_at) VALUES (?,1,?,?)').run(id,this.deps.encrypt(task),now);
    this.deps.change(botId,'schedule.created');return this.requireTask(botId,id);
  }
  private edit(botId: string, id: string, expectedRevision: unknown, patch: unknown): ScheduledTask {
    const current=this.requireTask(botId,id);
    if(current.deletedAt!==null)throw new Error('任务已删除');
    if(current.revision!==revision(expectedRevision))throw new Error('任务版本冲突，请刷新后重试');
    if(!record(patch))throw new Error('任务配置必须为对象');
    const fields=['name','kind','enabled','schedule','instructions','script','context','maxDelaySeconds','timeoutSeconds','notifyOnFailure'];
    if(Object.keys(patch).some(key=>!fields.includes(key)))throw new Error('任务配置包含未知或不可修改的字段');
    const {id:_id,botId:_botId,revision:_revision,creatorId:_creatorId,createdAt:_createdAt,updatedAt:_updatedAt,deletedAt:_deletedAt,appliedRevision:_appliedRevision,nextRunAt:_nextRunAt,...base}=current;
    const unchangedSchedule=patch.schedule===undefined||JSON.stringify(validateSchedule(patch.schedule))===JSON.stringify(current.schedule);
    const pausingExistingScript=current.kind==='script'&&(patch.kind===undefined||patch.kind==='script')&&patch.enabled===false
      &&(patch.script===undefined||JSON.stringify(patch.script)===JSON.stringify(current.script));
    const task=validateTask({...base,...patch},this.deps.requireBot(botId).config.allowCommands||pausingExistingScript,unchangedSchedule?-Infinity:Date.now());
    this.db.prepare('UPDATE scheduled_tasks SET revision=revision+1,updated_at=?,definition_cipher=? WHERE bot_id=? AND id=?').run(Date.now(),this.deps.encrypt(task),botId,id);
    this.db.prepare('INSERT INTO scheduled_task_revisions(task_id,revision,definition_cipher,created_at) VALUES (?,?,?,?)').run(id,current.revision+1,this.deps.encrypt(task),Date.now());
    this.deps.change(botId,'schedule.updated');return this.requireTask(botId,id);
  }
  private remove(botId: string,id:string,expectedRevision:unknown):ScheduledTask {
    const current=this.requireTask(botId,id);
    if(current.revision!==revision(expectedRevision))throw new Error('任务版本冲突，请刷新后重试');
    if(current.deletedAt===null){const now=Date.now();this.db.prepare('UPDATE scheduled_tasks SET revision=revision+1,updated_at=?,deleted_at=? WHERE bot_id=? AND id=?').run(now,now,botId,id);this.deps.change(botId,'schedule.deleted');}
    return this.requireTask(botId,id);
  }
}
