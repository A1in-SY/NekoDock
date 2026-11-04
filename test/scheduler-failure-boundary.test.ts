import test from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler } from '../src/scheduler.js';
import { ScheduledStore } from '../src/scheduled-store.js';
import type { ScheduledTask } from '../src/scheduled-contract.js';

const now=Date.parse('2026-01-02T00:00:00Z');
const definition:ScheduledTask={id:'task-demo',botId:'bot-demo',name:'Demo',kind:'model',enabled:true,schedule:{kind:'cron',expression:'* * * * *',timezone:'Asia/Shanghai'},instructions:'Send a report',script:null,context:{taskState:true},maxDelaySeconds:600,timeoutSeconds:120,notifyOnFailure:true,revision:1,creatorId:null,createdAt:now-60000,updatedAt:now-60000,deletedAt:null};
const logger={info(){},warn(){},error(){}};

test('a task that exhausts its message budget still records terminal failure when failure notification cannot be accepted',async()=>{
 const store=new ScheduledStore(':memory:');const events:unknown[]=[];
 const scheduler=new Scheduler({store,workspace:'/unused',targetType:'group',conversationId:()=>'chat',now:()=>now,fetchTasks:async()=>({tasks:[definition],tickets:[]}),authorize:async()=>true,applied:async()=>{},logger,
 record:(_type,payload)=>events.push(payload),send:async request=>({status:'acknowledged',acknowledgedMessages:request.messages.length}),
 executeModel:async(_input,_task,tools)=>{
  for(let n=0;n<3;n++)await tools.send({messages:Array.from({length:10},(_,i)=>({type:'text' as const,text:`result ${n}:${i}`}))});
  throw new Error('PI_EXECUTION_FAILED: 524 provider timeout');
 }});
 try{
  await scheduler.tick();await scheduler.runNext(new AbortController().signal);
  assert.equal(scheduler.isRunning,false);const row=store.db.prepare('SELECT id FROM scheduled_runs').get() as {id:string};const run=store.run(row.id)!;
  assert.equal(run.status,'failed');assert.equal(run.acceptedMessages,30);assert.equal(run.acknowledgedMessages,30);assert.equal(run.deliveryStatus,'acknowledged');assert.equal(scheduler.hasPending,false);
 }finally{await scheduler.close();store.close();}
});
