import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ConsoleEvent } from './console/contracts.js';

/** Shares the business connection so ingress and delivery events commit atomically. */
export class ConversationRecorder {
  private readonly subscribers = new Set<() => void>();
  constructor(private readonly db: DatabaseSync, private readonly mediaDir?:string) {
    db.exec(`CREATE TABLE IF NOT EXISTS console_state (
      id INTEGER PRIMARY KEY CHECK(id=1), conversation_id TEXT NOT NULL, acknowledged_seq INTEGER NOT NULL DEFAULT 0
    ); CREATE TABLE IF NOT EXISTS console_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT NOT NULL UNIQUE, type TEXT NOT NULL,
      time INTEGER NOT NULL, conversation_id TEXT NOT NULL, run_id TEXT, item_id TEXT, payload_json TEXT NOT NULL
    );`);
    if (!db.prepare('SELECT 1 FROM console_state WHERE id=1').get()) {
      const id = randomUUID();
      db.prepare('INSERT INTO console_state(id,conversation_id) VALUES(1,?)').run(id);
      const messages = db.prepare('SELECT * FROM messages ORDER BY seq').all();
      this.append('conversation.started', { legacy: messages.length > 0 }, 'initial-conversation');
      for (const message of messages) this.append('message.received', {
        messageId: message.message_id, senderId: message.sender_id, senderName: message.sender_name,
        text: message.text, time: Number(message.time)*1000, replyTo: message.reply_to, trigger: message.trigger === 1, legacy: true,
        messageSeq: message.seq,
      }, `incoming:${String(message.message_id)}`, { time: Number(message.time) * 1000, itemId: String(message.message_id) });
      const session = db.prepare('SELECT session_id FROM instance_state WHERE id=1').get()?.session_id;
      if (typeof session === 'string') this.append('session.established', { sessionId: session }, `session:${id}:${session}`);
    }
  }

  get conversationId(): string { return String(this.db.prepare('SELECT conversation_id FROM console_state WHERE id=1').get()!.conversation_id); }

  append(type: string, payload: Record<string,unknown>, key: string = randomUUID(), options: {time?:number; runId?:string; itemId?:string; conversationId?:string} = {}): void {
    // The source messages remain complete in `messages`. Bound the presentation copy so
    // one oversized ingress cannot permanently block heartbeat delivery of later events.
    let encoded=JSON.stringify(payload);
    if(Buffer.byteLength(encoded)>384*1024) {
      const trimmed=Object.fromEntries(Object.entries(payload).map(([name,value])=>[name,
        typeof value==='string'&&value.length>32768?`${value.slice(0,32768)}\n[truncated]`:value]));
      encoded=JSON.stringify({...trimmed,truncated:true});
      if(Buffer.byteLength(encoded)>384*1024) encoded=JSON.stringify({truncated:true,messageId:payload.messageId,
        senderId:payload.senderId,senderName:typeof payload.senderName==='string'?payload.senderName.slice(0,256):undefined,
        time:payload.time,text:typeof payload.text==='string'?payload.text.slice(0,32768):undefined,preview:encoded.slice(0,32768)});
    }
    const inserted=this.db.prepare(`INSERT OR IGNORE INTO console_events(event_key,type,time,conversation_id,run_id,item_id,payload_json)
      VALUES(?,?,?,?,?,?,?)`).run(key,type,options.time ?? Date.now(),options.conversationId ?? this.conversationId,
        options.runId ?? null,options.itemId ?? null,encoded);
    if(inserted.changes) for(const subscriber of this.subscribers) {
      // Subscribers only schedule asynchronous reads: append may be inside a
      // business transaction, which must commit before any event is uploaded.
      try{subscriber();}catch{/* Presentation transport cannot break message persistence. */}
    }
  }

  subscribe(subscriber:()=>void):()=>void {this.subscribers.add(subscriber);return()=>this.subscribers.delete(subscriber);}

  reset(throughSeq: number, commandId: number | string): void {
    const id = randomUUID();
    this.db.prepare('UPDATE console_state SET conversation_id=? WHERE id=1').run(id);
    this.append('conversation.started', { legacy:false }, `conversation:new:${commandId}`);
    const messages = this.db.prepare('SELECT message_id FROM messages WHERE seq>? ORDER BY seq').all(throughSeq);
    if (messages.length) {
      const messageIds = messages.map(row => String(row.message_id));
      // An already uploaded ingress retains its original seq and is moved by this event.
      for(let offset=0;offset<messageIds.length;offset+=500) this.append('conversation.messages_moved', { messageIds:messageIds.slice(offset,offset+500) }, `conversation:moved:${commandId}:${offset}`);
    }
  }

  pending(limit = 100): ConsoleEvent[] {
    const rows = this.db.prepare(`SELECT * FROM console_events WHERE seq>(SELECT acknowledged_seq FROM console_state WHERE id=1)
      ORDER BY seq LIMIT ?`).all(limit);
    const result:ConsoleEvent[]=[];let size=0;
    for(const row of rows) {
      const event:ConsoleEvent={seq:Number(row.seq),type:String(row.type),time:Number(row.time),conversationId:String(row.conversation_id),
      ...(typeof row.run_id==='string'?{runId:row.run_id}:{}),...(typeof row.item_id==='string'?{itemId:row.item_id}:{}),
      payload:JSON.parse(String(row.payload_json)) as Record<string,unknown>};
      const bytes=Buffer.byteLength(JSON.stringify(event));
      if(result.length&&size+bytes>512*1024)break;
      result.push(event);size+=bytes;
    }
    return result;
  }

  mediaSnapshot(file:string,kind:'image'|'voice'):string|undefined {
    if(!this.mediaDir||!file.startsWith('base64://'))return undefined;
    const bytes=Buffer.from(file.slice(9),'base64');
    if(bytes.length>20*1024*1024)return undefined;
    const extension=kind==='voice'?'mp3':bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'png':
      bytes[0]===255&&bytes[1]===216?'jpg':bytes.subarray(0,3).toString()==='GIF'?'gif':
      bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP'?'webp':null;
    if(!extension)return undefined;
    mkdirSync(this.mediaDir,{recursive:true,mode:0o700});
    const path=join(this.mediaDir,`${createHash('sha256').update(bytes).digest('hex')}.${extension}`);
    writeFileSync(path,bytes,{mode:0o600});return path;
  }

  acknowledge(seq: number): void {
    const maximum = Number(this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM console_events').get()!.seq);
    if (!Number.isSafeInteger(seq) || seq<0 || seq>maximum) throw new Error('Invalid console event acknowledgement.');
    this.db.prepare('UPDATE console_state SET acknowledged_seq=MAX(acknowledged_seq,?) WHERE id=1').run(seq);
  }
}

export function safeToolPayload(value: unknown, secrets: string[] = []): unknown {
  const scrub = (input: unknown, depth: number): unknown => {
    if (depth > 8) return '[truncated]';
    if (typeof input==='string') {
      let text=input.replace(/(?:Bearer\s+)[A-Za-z0-9._~+\/-]+/gi,'Bearer [redacted]')
        .replace(/\b(?:sk-|th-)[A-Za-z0-9_-]{12,}/g,'[redacted]');
      for (const secret of secrets) if (secret.length>=4) text=text.split(secret).join('[redacted]');
      return text.length>32_768?`${text.slice(0,32_768)}\n[truncated]`:text;
    }
    if (Array.isArray(input)) return input.slice(0,100).map(item=>scrub(item,depth+1));
    if (input && typeof input==='object') return Object.fromEntries(Object.entries(input).slice(0,100).map(([key,item])=>
      [key,/token|password|authorization|api.?key|secret|base64|reasoning/i.test(key)?'[redacted]':scrub(item,depth+1)]));
    return input;
  };
  const cleaned=scrub(value,0);
  const encoded=JSON.stringify(cleaned);
  if(encoded && Buffer.byteLength(encoded)>128*1024) {
    const object=cleaned&&typeof cleaned==='object'&&!Array.isArray(cleaned)?cleaned as Record<string,unknown>:{};
    return {toolType:object.toolType,tool:object.tool,status:object.status,truncated:true,result:encoded.slice(0,32768)};
  }
  return cleaned;
}
