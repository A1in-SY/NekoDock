import { prepareReplyParts, transmitReply } from './reply-delivery.js';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { BridgeStore } from './store.js';
import { prepareImageReply } from './images.js';
import { fingerprint, logEvent } from './logging.js';
import { isMp3Snapshot } from './audio.js';
import type { SpeechProvider } from './tts.js';
import type { Scheduler } from './scheduler.js';
import type { TaskTools } from './scheduled-contract.js';
import type { AgentRunner, CommandResult, Logger, MessageSegment, MessageSender, OutputMessage, PendingCommand, RecallToolReceipt, ReplyPart, ReplyTools, SegmentMessage } from './types.js';
import type { ContextCommit } from './chat-context-contract.js';
import { saveChatAsset } from './chat-assets.js';
import { modelErrorReply } from './model-error-reply.js';
import { ReplyToolError } from './reply-contract.js';

const commandReplies: Record<CommandResult, string> = {
  help: [
    '可用指令：',
    '/help — 查看指令及功能。',
    '/new — 重置会话，跳过此前待处理消息；下条普通消息开启新对话，保留聊天记录和工作目录文件。',
    '/compact — 压缩当前上下文，保留会话。',
    '',
    '群聊和私聊均可用；群聊无需 @。忙碌时会在当前轮完成后执行并回复结果。',
  ].join('\n'),
  new: '已重置会话，下条消息将开启新对话。',
  compacted: '上下文已压缩。',
  empty: '当前没有可压缩的会话。',
  failed: '上下文压缩失败，请稍后重试 /compact。',
};

export { splitReply, splitMessage } from './reply-delivery.js';

export { modelErrorReply } from './model-error-reply.js';

export class Processor {
  private wake: (() => void) | undefined;
  private notified = true;
  private draining=false;
  private active=false;
  private activeCommand:number|null=null;
  private drainCommand:number|null=null;
  private contextRecovery=true;
  private activeReply: {messageRef:string;done:Promise<void>} | undefined;
  requestDrain():void { if(this.draining)return; this.draining=true; this.options.store.invalidateReplyDecisions('draining'); this.drainCommand=this.activeCommand; this.options.scheduler?.requestDrain();this.options.backgroundActions?.requestDrain?.();this.notify(); }
  get isProcessing():boolean { return this.active || this.options.store.peekPendingBatch()!==null; }
  get isDrained():boolean { return this.draining && !this.active && this.options.store.peekPendingBatch()===null && this.drainCommand===null && (!this.options.scheduler||this.options.scheduler.isDrained); }

  constructor(private readonly options: {
    store: BridgeStore; agent: AgentRunner; sender: MessageSender; logger: Logger;
    batchSize: number; replyMaxChars: number; retryMs: number;
    workspace: string; imageMaxBytes: number; imageTimeoutMs: number; imageFetch?:typeof globalThis.fetch;
    speech?: SpeechProvider | null; voiceReplyEnabled?: boolean;
    voiceReplyProbability?: number; ttsMaxChars?: number; random?: () => number;
    scheduler?:Scheduler; taskTools?:TaskTools;
    helpText?:()=>string;
    backgroundActions?:{readonly hasPending:boolean;runNext(signal:AbortSignal):Promise<boolean>;requestDrain?():void};
    beforeContext?:(batch:import('./types.js').PendingBatch,signal:AbortSignal)=>Promise<void>;
  }) {}

  notify(): void { this.notified = true; this.wake?.(); }

  async run(signal: AbortSignal): Promise<void> {
    const { store, agent, logger, batchSize, retryMs } = this.options;
    const abort = () => this.wake?.();
    signal.addEventListener('abort', abort, { once: true });
    try {
      while (!signal.aborted) {
        this.notified = false;
        const command = store.getPendingCommand();
        if(this.draining && !store.peekPendingBatch() && (this.drainCommand===null || command?.id!==this.drainCommand)) {
          await new Promise<void>(resolve=>{this.wake=resolve;if(this.notified||signal.aborted)resolve();});
          this.wake=undefined;continue;
        }
        if (command && (!this.draining || this.drainCommand===command.id)) {
          this.active=true;this.activeCommand=command.id;
          try {
            await this.processCommand(command, signal);
            this.drainCommand=null;
          } catch {
            if (signal.aborted) break;
            try { await delay(retryMs, undefined, { signal }); } catch { break; }
          } finally {this.active=false;this.activeCommand=null;}
          continue;
        }
        if(!this.draining&&this.options.backgroundActions?.hasPending&&!store.isBusy()) {
          this.active=true;store.setScheduledBusy(true);let executed=false;
          try {executed=await this.options.backgroundActions.runNext(signal);} finally {store.setScheduledBusy(false);this.active=false;}
          if(executed)continue;
        }
        if(!this.draining&&this.options.scheduler?.hasPending&&!store.isBusy()) {
          this.active=true;store.setScheduledBusy(true);let executed=false;
          try {executed=await this.options.scheduler.runNext(signal);} finally {store.setScheduledBusy(false);this.active=false;}
          if(executed)continue;
        }
        const batch = this.draining?store.peekPendingBatch():store.openOrCreateBatch(batchSize);
        if (!batch) {
          await new Promise<void>((resolve) => {
            this.wake = resolve;
            if (this.notified || signal.aborted) resolve();
          });
          this.wake = undefined;
          continue;
        }
        this.active = true;
        const started = Date.now();
        const runId = randomUUID();
        let stage = 'agent';
        let replyIndex: number | undefined;
        let deliveries: ReturnType<Processor['replyTools']> | undefined;
        try {
          if(this.contextRecovery&&agent.recoverContext) {
            const session=store.getSessionId(),pendingIds=store.pendingContextBatchIds();
            await agent.recoverContext(session,receipt=>{
              const known=pendingIds.includes(receipt.batchId);
              if(store.commitContext(receipt)&&session===null&&known&&receipt.conversationId===store.recorder.conversationId)store.setSessionId(receipt.session);
            },pendingIds);
          }
          this.contextRecovery=false;
          if (batch.modelStarted || batch.replies !== null) {
            store.abandonBatch(batch.throughSeq, 'interrupted');
            logEvent(logger, 'warn', 'processor.batch.interrupted', {
              through_seq: batch.throughSeq, next_reply_index: batch.nextReplyIndex,
              total: batch.replies?.length, replayed: false,
            });
            continue;
          }
          await this.options.beforeContext?.(store.getBatch(batch.throughSeq),signal);
          const context=store.prepareContext(store.getBatch(batch.throughSeq));
          store.markGenerationStarted(batch.throughSeq);
          store.recorder.append('run.started', { throughSeq: batch.throughSeq, messageIds: batch.messages.map(message => message.messageId), replyAllowed: batch.replyAllowed }, `run:${runId}:start`, { runId });
          logEvent(logger, 'info', 'processor.batch.started', {
            through_seq: batch.throughSeq, count: batch.messages.length, reply_allowed: batch.replyAllowed,
            next_reply_index: batch.nextReplyIndex,
          });
          deliveries = this.replyTools(batch.throughSeq, signal, runId);
          let observedEvent = 0;
          const result = await agent.run({...store.getBatch(batch.throughSeq),context}, store.getSessionId(), id => {
            stage = 'session_save';
            store.setSessionId(id);
            stage = 'agent';
          }, signal, deliveries.tools, event => {
            if(event.type==='context.committed')store.commitContext(event.payload as unknown as ContextCommit);
            const sequence = ++observedEvent;
            store.recorder.append(event.type,
              { ...event.payload, ...(event.type === 'usage.recorded' ? { usageId: event.payload.usageId ?? `${runId}:${sequence}` } : {}) },
              `${runId}:${event.type}:${event.itemId ?? sequence}${event.type==='thinking.updated'?`:${sequence}`:''}`, { runId, ...(event.itemId ? { itemId: event.itemId } : {}) });
          },this.options.taskTools);
          // Non-persistent adapters have no Pi acknowledgement channel; their successful
          // return is the explicit context boundary. Pi always acknowledges its file entry.
          if(!agent.supportsContextCommits)store.commitContext({batchId:context.batchId,conversationId:context.conversationId,
            session:store.getSessionId()??'',entryId:`adapter:${context.batchId}`,versions:context.versions,recallEventIds:context.recalls?.map(event=>event.eventId)});
          stage = 'reply_prepare';
          const usedTools = store.listReplyRequests(batch.throughSeq).length > 0;
          if (usedTools && result.messages.length > 0) throw new Error('Tool replies must not be repeated in the final output.');
          const messageIndices: number[] = [];
          const replies = usedTools ? store.getBatch(batch.throughSeq).replies!
            : batch.replyAllowed ? this.prepareReplies(result.messages, batch.throughSeq, messageIndices) : [];
          stage = 'replies_save';
          if (usedTools) store.finishGeneration(batch.throughSeq);
          else store.saveReplies(batch.throughSeq, replies, messageIndices, result.messages);
          logEvent(logger, 'info', 'processor.batch.result_saved', {
            through_seq: batch.throughSeq, message_count: result.messages.length, reply_count: replies.length,
            reply_allowed: batch.replyAllowed, duration_ms: Date.now() - started,
          });
          stage = 'send';
          await deliveries.flush();
          await this.deliverPending(batch.throughSeq, signal, runId, (value, index) => { stage = value; replyIndex = index; });
          if (signal.aborted) {
            store.abandonBatch(batch.throughSeq, 'cancelled', runId);
            break;
          }
          stage = 'batch_complete';
          const replyCount = store.getBatch(batch.throughSeq).replies?.length ?? 0;
          store.completeBatch(batch.throughSeq, { runId, durationMs: Math.max(0, Date.now() - (batch.messages.find(message => message.trigger)?.time ?? batch.messages[0]?.time ?? started / 1000) * 1000), replyAllowed: batch.replyAllowed });
          logEvent(logger, 'info', 'processor.batch.completed', {
            through_seq: batch.throughSeq, cursor: batch.throughSeq, reply_count: replyCount, duration_ms: Date.now() - started,
          });
        } catch (error) {
          this.contextRecovery=true;
          // Already accepted sends finish independently of model execution. A failed
          // execution never receives the same user input a second time.
          try { await deliveries?.flush(); } catch { /* Stored attempt markers prevent resends. */ }
          const metadata = error as {code?:unknown;providerStatus?:unknown;message?:unknown;modelFailure?:unknown}|null;
          const errorCode = typeof metadata?.code === 'string' && /^PI_[A-Z_]{1,60}$/.test(metadata.code) ? metadata.code : undefined;
          const httpStatus = typeof metadata?.providerStatus === 'number' && Number.isInteger(metadata.providerStatus)
            && metadata.providerStatus >= 400 && metadata.providerStatus <= 599 ? metadata.providerStatus : undefined;
          store.recorder.append('run.failed', { throughSeq: batch.throughSeq, durationMs: Date.now() - started,
            status: signal.aborted ? 'cancelled' : 'failed', ...(errorCode ? {errorCode,error:typeof metadata?.message==='string'?metadata.message.slice(0,600):errorCode}:{}),
            ...(httpStatus?{httpStatus}:{}) }, `run:${runId}:end`, { runId });
          logEvent(logger, 'warn', 'processor.batch.failed', {
            through_seq: batch.throughSeq, stage, reply_index: replyIndex, replayed: false, error_code:errorCode,
            http_status:httpStatus, duration_ms: Date.now() - started,
          });
          if (metadata?.modelFailure === true && batch.replyAllowed && !signal.aborted) {
            try {
              await this.options.sender.sendText(modelErrorReply(error), signal);
              logEvent(logger, 'info', 'processor.model_error_reply.sent', { through_seq: batch.throughSeq, run_ref: runId });
            } catch {
              logEvent(logger, 'warn', 'processor.model_error_reply.failed', { through_seq: batch.throughSeq, run_ref: runId });
            }
          }
          try { store.abandonBatch(batch.throughSeq, signal.aborted ? 'cancelled' : 'failed', runId); }
          catch {
            // A storage outage may delay cleanup, but model_started ensures the
            // next loop or process can only abandon this execution, never rerun it.
            if (!signal.aborted) try { await delay(retryMs, undefined, { signal }); } catch { break; }
          }
          if (signal.aborted) break;
        } finally { this.active = false; }
      }
    } finally { signal.removeEventListener('abort', abort); this.wake = undefined; }
  }

  private replyTools(throughSeq: number, signal: AbortSignal, runId: string): { tools: ReplyTools; flush(): Promise<void> } {
    const { store, logger } = this.options;
    let tail = Promise.resolve();
    let failed = false;
    let failure: unknown;
    let recallOperationId: string | undefined;
    const tools: ReplyTools = {
      send: async (request, metadata) => {
        if (signal.aborted) throw new Error('Reply acceptance cancelled.');
        await this.validateReplyTargets(request.messages,signal);
        if(signal.aborted)throw new Error('Reply acceptance cancelled.');
        this.replyTargets(request.messages);
        const requestId = randomUUID();
        const messageIndices: number[] = [];
        const parts = this.prepareReplies(request.messages, throughSeq, messageIndices);
        store.appendReplyRequest(throughSeq, requestId, request.messages, parts, messageIndices,metadata?.toolCallId);
        logEvent(logger, 'info', 'processor.reply_tool.accepted', {
          through_seq: throughSeq, run_ref: runId, request_ref: fingerprint(requestId), message_count: request.messages.length,
        });
        tail = tail.then(async () => {
          if (failed) return;
          try { await this.deliverPending(throughSeq, signal, runId); }
          catch (error) { failed = true; failure = error; }
        });
        return { accepted: true, messages:store.replyLedger.references(requestId).map(messageRef=>({messageRef,status:'queued' as const})) };
      },
      recall: async (request, metadata) => {
        if(signal.aborted)throw new Error('Reply recall cancelled.');
        const operationId=metadata?.operationId??metadata?.toolCallId??randomUUID();
        if(recallOperationId!==undefined&&recallOperationId!==operationId)
          throw new ReplyToolError('RECALL_LIMIT_REACHED','recall_message may be called at most once per agent run, including failed or unconfirmed attempts.');
        const existing=store.beginReplyRecall(request.messageRef,operationId);
        recallOperationId=operationId;
        if(existing==='started')return {messageRef:request.messageRef,status:'unconfirmed',parts:[],code:'RECALL_INTERRUPTED'};
        if(existing)return existing;
        const active=this.activeReply;
        if(active?.messageRef===request.messageRef)await active.done;
        const parts=store.replyLedger.parts(request.messageRef,store.recorder.conversationId);
        const cancelledParts=parts.filter(part=>part.state==='cancelled').length;
        const sent=parts.filter(part=>['acknowledged','recalled','started','unconfirmed'].includes(part.state));
        let result:RecallToolReceipt;
        if(!sent.length)result={messageRef:request.messageRef,status:cancelledParts===parts.length?'cancelled':'failed',parts:[],cancelledParts,
          ...(cancelledParts===parts.length?{}:{code:'RECALL_NOT_DELIVERED'})};
        else if(sent.every(part=>part.state==='recalled'))result={messageRef:request.messageRef,status:'already_recalled',cancelledParts,
          parts:sent.filter(part=>part.messageId).map(part=>({messageId:part.messageId!,partIndex:part.partIndex,status:'already_recalled'}))};
        else if(!this.options.sender.recallMessage)result={messageRef:request.messageRef,status:'failed',parts:[],cancelledParts,code:'RECALL_UNAVAILABLE'};
        else {
          try {result={...await this.options.sender.recallMessage(request.messageRef,operationId,signal),cancelledParts};}
          catch(error){result={messageRef:request.messageRef,status:'unconfirmed',parts:[],cancelledParts,
            code:typeof (error as {code?:unknown})?.code==='string'&&/^[A-Z][A-Z0-9_]{0,99}$/.test((error as {code:string}).code)?(error as {code:string}).code:'RECALL_UNCONFIRMED'};}
          for(const event of result.events??[])store.applyRecall(event);
        }
        store.finishReplyRecall(operationId,result);
        logEvent(logger,result.status==='failed'||result.status==='unconfirmed'?'warn':'info','processor.reply.recalled',{
          run_ref:runId,message_ref:fingerprint(request.messageRef),status:result.status,cancelled_parts:cancelledParts,part_count:result.parts.length,code:result.code});
        return result;
      },
    };
    return { tools, async flush() { await tail; if (failed) throw failure; } };
  }

  private async deliverPending(throughSeq: number, signal: AbortSignal, runId: string,
    progress: (stage: string, index: number) => void = () => {}): Promise<void> {
    const { store, sender, logger } = this.options;
    const imageOptions = { workspace: this.options.workspace, maxBytes: this.options.imageMaxBytes, timeoutMs: this.options.imageTimeoutMs, logger,fetch:this.options.imageFetch };
    while (!signal.aborted) {
      const batch = store.getBatch(throughSeq);
      const index = batch.nextReplyIndex;
      if (index >= (batch.replies?.length ?? 0)) return;
      let part = batch.replies![index]!;
      const request = store.listReplyRequests(throughSeq).find(request => request.startIndex <= index && request.endIndex > index);
      const requestRef = request ? fingerprint(request.requestId) : `final:${throughSeq}`;
      const durable=store.replyLedger.part(throughSeq,index);
      if(durable?.state==='cancelled'){store.skipCancelledReply(throughSeq,index);continue;}
      let stage = 'attempt_save';
      let sendStarted: number | undefined;
      let acknowledged = false;
      const attemptedAt = Date.now();
      const replyType = typeof part === 'string' ? 'text' : part.type;
      const fields = { through_seq: throughSeq, run_ref: runId, request_ref: requestRef, delivery_id: `${throughSeq}:${index}`, reply_index: index, type: replyType };
      // Persist before preparing or calling NapCat. Storage failures stop this
      // batch; they cannot turn a potentially delivered message into a retry.
      store.beginReplyAttempt(throughSeq, index);
      let releaseActive: (()=>void)|undefined;
      const active=durable?{messageRef:durable.messageRef,done:new Promise<void>(resolve=>{releaseActive=resolve;})}:undefined;
      this.activeReply=active;
      try {
        if (typeof part !== 'string' && part.type === 'image' && !part.file.startsWith('base64://')) {
          stage = 'image_prepare'; progress(stage, index);
          logEvent(logger, 'info', 'processor.image.prepare_started', fields);
          const prepared = await prepareImageReply(part.file, imageOptions, signal);
          stage = 'image_save'; progress(stage, index);
          store.saveImage(throughSeq, index, prepared.file);
          part.file = prepared.file;
          logEvent(logger, 'info', 'processor.image.prepared', { ...fields, duration_ms: Date.now() - attemptedAt });
        }
        if (typeof part !== 'string' && part.type === 'voice' && !part.file) {
          stage = 'voice_prepare'; progress(stage, index);
          logEvent(logger, 'info', 'processor.voice.prepare_started', fields);
          let preparedFile: string | undefined;
          try {
            if (!this.options.voiceReplyEnabled || !this.options.speech || !sender.sendVoice) throw new Error('Voice tools unavailable');
            const prepared = await this.options.speech.synthesize(part.text, signal);
            if (!isMp3Snapshot(prepared.file)) throw new Error('Invalid voice snapshot');
            preparedFile = prepared.file;
          } catch {
            if (signal.aborted) throw new Error('Voice preparation aborted');
            stage = 'voice_fallback_save'; progress(stage, index);
            store.fallbackVoice(throughSeq, index);
            part = part.text;
            logEvent(logger, 'warn', 'processor.voice.fallback', { ...fields, duration_ms: Date.now() - attemptedAt });
          }
          if (preparedFile !== undefined && typeof part !== 'string') {
            stage = 'voice_save'; progress(stage, index);
            store.saveVoice(throughSeq, index, preparedFile);
            part.file = preparedFile;
            logEvent(logger, 'info', 'processor.voice.prepared', { ...fields, duration_ms: Date.now() - attemptedAt });
          }
        }
        if (signal.aborted) throw new Error('Reply delivery cancelled.');
        stage = 'send'; progress(stage, index);
        let receipt: Awaited<ReturnType<typeof sender.sendText>>;
        const latest=store.replyLedger.part(throughSeq,index);
        if(latest?.cancelRequested){
          store.replyLedger.status(throughSeq,index,'cancelled');store.skipCancelledReply(throughSeq,index);continue;
        }
        sendStarted = Date.now();
        logEvent(logger, 'info', 'processor.reply.send_started', fields);
        receipt = await transmitReply(part,sender,signal,durable?.firstPart?durable.replyTo:undefined,durable?store.replyLedger.metadata(durable):undefined);
        acknowledged = true;
        logEvent(logger, 'info', 'processor.reply.sent', { ...fields, duration_ms: Date.now() - sendStarted, ...(receipt?.messageId ? { message_ref: receipt.messageId } : {}) });
        stage = 'reply_ack'; progress(stage, index);
        let assets:import('./chat-context-contract.js').ChatAsset[]|undefined;
        if(typeof part!=='string'&&(part.type==='image'||part.type==='voice')&&part.file)try{assets=[await saveChatAsset(this.options.workspace,part.file,part.type)];}
        catch{logEvent(logger,'warn','processor.reply.chat_media_failed',fields);}
        const saved = store.acknowledgeReply(throughSeq, index, receipt?.messageId,assets);
        if (!saved.mediaSaved) logEvent(logger, 'warn', 'processor.reply.media_snapshot_failed', fields);
        logEvent(logger, 'info', 'processor.reply.acknowledged', fields);
      } catch (error) {
        const errorCode = deliveryErrorCode(error, stage);
        const status = acknowledged ? 'acknowledged' : sendStarted === undefined ? 'failed' : deliveryFailureStatus(error);
        const retcode = deliveryRetcode(error);
        logEvent(logger, 'warn', 'processor.reply.failed', { ...fields, stage, status, error_code: errorCode, retcode, duration_ms: Date.now() - attemptedAt });
        if (acknowledged) throw error;
        store.failReply(throughSeq, index, sendStarted === undefined ? 'failed' : deliveryFailureStatus(error), stage, errorCode, retcode);
        if(durable&&/^QUOTE_TARGET_/.test(errorCode))store.cancelReply(durable.messageRef,errorCode);
      } finally {
        if(this.activeReply===active)this.activeReply=undefined;
        releaseActive?.();
      }
    }
  }

  private prepareReplies(messages: OutputMessage[], throughSeq: number, messageIndices?:number[]): ReplyPart[] {
    return prepareReplyParts(messages,this.options,throughSeq,messageIndices);
  }

  private replyTargets(messages: OutputMessage[]): Array<{id:string;index:number}> {
    const targets:Array<{id:string;index:number}>=[];
    for(const [index,message] of messages.entries())if('replyTo' in message&&message.replyTo){
      const source=this.options.store.chatMessageForQQ(message.replyTo);
      if(!source)throw new ReplyToolError('QUOTE_TARGET_UNKNOWN','The reply target is not a recorded QQ message.',index);
      if(source.conversationId!==this.options.store.recorder.conversationId)throw new ReplyToolError('QUOTE_TARGET_FORBIDDEN','The reply target belongs to another conversation.',index);
      if(source.recalled)throw new ReplyToolError('QUOTE_TARGET_RECALLED','The reply target has been recalled.',index);
      targets.push({id:message.replyTo,index});
    }
    return targets;
  }
  private async validateReplyTargets(messages: OutputMessage[], signal: AbortSignal): Promise<void> {
    const targets=this.replyTargets(messages);
    if(targets.length&&this.options.sender.validateReplyTargets)try {await this.options.sender.validateReplyTargets(targets.map(target=>target.id),signal);}
    catch(error){
      const detail=error as {code?:string;messageIndex?:number;messageId?:string};
      if(detail.code&&/^QUOTE_TARGET_[A-Z_]+$/.test(detail.code))throw new ReplyToolError(detail.code,'The quoted message is unavailable for this reply.',
        targets.find(target=>target.id===detail.messageId)?.index??targets[detail.messageIndex??0]?.index);
      throw error;
    }
  }

  private async processCommand(command: PendingCommand, signal: AbortSignal): Promise<void> {
    const { store, agent, sender, logger } = this.options;
    const started = Date.now();
    let stage = 'execute';
    let result = command.result;
    logEvent(logger, 'info', result === null ? 'processor.command.started' : 'processor.command.resumed', {
      command_id: command.id, kind: command.kind, result, confirmation_only: result !== null,
    });
    try {
      if (result === null) {
        if (command.kind === 'new') {
          stage = 'session_reset';
          store.resetSessionForCommand(command.id);
          result = 'new';
        } else if (command.kind === 'help') {
          result = 'help';
          stage = 'result_save';
          store.saveCommandResult(command.id, result);
        } else {
          const sessionId = store.getSessionId();
          if (!sessionId) result = 'empty';
          else {
            try {
              stage = 'compact';
              if (!agent.compact) throw new Error('Agent compaction is unavailable.');
              let compactEvent = 0;
              await agent.compact(sessionId, signal, event => store.recorder.append(event.type,event.payload,
                `command:${command.id}:${event.type}:${++compactEvent}`, {runId:`command:${command.id}`,...(event.itemId?{itemId:event.itemId}:{})}));
              result = 'compacted';
            } catch {
              if (signal.aborted) throw new Error('Command aborted.');
              result = 'failed';
              logEvent(logger, 'warn', 'processor.command.operation_failed', {
                command_id: command.id, kind: command.kind, stage, duration_ms: Date.now() - started,
              });
            }
          }
          stage = 'result_save';
          store.saveCommandResult(command.id, result);
        }
        logEvent(logger, 'info', 'processor.command.result_saved', { command_id: command.id, kind: command.kind, result });
      }
      if (signal.aborted) return;
      stage = 'confirmation_send';
      logEvent(logger, 'info', 'processor.command.confirmation_started', { command_id: command.id, kind: command.kind, result });
      await sender.sendText(result==='help'&&this.options.helpText?this.options.helpText():commandReplies[result], signal);
      logEvent(logger, 'info', 'processor.command.confirmation_sent', { command_id: command.id, kind: command.kind, result });
      stage = 'command_ack';
      store.acknowledgeCommand(command.id);
      logEvent(logger, 'info', 'processor.command.completed', {
        command_id: command.id, kind: command.kind, result, duration_ms: Date.now() - started,
      });
    } catch (error) {
      if (!signal.aborted) logEvent(logger, 'warn', 'processor.command.failed', {
        command_id: command.id, kind: command.kind, stage, retry_ms: this.options.retryMs, duration_ms: Date.now() - started,
      });
      throw error;
    }
  }
}

/** Only bounded machine-readable codes reach logs; raw errors may contain credentials. */
function deliveryErrorCode(error: unknown, stage: string): string {
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)) return code;
    if (typeof code === 'number' && Number.isSafeInteger(code)) return String(code);
  }
  return stage === 'send' ? 'SEND_UNCONFIRMED' : `${stage.toUpperCase()}_FAILED`;
}

function deliveryFailureStatus(error: unknown): 'failed' | 'unconfirmed' {
  return error && typeof error === 'object' && (error as { deliveryStatus?: unknown }).deliveryStatus === 'failed'
    ? 'failed' : 'unconfirmed';
}

function deliveryRetcode(error: unknown): number | undefined {
  const code = error && typeof error === 'object' ? (error as { retcode?: unknown }).retcode : undefined;
  return typeof code === 'number' && Number.isSafeInteger(code) ? code : undefined;
}
