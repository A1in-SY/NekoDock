import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import type {AgentMessage} from '@earendil-works/pi-agent-core';
import {PiRunner} from '../src/pi.js';
import {createPiTools} from '../src/pi-tools.js';
import {ReplyToolError,replyMessagesSchema,validateRecallRequest,validateReplyRequest} from '../src/reply-contract.js';
import {appendRecallEvents,CHAT_RECALL_CUSTOM_TYPE,committedContext,modelContextMessages,prepareContextInput,recoverContextReceipts} from '../src/pi-context.js';
import type {PiConfig} from '../src/pi-protocol.js';
import type {ChatContextMessage,ChatRecallEvent,ContextCommit,ContextSubmission} from '../src/chat-context-contract.js';
import type {PendingBatch,ReplyTools,RunObservation} from '../src/types.js';
import {decodeModelCall,respond,type ModelHandler} from './fixtures/pi-e2e.js';

const config:PiConfig={home:'/tmp/recall-tools',workspace:'/tmp/recall-tools',model:'synthetic',baseUrl:'http://127.0.0.1:1/v1',
  api:'openai-completions',contextWindow:200000,compactLimit:160000,maxOutputTokens:1000,supportsImages:false,supportsReasoning:false,
  allowCommands:false,allowFileWrites:false,persona:'Synthetic test persona.',targetType:'group'};
const recall:ChatRecallEvent={eventId:'recall-example-one',messageId:'10001',time:100,authorId:'20001',operatorId:'20001'};
const human=(id='10001'):ChatContextMessage=>({chatMessageId:`in:${id}`,conversationId:'example-conversation',revision:1,
  messageId:id,senderId:'20001',senderName:'Example user',time:90,text:'The original request.',replyTo:null,role:'user',origin:'human'});
const submission=(id:string,messages:ChatContextMessage[],recalls?:ChatRecallEvent[]):ContextSubmission=>({batchId:id,conversationId:'example-conversation',
  messages,revisions:[],references:[],versions:messages.map(m=>({chatMessageId:m.chatMessageId,revision:m.revision})),...(recalls?{recalls}:{})});
const batch=(context:ContextSubmission,replyAllowed=true):PendingBatch=>({throughSeq:1,messages:context.messages.filter(m=>m.origin==='human').map((m,i)=>({
  seq:i+1,messageId:m.messageId!,senderId:m.senderId,senderName:m.senderName,time:m.time,text:m.text,replyTo:m.replyTo,
  trigger:replyAllowed,rawJson:JSON.stringify({message:[{type:'text',data:{text:m.text}}]})})),replyAllowed,replies:null,nextReplyIndex:0,context});
const text=(value:unknown)=>JSON.stringify(value);
const toolBody=(result:{content:unknown[]})=>JSON.parse((result.content[0] as {text:string}).text);

test('provider recall dedup removes only events covered by a visible recall tool result without changing durable messages',()=>{
  const other={...recall,eventId:'external-recall',messageId:'10002'};
  const notice=(event:ChatRecallEvent):AgentMessage=>({role:'custom',customType:CHAT_RECALL_CUSTOM_TYPE,
    content:JSON.stringify({source:'chat_state',type:'message_recalled',...event}),display:false,details:{event},timestamp:1});
  const result:AgentMessage={role:'toolResult',toolName:'recall_message',toolCallId:'recall-partial',isError:false,timestamp:1,
    content:[{type:'text',text:JSON.stringify({status:'partial',events:[recall]})}]};
  const covered=notice(recall),external=notice(other);
  for(const messages of [[covered,result,external],[result,covered,external]]) {
    const before=structuredClone(messages),filtered=modelContextMessages(messages);
    assert.deepEqual(filtered,[result,external]);assert.deepEqual(messages,before);
    assert.ok(messages.includes(covered),'The original status entry must remain durable');
  }
  assert.deepEqual(modelContextMessages([covered,external]),[covered,external],
    'A status remains necessary when the corresponding tool output is absent from the current context');
});

test('provider recall dedup preserves notices not confirmed by a matching successful tool output',()=>{
  const notice:AgentMessage={role:'custom',customType:CHAT_RECALL_CUSTOM_TYPE,content:'Recall status',display:false,details:{event:recall},timestamp:1};
  const result=(body:unknown,extra:Record<string,unknown>={}):AgentMessage=>({role:'toolResult',toolName:'recall_message',toolCallId:'recall-test',
    isError:false,timestamp:1,content:[{type:'text',text:typeof body==='string'?body:JSON.stringify(body)}],...extra});
  for(const output of [
    result({status:'unconfirmed',events:[]}),result({status:'recalled'}),result('invalid JSON'),
    result({events:[{...recall,time:'invalid'}]}),result({events:[{...recall,messageId:'different-message'}]}),
    result({events:[recall]},{isError:true}),result({events:[recall]},{toolName:'search_chat_history'}),
  ])assert.deepEqual(modelContextMessages([output,notice]),[output,notice]);
  const unrelated:AgentMessage={...notice,customType:'unrelated-status'};
  const output=result({events:[recall]});assert.deepEqual(modelContextMessages([output,unrelated]),[output,unrelated]);
});

test('reply arguments preserve independent real QQ quote targets and reject media quotes or invented reply segments',()=>{
  const request={messages:[{type:'text',text:'First answer.',replyTo:'10001'},
    {type:'message',segments:[{type:'at',userId:'20002'},{type:'text',text:'Second answer.'}],replyTo:'10002'},
    {type:'text',text:'Unquoted answer.'}]};
  assert.deepEqual(validateReplyRequest(request,'group'),request);
  assert.deepEqual(validateReplyRequest({messages:[{type:'text',text:'Private answer.',replyTo:'-10003'}]},'private'),
    {messages:[{type:'text',text:'Private answer.',replyTo:'-10003'}]});
  for(const invalid of [
    {type:'text',text:'Answer.',replyTo:''},{type:'text',text:'Answer.',replyTo:' 10001'},
    {type:'text',text:'Answer.',replyTo:10001},{type:'text',text:'Answer.',replyTo:'x'.repeat(201)},
    {type:'image',path:'image.png',replyTo:'10001'},{type:'image',path:'image.png',text:'Unexpected'},
    {type:'message',segments:[{type:'reply',id:'10001'},{type:'text',text:'Answer.'}]},
  ])assert.throws(()=>validateReplyRequest({messages:[invalid]},'group'),ReplyToolError);
  assert.throws(()=>validateReplyRequest({messages:[request.messages[1]]},'private'),ReplyToolError);
  assert.equal((replyMessagesSchema('group').items.anyOf[0]!.properties as Record<string,unknown>).replyTo!==undefined,true);
  assert.deepEqual(validateRecallRequest({messageRef:'reply_example:0'}),{messageRef:'reply_example:0'});
  for(const invalid of [{messageRef:''},{messageRef:' reply_example:0'},{messageRef:'reply_example:0',messageId:'10001'}])
    assert.throws(()=>validateRecallRequest(invalid),ReplyToolError);
});

test('reply tools return stable references and actionable errors without accepting malformed sends',async()=>{
  let sends=0,recalls=0;
  const tools=createPiTools(config,async()=>{sends++;return {accepted:true,messages:[{messageRef:'reply_example:0',status:'queued'}]};},undefined,undefined,{
    recall:async request=>{recalls++;return {...request,status:'recalled',parts:[{messageId:'10003',partIndex:0,status:'recalled'}]};},
  });
  const send=tools.find(t=>t.name==='send_message')!,takeBack=tools.find(t=>t.name==='recall_message')!;
  const result=await send.execute('send-example',{messages:[{type:'text',text:'Example.',replyTo:'10001'}]},undefined,undefined,{} as never);
  assert.deepEqual(toolBody(result),{accepted:true,messages:[{messageRef:'reply_example:0',status:'queued'}]});
  assert.equal(toolBody(await takeBack.execute('recall-example',{messageRef:'reply_example:0'} ,undefined,undefined,{} as never)).status,'recalled');
  const invalid=toolBody(await send.execute('invalid-example',{messages:[{type:'image',path:'image.png',replyTo:'10001'}]},undefined,undefined,{} as never));
  assert.equal(invalid.accepted,false);assert.equal(invalid.error.code,'REPLY_INVALID_REQUEST');assert.equal(sends,1);assert.equal(recalls,1);
  assert.equal(takeBack.executionMode,'sequential');
});

async function fixture(t:TestContext,handler:ModelHandler,tools:ReplyTools) {
  const root=await mkdtemp(join(tmpdir(),'pi-recall-'));const home=join(root,'pi'),workspace=join(root,'workspace');await mkdir(home);await mkdir(workspace);
  const requests:Record<string,any>[]=[],errors:unknown[]=[];
  const server=createServer((req,res)=>{void(async()=>{
    let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);requests.push(body);
    await handler(decodeModelCall(req.url!,undefined,body),res,requests.length);
  })().catch(error=>{errors.push(error);res.writeHead(500);res.end('{}');});});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert.ok(address&&typeof address!=='string');
  const events:RunObservation[]=[];let session:string|null=null;
  const runner=new PiRunner({...config,home,workspace,baseUrl:`http://127.0.0.1:${address.port}/v1`,timeoutMs:10000,logger:{info(){},warn(){},error(){}}});
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(root,{recursive:true,force:true});assert.deepEqual(errors,[]);});
  return {runner,requests,events,get session(){return session;},run:(input:PendingBatch)=>runner.run(input,session,path=>{session=path;},new AbortController().signal,tools,e=>events.push(e))};
}

test('Pi returns a rejected quote as a correctable tool result and accepts only the repaired call',async t=>{
  let attempts=0;const accepted:unknown[]=[];
  const f=await fixture(t,(call,response,index)=>{
    if(index===1)respond(call,response,[{name:'send_message',arguments:{messages:[{type:'text',text:'Answer.',replyTo:'10001'}]}}]);
    else if(index===2) {
      assert.match(text(call.body.messages),/QUOTE_TARGET_RECALLED/);assert.match(text(call.body.messages),/messageIndex/);
      respond(call,response,[{name:'send_message',arguments:{messages:[{type:'text',text:'Repaired answer.',replyTo:'10002'}]}}]);
    }else {assert.match(text(call.body.messages),/reply_repaired:0/);respond(call,response,'Internal completion.');}
  },{send:async request=>{attempts++;if(attempts===1)throw new ReplyToolError('QUOTE_TARGET_RECALLED','The quoted message was recalled.',0);
    accepted.push(request);return {accepted:true,messages:[{messageRef:'reply_repaired:0',status:'queued'}]};}});
  await f.run(batch(submission('quote-repair',[human()])));
  assert.equal(attempts,2);assert.equal(accepted.length,1);assert.equal(f.requests.length,3);
  assert.ok(f.events.some(e=>e.type==='tool.completed'&&e.payload.tool==='send_message'));
});

test('Pi preserves recall results and durable status while filtering duplicate provider user notices across continuations and resume',async t=>{
  let recalled='';const selfRecall={...recall,messageId:'10003',authorId:'self'};
  const f=await fixture(t,(call,response,index)=>{
    if(index===1){assert.ok(call.body.tools.some((t:any)=>t.function?.name==='recall_message'));respond(call,response,[{name:'send_message',arguments:{messages:[{type:'text',text:'An incorrect answer.'}]}}]);}
    else if(index===2){assert.match(text(call.body.messages),/reply_original:0/);respond(call,response,[{name:'recall_message',arguments:{messageRef:'reply_original:0'}}]);}
    else if(index===3){assert.ok(call.body.messages.some((item:any)=>item.role==='tool'&&JSON.parse(item.content).status==='recalled'));
      assert.ok(!call.body.messages.some((item:any)=>item.role==='user'&&text(item.content).includes('message_recalled')));
      assert.deepEqual(call.body.tools,f.requests[0]!.tools,'Tool definitions remain static throughout the run');
      f.runner.notifyRecall(selfRecall);
      respond(call,response,[{name:'send_message',arguments:{messages:[{type:'text',text:'The corrected answer.'}]}}]);}
    else {
      assert.ok(!call.body.messages.some((item:any)=>item.role==='user'&&text(item.content).includes('message_recalled')));
      if(index===5)respond(call,response,[{name:'send_message',arguments:{messages:[{type:'text',text:'A later answer.'}]}}]);
      else respond(call,response,'Internal completion.');
    }
  },{send:async()=>({accepted:true,messages:[{messageRef:'reply_original:0',status:'queued'}]}),recall:async(request,meta)=>{
    recalled=request.messageRef;assert.ok(meta?.operationId);assert.ok(meta?.toolCallId);
    f.runner.notifyRecall(selfRecall);
    return {messageRef:request.messageRef,status:'recalled',parts:[{messageId:'10003',partIndex:0,status:'recalled'}],events:[selfRecall]};
  }});
  await f.run(batch(submission('self-recall',[human()])));assert.equal(recalled,'reply_original:0');assert.equal(f.requests.length,4);
  const entries=(await readFile(f.session!,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(entries.filter(e=>e.type==='custom_message'&&e.customType===CHAT_RECALL_CUSTOM_TYPE).length,1);
  await f.run(batch(submission('self-recall-resumed',[human('10004')],[selfRecall])));assert.equal(f.requests.length,6);
  const recovered=await recoverContextReceipts(f.session!);
  assert.deepEqual(recovered.find(item=>item.batchId==='self-recall-resumed')!.recallEventIds,[selfRecall.eventId]);
  const noRecall=createPiTools(config,async()=>{});assert.equal(noRecall.some(tool=>tool.name==='recall_message'),false);
});

test('Pi appends initial recall facts after the original input and commits their durable IDs',async t=>{
  const original={...human(),recalled:true,recalledAt:100};
  const f=await fixture(t,(call,response,index)=>{
    if(index===1){const wire=text(call.body.messages);assert.match(wire,/The original request/);assert.match(wire,/message_recalled/);
      assert.ok(wire.indexOf('The original request')<wire.indexOf('message_recalled'));respond(call,response,[{name:'send_message',arguments:{messages:[{type:'text',text:'Another relevant reply.'}]}}]);}
    else respond(call,response,'Internal completion.');
  },{send:async()=>({accepted:true})});
  await f.run(batch(submission('recall-initial',[original],[recall])));
  const commits=f.events.filter(e=>e.type==='context.committed').map(e=>e.payload as unknown as ContextCommit);
  assert.equal(commits.length,1);assert.deepEqual(commits[0]!.recallEventIds,[recall.eventId]);
  const entries=(await readFile(f.session!,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  const user=entries.findIndex(e=>e.type==='message'&&e.message.role==='user');const event=entries.findIndex(e=>e.type==='custom_message');assert.ok(user<event);
  assert.equal(entries[event].customType,CHAT_RECALL_CUSTOM_TYPE);assert.equal(entries.filter(e=>e.type==='context_edit').length,0);
  const recovered=await recoverContextReceipts(f.session!);assert.deepEqual(recovered[0]!.recallEventIds,[recall.eventId]);
});

test('Pi delivers a live recall before the next provider request without starting another turn or rewriting history',async t=>{
  let notify:()=>void=()=>{};
  const f=await fixture(t,async(call,response,index)=>{
    if(index===1){assert.doesNotMatch(text(call.body.messages),/message_recalled/);notify();await new Promise(r=>setTimeout(r,20));
      respond(call,response,[{name:'send_message',arguments:{messages:[{type:'text',text:'An independent answer.'}]}}]);}
    else {assert.match(text(call.body.messages),/message_recalled/);respond(call,response,'Internal completion.');}
  },{send:async()=>({accepted:true})});
  notify=()=>{f.runner.notifyRecall(recall);f.runner.notifyRecall(recall);};
  await f.run(batch(submission('recall-live',[human()])));assert.equal(f.requests.length,2);
  const first=f.requests[0]!.messages.find((m:any)=>m.role==='user');assert.deepEqual(f.requests[1]!.messages.find((m:any)=>m.role==='user'),first);
  const entries=(await readFile(f.session!,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(entries.filter(e=>e.type==='custom_message'&&e.customType===CHAT_RECALL_CUSTOM_TYPE).length,1);
  assert.equal(entries.filter(e=>e.type==='context_edit').length,0);
});

test('append-only recall batches persist without invoking the model and replay idempotently',async t=>{
  const f=await fixture(t,()=>{assert.fail('An append must not invoke the model.');},{send:async()=>({accepted:true})});
  const input=batch(submission('recall-background',[{...human(),recalled:true,recalledAt:100}],[recall]),false);
  await f.run(input);await f.run(input);assert.equal(f.requests.length,0);
  const entries=(await readFile(f.session!,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(entries.filter(e=>e.type==='message'&&e.message.role==='user').length,1);
  assert.equal(entries.filter(e=>e.type==='custom_message').length,1);
  assert.deepEqual((await recoverContextReceipts(f.session!))[0]!.recallEventIds,[recall.eventId]);
});

test('recall commits acknowledge only status entries actually present on the current branch',async t=>{
  const root=await mkdtemp(join(tmpdir(),'pi-recall-receipt-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const manager=SessionManager.create(root,root);const current=human();const prepared=prepareContextInput(manager,{
    submission:submission('recall-commit',[current],[recall]),imageData:{}},['10001']);
  manager.appendMessage({role:'user',content:[{type:'text',text:prepared.prompt}],timestamp:1});
  assert.deepEqual(committedContext(manager,'recall-commit')!.recallEventIds,[]);
  assert.deepEqual((await recoverContextReceipts(manager.getSessionFile()!))[0]!.recallEventIds,[]);
  appendRecallEvents(manager,[recall,recall]);
  assert.deepEqual(committedContext(manager,'recall-commit')!.recallEventIds,[recall.eventId]);
  assert.deepEqual((await recoverContextReceipts(manager.getSessionFile()!))[0]!.recallEventIds,[recall.eventId]);
});

test('compaction does not make an already recorded recall append a second time',()=>{
  const manager=SessionManager.inMemory('/tmp');
  manager.appendMessage({role:'user',content:[{type:'text',text:'The original request.'}],timestamp:1});
  assert.deepEqual(appendRecallEvents(manager,[recall]),[recall.eventId]);
  const retained=manager.appendMessage({role:'user',content:[{type:'text',text:'A later message.'}],timestamp:2});
  manager.appendCompaction('The earlier request was recalled.',retained,100);
  assert.deepEqual(appendRecallEvents(manager,[recall]),[]);
  assert.equal(manager.getBranch().filter(entry=>entry.type==='custom_message'&&entry.customType===CHAT_RECALL_CUSTOM_TYPE).length,1);
});

test('a recall-only model turn succeeds without forcing an extra chat message',async t=>{
  let sends=0,recalls=0;
  const f=await fixture(t,(call,response,index)=>{
    if(index===1)respond(call,response,[{name:'recall_message',arguments:{messageRef:'reply_previous:0'}}]);
    else respond(call,response,'Internal completion.');
  },{send:async()=>{sends++;return {accepted:true};},recall:async request=>{
    recalls++;return {messageRef:request.messageRef,status:'recalled',parts:[{messageId:'10003',partIndex:0,status:'recalled'}]};
  }});
  await f.run(batch(submission('recall-only',[human('10004')])));
  assert.equal(sends,0);assert.equal(recalls,1);assert.equal(f.requests.length,2);
});
