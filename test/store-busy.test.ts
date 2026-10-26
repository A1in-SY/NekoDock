import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test, type TestContext } from 'node:test';
import { BridgeStore } from '../src/store.js';
import type { IncomingMessage } from '../src/types.js';

const target = { type: 'group' as const, id: '1001' };
const message = (id: number, trigger = true): IncomingMessage => ({
  messageId: String(id), senderId: '2001', senderName: 'Alice', time: id,
  text: `message ${id}`, replyTo: null, trigger, rawJson: '{}',
});
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'bridge-busy-store-'));
  const path = join(directory, 'bridge.sqlite3');
  const stores: BridgeStore[] = [];
  t.after(() => { stores.forEach(store => store.close()); rmSync(directory, { recursive: true, force: true }); });
  return () => { const store = new BridgeStore(path, target); stores.push(store); return store; };
}

test('queued trigger is busy before a batch opens; context-only background stays idle', t => {
  const store = fixture(t)();
  assert.equal(store.isBusy(), false);
  store.insert(message(1, false)); assert.equal(store.isBusy(), false);
  store.insert(message(2)); assert.equal(store.isBusy(), true);
  assert.equal(store.getCursor(), 0);
  assert.equal(store.openOrCreateBatch(50)?.throughSeq, 2);
  assert.equal(store.isBusy(), true);
});

test('busy lasts through generation, pending sends, full ACK and ends only at batch completion', t => {
  const store = fixture(t)(); store.insert(message(1)); store.openOrCreateBatch(50);
  assert.equal(store.isBusy(), true);
  store.saveReplies(1, ['reply']); assert.equal(store.isBusy(), true);
  store.acknowledgeReply(1, 0); assert.equal(store.isBusy(), true);
  store.completeBatch(1); assert.equal(store.isBusy(), false);
});

test('a sent intermediate tool reply does not make an unfinished model turn idle', t => {
  const store = fixture(t)(); store.insert(message(1)); store.openOrCreateBatch(50);
  store.appendReplyRequest(1, 'milestone', [{ type: 'text', text: 'important result' }], ['important result']);
  store.markReplySending(1, 0); store.acknowledgeReply(1, 0);
  assert.equal(store.getBatch(1).generationDone, false);
  assert.equal(store.isBusy(), true);
  store.finishGeneration(1); assert.equal(store.isBusy(), true);
  store.completeBatch(1); assert.equal(store.isBusy(), false);
});

test('retry and restart preserve busy state; later context-only messages do not start another turn', t => {
  const open = fixture(t); const first = open();
  first.insert(message(1)); first.openOrCreateBatch(50);
  first.insert(message(2, false)); first.close();
  const restored = open(); assert.equal(restored.isBusy(), true);
  assert.equal(restored.getBatch(1).generationDone, false);
  restored.finishGeneration(1); restored.completeBatch(1);
  assert.equal(restored.isBusy(), false);
  assert.equal(restored.openOrCreateBatch(50), null);
  restored.insert(message(3)); assert.equal(restored.isBusy(), true);
  assert.deepEqual(restored.openOrCreateBatch(50)?.messages.map(entry => entry.messageId), ['2', '3']);
});

test('queued follow-up trigger remains busy after the previous batch completes', t => {
  const store = fixture(t)(); store.insert(message(1)); store.openOrCreateBatch(50);
  store.insert(message(2)); store.finishGeneration(1); store.completeBatch(1);
  assert.equal(store.isBusy(), true);
  store.openOrCreateBatch(50); store.finishGeneration(2); store.completeBatch(2);
  assert.equal(store.isBusy(), false);
});

test('queued bridge command stays busy until its confirmation is acknowledged', t => {
  const store = fixture(t)(); store.insert({ ...message(1), command: 'help', text: '/help' });
  assert.equal(store.isBusy(), true);
  const command = store.getPendingCommand()!;
  store.saveCommandResult(command.id, 'help'); assert.equal(store.isBusy(), true);
  store.acknowledgeCommand(command.id); assert.equal(store.isBusy(), false);
  store.insert({ ...message(2), command: 'new', text: '/new' });
  const next = store.getPendingCommand()!;
  store.resetSessionForCommand(next.id); assert.equal(store.isBusy(), true);
  store.acknowledgeCommand(next.id); assert.equal(store.isBusy(), false);
});
