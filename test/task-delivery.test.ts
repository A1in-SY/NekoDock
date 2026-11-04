import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { BridgeStore } from '../src/store.js';
import { ScheduledStore } from '../src/scheduled-store.js';
import { deliverTaskMessage, type TaskDeliveryOptions } from '../src/task-delivery.js';
import { runTaskScript } from '../src/task-script.js';
import type { ScheduledInput, ScheduledTask } from '../src/scheduled-contract.js';
import type { ReplyToolRequest } from '../src/types.js';

const logger={info(){},warn(){},error(){}};
const now=Date.now();
const audio=`base64://${Buffer.from([0xff,0xfb,0x90,0x64,0,0,0,0]).toString('base64')}`;
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j90kAAAAASUVORK5CYII=';
function task():ScheduledTask {return {id:'task-demo',botId:'bot-demo',name:'Demo',kind:'model',enabled:true,schedule:{kind:'cron',expression:'* * * * *',timezone:'Asia/Shanghai'},instructions:'Say hello',script:null,context:{taskState:true},maxDelaySeconds:600,timeoutSeconds:10,notifyOnFailure:false,revision:1,creatorId:null,createdAt:now-60000,updatedAt:now-60000,deletedAt:null};}
function fixture(request:ReplyToolRequest,extra:Partial<TaskDeliveryOptions>={}) {
 const workspace=mkdtempSync(join(tmpdir(),'task-delivery-'));const store=new ScheduledStore(':memory:');const chatStore=new BridgeStore(':memory:',{type:'group',id:'1001'});const definition=task();
 store.sync([definition],now);store.materializeDue(now,chatStore.recorder.conversationId);const run=store.startRun(store.nextQueued()!.id,now)!;const requestId=store.beginDelivery(run.id,request,now);
 const sent:string[]=[];const options:TaskDeliveryOptions={store,chatStore,workspace,imageMaxBytes:1024*1024,imageTimeoutMs:1000,replyMaxChars:1500,logger,
 sender:{async sendText(text){sent.push(text);return {messageId:'q1'};},async sendImage(file){sent.push(file);return {messageId:'q2'};},async sendMessage(){return {messageId:'q3'};}},...extra};
 return {options,store,chatStore,workspace,sent,context:{run,task:definition,requestId},close(){store.close();chatStore.close();rmSync(workspace,{recursive:true,force:true});}};
}

test('task delivery never sends an attempted segment again after ACK and local history persistence failure',async()=>{
 const request:ReplyToolRequest={messages:[{type:'text',text:'once'}]};const f=fixture(request);
 f.chatStore.recordTaskReply=()=>{throw new Error('local database unavailable');};
 try {
  const first=await deliverTaskMessage(f.options,request,f.context,new AbortController().signal);assert.deepEqual(first,{status:'acknowledged',acknowledgedMessages:1});
  await deliverTaskMessage(f.options,request,f.context,new AbortController().signal);assert.deepEqual(f.sent,['once']);
  assert.equal(f.store.db.prepare('SELECT status FROM scheduled_attempts').get()!.status,'acknowledged');
 }finally{f.close();}
});

test('a successful transport ACK is retained if the attempt-state write itself fails',async()=>{
 const request:ReplyToolRequest={messages:[{type:'text',text:'once'}]};const f=fixture(request);
 f.store.finishAttempt=()=>{throw new Error('write unavailable after transport ACK');};
 try {
  const first=await deliverTaskMessage(f.options,request,f.context,new AbortController().signal);assert.equal(first.status,'acknowledged');
  await deliverTaskMessage(f.options,request,f.context,new AbortController().signal);assert.deepEqual(f.sent,['once']);
 }finally{f.close();}
});

test('uncertain transport results are recorded and do not create outgoing chat history or retries',async()=>{
 const request:ReplyToolRequest={messages:[{type:'text',text:'uncertain'}]};let attempts=0;
 const f=fixture(request,{sender:{async sendText(){attempts++;throw Object.assign(new Error('no ACK'),{deliveryStatus:'unconfirmed'});},async sendImage(){},async sendMessage(){}}});
 try {
  const result=await deliverTaskMessage(f.options,request,f.context,new AbortController().signal);assert.equal(result.status,'unconfirmed');assert.equal(result.acknowledgedMessages,0);
  await deliverTaskMessage(f.options,request,f.context,new AbortController().signal);assert.equal(attempts,1);assert.deepEqual(f.chatStore.takeExternalMessages(),[]);
 }finally{f.close();}
});

test('task delivery uses instance TTS and preserves original text when synthesis fails',async()=>{
 const request:ReplyToolRequest={messages:[{type:'text',text:'hello'}]};const spoken:string[]=[];const voices:string[]=[];
 const f=fixture(request,{voiceReplyEnabled:true,voiceReplyProbability:1,speech:{name:'test',async synthesize(text){spoken.push(text);return {file:audio};}},sender:{async sendText(){assert.fail('expected voice');},async sendVoice(file){voices.push(file);},async sendImage(){},async sendMessage(){}}});
 try{const result=await deliverTaskMessage(f.options,request,f.context,new AbortController().signal);assert.equal(result.status,'acknowledged');assert.deepEqual(spoken,['hello']);assert.deepEqual(voices,[audio]);assert.equal(f.chatStore.takeExternalMessages()[0]!.text,'hello');}finally{f.close();}
 const fallback=fixture(request,{voiceReplyEnabled:true,voiceReplyProbability:1,speech:{name:'test',async synthesize(){throw new Error('TTS unavailable');}},sender:{async sendText(text){spoken.push(text);},async sendVoice(){assert.fail('expected text fallback');},async sendImage(){},async sendMessage(){}}});
 try{const result=await deliverTaskMessage(fallback.options,request,fallback.context,new AbortController().signal);assert.equal(result.status,'acknowledged');assert.equal(spoken.at(-1),'hello');}finally{fallback.close();}
});

for(const runtime of ['python','node'] as const)test(`${runtime} script generated relative images reach the shared image delivery pipeline`,async()=>{
 const workspace=mkdtempSync(join(tmpdir(),'task-relative-image-'));const store=new ScheduledStore(':memory:');const chatStore=new BridgeStore(':memory:',{type:'group',id:'1001'});let sentImage='';
 const definition:ScheduledTask={...task(),kind:'script',script:{runtime,source:runtime==='python'?`from pathlib import Path\nfrom base64 import b64decode\nfrom nekodock_tasks import send_message\nPath('chart.png').write_bytes(b64decode('${png}'))\nsend_message({'messages':[{'type':'image','path':'chart.png'}]})`:`import {writeFileSync} from 'node:fs';import {sendMessage} from './nekodock_tasks.mjs';writeFileSync('chart.png',Buffer.from('${png}','base64'));sendMessage({messages:[{type:'image',path:'chart.png'}]});`}};
 store.sync([definition],now);store.materializeDue(now,chatStore.recorder.conversationId);const run=store.startRun(store.nextQueued()!.id,now)!;
 const input:ScheduledInput={kind:'scheduled_task',task:{id:definition.id,name:definition.name,instructions:''},context:{taskState:store.readState(definition.id)},invocation:{runId:randomUUID(),scheduledAt:new Date(now).toISOString(),startedAt:new Date(now).toISOString(),timezone:'Asia/Shanghai'}};
 try {
  await runTaskScript({task:definition,input,workspace,signal:new AbortController().signal,targetType:'group',tools:{saveState:async()=>{throw new Error('unexpected');},send:async request=>{
   const requestId=store.beginDelivery(run.id,request);const result=await deliverTaskMessage({store,chatStore,workspace,logger,imageMaxBytes:1024*1024,imageTimeoutMs:1000,replyMaxChars:1500,sender:{async sendText(){assert.fail('unexpected text');},async sendImage(file){sentImage=file;},async sendMessage(){}}},request,{run,task:definition,requestId},new AbortController().signal);
   assert.equal(result.status,'acknowledged');return {accepted:true};
  }}});
  assert.ok(sentImage.startsWith('base64://'));assert.deepEqual(Buffer.from(sentImage.slice(9),'base64'),Buffer.from(png,'base64'));
 }finally{store.close();chatStore.close();rmSync(workspace,{recursive:true,force:true});}
});
