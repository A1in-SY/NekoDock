import { mkdirSync } from 'node:fs';
import { ConversationRecorder } from './conversation-recorder.js';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isMp3Snapshot } from './audio.js';
import { isSegmentMessage } from './messages.js';
import type { BridgeCommand, CommandResult, IncomingMessage, OutputMessage, PendingBatch, PendingCommand, ReplyPart, ReplyRequestRecord, StoredMessage, Target } from './types.js';

type StateRow = {
  target_type: string;
  target_id: string;
  session_id: string | null;
  cursor: number;
};

type MessageRow = {
  seq: number;
  message_id: string;
  sender_id: string;
  sender_name: string;
  time: number;
  text: string;
  reply_to: string | null;
  trigger: number;
  raw_json: string;
};

type BatchRow = {
  through_seq: number;
  reply_allowed: number;
  replies_json: string | null;
  next_reply_index: number;
  generation_done: number;
  model_started: number;
};

type ReplyRequestRow = {
  request_id: string;
  messages_json: string;
  start_index: number;
  end_index: number;
  send_started: number;
};

type CommandRow = {
  id: number;
  kind: BridgeCommand;
  through_seq: number;
  result: CommandResult | null;
  done: number;
};

export class BridgeStore {
  private readonly db: DatabaseSync;
  private closed = false;
  recorder!: ConversationRecorder;

  constructor(filePath: string, target: Target) {
    if (filePath !== ':memory:') mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    try {
      this.db.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
      `);
      this.transaction(() => {
        this.db.exec(`
        CREATE TABLE IF NOT EXISTS instance_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          target_type TEXT NOT NULL,
          target_id TEXT NOT NULL,
          session_id TEXT,
          cursor INTEGER NOT NULL DEFAULT 0 CHECK (cursor >= 0)
        );
        CREATE TABLE IF NOT EXISTS messages (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          message_id TEXT NOT NULL UNIQUE,
          sender_id TEXT NOT NULL,
          sender_name TEXT NOT NULL,
          time INTEGER NOT NULL,
          text TEXT NOT NULL,
          reply_to TEXT,
          trigger INTEGER NOT NULL CHECK (trigger IN (0, 1)),
          raw_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS pending_batch (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          through_seq INTEGER NOT NULL,
          reply_allowed INTEGER NOT NULL CHECK (reply_allowed IN (0, 1)),
          replies_json TEXT,
          next_reply_index INTEGER NOT NULL DEFAULT 0 CHECK (next_reply_index >= 0),
          generation_done INTEGER NOT NULL DEFAULT 0 CHECK (generation_done IN (0, 1))
        );
        `);
        const existing = this.db.prepare('SELECT * FROM instance_state WHERE id = 1').get() as StateRow | undefined;
        if (existing) {
          if (existing.target_type !== target.type || existing.target_id !== target.id) {
            throw new Error('Persisted state belongs to a different target; use a separate data directory.');
          }
        } else {
          this.db.prepare('INSERT INTO instance_state (id, target_type, target_id) VALUES (1, ?, ?)')
            .run(target.type, target.id);
        }
        this.initializeCommandSchema();
        this.initializeReplySchema();
        this.recorder = new ConversationRecorder(this.db,filePath===':memory:'?undefined:join(dirname(filePath),'console-media'));
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  insert(message: IncomingMessage): boolean {
    return this.transaction(() => {
      const existing = this.db.prepare(`
        SELECT 1 FROM messages WHERE message_id = ?
        UNION ALL SELECT 1 FROM control_commands WHERE message_id = ? LIMIT 1
      `).get(message.messageId, message.messageId);
      if (existing) return false;
      if (message.command) {
        this.db.prepare(`
          INSERT INTO control_commands (message_id, kind, through_seq)
          SELECT ?, ?, COALESCE(MAX(seq), 0) FROM messages
        `).run(message.messageId, message.command);
      } else {
        this.db.prepare(`
          INSERT INTO messages (message_id, sender_id, sender_name, time, text, reply_to, trigger, raw_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(message.messageId, message.senderId, message.senderName, message.time,
          message.text, message.replyTo, message.trigger ? 1 : 0, message.rawJson);
        this.recorder.append('message.received', {
          messageId:message.messageId,senderId:message.senderId,senderName:message.senderName,text:message.text,
          time:message.time*1000,replyTo:message.replyTo,trigger:message.trigger,legacy:false,
          messageSeq:Number(this.db.prepare('SELECT seq FROM messages WHERE message_id=?').get(message.messageId)!.seq),
        },`incoming:${message.messageId}`,{time:message.time*1000,itemId:message.messageId});
      }
      return true;
    });
  }

  getPendingCommand(): PendingCommand | null {
    const row = this.db.prepare('SELECT * FROM control_commands WHERE done = 0 ORDER BY id LIMIT 1')
      .get() as CommandRow | undefined;
    return row ? { id: row.id, kind: row.kind, throughSeq: row.through_seq, result: row.result } : null;
  }

  resetSessionForCommand(id: number): void {
    this.transaction(() => {
      const command = this.requireCommand(id);
      if (command.kind !== 'new') throw new Error('Only a new command can reset the session.');
      if (command.result === 'new') return;
      if (command.result !== null) throw new Error('Command result has already been saved.');
      this.db.prepare('UPDATE instance_state SET session_id = NULL, cursor = MAX(cursor, ?) WHERE id = 1')
        .run(command.through_seq);
      this.db.prepare('DELETE FROM pending_batch WHERE id = 1').run();
      this.db.prepare('DELETE FROM reply_requests').run();
      this.db.prepare('DELETE FROM reply_part_sources').run();
      this.db.prepare('DELETE FROM reply_attempts').run();
      this.recorder.reset(command.through_seq,id);
      this.db.prepare("UPDATE control_commands SET result = 'new' WHERE id = ?").run(id);
    });
  }

  saveCommandResult(id: number, result: Exclude<CommandResult, 'new'>): void {
    this.transaction(() => {
      const command = this.requireCommand(id);
      const matches = command.kind === 'help' ? result === 'help'
        : command.kind === 'compact' && (result === 'compacted' || result === 'empty' || result === 'failed');
      if (!matches) {
        throw new Error('Command result does not match command kind.');
      }
      if (command.result !== null) {
        if (command.result !== result) throw new Error('Command result has already been saved.');
        return;
      }
      this.db.prepare('UPDATE control_commands SET result = ? WHERE id = ?').run(result, id);
    });
  }

  acknowledgeCommand(id: number): void {
    const command = this.db.prepare('SELECT * FROM control_commands WHERE id = ?').get(id) as CommandRow | undefined;
    if (!command) throw new Error('Control command does not exist.');
    if (command.result === null) throw new Error('Command result has not been saved.');
    this.db.prepare('UPDATE control_commands SET done = 1 WHERE id = ?').run(id);
  }

  getSessionId(): string | null {
    return this.readState().session_id;
  }

  /** Activate Pi once, without replaying the old runtime's messages or sends. */
  initializeAgentRuntime(): void {
    this.transaction(() => {
      this.db.exec(`CREATE TABLE IF NOT EXISTS agent_runtime (
        id INTEGER PRIMARY KEY CHECK(id=1), engine TEXT NOT NULL, activated_at INTEGER NOT NULL,
        cutoff INTEGER NOT NULL CHECK(cutoff>=0)
      )`);
      const current = this.db.prepare('SELECT engine FROM agent_runtime WHERE id=1').get();
      if (current?.engine === 'pi') return;
      const cutoff = Number(this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM messages').get()!.seq);
      const oldSession = this.getSessionId();
      this.db.prepare('UPDATE instance_state SET session_id=NULL,cursor=MAX(cursor,?) WHERE id=1').run(cutoff);
      for (const table of ['pending_batch', 'reply_requests', 'reply_part_sources', 'reply_attempts']) this.db.exec(`DELETE FROM ${table}`);
      this.db.exec(`UPDATE control_commands SET done=1,result=COALESCE(result,
        CASE kind WHEN 'new' THEN 'new' WHEN 'help' THEN 'help' ELSE 'empty' END) WHERE done=0`);
      if (cutoff > 0 || oldSession !== null) this.recorder.reset(cutoff, 'runtime:pi');
      this.db.prepare('INSERT OR REPLACE INTO agent_runtime(id,engine,activated_at,cutoff) VALUES(1,?,?,?)').run('pi',Date.now(),cutoff);
      this.recorder.append('runtime.activated',{engine:'pi',cutoff},'runtime:pi:activated');
    });
  }

  setSessionId(id: string): void {
    if (!id.trim()) throw new Error('Agent session ID must not be empty.');
    this.transaction(() => {
      this.db.prepare('UPDATE instance_state SET session_id = ? WHERE id = 1').run(id);
      this.recorder.append('session.established',{sessionId:id},`session:${this.recorder.conversationId}:${id}`);
    });
  }

  getCursor(): number {
    return this.readState().cursor;
  }

  isBusy(): boolean {
    // Include queued work before the processing loop opens its first batch.
    const row = this.db.prepare(`
      SELECT EXISTS (SELECT 1 FROM pending_batch)
        OR EXISTS (SELECT 1 FROM control_commands WHERE done = 0)
        OR EXISTS (SELECT 1 FROM messages
          WHERE seq > (SELECT cursor FROM instance_state WHERE id = 1) AND trigger = 1) AS busy
    `).get();
    return row?.busy === 1;
  }

  peekPendingBatch(): PendingBatch | null { return this.readBatch(); }

  openOrCreateBatch(limit: number): PendingBatch | null {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Batch limit must be a positive integer.');
    return this.transaction(() => {
      const pending = this.readBatch();
      if (pending) return pending;

      const cursor = this.getCursor();
      const triggered = this.db.prepare('SELECT 1 FROM messages WHERE seq > ? AND trigger = 1 LIMIT 1').get(cursor);
      if (!triggered) return null;

      const rows = this.db.prepare('SELECT * FROM messages WHERE seq > ? ORDER BY seq LIMIT ?')
        .all(cursor, limit) as MessageRow[];
      const last = rows.at(-1);
      if (!last) throw new Error('Triggered message batch is unexpectedly empty.');
      this.db.prepare(`
        INSERT INTO pending_batch (id, through_seq, reply_allowed) VALUES (1, ?, ?)
      `).run(last.seq, rows.some((row) => row.trigger === 1) ? 1 : 0);
      return this.readBatch();
    });
  }

  saveReplies(throughSeq: number, parts: ReplyPart[], messageIndices?:number[],logicalMessages?:OutputMessage[]): void {
    if (!Array.isArray(parts) || parts.some((part) => !isInitialReplyPart(part))) {
      throw new Error('Reply parts must contain text or images or segment messages or unprepared voice.');
    }
    this.transaction(() => {
      const pending = this.requireBatch(throughSeq);
      if (!pending.replyAllowed && parts.length > 0) throw new Error('This batch does not allow a reply.');
      const encoded = JSON.stringify(parts);
      if (pending.replies !== null) {
        if (JSON.stringify(pending.replies) !== encoded) throw new Error('Replies have already been saved for this batch.');
        this.db.prepare('UPDATE pending_batch SET generation_done = 1 WHERE id = 1').run();
        return;
      }
      this.db.prepare('UPDATE pending_batch SET replies_json = ?, generation_done = 1 WHERE id = 1').run(encoded);
      this.saveReplySources(throughSeq,0,parts.length,messageIndices);
      if(parts.length) this.recorder.append('reply.accepted',{requestId:`final:${throughSeq}`,messages:logicalMessages??parts.map(part=>typeof part==='string'?{type:'text',text:part}:part.type==='voice'?{type:'text',text:part.text}:part)},`reply:${throughSeq}:final`,{itemId:`final:${throughSeq}`});
    });
  }

  getBatch(throughSeq: number): PendingBatch {
    return this.requireBatch(throughSeq);
  }

  markGenerationStarted(throughSeq: number): void {
    this.transaction(() => {
      const pending = this.requireBatch(throughSeq);
      if (pending.modelStarted || pending.replies !== null) throw new Error('Batch model execution has already started.');
      this.db.prepare('UPDATE pending_batch SET model_started = 1 WHERE id = 1').run();
    });
  }

  /** A started execution is never replayed after a crash or generation failure. */
  abandonBatch(throughSeq: number, reason: 'interrupted' | 'failed' | 'cancelled', runId?: string): void {
    this.transaction(() => {
      const pending = this.requireBatch(throughSeq);
      for (let index = pending.nextReplyIndex; index < (pending.replies?.length ?? 0); index++) {
        const attempted = this.db.prepare('SELECT status FROM reply_attempts WHERE through_seq=? AND part_index=?').get(throughSeq, index);
        this.recorder.append('delivery.failed', {
          deliveryId: `${throughSeq}:${index}`, partIndex: index, status: attempted ? 'unconfirmed' : 'skipped', reason,
        }, `delivery-result:${throughSeq}:${index}`);
      }
      this.recorder.append('batch.abandoned', { throughSeq, reason }, `batch:${throughSeq}:abandoned`, runId ? { runId } : {});
      this.clearBatch(throughSeq);
    });
  }

  beginReplyAttempt(throughSeq: number, index: number): void {
    this.transaction(() => {
      const pending = this.requireBatch(throughSeq);
      if (!pending.replies || index !== pending.nextReplyIndex || index >= pending.replies.length) throw new Error('Pending reply index is invalid.');
      this.db.prepare('INSERT INTO reply_attempts(through_seq,part_index,status) VALUES(?,?,?)').run(throughSeq, index, 'started');
      this.db.prepare(`UPDATE reply_requests SET send_started = 1
        WHERE through_seq = ? AND start_index <= ? AND end_index > ?`).run(throughSeq, index, index);
      this.recorder.append('delivery.attempted', { deliveryId: `${throughSeq}:${index}`, partIndex: index }, `delivery-attempt:${throughSeq}:${index}`);
    });
  }

  failReply(throughSeq: number, index: number, status: 'failed' | 'unconfirmed', stage: string, errorCode: string, retcode?: number): void {
    this.transaction(() => {
      const pending = this.requireBatch(throughSeq);
      if (index !== pending.nextReplyIndex || !pending.replies || index >= pending.replies.length) throw new Error('Pending reply index is invalid.');
      this.db.prepare('UPDATE reply_attempts SET status=? WHERE through_seq=? AND part_index=?').run(status, throughSeq, index);
      this.db.prepare('UPDATE pending_batch SET next_reply_index=? WHERE id=1').run(index + 1);
      this.recorder.append('delivery.failed', { deliveryId: `${throughSeq}:${index}`, partIndex: index, status, stage, errorCode, ...(retcode !== undefined ? { retcode } : {}) }, `delivery-result:${throughSeq}:${index}`);
    });
  }

  getReplyRequest(throughSeq: number, requestId: string): ReplyRequestRecord | null {
    const row = this.db.prepare(`
      SELECT request_id, messages_json, start_index, end_index, send_started FROM reply_requests
      WHERE through_seq = ? AND request_id = ?
    `).get(throughSeq, requestId) as ReplyRequestRow | undefined;
    return row ? toReplyRequest(row) : null;
  }

  listReplyRequests(throughSeq: number): ReplyRequestRecord[] {
    const rows = this.db.prepare(`
      SELECT request_id, messages_json, start_index, end_index, send_started FROM reply_requests
      WHERE through_seq = ? ORDER BY start_index, rowid
    `).all(throughSeq) as ReplyRequestRow[];
    return rows.map(toReplyRequest);
  }

  appendReplyRequest(throughSeq: number, requestId: string, messages: OutputMessage[], parts: ReplyPart[], messageIndices?:number[]): ReplyRequestRecord {
    if (typeof requestId !== 'string' || !requestId.trim()) throw new Error('Reply request ID must not be empty.');
    if (!Array.isArray(messages) || messages.length === 0 || messages.some(message => !isOutputMessage(message))) {
      throw new Error('Reply request messages must contain text or images or segment messages.');
    }
    return this.transaction(() => {
      const pending = this.requireBatch(throughSeq);
      const existing = this.getReplyRequest(throughSeq, requestId);
      const encoded = JSON.stringify(messages);
      if (existing) {
        if (JSON.stringify(existing.messages) !== encoded) throw new Error('Reply request ID has already been used with different messages.');
        return existing;
      }
      if (!pending.replyAllowed) throw new Error('This batch does not allow a reply.');
      if (pending.generationDone) throw new Error('Generation has already finished for this batch.');
      if (!Array.isArray(parts) || parts.length === 0 || parts.some(part => !isInitialReplyPart(part))) {
        throw new Error('Reply parts must contain text or images or segment messages or unprepared voice.');
      }
      const replies = pending.replies ?? [];
      const startIndex = replies.length;
      const endIndex = startIndex + parts.length;
      this.db.prepare('UPDATE pending_batch SET replies_json = ? WHERE id = 1').run(JSON.stringify([...replies, ...parts]));
      this.db.prepare(`
        INSERT INTO reply_requests (through_seq, request_id, messages_json, start_index, end_index)
        VALUES (?, ?, ?, ?, ?)
      `).run(throughSeq, requestId, encoded, startIndex, endIndex);
      this.saveReplySources(throughSeq,startIndex,parts.length,messageIndices);
      this.recorder.append('reply.accepted',{requestId,messages},`reply:${throughSeq}:${requestId}`,{itemId:requestId});
      return { requestId, messages: JSON.parse(encoded) as OutputMessage[], startIndex, endIndex, sendStarted: false };
    });
  }

  markReplySending(throughSeq: number, index: number): void {
    this.transaction(() => {
      const pending = this.requireBatch(throughSeq);
      if (!Number.isSafeInteger(index) || index < pending.nextReplyIndex || !pending.replies || index >= pending.replies.length) {
        throw new Error('Pending reply index is invalid.');
      }
      this.db.prepare(`UPDATE reply_requests SET send_started = 1
        WHERE through_seq = ? AND start_index <= ? AND end_index > ?`).run(throughSeq, index, index);
    });
  }

  finishGeneration(throughSeq: number): void {
    this.transaction(() => {
      this.requireBatch(throughSeq);
      this.db.prepare("UPDATE pending_batch SET replies_json = COALESCE(replies_json, '[]'), generation_done = 1 WHERE id = 1").run();
    });
  }

  saveImage(throughSeq: number, index: number, file: string): void {
    if (!file.startsWith('base64://')) throw new Error('Prepared image must contain a base64 snapshot.');
    this.transaction(() => {
      const pending = this.requireBatch(throughSeq);
      const part = pending.replies?.[index];
      if (!Number.isSafeInteger(index) || index < pending.nextReplyIndex || !part || typeof part === 'string' || part.type !== 'image') {
        throw new Error('Pending image index is invalid.');
      }
      if (part.file.startsWith('base64://') && part.file !== file) throw new Error('Image snapshot has already been saved.');
      part.file = file;
      this.db.prepare('UPDATE pending_batch SET replies_json = ? WHERE id = 1').run(JSON.stringify(pending.replies));
    });
  }

  saveVoice(throughSeq: number, index: number, file: string): void {
    if (!isMp3Snapshot(file)) throw new Error('Prepared voice must contain a valid MP3 base64 snapshot.');
    this.transaction(() => {
      const pending = this.requireBatch(throughSeq);
      const part = pending.replies?.[index];
      if (!Number.isSafeInteger(index) || index < pending.nextReplyIndex || !part || typeof part === 'string' || part.type !== 'voice') {
        throw new Error('Pending voice index is invalid.');
      }
      if (part.file !== undefined && part.file !== file) throw new Error('Voice snapshot has already been saved.');
      part.file = file;
      this.db.prepare('UPDATE pending_batch SET replies_json = ? WHERE id = 1').run(JSON.stringify(pending.replies));
    });
  }

  fallbackVoice(throughSeq: number, index: number): void {
    this.transaction(() => {
      const pending = this.requireBatch(throughSeq);
      const part = pending.replies?.[index];
      if (!Number.isSafeInteger(index) || index < pending.nextReplyIndex || !part || typeof part === 'string' || part.type !== 'voice') {
        throw new Error('Pending voice index is invalid.');
      }
      if (part.file !== undefined) throw new Error('Prepared voice cannot fall back to text.');
      pending.replies![index] = part.text;
      this.db.prepare('UPDATE pending_batch SET replies_json = ? WHERE id = 1').run(JSON.stringify(pending.replies));
    });
  }

  acknowledgeReply(throughSeq: number, index: number, messageId?: string): { mediaSaved: boolean } {
    let mediaSaved = true;
    this.transaction(() => {
      const pending = this.requireBatch(throughSeq);
      if (pending.replies === null) throw new Error('Replies have not been saved for this batch.');
      if (!Number.isSafeInteger(index) || index < 0 || index >= pending.replies.length) {
        throw new Error('Reply index is out of range.');
      }
      if (index < pending.nextReplyIndex) return;
      if (index !== pending.nextReplyIndex) throw new Error('Reply acknowledgements must be in order.');
      this.db.prepare('UPDATE pending_batch SET next_reply_index = ? WHERE id = 1').run(index + 1);
      this.db.prepare("UPDATE reply_attempts SET status='acknowledged' WHERE through_seq=? AND part_index=?").run(throughSeq,index);
      const part=pending.replies[index]!;
      const request=this.listReplyRequests(throughSeq).find(request=>request.startIndex<=index&&request.endIndex>index);
      const source=this.db.prepare('SELECT message_index FROM reply_part_sources WHERE through_seq=? AND part_index=?').get(throughSeq,index);
      let mediaPath: string | undefined;
      if (typeof part !== 'string' && (part.type === 'image' || part.type === 'voice') && part.file) {
        try { mediaPath = this.recorder.mediaSnapshot(part.file, part.type); }
        catch { mediaSaved = false; }
      }
      this.recorder.append('delivery.acknowledged',{deliveryId:`${throughSeq}:${index}`,requestId:request?.requestId ?? `final:${throughSeq}`,
        partIndex:index,...(source?{logicalMessageIndex:Number(source.message_index)}:{}),kind:typeof part==='string'?'text':part.type,normal:true,...(messageId?{messageId}:{}),...(mediaPath?{mediaPath}:{})},`ack:${throughSeq}:${index}`);
    });
    return { mediaSaved };
  }

  completeBatch(throughSeq: number, run?:{runId:string;durationMs:number;replyAllowed:boolean}): void {
    this.transaction(() => {
      const pending = this.requireBatch(throughSeq);
      if (pending.replies === null || pending.nextReplyIndex !== pending.replies.length) {
        throw new Error('Cannot complete a batch before all replies have finished.');
      }
      if (!pending.generationDone) throw new Error('Cannot complete a batch before generation has finished.');
      if(run){
        this.recorder.append('run.completed',{throughSeq,durationMs:run.durationMs,replyAllowed:run.replyAllowed},`run:${run.runId}:end`,{runId:run.runId});
        if(run.replyAllowed)this.recorder.append('batch.completed',{throughSeq,durationMs:run.durationMs},`batch:${throughSeq}:complete`,{runId:run.runId});
      }
      this.clearBatch(throughSeq);
    });
  }

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }

  private readState(): StateRow {
    const state = this.db.prepare('SELECT * FROM instance_state WHERE id = 1').get() as StateRow | undefined;
    if (!state) throw new Error('Instance state is missing.');
    return state;
  }

  private readBatch(): PendingBatch | null {
    const row = this.db.prepare('SELECT * FROM pending_batch WHERE id = 1').get() as BatchRow | undefined;
    if (!row) return null;
    const rows = this.db.prepare('SELECT * FROM messages WHERE seq > ? AND seq <= ? ORDER BY seq')
      .all(this.getCursor(), row.through_seq) as MessageRow[];
    return {
      throughSeq: row.through_seq,
      messages: rows.map(toStoredMessage),
      replyAllowed: row.reply_allowed === 1,
      replies: row.replies_json === null ? null : JSON.parse(row.replies_json) as ReplyPart[],
      nextReplyIndex: row.next_reply_index,
      generationDone: row.generation_done === 1,
      modelStarted: row.model_started === 1,
    };
  }

  private requireBatch(throughSeq: number): PendingBatch {
    const pending = this.readBatch();
    if (!pending || pending.throughSeq !== throughSeq) throw new Error('Pending batch does not match throughSeq.');
    return pending;
  }

  private requireCommand(id: number): CommandRow {
    const command = this.db.prepare('SELECT * FROM control_commands WHERE id = ? AND done = 0')
      .get(id) as CommandRow | undefined;
    if (!command) throw new Error('Pending control command does not exist.');
    return command;
  }

  private saveReplySources(throughSeq:number,start:number,count:number,indices?:number[]):void {
    if(indices && (indices.length!==count||indices.some(index=>!Number.isSafeInteger(index)||index<0)))throw new Error('Invalid logical reply mapping.');
    if(indices) for(const [offset,index] of indices.entries()) this.db.prepare('INSERT OR IGNORE INTO reply_part_sources(through_seq,part_index,message_index)VALUES(?,?,?)').run(throughSeq,start+offset,index);
  }

  private clearBatch(throughSeq: number): void {
    this.db.prepare('UPDATE instance_state SET cursor = ? WHERE id = 1').run(throughSeq);
    this.db.prepare('DELETE FROM pending_batch WHERE id = 1').run();
    this.db.prepare('DELETE FROM reply_requests WHERE through_seq = ?').run(throughSeq);
    this.db.prepare('DELETE FROM reply_part_sources WHERE through_seq=?').run(throughSeq);
    this.db.prepare('DELETE FROM reply_attempts WHERE through_seq=?').run(throughSeq);
  }

  private initializeReplySchema(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS reply_part_sources(through_seq INTEGER NOT NULL,part_index INTEGER NOT NULL,message_index INTEGER NOT NULL,PRIMARY KEY(through_seq,part_index))');
    const columns = this.db.prepare('PRAGMA table_info(pending_batch)').all();
    if (!columns.some(column => column.name === 'model_started')) {
      // Only batches present at migration may already have reached an older CLI.
      // New batches remain unstarted until markGenerationStarted commits.
      this.db.exec(`ALTER TABLE pending_batch ADD COLUMN model_started INTEGER NOT NULL DEFAULT 0 CHECK (model_started IN (0,1));
        UPDATE pending_batch SET model_started = 1;`);
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS reply_attempts(
      through_seq INTEGER NOT NULL,part_index INTEGER NOT NULL,status TEXT NOT NULL,
      PRIMARY KEY(through_seq,part_index))`);
    if (!columns.some(column => column.name === 'generation_done')) {
      this.db.exec(`
        ALTER TABLE pending_batch ADD COLUMN generation_done INTEGER NOT NULL DEFAULT 0 CHECK (generation_done IN (0, 1));
        UPDATE pending_batch SET generation_done = 1 WHERE replies_json IS NOT NULL;
      `);
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS reply_requests (
      through_seq INTEGER NOT NULL,
      request_id TEXT NOT NULL,
      messages_json TEXT NOT NULL,
      start_index INTEGER NOT NULL CHECK (start_index >= 0),
      end_index INTEGER NOT NULL CHECK (end_index > start_index),
      send_started INTEGER NOT NULL DEFAULT 0 CHECK (send_started IN (0, 1)),
      PRIMARY KEY (through_seq, request_id)
    )`);
  }

  private initializeCommandSchema(): void {
    const version = this.db.prepare('PRAGMA user_version').get()?.user_version;
    if (version !== 0 && version !== 1) throw new Error('Unsupported database schema version.');
    const existing = this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'control_commands'").get();
    if (!existing) {
      this.createCommandTable('control_commands');
    } else if (version === 0) {
      const sequence = this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'control_commands'").get()?.seq;
      this.createCommandTable('control_commands_v1');
      this.db.exec(`
        INSERT INTO control_commands_v1 (id, message_id, kind, through_seq, result, done)
          SELECT id, message_id, kind, through_seq, result, done FROM control_commands ORDER BY id;
        DROP TABLE control_commands;
        ALTER TABLE control_commands_v1 RENAME TO control_commands;
      `);
      if (typeof sequence === 'number') {
        this.db.prepare(`INSERT INTO sqlite_sequence (name, seq)
          SELECT 'control_commands', ? WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'control_commands')`)
          .run(sequence);
        this.db.prepare("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'control_commands'").run(sequence);
      }
    }
    this.db.exec('PRAGMA user_version = 1');
  }

  private createCommandTable(name: 'control_commands' | 'control_commands_v1'): void {
    this.db.exec(`CREATE TABLE ${name} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK (kind IN ('new', 'compact', 'help')),
      through_seq INTEGER NOT NULL CHECK (through_seq >= 0),
      result TEXT CHECK (result IN ('new', 'compacted', 'empty', 'failed', 'help')),
      done INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1))
    )`);
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = operation();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

function toReplyRequest(row: ReplyRequestRow): ReplyRequestRecord {
  return {
    requestId: row.request_id,
    messages: JSON.parse(row.messages_json) as OutputMessage[],
    startIndex: row.start_index,
    endIndex: row.end_index,
    sendStarted: row.send_started === 1,
  };
}

function isOutputMessage(message: unknown): message is OutputMessage {
  if (isSegmentMessage(message)) return true;
  if (!message || typeof message !== 'object' || Array.isArray(message) || Object.keys(message).length !== 2) return false;
  const value = message as Record<string, unknown>;
  if (value.type === 'text') return typeof value.text === 'string' && value.text.trim().length > 0;
  return value.type === 'image' && typeof value.path === 'string' && value.path.trim().length > 0;
}

function isInitialReplyPart(part: unknown): part is ReplyPart {
  if (typeof part === 'string' || isSegmentMessage(part)) return true;
  if (!part || typeof part !== 'object' || Array.isArray(part) || Object.keys(part).length !== 2) return false;
  const item = part as Record<string, unknown>;
  if (!Object.hasOwn(item, 'type')) return false;
  if (item.type === 'voice') return Object.hasOwn(item, 'text') && typeof item.text === 'string' && item.text.trim().length > 0;
  return item.type === 'image' && typeof item.file === 'string' && item.file.trim().length > 0
    && !item.file.startsWith('base64://');
}

function toStoredMessage(row: MessageRow): StoredMessage {
  return {
    seq: row.seq,
    messageId: row.message_id,
    senderId: row.sender_id,
    senderName: row.sender_name,
    time: row.time,
    text: row.text,
    replyTo: row.reply_to,
    trigger: row.trigger === 1,
    rawJson: row.raw_json,
  };
}
