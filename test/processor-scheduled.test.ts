import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Processor } from '../src/processor.js';
import { Scheduler } from '../src/scheduler.js';
import { ScheduledStore } from '../src/scheduled-store.js';
import { BridgeStore } from '../src/store.js';
import { handleIncomingEvent, busyReply } from '../src/incoming.js';
import { deliverTaskMessage } from '../src/task-delivery.js';
import type { ScheduledTask } from '../src/scheduled-contract.js';
import type { MessageSender } from '../src/types.js';

const logger={info(){},warn(){},error(){}};
async function until(check:()=>boolean){const deadline=Date.now()+3000;while(!check()){if(Date.now()>deadline)throw new Error('Condition timeout');await delay(5);}}
function task(now:number):ScheduledTask {return {id:'task-demo',botId:'bot-demo',name:'Demo',kind:'model',enabled:true,schedule:{kind:'cron',expression:'* * * * *',timezone:'Asia/Shanghai'},instructions:'Send a report',script:null,context:{taskState:false},maxDelaySeconds:600,timeoutSeconds:120,notifyOnFailure:false,revision:1,creatorId:null,createdAt:now-60000,updatedAt:now-60000,deletedAt:null};}

test('scheduled generation and delivery share chat busy semantics and drain waits for the final ACK',async()=>{
 const workspace=mkdtempSync(join(tmpdir(),'scheduled-processor-'));const store=new BridgeStore(':memory:',{type:'group',id:'1001'});const scheduledStore=new ScheduledStore(':memory:');const abort=new AbortController();const now=Math.floor(Date.now()/60000)*60000;
 let releaseModel!:()=>void;const modelGate=new Promise<void>(resolve=>{releaseModel=resolve;});let releaseACK!:()=>void;const ackGate=new Promise<void>(resolve=>{releaseACK=resolve;});
 let started=false;let sending=false;let chatCalls=0;const sent:string[]=[];
 const sender:MessageSender={async sendText(text){sent.push(text);if(text!==busyReply){sending=true;await ackGate;}return {messageId:'q1'};},async sendImage(){},async sendMessage(){}};
 let processor:Processor;
 const scheduler=new Scheduler({store:scheduledStore,workspace,targetType:'group',now:()=>now,conversationId:()=>store.recorder.conversationId,fetchTasks:async()=>({tasks:[task(now)],tickets:[]}),authorize:async()=>true,applied:async()=>{},
  executeModel:async(_input,_task,tools)=>{started=true;await modelGate;await tools.send({messages:[{type:'text',text:'scheduled report'}]});},
  send:(request,context,signal)=>deliverTaskMessage({store:scheduledStore,chatStore:store,workspace,sender,logger,replyMaxChars:1500,imageMaxBytes:1000000,imageTimeoutMs:1000},request,context,signal),
  record:(type,payload,run,id,time)=>store.recorder.append(type,payload,id,{runId:run?.id,conversationId:run?.conversationId,time}),logger,notify:()=>processor?.notify()});
 processor=new Processor({store,agent:{async run(){chatCalls++;return {messages:[]};}},sender,logger,batchSize:50,replyMaxChars:1500,retryMs:5,workspace,imageMaxBytes:1000000,imageTimeoutMs:1000,scheduler});
 let running:Promise<void>|undefined;
 try {
  await scheduler.tick();running=processor.run(abort.signal);await until(()=>started);assert.equal(processor.isProcessing,true);assert.equal(store.isBusy(),true);
  const input={target:{type:'group' as const,id:'1001'},store,processor,sender,logger,signal:abort.signal,randomReplyProbability:1,random:()=>assert.fail('busy input must not sample')};
  handleIncomingEvent({post_type:'message',message_type:'group',group_id:1001,self_id:999,message_id:2,user_id:2001,time:Math.floor(Date.now()/1000),message:[{type:'text',data:{text:'ordinary background'}}]},input);
  assert.deepEqual(sent,[]);assert.equal(store.openOrCreateBatch(50),null);
  handleIncomingEvent({post_type:'message',message_type:'group',group_id:1001,self_id:999,message_id:3,user_id:2001,time:Math.floor(Date.now()/1000),message:[{type:'at',data:{qq:'999'}},{type:'text',data:{text:'a question'}}]},input);
  assert.deepEqual(sent,[busyReply]);processor.requestDrain();assert.equal(processor.isDrained,false);
  releaseModel();await until(()=>sending);assert.equal(processor.isDrained,false);assert.equal(store.isBusy(),true);
  releaseACK();await until(()=>processor.isDrained);assert.equal(chatCalls,0);assert.deepEqual(sent,[busyReply,'scheduled report']);
  const events=store.recorder.pending();assert.equal(events.filter(event=>event.type==='delivery.acknowledged').length,1);assert.ok(events.every(event=>!JSON.stringify(event.payload).includes(busyReply)));
  assert.equal(store.getCursor(),0);assert.equal(store.isBusy(),true);
 }finally{releaseModel();releaseACK();abort.abort();await running;await scheduler.close();scheduledStore.close();store.close();rmSync(workspace,{recursive:true,force:true});}
});
