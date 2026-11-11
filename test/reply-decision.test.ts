import assert from 'node:assert/strict';
import { test,type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BridgeStore } from '../src/store.js';
import { ReplyDecisionCoordinator } from '../src/reply-decision.js';
import { handleIncomingEvent } from '../src/incoming.js';
import type { ReplyDecisionConfig } from '../src/reply-decision-contract.js';
import type { IncomingMessage } from '../src/types.js';

const target={type:'group',id:'1001'} as const;
const config:ReplyDecisionConfig={mode:'jev',baseUrl:'https://judge.example.test/proxy/v1/',model:'synthetic-judge',apiKey:'synthetic-secret',threshold:0.7,timeoutMs:1000,instructions:''};
const message=(id:string,text=`message ${id}`):IncomingMessage=>({messageId:id,senderId:'2001',senderName:'Alice',time:Date.now()/1000,text,replyTo:null,trigger:false,rawJson:JSON.stringify({message:[{type:'text',data:{text}}]})});
const answer=(scores:number[])=>new Response(JSON.stringify({model:'synthetic-resolved',answers:Object.fromEntries(scores.map((score,index)=>[`reply_${index}`,{type:'noul',noul:score}])),usage:{input_tokens:30,output_tokens:2}}));
async function waitFor(check:()=>boolean):Promise<void>{for(let i=0;i<200;i++){if(check())return;await delay(5);}assert.fail('condition timed out');}
function fixture(t:TestContext,fetch:typeof globalThis.fetch,overrides:Partial<ReplyDecisionConfig>={},runtime:{now?:()=>number;mergeMs?:number}={}) {
  const store=new BridgeStore(':memory:',target),controller=new AbortController(),logs:string[]=[];
  const logger={info:(line:string)=>logs.push(line),warn:(line:string)=>logs.push(line),error:(line:string)=>logs.push(line)};
  let notifications=0;
  const judge=new ReplyDecisionCoordinator({store,config:{...config,...overrides},configRevision:'revision-1',logger,signal:controller.signal,fetch,
    notify:()=>notifications++,mergeMs:runtime.mergeMs??1,...(runtime.now?{now:runtime.now}:{})});
  t.after(async()=>{await judge.close();store.close();});
  const put=(id:string,text?:string)=>{const input=message(id,text);store.insert(input);judge.enqueue(input);return input;};
  const sent:string[]=[];
  const handle=(id:number,segments:unknown[],dispatch?:import('../src/plugin-contract.js').PluginDispatch)=>handleIncomingEvent({post_type:'message',message_type:'group',group_id:1001,self_id:999,
    message_id:id,user_id:2001,time:Date.now()/1000,message:segments}, {target,randomReplyProbability:1,store,logger,signal:controller.signal,
    replyDecision:judge,processor:{notify:()=>{}},sender:{sendText:async(text:string)=>{sent.push(text);}},...(dispatch?{dispatch}:{})});
  return {store,judge,put,handle,logs,sent,controller,get notifications(){return notifications;}};
}

test('one System One request selects actual outer message targets without sampling or adding chat facts',async t=>{
  const requests:Array<{url:string,init:RequestInit|undefined}>=[];
  const f=fixture(t,async(input,init)=>{requests.push({url:String(input),init});return answer([0.7,0.69]);},{},{mergeMs:5});
  f.put('1','跟你刚才说的那个有关');f.put('2','今天喝了奶茶');
  await waitFor(()=>f.notifications===1);
  assert.equal(requests.length,1);assert.equal(requests[0]!.url,'https://judge.example.test/proxy/v1/systemone');
  assert.equal((requests[0]!.init!.headers as Record<string,string>).authorization,'Bearer synthetic-secret');
  const request=JSON.parse(String(requests[0]!.init!.body));
  assert.deepEqual(request.state.candidates.map((row:{messageId:string})=>row.messageId),['1','2']);
  assert.equal(request.questions.reply_0.type,'noul');assert.match(request.questions.reply_1.instructions,/candidates\[1\]/);
  const batch=f.store.openOrCreateBatch(10)!;assert.deepEqual(batch.messages.map(row=>[row.messageId,row.trigger]),[['1',true],['2',false]]);
  const context=f.store.prepareContext(batch);assert.equal(context.messages.length,2);
  assert.doesNotMatch(JSON.stringify(context),/reply_0|noul|synthetic-secret/);
});

test('negative judgments do not trigger the main model and subsequent new messages remain eligible',async t=>{
  let calls=0;const f=fixture(t,async()=>{calls++;return answer([0.3]);});
  f.put('1');await waitFor(()=>f.logs.some(line=>line.includes('reply.decision.completed')));
  assert.equal(f.store.openOrCreateBatch(10),null);assert.equal(f.notifications,0);
  f.put('2');await waitFor(()=>calls===2);assert.equal(f.notifications,0);
});

test('pending decision does not make the instance busy or serialize ingestion behind network IO',async t=>{
  let release!:(response:Response)=>void,calls=0;
  const f=fixture(t,async()=>{calls++;return await new Promise(resolve=>{release=resolve;});});
  f.put('1');await waitFor(()=>calls===1);assert.equal(f.store.isBusy(),false);
  f.put('2');assert.equal(f.store.getMessage('2')?.text,'message 2');
  release(answer([0.9]));await waitFor(()=>f.notifications===1);await delay(10);assert.equal(calls,1);
  assert.deepEqual(f.store.openOrCreateBatch(10)!.messages.map(row=>row.trigger),[true,false]);
});

test('direct mention invalidates an in-flight decision even if ignored AbortSignal returns a late positive',async t=>{
  let release!:(response:Response)=>void,calls=0;
  const f=fixture(t,async()=>{calls++;return await new Promise(resolve=>{release=resolve;});});
  f.put('1');await waitFor(()=>calls===1);
  f.handle(2,[{type:'at',data:{qq:'999'}},{type:'text',data:{text:'请回答我'}}]);
  release(answer([0.99]));await delay(15);
  assert.equal(f.notifications,0);assert.equal(f.store.getMessage('1')?.trigger,false);assert.equal(f.store.getMessage('2')?.trigger,true);
});

for(const kind of ['new','compact','help'] as const)test(`${kind} command invalidates a pending judgment and stays out of context`,async t=>{
  let calls=0;const f=fixture(t,async()=>{calls++;return answer([1]);},{},{mergeMs:15});
  f.put('1');f.handle(2,[{type:'text',data:{text:`/${kind}`}}]);await delay(30);
  assert.equal(calls,0);assert.equal(f.store.getMessage('2'),null);assert.equal(f.store.getPendingCommand()?.kind,kind);
});

test('a busy interval invalidates judgments even after the interval has ended',async t=>{
  let release!:(response:Response)=>void,calls=0;
  const f=fixture(t,async()=>{calls++;return await new Promise(resolve=>{release=resolve;});});
  f.put('1');await waitFor(()=>calls===1);
  f.store.setScheduledBusy(true);f.store.setScheduledBusy(false);release(answer([1]));await delay(15);
  assert.equal(f.notifications,0);assert.equal(f.store.getMessage('1')?.trigger,false);
  f.store.setScheduledBusy(true);f.put('2');f.store.setScheduledBusy(false);await delay(10);assert.equal(calls,1);
});

test('draining cancels judges and permanently suspends new candidates in the runtime',async t=>{
  let calls=0;const f=fixture(t,async()=>{calls++;return answer([1]);},{},{mergeMs:15});
  f.put('1');f.store.invalidateReplyDecisions('draining');f.put('2');await delay(30);
  assert.equal(calls,0);assert.equal(f.notifications,0);
});

for(const [name,response] of [
  ['HTTP 500',()=>new Response('private upstream failure',{status:500})],
  ['missing answer',()=>new Response(JSON.stringify({answers:{}}))],
  ['wrong answer type',()=>new Response(JSON.stringify({answers:{reply_0:{type:'choice',noul:1}}}))],
  ['out of range score',()=>answer([1.1])],
  ['invalid JSON',()=>new Response('not json')],
  ['oversized JSON',()=>new Response(' '.repeat(70*1024))],
] as const)test(`${name} fails closed without retrying or sending a QQ message`,async t=>{
  let calls=0;const f=fixture(t,async()=>{calls++;return response();});
  f.put('1');await waitFor(()=>f.logs.some(line=>line.includes('reply.decision.failed')));await delay(10);
  assert.equal(calls,1);assert.equal(f.notifications,0);assert.equal(f.store.openOrCreateBatch(10),null);assert.deepEqual(f.sent,[]);
  assert.doesNotMatch(f.logs.join('\n'),/private upstream failure|synthetic-secret/);
});

test('timeout and close are bounded even when fetch never respects AbortSignal',async t=>{
  let calls=0;const f=fixture(t,async()=>{calls++;return await new Promise(()=>{});},{timeoutMs:15});
  f.put('1');await waitFor(()=>f.logs.some(line=>line.includes('reason="timeout"')));
  assert.equal(calls,1);assert.equal(f.notifications,0);
  await f.judge.close();
});

test('duplicate candidates are evaluated only once',async t=>{
  let calls=0;const f=fixture(t,async()=>{calls++;return answer([0]);});
  const input=f.put('1');f.judge.enqueue(input);await waitFor(()=>calls===1);await delay(10);f.judge.enqueue(input);await delay(10);
  assert.equal(calls,1);
});

test('expired candidates never issue a request',async t=>{
  let now=Date.now(),calls=0;const f=fixture(t,async()=>{calls++;return answer([1]);},{},{now:()=>now,mergeMs:10});
  f.put('1');now+=16_000;await delay(25);assert.equal(calls,0);assert.equal(f.notifications,0);
});

test('judge serializes requests, caps each batch at ten, and bounds its waiting queue',async t=>{
  let active=0,maxActive=0,seen=0;const sizes:number[]=[];
  const f=fixture(t,async(_input,init)=>{active++;maxActive=Math.max(maxActive,active);const size=JSON.parse(String(init!.body)).state.candidates.length;
    sizes.push(size);seen+=size;await delay(5);active--;return answer(Array(size).fill(0));},{},{mergeMs:1});
  for(let i=0;i<80;i++)f.put(String(i));
  await waitFor(()=>seen===50);await delay(15);
  assert.equal(maxActive,1);assert.deepEqual(sizes,[10,10,10,10,10]);assert.match(f.logs.join('\n'),/queue_full/);
});

test('background uses recent real chat, readable enhancement and cached image placeholders with bounded size',async t=>{
  let request:Record<string,any>|undefined;const f=fixture(t,async(_input,init)=>{request=JSON.parse(String(init!.body));return answer([0]);});
  for(let i=0;i<30;i++)f.store.insert(message(`background-${i}`,'背景'.repeat(1000)));
  f.store.insert({...message('old','过期的背景'),time:Date.now()/1000-3600});
  const input=message('candidate','看这个 [图片] base64://aGVsbG8=');f.store.insert(input);
  f.store.applyEnrichment('candidate','bilibili',[{type:'video',title:'当前视频标题',description:'描述',cover:'https://signed.example.test/image?token=secret',data:'data:image/jpeg;base64,aaaa'}],1);
  f.judge.enqueue(input);await waitFor(()=>!!request);
  assert.equal(request!.state.candidates[0].messageId,'candidate');assert.match(request!.state.candidates[0].contentSummary,/当前视频标题/);
  assert.ok(JSON.stringify(request!.state.recent_messages).length<=8002);
  assert.ok(request!.state.recent_messages.length<=20);
  assert.doesNotMatch(JSON.stringify(request),/base64:\/\/|data:image|signed\.example|过期的背景/);
});

test('ordinary eligibility excludes busy messages, stickers, plugin-owned commands and nested mentions',async t=>{
  let calls=0;const f=fixture(t,async(_input,init)=>{calls++;return answer(Array(JSON.parse(String(init!.body)).state.candidates.length).fill(0));});
  f.handle(1,[{type:'face',data:{id:'1'}}]);
  f.handle(2,[{type:'text',data:{text:'/content'}}],{executor:'console',contextPolicy:'chat',sourceMessageId:'2'} as import('../src/plugin-contract.js').PluginDispatch);
  f.store.setScheduledBusy(true);f.handle(3,[{type:'text',data:{text:'busy ordinary'}}]);f.store.setScheduledBusy(false);
  await delay(10);assert.equal(calls,0);
  f.handle(4,[{type:'forward',data:{content:[{sender:{user_id:'2002'},message:[{type:'at',data:{qq:'999'}}]}]}}]);
  await waitFor(()=>calls===1);assert.equal(f.store.getMessage('4')?.trigger,false);
});

test('unfinished durable decisions expire on runtime restart and cannot be re-enqueued',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'reply-decision-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const path=join(directory,'bridge.sqlite3');const first=new BridgeStore(path,target);first.insert(message('1'));
  const pending=first.createReplyDecision('1','v1',Date.now(),Date.now()+10_000)!;assert.ok(pending);first.close();
  const second=new BridgeStore(path,target);t.after(()=>second.close());second.initializeReplyDecisions();
  assert.equal(second.createReplyDecision('1','v2',Date.now(),Date.now()+10_000),null);
  assert.deepEqual(second.commitReplyDecisions([pending],[{score:1}],0.7,Date.now()),[]);
  const db=new DatabaseSync(path);t.after(()=>db.close());assert.equal(db.prepare('SELECT status FROM reply_decisions WHERE message_id=?').get('1')?.status,'stale');
});

test('recent background contains confirmed assistant replies but excludes tool and thinking events',async t=>{
  let request:Record<string,any>|undefined;const f=fixture(t,async(_input,init)=>{request=JSON.parse(String(init!.body));return answer([0]);});
  f.store.insert({...message('prior','上一轮用户消息'),trigger:true});const batch=f.store.openOrCreateBatch(10)!;
  f.store.saveReplies(batch.throughSeq,['上一轮已确认的回复']);f.store.acknowledgeReply(batch.throughSeq,0,'confirmed-qq-id');f.store.completeBatch(batch.throughSeq);
  f.store.recorder.append('thinking.updated',{text:'private-thinking-text'});
  f.store.recorder.append('tool.completed',{result:'private-tool-result'});
  f.put('current','追问');await waitFor(()=>!!request);
  const recent=request!.state.recent_messages as Array<Record<string,unknown>>;
  assert.ok(recent.some(row=>row.role==='assistant'&&row.text==='上一轮已确认的回复'&&row.messageId==='confirmed-qq-id'));
  assert.doesNotMatch(JSON.stringify(request),/private-thinking-text|private-tool-result/);
});

test('mismatched configuration, forged message identities and passed deadlines cannot become triggers',t=>{
  const store=new BridgeStore(':memory:',target);t.after(()=>store.close());store.initializeReplyDecisions();store.insert(message('1'));
  const candidate=store.createReplyDecision('1','original',Date.now(),Date.now()+10_000)!;
  assert.deepEqual(store.commitReplyDecisions([{...candidate,configRevision:'different'}],[{score:1}],0.7,Date.now()),[]);
  store.insert(message('2'));const next=store.createReplyDecision('2','original',Date.now(),Date.now()+10_000)!;
  assert.deepEqual(store.commitReplyDecisions([{...next,messageId:'not-received'}],[{score:1}],0.7,Date.now()),[]);
  assert.deepEqual(store.commitReplyDecisions([next],[{score:1}],0.7,next.expiresAt+1),[]);
  assert.equal(store.getMessage('1')?.trigger,false);assert.equal(store.getMessage('2')?.trigger,false);
});

test('a real quoted bot reply is identified outside the recent window and unknown references remain unknown',async t=>{
  let request:Record<string,any>|undefined;const now=Date.now()+3600_000;
  const f=fixture(t,async(_input,init)=>{request=JSON.parse(String(init!.body));return answer([0,0]);},{},{now:()=>now,mergeMs:5});
  f.store.insert({...message('prior','旧问题'),trigger:true});const batch=f.store.openOrCreateBatch(10)!;
  f.store.saveReplies(batch.throughSeq,['旧的真实回复']);f.store.acknowledgeReply(batch.throughSeq,0,'old-real-qq-id');f.store.completeBatch(batch.throughSeq);
  const followUp={...message('current','追问旧回复'),replyTo:'old-real-qq-id'};
  f.store.insert(followUp);f.judge.enqueue(followUp);
  const unknown={...message('other','这个引用是谁的'),replyTo:'unknown-qq-id'};f.store.insert(unknown);f.judge.enqueue(unknown);
  await waitFor(()=>!!request);
  assert.equal(request!.state.recent_messages.length,0);
  assert.deepEqual(request!.state.candidates[0].replyToMessage,{messageId:'old-real-qq-id',role:'assistant',senderId:'self',senderName:'Assistant',
    time:request!.state.candidates[0].replyToMessage.time,text:'旧的真实回复'});
  assert.deepEqual(request!.state.candidates[1].replyToMessage,{messageId:'unknown-qq-id',role:'unknown'});
});
