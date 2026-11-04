import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runTaskScript, previewTaskScript } from '../src/task-script.js';
import type { ScheduledInput, ScheduledTask, TaskState } from '../src/scheduled-contract.js';

const now=Date.parse('2026-01-02T00:00:00Z');
function task(runtime:'python'|'node',source:string):ScheduledTask{return {id:'task-script',botId:'bot-demo',name:'Script',kind:'script',enabled:true,
 schedule:{kind:'cron',expression:'* * * * *',timezone:'Asia/Shanghai'},instructions:'',script:{runtime,source},context:{taskState:true},maxDelaySeconds:600,timeoutSeconds:5,notifyOnFailure:false,
 revision:1,creatorId:'2001',createdAt:now,updatedAt:now,deletedAt:null};}
function input():ScheduledInput{return {kind:'scheduled_task',task:{id:'task-script',name:'Script',instructions:''},context:{taskState:{version:0,data:{},updatedAt:null,sourceRunId:null}},invocation:{runId:randomUUID(),scheduledAt:new Date(now).toISOString(),startedAt:new Date(now).toISOString(),timezone:'Asia/Shanghai'}};}

for(const runtime of ['python','node'] as const)test(`${runtime} script SDK sends ordered messages, reads state and commits a checkpoint without exposing credentials`,async()=>{
 const workspace=mkdtempSync(join(tmpdir(),'task-sdk-'));const sent:unknown[]=[];const logs:string[]=[];let state:TaskState={version:0,data:{},updatedAt:null,sourceRunId:null};
 const source=runtime==='python'?`from nekodock_tasks import send_message, read_task_state, save_task_state
import os
assert os.environ.get('AGENT_API_KEY') is None
state = read_task_state()
assert state['version'] == 0
result = save_task_state({'price': '1000.00'}, state['version'])
assert result['version'] == 1
assert read_task_state()['data']['price'] == '1000.00'
send_message({'messages':[{'type':'text','text':'早安'}]})
print('done')
`:`import {sendMessage,readTaskState,saveTaskState} from './nekodock_tasks.mjs';
if(process.env.AGENT_API_KEY)throw new Error('Credential leaked');
const state=readTaskState();if(state.version!==0)throw new Error('State missing');
saveTaskState({price:'1000.00'},state.version);
if(readTaskState().version!==1)throw new Error('State checkpoint missing');
sendMessage({messages:[{type:'text',text:'早安'}]});console.log('done');`;
 const previous=process.env.AGENT_API_KEY;process.env.AGENT_API_KEY='private-test-model-key';
 try {
  await runTaskScript({task:task(runtime,source),input:input(),workspace,signal:new AbortController().signal,targetType:'group',onOutput:(_stream,text)=>logs.push(text),tools:{
   send:async request=>{sent.push(request);return {accepted:true};},saveState:async(data,expectedVersion)=>{assert.equal(expectedVersion,state.version);state={version:state.version+1,data,updatedAt:now,sourceRunId:'run-demo'};return state;},
  }});
  assert.equal(sent.length,1);assert.equal(state.data.price,'1000.00');assert.match(logs.join(''),/done/);
 }finally{if(previous===undefined)delete process.env.AGENT_API_KEY;else process.env.AGENT_API_KEY=previous;rmSync(workspace,{recursive:true,force:true});}
});

test('script previews collect sends and keep state readonly',async()=>{
 const workspace=mkdtempSync(join(tmpdir(),'task-preview-'));
 try {
  const messages=await previewTaskScript({task:task('node',`import {sendMessage} from './nekodock_tasks.mjs';sendMessage({messages:[{type:'text',text:'preview'}]});`),input:input(),workspace,signal:new AbortController().signal});
  assert.deepEqual(messages,[{type:'text',text:'preview'}]);
 }finally{rmSync(workspace,{recursive:true,force:true});}
});

test('invalid message requests fail the script and are never forwarded',async()=>{
 const workspace=mkdtempSync(join(tmpdir(),'task-invalid-'));let sends=0;
 try {
  await assert.rejects(runTaskScript({task:task('node',`import {sendMessage} from './nekodock_tasks.mjs';sendMessage({messages:[{type:'text',text:''}]});`),input:input(),workspace,signal:new AbortController().signal,tools:{send:async()=>{sends++;return {accepted:true};},saveState:async()=>{throw new Error('unexpected');}}}),/TASK_SCRIPT_EXIT/);
  assert.equal(sends,0);
 }finally{rmSync(workspace,{recursive:true,force:true});}
});

test('timeout terminates the script and output limits bound stored diagnostics',async()=>{
 const workspace=mkdtempSync(join(tmpdir(),'task-limits-'));const tools={send:async()=>({accepted:true as const}),saveState:async()=>{throw new Error('unexpected');}};
 try {
  await assert.rejects(runTaskScript({task:{...task('node','setInterval(()=>{},1000);'),timeoutSeconds:0.1},input:input(),workspace,signal:new AbortController().signal,tools}),/TASK_TIMEOUT/);
  await assert.rejects(runTaskScript({task:task('node',`process.stdout.write('x'.repeat(300000));`),input:input(),workspace,signal:new AbortController().signal,tools}),/TASK_SCRIPT_OUTPUT_LIMIT/);
 }finally{rmSync(workspace,{recursive:true,force:true});}
});

test('task state tools stay disabled unless the task explicitly selects state context',async()=>{
 const workspace=mkdtempSync(join(tmpdir(),'task-state-disabled-'));let saves=0;
 try {
  await assert.rejects(runTaskScript({task:{...task('node',`import {saveTaskState} from './nekodock_tasks.mjs';saveTaskState({},0);`),context:{taskState:false}},input:input(),workspace,signal:new AbortController().signal,tools:{send:async()=>({accepted:true}),saveState:async()=>{saves++;throw new Error('unexpected');}}}),/TASK_SCRIPT_EXIT/);
  assert.equal(saves,0);
 }finally{rmSync(workspace,{recursive:true,force:true});}
});

test('script SDK exposes the bounded chat context and scheduled invocation snapshot',async()=>{
 const workspace=mkdtempSync(join(tmpdir(),'task-context-'));const data=input();data.context.chatMessages=[{id:'m1',senderId:'2001',senderName:'Alice',time:now,text:'context message',replyTo:null,role:'user'}];
 try {
  const output=await previewTaskScript({task:task('node',`import {readTaskContext,sendMessage} from './nekodock_tasks.mjs';const input=readTaskContext();sendMessage({messages:[{type:'text',text:input.context.chatMessages[0].text}]});`),input:data,workspace,signal:new AbortController().signal});
  assert.deepEqual(output,[{type:'text',text:'context message'}]);
 }finally{rmSync(workspace,{recursive:true,force:true});}
});

test('timeout also closes inherited output pipes held by a spawned child process',async()=>{
 const workspace=mkdtempSync(join(tmpdir(),'task-descendant-'));
 try{
  await assert.rejects(runTaskScript({task:{...task('node',`import {spawn} from 'node:child_process';spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});process.exit(0);`),timeoutSeconds:0.15},input:input(),workspace,signal:new AbortController().signal,tools:{send:async()=>({accepted:true}),saveState:async()=>{throw new Error('unexpected');}}}),/TASK_TIMEOUT/);
 }finally{rmSync(workspace,{recursive:true,force:true});}
});
