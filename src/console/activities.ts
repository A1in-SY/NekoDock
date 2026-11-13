import type { DatabaseSync } from 'node:sqlite';
import { ACTIVITY_NAMES, type ActivityEvent, type ActivitySpan, type ActivityTimeline, type ProcessSample, type ObservedProcessSample } from '../activity-contract.js';
import type { ConsoleEvent } from './contracts.js';

const kinds = new Set(['run','model','tool','command','plugin','download','render_wait','render','upload','send','compact','memory','schedule','prepare']);
const statuses = new Set(['running','completed','failed','cancelled','interrupted']);
const programs = new Set(['bash','browser','python','ffmpeg','node','downloader','other']);
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,240}$/u.test(value);
const counter = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
export interface ActivityOwner { resourceId: string; botId: string | null; traceId?:string; runId?: string; jobId?: string; pluginId?: string; sourceMessageId?: string; conversationId?: string; }
type Owner=ActivityOwner;
interface SpanRow { data: string; ended_at: number | null; }
export interface MonitorPluginJob { id: string; rootJobId?:string; botId: string; pluginId: string; sourceMessageId: string; conversationId?: string; operation: string; state: string; createdAt: number; startedAt?:number; finishedAt?: number; attempts?:number; leaseUntil?:number; }

/** The projection and its checkpoints share the metrics connection, independently of business writes. */
export class ActivitiesDatabase {
  private readonly pluginStates=new Map<string,string>();
  private readonly pluginAttempts=new Map<string,number>();
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS activity_spans (
      owner TEXT NOT NULL,id TEXT NOT NULL,trace_id TEXT NOT NULL,bot_id TEXT,resource_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,ended_at INTEGER,status TEXT NOT NULL,data TEXT NOT NULL,
      PRIMARY KEY(owner,id));
      CREATE INDEX IF NOT EXISTS activity_time ON activity_spans(started_at,ended_at);
      CREATE INDEX IF NOT EXISTS activity_end ON activity_spans(ended_at,started_at);
      CREATE INDEX IF NOT EXISTS activity_trace ON activity_spans(trace_id,bot_id);
      CREATE TABLE IF NOT EXISTS activity_cursors(bot_id TEXT PRIMARY KEY,seq INTEGER NOT NULL,version INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS activity_process_samples (
        owner TEXT NOT NULL,id TEXT NOT NULL,span_id TEXT NOT NULL,time INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(owner,id));
      CREATE INDEX IF NOT EXISTS activity_process_time ON activity_process_samples(time);
      CREATE INDEX IF NOT EXISTS activity_process_span ON activity_process_samples(owner,span_id,time);
      CREATE TABLE IF NOT EXISTS activity_resources(id TEXT PRIMARY KEY,generation TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS activity_sample_drops(owner TEXT NOT NULL,source TEXT NOT NULL,count INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(owner,source));`);
    db.exec('BEGIN IMMEDIATE');
    try {
      const columns=db.prepare('PRAGMA table_info(activity_cursors)').all();
      if(!columns.some(column=>column.name==='version'))db.exec('ALTER TABLE activity_cursors ADD COLUMN version INTEGER NOT NULL DEFAULT 0');
      // Replay durable boundaries once to repair summaries inferred before run.completed was projected.
      db.exec('UPDATE activity_cursors SET seq=0,version=1 WHERE version<1');
      db.exec('COMMIT');
    } catch(error) { db.exec('ROLLBACK');throw error; }
  }
  private owner(value: Owner): string { return `${value.resourceId}/${value.botId ?? ''}`; }
  cursor(botId: string): number { return Number(this.db.prepare('SELECT seq FROM activity_cursors WHERE bot_id=?').get(botId)?.seq ?? 0); }
  ingest(owner: Owner, input: unknown): void { this.upsert(owner,input); }
  private upsert(owner: Owner, input: unknown, terminalRun=false): void {
    if (!input || typeof input !== 'object') throw new Error('监控事件无效');
    const e = input as ActivityEvent;
    if (!id(e.id) || !id(e.traceId) || e.parentId !== undefined && !id(e.parentId) || !kinds.has(e.kind) || !Object.hasOwn(ACTIVITY_NAMES,e.name)
      || !statuses.has(e.status) || !Number.isSafeInteger(e.time) || !Number.isSafeInteger(e.startedAt) || e.startedAt < 0 || e.time < e.startedAt
      || e.time > Date.now()+60_000 || e.time-e.startedAt > 31*86400000) throw new Error('监控事件无效');
    const metadata: Partial<ActivityEvent> = {};
    for (const key of ['durationMs','requestIndex','firstEventMs','count'] as const) if (e[key] !== undefined) { if (!counter(e[key])) throw new Error('监控事件无效'); metadata[key] = e[key]; }
    if (typeof e.errorCode === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/u.test(e.errorCode)) metadata.errorCode=e.errorCode;
    const traceId=owner.traceId??owner.runId ?? (owner.jobId ? `job:${owner.jobId}` : e.traceId);
    const value: ActivitySpan = { id:e.id,traceId,...(e.parentId?{parentId:e.parentId}:owner.runId&&e.id!==`run:${owner.runId}`?{parentId:`run:${owner.runId}`} : owner.jobId&&e.id!==`job:${owner.jobId}`?{parentId:`job:${owner.jobId}`} : {}),
      kind:e.kind,name:e.name,time:e.time,startedAt:e.startedAt,status:e.status,...metadata,...owner,endedAt:e.status==='running'?null:e.time };
    const previous = this.db.prepare('SELECT data,ended_at FROM activity_spans WHERE owner=? AND id=?').get(this.owner(owner),e.id) as unknown as SpanRow | undefined;
    if (previous) {
      const old=JSON.parse(previous.data) as ActivitySpan;
      const authoritative=terminalRun&&e.id===`run:${owner.runId}`&&e.kind==='run'&&e.status!=='running';
      if (old.startedAt!==e.startedAt || old.traceId!==traceId || old.kind!==e.kind
        || !authoritative&&(old.name!==e.name || old.time>e.time || old.endedAt!==null)) return;
      Object.assign(value,{...old,...value});
      if(value.firstEventMs===undefined&&old.firstEventMs!==undefined)value.firstEventMs=old.firstEventMs;
    }
    this.db.prepare(`INSERT INTO activity_spans(owner,id,trace_id,bot_id,resource_id,started_at,ended_at,status,data) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(owner,id) DO UPDATE SET ended_at=excluded.ended_at,status=excluded.status,data=excluded.data`)
      .run(this.owner(owner),e.id,traceId,owner.botId,owner.resourceId,e.startedAt,value.endedAt,value.status,JSON.stringify(value));
  }
  project(botId: string, events: ConsoleEvent[]): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const event of events) {
        const owner: Owner={botId,resourceId:botId,...(event.runId?{runId:event.runId}:{}),...(event.conversationId?{conversationId:event.conversationId}:{})};
        try {
          const observed=event.type==='activity.updated'?event.payload:event.type==='schedule.run.event'&&event.payload.eventType==='activity.updated'?event.payload.eventPayload:undefined;
          if(observed){this.ingest(owner,observed);const value=observed as ActivityEvent;if(value.status!=='running')this.endChildren(owner,value.id,value.time,value.status==='cancelled'?'cancelled':'interrupted');}
          if(event.type==='runtime.activated')this.interrupt(botId,event.time);
          if(event.runId && ['run.started','run.completed','batch.completed','run.failed','run.cancelled'].includes(event.type)) {
            const spanId=`run:${event.runId}`,old=this.get(owner,spanId);
            const name=event.payload.replyAllowed===false?'append':event.payload.replyAllowed===true?'reply':old?.name??'reply';
            this.upsert(owner,{id:spanId,traceId:event.runId,kind:'run',name,startedAt:old?.startedAt??event.time,time:event.time,
              status:event.type==='run.started'?'running':event.type==='run.completed'||event.type==='batch.completed'?'completed':event.type==='run.cancelled'?'cancelled':'failed'},
              event.type!=='run.started'&&event.type!=='batch.completed');
            if(event.type!=='run.started')this.endTrace(botId,event.runId,event.time,event.type==='run.cancelled'?'cancelled':'interrupted');
          }
          if(event.type==='schedule.run.updated'&&event.runId){
            const run=event.payload.run as import('../scheduled-contract.js').ScheduledRun;
            if(run?.startedAt){const ended=run.finishedAt!==null,state=run.status==='completed'?'completed':run.status==='failed'?'failed':run.status==='interrupted'?'interrupted':'running';
              this.ingest(owner,{id:`run:${event.runId}`,traceId:event.runId,kind:'schedule',name:'scheduled',startedAt:run.startedAt,time:run.finishedAt??event.time,status:state});
              if(ended)this.endTrace(botId,event.runId,run.finishedAt!,state==='failed'?'interrupted':state);
            }
          }
        } catch { /* Invalid optional telemetry cannot poison the durable event cursor. */ }
        this.db.prepare('INSERT INTO activity_cursors(bot_id,seq,version) VALUES(?,?,1) ON CONFLICT(bot_id) DO UPDATE SET seq=MAX(seq,excluded.seq),version=excluded.version').run(botId,event.seq);
      }
      this.db.exec('COMMIT');
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private get(owner:Owner,spanId:string):ActivitySpan|undefined { const row=this.db.prepare('SELECT data FROM activity_spans WHERE owner=? AND id=?').get(this.owner(owner),spanId);return row?JSON.parse(String(row.data)) as ActivitySpan:undefined; }
  private endChildren(owner:Owner,parentId:string,time:number,status:ActivitySpan['status']):void {
    const descendants=new Set([parentId]),rows=this.db.prepare("SELECT owner,id,data FROM activity_spans WHERE owner=? AND ended_at IS NULL AND json_extract(data,'$.kind')<>'send'").all(this.owner(owner));
    for(let changed=true;changed;){changed=false;for(const row of rows){const value=JSON.parse(String(row.data)) as ActivitySpan;if(value.parentId&&descendants.has(value.parentId)&&!descendants.has(value.id)){this.finishRow(row,time,status);descendants.add(value.id);changed=true;}}}
  }
  processSamples(owner:Owner, samples:unknown, dropped:unknown=0,source:unknown='legacy'):void {
    if(!Array.isArray(samples)||samples.length>200||!Number.isSafeInteger(dropped)||Number(dropped)<0||Number(dropped)>1_000_000||!id(source))throw new Error('监控采样无效');
    const safe:ObservedProcessSample[]=samples.map((raw:unknown)=>{
      const s=raw as ProcessSample;
      if(!s||!id(s.id)||!id(s.spanId)||!Number.isSafeInteger(s.time)||s.time<0||s.time>Date.now()+60000||!counter(s.intervalMs)||s.intervalMs>3600_000
        ||s.cpu!==null&&!counter(s.cpu)||s.scope!==undefined&&!['self','tree'].includes(s.scope)||!['sampled','partial','unavailable'].includes(s.coverage)||!Array.isArray(s.processes)||s.processes.length>20)throw new Error('监控采样无效');
      const processes=s.processes.map(p=>{if(!p||!Number.isSafeInteger(p.pid)||p.pid<1||typeof p.startTime!=='string'||!/^\d{1,30}$/u.test(p.startTime)||!programs.has(p.program)||!counter(p.cpu))throw new Error('监控采样无效');return {pid:p.pid,startTime:p.startTime,program:p.program,cpu:p.cpu};});
      return {id:s.id,spanId:s.spanId,time:s.time,intervalMs:s.intervalMs,cpu:s.cpu,scope:s.scope??'tree',coverage:s.coverage,processes,botId:owner.botId,resourceId:owner.resourceId};
    });
    this.db.exec('BEGIN IMMEDIATE');try {
      for(const s of safe)this.db.prepare('INSERT OR IGNORE INTO activity_process_samples(owner,id,span_id,time,data) VALUES(?,?,?,?,?)').run(this.owner(owner),s.id,s.spanId,s.time,JSON.stringify(s));
      if(dropped)this.db.prepare('INSERT INTO activity_sample_drops(owner,source,count) VALUES(?,?,?) ON CONFLICT(owner,source) DO UPDATE SET count=MAX(count,excluded.count)').run(this.owner(owner),source,Number(dropped));
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  resource(id:string,generation:string,startedAt:number):void {
    const old=this.db.prepare('SELECT generation FROM activity_resources WHERE id=?').get(id);
    if(old&&old.generation!==generation)this.interrupt(id,startedAt);
    this.db.prepare('INSERT INTO activity_resources(id,generation) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET generation=excluded.generation').run(id,generation);
  }
  interrupt(resourceId:string,before=Date.now()):void {
    const rows=this.db.prepare("SELECT owner,id,data FROM activity_spans WHERE resource_id=? AND ended_at IS NULL AND started_at<? AND id NOT LIKE 'job:%' AND id NOT LIKE 'queue:%'").all(resourceId,before);
    for(const row of rows)this.finishRow(row,before,'interrupted');
  }
  private finishRow(row:Record<string,unknown>,time:number,status:ActivitySpan['status']):void {
    const value=JSON.parse(String(row.data)) as ActivitySpan;value.endedAt=Math.max(value.startedAt,time);value.time=value.endedAt;value.status=status;
    this.db.prepare('UPDATE activity_spans SET ended_at=?,status=?,data=? WHERE owner=? AND id=?').run(value.endedAt,status,JSON.stringify(value),String(row.owner),String(row.id));
  }
  private endTrace(botId:string,traceId:string,time:number,status:ActivitySpan['status']):void {
    for(const row of this.db.prepare("SELECT owner,id,data FROM activity_spans WHERE bot_id=? AND trace_id=? AND ended_at IS NULL AND json_extract(data,'$.kind')<>'send'").all(botId,traceId))this.finishRow(row,time,status);
  }
  syncPlugins(jobs:MonitorPluginJob[]):void {
    for(const job of jobs) {
      const expired=job.state==='running'&&!!job.leaseUntil&&job.leaseUntil<Date.now();
      const signature=JSON.stringify([job.state,job.startedAt,job.finishedAt,job.conversationId,job.attempts,expired]);if(this.pluginStates.get(job.id)===signature)continue;
      const rootJobId=job.rootJobId??job.id;
      const owner:Owner={resourceId:job.operation==='inspect'||job.operation==='execute'?'service:console':'service:plugin-runner',botId:job.botId,traceId:`job:${rootJobId}`,jobId:job.id,pluginId:job.pluginId,sourceMessageId:job.sourceMessageId,...(job.conversationId?{conversationId:job.conversationId}:{})};
      const finished=['completed','failed','cancelled'].includes(job.state),status:ActivitySpan['status']=finished?job.state==='completed'?'completed':job.state==='cancelled'?'cancelled':'failed':'running';
      this.ingest(owner,{id:`job:${job.id}`,traceId:`job:${rootJobId}`,...(rootJobId!==job.id?{parentId:`job:${rootJobId}`} : {}),kind:'plugin',name:job.operation==='download'?'plugin_download':job.operation==='prepare'?'plugin_prepare':job.operation==='inspect'?'inspect':'plugin_resolve',
        time:finished?(job.finishedAt??Date.now()):job.createdAt,startedAt:job.createdAt,status});
      if(job.operation!=='execute')this.ingest(owner,{id:`queue:${job.id}`,traceId:`job:${job.id}`,parentId:`job:${job.id}`,kind:'plugin',name:'plugin_queue',startedAt:job.createdAt,
        time:job.startedAt??(finished?(job.finishedAt??Date.now()):job.createdAt),status:job.startedAt?'completed':finished?'interrupted':'running'});
      const previousAttempt=this.pluginAttempts.get(job.id),retried=previousAttempt!==undefined&&(job.attempts??0)>previousAttempt;
      if(finished||expired||retried||job.state==='queued')for(const row of this.db.prepare("SELECT owner,id,data FROM activity_spans WHERE bot_id=? AND json_extract(data,'$.jobId')=? AND ended_at IS NULL AND id<>? AND id<>? AND json_extract(data,'$.kind')<>'send'").all(job.botId,job.id,`job:${job.id}`,`queue:${job.id}`))this.finishRow(row,job.finishedAt??Date.now(),'interrupted');
      this.pluginAttempts.set(job.id,job.attempts??0);
      this.pluginStates.set(job.id,signature);if(this.pluginStates.size>4000){const first=this.pluginStates.keys().next().value!;this.pluginStates.delete(first);this.pluginAttempts.delete(first);}
    }
  }
  query(from:number,to:number,options:{botId?:string;resourceId?:string;at?:number;traceId?:string;windowMs?:number}={}):ActivityTimeline {
    const clauses=['started_at<=?','(ended_at IS NULL OR ended_at>=?)'],args:Array<string|number>=[to,from];
    for(const [key,column] of [['botId','bot_id'],['resourceId','resource_id'],['traceId','trace_id']] as const)if(options[key]){clauses.push(`${column}=?`);args.push(options[key]!);}
    const rows=this.db.prepare(`SELECT data,ended_at FROM activity_spans WHERE ${clauses.join(' AND ')} ORDER BY started_at DESC,id LIMIT 1001`).all(...args) as unknown as SpanRow[];
    const at=Math.min(to,Math.max(from,options.at??to)),processArgs:Array<string|number>=[Math.max(from,at-5000),Math.min(to,at+(options.windowMs??5000))];
    const processClauses=['p.time>=?','p.time<=?'];
    for(const [key,column] of [['botId','s.bot_id'],['resourceId','s.resource_id'],['traceId','s.trace_id']] as const)if(options[key]){processClauses.push(`${column}=?`);processArgs.push(options[key]!);}
    const samples=this.db.prepare(`SELECT p.data FROM activity_process_samples p JOIN activity_spans s ON s.owner=p.owner AND s.id=p.span_id WHERE ${processClauses.join(' AND ')} ORDER BY p.time DESC LIMIT 1001`).all(...processArgs);
    const dropRules:string[]=[],dropArgs:string[]=[];
    if(options.botId){dropRules.push("substr(owner,instr(owner,'/')+1)=?");dropArgs.push(options.botId);}
    if(options.resourceId){dropRules.push("substr(owner,1,instr(owner,'/')-1)=?");dropArgs.push(options.resourceId);}
    return {spans:rows.slice(0,1000).map(r=>JSON.parse(r.data) as ActivitySpan).reverse(),processes:samples.slice(0,1000).map(r=>JSON.parse(String(r.data)) as ObservedProcessSample).reverse(),truncated:rows.length>1000,processTruncated:samples.length>1000,
      droppedProcessSamples:Number(this.db.prepare('SELECT COALESCE(SUM(count),0) AS count FROM activity_sample_drops'+(dropRules.length?' WHERE '+dropRules.join(' AND '):'')).get(...dropArgs)!.count)};
  }
  compact(now=Date.now()):void {
    this.db.prepare('DELETE FROM activity_process_samples WHERE time<?').run(now-86400000);
    this.db.prepare("DELETE FROM activity_spans WHERE ended_at<? AND json_extract(data,'$.kind') NOT IN ('run','plugin','memory','schedule')").run(now-7*86400000);
    this.db.prepare('DELETE FROM activity_spans WHERE ended_at<?').run(now-30*86400000);
  }
}
