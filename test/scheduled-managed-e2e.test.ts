import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { createConsole } from '../src/console/server.js';
import { DockerClient } from '../src/console/docker.js';
import type { ScheduledTask } from '../src/scheduled-contract.js';
import { piFixture, respond } from './fixtures/pi-e2e.js';

class FakeDocker extends DockerClient {
  constructor(){super({socketPath:'unused',image:'unused',network:'unused',consoleUrl:'unused'});}
  override async inspect(){return null;}
}

test('managed scheduling sends script output without a model and retains committed state after a post-send model failure', {timeout:45_000}, async t=>{
  const directory=await mkdtemp(join(tmpdir(),'scheduled-managed-e2e-'));
  let modelInput:Record<string,any>|undefined;
  const fixture=await piFixture(t,async(call,response)=>{
    if(!call.results.length) {
      const items=call.body.input as Array<Record<string,any>>;
      const user=items.findLast(item=>item.role==='user')!;
      const text=typeof user.content==='string'?user.content:user.content.map((part:Record<string,any>)=>part.text??'').join('');
      modelInput=JSON.parse(text);
      assert.equal(modelInput!.kind,'scheduled_task');assert.equal(modelInput!.context.taskState.version,0);
      const tools=call.body.tools as Array<{name:string}>;
      assert.ok(tools.some(tool=>tool.name==='save_task_state'));
      assert.equal(tools.some(tool=>tool.name==='create_scheduled_task'),false);
      respond(call,response,[
        {name:'save_task_state',arguments:{expectedVersion:0,data:{observedValue:'1000.00',source:'isolated fixture'}}},
        {name:'send_message',arguments:{messages:[{type:'text',text:'scheduled-model-report'}]}},
      ]);
    } else {
      assert.match(JSON.stringify(call.results),/"?version/);
      assert.match(JSON.stringify(call.results),/accepted/);
      response.writeHead(524,{'content-type':'application/json'});
      response.end(JSON.stringify({error:{message:'isolated simulated provider timeout',type:'origin_response_timeout'}}));
    }
  });
  const consoleApp=await createConsole({dataDir:join(directory,'console'),docker:new FakeDocker(),staticDir:'/nonexistent',timers:false});
  let child:ChildProcessWithoutNullStreams|undefined;let done:Promise<number|null>|undefined;let exitCode:number|null|undefined;
  const logs:string[]=[];
  const closeChild=async()=>{
    if(child&&exitCode===undefined) {
      child.kill('SIGTERM');let deadline:NodeJS.Timeout|undefined;
      try {await Promise.race([done,new Promise<void>(resolve=>{deadline=setTimeout(resolve,5000);})]);}finally{clearTimeout(deadline);}
      if(exitCode===undefined){child.kill('SIGKILL');await done;assert.fail(`Worker did not stop cleanly: ${logs.slice(-25).join('\n')}`);}
      assert.equal(exitCode,0,logs.slice(-25).join('\n'));
    }
  };
  try {
    await consoleApp.app.listen({host:'127.0.0.1',port:0});
    const base=`http://127.0.0.1:${(consoleApp.app.server.address() as AddressInfo).port}`;
    let cookie='';
    const api=async<T>(path:string,method='GET',body?:unknown):Promise<T>=>{
      const response=await fetch(base+path,{method,headers:{'x-console-request':'1',...(cookie?{cookie}:{}),...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
      const data=await response.json();assert.ok(response.ok,`${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
      if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie')!.split(';')[0]!;
      return data as T;
    };
    const until=async(condition:()=>boolean,label:string,timeout=15000)=>{
      const end=Date.now()+timeout;
      while(!condition()) {
        assert.deepEqual(fixture.failures,[]);
        assert.equal(exitCode,undefined,`Worker exited: ${logs.slice(-25).join('\n')}`);
        assert.ok(Date.now()<end,`${label}: ${logs.slice(-30).join('\n')}`);await delay(25);
      }
    };
    await api('/api/setup','POST',{password:'isolated-scheduler-password'});
    const connection=await api<{id:string}>('/api/napcat-connections','POST',{name:'Simulated NapCat',wsUrl:fixture.localWsUrl});
    const bot=await api<{id:string}>('/api/bots','POST',{name:'Isolated scheduled instance',targetType:'group',targetId:'1001',connectionId:connection.id,config:{
      persona:'Use short, natural replies.',model:'isolated-scheduler-model',modelApi:'openai-responses',baseUrl:fixture.modelUrl.replace('host.docker.internal','127.0.0.1'),
      modelApiKey:'synthetic-scheduler-key',supportsReasoning:false,reasoning:'none',allowCommands:true,allowFileWrites:false,
      replyProbability:0,ttsProvider:'none',voiceEnabled:false,searchProvider:'none',modelTimeout:20,
    }});
    const taskBase=`/api/bots/${bot.id}/tasks`;
    const script=await api<ScheduledTask>(taskBase,'POST',{name:'Script greeting',kind:'script',schedule:{kind:'once',at:new Date(Date.now()+2000).toISOString(),timezone:'Asia/Shanghai'},script:{runtime:'node',source:"import {sendMessage} from './nekodock_tasks.mjs';\nsendMessage({messages:[{type:'text',text:'scheduled-script-report'}]});"},maxDelaySeconds:60,timeoutSeconds:10});
    consoleApp.db.setDesiredState(bot.id,'running');
    child=spawn(process.execPath,[fileURLToPath(new URL('../src/main.js',import.meta.url))],{
      env:{...process.env,CONSOLE_URL:base,BOT_INSTANCE_ID:bot.id,WORKER_TOKEN:consoleApp.db.getBot(bot.id)!.workerToken,DATA_DIR:join(directory,'worker')},
      stdio:['pipe','pipe','pipe'],shell:false,
    });
    child.stdout.on('data',chunk=>logs.push(String(chunk)));child.stderr.on('data',chunk=>logs.push(String(chunk)));
    child.on('error',error=>fixture.failures.push(error));
    done=new Promise(resolve=>child!.once('close',code=>{exitCode=code;resolve(code);}));
    await until(()=>consoleApp.db.tasks.runs(bot.id,script.id).some(run=>run.status==='completed'&&run.deliveryStatus==='acknowledged'),'script run should complete and be ACKed');
    assert.equal(fixture.calls.length,0);assert.equal(fixture.outgoing.length,1);
    assert.equal(fixture.outgoing[0]!.params.group_id,'1001');
    assert.equal(fixture.outgoing[0]!.params.message.map(segment=>segment.data.text??'').join(''),'scheduled-script-report');
    const language=await api<ScheduledTask>(taskBase,'POST',{name:'Model report',kind:'model',instructions:'Publish the current fixture value and save the verified value for the next execution.',schedule:{kind:'once',at:new Date(Date.now()+2000).toISOString(),timezone:'Asia/Shanghai'},context:{taskState:true},maxDelaySeconds:60,timeoutSeconds:20});
    await until(()=>consoleApp.db.tasks.runs(bot.id,language.id).some(run=>run.status==='failed'&&run.deliveryStatus==='acknowledged'),'model failure should preserve the earlier ACK');
    const run=consoleApp.db.tasks.runs(bot.id,language.id)[0]!;const detail=consoleApp.db.tasks.detail(bot.id,run.id)!;
    assert.equal(run.acceptedMessages,1);assert.equal(run.acknowledgedMessages,1);
    assert.equal(detail.taskState!.version,1);assert.equal(detail.taskState!.data.observedValue,'1000.00');
    assert.equal(detail.events.some(event=>event.type==='tool.started'),true);
    assert.equal(fixture.calls.length,2);assert.equal(fixture.outgoing.length,2);
    assert.equal(fixture.outgoing[1]!.params.message.map(segment=>segment.data.text??'').join(''),'scheduled-model-report');
    assert.equal(modelInput!.invocation.timezone,'Asia/Shanghai');
    assert.equal(consoleApp.db.getConversation(bot.id)!.usage.total,null,'scheduled usage is separate from the main conversation');
    const db=new DatabaseSync(join(directory,'worker','bridge.sqlite3'),{readOnly:true});
    try {assert.equal(db.prepare('SELECT session_id FROM instance_state WHERE id=1').get()!.session_id,null);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get()!.n,0);}finally{db.close();}
    consoleApp.db.setDesiredState(bot.id,'stopped');
    await until(()=>{const runtime=consoleApp.db.getRuntime(bot.id);return runtime.drained&&!runtime.processing;},'Worker should report safe drain before shutdown');
    await closeChild();
    assert.equal(fixture.outgoing.length,2,'drain must not resend completed tasks');
  } finally {await closeChild();await consoleApp.app.close();await rm(directory,{recursive:true,force:true});}
});
