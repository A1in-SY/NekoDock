import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConsole } from '../src/console/server.js';
import { DockerClient } from '../src/console/docker.js';
class FakeDocker extends DockerClient{
 constructor(){super({socketPath:'unused',image:'unused',network:'unused',consoleUrl:'unused'});}
 override async inspect(){return null;}
 override async create(){}
 override async start(){}
}
test('console HTTP lifecycle authenticates, protects mutations, keeps target immutable and isolates worker credentials',async()=>{
 const path=mkdtempSync(join(tmpdir(),'console-http-'));
 const {app,db}=await createConsole({dataDir:path,docker:new FakeDocker(),timers:false,staticDir:'/nonexistent'});
 const headers={'x-console-request':'1'};
 try{
  assert.equal((await app.inject('/api/bots')).statusCode,401);
  assert.equal((await app.inject({method:'POST',url:'/api/setup',payload:{password:'long-test-password'}})).statusCode,403);
  const setup=await app.inject({method:'POST',url:'/api/setup',headers,payload:{password:'long-test-password'}});assert.equal(setup.statusCode,200);
  const cookie=setup.headers['set-cookie']!.toString().split(';')[0]!;const logged={...headers,cookie};
  assert.match(setup.headers['set-cookie']!.toString(),/HttpOnly/);assert.match(setup.headers['set-cookie']!.toString(),/SameSite=Strict/);
  assert.equal((await app.inject({method:'POST',url:'/api/bots',headers:{...logged,origin:'http://evil.test'},payload:{}})).statusCode,403);
  const create=await app.inject({method:'POST',url:'/api/bots',headers:logged,payload:{name:'test',targetType:'group',targetId:'123',config:{napcatToken:'secret-test-value'}}});
  assert.equal(create.statusCode,201,create.body);const bot=create.json();assert.equal(bot.config.napcatToken,undefined);assert.equal(bot.workerToken,undefined);assert.equal(bot.configuredSecrets.napcatToken,true);
  assert.equal((await app.inject({method:'PUT',url:`/api/bots/${bot.id}`,headers:logged,payload:{expectedRevision:1,targetId:'456'}})).statusCode,400);
  const update=await app.inject({method:'PUT',url:`/api/bots/${bot.id}`,headers:logged,payload:{expectedRevision:1,config:{replyProbability:100}}});assert.equal(update.statusCode,200,update.body);
  assert.equal((await app.inject({method:'PUT',url:`/api/bots/${bot.id}`,headers:logged,payload:{expectedRevision:1,config:{replyProbability:50}}})).statusCode,409);
  assert.equal((await app.inject(`/internal/workers/${bot.id}/config`)).statusCode,401);
  const internal={authorization:`Bearer ${db.getBot(bot.id)!.workerToken}`};
  const snapshot=await app.inject({url:`/internal/workers/${bot.id}/config`,headers:internal});assert.equal(snapshot.statusCode,200);assert.equal(snapshot.json().env.NAPCAT_TOKEN,'secret-test-value');
  const heartbeat=await app.inject({method:'POST',url:`/internal/workers/${bot.id}/heartbeat`,headers:internal,payload:{revision:2,connected:true,processing:false,drained:true,conversationId:'c1',events:[{seq:1,type:'message.received',time:Date.now(),conversationId:'c1',payload:{messageId:'m1',text:'test'}}]}});
  assert.equal(heartbeat.statusCode,200,heartbeat.body);assert.equal(heartbeat.json().acknowledgedSeq,1);
  const list=await app.inject({url:'/api/bots',headers:logged});assert.equal(list.json()[0].statistics.totalMessages,1);
  const conversation=await app.inject({url:`/api/bots/${bot.id}/conversation`,headers:logged});assert.equal(conversation.json().items[0].payload.text,'test');assert.equal(conversation.json().usage.total,null);
  assert.equal((await app.inject({url:'/api/metrics?from=2&to=1',headers:logged})).statusCode,400);
  const clone=await app.inject({method:'POST',url:'/api/bots',headers:logged,payload:{name:'copy',targetType:'private',targetId:'234',copyFrom:bot.id,config:{}}});assert.equal(clone.statusCode,201,clone.body);assert.equal(clone.json().statistics.totalMessages,0);assert.equal(clone.json().configuredSecrets.napcatToken,true);
  await app.inject({method:'POST',url:'/api/logout',headers:logged});assert.equal((await app.inject({url:'/api/bots',headers:logged})).statusCode,401);
 }finally{await app.close();rmSync(path,{recursive:true,force:true});}
});
