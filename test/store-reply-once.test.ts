import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { BridgeStore } from '../src/store.js';

const target = { type: 'group' as const, id: '1' };
function create(path: string) {
  const store = new BridgeStore(path, target);
  store.insert({ messageId: '1', senderId: '2', senderName: 'A', time: 1, text: 'question', replyTo: null, trigger: true, rawJson: '{}' });
  store.openOrCreateBatch(50);
  return store;
}

test('model start is durable; repeated execution and repeated part attempts are rejected', () => {
  const store = create(':memory:');
  assert.equal(store.getBatch(1).modelStarted, false);
  store.markGenerationStarted(1);
  assert.equal(store.getBatch(1).modelStarted, true);
  assert.throws(() => store.markGenerationStarted(1), /already started/);
  store.saveReplies(1, ['first', 'second']);
  store.beginReplyAttempt(1, 0);
  assert.throws(() => store.beginReplyAttempt(1, 0), /UNIQUE/);
  store.failReply(1, 0, 'unconfirmed', 'send', 'SEND_UNCONFIRMED');
  assert.equal(store.getBatch(1).nextReplyIndex, 1);
  store.beginReplyAttempt(1, 1); store.acknowledgeReply(1, 1);
  store.completeBatch(1);
  assert.equal(store.getCursor(), 1); assert.equal(store.peekPendingBatch(), null);
  assert.equal(store.recorder.pending().filter(event => event.type === 'delivery.acknowledged').length, 1);
  store.close();
});

test('migration marks only preexisting pending batches interrupted and preserves session/history', t => {
  const dir = mkdtempSync(join(tmpdir(), 'reply-once-migration-')), path = join(dir, 'bridge.sqlite3');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const original = create(path); original.setSessionId('session'); original.close();
  const old = new DatabaseSync(path); old.exec('ALTER TABLE pending_batch DROP COLUMN model_started'); old.close();
  const migrated = new BridgeStore(path, target);
  assert.equal(migrated.getBatch(1).modelStarted, true); assert.equal(migrated.getSessionId(), 'session');
  assert.equal(migrated.getBatch(1).messages[0]?.text, 'question');
  migrated.abandonBatch(1, 'interrupted');
  assert.equal(migrated.getCursor(), 1); assert.equal(migrated.getSessionId(), 'session');
  migrated.insert({ messageId: '2', senderId: '2', senderName: 'A', time: 2, text: 'new question', replyTo: null, trigger: true, rawJson: '{}' });
  assert.equal(migrated.openOrCreateBatch(50)?.modelStarted, false);
  migrated.close();
  const restarted = new BridgeStore(path, target);
  assert.equal(restarted.getBatch(2).modelStarted, false);
  restarted.close();
});
