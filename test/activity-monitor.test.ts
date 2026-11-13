import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { activity, beginActivity, withActivityReporter } from '../src/activity.js';
import { parseProcStat, processDelta, watchProcessTree } from '../src/process-observer.js';
import { ActivitiesDatabase } from '../src/console/activities.js';
import { MetricsDatabase, resourceSample } from '../src/console/metrics.js';
import { createConsole } from '../src/console/server.js';
import { DockerClient, type ContainerInfo, type DockerStats } from '../src/console/docker.js';
import type { ActivityEvent, ActivitySpan, ProcessSample } from '../src/activity-contract.js';
import type { ConsoleEvent } from '../src/console/contracts.js';
import { ConsoleDatabase } from '../src/console/database.js';

const owner={resourceId:'worker-a',botId:'worker-a',runId:'reply-a'};
function event(id='phase-a',patch:Partial<ActivityEvent>={}):ActivityEvent {const time=Date.now();return {id,traceId:'agent-a',kind:'model',name:'model_request',time,startedAt:time,status:'running',...patch};}
function point(spanId='phase-a',patch:Partial<ProcessSample>={}):ProcessSample{return {id:'sample-a',spanId,time:Date.now(),intervalMs:1000,cpu:80,coverage:'sampled',processes:[{pid:22,startTime:'100',program:'browser',cpu:80}],...patch};}
function fixture(t:test.TestContext){const db=new DatabaseSync(':memory:'),activities=new ActivitiesDatabase(db);t.after(()=>db.close());return {db,activities};}
const observation=(seq:number,type:string,payload:Record<string,unknown>,time=Date.now()):ConsoleEvent=>({seq,type,time,runId:'reply-a',conversationId:'chat-a',payload});

test('activity scopes preserve parallel parents and isolate failing instrumentation',async()=>{
  const records:ActivityEvent[]=[];
  await Promise.all(['agent','memory'].map(name=>withActivityReporter(e=>records.push(e),undefined,()=>activity('run',name as 'agent'|'memory',async()=>{
    await new Promise<void>(resolve=>setImmediate(resolve));await activity('model','model_request',async()=>42);
  }))));
  const starts=records.filter(e=>e.status==='running');assert.equal(starts.length,4);
  for(const child of starts.filter(e=>e.kind==='model'))assert.equal(starts.find(e=>e.id===child.parentId)?.traceId,child.traceId);
  assert.equal(new Set(starts.filter(e=>!e.parentId).map(e=>e.traceId)).size,2);
  assert.equal(await withActivityReporter(()=>{throw new Error('offline')},undefined,()=>activity('tool','read',async()=>7)),7);
  const failure=Object.assign(new Error('private-command-body'),{code:'EXAMPLE_FAILED'});
  await assert.rejects(withActivityReporter(e=>records.push(e),undefined,()=>activity('command','bash',async()=>{throw failure})),error=>error===failure);
  assert.equal(records.at(-1)!.errorCode,'EXAMPLE_FAILED');assert.ok(!JSON.stringify(records).includes('private-command-body'));
});

test('request progress keeps the first event measurement through completion',async t=>{
  const {activities}=fixture(t),events:ActivityEvent[]=[];
  await withActivityReporter(e=>events.push(e),undefined,async()=>{const span=beginActivity('model','model_request',{requestIndex:2});span.progress({firstEventMs:17});span.end();span.end('failed');});
  for(const e of events)activities.ingest(owner,e);
  const row=activities.query(0,Date.now()+1).spans[0]!;
  assert.equal(row.firstEventMs,17);assert.equal(row.requestIndex,2);assert.equal(row.status,'completed');
});

test('proc parser handles embedded parentheses and CPU deltas reject reused PIDs',()=>{
  const fields=Array(22).fill('0');fields[0]='R';fields[1]='12';fields[11]='150';fields[12]='50';fields[19]='98765';
  const current=parseProcStat('42 (chromium (worker)) '+fields.join(' '));assert.equal(current.program,'browser');assert.equal(current.parent,12);assert.equal(current.ticks,200);
  const previous=new Map([[`42:${current.startTime}`,{...current,ticks:100}]]);
  assert.equal(processDelta([current],previous,1000,100)[0]!.cpu,100);
  assert.deepEqual(processDelta([{...current,startTime:'98766'}],previous,1000,100),[]);
  assert.deepEqual(processDelta([current],previous,0,100),[]);
});
test('a short process that disappears before sampling never adopts a reused root PID',async t=>{
  const root=mkdtempSync(join(tmpdir(),'activity-proc-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const fields=Array(22).fill('0');fields[0]='R';fields[1]='1';fields[11]='100';fields[12]='0';fields[19]='200';
  const samples:ProcessSample[]=[];
  const stop=watchProcessTree(42,'short-command',sample=>samples.push(sample),{root,hz:100,intervalMs:10});
  mkdirSync(join(root,'42'));writeFileSync(join(root,'42/stat'),'42 (chromium) '+fields.join(' '));
  await new Promise(resolve=>setTimeout(resolve,25));await stop();
  assert.ok(samples.length>0);assert.ok(samples.every(sample=>sample.cpu===null&&sample.processes.length===0));
});

test('projection is replayable, rejects secret fields and closes interrupted model spans while sends finish',t=>{
  const {db,activities}=fixture(t),time=Date.now();
  const events=[observation(1,'run.started',{},time),observation(2,'activity.updated',{...event('phase-a',{time:time+1,startedAt:time+1}),command:'private',url:'https://example.test/?token=private'},time+1),
    observation(3,'activity.updated',{...event('send-a',{kind:'send',name:'send',time:time+2,startedAt:time+2})},time+2),observation(4,'run.cancelled',{},time+3)];
  activities.project('worker-a',events);activities.project('worker-a',events);
  const first=activities.query(time-1,time+10);assert.equal(first.spans.length,3);assert.equal(first.spans.find(s=>s.id==='phase-a')!.status,'cancelled');assert.equal(first.spans.find(s=>s.id==='send-a')!.status,'running');
  assert.ok(!JSON.stringify(first).includes('private'));assert.equal(activities.cursor('worker-a'),4);
  activities.project('worker-a',[observation(5,'activity.updated',{...event('send-a',{kind:'send',name:'send',time:time+4,startedAt:time+2,status:'completed'})},time+4)]);
  assert.equal(activities.query(time-1,time+10).spans.find(s=>s.id==='send-a')!.status,'completed');
  assert.equal(new ActivitiesDatabase(db).cursor('worker-a'),5);
});

test('malformed optional observations cannot poison later durable observations',t=>{
  const {activities}=fixture(t);
  activities.project('worker-a',[observation(1,'activity.updated',{id:'bad'}),observation(2,'activity.updated',{...event()})]);
  assert.equal(activities.cursor('worker-a'),2);assert.equal(activities.query(0,Date.now()+1).spans.length,1);
});
test('ending an agent closes its unfinished children without prematurely finishing the reply',t=>{
  const {activities}=fixture(t),time=Date.now();
  activities.project('worker-a',[observation(1,'run.started',{},time),observation(2,'activity.updated',{...event('agent',{kind:'run',name:'run',time:time+1,startedAt:time+1})},time+1),
    observation(3,'activity.updated',{...event('child',{parentId:'agent',time:time+2,startedAt:time+2})},time+2),
    observation(4,'activity.updated',{...event('agent',{kind:'run',name:'run',time:time+3,startedAt:time+1,status:'failed'})},time+3)]);
  const rows=activities.query(time-1,time+5).spans;
  assert.equal(rows.find(span=>span.id==='child')!.status,'interrupted');assert.equal(rows.find(span=>span.id==='run:reply-a')!.status,'running');
});

test('process samples are deduplicated and scoped to both the resource and the owning instance',t=>{
  const {activities}=fixture(t),time=Date.now();
  activities.ingest(owner,event());activities.processSamples(owner,[point()]);activities.processSamples(owner,[point()]);
  activities.processSamples({resourceId:'worker-b',botId:'worker-b'},[point('phase-a',{id:'forged'})]);
  assert.equal(activities.query(time-10,time+10).processes.length,1);
  for(const botId of ['first','second']){const scope={botId,resourceId:'service:plugin-runner'};activities.ingest(scope,event('same-id'));activities.processSamples(scope,[point('same-id',{id:'same-sample',cpu:botId==='first'?30:70})]);}
  assert.equal(activities.query(time-10,time+10,{botId:'first'}).processes[0]!.cpu,30);
  assert.equal(activities.query(time-10,time+10,{botId:'second'}).processes[0]!.cpu,70);
  assert.throws(()=>activities.processSamples(owner,[point('phase-a',{cpu:NaN})]),/采样无效/u);
});
test('loss counters are cumulative per collector and idempotent across retries',t=>{
  const {activities}=fixture(t),time=Date.now();
  activities.processSamples(owner,[],5,'first');activities.processSamples(owner,[],5,'first');activities.processSamples(owner,[],3,'first');
  activities.processSamples(owner,[],7,'second');
  assert.equal(activities.query(time-10,time+10).droppedProcessSamples,12);
});

test('container generation changes interrupt only spans from before the new container start',t=>{
  const {activities}=fixture(t),time=Date.now();
  activities.resource('worker-a','old',time-10000);activities.ingest(owner,event('old',{startedAt:time-5000,time:time-5000}));activities.ingest(owner,event('new',{startedAt:time,time}));
  activities.resource('worker-a','new',time-1000);
  const rows=activities.query(time-10000,time+1).spans;assert.equal(rows.find(s=>s.id==='old')!.status,'interrupted');assert.equal(rows.find(s=>s.id==='new')!.status,'running');
});

test('plugin queues and terminal jobs retain their instance and execution location',t=>{
  const {activities}=fixture(t),time=Date.now();
  const job={id:'job-a',botId:'worker-a',pluginId:'example',sourceMessageId:'message-a',operation:'prepare',state:'queued',createdAt:time-5000};
  activities.syncPlugins([job]);activities.syncPlugins([{...job,state:'running',startedAt:time-3000}]);
  activities.ingest({resourceId:'service:plugin-runner',botId:'worker-a',jobId:'job-a'},event('render-a',{kind:'render',name:'image_render',startedAt:time-2000,time:time-2000}));
  activities.syncPlugins([{...job,state:'failed',startedAt:time-3000,finishedAt:time}]);
  const rows=activities.query(time-10000,time+1).spans;
  assert.equal(rows.find(s=>s.id==='queue:job-a')!.endedAt,time-3000);assert.equal(rows.find(s=>s.id==='render-a')!.status,'interrupted');
  assert.equal(rows.find(s=>s.id==='job:job-a')!.resourceId,'service:plugin-runner');
  activities.syncPlugins([{...job,id:'inspect-a',operation:'inspect',state:'completed',finishedAt:time}]);
  assert.equal(activities.query(time-10000,time+1).spans.find(s=>s.id==='job:inspect-a')!.resourceId,'service:console');
});
test('a completed resolve does not interrupt a follow-up in the same plugin workflow',t=>{
  const {activities}=fixture(t),time=Date.now();
  const source={id:'resolve',botId:'worker-a',pluginId:'example',sourceMessageId:'message-a',operation:'resolve',state:'completed',createdAt:time-5000,startedAt:time-4000,finishedAt:time-3000};
  activities.syncPlugins([{...source,id:'prepare',rootJobId:'resolve',operation:'prepare',state:'running',createdAt:time-3000,startedAt:time-2000,finishedAt:undefined},source]);
  const rows=activities.query(time-6000,time+1,{traceId:'job:resolve'}).spans;
  assert.equal(rows.find(s=>s.id==='job:resolve')!.status,'completed');assert.equal(rows.find(s=>s.id==='job:prepare')!.status,'running');
  assert.equal(rows.find(s=>s.id==='job:prepare')!.parentId,'job:resolve');
});
test('an expired or replaced plugin attempt is interrupted without closing the durable job',t=>{
  const {activities}=fixture(t),time=Date.now(),job={id:'job-a',botId:'worker-a',pluginId:'example',sourceMessageId:'m',operation:'prepare',state:'running',attempts:1,createdAt:time-5000,startedAt:time-4000,leaseUntil:time+1000};
  activities.syncPlugins([job]);
  activities.ingest({resourceId:'service:plugin-runner',botId:'worker-a',jobId:job.id},event('attempt',{kind:'render',name:'image_render',startedAt:time-2000,time:time-2000}));
  activities.syncPlugins([{...job,attempts:2,leaseUntil:time+5000}]);
  const rows=activities.query(time-6000,time+1).spans;
  assert.equal(rows.find(s=>s.id==='attempt')!.status,'interrupted');assert.equal(rows.find(s=>s.id==='job:job-a')!.status,'running');
});
test('monitor-only boundaries do not displace chat pages or stall conversation cursors',t=>{
  const dir=mkdtempSync(join(tmpdir(),'activity-chat-')),db=new ConsoleDatabase(join(dir,'console.sqlite3'),join(dir,'master.key'));
  t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
  const bot=db.createBot({name:'Synthetic',targetType:'group',targetId:'10001',config:{}}),time=Date.now();
  db.ingestEvents(bot.id,[observation(1,'conversation.started',{}),observation(2,'message.received',{messageId:'m1',text:'First synthetic message'}),observation(3,'message.received',{messageId:'m2',text:'Second synthetic message'}),
    ...Array.from({length:150},(_,i)=>observation(i+4,'activity.updated',{...event('phase-'+i,{time,startedAt:time})}))]);
  assert.deepEqual(db.getConversation(bot.id,undefined,2)!.items.map(item=>item.type),['message.received','message.received']);
  const delta=db.getConversationUpdate(bot.id,3,500);assert.equal(delta.cursor,153);assert.deepEqual(delta.view!.items,[]);
});

test('activity retention keeps summaries longer than details and expires process counters',t=>{
  const {db,activities}=fixture(t),day=86400000,now=Date.now(),old=now-8*day;
  activities.ingest(owner,event('detail',{startedAt:old,time:old+100,status:'completed'}));activities.ingest(owner,event('summary',{kind:'run',name:'reply',startedAt:old,time:old+100,status:'completed'}));
  activities.processSamples(owner,[point('detail',{time:now-2*day})]);activities.compact(now);
  assert.equal(activities.query(0,now).spans.length,1);assert.equal(db.prepare('SELECT COUNT(*) n FROM activity_process_samples').get()!.n,0);
  activities.compact(now+31*day);assert.equal(activities.query(0,now+31*day).spans.length,0);
});

test('container CPU uses cumulative counters over the actual sampling interval',()=>{
  const stats={cpu_stats:{cpu_usage:{total_usage:3e9}}};
  assert.equal(resourceSample('worker-a',stats,{time:1000,rx:null,tx:null,cpuNs:1e9},3000).sample.cpu,100);
  assert.equal(resourceSample('worker-a',stats,{time:1000,rx:null,tx:null,cpuNs:null},3000).sample.cpu,null);
  assert.equal(resourceSample('worker-a',stats,{time:1000,rx:null,tx:null,cpuNs:4e9},3000).sample.cpu,null);
});

class FakeDocker extends DockerClient {
  constructor(){super({socketPath:'unused',image:'unused',network:'unused',consoleUrl:'unused'});}
  override async inspect(id:string):Promise<ContainerInfo>{return {Id:'container-'+id,Config:{Labels:{'io.napcat.console.bot':id}},State:{Running:true,Status:'running'}};}
  override async stats():Promise<DockerStats>{return {cpu_stats:{cpu_usage:{total_usage:1e9}},memory_stats:{usage:1048576},networks:{eth0:{rx_bytes:1,tx_bytes:1}}};}
  override async serviceStats(service:'console'|'plugin-runner'){return {container:{Id:service,Config:{Labels:{}},State:{Running:true,Status:'running'}},stats:await this.stats()};}
}
test('monitor APIs authenticate, project durable events and sample both shared services',async t=>{
  const path=mkdtempSync(join(tmpdir(),'activity-http-'));
  const {app,db,sample,metrics}=await createConsole({dataDir:path,docker:new FakeDocker(),timers:false,staticDir:'/nonexistent'});
  t.after(async()=>{await app.close();rmSync(path,{recursive:true,force:true});});
  const bot=db.createBot({name:'Synthetic',targetType:'group',targetId:'10001',config:{}});
  assert.equal((await app.inject('/api/monitor/timeline')).statusCode,401);
  const setup=await app.inject({method:'POST',url:'/api/setup',headers:{'x-console-request':'1'},payload:{password:'synthetic-password'}}),cookie=String(setup.headers['set-cookie']).split(';')[0]!;
  const headers={cookie},worker={authorization:'Bearer '+bot.workerToken};
  const input=event();
  assert.equal((await app.inject({method:'POST',url:`/internal/workers/${bot.id}/events`,headers:worker,payload:{events:[observation(1,'activity.updated',{...input})]}})).statusCode,200);
  assert.equal((await app.inject({method:'POST',url:`/internal/workers/${bot.id}/process-samples`,headers:worker,payload:{samples:[point()],dropped:0}})).statusCode,200);
  await sample();
  const result=await app.inject({url:'/api/monitor/timeline?from=0&to='+Date.now(),headers});assert.equal(result.statusCode,400,'ranges over 31 days are bounded');
  const timeline=await app.inject({url:`/api/monitor/timeline?from=${Date.now()-60000}&to=${Date.now()+10}`,headers});assert.equal(timeline.statusCode,200);assert.equal(timeline.json().spans.length,1);assert.equal(timeline.json().processes.length,1);
  const queried=await app.inject({url:`/api/metrics?from=${Date.now()-60000}&to=${Date.now()+10}`,headers});assert.equal(queried.json().resources.length,3);
  const ids=new Set(metrics.query(Date.now()-60000,Date.now()+100).samples.map(s=>s.botId));assert.ok(ids.has(bot.id));assert.ok(ids.has('service:console'));assert.ok(ids.has('service:plugin-runner'));
  assert.equal((await app.inject({method:'POST',url:'/internal/plugin-runner/jobs/invalid/observations',payload:{events:[]}})).statusCode,401);
  db.setDesiredState(bot.id,'running');db.plugins.update(bot.id,'bilibili',{expectedRevision:0,enabled:true});
  db.plugins.register(bot.id,{post_type:'message',message_type:'group',message_id:'synthetic-source',user_id:'10002',self_id:'10003',group_id:'10001',message:[{type:'text',data:{text:'https://www.bilibili.com/video/BV1234567890'}}]});
  const runner={authorization:'Bearer '+db.pluginRunnerToken()},claim=await app.inject({method:'POST',url:'/internal/plugin-runner/claim',headers:runner,payload:{}}),job=claim.json().job;
  assert.ok(job);const observations={events:[{...event('runner-stage'),botId:'another-instance',resourceId:'another-resource'}],samples:[],dropped:0};
  assert.equal((await app.inject({method:'POST',url:`/internal/plugin-runner/jobs/${job.id}/observations`,headers:runner,payload:{lease:'wrong',...observations}})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url:`/internal/plugin-runner/jobs/${job.id}/observations`,headers:runner,payload:{lease:job.lease,...observations}})).statusCode,200);
  const recorded=metrics.activities.query(Date.now()-60000,Date.now()+100).spans.find(s=>s.id==='runner-stage')!;
  assert.equal(recorded.botId,bot.id);assert.equal(recorded.resourceId,'service:plugin-runner');
  const completed=await app.inject({method:'POST',url:`/internal/plugin-runner/jobs/${job.id}/result`,headers:runner,payload:{lease:job.lease,result:{error:'PLUGIN_OPERATION_FAILED'},observations:{events:[{id:'malformed'}],samples:[]}}});
  assert.equal(completed.statusCode,200);assert.equal(completed.json().accepted,true,'invalid telemetry does not fail the business result');
  assert.equal((await app.inject({method:'POST',url:`/internal/plugin-runner/jobs/${job.id}/observations`,headers:runner,payload:{lease:job.lease,...observations}})).statusCode,400);
});
