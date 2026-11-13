import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {ConsoleDatabase} from '../src/console/database.js';
import {defaultSettings} from '../src/console/settings.js';
import {createConsole} from '../src/console/server.js';
import {DockerClient} from '../src/console/docker.js';
import {runManagedWorker} from '../src/managed-worker.js';
import {BridgeStore} from '../src/store.js';
import {Processor} from '../src/processor.js';
import type {ConsoleEvent} from '../src/console/contracts.js';
import type {RunCancellation} from '../src/run-control-contract.js';

const logger={info(){},warn(){},error(){}};
const event=(seq:number,type:string,runId='run-a',payload:Record<string,unknown>={}):ConsoleEvent=>({seq,type,runId,payload:{throughSeq:1,...payload},conversationId:'chat-example',time:Date.now()});
async function until(check:()=>boolean,timeout=5000){const end=Date.now()+timeout;while(!check()){assert.ok(Date.now()<end,'condition timed out');await delay(5);}}
class FakeDocker extends DockerClient {
  constructor(){super({socketPath:'unused',image:'unused',network:'unused',consoleUrl:'unused'});}
  override async inspect(){return null;}
}

test('durable controls are idempotent, monotonic and remain scoped to one turn across restart',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'run-controls-'));
  const path=join(directory,'console.sqlite3'),key=join(directory,'master.key');
  let db=new ConsoleDatabase(path,key);t.after(async()=>{db.close();await rm(directory,{recursive:true,force:true});});
  const bot=db.createBot({name:'Example',targetType:'group',targetId:'1001',config:defaultSettings()});
  db.ingestEvents(bot.id,[event(1,'run.started')]);
  assert.throws(()=>db.runControls.request(bot.id,'run-a','click-a'),/更新实例/);
  db.runControls.capability(bot.id,true);
  const command=db.runControls.request(bot.id,'run-a','click-a');
  assert.deepEqual(db.runControls.request(bot.id,'run-a','click-a'),command);
  assert.deepEqual(db.runControls.request(bot.id,'run-a','click-b'),command);
  assert.throws(()=>db.runControls.request(bot.id,'run-b','click-a'),/其他轮次/);
  assert.throws(()=>db.runControls.request(bot.id,'stale-run','click-c'),/已结束/);
  db.close();db=new ConsoleDatabase(path,key);
  assert.deepEqual(db.runControls.pending(bot.id),[command]);assert.equal(db.runControls.isCancelled(bot.id,'run-a'),true);
  db.runControls.acknowledge(bot.id,{...command,status:'received'});
  db.runControls.acknowledge(bot.id,{...command,status:'already_finished'}); // A reconnect can beat the terminal event upload.
  db.ingestEvents(bot.id,[event(2,'run.progress','run-a',{phase:'cancelling'}),event(3,'run.cancelled')]);
  assert.equal(db.runControls.view(bot.id).active,null);assert.equal(db.runControls.view(bot.id).cancellation!.status,'cancelled');
  db.runControls.acknowledge(bot.id,{...command,status:'received'}); // Late ACK cannot reopen a finished command.
  assert.deepEqual(db.runControls.pending(bot.id),[]);
  db.ingestEvents(bot.id,[event(4,'run.started','run-b',{throughSeq:2})]);
  db.ingestEvents(bot.id,[event(3,'run.cancelled')]);
  assert.equal(db.runControls.view(bot.id).active!.runId,'run-b');assert.equal(db.runControls.isCancelled(bot.id,'run-b'),false);
  db.ingestEvents(bot.id,[event(5,'batch.abandoned','unrelated',{throughSeq:2})]);
  assert.equal(db.runControls.view(bot.id).active,null);
});

test('cancel API requires admin/CSRF and worker ACKs require the matching instance identity',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'run-control-api-'));
  const {app,db}=await createConsole({dataDir:directory,docker:new FakeDocker(),timers:false,staticDir:'/nonexistent'});
  t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
  const bot=db.createBot({name:'Example',targetType:'group',targetId:'1001',config:defaultSettings()});
  const path=`/api/bots/${bot.id}/runs/run-a/cancel`;
  assert.equal((await app.inject({method:'POST',url:path,payload:{requestId:'click-a'}})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:path,headers:{'x-console-request':'1'},payload:{requestId:'click-a'}})).statusCode,401);
  const setup=await app.inject({method:'POST',url:'/api/setup',headers:{'x-console-request':'1'},payload:{password:'synthetic-admin-password'}});
  const headers={'x-console-request':'1',cookie:setup.headers['set-cookie']!.toString().split(';')[0]!};
  db.ingestEvents(bot.id,[event(1,'run.started')]);
  assert.equal((await app.inject({method:'POST',url:path,headers,payload:{requestId:'click-a'}})).statusCode,409);
  const internal={authorization:`Bearer ${bot.workerToken}`};
  assert.equal((await app.inject({method:'POST',url:`/internal/workers/${bot.id}/heartbeat`,headers:internal,
    payload:{revision:1,connected:true,processing:true,drained:false,events:[],supportsRunCancellation:true}})).statusCode,200);
  const accepted=await app.inject({method:'POST',url:path,headers,payload:{requestId:'click-a'}});
  assert.equal(accepted.statusCode,202);assert.equal(accepted.json().status,'requested');
  const other=db.createBot({name:'Other',targetType:'group',targetId:'1002',config:defaultSettings()});
  for(const route of ['run-controls/stream','run-controls/ack']) {
    assert.equal((await app.inject({method:route.endsWith('ack')?'POST':'GET',url:`/internal/workers/${other.id}/${route}`,headers:internal})).statusCode,401);
  }
  const ack=await app.inject({method:'POST',url:`/internal/workers/${bot.id}/run-controls/ack`,headers:internal,payload:{...accepted.json<RunCancellation>(),status:'received'}});
  assert.equal(ack.statusCode,200);assert.equal(db.runControls.view(bot.id).cancellation!.status,'received');
});

test('managed control stream cancels during thinking, replays after disconnect and retains ACKs and the next turn',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'managed-run-cancel-'));
  const {app,db}=await createConsole({dataDir:join(directory,'console'),docker:new FakeDocker(),timers:false,staticDir:'/nonexistent'});
  await app.listen({host:'127.0.0.1',port:0});const address=app.server.address();assert.ok(address&&typeof address!=='string');
  const url=`http://127.0.0.1:${address.port}`;
  const bot=db.createBot({name:'Example',targetType:'group',targetId:'1001',config:defaultSettings()});db.setDesiredState(bot.id,'running');
  const setup=await app.inject({method:'POST',url:'/api/setup',headers:{'x-console-request':'1'},payload:{password:'synthetic-admin-password'}});
  const cookie=setup.headers['set-cookie']!.toString().split(';')[0]!;
  const store=new BridgeStore(join(directory,'bridge.sqlite3'),{type:'group',id:'1001'});
  const insert=(id:number)=>store.insert({messageId:String(id),senderId:'2001',senderName:'Example',time:Date.now()/1000,text:`question-${id}`,replyTo:null,trigger:true,rawJson:'{}'});
  insert(1);const controller=new AbortController();let calls=0,cancellations=0;const sent:string[]=[];
  let release!:()=>void;const ack=new Promise<void>(resolve=>{release=resolve;});let processor!:Processor;
  const managed=runManagedWorker({url,botId:bot.id,token:bot.workerToken,dataDir:join(directory,'worker')},{},logger,controller.signal,(_config,signal)=>{
    processor=new Processor({store,agent:{async run(_batch,session,onSession,runSignal,tools){
      calls++;if(calls===1){onSession('retained-session');await tools!.send({messages:[{type:'text',text:'first'},{type:'text',text:'queued'}]});
        try{await delay(60_000,undefined,{signal:runSignal});}catch{throw Object.assign(new Error('cancelled'),{modelFailure:true});}}
      assert.equal(session,'retained-session');return {messages:[{type:'text',text:'next'}]};
    }},sender:{async sendText(text,deliverySignal){sent.push(text);if(text==='first'){await ack;assert.equal(deliverySignal.aborted,false);}return {messageId:`ack-${text}`};},async sendImage(){},async sendMessage(){}},
      logger,batchSize:1,replyMaxChars:100,retryMs:1,workspace:directory,imageMaxBytes:1024,imageTimeoutMs:100});
    const done=processor.run(signal);
    return {store,connected:true,get processing(){return processor.isProcessing;},get drained(){return processor.isDrained;},
      requestDrain:()=>processor.requestDrain(),done,cancelRun:runId=>{cancellations++;return processor.cancelRun(runId);},async stop(beforeClose){await done;await beforeClose?.();}};
  });
  t.after(async()=>{release();controller.abort();await managed;store.close();await app.close();await rm(directory,{recursive:true,force:true});});
  await until(()=>!!db.runControls.view(bot.id).active&&db.runControls.view(bot.id).supported&&sent.length===1);
  const runId=db.runControls.view(bot.id).active!.runId;
  const response=await fetch(`${url}/api/bots/${bot.id}/runs/${runId}/cancel`,{method:'POST',headers:{cookie,'x-console-request':'1','content-type':'application/json'},body:JSON.stringify({requestId:'click-a'})});
  assert.equal(response.status,202);
  await until(()=>db.runControls.view(bot.id).cancellation?.status==='received');
  assert.equal(processor.activeRun!.phase,'cancelling');assert.equal(store.getCursor(),0);assert.deepEqual(sent,['first']);
  app.server.closeAllConnections();
  await until(()=>cancellations>=2); // The same run-scoped command is replayed while its ACK is pending.
  insert(2);processor.notify();release();
  await until(()=>store.getCursor()===2&&db.runControls.view(bot.id).cancellation?.status==='cancelled');
  assert.equal(calls,2);assert.deepEqual(sent,['first','next']);assert.equal(controller.signal.aborted,false);
  assert.equal(store.getSessionId(),'retained-session');
  await until(()=>db.getConversation(bot.id)!.items.some(item=>item.type==='run.cancelled'));
  assert.equal(db.getConversation(bot.id)!.items.filter(item=>item.type==='run.failed').length,0);
});
