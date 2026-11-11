import test from 'node:test';
import assert from 'node:assert/strict';
import { incomingRecall } from '../src/incoming-recall.js';

const notice={post_type:'notice',notice_type:'group_recall',group_id:'1001',self_id:'999',user_id:'2001',operator_id:'2002',message_id:'3001',time:10};
test('direct recall parsing validates the fixed group and preserves author versus operator',()=>{
  const event=incomingRecall(notice,{type:'group',id:'1001'},()=>false)!;
  assert.equal(event.messageId,'3001');assert.equal(event.authorId,'2001');assert.equal(event.operatorId,'2002');assert.equal(event.time,10);
  assert.equal(incomingRecall({...notice,group_id:'1002'},{type:'group',id:'1001'},()=>false),null);
  assert.equal(incomingRecall({...notice,time:NaN},{type:'group',id:'1001'},()=>false),null);
  assert.equal(incomingRecall({...notice,notice_type:'group_ban'},{type:'group',id:'1001'},()=>false),null);
  assert.equal(incomingRecall(notice,{type:'group',id:'1001'},()=>false)!.eventId,event.eventId);
});
test('private self recalls require known outgoing identity instead of guessing another peer',()=>{
  const friend={...notice,notice_type:'friend_recall'};
  assert.ok(incomingRecall(friend,{type:'private',id:'2001'},()=>false));
  assert.equal(incomingRecall(friend,{type:'private',id:'2002'},()=>false),null);
  assert.equal(incomingRecall({...friend,user_id:'999'},{type:'private',id:'2001'},()=>false),null);
  assert.ok(incomingRecall({...friend,user_id:'999'},{type:'private',id:'2001'},()=>true));
});
