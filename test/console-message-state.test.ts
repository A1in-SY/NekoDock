import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test,type TestContext} from 'node:test';
import {ConsoleDatabase} from '../src/console/database.js';

async function fixture(t:TestContext){
  const directory=await mkdtemp(join(tmpdir(),'message-state-'));
  const path=join(directory,'console.sqlite3'),key=join(directory,'master.key');
  let db=new ConsoleDatabase(path,key);
  const connection=db.createNapcatConnection({name:'Synthetic connection',wsUrl:'ws://127.0.0.1:9',enabled:true});db.bindNapcatAccount(connection.id,'999');
  const bot=db.createBot({name:'First',targetType:'group',targetId:'1001',connectionId:connection.id,config:{}});
  const other=db.createBot({name:'Other',targetType:'group',targetId:'1002',connectionId:connection.id,config:{}});
  t.after(async()=>{db.close();await rm(directory,{recursive:true,force:true});});
  return {get db(){return db;},bot,other,connection,reopen(){db.close();db=new ConsoleDatabase(path,key);}};
}

test('message state isolates targets and requires an observed platform message for quoting',async t=>{
  const f=await fixture(t);assert.deepEqual(f.db.messageState.validate(f.bot.id,['not-observed']),{ok:false,code:'QUOTE_TARGET_UNKNOWN',messageId:'not-observed'});
  f.db.messageState.register(f.bot.id,'qq-1','123','human');
  assert.deepEqual(f.db.messageState.validate(f.bot.id,['qq-1']),{ok:true});
  assert.equal(f.db.messageState.validate(f.other.id,['qq-1']).ok,false);
  assert.throws(()=>f.db.bindNapcatAccount(f.connection.id,'888'),/登录账号已改变/);
});

test('a recall received before the original message remains a tombstone after registration and restart',async t=>{
  const f=await fixture(t);const event=f.db.messageState.recalled(f.bot.id,'qq-2',1234,'123','123')!;
  assert.equal(f.db.messageState.validate(f.bot.id,['qq-2']).ok,false);
  f.db.messageState.register(f.bot.id,'qq-2','123','human');
  assert.deepEqual(f.db.messageState.validate(f.bot.id,['qq-2']),{ok:false,code:'QUOTE_TARGET_RECALLED',messageId:'qq-2'});
  assert.deepEqual(f.db.messageState.recalled(f.bot.id,'qq-2',1235,'123','123'),event);
  assert.equal(f.db.messageState.recalled(f.bot.id,'qq-2',1236,'456','456'),null);
  f.reopen();assert.equal(f.db.messageState.get(f.bot.id,'qq-2')?.recalled,1);
});

test('recall events survive durable queue replay and stop replaying only after acknowledgement',async t=>{
  const f=await fixture(t);const event=f.db.messageState.recalled(f.bot.id,'qq-3',1234,'123','123')!;
  const original=f.db.pendingNapcatEvents(f.bot.id,1)[0]!;
  assert.deepEqual(original.recall,event);assert.equal(f.db.pendingNapcatEvents(f.bot.id).length,1);
  f.reopen();assert.equal(f.db.pendingNapcatEvents(f.bot.id)[0]?.seq,original.seq);
  f.db.ackNapcatEvents(f.bot.id,original.seq);
  assert.equal(f.db.pendingNapcatEvents(f.bot.id).length,0);
  f.db.messageState.recalled(f.bot.id,'qq-3',9999);assert.equal(f.db.pendingNapcatEvents(f.bot.id).length,0);
});

test('recall ownership resolves only confirmed self-authored model parts for the current binding',async t=>{
  const f=await fixture(t),metadata={messageRef:'reply-synthetic:0',conversationId:'chat-example',origin:'model' as const,logicalMessageIndex:0,partIndex:0};
  f.db.messageState.register(f.bot.id,'own-0','999','model',metadata);
  f.db.messageState.register(f.bot.id,'own-1','999','model',{...metadata,partIndex:1});
  f.db.messageState.register(f.bot.id,'plugin-0','999','plugin',{...metadata,partIndex:2});
  f.db.messageState.register(f.bot.id,'human-0','123','model',{...metadata,partIndex:3});
  assert.deepEqual(f.db.messageState.owned(f.bot.id,metadata.messageRef).map(row=>row.message_id),['own-0','own-1']);
  assert.deepEqual(f.db.messageState.owned(f.other.id,metadata.messageRef),[]);
});

test('an observed message cannot be rebound to another author, origin or logical reply by a later ACK',async t=>{
  const f=await fixture(t),metadata={messageRef:'reply-owner:0',conversationId:'chat-example',origin:'model' as const,logicalMessageIndex:0,partIndex:0};
  f.db.messageState.register(f.bot.id,'human-owned','123','human');
  assert.throws(()=>f.db.messageState.register(f.bot.id,'human-owned','999','model',metadata),/identity conflicts/);
  assert.equal(f.db.messageState.get(f.bot.id,'human-owned')!.origin,'human');
  assert.deepEqual(f.db.messageState.owned(f.bot.id,metadata.messageRef),[]);
  f.db.messageState.register(f.bot.id,'model-owned','999','model',metadata);
  assert.doesNotThrow(()=>f.db.messageState.register(f.bot.id,'model-owned','999','model',metadata));
  assert.throws(()=>f.db.messageState.register(f.bot.id,'model-owned','999','model',{...metadata,messageRef:'reply-owner:1'}),/identity conflicts/);
  assert.throws(()=>f.db.messageState.register(f.bot.id,'model-owned','999','model',{...metadata,partIndex:1}),/identity conflicts/);
  assert.equal(f.db.messageState.owned(f.bot.id,metadata.messageRef)[0]!.part_index,0);
});

test('recall operation identity is durable and interrupted operations are never automatically executed again',async t=>{
  const f=await fixture(t);assert.deepEqual(f.db.messageState.beginOperation(f.bot.id,'operation-1','reply-1'),{created:true});
  assert.equal(f.db.messageState.beginOperation(f.bot.id,'operation-1','reply-1').created,false);
  assert.throws(()=>f.db.messageState.beginOperation(f.bot.id,'operation-1','reply-2'),/reused/);
  f.reopen();const recovered=f.db.messageState.beginOperation(f.bot.id,'operation-1','reply-1');
  assert.equal(recovered.created,false);assert.equal((recovered.result as {status:string}).status,'unconfirmed');
});

test('older conversation pages hydrate recalled messages and include real ACK IDs for accepted logical replies',async t=>{
  const f=await fixture(t),conversationId='chat-paging',time=Date.now();
  const values:[string,Record<string,unknown>][]=[
    ['conversation.started',{}],
    ['message.received',{messageId:'user-message',text:'original question',senderName:'Synthetic sender'}],
    ['reply.accepted',{requestId:'request-example',partCounts:[2],messages:[{type:'text',text:'original answer',replyTo:'user-message'}]}],
    ['delivery.acknowledged',{requestId:'request-example',deliveryId:'delivery-example',logicalMessageIndex:0,partIndex:0,messageId:'assistant-message',normal:true}],
    ['plugin.message.sent',{messageId:'plugin-message',text:'plugin response'}],
    ['message.recalled',{messageId:'user-message',time:time/1000}],
    ['message.recalled',{messageId:'assistant-message',time:time/1000}],
    ['message.recalled',{messageId:'plugin-message',time:time/1000}],
  ];
  f.db.ingestEvents(f.bot.id,values.map(([type,payload],index)=>({seq:index+1,type,payload,time,conversationId})));
  assert.equal(f.db.getConversation(f.bot.id,3,1)!.items.find(item=>item.seq===2)!.payload.recalled,true);
  const replyPage=f.db.getConversation(f.bot.id,4,1)!;
  const accepted=replyPage.items.find(item=>item.seq===3)!;
  assert.equal(((accepted.payload.messages as {replyPreview:{recalled:boolean}}[])[0]!.replyPreview).recalled,true);
  assert.deepEqual((accepted.payload.messages as {deliverySummary:unknown}[])[0]!.deliverySummary,{totalParts:2,totalKnown:true,acknowledgedParts:1,recalledParts:1,cancelledParts:0});
  const ack=replyPage.items.find(item=>item.type==='delivery.acknowledged')!;
  assert.equal(ack.payload.messageId,'assistant-message');assert.equal(ack.payload.recalled,true);
  assert.equal(replyPage.nextBefore,3);
  assert.equal(f.db.getConversation(f.bot.id,6,1)!.items.find(item=>item.seq===5)!.payload.recalled,true);
});

test('a paged logical reply includes deduplicated cancelled parts alongside recalled ACKs',async t=>{
  const f=await fixture(t),conversationId='chat-cancel-page',time=Date.now();
  const values:[string,Record<string,unknown>][]=[
    ['conversation.started',{}],
    ['reply.accepted',{requestId:'r',partCounts:[2],messages:[{type:'text',text:'two-part reply'}]}],
    ['delivery.acknowledged',{requestId:'r',deliveryId:'delivery-0',logicalMessageIndex:0,partIndex:0,messageId:'30001',normal:true}],
    ['delivery.cancelled',{requestId:'r',deliveryId:'delivery-1',logicalMessageIndex:0,partIndex:1}],
    ['message.recalled',{messageId:'30001',time:time/1000,logicalRecallCount:1,logicalCancelledCount:1,logicalPartCount:2}],
    ['delivery.cancelled',{requestId:'r',deliveryId:'delivery-1',logicalMessageIndex:0,partIndex:1}],
  ];
  f.db.ingestEvents(f.bot.id,values.map(([type,payload],index)=>({seq:index+1,type,payload,time,conversationId})));
  const page=f.db.getConversation(f.bot.id,3,1)!;
  const accepted=page.items.find(item=>item.type==='reply.accepted')!;
  assert.deepEqual((accepted.payload.messages as {deliverySummary:unknown}[])[0]!.deliverySummary,{totalParts:2,totalKnown:true,acknowledgedParts:1,recalledParts:1,cancelledParts:1});
  assert.equal(page.items.some(item=>item.type==='message.recalled'||item.type==='delivery.cancelled'),false);
});
