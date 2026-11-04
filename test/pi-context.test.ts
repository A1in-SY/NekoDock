import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,rm,writeFile,copyFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {PiRunner,type PiRunnerOptions} from '../src/pi.js';
import {prepareContextInput,recoverContextReceipts} from '../src/pi-context.js';
import {CHECKPOINT_HEADINGS} from '../src/pi-compaction.js';
import type {ChatContextMessage,ContextCommit,ContextSubmission} from '../src/chat-context-contract.js';
import type {PendingBatch,RunObservation} from '../src/types.js';
import {decodeModelCall,respond,pngBase64,type ModelHandler} from './fixtures/pi-e2e.js';
import {assertModelImage,largeModelImage} from './fixtures/model-image.js';

const message=(id:string,revision=1):ChatContextMessage=>({chatMessageId:`in:${id}`,conversationId:'conversation-one',revision,
  messageId:id,senderId:'2001',senderName:'Example user',time:1,text:`Message ${id}`,replyTo:null,role:'user',origin:'human'});
const submission=(id:string,messages:ChatContextMessage[],extra:Partial<ContextSubmission>={}):ContextSubmission=>({batchId:id,
  conversationId:'conversation-one',messages,revisions:[],references:[],versions:messages.map(({chatMessageId,revision})=>({chatMessageId,revision})),...extra});
function input(context:ContextSubmission,replyAllowed=true):PendingBatch {
  return {throughSeq:1,messages:context.messages.filter(m=>m.origin==='human').map((m,index)=>({seq:index+1,messageId:m.messageId!,senderId:m.senderId,
    senderName:m.senderName,time:m.time,text:m.text,replyTo:m.replyTo,trigger:replyAllowed,rawJson:'{}'})),replyAllowed,replies:null,nextReplyIndex:0,context};
}
async function fixture(t:TestContext,overrides:Partial<PiRunnerOptions>={},handler?:ModelHandler) {
  const root=await mkdtemp(join(tmpdir(),'pi-context-'));const home=join(root,'pi'),workspace=join(root,'workspace');await mkdir(home);await mkdir(workspace);
  const requests:Record<string,any>[]=[];let fail=false;
  const server=createServer((req,res)=>{void(async()=>{
    let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text);requests.push(body);
    if(fail){res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'synthetic provider failure'}}));return;}
    const call=decodeModelCall(req.url!,undefined,body);
    const user=body.messages?.findLast((message:any)=>message.role==='user');
    try {
      const prompt=JSON.parse(typeof user?.content==='string'?user.content:user?.content?.find((part:any)=>part.type==='text')?.text);
      if(typeof prompt?.historicalConversation==='string'){
        respond(call,res,CHECKPOINT_HEADINGS.map(heading=>`## ${heading}\nVerified synthetic summary.`).join('\n\n'));return;
      }
    }catch{}
    if(handler){await handler(call,res,requests.length);return;}
    respond(call,res,call.results.length?'Internal completion.':[{name:'send_message',arguments:{messages:[{type:'text',text:'Example reply.'}]}}]);
  })().catch(error=>{res.writeHead(500);res.end(String(error));});});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert.ok(address&&typeof address!=='string');
  const events:RunObservation[]=[];let session:string|null=null;
  const runner=new PiRunner({home,workspace,model:'test-model',baseUrl:`http://127.0.0.1:${address.port}/v1`,api:'openai-completions',
    reasoning:'off',contextWindow:200000,compactLimit:160000,maxOutputTokens:1000,supportsImages:true,supportsReasoning:false,
    allowCommands:false,allowFileWrites:false,persona:'Example persona.',targetType:'group',timeoutMs:10000,logger:{info(){},warn(){},error(){}},...overrides});
  const toolIds:string[]=[];
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(root,{recursive:true,force:true});});
  return {home,workspace,requests,events,runner,toolIds,get session(){return session;},fail(value=true){fail=value;},
    run:(batch:PendingBatch)=>runner.run(batch,session,path=>{session=path;},new AbortController().signal,{send:async(_request,meta)=>{
      assert.ok(events.some(e=>e.type==='context.committed'),'The input must be durable before accepting a reply.');
      if(meta?.toolCallId)toolIds.push(meta.toolCallId);return {accepted:true};
    }},event=>events.push(event))};
}

function wireImages(value:unknown):string[] {
  if(typeof value==='string')return value.startsWith('data:image/')?[value]:[];
  if(Array.isArray(value))return value.flatMap(wireImages);
  if(value&&typeof value==='object')return Object.values(value).flatMap(wireImages);
  return [];
}

test('Pi context compresses a large incoming image before persisting or sending it',async t=>{
  const f=await fixture(t);const original=largeModelImage();const path=join(f.workspace,'large-image.png');await writeFile(path,original);
  const current={...message('current-image'),assets:[{id:'large-asset',type:'image' as const,status:'ready' as const,path}]};
  await f.run(input(submission('large-incoming',[current])));
  assert.equal(f.requests.length,2);
  for(const request of f.requests) {
    const images=wireImages(request);assert.equal(images.length,1);await assertModelImage(images[0]!);
  }
  const call=decodeModelCall('/v1/chat/completions',undefined,f.requests[0]!);
  assert.deepEqual(call.batch.map(m=>m.messageId),['current-image']);
  assert.equal((call.batch[0]!.assets as Array<{status:string}>)[0]!.status,'ready');
  assert.deepEqual(await readFile(path),original,'Compression must preserve the cached original image.');
});

test('Pi background image compression stays byte-stable through later conversation and tool requests',async t=>{
  const f=await fixture(t);const original=largeModelImage();const path=join(f.workspace,'background-image.png');await writeFile(path,original);
  const background={...message('background-image'),assets:[{id:'background-asset',type:'image' as const,status:'ready' as const,path}]};
  await f.run(input(submission('background-image-batch',[background]),false));assert.equal(f.requests.length,0);
  const entries=(await readFile(f.session!,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  const saved=entries.find(e=>e.type==='message'&&e.message.role==='user').message;
  const image=saved.content.find((b:any)=>b.type==='image');assert.ok(image);
  const persistedURL=`data:${image.mimeType};base64,${image.data}`;await assertModelImage(persistedURL);
  await f.run(input(submission('image-follow-up-one',[message('follow-one')])));
  await f.run(input(submission('image-follow-up-two',[message('follow-two')])));
  assert.equal(f.requests.length,4);
  const firstUser=f.requests[0]!.messages.find((m:any)=>m.role==='user');
  for(const request of f.requests) {
    assert.deepEqual(wireImages(request),[persistedURL],'Later requests must reuse the persisted compressed image without rewriting it.');
    assert.deepEqual(request.messages.find((m:any)=>m.role==='user'),firstUser,'Appending later turns must preserve the earlier user prefix.');
  }
  assert.deepEqual(await readFile(path),original);
});

test('Pi read-tool images use the same entry compression limits as chat attachments',async t=>{
  let imagePath='';
  const f=await fixture(t,{},(call,response,count)=>{
    if(count===1)respond(call,response,[{name:'read',arguments:{path:imagePath}}]);
    else if(count===2)respond(call,response,[{name:'send_message',arguments:{messages:[{type:'text',text:'Read the example image.'}]}}]);
    else respond(call,response,'Internal completion.');
  });
  const original=largeModelImage();imagePath=join(f.workspace,'read-image.png');await writeFile(imagePath,original);
  await f.run(input(submission('read-image-batch',[message('read-request')])));
  assert.equal(f.requests.length,3);
  assert.equal(wireImages(f.requests[0]!).length,0);
  for(const request of f.requests.slice(1)) {
    const images=wireImages(request);assert.equal(images.length,1);await assertModelImage(images[0]!);
  }
  assert.deepEqual(wireImages(f.requests[1]!),wireImages(f.requests[2]!),'The read result must remain stable for the next model call.');
  assert.ok(f.events.some(event=>event.type==='tool.completed'&&event.payload.tool==='read'&&event.payload.status==='completed'));
  assert.deepEqual(await readFile(imagePath),original);
});

test('Pi context acknowledges durable append and recovers it without invoking a model',async t=>{
  const f=await fixture(t);const context=submission('batch-one',[message('m1')]);
  await f.run(input(context,false));assert.equal(f.requests.length,0);
  const receipt=f.events.find(e=>e.type==='context.committed')!.payload as unknown as ContextCommit;
  assert.equal(receipt.batchId,'batch-one');assert.equal(receipt.versions[0]!.chatMessageId,'in:m1');assert.ok(receipt.hash);
  const recovered:ContextCommit[]=[];await f.runner.recoverContext(f.session!,value=>recovered.push(value));assert.deepEqual(recovered,[receipt]);
  await f.run(input(context,false));
  const saved=(await readFile(f.session!,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(saved.filter(e=>e.type==='message'&&e.message.role==='user').length,1,'An acknowledged batch is not appended twice.');
});

test('Pi provider failure retains the committed input and cannot replay its generation',async t=>{
  const f=await fixture(t);f.fail();const context=submission('failed-batch',[message('m1')]);
  await assert.rejects(f.run(input(context)),/PI_EXECUTION_FAILED/);assert.equal(f.requests.length,1);
  const committed=f.events.filter(e=>e.type==='context.committed');assert.equal(committed.length,1);
  const recovered=await recoverContextReceipts(f.session!);assert.equal(recovered[0]!.batchId,'failed-batch');
  await assert.rejects(f.run(input(context)),/ALREADY_COMMITTED/);assert.equal(f.requests.length,1);
});

test('Pi revisions update a pending image in its original entry and do not duplicate an active quote',async t=>{
  const f=await fixture(t);const pending={...message('image-one'),assets:[{id:'image-asset',type:'image' as const,status:'pending' as const}]};
  await f.run(input(submission('image-pending',[pending])));
  const first=f.events.find(e=>e.type==='context.committed')!.payload as unknown as ContextCommit;
  const path=join(f.workspace,'image.png');await writeFile(path,Buffer.from(pngBase64,'base64'));
  const ready={...pending,revision:2,assets:[{id:'image-asset',type:'image' as const,status:'ready' as const,path}]};
  const follow={...message('follow'),replyTo:'image-one'};
  await f.run(input(submission('image-ready',[follow],{revisions:[{message:ready,entryId:first.entryId}],references:[ready],
    versions:[{chatMessageId:ready.chatMessageId,revision:2},{chatMessageId:follow.chatMessageId,revision:1}]})));
  const call=decodeModelCall('/v1/chat/completions',undefined,f.requests[2]!);
  assert.equal(JSON.stringify(call.body.messages).match(/data:image\//g)?.length,1);
  assert.deepEqual(call.batch.map(m=>m.messageId),['follow'],'The already active image is revised, not repeated in the new user envelope.');
  const manager=SessionManager.open(f.session!);const old=manager.buildSessionProjection().entries.find(e=>e.sourceEntry.id===first.entryId)!;
  const original=old.messages[0]!;assert.equal(original.role,'user');
  const text=Array.isArray(original.content)?original.content.find(part=>part.type==='text'):undefined;
  assert.ok(text&&text.type==='text');assert.equal(JSON.parse(text.text).messages[0].images[0].status,'ready');
  assert.ok(manager.getBranch().some(e=>e.type==='context_edit'));
  assert.ok(f.toolIds.length>=2,'Actual SDK tool-call identifiers cross the Worker IPC.');
});

test('Pi summarized source revisions become historical material rather than ineffective edits',()=>{
  const manager=SessionManager.inMemory('/tmp');const source=message('old');
  const old=manager.appendMessage({role:'user',content:[{type:'text',text:JSON.stringify({messages:[source],replyTargetMessageIds:[]})}],timestamp:1});
  const keep=manager.appendMessage({role:'user',content:[{type:'text',text:'Keep this recent message.'}],timestamp:2});
  manager.appendCompaction('Earlier messages were summarized.',keep,100);
  const updated={...source,revision:2,text:'Late verified contents.'};const now=message('now');
  const prepared=prepareContextInput(manager,{submission:submission('after-summary',[now],{revisions:[{message:updated,entryId:old}],references:[updated],
    versions:[{chatMessageId:updated.chatMessageId,revision:2},{chatMessageId:now.chatMessageId,revision:1}]}),imageData:{}},['now']);
  const envelope=JSON.parse(prepared.prompt);assert.equal(envelope.messages.length,2);
  assert.equal(envelope.messages.find((m:any)=>m.messageId==='old').historical,true);assert.deepEqual(envelope.replyTargetMessageIds,['now']);
  assert.equal(manager.getBranch().filter(e=>e.type==='context_edit').length,0);
});

test('Pi records real QQ delivery IDs in the existing tool result without adding a duplicate reply',()=>{
  const manager=SessionManager.inMemory('/tmp');
  const tool=manager.appendMessage({role:'toolResult',toolCallId:'call-one',toolName:'send_message',content:[{type:'text',text:'{"accepted":true}'}],isError:false,timestamp:1});
  const receipt={...message('901001'),chatMessageId:'out:one',role:'assistant' as const,origin:'model' as const,toolCallId:'call-one',logicalMessageIndex:0,partIndex:0,text:'Already in tool-call arguments.'};
  const current=message('current');
  const prepared=prepareContextInput(manager,{submission:submission('delivery-mapping',[current],{receipts:[receipt],references:[receipt],
    versions:[{chatMessageId:receipt.chatMessageId,revision:1},{chatMessageId:current.chatMessageId,revision:1}]}),imageData:{}},['current']);
  assert.deepEqual(JSON.parse(prepared.prompt).messages.map((m:any)=>m.messageId),['current']);
  const projected=manager.buildSessionProjection().entries.find(e=>e.sourceEntry.id===tool)!;
  assert.match(JSON.stringify(projected.messages),/901001/);assert.doesNotMatch(JSON.stringify(projected.messages),/Already in tool-call arguments/);
});

test('Pi resumed provider input associates a real quoted QQ message with the original reply once',async t=>{
  const f=await fixture(t);await f.run(input(submission('ordinary-one',[message('m1')])));
  const sent={...message('901001'),chatMessageId:'out:one',role:'assistant' as const,origin:'model' as const,
    toolCallId:f.toolIds[0],logicalMessageIndex:0,partIndex:0,text:'Example reply.'};
  const quote={...message('m2'),replyTo:'901001'};
  await f.run(input(submission('ordinary-two',[quote],{receipts:[sent],references:[sent],
    versions:[{chatMessageId:quote.chatMessageId,revision:1},{chatMessageId:sent.chatMessageId,revision:1}]})));
  const wire=f.requests[2]!;const call=decodeModelCall('/v1/chat/completions',undefined,wire);
  assert.deepEqual(call.batch.map(m=>m.messageId),['m2']);
  assert.match(JSON.stringify(wire.messages.filter((m:any)=>m.role==='tool')),/901001/);
  assert.equal(JSON.stringify(wire.messages).match(/Example reply\./g)?.length,1);
  assert.doesNotMatch(JSON.stringify(wire.messages),/contextBatch|ordinary-one|ordinary-two/);
  const saved=await readFile(f.session!,'utf8');assert.match(saved,/contextBatch/);
  const first=f.requests[0]!.messages.find((m:any)=>m.role==='user').content;
  const preserved=wire.messages.find((m:any)=>m.role==='user').content;
  assert.deepEqual(preserved,first,'Only necessary receipt edits change history; the preceding user provider prefix stays stable.');
});

test('Pi confirmed scheduled image snapshots enter the unified message stream with their real bytes',async t=>{
  const f=await fixture(t);const bytes=Buffer.from(pngBase64,'base64');
  const media=join(f.workspace,'..','console-media');await mkdir(media);
  const path=join(media,createHash('sha256').update(bytes).digest('hex')+'.png');await writeFile(path,bytes);
  const sent={...message('901002'),chatMessageId:'scheduled:one',role:'assistant' as const,origin:'scheduled' as const,text:'[image]',
    assets:[{id:'scheduled-image',type:'image' as const,status:'ready' as const,path}]};
  await f.run(input(submission('scheduled-image',[sent,message('current')])));
  const call=decodeModelCall('/v1/chat/completions',undefined,f.requests[0]!);
  assert.equal(call.images.length,1);assert.equal(call.batch[0]!.messageId,'901002');assert.equal(call.batch[0]!.origin,'scheduled');
  assert.equal('externalEvents' in JSON.parse((f.requests[0]!.messages.findLast((m:any)=>m.role==='user')).content[0].text),false);
});

test('Pi invalid image contents do not lose the durable input acknowledgement',async t=>{
  const f=await fixture(t);const path=join(f.workspace,'invalid.png');await writeFile(path,'not an image');
  const current={...message('current'),assets:[{id:'invalid-image',type:'image' as const,status:'ready' as const,path}]};
  await f.run(input(submission('image-omission',[current])));
  assert.ok(f.events.some(event=>event.type==='context.committed'));
  const recovered=await recoverContextReceipts(f.session!);assert.equal(recovered[0]!.batchId,'image-omission');
});

test('Pi revisions preserve other messages and earlier target lists in the same input entry',()=>{
  const manager=SessionManager.inMemory('/tmp');const a=message('a'),b=message('b');
  const old=manager.appendMessage({role:'user',content:[{type:'text',text:JSON.stringify({messages:[a,b],replyTargetMessageIds:['a']})}],timestamp:1});
  const changed={...b,revision:2,text:'Verified updated contents.'};
  prepareContextInput(manager,{submission:submission('update-b',[message('now')],{revisions:[{message:changed,entryId:old}]}),imageData:{}},['now']);
  const projected=manager.buildSessionProjection().entries.find(e=>e.sourceEntry.id===old)!.messages[0]!;
  assert.equal(projected.role,'user');const block=Array.isArray(projected.content)?projected.content.find(p=>p.type==='text'):undefined;
  assert.ok(block&&block.type==='text');const envelope=JSON.parse(block.text);
  assert.deepEqual(envelope.messages[0],a);assert.equal(envelope.messages[1].text,changed.text);assert.deepEqual(envelope.replyTargetMessageIds,['a']);
});

test('Pi recovery reads the active branch and tolerates provider input notices and a torn trailing line',async t=>{
  const root=await mkdtemp(join(tmpdir(),'pi-context-recovery-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,'session.jsonl');
  const entry=(id:string,batchId:string)=>({type:'message',id,parentId:'root',message:{role:'user',content:[{type:'text',text:JSON.stringify({messages:[],
    contextBatch:{batchId,conversationId:'conversation-one',versions:[],entries:[]},replyTargetMessageIds:[]})+'\n\n[Image omitted: unavailable.]'}]}});
  await writeFile(path,[JSON.stringify({type:'session',id:'synthetic-session',version:3}),JSON.stringify({type:'model_change',id:'root',parentId:null}),JSON.stringify(entry('a','other-branch')),
    JSON.stringify(entry('b','active-branch')),'{"type":"message"'].join('\n'));
  const receipts=await recoverContextReceipts(path);assert.deepEqual(receipts.map(r=>r.batchId),['active-branch']);
});

test('Pi quoting an already acknowledged model image adds its bytes to the existing tool result',()=>{
  const manager=SessionManager.inMemory('/tmp');const imagePath='/tmp/example.png';
  const sent={...message('901005'),chatMessageId:'out:image',role:'assistant' as const,origin:'model' as const,toolCallId:'call-image',
    assets:[{id:'image',type:'image' as const,status:'ready' as const,path:imagePath}]};
  const tool=manager.appendMessage({role:'toolResult',toolCallId:'call-image',toolName:'send_message',content:[{type:'text',text:JSON.stringify({accepted:true,
    deliveredMessages:[{chatMessageId:sent.chatMessageId,revision:1,messageId:'901005',assets:sent.assets}]})}],isError:false,timestamp:1});
  const prepared=prepareContextInput(manager,{submission:submission('quoted-image',[message('now')],{references:[sent]}),
    imageData:{[imagePath]:{type:'image',data:pngBase64,mimeType:'image/png'}}},['now']);
  assert.equal(JSON.parse(prepared.prompt).messages.length,1);
  const projected=manager.buildSessionProjection().entries.find(e=>e.sourceEntry.id===tool)!.messages[0]!;
  assert.ok(projected.role==='toolResult');
  assert.equal(projected.content.filter(block=>block.type==='image').length,1);
});

test('Pi transient recall precedes internal metadata removal and never becomes durable chat',async t=>{
  const f=await fixture(t,{recall:async()=>({items:[{content:'Synthetic remembered preference.'}]})});
  await f.run(input(submission('remembered-batch',[message('current')])));
  assert.equal(f.requests.length,2);
  for(const request of f.requests) {
    assert.match(JSON.stringify(request.messages),/Synthetic remembered preference/);
    assert.doesNotMatch(JSON.stringify(request.messages),/contextBatch|remembered-batch/);
  }
  const stored=await readFile(f.session!,'utf8');assert.doesNotMatch(stored,/Synthetic remembered preference/);assert.match(stored,/remembered-batch/);
});

test('Pi compaction reads real chat while hiding durable input submission metadata',async t=>{
  const f=await fixture(t,{keepRecentTokens:1});
  await f.run(input(submission('summary-hidden-one',[message('older')]),false));
  await f.run(input(submission('summary-hidden-two',[message('recent')]),false));
  await f.run(input(submission('summary-hidden-three',[message('now')])));
  await f.runner.compact(f.session!,new AbortController().signal,event=>f.events.push(event));
  const wire=f.requests.at(-1)!;assert.doesNotMatch(JSON.stringify(wire.messages),/contextBatch|summary-hidden-/);
  assert.match(JSON.stringify(wire.messages),/Message older/);
  assert.ok(f.events.some(event=>event.type==='compact.completed'));
  assert.match(await readFile(f.session!,'utf8'),/summary-hidden-one/);
});

test('Pi legacy chat enrichment replaces a unique real QQ source rather than appending it again',()=>{
  const manager=SessionManager.inMemory('/tmp');
  const original={messageId:'10001',senderId:'2001',senderName:'Example user',time:1,text:'[JSON card]',replyTo:null};
  const old=manager.appendMessage({role:'user',content:[{type:'text',text:JSON.stringify({messages:[original],replyTargetMessageIds:[]})}],timestamp:1});
  const enriched={...message('10001',2),text:'Verified video title.',contents:[{type:'video',title:'Verified video title.'}]};
  const next=message('current');
  const prepared=prepareContextInput(manager,{submission:submission('legacy-enrichment',[enriched,next]),imageData:{}},['current']);
  assert.deepEqual(JSON.parse(prepared.prompt).messages.map((m:any)=>m.messageId),['current']);
  const projected=manager.buildSessionProjection().entries.find(e=>e.sourceEntry.id===old)!.messages[0]!;
  assert.ok(projected.role==='user'&&Array.isArray(projected.content));const block=projected.content.find(p=>p.type==='text');assert.ok(block&&block.type==='text');
  assert.equal(JSON.parse(block.text).messages[0].text,'Verified video title.');
  assert.ok(prepared.marker.entries.some(entry=>entry.chatMessageId===enriched.chatMessageId&&entry.entryId===old));
});

test('Pi recovers a first persisted input when both session-path and commit IPC were lost',async t=>{
  const f=await fixture(t);const first=submission('first-lost-ipc',[message('older')]);
  // Discard both parent callbacks, reproducing the persistent state after a parent
  // failure between the child fsync and receipt processing.
  await f.runner.run(input(first,false),null,()=>{},new AbortController().signal);
  assert.equal(f.requests.length,0);assert.equal(f.session,null);
  // An unrelated, newer session must never win merely because of its timestamp.
  await f.runner.run(input(submission('unrelated',[message('other')]),false),null,()=>{},new AbortController().signal);
  const commits:ContextCommit[]=[];
  await f.runner.recoverContext(null,receipt=>commits.push(receipt),['first-lost-ipc']);
  assert.equal(commits.length,1);assert.equal(commits[0]!.batchId,'first-lost-ipc');
  let toolCalls=0;
  await f.runner.run(input(submission('next-current',[message('current')])),commits[0]!.session,()=>{},new AbortController().signal,
    {send:async()=>{toolCalls++;return {accepted:true};}});
  assert.equal(toolCalls,1);assert.equal(f.requests.length,2);
  const wire=f.requests[0]!;
  const envelopes=wire.messages.filter((m:any)=>m.role==='user').map((m:any)=>JSON.parse(typeof m.content==='string'?m.content:m.content.find((p:any)=>p.type==='text').text));
  assert.deepEqual(envelopes.map((p:any)=>p.messages.map((m:any)=>m.messageId)),[['older'],['current']]);
  assert.deepEqual(envelopes.map((p:any)=>p.replyTargetMessageIds),[[],['current']]);
  assert.doesNotMatch(JSON.stringify(wire.messages),/Message other/);
});

test('Pi missing-path recovery rejects ambiguous exact batch matches without adopting a session',async t=>{
  const f=await fixture(t);await f.runner.run(input(submission('ambiguous',[message('older')]),false),null,()=>{},new AbortController().signal);
  const recovered:ContextCommit[]=[];await f.runner.recoverContext(null,receipt=>recovered.push(receipt),['ambiguous']);assert.equal(recovered.length,1);
  const source=await readFile(recovered[0]!.session,'utf8');
  await writeFile(join(f.home,'sessions','not-a-session.jsonl'),source.split('\n').filter(line=>line.includes('"role":"user"')).join('\n'));
  const valid:ContextCommit[]=[];await f.runner.recoverContext(null,receipt=>valid.push(receipt),['ambiguous']);assert.equal(valid.length,1,'Matching text without a valid session header is not a candidate.');
  await copyFile(recovered[0]!.session,join(f.home,'sessions','duplicate.jsonl'));
  let callbacks=0;
  await assert.rejects(f.runner.recoverContext(null,()=>{callbacks++;},['ambiguous']),/PI_CONTEXT_RECOVERY_AMBIGUOUS/);
  assert.equal(callbacks,0);assert.equal(f.requests.length,0);
  await f.runner.recoverContext(null,()=>{callbacks++;});assert.equal(callbacks,0,'No staged identity means no discovery.');
});

test('Pi first-round failure with lost path IPC is recovered as history without replaying its target',async t=>{
  const f=await fixture(t);f.fail();const first=submission('first-failed-lost-ipc',[message('failed-target')]);
  await assert.rejects(f.runner.run(input(first),null,()=>{},new AbortController().signal),/PI_EXECUTION_FAILED/);
  assert.equal(f.requests.length,1);assert.equal(f.session,null);f.fail(false);
  const commits:ContextCommit[]=[];await f.runner.recoverContext(null,receipt=>commits.push(receipt),[first.batchId]);assert.equal(commits.length,1);
  let sends=0;await f.runner.run(input(submission('fresh-target',[message('current')])),commits[0]!.session,()=>{},new AbortController().signal,
    {send:async()=>{sends++;return {accepted:true};}});
  assert.equal(f.requests.length,3);assert.equal(sends,1);
  const call=decodeModelCall('/v1/chat/completions',undefined,f.requests[1]!);assert.deepEqual(call.replyTargetMessageIds,['current']);
  const users=f.requests[1]!.messages.filter((m:any)=>m.role==='user').map((m:any)=>JSON.parse(typeof m.content==='string'?m.content:m.content.find((p:any)=>p.type==='text').text));
  assert.deepEqual(users.map((p:any)=>p.messages.map((m:any)=>m.messageId)),[['failed-target'],['current']]);
});
