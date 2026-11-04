import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { piFixture, respond, sendReply, deferred } from './fixtures/pi-e2e.js';

const run=promisify(execFile);
const image=process.env.BRIDGE_E2E_IMAGE;

test('isolated image consolidates durable memory while a separate real Pi chat completes', {skip:!image,timeout:40_000},async t=>{
  const gate=deferred();t.after(()=>gate.resolve());
  let memoryStarted=false;
  const f=await piFixture(t,async(call,response)=>{
    if(call.body.model==='control'){response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({started:memoryStarted}));return;}
    if(call.body.model==='memory-example'){
      assert.equal(call.results.length,0,'Successful staging must not need an extra provider request.');
      memoryStarted=true;await gate.promise;respond(call,response,[{name:'stage_memory_changes',arguments:{changes:[{operation:'upsert',scope:'person',subjectUserId:'2001',kind:'preference',topic:'饮食/香菜',content:'不吃香菜',sources:[{sourceSeq:1,quote:'我不吃香菜'}]}]}}]);
    }else if(!call.results.length)sendReply(call,response,[{type:'text',text:'A normal chat reply.'}]);
    else {respond(call,response,'Done.');gate.resolve();}
  });
  const name=`memory-isolated-${randomUUID()}`;
  t.after(async()=>{await run('docker',['rm','--force',name]).catch(()=>{});});
  const script=`
    import assert from 'node:assert/strict';import{mkdirSync}from'node:fs';
    import{BridgeStore}from'./dist/src/store.js';import{MemoryStore}from'./dist/src/memory-store.js';
    import{MemoryCoordinator}from'./dist/src/memory-coordinator.js';import{PiRunner}from'./dist/src/pi.js';
    const logger={info(){},warn(){},error(){}};for(const dir of ['/data/pi','/data/workspace'])mkdirSync(dir,{recursive:true});
    const bridge=new BridgeStore('/data/bridge.sqlite3',{type:'group',id:'1001'});const store=new MemoryStore('/data/bridge.sqlite3');
    const options={home:'/data/pi',workspace:'/data/workspace',model:'memory-example',baseUrl:${JSON.stringify(f.modelUrl)},apiKey:'synthetic-key',api:'openai-responses',supportsImages:false,supportsReasoning:false,reasoning:'off',contextWindow:200000,compactLimit:160000,maxOutputTokens:8192,timeoutMs:15000,allowCommands:false,allowFileWrites:false,persona:'',targetType:'group',logger};
    const config={enabled:true,dailyEnabled:false,dailyTime:'04:00',timezone:'Asia/Shanghai',afterCompaction:true,recallTokens:3000,model:'',baseUrl:'',embeddingProvider:'none',embeddingBaseUrl:'',embeddingModel:''};
    const memory=new MemoryCoordinator({store,config,runner:new PiRunner(options),logger});
    const signal=new AbortController().signal;let replies=0;
    try{
      bridge.insert({messageId:'source-1',senderId:'2001',senderName:'Example',time:123,text:'我不吃香菜',replyTo:null,trigger:false,rawJson:'{}'});
      memory.onCompacted({session:'/data/synthetic.jsonl',entryId:'checkpoint'});
      while(!memory.processing)await new Promise(r=>setTimeout(r,5));assert.equal(bridge.isBusy(),false);
      while(!(await (await fetch(${JSON.stringify(f.modelUrl + '/started')},{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'control',input:[]})})).json()).started)await new Promise(r=>setTimeout(r,10));
      await new PiRunner({...options,model:'chat-example'}).run({throughSeq:2,messages:[{seq:2,messageId:'question',senderId:'2001',senderName:'Example',time:124,text:'A current question',replyTo:null,trigger:true,rawJson:'{}'}],replyAllowed:true,replies:null,nextReplyIndex:0},null,()=>{},signal,{send:async()=>{replies++;return{accepted:true};}});
      assert.equal(replies,1);const end=Date.now()+10000;while(store.cursor()!==store.highWater()){assert.ok(Date.now()<end,'memory publication timeout');await new Promise(r=>setTimeout(r,10));}
      assert.equal(store.search({query:'香菜'}).length,1);assert.equal(bridge.isBusy(),false);
      console.log(JSON.stringify({chatCompleted:true,memoryPublished:true,busy:false}));
    }finally{await memory.close();store.close();bridge.close();}
  `;
  const result=await run('docker',['run','--rm','--name',name,'--read-only','--tmpfs','/data:rw,mode=1777,size=64m','--entrypoint','node',image!,'--input-type=module','-e',script],{timeout:30_000,maxBuffer:1024*1024});
  assert.match(result.stdout,/"chatCompleted":true,"memoryPublished":true,"busy":false/);
  assert.equal(f.outgoing.length,0);
  assert.ok(f.calls.findIndex(call=>call.body.model==='chat-example')>f.calls.findIndex(call=>call.body.model==='memory-example'));
});
