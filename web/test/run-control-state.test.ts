import assert from 'node:assert/strict';
import {test} from 'node:test';
import {replyCancellationState} from '../src/run-control-state.ts';
import type {PublicBot} from '../../src/console/contracts.ts';

const bot=():PublicBot=>({state:'running',lastHeartbeat:1000,runControl:{supported:true,
  active:{runId:'run-a',conversationId:'chat',throughSeq:1,startedAt:1000,phase:'generating'},cancellation:null}} as PublicBot);

test('reply stop is available during instance drain and disabled on an unsupported Worker',()=>{
  const value=bot();value.state='stopping';
  assert.equal(replyCancellationState(value,null,1000).disabled,false);
  value.runControl!.supported=false;
  assert.equal(replyCancellationState(value,null,1000).disabled,true);
  assert.match(replyCancellationState(value,null,1000).title,/更新实例/);
});

test('accepted is distinct from confirmed, and a terminal old cancellation cannot disable the next turn',()=>{
  const value=bot();const requested={runId:'run-a',time:1000};
  const initial=replyCancellationState(value,requested,1001);assert.equal(initial.waiting,true);assert.equal(initial.disabled,true);
  assert.match(replyCancellationState(value,requested,11000).message,/尚未确认/);
  value.runControl!.active!.phase='cancelling';assert.match(replyCancellationState(value,requested,1002).message,/回执/);
  value.runControl!.cancellation={id:'cancel-a',runId:'run-a',status:'cancelled',createdAt:1000};
  assert.equal(replyCancellationState(value,requested,1003).waiting,false);
  value.runControl!.active!.runId='run-b';value.runControl!.active!.phase='generating';
  const next=replyCancellationState(value,requested,1004);
  assert.equal(next.runId,'run-b');assert.equal(next.disabled,false);assert.equal(next.waiting,false);
  value.lastHeartbeat=20000;
  value.runControl!.cancellation={id:'cancel-b',runId:'run-b',status:'requested',createdAt:20000};
  assert.match(replyCancellationState(value,requested,20001).message,/请求已接受/);
});

test('a stop requested in another browser displays pending state and never reports completion while disconnected',()=>{
  const value=bot();value.runControl!.cancellation={id:'cancel-a',runId:'run-a',status:'requested',createdAt:1000};
  assert.equal(replyCancellationState(value,null,1001).waiting,true);
  value.lastHeartbeat=null;assert.match(replyCancellationState(value,null,1002).message,/尚未确认/);
});
