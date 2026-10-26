import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { cachedSnapshot, loadManagedSnapshot, managedIdentity, materializeSnapshot, runManagedWorker, saveSnapshot, uploadWorkerEvents, type ManagedIdentity, type WorkerRuntime } from '../src/managed-worker.js';
import type { WorkerSnapshot } from '../src/console/contracts.js';
import { BridgeStore } from '../src/store.js';
const logger={info(){},warn(){},error(){}};
function config(identity:ManagedIdentity,revision=1):WorkerSnapshot {return{botId:identity.botId,revision,target:{type:'group',id:'1001'},env:{TARGET_TYPE:'group',TARGET_ID:'1001',NAPCAT_WS_URL:'ws://127.0.0.1:9999',AGENT_API_KEY:'private-api-credential'},persona:'Persona text'};}

test('managed identity remains optional for standalone workers and rejects partial credentials',()=>{
 assert.equal(managedIdentity({}),null);assert.throws(()=>managedIdentity({BOT_INSTANCE_ID:'one'}),/requires/);
 assert.throws(()=>managedIdentity({CONSOLE_URL:'http://user:password@localhost',BOT_INSTANCE_ID:'one',WORKER_TOKEN:'key'}),/endpoint/);
});

test('snapshot is encrypted, restrictive, authenticated and available when control plane is offline',async t=>{
 const dataDir=await mkdtemp(join(tmpdir(),'managed-cache-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
 const identity={url:'http://127.0.0.1:1',botId:'bot1',token:'test-worker-control-token',dataDir};
 const value=config(identity);await saveSnapshot(identity,value);
 const bytes=await readFile(join(dataDir,'managed-config.enc'));assert.equal(bytes.includes(Buffer.from('private-api-credential')),false);assert.equal(bytes.includes(Buffer.from('Persona text')),false);
 assert.equal((await stat(join(dataDir,'managed-config.enc'))).mode&0o777,0o600);
 assert.deepEqual(await cachedSnapshot(identity),value);assert.deepEqual(await loadManagedSnapshot(identity),value);
 await assert.rejects(cachedSnapshot({...identity,token:'wrong-token'}));
 const corrupt=Buffer.from(bytes);corrupt[corrupt.length-1]!^=1;
 const {writeFile}=await import('node:fs/promises');await writeFile(join(dataDir,'managed-config.enc'),corrupt);
 await assert.rejects(cachedSnapshot(identity));
});

test('control config validates bot identity and passes DB persona directly to the Agent',async t=>{
 const dataDir=await mkdtemp(join(tmpdir(),'managed-config-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
 let identity:ManagedIdentity;let foreign=false;
 const server=createServer((request,response)=>{
   assert.equal(request.headers.authorization,'Bearer worker-token');response.setHeader('content-type','application/json');
   response.end(JSON.stringify({...config(identity),...(foreign?{botId:'other'}:{})}));
 });await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
 identity={url:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,botId:'bot1',token:'worker-token',dataDir};
 const value=await loadManagedSnapshot(identity,undefined,false);const runtime=await materializeSnapshot(identity,value,{});
 assert.equal(runtime.target.id,'1001');assert.equal(runtime.agentHome,join(dataDir,'pi'));
 assert.equal(runtime.persona,'Persona text');
 await assert.rejects(stat(join(runtime.agentHome,'AGENTS.md')), { code: 'ENOENT' });
 foreign=true;await assert.rejects(loadManagedSnapshot(identity,undefined,false),/snapshot/);
});

test('heartbeat carries only runtime state and drains the event uploader before applying a new revision',async t=>{
 const dataDir=await mkdtemp(join(tmpdir(),'managed-heartbeat-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
 let identity:ManagedIdentity;let revision=1,posts=0,drainRequests=0,created=0,stopped=0;const abort=new AbortController();
 const uploaded:number[]=[];const heartbeats:number[][]=[];
 const server=createServer(async(request,response)=>{
   response.setHeader('content-type','application/json');
   if(request.url!.endsWith('/config')){response.end(JSON.stringify(config(identity,revision)));return;}
   let body='';for await(const chunk of request)body+=chunk;const hb=JSON.parse(body);
   if(request.url!.endsWith('/events')){uploaded.push(...hb.events.map((event:{seq:number})=>event.seq));response.end(JSON.stringify({acknowledgedSeq:hb.events.at(-1)?.seq??0}));return;}
   posts++;heartbeats.push(hb.events.map((event:{seq:number})=>event.seq));
   if(posts===2)revision=2;
   response.end(JSON.stringify({desiredState:'running',desiredRevision:revision,acknowledgedSeq:hb.events.at(-1)?.seq??0}));
   if(posts===3)setTimeout(()=>abort.abort(),20);
 });await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
 identity={url:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,botId:'bot1',token:'worker-token',dataDir};
 const factory=():WorkerRuntime=>{
   created++;const store=new BridgeStore(join(dataDir,'bridge.sqlite3'),{type:'group',id:'1001'});let drained=false;
   return{store,connected:true,processing:false,get drained(){return drained;},requestDrain(){drainRequests++;drained=true;},done:new Promise(()=>{}),async stop(beforeClose){stopped++;store.recorder.append('runtime.closed',{revision:created});await beforeClose?.();store.close();}};
 };
 const timeout=setTimeout(()=>abort.abort(),14000);t.after(()=>clearTimeout(timeout));
 await runManagedWorker(identity,{},logger,abort.signal,()=>factory());
 assert.equal(posts,3);assert.deepEqual(heartbeats,[[],[],[]]);assert.equal(created,2);assert.equal(stopped,2);assert.equal(drainRequests,1);
 assert.ok(uploaded.length>=3);assert.equal(new Set(uploaded).size,uploaded.length);
 assert.equal((await cachedSnapshot(identity)).revision,2);
});

const waitUntil=async(predicate:()=>boolean,timeout=4000)=>{const deadline=Date.now()+timeout;while(!predicate()){assert.ok(Date.now()<deadline,'event transport did not settle');await new Promise(resolve=>setTimeout(resolve,15));}};

test('events upload before the next heartbeat, remain single-flight and include append-during-upload',async t=>{
 const dataDir=await mkdtemp(join(tmpdir(),'managed-events-live-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
 const store=new BridgeStore(join(dataDir,'bridge.sqlite3'),{type:'group',id:'1001'});
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 let active=0,maxActive=0;const batches:number[][]=[];
 const server=createServer(async(request,response)=>{
   active++;maxActive=Math.max(maxActive,active);let body='';for await(const chunk of request)body+=chunk;
   const events=JSON.parse(body).events;assert.ok(request.url!.endsWith('/events'));
   batches.push(events.map((event:{seq:number})=>event.seq));if(batches.length===1)await gate;
   response.setHeader('content-type','application/json');response.end(JSON.stringify({acknowledgedSeq:events.at(-1).seq}));active--;
 });await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const identity={url:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,botId:'bot1',token:'worker-token',dataDir};
 const uploader=uploadWorkerEvents(identity,store.recorder,logger);
 t.after(async()=>{release();await uploader.close();store.close();await new Promise<void>(resolve=>server.close(()=>resolve()));});
 const started=Date.now();await waitUntil(()=>batches.length===1);assert.ok(Date.now()-started<1500);
 for(let index=0;index<95;index++)store.recorder.append('thinking.updated',{text:'visible',status:'in_progress'},`thought:${index}`);
 await new Promise(resolve=>setTimeout(resolve,150));assert.equal(batches.length,1);
 release();await waitUntil(()=>store.recorder.pending(1).length===0);
 assert.equal(maxActive,1);assert.deepEqual(batches.map(batch=>batch.length),[1,80,15]);
 const seqs=batches.flat();assert.equal(new Set(seqs).size,96);
});

test('event failures retain the durable backlog, retry independently and resume after restart',async t=>{
 const dataDir=await mkdtemp(join(tmpdir(),'managed-events-retry-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
 const path=join(dataDir,'bridge.sqlite3');let store=new BridgeStore(path,{type:'group',id:'1001'});
 store.recorder.append('thinking.updated',{text:'private-body',status:'completed'},'saved-before-restart');store.close();
 store=new BridgeStore(path,{type:'group',id:'1001'});
 const batches:number[][]=[];const logs:string[]=[];
 const server=createServer(async(request,response)=>{
   let body='';for await(const chunk of request)body+=chunk;const events=JSON.parse(body).events;
   batches.push(events.map((event:{seq:number})=>event.seq));response.setHeader('content-type','application/json');
   if(batches.length===1){response.statusCode=503;response.end('{}');return;}
   response.end(JSON.stringify({acknowledgedSeq:events.at(-1).seq}));
 });await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const identity={url:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,botId:'bot1',token:'worker-token',dataDir};
 const uploader=uploadWorkerEvents(identity,store.recorder,{...logger,warn:value=>logs.push(value)});
 t.after(async()=>{await uploader.close();store.close();await new Promise<void>(resolve=>server.close(()=>resolve()));});
 await waitUntil(()=>batches.length===1);assert.equal(store.recorder.pending().length,2);
 await waitUntil(()=>store.recorder.pending(1).length===0);
 assert.equal(batches.length,2);assert.deepEqual(batches[0],batches[1]);assert.doesNotMatch(logs.join('\n'),/private-body|worker-token/);
 await uploader.close();store.recorder.append('after.closed',{});await new Promise(resolve=>setTimeout(resolve,150));assert.equal(batches.length,2);
});
