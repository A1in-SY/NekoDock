import { prepareReplyParts, transmitReply, type ReplyDeliveryOptions } from './reply-delivery.js';
import { prepareImageReply } from './images.js';
import { isMp3Snapshot } from './audio.js';
import { logEvent } from './logging.js';
import type { BridgeStore } from './store.js';
import type { ScheduledStore } from './scheduled-store.js';
import type { ScheduledRun, ScheduledTask, TaskDeliveryStatus } from './scheduled-contract.js';
import type { OutputMessage, ReplyPart, ReplyToolRequest } from './types.js';
import { saveChatAsset } from './chat-assets.js';
import type { ChatAsset } from './chat-context-contract.js';

export interface TaskDeliveryOptions extends ReplyDeliveryOptions {
  store:ScheduledStore;chatStore:BridgeStore;workspace:string;imageMaxBytes:number;imageTimeoutMs:number;imageFetch?:typeof globalThis.fetch;
}
export async function deliverTaskMessage(options:TaskDeliveryOptions,request:ReplyToolRequest,
  context:{run:ScheduledRun;task:ScheduledTask;requestId:string},signal:AbortSignal):Promise<{status:Exclude<TaskDeliveryStatus,'none'|'pending'>;acknowledgedMessages:number}> {
  const {store,chatStore,sender,logger}=options;const {run,task,requestId}=context;
  const indices:number[]=[];const parts=prepareReplyParts(request.messages,options,0,indices);
  const messagesOK=request.messages.map(()=>true);let acknowledgedParts=0;let unknown=false;
  for(const [index,source] of parts.entries()) {
    const logical=indices[index]!;const deliveryId=`task:${run.id}:${requestId}:${index}`;
    const original=request.messages[logical]!,quoteTarget='replyTo' in original?original.replyTo:undefined;
    const replyTo=indices.indexOf(logical)===index?quoteTarget:undefined;
    const fields={task_id:task.id,run_id:run.id,delivery_id:deliveryId,reply_index:index};
    if(signal.aborted||!store.beginAttempt(requestId,index)){messagesOK[logical]=false;continue;}
    let part=source;let transmitted=false;let acknowledged=false;
    logEvent(logger,'info','schedule.reply.started',fields);
    try {
      if(quoteTarget&&chatStore.chatMessageForQQ(quoteTarget)?.recalled)throw Object.assign(new Error('Quoted message was recalled.'),{deliveryStatus:'failed'});
      if(typeof part!=='string'&&part.type==='image') {
        const prepared=await prepareImageReply(part.file,{workspace:options.workspace,maxBytes:options.imageMaxBytes,timeoutMs:options.imageTimeoutMs,logger,fetch:options.imageFetch},signal);
        part={...part,file:prepared.file};
      } else if(typeof part!=='string'&&part.type==='voice') {
        try {
          if(!options.speech)throw new Error('Voice provider unavailable');
          const prepared=await options.speech.synthesize(part.text,signal);
          if(!isMp3Snapshot(prepared.file))throw new Error('Invalid voice snapshot');
          part={...part,file:prepared.file};
        } catch {if(signal.aborted)throw new Error('TASK_CANCELLED');part=part.text;}
      }
      signal.throwIfAborted();transmitted=true;
      const receipt=await transmitReply(part,sender,signal,replyTo);
      // Once the transport ACKs, later local failures must never turn this attempt into a resend.
      acknowledged=true;acknowledgedParts++;store.finishAttempt(requestId,index,'acknowledged');
      const body=partText(part);
      let assets:ChatAsset[]=[];
      if(typeof part!=='string'&&(part.type==='image'||part.type==='voice')&&part.file)try{assets=[await saveChatAsset(options.workspace,part.file,part.type)];}
      catch{assets=[{id:`task-media:${deliveryId}`,type:part.type,status:'failed',error:'Media snapshot could not be retained.'}];}
      chatStore.recordTaskReply(deliveryId,body,task.id,run.conversationId,receipt?.messageId,assets,replyTo);
      const acceptedId=`${requestId}:${index}`;
      const mediaPath=typeof part!=='string'&&(part.type==='image'||part.type==='voice')&&part.file?chatStore.recorder.mediaSnapshot(part.file,part.type):undefined;
      const output:OutputMessage=typeof part==='string'?{type:'text',text:part,...(replyTo?{replyTo}:{})}:part.type==='message'?{...part,...(replyTo?{replyTo}:{})}:part.type==='voice'?{type:'text',text:part.text}:{type:'image',path:mediaPath??'[image]'};
      chatStore.recorder.append('reply.accepted',{requestId:acceptedId,messages:[output],partCounts:[1],taskId:task.id,scheduled:true},`accepted:${deliveryId}`,{runId:run.id,conversationId:run.conversationId});
      chatStore.recorder.append('delivery.acknowledged',{deliveryId,requestId:acceptedId,partIndex:0,logicalMessageIndex:0,normal:true,taskId:task.id,
        kind:typeof part==='string'?'text':part.type,...(receipt?.messageId?{messageId:receipt.messageId}:{}),...(mediaPath?{mediaPath}:{})},`ack:${deliveryId}`,{runId:run.id,conversationId:run.conversationId});
      logEvent(logger,'info','schedule.reply.acknowledged',fields);
    } catch(error) {
      if(acknowledged){logEvent(logger,'warn','schedule.reply.record_failed',{...fields,status:'acknowledged'});continue;}
      messagesOK[logical]=false;
      const status=transmitted&&(error as {deliveryStatus?:string})?.deliveryStatus!=='failed'?'unconfirmed':'failed';
      unknown||=status==='unconfirmed';store.finishAttempt(requestId,index,status);
      store.event(run,'delivery.failed',{deliveryId,partIndex:index,status},Date.now());
      logEvent(logger,'warn','schedule.reply.failed',{...fields,status});
    }
  }
  return {status:acknowledgedParts===parts.length?'acknowledged':acknowledgedParts>0?'partial':unknown?'unconfirmed':'failed',acknowledgedMessages:messagesOK.filter(Boolean).length};
}
function partText(part:ReplyPart):string {
  return typeof part==='string'?part:part.type==='image'?'[image]':part.type==='voice'?part.text:part.segments.map(segment=>segment.type==='text'?segment.text:`@${segment.userId}`).join('');
}
