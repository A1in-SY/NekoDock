import { ScheduledStore, type TaskTicket } from './scheduled-store.js';
import { runTaskScript } from './task-script.js';
import { activity, withActivityReporter } from './activity.js';
import { publishProcessSample } from './process-sample-channel.js';
import { validateReplyRequest } from './reply-contract.js';
import { logEvent } from './logging.js';
import type { Logger, ReplyToolRequest, RunObservation, TargetType } from './types.js';
import type { ScheduledExecutionTools, ScheduledInput, ScheduledRun, ScheduledTask, TaskDeliveryStatus } from './scheduled-contract.js';
import type { NetworkProxyConfig } from './network.js';

export interface SchedulerOptions {
 store:ScheduledStore;workspace:string;targetType?:TargetType;conversationId:()=>string;
 fetchTasks:()=>Promise<{tasks:ScheduledTask[];tickets:TaskTicket[]}>;
 authorize:(task:ScheduledTask)=>Promise<boolean>;
 applied:(value:{tasks:Array<{id:string;revision:number;nextRunAt:number|null}>;acknowledgedTickets:string[]})=>Promise<unknown>;
 executeModel:(input:ScheduledInput,task:ScheduledTask,tools:ScheduledExecutionTools,signal:AbortSignal,observer:(event:RunObservation)=>void)=>Promise<void>;
 send:(request:ReplyToolRequest,context:{run:ScheduledRun;task:ScheduledTask;requestId:string},signal:AbortSignal)=>Promise<{status:Exclude<TaskDeliveryStatus,'none'|'pending'>;acknowledgedMessages:number}>;
 history?:(task:ScheduledTask,scheduledAt:number)=>ScheduledInput['context']|Promise<ScheduledInput['context']>;
 record:(type:string,payload:Record<string,unknown>,run?:ScheduledRun,eventId?:string,time?:number)=>void;
 logger:Logger;now?:()=>number;notify?:()=>void;
 networkProxy?:NetworkProxyConfig;
}

/** Called by the existing serial Processor; ticking never executes user code. */
export class Scheduler {
 private draining=false;private running=false;private flight:Promise<void>|undefined;
 private lastSync=0;private readonly resetTickets=new Map<string,TaskTicket>();
 private readonly now:()=>number;
 constructor(readonly options:SchedulerOptions) {this.now=options.now??Date.now;options.store.recoverInterrupted(this.now());this.flushEvents();}
 get isRunning():boolean {return this.running;}
 get hasPending():boolean {return !this.draining&&(this.resetTickets.size>0||this.options.store.nextQueued()!==null);}
 get isDrained():boolean {return this.draining&&!this.running;}
 requestDrain():void {this.draining=true;}
 async close():Promise<void> {this.requestDrain();await this.flight;this.flushEvents();}
 async sync():Promise<void> {
  const {tasks,tickets}=await this.options.fetchTasks();const now=this.now();
  this.options.store.sync(tasks,now);
  const acknowledgedTickets:string[]=[];
  for(const ticket of tickets) {
   if(this.draining){if(this.options.store.hasTicket(ticket.id))acknowledgedTickets.push(ticket.id);continue;}
   if(ticket.operation==='reset-state'&&!this.options.store.hasTicket(ticket.id))this.resetTickets.set(ticket.id,ticket);
   else {this.options.store.ticket(ticket,now,this.options.conversationId());acknowledgedTickets.push(ticket.id);}
  }
  if(!this.draining)this.options.store.materializeDue(now,this.options.conversationId());
  this.flushEvents();
  await this.options.applied({tasks:this.options.store.tasks().map(task=>({id:task.id,revision:task.revision,nextRunAt:task.nextRunAt??null})),acknowledgedTickets});
  this.lastSync=now;
  if(this.hasPending)this.options.notify?.();
 }
 tick():Promise<void> {
  if(this.flight)return this.flight;
  if(this.draining)return Promise.resolve();
  this.flight=(async()=>{
   try {
    if(this.now()-this.lastSync>=5000||this.lastSync===0)await this.sync();
    else {this.options.store.materializeDue(this.now(),this.options.conversationId());this.flushEvents();if(this.hasPending)this.options.notify?.();}
   }catch {logEvent(this.options.logger,'warn','schedule.sync.failed');}
  })().finally(()=>{this.flight=undefined;});return this.flight;
 }
 async runNext(signal:AbortSignal):Promise<boolean> {
  if(this.draining||this.running||signal.aborted)return false;
  for(const ticket of this.resetTickets.values()) {
   this.options.store.ticket(ticket,this.now(),this.options.conversationId());this.resetTickets.delete(ticket.id);this.flushEvents();
   // The next sync ACKs the durable ticket; an unavailable Console cannot cause a second reset.
   return true;
  }
  const queued=this.options.store.nextQueued();if(!queued)return false;
  const task=this.options.store.task(queued.taskId);
  if(!task||task.deletedAt!==null||task.revision!==queued.taskRevision||!task.enabled){this.options.store.finishRun(queued.id,'missed','TASK_CHANGED',this.now());this.flushEvents();return true;}
  if(this.now()-queued.scheduledAt>task.maxDelaySeconds*1000){this.options.store.finishRun(queued.id,'missed','TASK_EXPIRED',this.now());this.flushEvents();return true;}
  let allowed:boolean;
  try {allowed=await this.options.authorize(task);}catch{return false;}
  if(!allowed){this.options.store.finishRun(queued.id,'missed','TASK_DISABLED_OR_CHANGED',this.now());this.flushEvents();return true;}
  if(this.draining||signal.aborted)return false;
  const run=this.options.store.startRun(queued.id,this.now(),this.options.conversationId());if(!run)return false;
  this.running=true;this.flushEvents();
  logEvent(this.options.logger,'info','schedule.run.started',{task_id:task.id,run_id:run.id,task_revision:task.revision,scheduled_at:run.scheduledAt});
  const controller=new AbortController();const abort=()=>controller.abort();signal.addEventListener('abort',abort,{once:true});
  const deadline=setTimeout(()=>controller.abort(),task.timeoutSeconds*1000);if(signal.aborted)controller.abort();
  let tail=Promise.resolve();let failure:unknown;let toolFailed=false;
  const tools:ScheduledExecutionTools={
   send:async request=>{
    controller.signal.throwIfAborted();
    const checked=validateReplyRequest(request,this.options.targetType);const requestId=this.options.store.beginDelivery(run.id,checked,this.now());this.flushEvents();
    tail=tail.then(async()=>{
     if(toolFailed) {this.options.store.finishDelivery(requestId,'failed',0,this.now());return;}
     try {
      const result=await this.options.send(checked,{run,task,requestId},controller.signal);
      this.options.store.finishDelivery(requestId,result.status,result.acknowledgedMessages,this.now());
     }catch {toolFailed=true;this.options.store.finishDelivery(requestId,'unconfirmed',0,this.now());}
     this.flushEvents();
    });
    return {accepted:true};
   },
   saveState:async(data,expectedVersion)=>{
    controller.signal.throwIfAborted();if(!task.context.taskState)throw new Error('TASK_STATE_DISABLED');
    const state=this.options.store.saveState(task.id,run.id,data,expectedVersion,this.now());this.flushEvents();return state;
   },
  };
  const observer=(event:RunObservation)=>{this.options.store.event(run,event.type,{...event.payload,...(event.itemId?{itemId:event.itemId}:{})},this.now());this.flushEvents();};
  try {
   const context:ScheduledInput['context']={...(await this.options.history?.(task,run.scheduledAt)??{}),...(task.context.taskState?{taskState:this.options.store.readState(task.id)}:{})};
   const input:ScheduledInput={kind:'scheduled_task',task:{id:task.id,name:task.name,instructions:task.instructions},context,
    invocation:{runId:run.id,scheduledAt:new Date(run.scheduledAt).toISOString(),startedAt:new Date(run.startedAt!).toISOString(),timezone:task.schedule.timezone}};
   if(task.kind==='script')await withActivityReporter(event=>observer({type:'activity.updated',payload:{...event}}),publishProcessSample,()=>activity('schedule','scheduled',()=>runTaskScript({task,input,workspace:this.options.workspace,tools,signal:controller.signal,targetType:this.options.targetType,networkProxy:this.options.networkProxy,
    onOutput:(stream,text)=>observer({type:'script.output',payload:{stream,text}})})));
   else await this.options.executeModel(input,task,tools,controller.signal,observer);
   if(!this.options.store.run(run.id)!.acceptedMessages)throw new Error('TASK_NO_REPLY');
  }catch(error){failure=error;}
  finally {
   try{await tail;}catch(error){failure??=error;}
   clearTimeout(deadline);signal.removeEventListener('abort',abort);
   const code=failure?errorCode(failure,controller.signal.aborted):undefined;
   if(failure) {
    const provider=failure as {code?:unknown;message?:unknown;providerStatus?:unknown};
    this.options.store.event(run,'execution.error',{errorCode:code,
     ...(typeof provider.code==='string'&&provider.code.startsWith('PI_')&&typeof provider.message==='string'?{error:provider.message.slice(0,600)}:{}),
     ...(typeof provider.providerStatus==='number'?{httpStatus:provider.providerStatus}:{})},this.now());
   }
   if(failure&&task.notifyOnFailure&&!signal.aborted) {
    const request:ReplyToolRequest={messages:[{type:'text',text:`定时任务「${task.name}」执行失败（${code}）。可在控制台查看运行记录。`}]};
    let requestId:string|undefined;
    try {requestId=this.options.store.beginDelivery(run.id,request,this.now());const result=await this.options.send(request,{run,task,requestId},signal);this.options.store.finishDelivery(requestId,result.status,result.acknowledgedMessages,this.now());}
    catch {if(requestId)this.options.store.finishDelivery(requestId,'unconfirmed',0,this.now());}
   }
   try {this.options.store.finishRun(run.id,failure?'failed':'completed',code,this.now());this.flushEvents();}finally{this.running=false;}
   logEvent(this.options.logger,failure?'warn':'info',failure?'schedule.run.failed':'schedule.run.completed',{task_id:task.id,run_id:run.id,error_code:code});
  }
  return true;
 }
 flushEvents():void {
  while(true) {
   const events=this.options.store.pendingEvents();if(!events.length)return;
   for(const event of events) {
    const run=event.runId?this.options.store.run(event.runId)??undefined:undefined;
    this.options.record(event.type,event.payload,run,`schedule:${event.seq}`,event.time);this.options.store.markExported(event.seq);
   }
  }
 }
}
function errorCode(error:unknown,aborted:boolean):string {
 if(aborted)return 'TASK_CANCELLED_OR_TIMEOUT';
 const value=error instanceof Error?error.message:'';
 const code=/^(?:TASK|PI)_[A-Z_0-9]+/.exec(value)?.[0];return code??'TASK_EXECUTION_FAILED';
}
