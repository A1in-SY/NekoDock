import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import test from 'node:test';
import { replyMessageReceipt, replyToolReceipt, waitForReplyReceipt } from '../src/reply-receipt.js';
import type { ReplyPartState } from '../src/reply-ledger.js';

test('logical receipts distinguish pending, confirmed failure, uncertainty, cancellation and partial sending', () => {
  const cases: Array<[ReplyPartState[], string]> = [
    [['acknowledged', 'acknowledged'], 'sent'], [['acknowledged', 'recalled'], 'sent'],
    [['acknowledged', 'started'], 'pending'], [['queued'], 'pending'],
    [['failed', 'cancelled'], 'failed'], [['unconfirmed', 'failed'], 'unconfirmed'],
    [['acknowledged', 'unconfirmed'], 'partial'], [['acknowledged', 'cancelled'], 'partial'], [['cancelled'], 'cancelled'],
  ];
  for (const [states, status] of cases) {
    const message = replyMessageReceipt('reply:synthetic:0', states);
    assert.equal(message.status, status);
    const { total, ...counts } = message.parts;
    assert.equal(total, states.length); assert.equal(Object.values(counts).reduce((sum, n) => sum + n, 0), total);
  }
  assert.deepEqual(replyMessageReceipt('reply:synthetic:0', ['acknowledged', 'started', 'failed', 'unconfirmed', 'cancelled']).parts,
    { total: 5, sent: 1, pending: 1, failed: 1, unconfirmed: 1, cancelled: 1 });
});

function fixture() {
  const controller = new AbortController();
  const listeners = new Set<() => void>();
  let state: ReplyPartState = 'started'; let reads = 0;
  let settle!: () => void;
  const settled = new Promise<void>(resolve => { settle = resolve; });
  return {
    controller, listeners, settle,
    get reads() { return reads; },
    set(value: ReplyPartState) { state = value; },
    changed() { for (const listener of listeners) listener(); },
    wait() { return waitForReplyReceipt({ signal: controller.signal, settled,
      read() { reads++; return replyToolReceipt([replyMessageReceipt('reply:synthetic:0', [state])]); },
      subscribe(changed) { listeners.add(changed); return () => { listeners.delete(changed); }; },
    }); },
  };
}

test('the five-second deadline returns pending without cancelling delivery and cleans up its listeners', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); let finished = false;
  const waiting = f.wait().then(receipt => { finished = true; return receipt; });
  t.mock.timers.tick(4_999); await Promise.resolve(); assert.equal(finished, false);
  t.mock.timers.tick(1); const receipt = await waiting;
  assert.equal(receipt.accepted, true); assert.equal(receipt.messages![0]!.status, 'pending');
  assert.equal(f.controller.signal.aborted, false); assert.match(receipt.notice!, /Pending does not mean delivery failed/);
  assert.equal(f.listeners.size, 0); assert.equal(getEventListeners(f.controller.signal, 'abort').length, 0);
  const reads = f.reads; f.set('acknowledged'); f.changed(); f.settle(); await Promise.resolve();
  assert.equal(f.reads, reads, 'a late ACK must not revive the finished waiter');
});

test('the deadline reads the latest committed ACK rather than returning a cached pending receipt', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(), waiting = f.wait();
  f.set('acknowledged'); t.mock.timers.tick(5_000);
  assert.equal((await waiting).messages![0]!.status, 'sent'); assert.equal(f.listeners.size, 0);
});

test('receipt notifications are read after commit and unrelated events cannot finish a pending request', async () => {
  const f = fixture(); let finished = false;
  const waiting = f.wait().then(receipt => { finished = true; return receipt; });
  f.changed(); await Promise.resolve(); assert.equal(finished, false);
  f.changed(); f.set('acknowledged');
  assert.equal((await waiting).messages![0]!.status, 'sent'); assert.equal(f.listeners.size, 0);
  assert.equal(getEventListeners(f.controller.signal, 'abort').length, 0);
});

test('operator cancellation interrupts the receipt wait immediately without reviving on late delivery', async () => {
  const f = fixture(), waiting = f.wait();
  f.controller.abort(new Error('RUN_CANCELLED_BY_OPERATOR'));
  await assert.rejects(waiting, /RUN_CANCELLED_BY_OPERATOR/);
  assert.equal(f.listeners.size, 0); assert.equal(getEventListeners(f.controller.signal, 'abort').length, 0);
  const reads = f.reads; f.set('acknowledged'); f.changed(); f.settle(); await Promise.resolve(); assert.equal(f.reads, reads);
  await assert.rejects(f.wait(), /RUN_CANCELLED_BY_OPERATOR/); assert.equal(f.reads, reads);
});
