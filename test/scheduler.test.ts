import test from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler, type SchedulerOptions } from '../src/scheduler.js';
import { ScheduledStore } from '../src/scheduled-store.js';
import type { ScheduledTask } from '../src/scheduled-contract.js';

const now=Date.parse('2026-01-02T00:00:00Z');
const logger={info(){},warn(){},error(){}};
function task():ScheduledTask {return {id:'task-demo',botId:'bot-demo',name:'Demo',kind:'model',enabled:true,schedule:{kind:'cron',expression:'* * * * *',timezone:'Asia/Shanghai'},instructions:'Report current value',script:null,context:{taskState:true},maxDelaySeconds:600,timeoutSeconds:120,notifyOnFailure:false,revision:1,creatorId:null,createdAt:now-60000,updatedAt:now-60000,deletedAt:null};}
function fixture(overrides:Partial<SchedulerOptions>={}){
 const store=new ScheduledStore(':memory:');let clock=now;const events:Array<{type:string;payload:Record<string,unknown>;id:string|undefined}>=[];
 const scheduler=new Scheduler({store,workspace:'/unused',conversationId:()=>'main-conversation',fetchTasks:async()=>({tasks:[task()],tickets:[]}),authorize:async()=>true,applied:async()=>{},
  executeModel:async()=>{},send:async request=>({status:'acknowledged',acknowledgedMessages:request.messages.length}),logger,now:()=>clock,
  record:(type,payload,_run,id)=>events.push({type,payload,id}),...overrides});
 return {store,scheduler,events,setNow:(value:number)=>{clock=value;}};
}

test('a scheduled run uses a fresh task input with state/history and persists state despite a later model failure',async()=>{
 let observedInput:unknown;let sendCount=0;
 const f=fixture({history:async()=>({chatMessages:[],chatCoverage:{from:now-3600000,to:now,availableCount:0,includedCount:0,truncated:false,coverage:'complete'}}),
  executeModel:async(input,_task,tools,_signal,observer)=>{
   observedInput=input;await tools.saveState({price:'1000.00'},0);await tools.send({messages:[{type:'text',text:'report'}]});observer({type:'thinking.updated',payload:{text:'visible text'}});throw new Error('PI_EXECUTION_FAILED: provider 524');
  },send:async request=>{sendCount++;return {status:'acknowledged',acknowledgedMessages:request.messages.length};}});
 try{
  await f.scheduler.tick();assert.equal(f.scheduler.hasPending,true);assert.equal(await f.scheduler.runNext(new AbortController().signal),true);
  assert.equal(sendCount,1);assert.equal(f.store.readState('task-demo').data.price,'1000.00');
  const run=(f.store.db.prepare('SELECT id FROM scheduled_runs').get() as {id:string});assert.equal(f.store.run(run.id)!.status,'failed');assert.equal(f.store.run(run.id)!.deliveryStatus,'acknowledged');
  assert.equal((observedInput as {kind:string}).kind,'scheduled_task');assert.ok(f.events.some(event=>event.type==='schedule.run.event'));assert.ok(f.events.every(event=>event.id?.startsWith('schedule:')));
  assert.equal(await f.scheduler.runNext(new AbortController().signal),false);
 }finally{f.store.close();}
});

test('authorization outages retain queued runs; explicit disabled rejects and grace expires',async()=>{
 let fail=true;const f=fixture({authorize:async()=>{if(fail)throw new Error('offline');return false;}});
 try{
  await f.scheduler.tick();assert.equal(await f.scheduler.runNext(new AbortController().signal),false);assert.equal(f.scheduler.hasPending,true);
  fail=false;assert.equal(await f.scheduler.runNext(new AbortController().signal),true);assert.equal(f.scheduler.hasPending,false);
  await f.scheduler.sync();f.setNow(now+60000);await f.scheduler.tick();f.setNow(now+720000);
  assert.equal(await f.scheduler.runNext(new AbortController().signal),true);assert.equal(f.scheduler.hasPending,false);
 }finally{f.store.close();}
});

test('draining prevents new execution and ticks never start tasks themselves',async()=>{
 let modelCalls=0;const f=fixture({executeModel:async()=>{modelCalls++;}});
 try {await f.scheduler.tick();assert.equal(modelCalls,0);f.scheduler.requestDrain();assert.equal(f.scheduler.hasPending,false);assert.equal(f.scheduler.isDrained,true);assert.equal(await f.scheduler.runNext(new AbortController().signal),false);assert.equal(modelCalls,0);}finally{f.store.close();}
});

test('a running task blocks a second scheduler run and drain waits for current work',async()=>{
 let release!:()=>void;const blocked=new Promise<void>(resolve=>{release=resolve;});let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
 const f=fixture({executeModel:async()=>{entered();await blocked;}});
 try {await f.scheduler.tick();const running=f.scheduler.runNext(new AbortController().signal);await started;assert.equal(f.scheduler.isRunning,true);assert.equal(await f.scheduler.runNext(new AbortController().signal),false);
  f.scheduler.requestDrain();assert.equal(f.scheduler.isDrained,false);release();await running;assert.equal(f.scheduler.isDrained,true);
 }finally{release();f.store.close();}
});

test('reset controls execute only through the serial runNext boundary and ACK once',async()=>{
 const ticket={id:'reset-1',taskId:'task-demo',operation:'reset-state' as const};let acked:string[]=[];
 const f=fixture({fetchTasks:async()=>({tasks:[task()],tickets:[ticket]}),applied:async value=>{acked=value.acknowledgedTickets;}});
 try {await f.scheduler.sync();assert.equal(f.store.readState('task-demo').version,0);assert.deepEqual(acked,[]);
  await f.scheduler.runNext(new AbortController().signal);assert.equal(f.store.readState('task-demo').version,1);await f.scheduler.sync();assert.deepEqual(acked,['reset-1']);
  assert.equal(f.store.readState('task-demo').version,1);
 }finally{f.store.close();}
});

test('close waits for an inflight sync and does not consume new controls during drain',async()=>{
 let finishFetch!:(value:{tasks:ScheduledTask[];tickets:Array<{id:string;taskId:string;operation:'run'|'reset-state'}>})=>void;
 const fetched=new Promise<{tasks:ScheduledTask[];tickets:Array<{id:string;taskId:string;operation:'run'|'reset-state'}>}>(resolve=>{finishFetch=resolve;});
 const f=fixture({fetchTasks:()=>fetched});
 try {
  const ticking=f.scheduler.tick();let closed=false;const closing=f.scheduler.close().then(()=>{closed=true;});await Promise.resolve();assert.equal(closed,false);
  finishFetch({tasks:[task()],tickets:[{id:'manual-new',taskId:'task-demo',operation:'run'},{id:'reset-new',taskId:'task-demo',operation:'reset-state'}]});
  await ticking;await closing;assert.equal(closed,true);assert.equal(f.store.nextQueued(),null);assert.equal(f.store.hasTicket('manual-new'),false);assert.equal(f.store.readState('task-demo').version,0);
 }finally{f.store.close();}
});

test('a run with no accepted reply has a concrete failure rather than an apparent success',async()=>{
 const f=fixture();try {await f.scheduler.tick();await f.scheduler.runNext(new AbortController().signal);const row=f.store.db.prepare('SELECT id FROM scheduled_runs').get() as {id:string};assert.equal(f.store.run(row.id)!.status,'failed');assert.equal(f.store.run(row.id)!.error,'TASK_NO_REPLY');}finally{f.store.close();}
});

test('queued task binds outgoing events to the conversation active when execution starts',async()=>{
 let conversation='old-conversation';const f=fixture({conversationId:()=>conversation});
 try {await f.scheduler.tick();const queued=f.store.nextQueued()!;assert.equal(queued.conversationId,'old-conversation');conversation='new-conversation';await f.scheduler.runNext(new AbortController().signal);assert.equal(f.store.run(queued.id)!.conversationId,'new-conversation');}finally{f.store.close();}
});

test('aborted tasks cannot save state or accept additional messages after the deadline',async()=>{
 let toolErrors:string[]=[];
 const f=fixture({fetchTasks:async()=>({tasks:[{...task(),timeoutSeconds:0.01}],tickets:[]}),executeModel:async(_input,_task,tools,signal)=>{
  await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));
  try{await tools.saveState({invalid:true},0);}catch{toolErrors.push('state');}
  try{await tools.send({messages:[{type:'text',text:'late'}]});}catch{toolErrors.push('send');}
  signal.throwIfAborted();
 }});
 try{await f.scheduler.tick();await f.scheduler.runNext(new AbortController().signal);assert.deepEqual(toolErrors,['state','send']);assert.equal(f.store.readState('task-demo').version,0);}finally{f.store.close();}
});

test('manual tickets retain the original request time and expire after an offline interval',async()=>{
 const f=fixture({fetchTasks:async()=>({tasks:[task()],tickets:[{id:'offline-manual',taskId:'task-demo',operation:'run',createdAt:now-720000}]})});
 try {await f.scheduler.sync();const queued=f.store.nextQueued()!;assert.equal(queued.manual,true);assert.equal(queued.scheduledAt,now-720000);await f.scheduler.runNext(new AbortController().signal);assert.equal(f.store.run(queued.id)!.status,'missed');assert.equal(f.store.run(queued.id)!.error,'TASK_EXPIRED');}finally{f.store.close();}
});

test('visible thinking and tool observer identities remain available to the task detail renderer',async()=>{
 const f=fixture({executeModel:async(_input,_task,tools,_signal,observer)=>{observer({type:'thinking.updated',itemId:'thinking-1',payload:{text:'visible thought'}});await tools.send({messages:[{type:'text',text:'done'}]});}});
 try{await f.scheduler.sync();await f.scheduler.runNext(new AbortController().signal);const event=f.events.find(event=>event.type==='schedule.run.event')!;assert.equal((event.payload.eventPayload as Record<string,unknown>).itemId,'thinking-1');}finally{f.store.close();}
});
