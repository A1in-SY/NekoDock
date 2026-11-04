import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConsole } from '../src/console/server.js';
import { DockerClient } from '../src/console/docker.js';
import { NetworkProbes } from '../src/console/network-probes.js';
import { probeNetwork } from '../src/network-probe.js';
import { createNetworkClient, defaultNetworkProxy } from '../src/network.js';
import { pollNetworkProbes, type ManagedIdentity, type WorkerRuntime } from '../src/managed-worker.js';

test('diagnostics isolate bot identity and revision, expire and discard arbitrary result fields',()=>{
  let now=100;const probes=new NetworkProbes(()=>now);
  const first=probes.request('a',2);assert.equal(probes.request('a',2).id,first.id);
  assert.equal(probes.get('b',first.id),null);assert.equal(probes.claim('b',2),null);
  assert.equal(probes.claim('a',1),null);assert.equal(probes.get('a',first.id)!.result!.code,'REVISION_CHANGED');
  const next=probes.request('a',2);assert.notEqual(next.id,first.id);assert.equal(probes.claim('a',2)!.id,next.id);
  assert.equal(probes.claim('a',2),null);
  assert.throws(()=>probes.complete('b',{id:next.id,revision:2,result:{ok:true,code:'OK',durationMs:2,status:401}}));
  assert.throws(()=>probes.complete('a',{id:next.id,revision:2,result:{ok:false,code:'raw credential error',durationMs:2}}));
  probes.complete('a',{id:next.id,revision:2,result:{ok:true,code:'OK',durationMs:2,status:401,route:'proxy',secret:'do-not-save'}});
  assert.equal(JSON.stringify(probes.get('a',next.id)).includes('do-not-save'),false);
  assert.equal(probes.complete('a',{id:next.id,revision:2,result:{ok:false,code:'TIMEOUT',durationMs:0}}),false);
  const pending=probes.request('a',2);now+=31_000;assert.equal(probes.get('a',pending.id)!.status,'failed');
  now+=10*60_000;assert.equal(probes.get('a',next.id),null);
});

test('connectivity probe sends no model credential or generation payload and accepts HTTP denial as reachable',async t=>{
  const seen:Array<{url?:string;authorization?:string;method?:string}>=[];
  const server=createServer((req,res)=>{seen.push({url:req.url,authorization:req.headers.authorization,method:req.method});res.writeHead(401);res.write('denied');res.end();});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();return new Promise<void>(resolve=>server.close(()=>resolve()));});
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const client=createNetworkClient();t.after(()=>client.close());
  const result=await probeNetwork(client,`http://127.0.0.1:${address.port}/v1`,new AbortController().signal);
  assert.equal(result.ok,true);assert.equal(result.status,401);assert.equal(result.route,'direct');
  assert.deepEqual(seen,[{url:'/v1/models',method:'GET',authorization:undefined}]);
  assert.equal((await probeNetwork(client,undefined,new AbortController().signal)).code,'CONFIGURATION_REQUIRED');
  const broken=createNetworkClient({...defaultNetworkProxy(),enabled:true,url:'http://127.0.0.1:1',noProxy:''});t.after(()=>broken.close());
  assert.equal((await probeNetwork(broken,`http://127.0.0.1:${address.port}/v1`,new AbortController().signal)).code,'PROXY_UNREACHABLE');
  assert.equal(seen.length,1,'A failed proxy must not retry directly.');
  const rejected=createServer((_req,res)=>{res.writeHead(407);res.end();});
  await new Promise<void>(resolve=>rejected.listen(0,'127.0.0.1',resolve));t.after(()=>{rejected.closeAllConnections();return new Promise<void>(resolve=>rejected.close(()=>resolve()));});
  const proxyAddress=rejected.address();assert.ok(proxyAddress&&typeof proxyAddress!=='string');
  const auth=createNetworkClient({...defaultNetworkProxy(),enabled:true,url:`http://127.0.0.1:${proxyAddress.port}`,noProxy:''});t.after(()=>auth.close());
  assert.equal((await probeNetwork(auth,'http://target.invalid/v1',new AbortController().signal)).code,'PROXY_AUTH_FAILED');
});

class FakeDocker extends DockerClient {
  constructor(){super({socketPath:'unused',image:'unused',network:'unused',consoleUrl:'unused'});}
  override async inspect(){return null;}
}
test('authenticated Console queues a diagnostic which the matching Worker completes outside chat history',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'network-probe-http-'));
  const {app,db}=await createConsole({dataDir:directory,docker:new FakeDocker(),timers:false,staticDir:'/nonexistent'});
  t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
  const setup=await app.inject({method:'POST',url:'/api/setup',headers:{'x-console-request':'1'},payload:{password:'synthetic-long-password'}});
  const headers={'x-console-request':'1',cookie:setup.headers['set-cookie']!.toString().split(';')[0]!};
  const bot=db.createBot({name:'Example',targetType:'group',targetId:'10001',config:{}});
  const url=`/api/bots/${bot.id}/network-probe`;
  assert.equal((await app.inject({method:'POST',url,headers})).statusCode,400);
  db.setDesiredState(bot.id,'running');
  db.ingestHeartbeat(bot.id,{revision:1,connected:true,processing:true,drained:false,events:[]});
  const post=await app.inject({method:'POST',url,headers});assert.equal(post.statusCode,202,post.body);const job=post.json();
  assert.equal((await app.inject({method:'POST',url,headers:{cookie:headers.cookie}})).statusCode,403);
  assert.equal((await app.inject({url:`${url}?probeId=${job.id}`})).statusCode,401);
  const workerHeaders={authorization:`Bearer ${bot.workerToken}`};
  const internal=`/internal/workers/${bot.id}/network-probe`;
  assert.equal((await app.inject({url:`${internal}?revision=1`})).statusCode,401);
  const claim=await app.inject({url:`${internal}?revision=1`,headers:workerHeaders});assert.equal(claim.json().probe.id,job.id);
  const done=await app.inject({method:'POST',url:internal,headers:workerHeaders,payload:{id:job.id,revision:1,result:{ok:true,code:'OK',durationMs:12,status:401,route:'direct'}}});
  assert.equal(done.statusCode,200,done.body);
  const get=await app.inject({url:`${url}?probeId=${job.id}`,headers});assert.equal(get.json().status,'completed');
  assert.equal(db.getConversation(bot.id)?.items.length??0,0);
});

test('worker diagnostic polling posts a bounded result without depending on a chat turn',async t=>{
  const controller=new AbortController();const posts:unknown[]=[];let polled=false;
  const server=createServer(async(req,res)=>{
    assert.equal(req.headers.authorization,'Bearer synthetic-worker-token');res.setHeader('content-type','application/json');
    if(req.method==='GET'){polled=true;res.end(JSON.stringify({probe:{id:'example-probe',revision:3}}));return;}
    let body='';for await(const bytes of req)body+=bytes;posts.push(JSON.parse(body));res.end('{"accepted":true}');controller.abort();
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();return new Promise<void>(resolve=>server.close(()=>resolve()));});
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const identity:ManagedIdentity={url:`http://127.0.0.1:${address.port}`,botId:'example',token:'synthetic-worker-token',dataDir:'/unused'};
  const runtime={probeNetwork:async()=>({ok:false,code:'PROXY_AUTH_FAILED',durationMs:10})} as unknown as WorkerRuntime;
  const timeout=setTimeout(()=>controller.abort(),3000);t.after(()=>clearTimeout(timeout));
  await pollNetworkProbes(identity,()=>({revision:3,runtime}),{info(){},warn(){},error(){}},controller.signal);
  assert.equal(polled,true);assert.equal(posts.length,1);
  assert.deepEqual(posts[0],{id:'example-probe',revision:3,result:{ok:false,code:'PROXY_AUTH_FAILED',durationMs:10}});
});
