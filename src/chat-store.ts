import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ChatAsset, ChatContextMessage, ContextCommit, ContextSubmission, PluginChatReply } from './chat-context-contract.js';
import type { CachedIncomingImage } from './incoming-image-contract.js';
import type { StoredMessage } from './types.js';
import { incomingMessageText } from './napcat.js';
import { isForwardSnapshot, type ForwardContent, type ForwardSnapshot } from './forward-contract.js';

interface Row {
  seq:number;
  id: string; conversation_id: string; qq_message_id: string | null; revision: number;
  sender_id: string; sender_name: string; role: 'user' | 'assistant'; origin: ChatContextMessage['origin'];
  time: number; text: string; reply_to: string | null; assets_json: string; contents_json: string;
  source_message_id: string | null; plugin_id: string | null; projection: 'message' | 'reference';
  tool_call_id: string|null;logical_index:number|null;part_index:number|null;
}
const value = (row: Row): ChatContextMessage => ({
  chatMessageId: row.id, conversationId: row.conversation_id, revision: Number(row.revision),sequence:Number(row.seq),
  messageId: row.qq_message_id, senderId: row.sender_id, senderName: row.sender_name,
  time: Number(row.time), text: row.text, replyTo: row.reply_to, role: row.role, origin: row.origin,
  ...(row.assets_json !== '[]' ? { assets: JSON.parse(row.assets_json) as ChatAsset[] } : {}),
  ...(row.contents_json !== '[]' ? { contents: JSON.parse(row.contents_json) as unknown[] } : {}),
  ...(row.source_message_id ? { sourceMessageId: row.source_message_id } : {}),
  ...(row.plugin_id ? { pluginId: row.plugin_id } : {}),
  ...(row.tool_call_id?{toolCallId:row.tool_call_id}:{}),
  ...(row.logical_index!==null?{logicalMessageIndex:Number(row.logical_index)}:{}),
  ...(row.part_index!==null?{partIndex:Number(row.part_index)}:{}),
});

/** Uses the bridge connection so chat facts and business acknowledgements commit together. */
export class ChatStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS chat_messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,conversation_id TEXT NOT NULL,
      qq_message_id TEXT,revision INTEGER NOT NULL DEFAULT 1,sender_id TEXT NOT NULL,sender_name TEXT NOT NULL,
      role TEXT NOT NULL,origin TEXT NOT NULL,time REAL NOT NULL,text TEXT NOT NULL,reply_to TEXT,
      assets_json TEXT NOT NULL DEFAULT '[]',contents_json TEXT NOT NULL DEFAULT '[]',
      source_message_id TEXT,plugin_id TEXT,projection TEXT NOT NULL DEFAULT 'message',tool_call_id TEXT,logical_index INTEGER,part_index INTEGER
    ); CREATE INDEX IF NOT EXISTS chat_messages_qq ON chat_messages(qq_message_id);
    CREATE INDEX IF NOT EXISTS chat_messages_conversation ON chat_messages(conversation_id,seq);
    CREATE TABLE IF NOT EXISTS chat_context_batches (
      id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,submission_json TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'staged',
      session TEXT,entry_id TEXT,created_at INTEGER NOT NULL,staged_hash TEXT,committed_hash TEXT,receipt_json TEXT
    ); CREATE TABLE IF NOT EXISTS chat_context_versions (
      message_id TEXT NOT NULL,session TEXT NOT NULL,revision INTEGER NOT NULL,entry_id TEXT NOT NULL,
      PRIMARY KEY(message_id,session)
    ); CREATE TABLE IF NOT EXISTS chat_enrichments (
      message_id TEXT NOT NULL,plugin_id TEXT NOT NULL,revision INTEGER NOT NULL,contents_json TEXT NOT NULL,
      PRIMARY KEY(message_id,plugin_id)
    ); CREATE TABLE IF NOT EXISTS chat_resource_enrichments (
      message_id TEXT NOT NULL,plugin_id TEXT NOT NULL,resource_id TEXT NOT NULL,revision INTEGER NOT NULL,content_json TEXT NOT NULL,
      PRIMARY KEY(message_id,plugin_id,resource_id)
    ); CREATE TABLE IF NOT EXISTS chat_forwards (
      message_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,contents_json TEXT NOT NULL,deadline REAL NOT NULL,view_json TEXT
    );`);
    const columns=db.prepare('PRAGMA table_info(chat_context_batches)').all();
    for(const column of ['staged_hash','committed_hash','receipt_json'])if(!columns.some(item=>item.name===column))db.exec(`ALTER TABLE chat_context_batches ADD COLUMN ${column} TEXT`);
    if(!db.prepare('PRAGMA table_info(chat_forwards)').all().some(column=>column.name==='view_json'))db.exec('ALTER TABLE chat_forwards ADD COLUMN view_json TEXT');
  }

  get(id: string): ChatContextMessage | null {
    const row = this.db.prepare('SELECT * FROM chat_messages WHERE id=?').get(id) as Row | undefined;
    return row ? value(row) : null;
  }
  forQQ(id: string): ChatContextMessage | null {
    const row = this.db.prepare('SELECT * FROM chat_messages WHERE qq_message_id=? ORDER BY seq DESC LIMIT 1').get(id) as Row | undefined;
    return row ? value(row) : null;
  }
  put(message: Omit<ChatContextMessage, 'revision'>, projection: 'message' | 'reference' = 'message'): boolean {
    return !!this.db.prepare(`INSERT OR IGNORE INTO chat_messages(id,conversation_id,qq_message_id,sender_id,sender_name,role,origin,time,text,reply_to,assets_json,contents_json,source_message_id,plugin_id,projection,tool_call_id,logical_index,part_index)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(message.chatMessageId,message.conversationId,message.messageId,message.senderId,message.senderName,
      message.role,message.origin,message.time,message.text,message.replyTo,JSON.stringify(message.assets ?? []),JSON.stringify(message.contents ?? []),
      message.sourceMessageId ?? null,message.pluginId ?? null,projection,message.toolCallId??null,message.logicalMessageIndex??null,message.partIndex??null).changes;
  }
  incoming(message: StoredMessage, conversationId: string): void {
    this.put({chatMessageId:`in:${message.messageId}`,conversationId,messageId:message.messageId,senderId:message.senderId,
      senderName:message.senderName,time:message.time,text:incomingMessageText(message.rawJson) ?? message.text,
      replyTo:message.replyTo,role:'user',origin:'human'});
  }
  outgoing(id: string, text: string, conversationId: string, origin: 'model'|'scheduled'|'plugin', qqMessageId?: string,
    assets: ChatAsset[] = [], sourceMessageId?: string, pluginId?: string, time = Date.now()/1000,
    metadata?:{toolCallId?:string;logicalMessageIndex?:number;partIndex?:number;replyTo?:string|null}): void {
    this.put({chatMessageId:`out:${id}`,conversationId,messageId:qqMessageId ?? null,senderId:'self',senderName:'Assistant',
      time,text,replyTo:sourceMessageId ?? null,role:'assistant',origin,assets,sourceMessageId,pluginId,...metadata},origin === 'model' ? 'reference' : 'message');
  }
  pluginReply(reply: PluginChatReply): boolean {
    if (!this.forQQ(reply.sourceMessageId) || this.forQQ(reply.sourceMessageId)!.conversationId !== reply.conversationId) return false;
    const existed = this.get(`out:${reply.id}`);
    this.outgoing(reply.id,reply.text,reply.conversationId,'plugin',reply.qqMessageId,reply.assets,reply.sourceMessageId,reply.pluginId,reply.time ?? Date.now()/1000,
      {replyTo:reply.replyTo===undefined?reply.sourceMessageId:reply.replyTo});
    return !existed;
  }
  images(messageId: string, images: CachedIncomingImage[]): void {
    const row=this.get(`in:${messageId}`);if(!row)return;
    const assets:ChatAsset[]=images.map(image=>({id:image.attachmentId,type:'image',status:image.status,...(image.path?{path:image.path}:{}),...(image.error?{error:image.error}:{}),
      ...(image.origin==='plugin'?{origin:'plugin' as const,pluginId:image.pluginId,pluginAssetId:image.assetId}:{})}));
    const present=new Set(assets.map(asset=>asset.id));
    // Incoming QQ callbacks may arrive independently of plugin source-image preparation.
    for(const asset of row.assets??[])if(asset.origin==='plugin'&&!present.has(asset.id))assets.push(asset);
    if(JSON.stringify(row.assets ?? []) === JSON.stringify(assets))return;
    this.db.prepare('UPDATE chat_messages SET assets_json=?,revision=revision+1 WHERE id=?').run(JSON.stringify(assets),row.chatMessageId);
  }
  forwardSnapshot(messageId: string): ForwardSnapshot | null {
    const row=this.db.prepare('SELECT revision,contents_json,deadline FROM chat_forwards WHERE message_id=?').get(`in:${messageId}`);
    return row?{messageId,revision:Number(row.revision),contents:JSON.parse(String(row.contents_json)) as ForwardContent[],deadline:Number(row.deadline)}:null;
  }
  /** A protocol content update changes the existing chat fact, without running plugin policy. */
  forwards(snapshot: ForwardSnapshot): boolean {
    if(!isForwardSnapshot(snapshot))throw new Error('Invalid forwarded message content.');
    const row=this.get(`in:${snapshot.messageId}`);if(!row)return false;
    const previous=this.forwardSnapshot(snapshot.messageId);
    if(previous&&previous.revision>=snapshot.revision)return false;
    this.db.prepare('INSERT INTO chat_forwards(message_id,revision,contents_json,deadline) VALUES(?,?,?,?) ON CONFLICT(message_id) DO UPDATE SET revision=excluded.revision,contents_json=excluded.contents_json,deadline=excluded.deadline,view_json=NULL')
      .run(row.chatMessageId,snapshot.revision,JSON.stringify(snapshot.contents),snapshot.deadline);
    return this.writeForwardContents(row,snapshot.contents);
  }
  /** Preserve the upstream version so a later durable result can replace this local timeout view. */
  failPendingForwards(messageId: string): boolean {
    const snapshot=this.forwardSnapshot(messageId),row=this.get(`in:${messageId}`);if(!snapshot||!row)return false;
    const contents=structuredClone(snapshot.contents);let changed=false;
    const visit=(items:ForwardContent[])=>{for(const content of items){
      if(content.status==='pending'){content.status=content.nodes.length?'partial':'failed';content.error='转发内容读取超时，本轮未能取得剩余内容';changed=true;}
      for(const node of content.nodes)visit(node.segments.filter((segment):segment is ForwardContent=>segment.type==='forward'));
    }};
    visit(contents);if(!changed)return false;
    this.db.prepare('UPDATE chat_forwards SET view_json=? WHERE message_id=?').run(JSON.stringify(contents),row.chatMessageId);
    return this.writeForwardContents(row,contents);
  }
  private writeForwardContents(row: ChatContextMessage, forwards: ForwardContent[]): boolean {
    const plugins=this.db.prepare('SELECT contents_json FROM chat_enrichments WHERE message_id=? ORDER BY plugin_id').all(row.chatMessageId);
    const contents=[...forwards,...plugins.flatMap(item=>JSON.parse(String(item.contents_json)) as unknown[])];
    if(JSON.stringify(row.contents??[])===JSON.stringify(contents))return false;
    this.db.prepare('UPDATE chat_messages SET contents_json=?,revision=revision+1 WHERE id=?').run(JSON.stringify(contents),row.chatMessageId);
    return true;
  }
  private forwardView(messageId:string):ForwardContent[] {
    const row=this.db.prepare('SELECT COALESCE(view_json,contents_json) AS contents FROM chat_forwards WHERE message_id=?').get(`in:${messageId}`);
    return row?JSON.parse(String(row.contents)) as ForwardContent[]:[];
  }
  enrich(messageId: string, pluginId: string, contents: unknown[], revision = 1): boolean {
    const row=this.get(`in:${messageId}`);if(!row)return false;
    if(!pluginId || !Number.isSafeInteger(revision) || revision<1 || !Array.isArray(contents) || Buffer.byteLength(JSON.stringify(contents))>1024*1024)throw new Error('Invalid message enrichment.');
    const old=this.db.prepare('SELECT revision,contents_json FROM chat_enrichments WHERE message_id=? AND plugin_id=?').get(row.chatMessageId,pluginId);
    if(old && Number(old.revision)>=revision)return false;
    const encoded=JSON.stringify(contents);
    if(old?.contents_json===encoded){
      this.db.prepare('UPDATE chat_enrichments SET revision=? WHERE message_id=? AND plugin_id=?').run(revision,row.chatMessageId,pluginId);
      return false;
    }
    this.db.prepare('INSERT INTO chat_enrichments(message_id,plugin_id,revision,contents_json) VALUES(?,?,?,?) ON CONFLICT(message_id,plugin_id) DO UPDATE SET revision=excluded.revision,contents_json=excluded.contents_json')
      .run(row.chatMessageId,pluginId,revision,encoded);
    const all=this.db.prepare('SELECT contents_json FROM chat_enrichments WHERE message_id=? ORDER BY plugin_id').all(row.chatMessageId);
    const merged=[...this.forwardView(messageId),...all.flatMap(item=>JSON.parse(String(item.contents_json)) as unknown[])];
    let text=row.text;
    const platformLabel=new Map([['bilibili','哔哩哔哩'],['heybox','小黑盒'],['douyin','抖音']]).get(pluginId);
    if(platformLabel&&contents.some(item=>item&&typeof item==='object'&&(item as {platform?:unknown}).platform===pluginId)&&
      (text.startsWith('[JSON ')&&text.endsWith(']')||new RegExp(`^\\[${platformLabel}(?:视频|动态|直播|游戏)?分享\\]$`,'u').test(text))) {
      try {
        if(text.startsWith('[JSON '))JSON.parse(text.slice(6,-1));
        const kinds=new Set(contents.map(item=>(item as {type?:unknown})?.type));
        const kind=kinds.size===1?({video:'视频',post:'动态',live:'直播',game:'游戏'} as Record<string,string>)[String([...kinds][0])]??'':'';
        text=`[${platformLabel}${kind}分享]`;
      }catch{/* Mixed text and malformed cards retain their original presentation. */}
    }
    this.db.prepare('UPDATE chat_messages SET contents_json=?,text=?,revision=revision+1 WHERE id=?').run(JSON.stringify(merged),text,row.chatMessageId);
    return true;
  }
  mergeEnrichment(messageId:string,pluginId:string,content:unknown,resourceRevision:number):boolean {
    const message=this.get(`in:${messageId}`);if(!message)return false;
    if(!content||typeof content!=='object'||Array.isArray(content)||!Number.isSafeInteger(resourceRevision)||resourceRevision<1)throw new Error('Invalid resource enrichment.');
    const resourceId=(content as {resourceId?:unknown}).resourceId;
    if(typeof resourceId!=='string'||!resourceId||resourceId.length>400||!pluginId)throw new Error('Resource enrichment requires a stable resource identifier.');
    const encoded=JSON.stringify(content);if(Buffer.byteLength(encoded)>1024*1024)throw new Error('Resource enrichment exceeds its size limit.');
    const old=this.db.prepare('SELECT revision FROM chat_resource_enrichments WHERE message_id=? AND plugin_id=? AND resource_id=?').get(message.chatMessageId,pluginId,resourceId);
    if(old&&Number(old.revision)>=resourceRevision)return false;
    this.db.prepare(`INSERT INTO chat_resource_enrichments(message_id,plugin_id,resource_id,revision,content_json) VALUES(?,?,?,?,?)
      ON CONFLICT(message_id,plugin_id,resource_id) DO UPDATE SET revision=excluded.revision,content_json=excluded.content_json`)
      .run(message.chatMessageId,pluginId,resourceId,resourceRevision,encoded);
    const contents=this.db.prepare('SELECT content_json FROM chat_resource_enrichments WHERE message_id=? AND plugin_id=? ORDER BY resource_id').all(message.chatMessageId,pluginId).map(row=>JSON.parse(String(row.content_json)) as unknown);
    const previous=this.db.prepare('SELECT revision FROM chat_enrichments WHERE message_id=? AND plugin_id=?').get(message.chatMessageId,pluginId);
    return this.enrich(messageId,pluginId,contents,Number(previous?.revision??0)+1);
  }
  movePending(messageIds: string[], conversationId: string): void {
    for(const id of messageIds)this.db.prepare('UPDATE chat_messages SET conversation_id=? WHERE id=?').run(conversationId,`in:${id}`);
  }
  baseline(id: string, session: string): void {
    const message=this.get(id);if(!message)return;
    this.db.prepare('INSERT OR IGNORE INTO chat_context_versions(message_id,session,revision,entry_id) VALUES(?,?,?,?)').run(id,session,message.revision,'');
  }
  prepare(messages: StoredMessage[], conversationId: string, session: string | null, maximum = 100): ContextSubmission {
    const activeIds=new Set(messages.map(message=>`in:${message.messageId}`));
    const current=messages.map(message=>this.get(`in:${message.messageId}`)).filter((message):message is ChatContextMessage=>!!message);
    const rows=this.db.prepare(`SELECT c.*,v.revision AS supplied_revision,v.entry_id AS supplied_entry FROM chat_messages c
      LEFT JOIN chat_context_versions v ON v.message_id=c.id AND v.session=?
      WHERE c.conversation_id=? AND c.projection='message' AND (v.revision IS NULL OR v.revision<c.revision)
      AND (c.origin<>'human' OR c.qq_message_id IN (SELECT message_id FROM messages WHERE seq<=?))
      ORDER BY c.seq LIMIT ?`).all(session ?? '',conversationId,Math.max(0,...messages.map(message=>message.seq)),Math.max(maximum,activeIds.size)) as unknown as Array<Row & {supplied_revision?:number;supplied_entry?:string}>;
    const append:ChatContextMessage[]=[];const revisions:ContextSubmission['revisions']=[];let bytes=0;
    for(const row of rows) {
      if(activeIds.has(row.id))continue;
      const message=value(row),size=Buffer.byteLength(JSON.stringify(message));
      // Keep a pending fact for a later bounded page; never consume the omitted tail.
      if(bytes+size>256*1024 && append.length+revisions.length)break;
      bytes+=size;
      if(row.supplied_entry)revisions.push({message,entryId:row.supplied_entry});else append.push(message);
    }
    // Current targets remain at their own chronological location rather than an external side channel.
    const projected=[...append,...current].sort((a,b)=>(a.sequence??0)-(b.sequence??0));
    const references:ChatContextMessage[]=[];const referenced=new Set<string>();
    for(const message of [...current,...append])if(message.replyTo){const ref=this.forQQ(message.replyTo);if(ref && !activeIds.has(ref.chatMessageId) && !projected.some(item=>item.chatMessageId===ref.chatMessageId) && !referenced.has(ref.chatMessageId)){references.push(ref);referenced.add(ref.chatMessageId);}}
    const receipts=(this.db.prepare(`SELECT c.* FROM chat_messages c LEFT JOIN chat_context_versions v ON v.message_id=c.id AND v.session=?
      WHERE c.conversation_id=? AND c.origin='model' AND c.tool_call_id IS NOT NULL AND (v.revision IS NULL OR v.revision<c.revision) ORDER BY c.seq LIMIT 100`).all(session??'',conversationId) as unknown as Row[]).map(value);
    const versions=[...projected,...revisions.map(item=>item.message),...receipts].map(message=>({chatMessageId:message.chatMessageId,revision:message.revision}));
    const submission:ContextSubmission={batchId:randomUUID(),conversationId,messages:projected,revisions,references,receipts,versions};
    const encoded=JSON.stringify(submission);
    this.db.prepare('INSERT INTO chat_context_batches(id,conversation_id,submission_json,created_at,staged_hash) VALUES(?,?,?,?,?)')
      .run(submission.batchId,conversationId,encoded,Date.now(),createHash('sha256').update(encoded).digest('hex'));
    return submission;
  }
  pendingBatches(conversationId:string):string[] {
    return (this.db.prepare("SELECT id FROM chat_context_batches WHERE conversation_id=? AND state='staged' ORDER BY created_at,id").all(conversationId) as Array<{id:string}>).map(row=>row.id);
  }
  commit(receipt: ContextCommit): boolean {
    if(receipt.hash!==undefined&&!/^[a-f0-9]{64}$/u.test(receipt.hash))throw new Error('Invalid committed context hash.');
    const row=this.db.prepare('SELECT * FROM chat_context_batches WHERE id=?').get(receipt.batchId);
    if(!row || row.conversation_id !== receipt.conversationId)return false;
    const submission=JSON.parse(String(row.submission_json)) as ContextSubmission;
    const selected=new Map(submission.versions.map(version=>[version.chatMessageId,version.revision]));
    for(const version of receipt.versions) {
      if(selected.get(version.chatMessageId)!==version.revision)throw new Error('Context commit does not match its staged message versions.');
      const entry=receipt.entries?.find(item=>item.chatMessageId===version.chatMessageId&&item.revision===version.revision)?.entryId ?? receipt.entryId;
      this.db.prepare(`INSERT INTO chat_context_versions(message_id,session,revision,entry_id) VALUES(?,?,?,?)
        ON CONFLICT(message_id,session) DO UPDATE SET revision=MAX(revision,excluded.revision),entry_id=CASE WHEN excluded.revision>=revision THEN excluded.entry_id ELSE entry_id END`)
        .run(version.chatMessageId,receipt.session,version.revision,entry);
      if(version.chatMessageId.startsWith('out:'))this.db.prepare('UPDATE outgoing_history SET context_consumed=1 WHERE id=?').run(version.chatMessageId.slice(4));
    }
    this.db.prepare("UPDATE chat_context_batches SET state='committed',session=?,entry_id=?,committed_hash=?,receipt_json=? WHERE id=?")
      .run(receipt.session,receipt.entryId,receipt.hash??null,JSON.stringify(receipt),receipt.batchId);
    return true;
  }
}
