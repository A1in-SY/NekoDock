import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ConsoleDatabase } from '../src/console/database.js';
import { createConsole } from '../src/console/server.js';
import { DockerClient } from '../src/console/docker.js';
import type { ScheduledRun, ScheduledTask } from '../src/scheduled-contract.js';

function fixture(t:test.TestContext) {
  const directory=mkdtempSync(join(tmpdir(),'schedule-console-'));const path=join(directory,'console.sqlite3');
  const db=new ConsoleDatabase(path,join(directory,'master.key'));
  t.after(()=>{db.close();rmSync(directory,{recursive:true,force:true});});
  const bot=db.createBot({name:'First',targetType:'group',targetId:'10001',config:{modelApiKey:'synthetic-model-key'}});
  const other=db.createBot({name:'Second',targetType:'private',targetId:'10002',config:{}});
  return {db,bot,other,path};
}
const input=(name='Daily report')=>({name,kind:'model',instructions:'private-test-instruction',schedule:{kind:'cron',expression:'0 8 * * *',timezone:'Asia/Shanghai'}});

test('task definitions encrypt content, bind owners and bots, and apply optimistic revisions',t=>{
  const {db,bot,other,path}=fixture(t);const task=db.tasks.create(bot.id,input(),'1001');
  assert.equal(task.revision,1);assert.equal(task.creatorId,'1001');assert.equal(task.appliedRevision,0);
  const inspector=new DatabaseSync(path,{readOnly:true});t.after(()=>inspector.close());
  assert.equal(JSON.stringify(inspector.prepare('SELECT * FROM scheduled_tasks').all()).includes('private-test-instruction'),false);
  assert.equal(db.tasks.get(other.id,task.id),null);
  assert.throws(()=>db.tasks.update(other.id,task.id,1,{name:'bad'}),/任务不存在/);
  assert.throws(()=>db.tasks.update(bot.id,task.id,1,{botId:other.id}),/不可修改/);
  assert.equal(db.tasks.update(bot.id,task.id,1,{name:'New title'}).revision,2);
  assert.throws(()=>db.tasks.update(bot.id,task.id,1,{enabled:false}),/版本冲突/);
  assert.equal(db.tasks.delete(bot.id,task.id,2).revision,3);
  assert.equal(db.tasks.list(bot.id).length,0);assert.equal(db.tasks.snapshot(bot.id).tasks[0]!.deletedAt!==null,true);
  assert.equal(db.getBot(bot.id)!.desiredRevision,1,'task edits do not require a worker configuration restart');
  assert.throws(()=>db.tasks.create(bot.id,{...input(),kind:'script',script:{runtime:'python',source:'print(1)'}}),/命令执行权限/);
});

test('chat task tools enforce creator ownership and persist idempotent results after updates',t=>{
  const {db,bot}=fixture(t);const request={operation:'create',sourceMessageId:'message-1',task:input()};
  const created=db.tasks.manage(bot.id,'tool-call-1',request,'1001') as {id:string;revision:number};
  assert.deepEqual(db.tasks.manage(bot.id,'tool-call-1',request,'1001'),created);
  assert.equal(db.tasks.list(bot.id).length,1);
  assert.throws(()=>db.tasks.manage(bot.id,'tool-call-1',{...request,task:input('Different')},'1001'),/不同请求/);
  const edit={operation:'update',sourceMessageId:'message-2',taskId:created.id,expectedRevision:1,task:{name:'Updated'}};
  assert.throws(()=>db.tasks.manage(bot.id,'tool-call-2',edit,'1002'),/创建者/);
  const updated=db.tasks.manage(bot.id,'tool-call-2',edit,'1001');
  assert.deepEqual(db.tasks.manage(bot.id,'tool-call-2',edit,'1001'),updated);
  const list=db.tasks.manage(bot.id,'tool-call-3',{operation:'list',sourceMessageId:'message-3'},'1002') as Array<Record<string,unknown>>;
  assert.equal(list.length,1);assert.equal(list[0]!.instructions,undefined);assert.equal(list[0]!.script,undefined);
  const owned=db.tasks.manage(bot.id,'tool-call-4',{operation:'list',sourceMessageId:'message-4'},'1001') as Array<Record<string,unknown>>;
  assert.equal(owned[0]!.instructions,'private-test-instruction');
  assert.equal(owned[0]!.name,'Updated');assert.equal(owned[0]!.revision,2);
});

test('task list exposes the original script only to its creator for subsequent edits',t=>{
  const {db,bot}=fixture(t);db.updateBot(bot.id,{expectedRevision:1,config:{allowCommands:true}});
  const task=db.tasks.create(bot.id,{...input(),kind:'script',script:{runtime:'python',source:"from nekodock_tasks import send_message\nsend_message({'messages':[{'type':'text','text':'original greeting'}]})"}},'1001');
  db.tasks.create(bot.id,input('Console task'));
  const owned=db.tasks.manage(bot.id,'owner-list',{operation:'list',sourceMessageId:'source-1'},'1001') as Array<Record<string,unknown>>;
  const original=owned.find(item=>item.id===task.id)!;
  assert.equal((original.script as {source:string}).source,task.script!.source);
  assert.equal(original.instructions,task.instructions);
  assert.equal(owned.find(item=>item.name==='Console task')!.instructions,undefined);
  const changedSource=(original.script as {source:string}).source.replace('original greeting','updated greeting');
  db.tasks.manage(bot.id,'owner-update',{operation:'update',sourceMessageId:'source-2',taskId:task.id,expectedRevision:original.revision,task:{script:{runtime:'python',source:changedSource}}},'1001');
  assert.equal(db.tasks.get(bot.id,task.id)!.script!.source,changedSource);
  const shared=db.tasks.manage(bot.id,'nonowner-list',{operation:'list',sourceMessageId:'source-3'},'1002') as Array<Record<string,unknown>>;
  assert.equal(shared.find(item=>item.id===task.id)!.script,undefined);
  assert.equal(shared.find(item=>item.id===task.id)!.instructions,undefined);
});

test('shared task editing exposes full definitions and permits other members to edit, pause, resume and delete',t=>{
  const {db,bot}=fixture(t);
  db.updateBot(bot.id,{expectedRevision:1,config:{allowCommands:true,taskCreatorOnly:false}});
  const definition={...input(),kind:'script',script:{runtime:'python',source:'print("original")'},context:{taskState:true}};
  const created=db.tasks.manage(bot.id,'shared-create',{operation:'create',sourceMessageId:'source-create',task:definition},'1001') as ScheduledTask;
  const consoleTask=db.tasks.create(bot.id,input('Console task'));
  assert.equal(created.creatorId,'1001');assert.equal(consoleTask.creatorId,null);
  const listed=db.tasks.manage(bot.id,'shared-list',{operation:'list',sourceMessageId:'source-list'},'1002') as ScheduledTask[];
  assert.equal(listed.find(task=>task.id===created.id)!.script!.source,definition.script.source);
  assert.equal(listed.find(task=>task.id===created.id)!.context.taskState,true);
  assert.equal(listed.find(task=>task.id===consoleTask.id)!.instructions,'private-test-instruction');
  const edit={operation:'update',sourceMessageId:'source-edit',taskId:created.id,expectedRevision:1,task:{script:{runtime:'python',source:'print("updated")'}}};
  const updated=db.tasks.manage(bot.id,'shared-edit',edit,'1002') as ScheduledTask;
  assert.equal(updated.script!.source,'print("updated")');assert.equal(updated.creatorId,'1001');
  const pause=db.tasks.manage(bot.id,'shared-pause',{operation:'update',sourceMessageId:'source-pause',taskId:created.id,expectedRevision:2,task:{enabled:false}},'1002') as ScheduledTask;
  assert.equal(pause.enabled,false);
  const resume=db.tasks.manage(bot.id,'shared-resume',{operation:'update',sourceMessageId:'source-resume',taskId:created.id,expectedRevision:3,task:{enabled:true}},'1002') as ScheduledTask;
  assert.equal(resume.enabled,true);
  const removed=db.tasks.manage(bot.id,'shared-delete',{operation:'delete',sourceMessageId:'source-delete',taskId:created.id,expectedRevision:4},'1002') as ScheduledTask;
  assert.notEqual(removed.deletedAt,null);assert.equal(removed.creatorId,'1001');
  const editedConsole=db.tasks.manage(bot.id,'console-edit',{operation:'update',sourceMessageId:'source-console-edit',taskId:consoleTask.id,expectedRevision:1,task:{name:'Edited through chat'}},'1002') as ScheduledTask;
  assert.equal(editedConsole.name,'Edited through chat');assert.equal(editedConsole.creatorId,null);
  const deletedConsole=db.tasks.manage(bot.id,'console-delete',{operation:'delete',sourceMessageId:'source-console-delete',taskId:consoleTask.id,expectedRevision:2},'1002') as ScheduledTask;
  assert.notEqual(deletedConsole.deletedAt,null);
  db.updateBot(bot.id,{expectedRevision:2,config:{taskCreatorOnly:true}});
  assert.deepEqual(db.tasks.manage(bot.id,'shared-edit',edit,'1002'),updated,'replaying an accepted operation returns its receipt without another edit');
  assert.equal(db.tasks.get(bot.id,created.id)!.revision,5);
});

test('creator-only policy switches both detail visibility and edit authorization without changing task ownership',t=>{
  const {db,bot,other}=fixture(t);
  const task=db.tasks.create(bot.id,input(),'1001');
  const consoleTask=db.tasks.create(bot.id,input('Console task'));
  const request={operation:'update',sourceMessageId:'source-edit',taskId:task.id,expectedRevision:1,task:{name:'Shared title'}};
  const list=(id:string)=>db.tasks.manage(bot.id,id,{operation:'list',sourceMessageId:'source-list'},'1002') as Array<Record<string,unknown>>;
  assert.equal(db.getBot(bot.id)!.config.taskCreatorOnly,true);
  assert.equal(list('restricted-list').find(item=>item.id===task.id)!.instructions,undefined);
  assert.throws(()=>db.tasks.manage(bot.id,'restricted-edit',request,'1002'),/创建者/);
  assert.throws(()=>db.tasks.manage(bot.id,'restricted-console-delete',{operation:'delete',sourceMessageId:'source-delete',taskId:consoleTask.id,expectedRevision:1},'1002'),/创建者/);
  db.updateBot(bot.id,{expectedRevision:1,config:{taskCreatorOnly:false}});
  assert.equal(list('unrestricted-list').find(item=>item.id===task.id)!.instructions,'private-test-instruction');
  const updated=db.tasks.manage(bot.id,'unrestricted-edit',request,'1002') as ScheduledTask;
  assert.equal(updated.name,'Shared title');assert.equal(updated.creatorId,'1001');
  const isolated=db.tasks.create(other.id,input('Other bot task'),'1001');
  assert.throws(()=>db.tasks.manage(other.id,'other-bot-edit',{...request,taskId:isolated.id},'1002'),/创建者/);
  db.updateBot(bot.id,{expectedRevision:2,config:{taskCreatorOnly:true}});
  assert.equal(list('restricted-again-list').find(item=>item.id===task.id)!.instructions,undefined);
  assert.throws(()=>db.tasks.manage(bot.id,'restricted-again-edit',{...request,expectedRevision:2},'1002'),/创建者/);
  assert.throws(()=>db.tasks.manage(bot.id,'restricted-again-delete',{operation:'delete',sourceMessageId:'source-delete',taskId:task.id,expectedRevision:2},'1002'),/创建者/);
  const adminUpdate=db.tasks.update(bot.id,task.id,2,{name:'Console title'});
  assert.equal(adminUpdate.creatorId,'1001');assert.equal(adminUpdate.name,'Console title');
  const ownerUpdate=db.tasks.manage(bot.id,'owner-edit',{...request,expectedRevision:3},'1001') as ScheduledTask;
  assert.equal(ownerUpdate.revision,4);
  assert.notEqual(db.tasks.delete(bot.id,consoleTask.id,1).deletedAt,null,'Console management remains unrestricted');
});

test('shared task editing preserves actor, source, revision, instance and script-permission checks',t=>{
  const {db,bot,other}=fixture(t);
  db.updateBot(bot.id,{expectedRevision:1,config:{taskCreatorOnly:false}});
  const task=db.tasks.create(bot.id,input(),'1001');
  const foreignTask=db.tasks.create(other.id,input('Foreign task'),'1001');
  const edit={operation:'update',sourceMessageId:'source-edit',taskId:task.id,expectedRevision:1,task:{name:'Shared title'}};
  assert.throws(()=>db.tasks.manage(bot.id,'invalid-actor',edit,''),/创建者无效/);
  assert.throws(()=>db.tasks.manage(bot.id,'invalid-source',{...edit,sourceMessageId:''},'1002'),/任务操作无效/);
  assert.throws(()=>db.tasks.manage(bot.id,'foreign-task',{...edit,taskId:foreignTask.id},'1002'),/任务不存在/);
  assert.throws(()=>db.tasks.manage(bot.id,'stale-revision',{...edit,expectedRevision:2},'1002'),/版本冲突/);
  assert.throws(()=>db.tasks.manage(bot.id,'change-owner',{...edit,task:{creatorId:'1002'}},'1002'),/不可修改/);
  assert.throws(()=>db.tasks.manage(bot.id,'forbidden-script',{...edit,task:{kind:'script',script:{runtime:'python',source:'print(1)'}}},'1002'),/命令执行权限/);
  const updated=db.tasks.manage(bot.id,'valid-edit',edit,'1002') as ScheduledTask;
  assert.equal(updated.revision,2);assert.equal(updated.creatorId,'1001');
  assert.throws(()=>db.tasks.manage(bot.id,'stale-delete',{operation:'delete',sourceMessageId:'source-delete',taskId:task.id,expectedRevision:1},'1002'),/版本冲突/);
});

test('worker task synchronization, run projection and state remain isolated from the primary session',t=>{
  const {db,bot,other}=fixture(t);const task=db.tasks.create(bot.id,input());
  assert.deepEqual(db.tasks.authorize(bot.id,task.id,1),{authorized:false});db.setDesiredState(bot.id,'running');
  assert.deepEqual(db.tasks.authorize(bot.id,task.id,1),{authorized:true});
  assert.deepEqual(db.tasks.authorize(other.id,task.id,1),{authorized:false});
  const requested=db.tasks.request(bot.id,task.id,'run');assert.equal(db.tasks.snapshot(bot.id).tickets[0]!.id,requested.ticketId);
  db.tasks.applied(bot.id,{tasks:[{id:task.id,revision:1,nextRunAt:123456}],acknowledgedTickets:[requested.ticketId]});
  assert.equal(db.tasks.snapshot(bot.id).tickets.length,0);assert.equal(db.tasks.get(bot.id,task.id)!.appliedRevision,1);
  const run:ScheduledRun={id:'run-1',taskId:task.id,taskRevision:1,scheduledAt:123456,startedAt:123457,finishedAt:null,status:'running',deliveryStatus:'none',acceptedMessages:0,acknowledgedMessages:0,manual:true,conversationId:'main-chat'};
  const event=(seq:number,type:string,payload:Record<string,unknown>)=>({seq,type,payload,time:123457+seq,conversationId:'main-chat',runId:run.id});
  db.ingestEvents(bot.id,[
    {seq:1,type:'conversation.started',payload:{},time:123450,conversationId:'main-chat'},
    event(2,'schedule.run.updated',{run}),
    event(3,'schedule.run.event',{taskId:task.id,eventType:'usage.recorded',eventPayload:{input:9999,output:999}}),
    event(4,'schedule.run.event',{taskId:task.id,eventType:'context.updated',eventPayload:{used:999999,window:999999}}),
    event(5,'schedule.state.updated',{taskId:task.id,state:{version:1,data:{observedPrice:'1000.00'},updatedAt:123457,sourceRunId:run.id}}),
    event(6,'schedule.run.updated',{run:{...run,status:'failed',finishedAt:123463,error:'bridge 524',deliveryStatus:'acknowledged',acceptedMessages:1,acknowledgedMessages:1}}),
  ]);
  assert.equal(db.tasks.runs(bot.id,task.id)[0]!.status,'failed');
  const detail=db.tasks.detail(bot.id,run.id)!;
  assert.equal(detail.run.deliveryStatus,'acknowledged');assert.equal(detail.taskState!.data.observedPrice,'1000.00');
  assert.equal(detail.events.some(event=>event.type==='usage.recorded'),true);
  assert.equal(db.tasks.detail(other.id,run.id),null);
  assert.equal(db.getConversation(bot.id)!.usage.total,null);assert.notEqual(db.getConversation(bot.id)!.context.used,999999);
  assert.equal(db.listChanges(0,100).some(change=>change.type==='schedule.event'),true);
  const paused=db.tasks.update(bot.id,task.id,1,{enabled:false});assert.deepEqual(db.tasks.authorize(bot.id,task.id,paused.revision),{authorized:false});
});

test('expired one-time tasks can be renamed or paused without changing their schedule',t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.UTC(2026,0,1)});
  const {db,bot}=fixture(t);const task=db.tasks.create(bot.id,{...input(),schedule:{kind:'once',at:'2026-01-01T01:00:00Z',timezone:'Asia/Shanghai'}});
  t.mock.timers.tick(2*3600000);
  assert.equal(db.tasks.update(bot.id,task.id,1,{enabled:false}).enabled,false);
  assert.throws(()=>db.tasks.update(bot.id,task.id,2,{schedule:{kind:'once',at:'2025-12-31T01:00:00Z',timezone:'Asia/Shanghai'}}),/晚于当前时间/);
});

test('revoking script permission prevents authorization and manual execution while allowing pause',t=>{
  const {db,bot}=fixture(t);db.updateBot(bot.id,{expectedRevision:1,config:{allowCommands:true}});
  const task=db.tasks.create(bot.id,{...input(),kind:'script',script:{runtime:'python',source:'print(1)'}});
  db.setDesiredState(bot.id,'running');assert.equal(db.tasks.authorize(bot.id,task.id,1).authorized,true);
  db.updateBot(bot.id,{expectedRevision:2,config:{allowCommands:false}});
  assert.equal(db.tasks.authorize(bot.id,task.id,1).authorized,false);
  assert.throws(()=>db.tasks.request(bot.id,task.id,'run'),/命令执行权限/);
  assert.throws(()=>db.tasks.update(bot.id,task.id,1,{enabled:false,script:{runtime:'python',source:'print(2)'}}),/命令执行权限/);
  assert.equal(db.tasks.update(bot.id,task.id,1,{enabled:false}).enabled,false);
});

test('run detail advances raw event cursors while collapsing cumulative thinking and bounding pages',t=>{
  const {db,bot}=fixture(t);const task=db.tasks.create(bot.id,input());
  const run:ScheduledRun={id:'paged-run',taskId:task.id,taskRevision:1,scheduledAt:1,startedAt:1,finishedAt:null,status:'running',deliveryStatus:'none',acceptedMessages:0,acknowledgedMessages:0,manual:false,conversationId:'main-chat'};
  db.ingestEvents(bot.id,[{seq:1,type:'schedule.run.updated',payload:{run},time:1,runId:run.id}]);
  const events=Array.from({length:600},(_,i)=>({seq:i+2,type:'schedule.run.event',time:i+2,runId:run.id,payload:{taskId:task.id,eventType:'thinking.updated',eventPayload:{itemId:'thought-1',text:`cumulative ${i}`}}}));
  db.ingestEvents(bot.id,events);
  const snapshot=db.tasks.detail(bot.id,run.id)!;assert.equal(snapshot.cursor,601);assert.equal(snapshot.hasMore,false);assert.equal(snapshot.events.length,1);assert.equal(snapshot.events[0]!.seq,601);
  const first=db.tasks.detail(bot.id,run.id,0)!;assert.equal(first.cursor,500);assert.equal(first.hasMore,true);assert.equal(first.events.length,2);assert.equal(first.events.at(-1)!.seq,500);
  const second=db.tasks.detail(bot.id,run.id,first.cursor)!;assert.equal(second.cursor,601);assert.equal(second.hasMore,false);assert.equal(second.events.length,1);
  const empty=db.tasks.detail(bot.id,run.id,601)!;assert.equal(empty.events.length,0);assert.equal(empty.cursor,601);
  const restored=db.tasks.detail(bot.id,run.id,700)!;assert.equal(restored.events.length,0);assert.equal(restored.cursor,601);
});

class FakeDocker extends DockerClient { constructor(){super({socketPath:'unused',image:'unused',network:'unused',consoleUrl:'unused'});} override async inspect(){return null;} override async create(){} override async start(){} }
test('task HTTP endpoints protect mutations, isolate workers, preview schedules and expose run details',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'schedule-http-'));const {app,db}=await createConsole({dataDir:directory,docker:new FakeDocker(),timers:false,staticDir:'/nonexistent'});
  t.after(async()=>{await app.close();rmSync(directory,{recursive:true,force:true});});
  const setup=await app.inject({method:'POST',url:'/api/setup',headers:{'x-console-request':'1'},payload:{password:'synthetic-long-password'}});
  const logged={'x-console-request':'1',cookie:setup.headers['set-cookie']!.toString().split(';')[0]!};
  const bot=db.createBot({name:'HTTP bot',targetType:'group',targetId:'10001',config:{}});
  const worker={authorization:`Bearer ${bot.workerToken}`};
  const base=`/api/bots/${bot.id}/tasks`,internal=`/internal/workers/${bot.id}/tasks`;
  assert.equal((await app.inject(base)).statusCode,401);
  assert.equal((await app.inject({method:'POST',url:base,headers:{cookie:logged.cookie},payload:input()})).statusCode,403);
  const preview=await app.inject({method:'POST',url:`${base}/preview`,headers:logged,payload:input()});
  assert.equal(preview.statusCode,200,preview.body);assert.equal(preview.json().nextRuns.length,3);assert.equal(db.tasks.list(bot.id).length,0);
  const created=await app.inject({method:'POST',url:base,headers:logged,payload:input()});assert.equal(created.statusCode,201,created.body);const task=created.json();
  assert.equal((await app.inject({url:internal})).statusCode,401);
  assert.equal((await app.inject({url:internal,headers:worker})).json().tasks.length,1);
  const update=await app.inject({method:'PUT',url:`${base}/${task.id}`,headers:logged,payload:{expectedRevision:1,name:'Renamed'}});assert.equal(update.statusCode,200,update.body);
  assert.equal((await app.inject({method:'PUT',url:`${base}/${task.id}`,headers:logged,payload:{expectedRevision:1,name:'Stale'}})).statusCode,409);
  assert.equal((await app.inject({url:`${base}/runs/nonexistent`,headers:logged})).statusCode,404);
  db.setDesiredState(bot.id,'running');
  const run=await app.inject({method:'POST',url:`${base}/${task.id}/run`,headers:logged,payload:{}});assert.equal(run.statusCode,202,run.body);
  const authorize=await app.inject({method:'POST',url:`${internal}/authorize`,headers:worker,payload:{taskId:task.id,revision:2}});assert.deepEqual(authorize.json(),{authorized:true});
  const applied=await app.inject({method:'POST',url:`${internal}/applied`,headers:worker,payload:{tasks:[{id:task.id,revision:2,nextRunAt:null}],acknowledgedTickets:[run.json().ticketId]}});assert.equal(applied.statusCode,200,applied.body);
  assert.equal((await app.inject({method:'DELETE',url:`${base}/${task.id}`,headers:logged,payload:{expectedRevision:2}})).statusCode,200);
});
