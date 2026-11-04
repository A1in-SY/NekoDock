import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeStore } from '../src/store.js';
import { buildTaskHistory, taskHistoryRange } from '../src/task-history.js';
import { validateTask, nextTaskTime, previousTaskTime } from '../src/schedule.js';
import type { ScheduledTask } from '../src/scheduled-contract.js';

function task():ScheduledTask {return {...validateTask({name:'Daily summary',kind:'model',instructions:'Summarize this day.',schedule:{kind:'cron',expression:'0 23 * * *'},context:{taskState:true,chatHistory:{range:'scheduled_day'}}}),id:'task-example',botId:'bot-example',revision:1,creatorId:null,createdAt:0,updatedAt:0,deletedAt:null};}
test('task history uses scheduled local-day boundaries and calendar days across DST',()=>{
 const value=task();assert.deepEqual(taskHistoryRange(value,Date.parse('2026-10-28T15:00:00Z')),{from:Date.parse('2026-10-27T16:00:00Z'),to:Date.parse('2026-10-28T15:00:00Z')});
 value.context.chatHistory!.range='previous_day';value.schedule.timezone='America/New_York';
 const range=taskHistoryRange(value,Date.parse('2026-11-02T17:00:00Z'));assert.equal(range.to-range.from,25*3600000);
 assert.equal(range.from,Date.parse('2026-11-01T04:00:00Z'));assert.equal(range.to,Date.parse('2026-11-02T05:00:00Z'));
});
test('task history reads untriggered raw messages across new conversations with truthful coverage',()=>{
 const store=new BridgeStore(':memory:',{type:'group',id:'1001'});const value=task();
 try {
  for(let i=0;i<4;i++)store.insert({messageId:`m${i}`,senderId:'101',senderName:'A',time:Date.parse(`2026-10-28T0${i}:00:00+08:00`)/1000,text:`background ${i}`,replyTo:null,trigger:false,rawJson:'{}'});
  store.recorder.reset(2,'new-example');
  const full=buildTaskHistory(store,value,Date.parse('2026-10-28T23:00:00+08:00'));
  assert.equal(full.chatCoverage!.availableCount,4);assert.equal(full.chatCoverage!.truncated,false);assert.equal(full.chatMessages![0]!.text,'background 0');
  value.context.chatHistory!.maxMessages=2;
  const limited=buildTaskHistory(store,value,Date.parse('2026-10-28T23:00:00+08:00'));
  assert.equal(limited.chatCoverage!.availableCount,4);assert.equal(limited.chatCoverage!.includedCount,2);assert.equal(limited.chatCoverage!.truncated,true);
  assert.deepEqual(limited.chatMessages!.map(m=>m.id),['m2','m3']);
 }finally{store.close();}
});
test('scheduled messages remain pending until Pi commits and are not reimported after new',()=>{
 const store=new BridgeStore(':memory:',{type:'group',id:'1001'});
 try {
  store.recordTaskReply('d1','Scheduled report','t1',store.recorder.conversationId,'q1');
  assert.equal(store.takeExternalMessages()[0]!.text,'Scheduled report');assert.equal(store.takeExternalMessages()[0]!.text,'Scheduled report');
  store.insert({messageId:'question',senderId:'101',senderName:'A',time:1,text:'question',replyTo:null,trigger:true,rawJson:'{}'});
  const context=store.prepareContext(store.openOrCreateBatch(50)!);
  store.commitContext({batchId:context.batchId,conversationId:context.conversationId,session:'session-example',entryId:'entry-example',versions:context.versions});
  assert.deepEqual(store.takeExternalMessages(),[]);
  store.recordTaskReply('d2','Old conversation report','t1',store.recorder.conversationId,'q2');store.recorder.reset(0,'new');
  assert.deepEqual(store.takeExternalMessages(),[]);
 }finally{store.close();}
});
test('minute schedules preserve timezone and previous occurrence boundaries',()=>{
 const value=task();value.schedule={kind:'cron',expression:'* * * * *',timezone:'Asia/Shanghai'};
 const at=Date.parse('2026-10-28T08:00:00+08:00');
 assert.equal(previousTaskTime(value,at),at);assert.equal(previousTaskTime(value,at-1),at-60000);assert.equal(nextTaskTime(value,at),at+60000);
 assert.throws(()=>validateTask({name:'x',kind:'script',schedule:value.schedule,script:{runtime:'python',source:'print(1)'}},false),/权限/);
 assert.throws(()=>validateTask({name:'x',kind:'model',instructions:'x',schedule:{kind:'cron',expression:'* * * * * *'}}),/五段/);
});

test('chat history includes other tasks confirmed broadcasts while excluding its own output',()=>{
 const store=new BridgeStore(':memory:',{type:'group',id:'1001'});const value=task();value.context.chatHistory!.range='rolling';value.context.chatHistory!.hours=24;
 try {
  store.recordTaskReply('d1','Own previous summary',value.id,store.recorder.conversationId);
  store.recordTaskReply('d2','Another task gold report','other-task',store.recorder.conversationId);
  const input=buildTaskHistory(store,value,Date.now()+1000);
  assert.deepEqual(input.chatMessages!.map(message=>message.text),['Another task gold report']);assert.equal(input.chatCoverage!.availableCount,1);
 }finally{store.close();}
});
