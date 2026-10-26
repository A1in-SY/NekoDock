import test from 'node:test';
import assert from 'node:assert/strict';
import http, { createServer } from 'node:http';
import { hostname, tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { DockerLogDecoder, LogStreams, sanitizeLogSnapshot, type DockerLogSnapshot } from '../src/console/logs.js';
import { DockerClient } from '../src/console/docker.js';
import { createConsole } from '../src/console/server.js';

const time='2026-10-25T06:00:00.123456789Z';
const appTime='2026-10-25T14:00:00.123+08:00';
function frame(stream:1|2,text:string|Buffer):Buffer {
 const bytes=typeof text==='string'?Buffer.from(text):text;const header=Buffer.alloc(8);header[0]=stream;header.writeUInt32BE(bytes.length,4);return Buffer.concat([header,bytes]);
}
test('Docker log decoder handles binary header, frame and UTF-8 fragmentation, multiline and both streams',()=>{
 const decoder=new DockerLogDecoder();const body=Buffer.from(`${time} ${appTime} INFO agent.run.started reason="你好"\n${time} ${appTime} INFO agent.run.completed\n`);
 const split=body.indexOf(Buffer.from('好'))+1;
 const bytes=Buffer.concat([frame(1,body.subarray(0,split)),frame(2,`${time} ${appTime} WARN napcat.api.failed\n`),frame(1,body.subarray(split))]);
 for(let i=0;i<bytes.length;i+=3)decoder.write(bytes.subarray(i,i+3));
 const output=decoder.finish();assert.equal(output.lines.length,3);assert.equal(output.truncated,false);
 assert.equal(output.lines[0]!.stream,'stderr');assert.equal(output.lines[0]!.time,appTime);
 assert.match(output.lines[1]!.message,/你好/u);assert.equal(output.lines[2]!.stream,'stdout');
});
test('Docker log decoder bounds retained rows and oversized lines, rejects malformed/incomplete framing',()=>{
 const decoder=new DockerLogDecoder(2,100);decoder.write(frame(1,[1,2,3].map(n=>`${time} ${'x'.repeat(n===1?300:4)}\n`).join('')));
 assert.equal(decoder.finish().lines.length,2);assert.equal(decoder.truncated,true);
 const bad=new DockerLogDecoder();assert.throws(()=>bad.write(Buffer.alloc(8)),/无效/u);
 const incomplete=new DockerLogDecoder();incomplete.write(frame(1,`${time} ok\n`).subarray(0,10));assert.throws(()=>incomplete.finish(),/不完整/u);
});
test('log snapshots redact configured secrets and sensitive raw payloads while retaining diagnostic metadata',()=>{
 const secrets=['old-worker-token','new-api-secret','quote"secret'];
 const snapshot:DockerLogSnapshot={sourceId:'bot:a:container',truncated:false,lines:[
  {time:appTime,stream:'stdout',message:`${appTime} INFO processor.batch.failed reason="old-worker-token new-api-secret" payload="private chat" config="raw configuration" duration_ms=12`},
  {time:appTime,stream:'stdout',message:`${appTime} WARN processor.batch.failed reason=${JSON.stringify(secrets[2])} url="https://secret.test"`},
  {time:appTime,stream:'stdout',message:JSON.stringify({type:'agent_message',text:'private model text'})},
  {time:appTime,stream:'stderr',message:'(node:3) ExperimentalWarning: SQLite is an experimental feature and might change at any time'},
  {time:appTime,stream:'stderr',message:'Error: private raw stack or configuration'},
 ]};
 const result=sanitizeLogSnapshot(snapshot,secrets);assert.equal(result.lines.length,3);
 const output=JSON.stringify(result);for(const value of [...secrets,'private chat','raw configuration','private model text','secret.test','private raw'])assert.equal(output.includes(value),false,value);
 assert.match(output,/duration_ms=12/u);assert.match(output,/redacted/u);assert.equal(result.lines[2]!.level,'warn');
 assert.deepEqual(sanitizeLogSnapshot(snapshot,secrets),result);
});
test('log snapshots retain latest 500 rows and cap SSE payload size',()=>{
 const source:DockerLogSnapshot={sourceId:'console:id',truncated:false,lines:Array.from({length:600},(_,n)=>({time:appTime,stream:'stdout' as const,message:`${appTime} INFO processor.batch.started reason="${'x'.repeat(4000)}" pid=${n}`}))};
 const result=sanitizeLogSnapshot(source,[]);assert.equal(result.truncated,true);assert.ok(result.lines.length<500);assert.ok(Buffer.byteLength(JSON.stringify(result))<257*1024);assert.match(result.lines.at(-1)!.message,/pid=599/u);
});
test('log snapshots retain the tool, transport and control metadata needed to diagnose a failed turn',()=>{
 const messages=[
  'agent.tool.completed item_ref="abc" tool="web_fetch" status="failed" http_status=429 error_code="WEB_HTTP_ERROR" duration_ms=10',
  'napcat.connection.closed code=1006 reconnecting=true pending_count=1',
  'processor.command.resumed confirmation_only=true next_reply_index=2',
 ];
 const result=sanitizeLogSnapshot({sourceId:'bot:a:container',truncated:false,lines:messages.map(message=>({time:appTime,stream:'stdout',message:`${appTime} INFO ${message}`}))},[]);
 assert.deepEqual(result.lines.map(line=>line.message),messages);
});
test('Docker log endpoints enforce labels, use inspected IDs and rediscover replacement containers',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'console-log-docker-')),socketPath=join(dir,'docker.sock');
 let botLabel='a',consoleService='console',id='container-one';const logs:string[]=[];
 const server=createServer((req,res)=>{
  if(req.url==='/containers/napcat-managed-a/json'){res.end(JSON.stringify({Id:id,State:{Running:true},Config:{Labels:{'io.napcat.console.bot':botLabel}}}));return;}
  if(req.url===`/containers/${hostname()}/json`){res.end(JSON.stringify({Id:'self-container',State:{Running:true},Config:{Labels:{'com.docker.compose.service':consoleService,'com.docker.compose.project':'test'}}}));return;}
  if(req.url?.includes('/logs?')){logs.push(req.url);res.end(frame(1,`${time} ${appTime} INFO agent.run.started\n`));return;}
  res.statusCode=404;res.end('{}');
 });
 await new Promise<void>(resolve=>server.listen(socketPath,resolve));const docker=new DockerClient({socketPath,image:'unused',network:'unused',consoleUrl:'unused'});
 try{
  assert.equal((await docker.logs('a')).sourceId,'bot:a:container-one');assert.match(logs[0]!,/^\/containers\/container-one\/logs\?stdout=true&stderr=true&timestamps=true&tail=501$/u);
  id='container-two';assert.equal((await docker.logs('a')).sourceId,'bot:a:container-two');
  assert.equal((await docker.consoleLogs()).sourceId,'console:self-container');
  botLabel='wrong';await assert.rejects(docker.logs('a'),/不属于/u);consoleService='worker';await assert.rejects(docker.consoleLogs(),/不是控制台/u);assert.equal(logs.length,3);
  await assert.rejects(docker.logs('../other'),/无效/u);
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});}
});
test('Docker log reads abort on disconnect and reject oversized binary responses',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'console-log-bound-')),socketPath=join(dir,'docker.sock');let oversized=false;
 const server=createServer((req,res)=>{
  if(req.url?.endsWith('/json')){res.end(JSON.stringify({Id:'container',State:{Running:true},Config:{Labels:{'io.napcat.console.bot':'a'}}}));return;}
  if(oversized)res.end(frame(1,Buffer.alloc(2*1024*1024+1)));else res.writeHead(200);
 });
 await new Promise<void>(resolve=>server.listen(socketPath,resolve));const docker=new DockerClient({socketPath,image:'unused',network:'unused',consoleUrl:'unused'});
 try{
  const controller=new AbortController();const read=docker.logs('a',controller.signal);setTimeout(()=>controller.abort(),30);await assert.rejects(read,/读取失败/u);
  oversized=true;await assert.rejects(docker.logs('a'),/格式无效|超过限制/u);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});}
});

type Event={event:string;data:unknown};
async function until(check:()=>boolean,timeout=3000):Promise<void>{const start=Date.now();while(!check()){if(Date.now()-start>timeout)throw new Error('timed out');await new Promise(resolve=>setTimeout(resolve,5));}}
async function connect(url:string,cookie:string){
 const events:Event[]=[];let ended=false;let pending='';let response:http.IncomingMessage|undefined;
 const request=http.get(url,{headers:{cookie}},res=>{response=res;res.setEncoding('utf8');res.on('data',(chunk:string)=>{
  pending+=chunk;let index:number;while((index=pending.indexOf('\n\n'))>=0){const block=pending.slice(0,index);pending=pending.slice(index+2);const event=/^event: (.*)$/mu.exec(block)?.[1],data=/^data: (.*)$/mu.exec(block)?.[1];if(event&&data)events.push({event,data:JSON.parse(data)});}
 });res.on('end',()=>{ended=true;});});
 request.on('error',()=>{ended=true;});
 await until(()=>Boolean(response));
 return {events,get ended(){return ended;},close:()=>{response?.destroy();request.destroy();}};
}
class LogDocker extends DockerClient{
 active=0;maxActive=0;calls=0;available=true;sourceId='bot:a:one';extra='';aborted=0;delay=0;
 constructor(){super({socketPath:'unused',image:'unused',network:'unused',consoleUrl:'unused'});}
 override async logs(_id:string,signal?:AbortSignal):Promise<DockerLogSnapshot>{
  this.calls++;this.active++;this.maxActive=Math.max(this.maxActive,this.active);
  try{if(this.delay)await new Promise<void>((resolve,reject)=>{const timer=setTimeout(resolve,this.delay);signal?.addEventListener('abort',()=>{this.aborted++;clearTimeout(timer);reject(new Error('aborted'));},{once:true});});
   if(!this.available)throw new Error('unavailable');return {sourceId:this.sourceId,truncated:false,lines:[{time:appTime,stream:'stdout',message:`${appTime} INFO processor.batch.started reason=${JSON.stringify(this.extra)}`}]};
  }finally{this.active--;}
 }
 override async consoleLogs(signal?:AbortSignal):Promise<DockerLogSnapshot>{return this.logs('console',signal);}
 override async inspect(){return null;}
}
test('authenticated real HTTP log SSE sends snapshots only on changes, reconnects to replacement, redacts updated secrets and closes on logout',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'console-log-http-'));const docker=new LogDocker();
 const {app,db}=await createConsole({dataDir:dir,docker,timers:false,logPollMs:20,staticDir:'/nonexistent'});const clients:Array<Awaited<ReturnType<typeof connect>>>=[];
 try{
  await app.listen({port:0,host:'127.0.0.1'});const base=app.listeningOrigin;
  assert.equal((await fetch(`${base}/api/logs/stream`)).status,401);assert.equal((await fetch(`${base}/api/bots/missing/logs/stream`)).status,401);
  const setup=await app.inject({method:'POST',url:'/api/setup',headers:{'x-console-request':'1'},payload:{password:'long-test-password'}});const cookie=setup.headers['set-cookie']!.toString().split(';')[0]!;
  const bot=db.createBot({name:'test',targetType:'group',targetId:'123',config:{napcatToken:'current-key'}});docker.extra=`${bot.workerToken} current-key`;
  assert.equal((await fetch(`${base}/api/bots/missing/logs/stream`,{headers:{cookie}})).status,404);
  const stream=await connect(`${base}/api/bots/${bot.id}/logs/stream`,cookie);clients.push(stream);await until(()=>stream.events.some(e=>e.event==='logs'));
  assert.equal(JSON.stringify(stream.events).includes(bot.workerToken),false);assert.equal(JSON.stringify(stream.events).includes('current-key'),false);
  const first=stream.events.filter(e=>e.event==='logs').length;await new Promise(resolve=>setTimeout(resolve,65));assert.equal(stream.events.filter(e=>e.event==='logs').length,first);
  db.updateBot(bot.id,{expectedRevision:1,config:{napcatToken:'updated-key'}});docker.extra='updated-key current-key';await until(()=>stream.events.filter(e=>e.event==='logs').length>first);
  assert.equal(JSON.stringify(stream.events).includes('updated-key'),false);assert.equal(JSON.stringify(stream.events).includes('current-key'),false);
  docker.available=false;await until(()=>stream.events.some(e=>e.event==='status'&&(e.data as {state:string}).state==='unavailable'));
  const beforeRecovery=stream.events.filter(e=>e.event==='logs').length;docker.available=true;
  await until(()=>stream.events.filter(e=>e.event==='logs').length>beforeRecovery);
  assert.equal((stream.events.filter(e=>e.event==='logs').at(-1)!.data as {sourceId:string}).sourceId,'bot:a:one');
  docker.sourceId='bot:a:two';await until(()=>stream.events.some(e=>e.event==='logs'&&(e.data as {sourceId:string}).sourceId==='bot:a:two'));
  const consoleStream=await connect(`${base}/api/logs/stream`,cookie);clients.push(consoleStream);await until(()=>consoleStream.events.some(e=>e.event==='logs'));
  await app.inject({method:'POST',url:'/api/logout',headers:{'x-console-request':'1',cookie}});await until(()=>stream.ended&&consoleStream.ended);
  const calls=docker.calls;await new Promise(resolve=>setTimeout(resolve,60));assert.equal(docker.calls,calls);
 }finally{for(const client of clients)client.close();await app.close();rmSync(dir,{recursive:true,force:true});}
});
test('log SSE cancels pending reads on departure and session expiry, and never overlaps polls',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'console-log-cancel-')),docker=new LogDocker();docker.delay=35;
 const {app,db}=await createConsole({dataDir:dir,docker,timers:false,logPollMs:10,staticDir:'/nonexistent'});const clients:Array<Awaited<ReturnType<typeof connect>>>=[];
 try{
  await app.listen({port:0,host:'127.0.0.1'});const setup=await app.inject({method:'POST',url:'/api/setup',headers:{'x-console-request':'1'},payload:{password:'long-test-password'}});const cookie=setup.headers['set-cookie']!.toString().split(';')[0]!;
  const stream=await connect(`${app.listeningOrigin}/api/logs/stream`,cookie);clients.push(stream);await until(()=>stream.events.some(e=>e.event==='logs'));await until(()=>docker.calls>=3);assert.equal(docker.maxActive,1);stream.close();await until(()=>docker.active===0);assert.ok(docker.aborted>0);
  docker.delay=0;const expiry=await connect(`${app.listeningOrigin}/api/logs/stream`,cookie);clients.push(expiry);await until(()=>expiry.events.length>0);
  db.setSetting('session.'+createHash('sha256').update(cookie.split('=')[1]!).digest('hex'),String(Date.now()-1));await until(()=>expiry.ended);
 }finally{for(const client of clients)client.close();await app.close();rmSync(dir,{recursive:true,force:true});}
});
test('slow log clients are disconnected before adding another snapshot to an oversized write buffer',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'console-log-slow-')),docker=new LogDocker();
 const {app,db,auth}=await createConsole({dataDir:dir,docker,timers:false,staticDir:'/nonexistent'});
 class SlowResponse extends EventEmitter{
  writableLength=512*1024+1;destroyed=false;writes=0;
  writeHead(){}
  write(){this.writes++;return false;}
  end(){this.destroyed=true;this.emit('close');}
  destroy(){this.destroyed=true;this.emit('close');}
 }
 const response=new SlowResponse(),streams=new LogStreams(db,auth,docker,10);
 try{
  const token=await auth.setup('long-test-password','local');
  streams.open({cookies:{console_session:token}} as unknown as FastifyRequest,{raw:response,hijack(){}} as unknown as FastifyReply);
  await until(()=>response.destroyed);assert.equal(response.writes,0);const calls=docker.calls;await new Promise(resolve=>setTimeout(resolve,30));assert.equal(docker.calls,calls);
 }finally{streams.close();await app.close();rmSync(dir,{recursive:true,force:true});}
});


test('Pi lifecycle diagnostics retain selected metadata and never expose provider error prose', () => {
 const messages=[
  'agent.run.started operation="run" api="openai-responses" model="provider/model" run_id="run-one" resumed=true',
  'agent.tool.completed operation="run" tool="read" item_ref="a1b2c3" status="completed"',
  'agent.run.completed operation="append" accepted_requests=0 duration_ms=23 exit_code=0 stderr_bytes=0',
 ];
 const source:DockerLogSnapshot={sourceId:'bot:pi:container',truncated:false,lines:[
  ...messages.map(message=>({time:appTime,stream:'stdout' as const,message:`${appTime} INFO ${message}`})),
  {time:appTime,stream:'stderr',message:`${appTime} WARN agent.run.failed operation="run" api="openai-completions" accepted_requests=1 reason="PI_EXECUTION_FAILED: raw provider message with private user input" provider_message="private input" duration_ms=123`},
  {time:appTime,stream:'stderr',message:`${appTime} WARN agent.run.failed reason="private provider text" failure="private provider text" result="private provider text"`},
 ]};
 const result=sanitizeLogSnapshot(source,[]);
 assert.deepEqual(result.lines.slice(0,3).map(line=>line.message),messages);
 assert.equal(result.lines[3]!.message,'agent.run.failed operation="run" api="openai-completions" accepted_requests=1 reason="PI_EXECUTION_FAILED" duration_ms=123');
 assert.equal(result.lines[4]!.message,'agent.run.failed');
 assert.doesNotMatch(JSON.stringify(result),/raw provider|private user|private input|private provider/u);
});
