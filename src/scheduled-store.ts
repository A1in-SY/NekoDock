import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { nextTaskTime, previousTaskTime } from './schedule.js';
import type { ReplyToolRequest } from './types.js';
import type { ScheduledRun, ScheduledTask, TaskDeliveryStatus, TaskRunStatus, TaskState } from './scheduled-contract.js';

interface TaskRow { id:string; revision:number; definition:string; next_run_at:number|null }
interface RunRow { id:string; task_id:string; task_revision:number; scheduled_at:number; started_at:number|null; finished_at:number|null; status:TaskRunStatus; delivery_status:TaskDeliveryStatus; accepted_messages:number; acknowledged_messages:number; error:string|null; manual:number; conversation_id:string }
export interface ScheduledOutboxEvent { seq:number; type:string; payload:Record<string,unknown>; runId?:string; conversationId?:string; time:number }
export interface TaskTicket {id:string;taskId:string;operation:'run'|'reset-state';createdAt?:number}

/** Per-instance runtime data; task definitions remain authoritative in Console. */
export class ScheduledStore {
  readonly db:DatabaseSync;
  constructor(path:string) {
    if(path!==':memory:')mkdirSync(dirname(path),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS scheduled_tasks(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,definition TEXT NOT NULL,next_run_at INTEGER);
      CREATE TABLE IF NOT EXISTS scheduled_runs(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,task_revision INTEGER NOT NULL,scheduled_at INTEGER NOT NULL,occurrence_key TEXT NOT NULL UNIQUE,started_at INTEGER,finished_at INTEGER,status TEXT NOT NULL,delivery_status TEXT NOT NULL DEFAULT 'none',accepted_messages INTEGER NOT NULL DEFAULT 0,acknowledged_messages INTEGER NOT NULL DEFAULT 0,error TEXT,manual INTEGER NOT NULL DEFAULT 0,conversation_id TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS scheduled_due ON scheduled_runs(status,scheduled_at);
      CREATE TABLE IF NOT EXISTS scheduled_state(task_id TEXT PRIMARY KEY,version INTEGER NOT NULL,data TEXT NOT NULL,updated_at INTEGER,source_run_id TEXT);
      CREATE TABLE IF NOT EXISTS scheduled_tickets(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,operation TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scheduled_requests(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,request TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempted INTEGER NOT NULL DEFAULT 0,acknowledged_messages INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS scheduled_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,type TEXT NOT NULL,payload TEXT NOT NULL,run_id TEXT,conversation_id TEXT,time INTEGER NOT NULL,exported INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS scheduled_attempts(request_id TEXT NOT NULL,part_index INTEGER NOT NULL,status TEXT NOT NULL,PRIMARY KEY(request_id,part_index));
    `);
  }
  close():void {this.db.close();}
  private transaction<T>(fn:()=>T):T {this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}}
  private emit(type:string,payload:Record<string,unknown>,run?:ScheduledRun,time=Date.now()):void {
    this.db.prepare('INSERT INTO scheduled_events(type,payload,run_id,conversation_id,time) VALUES(?,?,?,?,?)').run(type,JSON.stringify(payload),run?.id??null,run?.conversationId??null,time);
  }
  private updated(run:ScheduledRun,now=Date.now()):void {this.emit('schedule.run.updated',{run},run,now);}
  task(id:string):ScheduledTask|null {
    const row=this.db.prepare('SELECT * FROM scheduled_tasks WHERE id=?').get(id) as unknown as TaskRow|undefined;
    return row?{...JSON.parse(row.definition) as ScheduledTask,nextRunAt:row.next_run_at}:null;
  }
  tasks():ScheduledTask[] {return (this.db.prepare('SELECT id FROM scheduled_tasks ORDER BY id').all() as {id:string}[]).map(row=>this.task(row.id)!);}
  sync(tasks:ScheduledTask[],now=Date.now()):Array<{id:string;revision:number;nextRunAt:number|null}> {
    return this.transaction(()=>{
      for(const task of tasks) {
        const previous=this.task(task.id);
        let next:number|null=previous?.revision===task.revision?previous.nextRunAt??null:nextTaskTime(task,task.updatedAt-1);
        if(!task.enabled||task.deletedAt!==null)next=null;
        this.db.prepare('INSERT INTO scheduled_tasks(id,revision,definition,next_run_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,definition=excluded.definition,next_run_at=excluded.next_run_at').run(task.id,task.revision,JSON.stringify(task),next);
        if(previous?.revision!==task.revision) {
          for(const row of this.db.prepare("SELECT id FROM scheduled_runs WHERE task_id=? AND status='queued'").all(task.id) as {id:string}[])this.finishInTransaction(row.id,'missed','TASK_CHANGED',now);
        }
      }
      return this.tasks().map(task=>({id:task.id,revision:task.revision,nextRunAt:task.nextRunAt??null}));
    });
  }
  /** Generate at most one fresh pending occurrence after downtime; older slots are not replayed. */
  materializeDue(now:number,conversationId:string):void {
    this.transaction(()=>{
      for(const task of this.tasks()) {
        if(!task.enabled||task.deletedAt!==null||task.nextRunAt===null||task.nextRunAt===undefined||task.nextRunAt>now)continue;
        const earliest=task.nextRunAt;
        const latest=previousTaskTime(task,now);
        if(latest!==null&&latest>=earliest) {
          for(const row of this.db.prepare("SELECT id FROM scheduled_runs WHERE task_id=? AND status='queued' AND manual=0 AND scheduled_at<?").all(task.id,latest) as {id:string}[])this.finishInTransaction(row.id,'missed','TASK_SUPERSEDED',now);
          const run=this.insertRun(task,latest,conversationId,false,`${task.id}:${latest}`,now);
          if(run&&now-latest>task.maxDelaySeconds*1000)this.finishInTransaction(run.id,'missed','TASK_EXPIRED',now);
        }
        this.db.prepare('UPDATE scheduled_tasks SET next_run_at=? WHERE id=?').run(nextTaskTime(task,now),task.id);
      }
    });
  }
  private insertRun(task:ScheduledTask,at:number,conversationId:string,manual:boolean,key:string,now:number):ScheduledRun|null {
    const id=randomUUID();const result=this.db.prepare("INSERT OR IGNORE INTO scheduled_runs(id,task_id,task_revision,scheduled_at,occurrence_key,status,manual,conversation_id) VALUES(?,?,?,?,?,'queued',?,?)").run(id,task.id,task.revision,at,key,manual?1:0,conversationId);
    if(!result.changes)return null;const run=this.run(id)!;this.updated(run,now);return run;
  }
  ticket(ticket:TaskTicket,now:number,conversationId:string):void {
    this.transaction(()=>{
      if(this.db.prepare('SELECT 1 FROM scheduled_tickets WHERE id=?').get(ticket.id))return;
      this.db.prepare('INSERT INTO scheduled_tickets(id,task_id,operation) VALUES(?,?,?)').run(ticket.id,ticket.taskId,ticket.operation);
      const task=this.task(ticket.taskId);if(!task||task.deletedAt!==null)return;
      if(ticket.operation==='run')this.insertRun(task,Number.isSafeInteger(ticket.createdAt)?ticket.createdAt!:now,conversationId,true,`ticket:${ticket.id}`,now);
      else {
        const old=this.readState(task.id);
        const state={version:old.version+1,data:{},updatedAt:now,sourceRunId:null};
        this.db.prepare('INSERT INTO scheduled_state(task_id,version,data,updated_at,source_run_id) VALUES(?,?,?,?,NULL) ON CONFLICT(task_id) DO UPDATE SET version=excluded.version,data=excluded.data,updated_at=excluded.updated_at,source_run_id=NULL').run(task.id,state.version,'{}',now);
        this.emit('schedule.state.updated',{taskId:task.id,state},undefined,now);
      }
    });
  }
  hasTicket(id:string):boolean {return !!this.db.prepare('SELECT 1 FROM scheduled_tickets WHERE id=?').get(id);}
  run(id:string):ScheduledRun|null {const row=this.db.prepare('SELECT * FROM scheduled_runs WHERE id=?').get(id) as unknown as RunRow|undefined;return row?runValue(row):null;}
  nextQueued():ScheduledRun|null {const row=this.db.prepare("SELECT * FROM scheduled_runs WHERE status='queued' ORDER BY scheduled_at,id LIMIT 1").get() as unknown as RunRow|undefined;return row?runValue(row):null;}
  startRun(id:string,now=Date.now(),conversationId?:string):ScheduledRun|null {
    return this.transaction(()=>{const changed=this.db.prepare("UPDATE scheduled_runs SET status='running',started_at=?,conversation_id=COALESCE(?,conversation_id) WHERE id=? AND status='queued'").run(now,conversationId??null,id);if(!changed.changes)return null;const run=this.run(id)!;this.updated(run,now);return run;});
  }
  finishRun(id:string,status:TaskRunStatus,error?:string,now=Date.now()):void {this.transaction(()=>this.finishInTransaction(id,status,error,now));}
  private finishInTransaction(id:string,status:TaskRunStatus,error:string|undefined,now:number):void {
    this.db.prepare('UPDATE scheduled_runs SET status=?,finished_at=?,error=? WHERE id=?').run(status,now,error?.slice(0,500)??null,id);const run=this.run(id);if(run)this.updated(run,now);
  }
  recoverInterrupted(now=Date.now()):void {
    this.transaction(()=>{
      const runs=this.db.prepare("SELECT id FROM scheduled_runs WHERE status='running'").all() as {id:string}[];
      for(const {id} of runs) {
        this.db.prepare("UPDATE scheduled_requests SET status=CASE WHEN attempted=1 THEN 'unconfirmed' ELSE 'failed' END WHERE run_id=? AND status='pending'").run(id);
        this.refreshDelivery(id);this.finishInTransaction(id,'interrupted','TASK_INTERRUPTED',now);
      }
    });
  }
  readState(taskId:string):TaskState {
    const row=this.db.prepare('SELECT * FROM scheduled_state WHERE task_id=?').get(taskId) as {version:number;data:string;updated_at:number|null;source_run_id:string|null}|undefined;
    return row?{version:row.version,data:JSON.parse(row.data) as Record<string,unknown>,updatedAt:row.updated_at,sourceRunId:row.source_run_id}:{version:0,data:{},updatedAt:null,sourceRunId:null};
  }
  saveState(taskId:string,runId:string,data:Record<string,unknown>,expectedVersion:number,now=Date.now()):TaskState {
    if(!data||typeof data!=='object'||Array.isArray(data)||!Number.isSafeInteger(expectedVersion)||expectedVersion<0)throw new Error('TASK_STATE_INVALID');
    let encoded:string;try{encoded=JSON.stringify(data);}catch{throw new Error('TASK_STATE_INVALID');}
    if(Buffer.byteLength(encoded)>16*1024)throw new Error('TASK_STATE_TOO_LARGE');
    return this.transaction(()=>{
      const run=this.run(runId);if(!run||run.taskId!==taskId||run.status!=='running')throw new Error('TASK_STATE_UNAVAILABLE');
      const previous=this.readState(taskId);if(previous.version!==expectedVersion)throw new Error('TASK_STATE_VERSION_CONFLICT');
      const state={version:expectedVersion+1,data:JSON.parse(encoded) as Record<string,unknown>,updatedAt:now,sourceRunId:runId};
      this.db.prepare('INSERT INTO scheduled_state(task_id,version,data,updated_at,source_run_id) VALUES(?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET version=excluded.version,data=excluded.data,updated_at=excluded.updated_at,source_run_id=excluded.source_run_id').run(taskId,state.version,encoded,now,runId);
      this.emit('schedule.state.updated',{taskId,state},run,now);return state;
    });
  }
  beginDelivery(runId:string,request:ReplyToolRequest,now=Date.now()):string {
    return this.transaction(()=>{
      const run=this.run(runId);if(!run||run.status!=='running')throw new Error('TASK_SEND_UNAVAILABLE');
      if(run.acceptedMessages+request.messages.length>30)throw new Error('TASK_MESSAGE_LIMIT');
      const id=randomUUID();this.db.prepare('INSERT INTO scheduled_requests(id,run_id,request) VALUES(?,?,?)').run(id,runId,JSON.stringify(request));
      this.db.prepare("UPDATE scheduled_runs SET accepted_messages=accepted_messages+?,delivery_status='pending' WHERE id=?").run(request.messages.length,runId);
      this.updated(this.run(runId)!,now);return id;
    });
  }
  beginAttempt(requestId:string,partIndex=0):boolean {
    return this.transaction(()=>{const changed=this.db.prepare("INSERT OR IGNORE INTO scheduled_attempts(request_id,part_index,status) VALUES(?,?,'started')").run(requestId,partIndex);if(changed.changes)this.db.prepare('UPDATE scheduled_requests SET attempted=1 WHERE id=?').run(requestId);return !!changed.changes;});
  }
  finishAttempt(requestId:string,partIndex:number,status:Exclude<TaskDeliveryStatus,'none'|'pending'|'partial'>):void {this.db.prepare('UPDATE scheduled_attempts SET status=? WHERE request_id=? AND part_index=?').run(status,requestId,partIndex);}
  finishDelivery(requestId:string,status:Exclude<TaskDeliveryStatus,'none'|'pending'>,acknowledgedMessages:number,now=Date.now()):void {
    this.transaction(()=>{
      const row=this.db.prepare('SELECT run_id FROM scheduled_requests WHERE id=?').get(requestId) as {run_id:string}|undefined;if(!row)return;
      this.db.prepare('UPDATE scheduled_requests SET status=?,acknowledged_messages=? WHERE id=?').run(status,acknowledgedMessages,requestId);this.refreshDelivery(row.run_id);this.updated(this.run(row.run_id)!,now);
    });
  }
  private refreshDelivery(runId:string):void {
    const requests=this.db.prepare('SELECT status,acknowledged_messages FROM scheduled_requests WHERE run_id=?').all(runId) as {status:TaskDeliveryStatus;acknowledged_messages:number}[];
    const statuses=new Set(requests.map(row=>row.status));
    const status:TaskDeliveryStatus=!requests.length?'none':statuses.has('pending')?'pending':statuses.size===1&&statuses.has('acknowledged')?'acknowledged':statuses.has('acknowledged')||statuses.has('partial')?'partial':statuses.has('unconfirmed')?'unconfirmed':'failed';
    this.db.prepare('UPDATE scheduled_runs SET delivery_status=?,acknowledged_messages=? WHERE id=?').run(status,requests.reduce((sum,row)=>sum+row.acknowledged_messages,0),runId);
  }
  event(run:ScheduledRun,eventType:string,eventPayload:Record<string,unknown>,now=Date.now()):void {this.emit('schedule.run.event',{taskId:run.taskId,eventType,eventPayload},run,now);}
  pendingEvents(limit=100):ScheduledOutboxEvent[] {
    return (this.db.prepare('SELECT * FROM scheduled_events WHERE exported=0 ORDER BY seq LIMIT ?').all(limit) as {seq:number;type:string;payload:string;run_id:string|null;conversation_id:string|null;time:number}[]).map(row=>({seq:row.seq,type:row.type,payload:JSON.parse(row.payload) as Record<string,unknown>,...(row.run_id?{runId:row.run_id}:{}),...(row.conversation_id?{conversationId:row.conversation_id}:{}),time:row.time}));
  }
  markExported(seq:number):void {this.db.prepare('UPDATE scheduled_events SET exported=1 WHERE seq<=?').run(seq);}
}
function runValue(row:RunRow):ScheduledRun {return {id:row.id,taskId:row.task_id,taskRevision:row.task_revision,scheduledAt:row.scheduled_at,startedAt:row.started_at,finishedAt:row.finished_at,status:row.status,deliveryStatus:row.delivery_status,acceptedMessages:row.accepted_messages,acknowledgedMessages:row.acknowledged_messages,...(row.error?{error:row.error}:{}),manual:!!row.manual,conversationId:row.conversation_id};}
