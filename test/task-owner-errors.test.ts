import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { workerRequest } from '../src/managed-worker.js';

const denied='任务只允许创建者修改或删除，请通过控制台管理其他任务';

async function mockManagement(t:test.TestContext) {
  let status=400,body=JSON.stringify({error:denied});
  const server=createServer(async(request,response)=>{
    assert.equal(request.headers.authorization,'Bearer synthetic-worker-token');
    for await(const _ of request) { /* Consume the synthetic request body. */ }
    response.writeHead(status,{'content-type':'application/json'});response.end(body);
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  return {
    identity:{url:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,botId:'synthetic-bot',token:'synthetic-worker-token',dataDir:'/unused'},
    respond(nextStatus:number,nextBody:unknown,raw=false){status=nextStatus;body=raw?String(nextBody):JSON.stringify(nextBody);},
  };
}

test('task management forwards only its exact creator-permission error to the model caller',async t=>{
  const mock=await mockManagement(t);
  mock.respond(400,{error:denied,detail:'synthetic-private-detail'});
  await assert.rejects(workerRequest(mock.identity,'tasks/manage',{operation:'update'}),{message:denied});
});

test('other management paths and HTTP statuses keep the fixed HTTP error even for the same body',async t=>{
  const mock=await mockManagement(t);
  for(const {path,status} of [
    {path:'tasks/manage',status:401},
    {path:'tasks/manage',status:403},
    {path:'tasks/manage',status:500},
    {path:'config',status:400},
    {path:'tasks/manage/',status:400},
  ]) {
    mock.respond(status,{error:denied});
    await assert.rejects(workerRequest(mock.identity,path,{}),{message:`Management request failed (${status}).`});
  }
});

test('unknown, malformed and non-string task errors never expose backend content',async t=>{
  const mock=await mockManagement(t);
  for(const body of [
    {error:'synthetic-private-backend-detail'},
    {error:`${denied} synthetic-private-detail`},
    {error:123},
    {error:{message:denied}},
    {message:denied},
    null,
    denied,
  ]) {
    mock.respond(400,body);
    await assert.rejects(workerRequest(mock.identity,'tasks/manage',{}),{message:'Management request failed (400).'});
  }
  mock.respond(400,'not-json synthetic-private-detail',true);
  await assert.rejects(workerRequest(mock.identity,'tasks/manage',{}),{message:'Management request failed (400).'});
});

test('successful task management responses remain unchanged',async t=>{
  const mock=await mockManagement(t);
  const result={id:'synthetic-task',revision:2,creatorId:'1001'};
  mock.respond(200,result);
  assert.deepEqual(await workerRequest(mock.identity,'tasks/manage',{}),result);
});
