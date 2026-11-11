import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { MemoryBatch, MemoryChange, MemoryControl, MemoryHistorySearch, MemoryItem, MemoryJob, MemoryProposal, MemorySearch, MemorySource, MemoryView } from './memory-contract.js';
import { memoryFtsQuery, memoryIndexText, memoryRelevance, memoryTerms } from './memory-search.js';

interface SourceRow { seq:number; id:string; message_id:string|null; sender_id:string; sender_name:string; role:MemorySource['role']; time:number; text:string; }
interface ItemRow { id:string; scope:'person'|'conversation'; subject_user_id:string|null; kind:MemoryItem['kind']; topic:string; content:string; occurred_at:number|null; valid_from:number|null; valid_to:number|null; status:MemoryItem['status']; revision:number; created_at:number; updated_at:number; last_source_seq:number; manual_seq:number; }
interface JobRow { id:string; reason:MemoryJob['reason']; status:MemoryJob['status']; from_seq:number; through_seq:number; processed_seq:number; attempts:number; error:string|null; created_at:number; started_at:number|null; finished_at:number|null; next_attempt:number; }
const MAX_CHANGES=100;
const MAX_CONTENT=4000;
const integer=(value:unknown,min=0,max=Number.MAX_SAFE_INTEGER):value is number=>Number.isSafeInteger(value)&&(value as number)>=min&&(value as number)<=max;
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&value.trim().length>0&&value.length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value);
const sourceValue=(row:SourceRow):MemorySource=>({seq:Number(row.seq),id:row.id,messageId:row.message_id,senderId:row.sender_id,senderName:row.sender_name,role:row.role,time:Number(row.time),text:row.text});
const jobValue=(row:JobRow):MemoryJob=>({id:row.id,reason:row.reason,status:row.status,fromSeq:Number(row.from_seq),throughSeq:Number(row.through_seq),processedSeq:Number(row.processed_seq),attempts:Number(row.attempts),error:row.error,createdAt:Number(row.created_at),startedAt:row.started_at,finishedAt:row.finished_at});

/** Diagnostic locations are safe to return to the model; private evidence is never echoed. */
export class MemoryValidationError extends Error {
  readonly code:string;
  constructor(code:string,readonly changeIndex:number,readonly sourceIndex?:number,readonly sourceSeq?:number) {
    const safe=/^MEMORY_[A-Z_]+$/.test(code)?code:'MEMORY_CHANGE_INVALID';
    const location=[`changeIndex=${changeIndex}`,...(sourceIndex===undefined?[]:[`sourceIndex=${sourceIndex}`]),...(sourceSeq===undefined?[]:[`sourceSeq=${sourceSeq}`])].join(', ');
    const hint=safe==='MEMORY_QUOTE_MISMATCH'?'Copy the exact quote from that source.':safe==='MEMORY_SOURCE_NOT_FOUND'||safe==='MEMORY_SOURCE_OUT_OF_RANGE'?'Use a sourceSeq from the current batch.':'Correct the complete proposal batch and stage it again.';
    super(`${safe}: ${location}. ${hint}`);
    this.name='MemoryValidationError';this.code=safe;
  }
}

/** The instance archive and memory share a WAL database; model work never holds a transaction. */
export class MemoryStore {
  readonly db:DatabaseSync;
  private closed=false;
  private depth=0;
  private recallProjection=false;
  constructor(path:string) {
    if(path!==':memory:')mkdirSync(dirname(path),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA busy_timeout=1000;PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS memory_state(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL DEFAULT 0,initialized INTEGER NOT NULL DEFAULT 0,cursor INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 0);
      INSERT OR IGNORE INTO memory_state(id) VALUES(1);
      CREATE TABLE IF NOT EXISTS memory_ingest(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,message_id TEXT,sender_id TEXT NOT NULL,sender_name TEXT NOT NULL,role TEXT NOT NULL,time INTEGER NOT NULL,text TEXT NOT NULL,indexed INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS memory_ingest_time ON memory_ingest(time);
      CREATE INDEX IF NOT EXISTS memory_ingest_sender ON memory_ingest(sender_id,seq);
      CREATE TABLE IF NOT EXISTS memory_items(id TEXT PRIMARY KEY,scope TEXT NOT NULL,subject_user_id TEXT,kind TEXT NOT NULL,topic TEXT NOT NULL,content TEXT NOT NULL,occurred_at INTEGER,valid_from INTEGER,valid_to INTEGER,status TEXT NOT NULL,revision INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,last_source_seq INTEGER NOT NULL DEFAULT 0,manual_seq INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS memory_subject ON memory_items(subject_user_id,status);
      CREATE TABLE IF NOT EXISTS memory_sources(memory_id TEXT NOT NULL,source_id TEXT NOT NULL,quote TEXT NOT NULL,PRIMARY KEY(memory_id,source_id,quote));
      CREATE TABLE IF NOT EXISTS memory_revisions(memory_id TEXT NOT NULL,revision INTEGER NOT NULL,item_json TEXT NOT NULL,actor TEXT NOT NULL,time INTEGER NOT NULL,PRIMARY KEY(memory_id,revision));
      CREATE TABLE IF NOT EXISTS memory_exclusions(id TEXT PRIMARY KEY,memory_id TEXT NOT NULL,subject_key TEXT NOT NULL,topic TEXT NOT NULL,source_id TEXT,through_seq INTEGER NOT NULL,block_property INTEGER NOT NULL DEFAULT 1);
      CREATE INDEX IF NOT EXISTS memory_exclusion_subject ON memory_exclusions(subject_key,topic);
      CREATE TABLE IF NOT EXISTS memory_jobs(id TEXT PRIMARY KEY,reason TEXT NOT NULL,status TEXT NOT NULL,from_seq INTEGER NOT NULL,through_seq INTEGER NOT NULL,processed_seq INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,error TEXT,created_at INTEGER NOT NULL,started_at INTEGER,finished_at INTEGER,next_attempt INTEGER NOT NULL DEFAULT 0,from_time INTEGER,to_time INTEGER,source_offset INTEGER NOT NULL DEFAULT 0,batch_through INTEGER,batch_next_offset INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS memory_job_status ON memory_jobs(status,created_at);
      CREATE TABLE IF NOT EXISTS memory_triggers(trigger_key TEXT PRIMARY KEY,job_id TEXT,time INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_receipts(id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT NOT NULL,time INTEGER NOT NULL,type TEXT NOT NULL,payload_json TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_source_fts USING fts5(source_id UNINDEXED,tokens);
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_item_fts USING fts5(memory_id UNINDEXED,tokens);
    `);
    // Triggers run in the archive writer's transaction, including ACK-derived replies.
    const archive=this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='messages'").get();
    if(archive) this.tx(()=>{
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS memory_ingest_incoming AFTER INSERT ON messages BEGIN
          INSERT OR IGNORE INTO memory_ingest(id,message_id,sender_id,sender_name,role,time,text) VALUES('in:'||NEW.message_id,NEW.message_id,NEW.sender_id,NEW.sender_name,'user',NEW.time*1000,NEW.text);
          UPDATE memory_state SET version=version+1 WHERE id=1;
        END;
        CREATE TRIGGER IF NOT EXISTS memory_ingest_outgoing AFTER INSERT ON outgoing_history BEGIN
          INSERT OR IGNORE INTO memory_ingest(id,message_id,sender_id,sender_name,role,time,text) VALUES('out:'||NEW.id,NEW.message_id,'self','Assistant','assistant',NEW.time,NEW.text);
          UPDATE memory_state SET version=version+1 WHERE id=1;
        END;
      `);
      if(!this.db.prepare("SELECT 1 FROM memory_triggers WHERE trigger_key='archive:seeded'").get()){
        this.db.exec(`INSERT OR IGNORE INTO memory_ingest(id,message_id,sender_id,sender_name,role,time,text)
            SELECT 'in:'||message_id,message_id,sender_id,sender_name,'user',time*1000,text FROM messages ORDER BY seq;
          INSERT OR IGNORE INTO memory_ingest(id,message_id,sender_id,sender_name,role,time,text)
            SELECT 'out:'||id,message_id,'self','Assistant','assistant',time,text FROM outgoing_history ORDER BY time,id;`);
        this.db.prepare("INSERT INTO memory_triggers(trigger_key,time)VALUES('archive:seeded',?)").run(Date.now());
      }
    });
    this.db.prepare("UPDATE memory_jobs SET status='pending',error='MEMORY_INTERRUPTED',next_attempt=0 WHERE status='running'").run();
  }
  /** Journal the same versioned chat content that supplies the main conversation. */
  enableChatProjection(): void {
    if (!this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='chat_messages'").get()) return;
    this.tx(() => {
      this.db.exec(`
        DROP TRIGGER IF EXISTS memory_ingest_incoming;
        DROP TRIGGER IF EXISTS memory_ingest_outgoing;
        CREATE TRIGGER IF NOT EXISTS memory_ingest_chat AFTER INSERT ON chat_messages BEGIN
          INSERT OR IGNORE INTO memory_ingest(id,message_id,sender_id,sender_name,role,time,text)
          VALUES(NEW.id,NEW.qq_message_id,NEW.sender_id,NEW.sender_name,NEW.role,CAST(NEW.time*1000 AS INTEGER),
            NEW.text||CASE WHEN NEW.contents_json<>'[]' THEN char(10)||'[Shared content]'||char(10)||NEW.contents_json ELSE '' END);
          UPDATE memory_state SET version=version+changes() WHERE id=1;
        END;
        CREATE TRIGGER IF NOT EXISTS memory_ingest_chat_revision AFTER UPDATE OF text,contents_json ON chat_messages
        WHEN NEW.text<>OLD.text OR NEW.contents_json<>OLD.contents_json BEGIN
          INSERT OR IGNORE INTO memory_ingest(id,message_id,sender_id,sender_name,role,time,text)
          VALUES('revision:'||NEW.id||':'||NEW.revision,NEW.qq_message_id,NEW.sender_id,NEW.sender_name,NEW.role,CAST(NEW.time*1000 AS INTEGER),
            NEW.text||CASE WHEN NEW.contents_json<>'[]' THEN char(10)||'[Shared content]'||char(10)||NEW.contents_json ELSE '' END);
          UPDATE memory_state SET version=version+changes() WHERE id=1;
        END;
        INSERT OR IGNORE INTO memory_ingest(id,message_id,sender_id,sender_name,role,time,text)
          SELECT id,qq_message_id,sender_id,sender_name,role,CAST(time*1000 AS INTEGER),
            text||CASE WHEN contents_json<>'[]' THEN char(10)||'[Shared content]'||char(10)||contents_json ELSE '' END
          FROM chat_messages ORDER BY seq;
        INSERT OR IGNORE INTO memory_ingest(id,message_id,sender_id,sender_name,role,time,text)
          SELECT 'revision:'||id||':'||revision,qq_message_id,sender_id,sender_name,role,CAST(time*1000 AS INTEGER),
            text||char(10)||'[Shared content]'||char(10)||contents_json
          FROM chat_messages WHERE contents_json<>'[]' ORDER BY seq;
      `);
      this.recallProjection=!!this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='chat_recall_events'").get();
      if(this.recallProjection)this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS memory_ingest_chat_recall AFTER INSERT ON chat_recall_events BEGIN
          INSERT OR IGNORE INTO memory_ingest(id,message_id,sender_id,sender_name,role,time,text)
          VALUES('recall:'||NEW.event_id,NEW.message_id,'system','Chat state','system',CAST(NEW.time*1000 AS INTEGER),
            json_object('type','message_recalled','eventId',NEW.event_id,'messageId',NEW.message_id,'recalled',json('true'),'time',NEW.time));
          UPDATE memory_state SET version=version+changes() WHERE id=1;
        END;
        INSERT OR IGNORE INTO memory_ingest(id,message_id,sender_id,sender_name,role,time,text)
          SELECT 'recall:'||event_id,message_id,'system','Chat state','system',CAST(time*1000 AS INTEGER),
            json_object('type','message_recalled','eventId',event_id,'messageId',message_id,'recalled',json('true'),'time',time)
          FROM chat_recall_events ORDER BY rowid;
      `);
    });
  }
  close():void {if(!this.closed){this.closed=true;this.db.close();}}
  private tx<T>(fn:()=>T):T {
    const nested=this.depth>0,savepoint=`memory_${this.depth++}`;
    this.db.exec(nested?`SAVEPOINT ${savepoint}`:'BEGIN IMMEDIATE');
    try {const result=fn();this.db.exec(nested?`RELEASE ${savepoint}`:'COMMIT');return result;}
    catch(error){this.db.exec(nested?`ROLLBACK TO ${savepoint}`:'ROLLBACK');if(nested)this.db.exec(`RELEASE ${savepoint}`);throw error;}
    finally {this.depth--;}
  }
  private bump():void {this.db.exec('UPDATE memory_state SET version=version+1 WHERE id=1');}
  private emit(jobId:string,type:string,payload:Record<string,unknown>,now=Date.now()):void {this.db.prepare('INSERT INTO memory_events(job_id,time,type,payload_json)VALUES(?,?,?,?)').run(jobId,now,type,JSON.stringify(payload));this.bump();}
  event(jobId:string,type:string,payload:Record<string,unknown>):void {
    if(!text(jobId,200)||!text(type,100)||Buffer.byteLength(JSON.stringify(payload))>128*1024)throw new Error('MEMORY_EVENT_INVALID');
    this.tx(()=>this.emit(jobId,type,payload));
  }
  initialize(enabled:boolean):void {
    this.tx(()=>{
      const state=this.db.prepare('SELECT * FROM memory_state WHERE id=1').get()!;
      if(enabled&&!state.initialized)this.db.prepare('UPDATE memory_state SET initialized=1,cursor=? WHERE id=1').run(this.highWater());
      if(Boolean(state.enabled)!==enabled){this.db.prepare('UPDATE memory_state SET enabled=? WHERE id=1').run(enabled?1:0);this.bump();}
    });
  }
  get enabled():boolean{return !!this.db.prepare('SELECT enabled FROM memory_state WHERE id=1').get()!.enabled;}
  highWater():number{return Number(this.db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM memory_ingest').get()!.n);}
  cursor():number{return Number(this.db.prepare('SELECT cursor FROM memory_state WHERE id=1').get()!.cursor);}
  private row(id:string):ItemRow|null{return this.db.prepare('SELECT * FROM memory_items WHERE id=?').get(id) as unknown as ItemRow|undefined??null;}
  private recallState(messageId:string|null):{recalled?:true;recalledAt?:number} {
    if(!this.recallProjection||!messageId)return {};
    const event=this.db.prepare('SELECT time FROM chat_recall_events WHERE message_id=?').get(messageId);
    return event?{recalled:true,recalledAt:Number(event.time)*1000}:{};
  }
  private source(row:SourceRow):MemorySource {
    const source=sourceValue(row);
    return row.role==='system'&&row.id.startsWith('recall:')?{...source,kind:'message_recalled'}:{...source,...this.recallState(row.message_id)};
  }
  private item(row:ItemRow):MemoryItem {return {id:row.id,scope:row.scope,subjectUserId:row.subject_user_id,kind:row.kind,topic:row.topic,content:row.content,occurredAt:row.occurred_at,validFrom:row.valid_from,validTo:row.valid_to,status:row.status,revision:row.revision,sources:(this.db.prepare('SELECT s.source_id AS sourceId,s.quote,i.message_id FROM memory_sources s LEFT JOIN memory_ingest i ON i.id=s.source_id WHERE s.memory_id=? ORDER BY s.source_id,s.quote').all(row.id) as Array<{sourceId:string;quote:string;message_id:string|null}>).map(source=>({sourceId:source.sourceId,quote:source.quote,...this.recallState(source.message_id)})),createdAt:row.created_at,updatedAt:row.updated_at};}
  get(id:string):MemoryItem|null {const row=this.row(id);return row?this.item(row):null;}
  activeItems(limit=10000,afterId=''):MemoryItem[]{return (this.db.prepare("SELECT * FROM memory_items WHERE status='active' AND id>? ORDER BY id LIMIT ?").all(afterId,Math.max(1,Math.min(10000,limit))) as unknown as ItemRow[]).map(row=>this.item(row));}
  job(id:string):MemoryJob|null {const row=this.db.prepare('SELECT * FROM memory_jobs WHERE id=?').get(id) as unknown as JobRow|undefined;return row?jobValue(row):null;}
  request(reason:MemoryJob['reason'],key:string,throughSeq=this.highWater(),fromSeq?:number):MemoryJob|null {
    if(!text(key,500)||!integer(throughSeq)||throughSeq>this.highWater()||fromSeq!==undefined&&!integer(fromSeq))throw new Error('MEMORY_JOB_INVALID');
    return this.tx(()=>{
      const old=this.db.prepare('SELECT job_id FROM memory_triggers WHERE trigger_key=?').get(key);
      if(old)return typeof old.job_id==='string'?this.job(old.job_id):null;
      if(!this.enabled){this.db.prepare('INSERT INTO memory_triggers(trigger_key,time)VALUES(?,?)').run(key,Date.now());return null;}
      const from=fromSeq??this.cursor();
      if(throughSeq<=from){this.db.prepare('INSERT INTO memory_triggers(trigger_key,time)VALUES(?,?)').run(key,Date.now());return null;}
      let job:MemoryJob|null=null;
      if(reason!=='backfill') {
        const pending=this.db.prepare("SELECT id FROM memory_jobs WHERE status='pending' AND reason<>'backfill' ORDER BY created_at,id LIMIT 1").get();
        if(pending){this.db.prepare('UPDATE memory_jobs SET from_seq=MIN(from_seq,?),through_seq=MAX(through_seq,?) WHERE id=?').run(from,throughSeq,pending.id as string);job=this.job(pending.id as string);}
        else {
          const running=this.db.prepare("SELECT id,through_seq FROM memory_jobs WHERE status='running' AND reason<>'backfill' ORDER BY created_at LIMIT 1").get();
          if(running&&Number(running.through_seq)>=throughSeq)job=this.job(running.id as string);
        }
      }
      if(!job){const id=randomUUID(),now=Date.now();this.db.prepare("INSERT INTO memory_jobs(id,reason,status,from_seq,through_seq,processed_seq,created_at)VALUES(?,?,'pending',?,?,?,?)").run(id,reason,from,throughSeq,from,now);job=this.job(id)!;}
      this.db.prepare('INSERT INTO memory_triggers(trigger_key,job_id,time)VALUES(?,?,?)').run(key,job.id,Date.now());
      this.emit(job.id,'memory.job.queued',{job});return job;
    });
  }
  claim(now=Date.now()):MemoryJob|null {
    return this.tx(()=>{
      if(!this.enabled||this.db.prepare("SELECT 1 FROM memory_jobs WHERE status='running'").get())return null;
      const row=this.db.prepare("SELECT * FROM memory_jobs WHERE status='pending' AND next_attempt<=? ORDER BY created_at,id LIMIT 1").get(now) as unknown as JobRow|undefined;
      if(!row)return null;
      if(row.reason!=='backfill')this.db.prepare('UPDATE memory_jobs SET processed_seq=MAX(processed_seq,?) WHERE id=?').run(this.cursor(),row.id);
      this.db.prepare("UPDATE memory_jobs SET status='running',attempts=attempts+1,started_at=?,finished_at=NULL,error=NULL WHERE id=?").run(now,row.id);
      const job=this.job(row.id)!;this.emit(job.id,'memory.job.started',{job},now);return job;
    });
  }
  batch(jobId:string,limit=100,maxBytes=24000):MemoryBatch|null {
    const job=this.job(jobId);if(!job||job.status!=='running')throw new Error('MEMORY_JOB_UNAVAILABLE');
    const range=this.db.prepare('SELECT from_time,to_time,source_offset FROM memory_jobs WHERE id=?').get(jobId)!;
    const rows=this.db.prepare('SELECT * FROM memory_ingest WHERE seq>? AND seq<=? AND (? IS NULL OR time>=?) AND (? IS NULL OR time<?) ORDER BY seq LIMIT ?').all(job.processedSeq,job.throughSeq,range.from_time??null,range.from_time??null,range.to_time??null,range.to_time??null,Math.max(1,Math.min(100,limit))) as unknown as SourceRow[];
    if(!rows.length)return null;
    const sources:MemorySource[]=[];let used=0,nextOffset=0;
    for(const row of rows){
      const source=this.source(row),offset=sources.length?0:Number(range.source_offset??0);
      if(offset){source.text=source.text.slice(offset);source.textOffset=offset;}
      const size=Buffer.byteLength(JSON.stringify(source));if(sources.length&&used+size>maxBytes)break;
      if(size>maxBytes){const length=Math.max(100,Math.floor(maxBytes/4));source.text=source.text.slice(0,length);source.textOffset=offset;source.truncated=offset+source.text.length<row.text.length;nextOffset=source.truncated?offset+source.text.length:0;}
      sources.push(source);used+=Buffer.byteLength(JSON.stringify(source));if(nextOffset)break;
    }
    this.db.prepare('UPDATE memory_jobs SET batch_through=?,batch_next_offset=? WHERE id=?').run(sources.at(-1)!.seq,nextOffset,jobId);
    const participants=new Set(sources.filter(source=>source.role==='user').map(source=>source.senderId));
    const memories:MemoryItem[]=[];let memoryBudget=12000;
    for(const item of this.search({limit:100,includeInactive:true})){
      if(item.scope==='person'&&!participants.has(item.subjectUserId??''))continue;
      const compact={...item,sources:item.sources.slice(0,3).map(source=>({...source,quote:source.quote.slice(0,600)}))};
      const size=Buffer.byteLength(JSON.stringify(compact));if(size>memoryBudget)continue;memories.push(compact);memoryBudget-=size;if(memories.length>=20)break;
    }
    return {jobId,fromSeq:job.processedSeq,throughSeq:sources.at(-1)!.seq,sources,memories,now:Date.now()};
  }
  publish(jobId:string,batchThrough:number,changes:MemoryChange[]):MemoryJob {
    if(!Array.isArray(changes)||changes.length>MAX_CHANGES)throw new Error('MEMORY_CHANGES_INVALID');
    return this.tx(()=>{
      const job=this.job(jobId);if(!job||job.status!=='running'||!integer(batchThrough,job.processedSeq,job.throughSeq))throw new Error('MEMORY_JOB_UNAVAILABLE');
      const pending=this.db.prepare('SELECT batch_through,batch_next_offset FROM memory_jobs WHERE id=?').get(jobId)!;
      if(pending.batch_through!==null&&Number(pending.batch_through)!==batchThrough)throw new Error('MEMORY_BATCH_CONFLICT');
      for(const change of changes)this.apply(change,job,batchThrough);
      const offset=Number(pending.batch_next_offset??0),processed=offset?Math.max(job.processedSeq,batchThrough-1):batchThrough;
      if(job.reason!=='backfill')this.db.prepare('UPDATE memory_state SET cursor=MAX(cursor,?) WHERE id=1').run(processed);
      this.db.prepare("UPDATE memory_jobs SET processed_seq=?,source_offset=?,batch_through=NULL,batch_next_offset=0,status=CASE WHEN ?>=through_seq AND ?=0 THEN 'completed' ELSE 'running' END,finished_at=CASE WHEN ?>=through_seq AND ?=0 THEN ? ELSE NULL END WHERE id=?").run(processed,offset,processed,offset,processed,offset,Date.now(),jobId);
      const updated=this.job(jobId)!;this.emit(jobId,'memory.job.published',{job:updated,changeCount:changes.length});return updated;
    });
  }
  /** Resolve model references and exercise the real mutation rules without publishing anything. */
  validateProposals(jobId:string,batchThrough:number,proposals:MemoryProposal[]):MemoryChange[] {
    if(!Array.isArray(proposals)||proposals.length>MAX_CHANGES)throw new MemoryValidationError('MEMORY_CHANGES_INVALID',-1);
    return this.tx(()=>{
      const job=this.job(jobId);
      if(!job||job.status!=='running'||!integer(batchThrough,job.processedSeq,job.throughSeq))throw new MemoryValidationError('MEMORY_JOB_UNAVAILABLE',-1);
      const range=this.db.prepare('SELECT batch_through,from_time,to_time FROM memory_jobs WHERE id=?').get(jobId)!;
      if(range.batch_through===null||Number(range.batch_through)!==batchThrough)throw new MemoryValidationError('MEMORY_BATCH_CONFLICT',-1);
      const allowed=new Set(['operation','id','expectedRevision','restore','scope','subjectUserId','kind','topic','content','occurredAt','validFrom','validTo','sources']);
      const changes:MemoryChange[]=proposals.map((proposal,changeIndex)=>{
        if(!proposal||typeof proposal!=='object'||Array.isArray(proposal)||Object.keys(proposal).some(key=>!allowed.has(key))||!Array.isArray(proposal.sources)||!proposal.sources.length||proposal.sources.length>20)throw new MemoryValidationError('MEMORY_CHANGE_INVALID',changeIndex);
        if(proposal.restore!==undefined&&typeof proposal.restore!=='boolean'||proposal.id!==undefined&&!text(proposal.id,200))throw new MemoryValidationError('MEMORY_CHANGE_INVALID',changeIndex);
        const sources=proposal.sources.map((evidence,sourceIndex)=>{
          const seq=integer(evidence?.sourceSeq,1)?evidence.sourceSeq:undefined;
          if(!evidence||typeof evidence!=='object'||Array.isArray(evidence)||Object.keys(evidence).some(key=>key!=='sourceSeq'&&key!=='quote')||seq===undefined||!text(evidence.quote,4000))throw new MemoryValidationError('MEMORY_SOURCE_INVALID',changeIndex,sourceIndex,seq);
          const row=this.db.prepare('SELECT * FROM memory_ingest WHERE seq=?').get(seq) as unknown as SourceRow|undefined;
          if(!row)throw new MemoryValidationError('MEMORY_SOURCE_NOT_FOUND',changeIndex,sourceIndex,seq);
          if(seq<=job.processedSeq||seq>batchThrough||range.from_time!==null&&row.time<Number(range.from_time)||range.to_time!==null&&row.time>=Number(range.to_time))throw new MemoryValidationError('MEMORY_SOURCE_OUT_OF_RANGE',changeIndex,sourceIndex,seq);
          if(!row.text.includes(evidence.quote))throw new MemoryValidationError('MEMORY_QUOTE_MISMATCH',changeIndex,sourceIndex,seq);
          return {sourceId:row.id,quote:evidence.quote};
        });
        return {...proposal,sources};
      });
      // Each apply sees preceding proposals (including revision changes), exactly as at publish.
      // The savepoint is rolled back even on success, including FTS, revisions, events and counters.
      this.db.exec('SAVEPOINT memory_proposal_validation');
      try {
        for(const [index,change] of changes.entries()) {
          try {this.apply(change,job,batchThrough);}
          catch(error){const code=error instanceof Error&&/^MEMORY_[A-Z_]+$/.test(error.message)?error.message:'MEMORY_CHANGE_INVALID';throw new MemoryValidationError(code,index);}
        }
      } finally {this.db.exec('ROLLBACK TO memory_proposal_validation');this.db.exec('RELEASE memory_proposal_validation');}
      return changes;
    });
  }
  private apply(change:MemoryChange,job:MemoryJob,batchThrough:number):void {
    if(!change||!['upsert','disable'].includes(change.operation)||!Array.isArray(change.sources)||!change.sources.length||change.sources.length>20)throw new Error('MEMORY_CHANGE_INVALID');
    const sources:MemorySource[]=[];
    const range=this.db.prepare('SELECT from_time,to_time FROM memory_jobs WHERE id=?').get(job.id)!;
    for(const evidence of change.sources){
      if(!evidence||!text(evidence.sourceId,300)||!text(evidence.quote,4000))throw new Error('MEMORY_SOURCE_INVALID');
      const row=this.db.prepare('SELECT * FROM memory_ingest WHERE id=? AND seq>? AND seq<=?').get(evidence.sourceId,job.processedSeq,batchThrough) as unknown as SourceRow|undefined;
      if(!row||!row.text.includes(evidence.quote)||range.from_time!==null&&row.time<Number(range.from_time)||range.to_time!==null&&row.time>=Number(range.to_time))throw new Error('MEMORY_SOURCE_INVALID');sources.push(this.source(row));
    }
    const previous=change.id?this.row(change.id):null;
    if(change.id&&(!previous||!integer(change.expectedRevision,1)||previous.revision!==change.expectedRevision))throw new Error('MEMORY_VERSION_CONFLICT');
    const scope=change.scope??previous?.scope;
    const subject=change.subjectUserId??previous?.subject_user_id??null;
    if(scope!=='person'&&scope!=='conversation'||scope==='person'&&!text(subject,100)||scope==='conversation'&&subject!==null)throw new Error('MEMORY_SUBJECT_INVALID');
    if(previous&&(previous.scope!==scope||previous.subject_user_id!==subject))throw new Error('MEMORY_SUBJECT_INVALID');
    if(scope==='person'&&!sources.some(source=>source.role==='user'&&source.senderId===subject))throw new Error('MEMORY_SELF_EVIDENCE_REQUIRED');
    if(!sources.some(source=>source.role==='user'))throw new Error('MEMORY_HUMAN_EVIDENCE_REQUIRED');
    const newest=Math.max(...sources.map(source=>source.seq));
    if(previous&&(newest<previous.last_source_seq||newest<=previous.manual_seq))return;
    if(change.operation==='disable'){
      if(!previous)throw new Error('MEMORY_CHANGE_INVALID');this.disable(previous,sources,change.sources,'agent',newest);return;
    }
    const topic=change.topic??previous?.topic,content=change.content??previous?.content,kind=change.kind??previous?.kind;
    if(!text(topic,200)||!text(content,MAX_CONTENT)||!kind||!['fact','preference','event'].includes(kind))throw new Error('MEMORY_CHANGE_INVALID');
    const subjectKey=scope==='person'?`person:${subject}`:'conversation';
    if(change.restore===true){
      if(!previous||previous.status!=='disabled')throw new Error('MEMORY_RESTORE_INVALID');
      const cutoff=Number(this.db.prepare('SELECT COALESCE(MAX(through_seq),0) AS n FROM memory_exclusions WHERE memory_id=?').get(previous.id)!.n);
      if(!sources.some(source=>source.role==='user'&&source.seq>cutoff&&(scope==='conversation'||source.senderId===subject)))throw new Error('MEMORY_RESTORE_SOURCE_REQUIRED');
    }else if(previous?.status==='disabled')return;
    const blocked=this.db.prepare(`SELECT 1 FROM memory_exclusions WHERE (block_property=1 AND subject_key=? AND topic=? AND (? IS NULL OR memory_id<>?)) OR source_id IN (${sources.map(()=>'?').join(',')}) LIMIT 1`).get(subjectKey,topic,change.restore===true?previous!.id:null,change.restore===true?previous!.id:null,...sources.map(source=>source.id));
    if(blocked)return;
    if(change.restore===true)this.db.prepare('UPDATE memory_exclusions SET block_property=0 WHERE memory_id=?').run(previous!.id);
    const times=[change.occurredAt!==undefined?change.occurredAt:previous?.occurred_at??null,change.validFrom!==undefined?change.validFrom:previous?.valid_from??null,change.validTo!==undefined?change.validTo:previous?.valid_to??null];
    if(times.some(value=>value!==null&&!integer(value))||times[1]!==null&&times[2]!==null&&times[2]!<=times[1]!)throw new Error('MEMORY_TIME_INVALID');
    const duplicate=!previous?this.db.prepare("SELECT id FROM memory_items WHERE scope=? AND subject_user_id IS ? AND topic=? AND content=? AND status='active' LIMIT 1").get(scope,subject,topic,content):undefined;
    if(duplicate)return;
    const id=previous?.id??randomUUID(),revision=(previous?.revision??0)+1,now=Date.now();
    this.db.prepare(`INSERT INTO memory_items(id,scope,subject_user_id,kind,topic,content,occurred_at,valid_from,valid_to,status,revision,created_at,updated_at,last_source_seq,manual_seq)VALUES(?,?,?,?,?,?,?,?,?,'active',?,?,?,?,0)
      ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,topic=excluded.topic,content=excluded.content,occurred_at=excluded.occurred_at,valid_from=excluded.valid_from,valid_to=excluded.valid_to,status='active',revision=excluded.revision,updated_at=excluded.updated_at,last_source_seq=excluded.last_source_seq`).run(id,scope,subject,kind,topic,content,...times,revision,previous?.created_at??now,now,newest);
    this.db.prepare('DELETE FROM memory_sources WHERE memory_id=?').run(id);
    for(const source of change.sources)this.db.prepare('INSERT OR IGNORE INTO memory_sources(memory_id,source_id,quote)VALUES(?,?,?)').run(id,source.sourceId,source.quote);
    this.indexItem(id,`${topic} ${content}`);this.revision(id,'agent');this.emit(job.id,previous?'memory.updated':'memory.created',{memoryId:id,revision});
  }
  private revision(id:string,actor:string):void {const item=this.get(id)!;this.db.prepare('INSERT INTO memory_revisions(memory_id,revision,item_json,actor,time)VALUES(?,?,?,?,?)').run(id,item.revision,JSON.stringify(item),actor,Date.now());}
  private disable(previous:ItemRow,sources:MemorySource[],evidence:MemoryChange['sources'],actor:string,throughSeq:number):void {
    this.db.prepare("UPDATE memory_items SET status='disabled',revision=revision+1,updated_at=?,last_source_seq=MAX(last_source_seq,?) WHERE id=?").run(Date.now(),Math.max(0,...sources.map(source=>source.seq)),previous.id);
    const subjectKey=previous.scope==='person'?`person:${previous.subject_user_id}`:'conversation';
    const old=this.get(previous.id)!;
    for(const source of [...old.sources,...evidence])this.db.prepare('INSERT OR IGNORE INTO memory_exclusions(id,memory_id,subject_key,topic,source_id,through_seq)VALUES(?,?,?,?,?,?)').run(createHash('sha256').update(`${previous.id}:${source.sourceId}`).digest('hex'),previous.id,subjectKey,previous.topic,source.sourceId,throughSeq);
    if(!old.sources.length&&!evidence.length)this.db.prepare('INSERT OR IGNORE INTO memory_exclusions(id,memory_id,subject_key,topic,through_seq)VALUES(?,?,?,?,?)').run(previous.id,previous.id,subjectKey,previous.topic,throughSeq);
    this.db.prepare('DELETE FROM memory_item_fts WHERE memory_id=?').run(previous.id);this.revision(previous.id,actor);
  }
  private indexItem(id:string,content:string):void {this.db.prepare('DELETE FROM memory_item_fts WHERE memory_id=?').run(id);this.db.prepare('INSERT INTO memory_item_fts(memory_id,tokens)VALUES(?,?)').run(id,memoryIndexText(content));}
  indexSources(limit=500):number {
    return this.tx(()=>{const rows=this.db.prepare('SELECT seq,id,substr(text,1,32768) AS text,length(text) AS full_length FROM memory_ingest WHERE indexed=0 ORDER BY seq LIMIT ?').all(Math.max(1,Math.min(5000,limit))) as Array<{seq:number;id:string;text:string;full_length:number}>;
      let count=0,bytes=0;
      for(const row of rows){const size=Buffer.byteLength(row.text);if(count&&bytes+size>128*1024)break;this.db.prepare('INSERT INTO memory_source_fts(source_id,tokens)VALUES(?,?)').run(row.id,memoryIndexText(row.text));this.db.prepare('UPDATE memory_ingest SET indexed=? WHERE seq=?').run(row.full_length>32768?2:1,row.seq);count++;bytes+=size;}return count;});
  }
  search(request:MemorySearch={}):MemoryItem[] {
    const limit=integer(request.limit,1,1000)?request.limit:20;const params:Array<string|number>=[];const where:string[]=[];
    if(!request.includeInactive){where.push("status='active'",'(valid_from IS NULL OR valid_from<=?)','(valid_to IS NULL OR valid_to>?)');params.push(Date.now(),Date.now());}
    if(request.subjectUserId){where.push('subject_user_id=?');params.push(request.subjectUserId);}
    if(request.kind){where.push('kind=?');params.push(request.kind);}
    const query=request.query?.slice(0,2000).trim()??'',fts=memoryFtsQuery(query);
    if(query){if(!fts)return [];where.push('id IN (SELECT memory_id FROM memory_item_fts WHERE memory_item_fts MATCH ?)');params.push(fts);}
    const rows=this.db.prepare(`SELECT * FROM memory_items ${where.length?`WHERE ${where.join(' AND ')}`:''} ORDER BY updated_at DESC,id LIMIT ?`).all(...params,query?1000:limit) as unknown as ItemRow[];
    const ranked=rows.map(row=>this.item(row)).sort((a,b)=>query?memoryRelevance(query,`${b.topic} ${b.content}`)-memoryRelevance(query,`${a.topic} ${a.content}`)||b.updatedAt-a.updatedAt:b.updatedAt-a.updatedAt).slice(0,limit);
    const result:MemoryItem[]=[];let budget=24*1024;
    for(const item of ranked){const bounded={...item,sources:item.sources.slice(0,3).map(source=>({...source,quote:source.quote.slice(0,400)}))};const size=Buffer.byteLength(JSON.stringify(bounded));if(size>budget)break;result.push(bounded);budget-=size;}return result;
  }
  recall(query:string,subjectIds:string[],budget:number,maxItems=8):MemoryItem[] {
    const candidates=this.search({query,limit:100}).filter(item=>item.scope==='conversation'||!!item.subjectUserId&&subjectIds.includes(item.subjectUserId));
    const result:MemoryItem[]=[];let remaining=Math.max(0,budget);
    for(const item of candidates){if(memoryRelevance(query,`${item.topic} ${item.content}`)<1)continue;const size=Buffer.byteLength(JSON.stringify(item));if(size>remaining)continue;result.push(item);remaining-=size;if(result.length>=Math.min(8,maxItems))break;}return result;
  }
  history(request:MemoryHistorySearch={},bounds?:{fromSeq:number;throughSeq:number;jobId?:string}):{messages:MemorySource[];availableCount:number;truncated:boolean;nextSeq:number|null} {
    this.indexSources(500);
    const limit=integer(request.limit,1,100)?request.limit:30;const where=['NOT EXISTS(SELECT 1 FROM memory_exclusions e WHERE e.source_id=memory_ingest.id)'];const params:Array<string|number>=[];
    if(bounds){where.push('seq>?','seq<=?');params.push(bounds.fromSeq,bounds.throughSeq);}
    if(bounds?.jobId){const range=this.db.prepare('SELECT from_time,to_time FROM memory_jobs WHERE id=?').get(bounds.jobId);if(!range)throw new Error('MEMORY_JOB_UNAVAILABLE');if(range.from_time!==null){where.push('time>=?');params.push(Number(range.from_time));}if(range.to_time!==null){where.push('time<?');params.push(Number(range.to_time));}}
    if(request.senderId){where.push('sender_id=?');params.push(request.senderId);}
    if(integer(request.from)){where.push('time>=?');params.push(request.from);}
    if(integer(request.to)){where.push('time<?');params.push(request.to);}
    if(integer(request.afterSeq)){where.push('seq>?');params.push(request.afterSeq);}
    if(request.aroundMessageId){const source=this.db.prepare('SELECT seq FROM memory_ingest WHERE message_id=? OR id=? ORDER BY seq LIMIT 1').get(request.aroundMessageId,request.aroundMessageId);if(!source)return {messages:[],availableCount:0,truncated:false,nextSeq:null};where.push('seq>=?','seq<=?');params.push(Math.max(0,Number(source.seq)-Math.floor(limit/2)),Number(source.seq)+Math.floor(limit/2));}
    const query=request.query?.slice(0,2000).trim()??'',fts=memoryFtsQuery(query);
    if(query){if(!fts)return {messages:[],availableCount:0,truncated:false,nextSeq:null};const terms=memoryTerms(query).filter(term=>[...term].length>1).slice(0,100);const fallback=terms.length?terms:memoryTerms(query).slice(0,100);where.push(`(id IN (SELECT source_id FROM memory_source_fts WHERE memory_source_fts MATCH ?) OR (indexed<>1 AND (${fallback.map(()=>"instr(lower(text),?)>0").join(' OR ')||'0'})))`);params.push(fts,...fallback);}
    const clause=where.join(' AND '),availableCount=Number(this.db.prepare(`SELECT COUNT(*) AS n FROM memory_ingest WHERE ${clause}`).get(...params)!.n);
    const rows=this.db.prepare(`SELECT * FROM memory_ingest WHERE ${clause} ORDER BY seq LIMIT ?`).all(...params,limit) as unknown as SourceRow[];
    const offset=integer(request.textOffset,0)?request.textOffset:0;
    const messages:MemorySource[]=[];let remaining=24*1024-512;
    for(const row of rows){const source=this.source(row),fullLength=source.text.length;source.text=source.text.slice(offset,offset+8000);source.senderName=source.senderName.slice(0,200);if(offset)source.textOffset=offset;
      let size=Buffer.byteLength(JSON.stringify(source));
      if(size>remaining&&messages.length)break;
      if(size>remaining){source.text=source.text.slice(0,Math.max(0,Math.floor((remaining-500)/4)));size=Buffer.byteLength(JSON.stringify(source));}
      if(offset+source.text.length<fullLength)source.truncated=true;
      messages.push(source);remaining-=size+32;
    }
    return {messages,availableCount,truncated:messages.length<availableCount||messages.some(source=>source.truncated),nextSeq:messages.length<availableCount?messages.at(-1)?.seq??null:null};
  }
  fail(id:string,error:string,retry=true):void {
    this.tx(()=>{const job=this.job(id);if(!job||job.status!=='running')return;const pending=retry&&job.attempts<3;const safe=/^(?:MEMORY|PI)_[A-Z_]+$/.test(error)?error:'MEMORY_EXECUTION_FAILED';this.db.prepare('UPDATE memory_jobs SET status=?,error=?,finished_at=?,next_attempt=? WHERE id=?').run(pending?'pending':'failed',safe,Date.now(),Date.now()+Math.min(60000,job.attempts*10000),id);this.emit(id,'memory.job.failed',{job:this.job(id)});});
  }
  release(id:string):void {
    this.tx(()=>{const job=this.job(id);if(!job||job.status!=='running')return;this.db.prepare("UPDATE memory_jobs SET status='pending',attempts=MAX(0,attempts-1),next_attempt=0,error=NULL WHERE id=?").run(id);this.emit(id,'memory.job.released',{job:this.job(id)});});
  }
  resume(id:string):MemoryJob {
    if(!text(id,200))throw new Error('MEMORY_JOB_INVALID');
    return this.tx(()=>{
      if(!this.enabled)throw new Error('MEMORY_DISABLED');
      const job=this.job(id);if(!job||job.status!=='failed')throw new Error('MEMORY_JOB_NOT_FAILED');
      this.db.prepare("UPDATE memory_jobs SET status='pending',attempts=0,error=NULL,next_attempt=0,started_at=NULL,finished_at=NULL,batch_through=NULL,batch_next_offset=0 WHERE id=?").run(id);
      const resumed=this.job(id)!;this.emit(id,'memory.job.resumed',{job:resumed});return resumed;
    });
  }
  cancel(id?:string):void {this.tx(()=>{const jobs=id?[this.job(id)].filter((job):job is MemoryJob=>!!job):(this.db.prepare("SELECT * FROM memory_jobs WHERE status IN ('pending','running')").all() as unknown as JobRow[]).map(jobValue);for(const job of jobs){if(!['pending','running'].includes(job.status))continue;this.db.prepare("UPDATE memory_jobs SET status='cancelled',finished_at=? WHERE id=?").run(Date.now(),job.id);this.emit(job.id,'memory.job.cancelled',{job:this.job(job.id)});}});}
  control(input:MemoryControl):{accepted:true;jobId?:string;memoryId?:string} {
    if(!input||!text(input.id,200)||!['run','backfill','cancel','update','disable','retry'].includes(input.operation))throw new Error('MEMORY_CONTROL_INVALID');
    return this.tx(()=>{
    const hash=createHash('sha256').update(JSON.stringify(input)).digest('hex');const old=this.db.prepare('SELECT * FROM memory_receipts WHERE id=?').get(input.id);
    if(old){if(old.request_hash!==hash)throw new Error('MEMORY_CONTROL_CONFLICT');return JSON.parse(old.result as string) as {accepted:true;jobId?:string;memoryId?:string};}
    let result:{accepted:true;jobId?:string;memoryId?:string}={accepted:true};
    if(input.operation==='run'){const job=this.request('manual',`control:${input.id}`);result={accepted:true,...(job?{jobId:job.id}:{})};}
    else if(input.operation==='backfill'){
      if(!integer(input.from)||!integer(input.to)||input.to<=input.from)throw new Error('MEMORY_RANGE_INVALID');
      const row=this.db.prepare('SELECT MIN(seq) AS first,MAX(seq) AS last FROM memory_ingest WHERE time>=? AND time<?').get(input.from,input.to)!;
      if(row.first!==null&&row.last!==null){const job=this.request('backfill',`control:${input.id}`,Number(row.last),Number(row.first)-1);if(job){result.jobId=job.id;this.db.prepare('UPDATE memory_jobs SET from_time=?,to_time=? WHERE id=?').run(input.from,input.to,job.id);}}
    }else if(input.operation==='cancel'){this.cancel();}
    else if(input.operation==='retry'){
      if(!text(input.jobId,200))throw new Error('MEMORY_CONTROL_INVALID');
      result.jobId=this.resume(input.jobId).id;
    }
    else {
      this.tx(()=>{
        if(!text(input.memoryId,100)||!integer(input.expectedRevision,1))throw new Error('MEMORY_CONTROL_INVALID');const row=this.row(input.memoryId);
        if(!row||row.revision!==input.expectedRevision)throw new Error('MEMORY_VERSION_CONFLICT');
        if(input.operation==='disable')this.disable(row,[],[],'console',this.highWater());
        else {
          if(!text(input.content,MAX_CONTENT))throw new Error('MEMORY_CONTROL_INVALID');
          const restore=input.restore===true;
          this.db.prepare('UPDATE memory_items SET content=?,revision=revision+1,updated_at=?,manual_seq=?,status=CASE WHEN ? THEN \'active\' ELSE status END WHERE id=?').run(input.content,Date.now(),this.highWater(),restore?1:0,row.id);
          if(restore)this.db.prepare('UPDATE memory_exclusions SET block_property=0 WHERE memory_id=?').run(row.id);
          if(row.status==='active'||restore)this.indexItem(row.id,`${row.topic} ${input.content}`);this.revision(row.id,'console');
        }
        this.emit('control:'+input.id,'memory.control.completed',{memoryId:row.id,operation:input.operation});result={accepted:true,memoryId:row.id};
      });
    }
    this.db.prepare('INSERT INTO memory_receipts(id,request_hash,result)VALUES(?,?,?)').run(input.id,hash,JSON.stringify(result));return result;
    });
  }
  view():MemoryView {
    const state=this.db.prepare('SELECT * FROM memory_state WHERE id=1').get()!;
    const totalItems=Number(this.db.prepare('SELECT COUNT(*) AS n FROM memory_items').get()!.n),jobs=(this.db.prepare('SELECT * FROM memory_jobs ORDER BY created_at DESC,id DESC LIMIT 50').all() as unknown as JobRow[]).map(jobValue);
    const view:MemoryView={enabled:!!state.enabled,cursor:Number(state.cursor),highWater:this.highWater(),version:Number(state.version),items:[],jobs,events:[],totalItems,truncated:false};
    let remaining=768*1024-Buffer.byteLength(JSON.stringify(view));
    const items=this.db.prepare('SELECT * FROM memory_items ORDER BY updated_at DESC,id LIMIT 1000').all() as unknown as ItemRow[];
    for(const row of items){const item=this.item(row),size=Buffer.byteLength(JSON.stringify(item));if(size>remaining){view.truncated=true;continue;}view.items.push(item);remaining-=size;}
    if(view.items.length<totalItems)view.truncated=true;
    const events=this.db.prepare('SELECT * FROM memory_events ORDER BY seq DESC LIMIT 100').all() as Array<{seq:number;job_id:string;time:number;type:string;payload_json:string}>;
    for(const row of events){const payload=JSON.parse(row.payload_json) as Record<string,unknown>;const event={seq:row.seq,jobId:row.job_id,time:row.time,type:row.type,payload};const size=Buffer.byteLength(JSON.stringify(event));if(size>remaining){view.truncated=true;continue;}view.events.unshift(event);remaining-=size;}
    return view;
  }
}
