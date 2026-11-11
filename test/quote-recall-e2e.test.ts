import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir,mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createConsole } from '../src/console/server.js';
import { DockerClient } from '../src/console/docker.js';
import { ConsoleTransport } from '../src/console-transport.js';
import { BridgeStore } from '../src/store.js';
import { Processor } from '../src/processor.js';
import { PiRunner } from '../src/pi.js';
import { normalizeMessage } from '../src/napcat.js';
import { uploadWorkerEvents } from '../src/managed-worker.js';
import { deferred,piFixture,respond,sendReply } from './fixtures/pi-e2e.js';

test('managed Pi tools deduplicate own recall notices, enforce one recall per run, and preserve external recalls', {timeout:30000},async t=>{
  let recalledRef='';
  const f=await piFixture(t,async(call,response,index)=>{
    const wire=JSON.stringify(call.body);
    if(index===1) {
      assert.deepEqual(call.replyTargetMessageIds,['10001','10002']);
      sendReply(call,response,[{type:'text',text:'An incorrect draft.',replyTo:'10001'}]);
    }else if(index===2) {
      await f.waitFor(()=>f.outgoing.some(m=>m.action==='send_group_msg'),'The original draft must actually reach the mock QQ transport');
      const outputs=(call.body.input as Array<Record<string,unknown>>).filter(m=>m.type==='function_call_output');
      const accepted=JSON.parse(String(outputs.at(-1)!.output));recalledRef=accepted.messages[0].messageRef;
      respond(call,response,[{name:'recall_message',arguments:{messageRef:recalledRef}}]);
    }else if(index===3) {
      assert.match(wire,/An incorrect draft/);
      assert.ok(!(call.body.input as Array<Record<string,unknown>>).some(item=>item.role==='user'&&JSON.stringify(item.content).includes('message_recalled')));
      assert.ok((call.body.input as Array<Record<string,unknown>>).some(item=>item.type==='function_call_output'&&JSON.parse(String(item.output)).status==='recalled'));
      sendReply(call,response,[{type:'text',text:'The corrected answer for A.',replyTo:'10001'},{type:'text',text:'The answer for B.',replyTo:'10002'}]);
    }else if(index===4) {
      const outputs=(call.body.input as Array<Record<string,unknown>>).filter(item=>item.type==='function_call_output');
      const accepted=JSON.parse(String(outputs.at(-1)!.output));
      respond(call,response,[{name:'recall_message',arguments:{messageRef:accepted.messages[0].messageRef}}]);
    }else if(index===5) {
      assert.match(wire,/RECALL_LIMIT_REACHED/);assert.deepEqual(call.body.tools,f.calls[0]!.body.tools);
      respond(call,response,'Internal completion.');
    }else if(index===6) {
      assert.match(wire,/Question B/);assert.match(wire,/message_recalled/);
      sendReply(call,response,[{type:'text',text:'This quote must be rejected.',replyTo:'10002'}]);
    }else if(index===7) {
      assert.match(wire,/QUOTE_TARGET_RECALLED/);
      sendReply(call,response,[{type:'text',text:'A valid follow-up.',replyTo:'10003'}]);
    }else if(index===8) {
      await f.waitFor(()=>f.outgoing.filter(m=>m.action==='send_group_msg').length===4,'The new reply must reach the mock transport');
      const outputs=(call.body.input as Array<Record<string,unknown>>).filter(item=>item.type==='function_call_output');
      const accepted=JSON.parse(String(outputs.at(-1)!.output));
      respond(call,response,[{name:'recall_message',arguments:{messageRef:accepted.messages[0].messageRef}}]);
    }else if(index===9) {
      const outputs=(call.body.input as Array<Record<string,unknown>>).filter(item=>item.type==='function_call_output');
      assert.equal(JSON.parse(String(outputs.at(-1)!.output)).status,'recalled');respond(call,response,'Internal completion.');
    }
    else assert.fail(`Unexpected model request ${index}`);
  });
  f.onSend=(message)=>{
    if(message.action==='delete_msg')f.broadcast({post_type:'notice',notice_type:'group_recall',self_id:'999',group_id:'1001',user_id:'999',operator_id:'999',
      message_id:(message.params as unknown as {message_id:string}).message_id,time:1792727202});
  };
  const root=await mkdtemp(join(tmpdir(),'quote-recall-managed-'));
  const logger={info(){},warn(){},error(){}};
  const consoleApp=await createConsole({dataDir:join(root,'console'),timers:false,staticDir:'/nonexistent',
    docker:new DockerClient({socketPath:'/nonexistent/isolated-no-docker.sock',image:'isolated',network:'isolated',consoleUrl:'http://127.0.0.1:1'})});
  await consoleApp.app.listen({host:'127.0.0.1',port:0});
  const address=consoleApp.app.server.address();assert.ok(address&&typeof address!=='string');
  const connection=consoleApp.db.createNapcatConnection({name:'Synthetic shared connection',wsUrl:f.localWsUrl,enabled:true,reconnectSeconds:1,actionTimeout:2});
  const bot=consoleApp.db.createBot({name:'Synthetic recall bot',targetType:'group',targetId:'1001',connectionId:connection.id,config:{}});
  consoleApp.db.setDesiredState(bot.id,'running');consoleApp.db.setRuntime(bot.id,{state:'running'});
  const identity={url:`http://127.0.0.1:${address.port}`,botId:bot.id,token:bot.workerToken,dataDir:join(root,'worker')};
  const workspace=join(identity.dataDir,'workspace'),home=join(identity.dataDir,'pi');await mkdir(workspace,{recursive:true});await mkdir(home);
  const store=new BridgeStore(join(identity.dataDir,'bridge.sqlite3'),{type:'group',id:'1001'});
  const agent=new PiRunner({home,workspace,model:'synthetic-model',baseUrl:f.modelUrl,api:'openai-responses',timeoutMs:10000,logger,
    contextWindow:200000,compactLimit:160000,maxOutputTokens:1000,supportsImages:false,supportsReasoning:false,allowCommands:false,allowFileWrites:false,
    persona:'Synthetic test persona.',targetType:'group'});
  const controller=new AbortController();let processor:Processor;
  const transport=new ConsoleTransport({identity,logger,actionTimeoutMs:2000,reconnectMs:10,
    onEvent:raw=>{const message=normalizeMessage(raw,{type:'group',id:'1001'},0);if(message){store.insert(message);processor?.notify();}},
    onRecall:event=>{if(store.applyRecall(event)&&store.chatMessageForQQ(event.messageId)?.conversationId===store.recorder.conversationId)agent.notifyRecall(event);}});
  const uploader=uploadWorkerEvents(identity,store.recorder,logger);
  let running:Promise<void>|undefined;
  t.after(async()=>{controller.abort();await transport.stop();await running;await uploader.close();store.close();await consoleApp.app.close();await rm(root,{recursive:true,force:true});});
  await consoleApp.gateway.reconcile();transport.start();
  await f.waitFor(()=>transport.connected,'The authenticated Console stream must connect');
  f.send('10001','Question A');f.send('10002','Question B');
  await f.waitFor(()=>store.getMessage('10001')!==null&&store.getMessage('10002')!==null,'Both source messages must be durable before batching');
  processor=new Processor({store,agent,sender:transport,logger,batchSize:50,replyMaxChars:1500,retryMs:10,workspace,imageMaxBytes:1024,imageTimeoutMs:100});
  running=processor.run(controller.signal);
  await f.waitFor(()=>store.getCursor()===2&&store.peekPendingBatch()===null,'The correction round must finish');
  const sends=f.outgoing.filter(m=>m.action==='send_group_msg');
  assert.equal(sends.length,3);assert.equal(f.outgoing.filter(m=>m.action==='delete_msg').length,1);
  assert.equal(sends[0]!.params.message[0]!.data.id,'10001');assert.equal(sends[1]!.params.message[0]!.data.id,'10001');assert.equal(sends[2]!.params.message[0]!.data.id,'10002');
  assert.match(recalledRef,/^reply:/);assert.equal(store.chatMessageForQQ('1')!.recalled,true);
  assert.equal(store.chatMessageForQQ('1')!.text,'An incorrect draft.');
  f.broadcast({post_type:'notice',notice_type:'group_recall',self_id:'999',group_id:'1001',user_id:'501',operator_id:'501',message_id:'10002',time:1792727203});
  await f.waitFor(()=>store.chatMessageForQQ('10002')?.recalled===true,'A human recall must traverse the durable stream');
  await delay(100);assert.equal(f.calls.length,5,'A recall alone must not start a model request');
  f.send('10003','A fresh follow-up');
  await f.waitFor(()=>store.getCursor()===3&&store.peekPendingBatch()===null,'The rejected quote must be repairable in the same round');
  assert.equal(f.calls.length,9);assert.equal(f.outgoing.filter(m=>m.action==='send_group_msg').length,4);
  assert.equal(f.outgoing.filter(m=>m.action==='delete_msg').length,2);
  assert.equal(f.outgoing.filter(m=>m.action==='send_group_msg').at(-1)!.params.message[0]!.data.id,'10003');
  assert.ok(f.outgoing.every(m=>!JSON.stringify(m.params).includes('This quote must be rejected')));
  await f.waitFor(()=>consoleApp.db.getConversation(bot.id)?.items.some(e=>e.type==='message.recalled')===true,'The recall must be visible through the real event upload');
  assert.equal(store.chatMessageForQQ('10002')!.text.includes('Question B'),true);
});

test('the real Worker keeps a newly received recalled background message out of the active round and appends both facts in its next batch', {timeout:30000},async t=>{
  const gate=deferred();t.after(()=>gate.resolve());
  const f=await piFixture(t,async(call,response,index)=>{
    const wire=JSON.stringify(call.body);
    if(index===1){await gate.promise;sendReply(call,response,[{type:'text',text:'The first result.'}]);}
    else if(index===2){assert.doesNotMatch(wire,/Withdrawn background|message_recalled/);respond(call,response,'Internal completion.');}
    else if(index===3){assert.match(wire,/Withdrawn background/);assert.match(wire,/message_recalled/);
      assert.ok(wire.indexOf('Withdrawn background')<wire.indexOf('message_recalled'));
      respond(call,response,[{name:'search_chat_history',arguments:{aroundMessageId:'future',limit:10}}]);}
    else if(index===4){
      const outputs=(call.body.input as Array<Record<string,unknown>>).filter(m=>m.type==='function_call_output');
      const history=JSON.parse(String(outputs.at(-1)!.output));
      const state=history.messages.find((source:Record<string,unknown>)=>source.kind==='message_recalled');
      assert.equal(state.role,'system');assert.equal(JSON.parse(state.text).messageId,'future');
      assert.equal(JSON.parse(state.text).type,'message_recalled');assert.equal(state.images,undefined);assert.equal(state.assets,undefined);
      assert.ok(history.messages.some((source:Record<string,unknown>)=>source.role==='user'&&source.recalled===true&&source.text==='Withdrawn background'));
      sendReply(call,response,[{type:'text',text:'The new question is answered.'}]);
    }else if(index===5)respond(call,response,'Internal completion.');
    else assert.fail(`Unexpected request ${index}`);
  });
  await f.start('1001',{MEMORY_ENABLED:'true',MEMORY_DAILY_ENABLED:'false',MEMORY_AFTER_COMPACTION:'false',MEMORY_EMBEDDING_PROVIDER:'none'});await f.waitFor(()=>f.napcat.clients.size===1,'The real Worker must connect to the isolated mock');
  f.send('active');await f.waitFor(()=>f.calls.length===1,'The first model request must be in flight');
  f.send('future','Withdrawn background',false);
  await f.waitFor(()=>f.read('1001',db=>!!db.prepare("SELECT 1 FROM messages WHERE message_id='future'").get()),'The background message must be durable');
  f.broadcast({post_type:'notice',notice_type:'group_recall',self_id:'999',group_id:'1001',user_id:'501',operator_id:'501',message_id:'future',time:1792727203});
  await f.waitFor(()=>f.read('1001',db=>db.prepare("SELECT recalled FROM chat_messages WHERE qq_message_id='future'").get()?.recalled===1),'The background recall must be durable');
  gate.resolve();await f.waitFor(()=>f.complete(1),'The initial round must finish while background input stays pending');
  assert.equal(f.calls.length,2);
  f.send('next','A fresh independent question');
  await f.waitFor(()=>f.complete(3),'The next round must consume the original message and its recall');
  assert.equal(f.calls.length,5);assert.equal(f.outgoing.length,2);
});
