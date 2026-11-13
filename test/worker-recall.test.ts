import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {test,type TestContext} from 'node:test';
import {BridgeStore} from '../src/store.js';
import {Processor} from '../src/processor.js';
import {ReplyToolError} from '../src/reply-contract.js';
import type {AgentRunner,IncomingMessage,MessageSender,OutgoingDeliveryMetadata,RecallToolReceipt} from '../src/types.js';

const incoming=(id:string,text='question',trigger=true):IncomingMessage=>({messageId:id,senderId:'2001',senderName:'Alice',time:100,
  text,replyTo:null,trigger,rawJson:'{}'});
const recall=(id:string)=>({eventId:`recall:${id}`,messageId:id,time:120,operatorId:'2001',authorId:'2001'});
const logger={info(){},warn(){},error(){}};
async function until(check:()=>boolean){const end=Date.now()+3000;while(!check()){assert.ok(Date.now()<end,'worker did not finish');await delay(5);}}
function fixture(t:TestContext){
  const directory=mkdtempSync(join(tmpdir(),'worker-recall-')),path=join(directory,'bridge.sqlite3');
  const store=new BridgeStore(path,{type:'group',id:'1001'}),controller=new AbortController();let running:Promise<void>|undefined,agentFailure:unknown;
  const releases:Array<()=>void>=[];
  t.after(async()=>{controller.abort();releases.forEach(release=>release());try{await running;assert.equal(agentFailure,undefined,'agent assertions must not be swallowed by Processor');}
    finally{store.close();rmSync(directory,{recursive:true,force:true});}});
  return {store,path,gate(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});releases.push(release);return {promise,release};},
    start(agent:AgentRunner,sender:Partial<MessageSender>={},options:Partial<ConstructorParameters<typeof Processor>[0]>={}){
      const unexpected=async()=>{throw new Error('Unexpected send');};
      const wrapped:AgentRunner={...agent,async run(...args){try{return await agent.run(...args);}catch(error){agentFailure=error;throw error;}}};
      const processor=new Processor({store,agent:wrapped,sender:{sendText:unexpected,sendImage:unexpected,sendMessage:unexpected,...sender},logger,
        batchSize:50,replyMaxChars:1500,retryMs:1,workspace:directory,imageMaxBytes:1024,imageTimeoutMs:1000,...options});
      running=processor.run(controller.signal);return processor;
    }};
}

test('recall preserves original content and trigger while staging a separate durable event',t=>{
  const {store}=fixture(t);store.insert(incoming('1','original'));store.setSessionId('session');
  const batch=store.openOrCreateBatch(50)!,first=store.prepareContext(batch);
  store.commitContext({batchId:first.batchId,conversationId:first.conversationId,session:'session',entryId:'entry',versions:first.versions});
  assert.equal(store.applyRecall(recall('1')),true);assert.equal(store.applyRecall({...recall('1'),eventId:'duplicate-notice'}),false);
  assert.equal(store.getMessage('1')!.trigger,true);assert.equal(store.chatMessageForQQ('1')!.text,'original');
  assert.equal(store.chatMessageForQQ('1')!.revision,1);assert.equal(store.chatMessageForQQ('1')!.recalled,true);
  const next=store.prepareContext(batch);assert.deepEqual(next.recalls,[recall('1')]);assert.deepEqual(next.revisions,[]);
  assert.equal(store.recorder.pending(100).filter(event=>event.type==='message.recalled').length,1);
  assert.throws(()=>store.commitContext({batchId:next.batchId,conversationId:next.conversationId,session:'session',entryId:'next',versions:next.versions,recallEventIds:['forged']}),/staged recall/);
  store.commitContext({batchId:next.batchId,conversationId:next.conversationId,session:'session',entryId:'next',versions:next.versions,recallEventIds:[recall('1').eventId]});
  assert.equal(store.prepareContext(batch).recalls,undefined);
});

test('a recall received before the source keeps original text and is appended after its first input',t=>{
  const {store}=fixture(t);store.applyRecall(recall('later'));store.insert(incoming('later','late original'));
  const plan=store.prepareContext(store.openOrCreateBatch(50)!);
  assert.equal(plan.messages[0]!.text,'late original');assert.equal(plan.messages[0]!.recalled,true);
  assert.deepEqual(plan.recalls,[recall('later')]);
  const task=store.readTaskChat(0,200000,true,50);assert.equal(task.messages[0]!.recalled,true);assert.equal(task.messages[0]!.text,'late original');
});

test('future unprocessed recalls do not precede their original input in a bounded batch',t=>{
  const {store}=fixture(t);store.insert(incoming('1'));store.insert(incoming('2','future'));store.applyRecall(recall('2'));
  const first=store.prepareContext(store.openOrCreateBatch(1)!);assert.equal(first.recalls,undefined);assert.deepEqual(first.messages.map(message=>message.messageId),['1']);
});

test('bounded external history defers a recall until its source content is supplied',t=>{
  const {store}=fixture(t);store.insert(incoming('1'));store.setSessionId('session');
  for(let index=0;index<105;index++)store.recordTaskReply(`scheduled-${index}`,`scheduled content ${index}`,'task',store.recorder.conversationId,`qq-${index}`);
  store.applyRecall(recall('qq-104'));const batch=store.openOrCreateBatch(50)!;
  const first=store.prepareContext(batch);assert.equal(first.messages.some(message=>message.messageId==='qq-104'),false);assert.equal(first.recalls,undefined);
  store.commitContext({batchId:first.batchId,conversationId:first.conversationId,session:'session',entryId:'page-one',versions:first.versions});
  const next=store.prepareContext(batch);assert.equal(next.messages.some(message=>message.messageId==='qq-104'),true);assert.deepEqual(next.recalls,[recall('qq-104')]);
});

test('new conversation moves queued originals and their recall events together',t=>{
  const {store}=fixture(t);store.insert({...incoming('reset'),command:'new'});store.applyRecall(recall('after'));store.insert(incoming('after','after reset'));
  const command=store.getPendingCommand()!;store.resetSessionForCommand(command.id);store.acknowledgeCommand(command.id);
  const plan=store.prepareContext(store.openOrCreateBatch(50)!);assert.deepEqual(plan.recalls,[recall('after')]);assert.equal(plan.messages[0]!.recalled,true);
});

test('logical references, quote targets and sent parts survive batch cleanup and restart',t=>{
  const f=fixture(t),store=f.store;store.insert(incoming('1'));const batch=store.openOrCreateBatch(50)!;
  store.appendReplyRequest(batch.throughSeq,'request',[{type:'text',text:'abcdef',replyTo:'1'}],['abc','def'],[0,0],'tool');
  const [ref]=store.replyLedger.references('request');assert.ok(ref);
  store.beginReplyAttempt(1,0);store.acknowledgeReply(1,0,'qq-a');store.beginReplyAttempt(1,1);store.acknowledgeReply(1,1,'qq-b');
  store.finishGeneration(1);store.completeBatch(1);
  assert.equal(store.chatMessageForQQ('qq-a')!.replyTo,'1');assert.equal(store.chatMessageForQQ('qq-b')!.replyTo,null);
  store.close();const reopened=new BridgeStore(f.path,{type:'group',id:'1001'});t.after(()=>reopened.close());
  assert.deepEqual(reopened.replyLedger.parts(ref).map(part=>[part.messageId,part.replyTo,part.firstPart]),[['qq-a','1',true],['qq-b','1',false]]);
  assert.equal(reopened.listReplyRequests(1).length,0);
});

test('quoted replies keep text and attach the quote only to the first physical part',async t=>{
  const f=fixture(t);f.store.insert(incoming('1'));let calls=0,draws=0;const sent:Array<{text:string;quote?:string;metadata?:OutgoingDeliveryMetadata}>=[];
  f.start({async run(_batch,_session,_onSession,_signal,tools){calls++;await tools!.send({messages:[{type:'text',text:'abcdef',replyTo:'1'},{type:'text',text:'XYZ'}]});return {messages:[]};}},
    {async sendText(text,_signal,quote,metadata){sent.push({text,quote,metadata});return {messageId:`qq-${sent.length}`};}},
    {replyMaxChars:3,voiceReplyEnabled:true,voiceReplyProbability:1,random(){draws++;return 0;},speech:{name:'mock',async synthesize(){throw new Error('ordinary voice fallback');}}});
  await until(()=>f.store.getCursor()===1);assert.equal(calls,1);assert.equal(draws,0);
  assert.deepEqual(sent.map(item=>[item.text,item.quote]),[['abc','1'],['def',undefined],['XYZ',undefined]]);
  assert.equal(sent[0]!.metadata!.messageRef,sent[1]!.metadata!.messageRef);assert.notEqual(sent[1]!.metadata!.messageRef,sent[2]!.metadata!.messageRef);
  const accepted=f.store.recorder.pending(100).find(event=>event.type==='reply.accepted')!;assert.deepEqual(accepted.payload.partCounts,[2,1]);
});

test('invalid quote atomically rejects the entire tool request and can be corrected in the same run',async t=>{
  const f=fixture(t);f.store.insert(incoming('1'));const sent:string[]=[];let checked=false;
  f.start({async run(_batch,_session,_onSession,_signal,tools){
    await assert.rejects(tools!.send({messages:[{type:'text',text:'must not leak'},{type:'text',text:'bad',replyTo:'missing'}]}),error=>error instanceof ReplyToolError&&error.code==='QUOTE_TARGET_UNKNOWN'&&error.messageIndex===1);
    assert.equal(f.store.listReplyRequests(1).length,0);checked=true;
    await tools!.send({messages:[{type:'text',text:'corrected',replyTo:'1'}]});return {messages:[]};
  }},{async sendText(text){sent.push(text);return {messageId:'qq'};}});
  await until(()=>f.store.getCursor()===1);assert.equal(checked,true);assert.deepEqual(sent,['corrected']);
});

test('Console validation errors identify the logical message and do not accept any sends',async t=>{
  const f=fixture(t);f.store.insert(incoming('1'));let checked=false;
  f.start({async run(_batch,_session,_onSession,_signal,tools){
    await assert.rejects(tools!.send({messages:[{type:'text',text:'plain'},{type:'text',text:'quoted',replyTo:'1'}]}),error=>error instanceof ReplyToolError&&error.code==='QUOTE_TARGET_RECALLED'&&error.messageIndex===1);
    checked=true;return {messages:[]};
  }},{async validateReplyTargets(ids){assert.deepEqual(ids,['1']);throw Object.assign(new Error('recalled'),{code:'QUOTE_TARGET_RECALLED',messageId:'1'});}});
  await until(()=>f.store.getCursor()===1);assert.equal(checked,true);assert.equal(f.store.recorder.pending(100).some(event=>event.type==='reply.accepted'),false);
});

test('a recall while Console preflight waits is rejected before durable acceptance',async t=>{
  const f=fixture(t),validation=f.gate();f.store.insert(incoming('1'));let checking=false,rejected=false;
  f.start({async run(_batch,_session,_onSession,_signal,tools){
    const pending=tools!.send({messages:[{type:'text',text:'quoted',replyTo:'1'}]});await until(()=>checking);
    f.store.applyRecall(recall('1'));validation.release();
    await assert.rejects(pending,error=>error instanceof ReplyToolError&&error.code==='QUOTE_TARGET_RECALLED');rejected=true;
    return {messages:[]};
  }},{async validateReplyTargets(){checking=true;await validation.promise;}});
  await until(()=>f.store.getCursor()===1);assert.equal(rejected,true);assert.equal(f.store.recorder.pending(100).some(event=>event.type==='reply.accepted'),false);
});

test('a late quote rejection stops its remaining parts and preserves other logical replies',async t=>{
  const f=fixture(t);f.store.insert(incoming('1'));const attempted:string[]=[];
  f.start({async run(_batch,_session,_onSession,_signal,tools){await tools!.send({messages:[{type:'text',text:'abcdef',replyTo:'1'},{type:'text',text:'XYZ'}]});return {messages:[]};}},
    {async sendText(text){attempted.push(text);if(text==='abc')throw Object.assign(new Error('recalled'),{code:'QUOTE_TARGET_RECALLED',deliveryStatus:'failed'});return {messageId:'other'};}},{replyMaxChars:3});
  await until(()=>f.store.getCursor()===1);assert.deepEqual(attempted,['abc','XYZ']);
  const failures=f.store.recorder.pending(100).filter(event=>event.type==='delivery.failed');assert.equal(failures.length,2);
});

test('recall waits for the active ACK, cancels remaining parts, and does not cancel another reply',async t=>{
  const f=fixture(t),ack=f.gate();f.store.insert(incoming('1'));const sent:string[]=[];let result:RecallToolReceipt|undefined,recallCalls=0;
  f.start({async run(_batch,_session,_onSession,_signal,tools){
    const accepted=await tools!.send({messages:[{type:'text',text:'abcdef'},{type:'text',text:'XYZ'}]});
    await until(()=>sent.length===1);const pending=tools!.recall!({messageRef:accepted.messages![0]!.messageRef},{operationId:'recall-once'});ack.release();result=await pending;
    assert.deepEqual(await tools!.recall!({messageRef:accepted.messages![0]!.messageRef},{operationId:'recall-once'}),result);return {messages:[]};
  }},{async sendText(text){sent.push(text);if(text==='abc')await ack.promise;return {messageId:`qq-${text}`};},async recallMessage(messageRef){recallCalls++;return {messageRef,status:'recalled',parts:[{messageId:'qq-abc',partIndex:0,status:'recalled'}],events:[recall('qq-abc')]};}},{replyMaxChars:3,replyReceiptWaitMs:20});
  await until(()=>f.store.getCursor()===1);assert.deepEqual(sent,['abc','XYZ']);assert.equal(recallCalls,1);assert.equal(result!.cancelledParts,1);assert.equal(result!.status,'recalled');
  assert.equal(f.store.chatMessageForQQ('qq-abc')!.recalled,true);assert.equal(f.store.recorder.pending(100).filter(event=>event.type==='delivery.cancelled').length,1);
  const event=f.store.recorder.pending(100).find(event=>event.type==='message.recalled')!;
  assert.equal(typeof event.payload.requestId,'string');assert.equal(typeof event.payload.messageRef,'string');
  assert.equal(event.payload.logicalPartCount,2);assert.equal(event.payload.logicalRecallCount,1);assert.equal(event.payload.logicalCancelledCount,1);
});

test('cancelling during preparation does not send the prepared voice or call remote recall',async t=>{
  const f=fixture(t),synthesis=f.gate();f.store.insert(incoming('1'));let preparing=false,calls=0,result:RecallToolReceipt|undefined;
  f.start({async run(_batch,_session,_onSession,_signal,tools){
    const receipt=await tools!.send({messages:[{type:'text',text:'voice'}]});await until(()=>preparing);
    const pending=tools!.recall!({messageRef:receipt.messages![0]!.messageRef});synthesis.release();result=await pending;return {messages:[]};
  }},{async sendVoice(){calls++;},async recallMessage(){throw new Error('Must not recall an unsent voice');}},{voiceReplyEnabled:true,voiceReplyProbability:1,replyReceiptWaitMs:20,
    speech:{name:'mock',async synthesize(){preparing=true;await synthesis.promise;return {file:`base64://${Buffer.from([0xff,0xfb,0x90,0x64]).toString('base64')}`};}}});
  await until(()=>f.store.getCursor()===1);assert.equal(calls,0);assert.equal(result!.status,'cancelled');assert.equal(result!.cancelledParts,1);
});

test('recalling one reply does not wait for unrelated voice preparation',async t=>{
  const f=fixture(t),synthesis=f.gate();f.store.insert(incoming('1'));let preparing=false,recalled=false;
  f.start({async run(_batch,_session,_onSession,_signal,tools){
    const receipt=await tools!.send({messages:[{type:'text',text:'A',replyTo:'1'},{type:'text',text:'B'}]});await until(()=>preparing);
    const result=await tools!.recall!({messageRef:receipt.messages![0]!.messageRef});assert.equal(result.status,'recalled');assert.equal(recalled,true);
    synthesis.release();return {messages:[]};
  }},{async sendText(){return {messageId:'qq-a'};},async sendVoice(){return {messageId:'qq-b'};},
    async recallMessage(messageRef){recalled=true;return {messageRef,status:'recalled',parts:[{messageId:'qq-a',partIndex:0,status:'recalled'}],events:[recall('qq-a')]};}},
    {voiceReplyEnabled:true,voiceReplyProbability:1,replyReceiptWaitMs:20,speech:{name:'mock',async synthesize(){preparing=true;await synthesis.promise;return {file:`base64://${Buffer.from([0xff,0xfb,0x90,0x64]).toString('base64')}`};}}});
  await until(()=>f.store.getCursor()===1);assert.equal(recalled,true);
});

test('a later turn recalls a persisted model reply and an unconfirmed result does not claim success',async t=>{
  const f=fixture(t);f.store.insert(incoming('1'));let ref='',calls=0,result:RecallToolReceipt|undefined;
  const processor=f.start({async run(batch,_session,_onSession,_signal,tools){
    if(batch.throughSeq===1)ref=(await tools!.send({messages:[{type:'text',text:'first'}]})).messages![0]!.messageRef;
    else result=await tools!.recall!({messageRef:ref},{operationId:'lost-result'});return {messages:[]};
  }},{async sendText(){calls++;return {messageId:'qq-first'};},async recallMessage(messageRef){return {messageRef,status:'unconfirmed',parts:[{messageId:'qq-first',partIndex:0,status:'unconfirmed',code:'RECALL_TIMEOUT'}]};}});
  await until(()=>f.store.getCursor()===1);f.store.insert(incoming('2'));processor.notify();await until(()=>f.store.getCursor()===2);
  assert.equal(calls,1);assert.equal(result!.status,'unconfirmed');assert.equal(f.store.chatMessageForQQ('qq-first')!.recalled,undefined);
});

test('recall notice preceding the model ACK remains authoritative in the durable ledger',t=>{
  const {store}=fixture(t);store.insert(incoming('1'));store.openOrCreateBatch(50);store.appendReplyRequest(1,'r',[{type:'text',text:'sent'}],['sent'],[0],'tool');
  store.beginReplyAttempt(1,0);store.applyRecall(recall('qq'));store.acknowledgeReply(1,0,'qq');
  assert.equal(store.replyLedger.part(1,0)!.state,'recalled');assert.equal(store.chatMessageForQQ('qq')!.recalled,true);
});

test('one recall per agent run rejects later attempts before side effects, preserves replay, and resets next run',async t=>{
  const f=fixture(t),ack=f.gate();f.store.insert(incoming('1'));const sent:string[]=[];let secondRef='',recalls=0,checked=false;
  const processor=f.start({async run(batch,_session,_onSession,_signal,tools){
    if(batch.throughSeq===1) {
      await assert.rejects(tools!.recall!({messageRef:'unknown'},{operationId:'invalid'}),error=>error instanceof ReplyToolError&&error.code==='RECALL_TARGET_UNKNOWN');
      const first=(await tools!.send({messages:[{type:'text',text:'first'}]})).messages![0]!.messageRef;
      await until(()=>sent.includes('first'));
      const result=await tools!.recall!({messageRef:first},{operationId:'first-recall'});
      secondRef=(await tools!.send({messages:[{type:'text',text:'second'}]})).messages![0]!.messageRef;
      await until(()=>sent.includes('second'));
      await assert.rejects(tools!.recall!({messageRef:secondRef},{operationId:'second-recall'}),
        error=>error instanceof ReplyToolError&&error.code==='RECALL_LIMIT_REACHED');
      assert.deepEqual(await tools!.recall!({messageRef:first},{operationId:'first-recall'}),result);
      assert.equal(f.store.replyLedger.parts(secondRef)[0]!.cancelRequested,false);
      assert.equal(f.store.replyLedger.parts(secondRef)[0]!.state,'started');
      await tools!.send({messages:[{type:'text',text:'after error'}]});ack.release();checked=true;
    } else {
      const result=await tools!.recall!({messageRef:secondRef},{operationId:'next-run-recall'});
      assert.equal(result.status,'recalled');
    }
    return {messages:[]};
  }},{async sendText(text){sent.push(text);if(text==='second')await ack.promise;return {messageId:'qq-'+text};},
    async recallMessage(messageRef){recalls++;const id=messageRef===secondRef?'qq-second':'qq-first';
      return {messageRef,status:'recalled',parts:[{messageId:id,partIndex:0,status:'recalled'}],events:[recall(id)]};}},{replyReceiptWaitMs:20});
  await until(()=>f.store.getCursor()===1);assert.equal(checked,true);assert.equal(recalls,1);assert.deepEqual(sent,['first','second','after error']);
  assert.equal(f.store.replyLedger.parts(secondRef)[0]!.state,'acknowledged');
  f.store.insert(incoming('2'));processor.notify();await until(()=>f.store.getCursor()===2);
  assert.equal(recalls,2);assert.equal(f.store.replyLedger.parts(secondRef)[0]!.state,'recalled');
});

for(const status of ['failed','unconfirmed'] as const)test(`a ${status} recall still consumes the run allowance`,async t=>{
  const f=fixture(t);f.store.insert(incoming('1'));let calls=0;
  f.start({async run(_batch,_session,_onSession,_signal,tools){
    const ref=(await tools!.send({messages:[{type:'text',text:'original'}]})).messages![0]!.messageRef;
    await until(()=>f.store.replyLedger.parts(ref)[0]?.state==='acknowledged');
    const result=await tools!.recall!({messageRef:ref},{operationId:'attempt'});assert.equal(result.status,status);
    await assert.rejects(tools!.recall!({messageRef:ref},{operationId:'retry'}),error=>error instanceof ReplyToolError&&error.code==='RECALL_LIMIT_REACHED');
    assert.deepEqual(await tools!.recall!({messageRef:ref},{operationId:'attempt'}),result);
    return {messages:[]};
  }},{async sendText(){return {messageId:'qq-original'};},async recallMessage(messageRef){calls++;
    return {messageRef,status,parts:[{messageId:'qq-original',partIndex:0,status}]};}});
  await until(()=>f.store.getCursor()===1);assert.equal(calls,1);
});

test('an in-flight recall reserves the sole allowance before awaiting its result',async t=>{
  const f=fixture(t),gate=f.gate();f.store.insert(incoming('1'));let calls=0;
  f.start({async run(_batch,_session,_onSession,_signal,tools){
    const refs=(await tools!.send({messages:[{type:'text',text:'A'},{type:'text',text:'B'}]})).messages!.map(m=>m.messageRef);
    await until(()=>f.store.replyLedger.parts(refs[1]!)[0]?.state==='acknowledged');
    const pending=tools!.recall!({messageRef:refs[0]!},{operationId:'in-flight'});await until(()=>calls===1);
    await assert.rejects(tools!.recall!({messageRef:refs[1]!},{operationId:'concurrent'}),error=>error instanceof ReplyToolError&&error.code==='RECALL_LIMIT_REACHED');
    assert.equal(f.store.replyLedger.parts(refs[1]!)[0]!.cancelRequested,false);gate.release();await pending;
    return {messages:[]};
  }},{async sendText(text){return {messageId:'qq-'+text};},async recallMessage(messageRef){calls++;await gate.promise;
    return {messageRef,status:'recalled',parts:[{messageId:'qq-A',partIndex:0,status:'recalled'}],events:[recall('qq-A')]};}});
  await until(()=>f.store.getCursor()===1);assert.equal(calls,1);
});
