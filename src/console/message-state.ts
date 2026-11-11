import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ChatRecallEvent } from '../chat-context-contract.js';
import type { OutgoingDeliveryMetadata } from '../types.js';
import type { BotRecord, NapcatConnectionRecord } from './contracts.js';

interface Host { requireBot(id:string):BotRecord; connection(id:string):NapcatConnectionRecord|null; }
interface MessageRow { bot_id:string; connection_id:string; account_id:string; target_type:string; target_id:string; message_id:string; author_id:string|null; registered:number; origin:string; message_ref:string|null; conversation_id:string|null; part_index:number; recalled:number; }
interface RecallRow { event_id:string; bot_id:string; message_id:string; time:number; operator_id:string|null; author_id:string|null; queued_seq:number|null; delivered:number; }

/** Message identity survives delivery-queue pruning; a tombstone never resurrects on late arrival. */
export class ConsoleMessageState {
  constructor(private readonly db:DatabaseSync,private readonly host:Host) {
    db.exec(`CREATE TABLE IF NOT EXISTS napcat_messages (
      bot_id TEXT NOT NULL REFERENCES bots(id),connection_id TEXT NOT NULL,account_id TEXT NOT NULL,
      target_type TEXT NOT NULL,target_id TEXT NOT NULL,message_id TEXT NOT NULL,author_id TEXT,registered INTEGER NOT NULL DEFAULT 0,
      origin TEXT NOT NULL DEFAULT 'unknown',message_ref TEXT,conversation_id TEXT,part_index INTEGER NOT NULL DEFAULT 0,
      recalled INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(bot_id,connection_id,account_id,target_type,target_id,message_id));
      CREATE INDEX IF NOT EXISTS napcat_message_ref ON napcat_messages(bot_id,message_ref);
      CREATE TABLE IF NOT EXISTS napcat_recalls (
      event_id TEXT PRIMARY KEY,bot_id TEXT NOT NULL REFERENCES bots(id),message_id TEXT NOT NULL,time REAL NOT NULL,
      operator_id TEXT,author_id TEXT,queued_seq INTEGER,delivered INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS napcat_recalls_pending ON napcat_recalls(bot_id,delivered,time,event_id);
      CREATE TABLE IF NOT EXISTS napcat_recall_operations (
      bot_id TEXT NOT NULL REFERENCES bots(id),operation_id TEXT NOT NULL,message_ref TEXT NOT NULL,result_json TEXT,
      PRIMARY KEY(bot_id,operation_id));`);
    // An interrupted remote call must not be issued again after restart.
    db.prepare("UPDATE napcat_recall_operations SET result_json=? WHERE result_json IS NULL").run(JSON.stringify({status:'unconfirmed',parts:[],code:'NAPCAT_RECALL_INTERRUPTED'}));
  }
  private scope(botId:string) {
    const bot=this.host.requireBot(botId),accountId=this.host.connection(bot.connectionId)?.accountId;
    return accountId?{bot,accountId,key:[botId,bot.connectionId,accountId,bot.targetType,bot.targetId]}:null;
  }
  get(botId:string,messageId:string):MessageRow|null {
    const scope=this.scope(botId);if(!scope)return null;
    return this.db.prepare('SELECT * FROM napcat_messages WHERE bot_id=? AND connection_id=? AND account_id=? AND target_type=? AND target_id=? AND message_id=?').get(...scope.key,messageId) as unknown as MessageRow??null;
  }
  register(botId:string,messageId:string,authorId:string,origin:string,metadata?:OutgoingDeliveryMetadata):void {
    const scope=this.scope(botId);if(!scope)return;
    const saved=this.db.prepare(`INSERT INTO napcat_messages(bot_id,connection_id,account_id,target_type,target_id,message_id,author_id,registered,origin,message_ref,conversation_id,part_index)
      VALUES(?,?,?,?,?,?,?,1,?,?,?,?) ON CONFLICT(bot_id,connection_id,account_id,target_type,target_id,message_id) DO UPDATE SET
      registered=1,author_id=excluded.author_id,origin=excluded.origin,message_ref=COALESCE(message_ref,excluded.message_ref),
      conversation_id=COALESCE(conversation_id,excluded.conversation_id),part_index=excluded.part_index
      WHERE napcat_messages.registered=0 OR (napcat_messages.author_id=excluded.author_id AND napcat_messages.origin=excluded.origin
        AND napcat_messages.message_ref IS excluded.message_ref AND napcat_messages.conversation_id IS excluded.conversation_id
        AND napcat_messages.part_index=excluded.part_index)`)
      .run(...scope.key,messageId,authorId,origin,metadata?.messageRef??null,metadata?.conversationId??null,metadata?.partIndex??0);
    if(!saved.changes)throw new Error('Platform message identity conflicts with its registered owner.');
  }
  validate(botId:string,ids:string[]):{ok:true}|{ok:false;code:string;messageId:string} {
    for(const messageId of ids){const row=this.get(botId,messageId);
      if(!row||!row.registered)return {ok:false,code:'QUOTE_TARGET_UNKNOWN',messageId};
      if(row.recalled)return {ok:false,code:'QUOTE_TARGET_RECALLED',messageId};
    }return {ok:true};
  }
  owned(botId:string,messageRef:string):MessageRow[] {
    const scope=this.scope(botId);if(!scope)return [];
    return this.db.prepare("SELECT * FROM napcat_messages WHERE bot_id=? AND connection_id=? AND account_id=? AND target_type=? AND target_id=? AND message_ref=? AND registered=1 AND origin='model' AND author_id=? ORDER BY part_index")
      .all(...scope.key,messageRef,scope.accountId) as unknown as MessageRow[];
  }
  recalled(botId:string,messageId:string,time:number,operatorId?:string,authorId?:string):ChatRecallEvent|null {
    this.db.exec('SAVEPOINT message_recall');
    try{const event=this.recordRecall(botId,messageId,time,operatorId,authorId);this.db.exec('RELEASE message_recall');return event;}
    catch(error){this.db.exec('ROLLBACK TO message_recall; RELEASE message_recall');throw error;}
  }
  private recordRecall(botId:string,messageId:string,time:number,operatorId?:string,authorId?:string):ChatRecallEvent|null {
    const scope=this.scope(botId);if(!scope)return null;
    const existing=this.get(botId,messageId);
    if(existing?.registered&&authorId&&existing.author_id!==authorId)return null;
    this.db.prepare(`INSERT INTO napcat_messages(bot_id,connection_id,account_id,target_type,target_id,message_id,author_id,recalled)
      VALUES(?,?,?,?,?,?,?,1) ON CONFLICT(bot_id,connection_id,account_id,target_type,target_id,message_id) DO UPDATE SET recalled=1`)
      .run(...scope.key,messageId,authorId??null);
    const eventId='recall:'+createHash('sha256').update(JSON.stringify([...scope.key,messageId])).digest('hex');
    this.db.prepare('INSERT OR IGNORE INTO napcat_recalls(event_id,bot_id,message_id,time,operator_id,author_id) VALUES(?,?,?,?,?,?)')
      .run(eventId,botId,messageId,time,operatorId??null,authorId??existing?.author_id??null);
    return this.event(this.db.prepare('SELECT * FROM napcat_recalls WHERE event_id=?').get(eventId) as unknown as RecallRow);
  }
  private event(row:RecallRow):ChatRecallEvent {return {eventId:row.event_id,messageId:row.message_id,time:row.time,...(row.operator_id?{operatorId:row.operator_id}:{}),...(row.author_id?{authorId:row.author_id}:{})};}
  pending(botId:string):ChatRecallEvent[] {
    return (this.db.prepare('SELECT * FROM napcat_recalls WHERE bot_id=? AND delivered=0 AND (queued_seq IS NULL OR NOT EXISTS(SELECT 1 FROM napcat_inbound q WHERE q.seq=napcat_recalls.queued_seq)) ORDER BY time,event_id LIMIT 100').all(botId) as unknown as RecallRow[]).map(row=>this.event(row));
  }
  queued(eventId:string,seq:number):void {this.db.prepare('UPDATE napcat_recalls SET queued_seq=? WHERE event_id=?').run(seq,eventId);}
  acknowledge(botId:string,seq:number):void {this.db.prepare('UPDATE napcat_recalls SET delivered=1 WHERE bot_id=? AND queued_seq<=?').run(botId,seq);}
  beginOperation(botId:string,operationId:string,messageRef:string):{created:boolean;result?:unknown} {
    const old=this.db.prepare('SELECT message_ref,result_json FROM napcat_recall_operations WHERE bot_id=? AND operation_id=?').get(botId,operationId) as {message_ref:string;result_json:string|null}|undefined;
    if(old){if(old.message_ref!==messageRef)throw new Error('Recall operation ID was reused.');return {created:false,...(old.result_json?{result:{messageRef,...JSON.parse(old.result_json)}}:{})};}
    this.db.prepare('INSERT INTO napcat_recall_operations(bot_id,operation_id,message_ref) VALUES(?,?,?)').run(botId,operationId,messageRef);return {created:true};
  }
  finishOperation(botId:string,operationId:string,result:unknown):void {this.db.prepare('UPDATE napcat_recall_operations SET result_json=? WHERE bot_id=? AND operation_id=?').run(JSON.stringify(result),botId,operationId);}
}
