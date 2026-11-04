import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createConsole} from '../src/console/server.js';
import {DockerClient} from '../src/console/docker.js';

class FakeDocker extends DockerClient {
  constructor(){super({socketPath:'unused',image:'unused',network:'unused',consoleUrl:'unused'});}
  override async inspect(){return null;}
}

test('shared connection API protects credentials, revisions, references and worker identity',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'shared-napcat-api-'));
  const {app,db}=await createConsole({dataDir:directory,docker:new FakeDocker(),timers:false,staticDir:'/nonexistent'});
  t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
  assert.equal((await app.inject('/api/napcat-connections')).statusCode,401);
  const setup=await app.inject({method:'POST',url:'/api/setup',headers:{'x-console-request':'1'},payload:{password:'synthetic-admin-password'}});
  const headers={'x-console-request':'1',cookie:setup.headers['set-cookie']!.toString().split(';')[0]!};
  const added=await app.inject({method:'POST',url:'/api/napcat-connections',headers,payload:{name:'shared',wsUrl:'ws://127.0.0.1:9/',token:'synthetic-upstream-token',enabled:false}});
  assert.equal(added.statusCode,201,added.body);const connection=added.json();
  assert.equal(connection.tokenConfigured,true);assert.equal(connection.token,undefined);assert.equal(added.body.includes('synthetic-upstream-token'),false);
  const create=await app.inject({method:'POST',url:'/api/bots',headers,payload:{name:'first',targetType:'group',targetId:'1001',connectionId:connection.id,config:{}}});
  assert.equal(create.statusCode,201,create.body);const bot=create.json();
  for(const field of ['imageMaxMiB','ttsMaxMiB'])assert.equal((await app.inject({method:'PUT',url:`/api/bots/${bot.id}`,headers,payload:{expectedRevision:1,config:{[field]:17}}})).statusCode,400);
  const copy=await app.inject({method:'POST',url:'/api/bots',headers,payload:{name:'second',targetType:'private',targetId:'2001',copyFrom:bot.id}});
  assert.equal(copy.statusCode,201,copy.body);assert.equal(copy.json().connectionId,connection.id);
  const defaults=(await app.inject({url:'/api/defaults',headers})).json();
  for(const key of ['wsUrl','napcatToken','actionTimeout','reconnectSeconds']){assert.equal(bot.config[key],undefined);assert.equal(defaults[key],undefined);}
  const internal={authorization:`Bearer ${db.getBot(bot.id)!.workerToken}`};
  const snapshot=(await app.inject({url:`/internal/workers/${bot.id}/config`,headers:internal})).json();
  assert.equal(snapshot.connectionId,connection.id);assert.equal(snapshot.transport,'console');assert.equal(snapshot.env.NAPCAT_TOKEN,'');assert.equal(snapshot.env.NAPCAT_WS_URL,'ws://console.invalid/');
  assert.equal(JSON.stringify(snapshot).includes('synthetic-upstream-token'),false);
  for(const suffix of ['config','napcat/events'])assert.equal((await app.inject({url:`/internal/workers/${copy.json().id}/${suffix}`,headers:internal})).statusCode,401);
  assert.equal((await app.inject({method:'POST',url:`/internal/workers/${copy.json().id}/napcat/send`,headers:internal,payload:{}})).statusCode,401);
  assert.equal((await app.inject({method:'DELETE',url:`/api/napcat-connections/${connection.id}`,headers})).statusCode,400);
  const updated=await app.inject({method:'PUT',url:`/api/napcat-connections/${connection.id}`,headers,payload:{expectedRevision:1,name:'renamed'}});
  assert.equal(updated.statusCode,200,updated.body);assert.equal(updated.json().tokenConfigured,true);
  assert.equal((await app.inject({method:'PUT',url:`/api/napcat-connections/${connection.id}`,headers,payload:{expectedRevision:1,name:'stale'}})).statusCode,409);
  assert.equal((await app.inject({url:'/api/napcat-connections',headers})).body.includes('synthetic-upstream-token'),false);
});

test('only the worker media route accepts bodies over the ordinary API limit',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'shared-napcat-media-api-'));
  const {app,db,gateway}=await createConsole({dataDir:directory,docker:new FakeDocker(),timers:false,staticDir:'/nonexistent'});
  t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
  const bot=db.createBot({name:'media',targetType:'group',targetId:'1001',config:{}});
  let received=0;
  gateway.send=async(id,input)=>{assert.equal(id,bot.id);received=JSON.stringify(input).length;return {ok:true,messageId:'synthetic-qq-message'};};
  const headers={authorization:`Bearer ${bot.workerToken}`};
  const payload={deliveryId:'media-check',deadline:Date.now()+15000,kind:'image',file:'base64://'+Buffer.alloc(4*1024*1024).toString('base64')};
  const response=await app.inject({method:'POST',url:`/internal/workers/${bot.id}/napcat/send`,headers,payload});
  assert.equal(response.statusCode,200,response.body);assert.equal(response.json().ok,true);assert.ok(received>4*1024*1024);
  assert.equal((await app.inject({method:'POST',url:`/internal/workers/${bot.id}/events`,headers,payload})).statusCode,413);
});
