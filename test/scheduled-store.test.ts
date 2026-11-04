import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScheduledStore } from '../src/scheduled-store.js';
import type { ScheduledTask } from '../src/scheduled-contract.js';

const now=Date.parse('2026-01-02T00:00:00Z');
function task(overrides:Partial<ScheduledTask>={}):ScheduledTask{return {id:'task-demo',botId:'bot-demo',name:'Morning',kind:'model',enabled:true,
 schedule:{kind:'cron',expression:'* * * * *',timezone:'Asia/Shanghai'},instructions:'Say hello',script:null,context:{taskState:true},maxDelaySeconds:600,timeoutSeconds:120,notifyOnFailure:false,
 revision:1,creatorId:'2001',createdAt:now-24*3600000,updatedAt:now-24*3600000,deletedAt:null,...overrides};}

test('materializes latest due occurrence, advances schedule and never duplicates a slot',()=>{
 const store=new ScheduledStore(':memory:');try{
  store.sync([task()],now);store.materializeDue(now,'chat');const run=store.nextQueued()!;
  assert.equal(run.scheduledAt,now);assert.equal(store.task('task-demo')!.nextRunAt,now+60000);
  store.materializeDue(now,'chat');assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM scheduled_runs').get()!.n,1);
  store.materializeDue(now+60000,'chat');assert.equal(store.nextQueued()!.scheduledAt,now+60000);assert.equal(store.run(run.id)!.status,'missed');
 }finally{store.close();}
});

test('records an expired one-off without replaying it after restart or sync',()=>{
 const store=new ScheduledStore(':memory:');try{
  store.sync([task({schedule:{kind:'once',at:new Date(now-3600000).toISOString(),timezone:'Asia/Shanghai'},updatedAt:now-7200000})],now);
  store.materializeDue(now,'chat');assert.equal(store.nextQueued(),null);assert.equal(store.task('task-demo')!.nextRunAt,null);
  store.sync([task({schedule:{kind:'once',at:new Date(now-3600000).toISOString(),timezone:'Asia/Shanghai'},updatedAt:now-7200000})],now);store.materializeDue(now,'chat');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM scheduled_runs').get()!.n,1);
  assert.equal(store.db.prepare('SELECT status FROM scheduled_runs').get()!.status,'missed');
 }finally{store.close();}
});

test('revision changes cancel queued work and task state uses bounded CAS checkpoints',()=>{
 const store=new ScheduledStore(':memory:');try{
  store.sync([task()],now);store.materializeDue(now,'chat');const queued=store.nextQueued()!;const run=store.startRun(queued.id,now)!;
  assert.equal(store.readState(run.taskId).version,0);
  const state=store.saveState(run.taskId,run.id,{price:'1000.00'},0,now);assert.equal(state.version,1);
  assert.throws(()=>store.saveState(run.taskId,run.id,{price:'wrong'},0,now),/VERSION_CONFLICT/);
  assert.throws(()=>store.saveState('other-task',run.id,{},0,now),/UNAVAILABLE/);
  assert.throws(()=>store.saveState(run.taskId,run.id,{tooLarge:'x'.repeat(17000)},1,now),/TOO_LARGE/);
  store.finishRun(run.id,'failed','PI_EXECUTION_FAILED',now+5);assert.equal(store.readState(run.taskId).data.price,'1000.00');
  assert.throws(()=>store.saveState(run.taskId,run.id,{},1,now),/UNAVAILABLE/);
  store.materializeDue(now+60000,'chat');const next=store.nextQueued()!;
  store.sync([task({revision:2,enabled:false,updatedAt:now+60001})],now+60001);assert.equal(store.run(next.id)!.status,'missed');assert.equal(store.nextQueued(),null);
 }finally{store.close();}
});

test('manual and reset tickets are durable and do not repeat',()=>{
 const store=new ScheduledStore(':memory:');try{
  store.sync([task()],now);const ticket={id:'ticket-1',taskId:'task-demo',operation:'run' as const};
  store.ticket(ticket,now,'chat');store.ticket(ticket,now+1,'chat');assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM scheduled_runs').get()!.n,1);
  const run=store.startRun(store.nextQueued()!.id,now)!;store.saveState(run.taskId,run.id,{remember:true},0,now);
  const reset={id:'reset-1',taskId:'task-demo',operation:'reset-state' as const};store.ticket(reset,now+5,'chat');store.ticket(reset,now+6,'chat');
  assert.deepEqual(store.readState(run.taskId).data,{});assert.equal(store.readState(run.taskId).version,2);
 }finally{store.close();}
});

test('restart marks started runs interrupted and does not resend accepted or attempted requests',()=>{
 const directory=mkdtempSync(join(tmpdir(),'scheduled-recovery-'));const path=join(directory,'tasks.sqlite3');
 let store=new ScheduledStore(path);try{
  store.sync([task()],now);store.materializeDue(now,'chat');const run=store.startRun(store.nextQueued()!.id,now)!;
  const first=store.beginDelivery(run.id,{messages:[{type:'text',text:'hello'}]},now);store.beginAttempt(first);store.finishDelivery(first,'acknowledged',1,now);
  const second=store.beginDelivery(run.id,{messages:[{type:'text',text:'second'}]},now);assert.equal(store.beginAttempt(second),true);assert.equal(store.beginAttempt(second),false);
  const third=store.beginDelivery(run.id,{messages:[{type:'text',text:'not attempted'}]},now);
  store.close();store=new ScheduledStore(path);store.recoverInterrupted(now+1);
  assert.equal(store.run(run.id)!.status,'interrupted');assert.equal(store.run(run.id)!.deliveryStatus,'partial');assert.equal(store.run(run.id)!.acknowledgedMessages,1);
  assert.equal(store.db.prepare('SELECT status FROM scheduled_requests WHERE id=?').get(second)!.status,'unconfirmed');assert.equal(store.db.prepare('SELECT status FROM scheduled_requests WHERE id=?').get(third)!.status,'failed');
  assert.equal(store.nextQueued(),null);
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test('outbox records recoverable state and run events with a durable sequence',()=>{
 const store=new ScheduledStore(':memory:');try{
  store.sync([task()],now);store.materializeDue(now,'chat');const run=store.startRun(store.nextQueued()!.id,now)!;
  store.event(run,'thinking.updated',{text:'visible reasoning'},now);store.saveState(run.taskId,run.id,{checkpoint:1},0,now);
  const pending=store.pendingEvents();assert.ok(pending.some(event=>event.type==='schedule.state.updated'));assert.ok(pending.some(event=>event.type==='schedule.run.event'));
  store.markExported(pending.at(-1)!.seq);assert.deepEqual(store.pendingEvents(),[]);
 }finally{store.close();}
});

test('mixed failed and unconfirmed sends never claim partial delivery when no message was acknowledged',()=>{
 const store=new ScheduledStore(':memory:');try{
  store.sync([task()],now);store.materializeDue(now,'chat');const run=store.startRun(store.nextQueued()!.id,now)!;
  const first=store.beginDelivery(run.id,{messages:[{type:'text',text:'failed'}]},now);store.finishDelivery(first,'failed',0,now);
  const second=store.beginDelivery(run.id,{messages:[{type:'text',text:'unconfirmed'}]},now);store.finishDelivery(second,'unconfirmed',0,now);
  assert.equal(store.run(run.id)!.deliveryStatus,'unconfirmed');assert.equal(store.run(run.id)!.acknowledgedMessages,0);
  const third=store.beginDelivery(run.id,{messages:[{type:'text',text:'confirmed'}]},now);store.finishDelivery(third,'acknowledged',1,now);
  assert.equal(store.run(run.id)!.deliveryStatus,'partial');assert.equal(store.run(run.id)!.acknowledgedMessages,1);
 }finally{store.close();}
});
