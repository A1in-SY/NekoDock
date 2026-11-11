import type { DatabaseSync } from 'node:sqlite';
import type { OutgoingDeliveryMetadata, OutputMessage, RecallToolReceipt } from './types.js';
import { ReplyToolError } from './reply-contract.js';

export type ReplyPartState = 'queued' | 'started' | 'acknowledged' | 'failed' | 'unconfirmed' | 'cancelled' | 'recalled';
export interface ReplyLedgerPart {
  messageRef: string; conversationId: string; requestId: string; logicalMessageIndex: number;
  throughSeq: number; partIndex: number; state: ReplyPartState; messageId?: string; replyTo?: string;
  firstPart: boolean; cancelRequested: boolean;
  cancelCode?: string;
}

/** Survives batch cleanup so a later turn can identify exactly what was sent. */
export class ReplyLedger {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS reply_messages (
      message_ref TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,through_seq INTEGER NOT NULL,request_id TEXT NOT NULL,
      logical_index INTEGER NOT NULL,reply_to TEXT,cancel_requested INTEGER NOT NULL DEFAULT 0,cancel_code TEXT,created_at INTEGER NOT NULL,
      UNIQUE(request_id,logical_index)
    ); CREATE TABLE IF NOT EXISTS reply_message_parts (
      message_ref TEXT NOT NULL,through_seq INTEGER NOT NULL,part_index INTEGER NOT NULL,status TEXT NOT NULL,
      message_id TEXT,PRIMARY KEY(through_seq,part_index)
    ); CREATE INDEX IF NOT EXISTS reply_parts_ref ON reply_message_parts(message_ref,part_index);
    CREATE TABLE IF NOT EXISTS reply_recall_operations (
      operation_id TEXT PRIMARY KEY,message_ref TEXT NOT NULL,result_json TEXT,created_at INTEGER NOT NULL
    );`);
  }

  register(throughSeq: number, requestId: string, conversationId: string, messages: OutputMessage[], start: number, count: number, indices?: number[]): string[] {
    const refs=messages.map((message,index)=>{
      const ref=`reply:${requestId}:${index}`;
      this.db.prepare('INSERT OR IGNORE INTO reply_messages(message_ref,conversation_id,through_seq,request_id,logical_index,reply_to,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(ref,conversationId,throughSeq,requestId,index,'replyTo' in message?message.replyTo??null:null,Date.now());
      return ref;
    });
    for(let offset=0;offset<count;offset++) {
      const logical=indices?.[offset]??Math.min(offset,messages.length-1);
      if(!refs[logical])throw new Error('Invalid durable reply mapping.');
      this.db.prepare('INSERT OR IGNORE INTO reply_message_parts(message_ref,through_seq,part_index,status) VALUES(?,?,?,?)')
        .run(refs[logical]!,throughSeq,start+offset,'queued');
    }
    return refs;
  }

  references(requestId: string): string[] {
    return this.db.prepare('SELECT message_ref FROM reply_messages WHERE request_id=? ORDER BY logical_index').all(requestId).map(row=>String(row.message_ref));
  }

  forQQ(messageId: string): ReplyLedgerPart | null {
    const row=this.db.prepare('SELECT through_seq,part_index FROM reply_message_parts WHERE message_id=? ORDER BY through_seq DESC,part_index DESC LIMIT 1').get(messageId);
    return row?this.part(Number(row.through_seq),Number(row.part_index)):null;
  }

  part(throughSeq: number, partIndex: number): ReplyLedgerPart | null {
    const row=this.db.prepare(`SELECT p.*,m.conversation_id,m.request_id,m.logical_index,m.reply_to,m.cancel_requested,m.cancel_code,
      (SELECT MIN(x.part_index) FROM reply_message_parts x WHERE x.message_ref=p.message_ref) AS first_part
      FROM reply_message_parts p JOIN reply_messages m ON m.message_ref=p.message_ref WHERE p.through_seq=? AND p.part_index=?`).get(throughSeq,partIndex);
    return row?{messageRef:String(row.message_ref),conversationId:String(row.conversation_id),requestId:String(row.request_id),
      logicalMessageIndex:Number(row.logical_index),throughSeq:Number(row.through_seq),partIndex:Number(row.part_index),
      state:String(row.status) as ReplyPartState,...(row.message_id?{messageId:String(row.message_id)}:{}),
      ...(row.reply_to?{replyTo:String(row.reply_to)}:{}),...(row.cancel_code?{cancelCode:String(row.cancel_code)}:{}),firstPart:Number(row.first_part)===partIndex,cancelRequested:!!row.cancel_requested}:null;
  }

  parts(messageRef: string, conversationId?: string): ReplyLedgerPart[] {
    const row=this.db.prepare('SELECT conversation_id FROM reply_messages WHERE message_ref=?').get(messageRef);
    if(!row)throw new ReplyToolError('RECALL_TARGET_UNKNOWN','The messageRef does not identify a recorded model reply.');
    if(conversationId!==undefined&&row.conversation_id!==conversationId)throw new ReplyToolError('RECALL_TARGET_FORBIDDEN','The reply belongs to a different conversation.');
    return this.db.prepare('SELECT through_seq,part_index FROM reply_message_parts WHERE message_ref=? ORDER BY part_index').all(messageRef)
      .map(part=>this.part(Number(part.through_seq),Number(part.part_index))!);
  }

  metadata(part: ReplyLedgerPart): OutgoingDeliveryMetadata {
    return {messageRef:part.messageRef,conversationId:part.conversationId,origin:'model',logicalMessageIndex:part.logicalMessageIndex,partIndex:part.partIndex};
  }

  status(throughSeq: number, index: number, state: ReplyPartState, messageId?: string): void {
    this.db.prepare('UPDATE reply_message_parts SET status=?,message_id=COALESCE(?,message_id) WHERE through_seq=? AND part_index=?')
      .run(state,messageId??null,throughSeq,index);
  }

  cancel(messageRef: string, code='REPLY_CANCELLED'): void {
    this.db.prepare('UPDATE reply_messages SET cancel_requested=1,cancel_code=COALESCE(cancel_code,?) WHERE message_ref=?').run(code,messageRef);
    this.db.prepare("UPDATE reply_message_parts SET status='cancelled' WHERE message_ref=? AND status='queued'").run(messageRef);
  }

  cancelQuoted(messageId: string): void {
    for(const row of this.db.prepare('SELECT message_ref FROM reply_messages WHERE reply_to=?').all(messageId))this.cancel(String(row.message_ref),'QUOTE_TARGET_RECALLED');
  }

  recalled(messageId: string): void {
    this.db.prepare("UPDATE reply_message_parts SET status='recalled' WHERE message_id=?").run(messageId);
  }

  abandon(throughSeq: number): void {
    this.db.prepare("UPDATE reply_message_parts SET status=CASE status WHEN 'started' THEN 'unconfirmed' ELSE 'cancelled' END WHERE through_seq=? AND status IN ('queued','started')").run(throughSeq);
  }

  beginRecall(operationId: string, messageRef: string): RecallToolReceipt | 'started' | null {
    const existing=this.db.prepare('SELECT message_ref,result_json FROM reply_recall_operations WHERE operation_id=?').get(operationId);
    if(existing){
      if(existing.message_ref!==messageRef)throw new ReplyToolError('RECALL_OPERATION_CONFLICT','This operation already belongs to another reply.');
      return existing.result_json?JSON.parse(String(existing.result_json)) as RecallToolReceipt:'started';
    }
    this.db.prepare('INSERT INTO reply_recall_operations(operation_id,message_ref,created_at) VALUES(?,?,?)').run(operationId,messageRef,Date.now());
    return null;
  }

  finishRecall(operationId: string, result: RecallToolReceipt): void {
    this.db.prepare('UPDATE reply_recall_operations SET result_json=? WHERE operation_id=? AND result_json IS NULL').run(JSON.stringify(result),operationId);
  }
}
