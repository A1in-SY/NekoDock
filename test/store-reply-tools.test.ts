import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { BridgeStore } from '../src/store.js';
import type { IncomingMessage, OutputMessage, ReplyPart, Target } from '../src/types.js';

const target: Target = { type: 'group', id: '1001' };
const voiceSnapshot = `base64://${Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0]).toString('base64')}`;

function message(id: string, trigger = true): IncomingMessage {
  return { messageId: id, senderId: '2001', senderName: 'Alice', time: 1_792_742_400,
    text: `message ${id}`, replyTo: null, trigger, rawJson: JSON.stringify({ message_id: id }) };
}

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'napcat-reply-store-'));
  const path = join(directory, 'bridge.sqlite3');
  const stores: BridgeStore[] = [];
  t.after(() => {
    for (const store of stores) store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { path, open() {
    const store = new BridgeStore(path, target);
    stores.push(store);
    return store;
  } };
}

function legacyBatch(path: string, replies: ReplyPart[] | null, nextReplyIndex: number) {
  const db = new DatabaseSync(path);
  try {
    db.exec(`CREATE TABLE pending_batch (
      id INTEGER PRIMARY KEY CHECK (id = 1), through_seq INTEGER NOT NULL,
      reply_allowed INTEGER NOT NULL CHECK (reply_allowed IN (0, 1)), replies_json TEXT,
      next_reply_index INTEGER NOT NULL DEFAULT 0 CHECK (next_reply_index >= 0)
    )`);
    db.prepare('INSERT INTO pending_batch VALUES (1, 1, 1, ?, ?)')
      .run(replies === null ? null : JSON.stringify(replies), nextReplyIndex);
  } finally { db.close(); }
}

test('migrates legacy saved replies as finished without changing snapshots or ACK position', t => {
  const files = fixture(t);
  const replies: ReplyPart[] = ['sent', { type: 'voice', text: 'voice', file: voiceSnapshot }];
  legacyBatch(files.path, replies, 1);
  const store = files.open();
  const migrated = store.getBatch(1);
  assert.equal(migrated.generationDone, true);
  assert.deepEqual(migrated.replies, replies);
  assert.equal(migrated.nextReplyIndex, 1);
  assert.deepEqual(store.listReplyRequests(1), []);
  store.close();
  const restarted = files.open();
  assert.deepEqual(restarted.getBatch(1), migrated);
  restarted.acknowledgeReply(1, 1);
  restarted.completeBatch(1);
  assert.equal(restarted.getCursor(), 1);
});

test('migrates an unfinished legacy generation and finishes an empty legacy result', t => {
  const files = fixture(t);
  legacyBatch(files.path, null, 0);
  const store = files.open();
  assert.equal(store.getBatch(1).generationDone, false);
  assert.equal(store.getBatch(1).replies, null);
  store.finishGeneration(1);
  store.finishGeneration(1);
  assert.equal(store.getBatch(1).generationDone, true);
  assert.deepEqual(store.getBatch(1).replies, []);
  store.completeBatch(1);
  assert.equal(store.getCursor(), 1);
});

test('appends ordered requests while ACK position and generation completion remain independent', t => {
  const store = fixture(t).open();
  store.insert(message('1'));
  const batch = store.openOrCreateBatch(50)!;
  assert.equal(batch.generationDone, false);
  const firstMessages: OutputMessage[] = [{ type: 'text', text: 'first milestone' }];
  assert.deepEqual(store.appendReplyRequest(batch.throughSeq, 'first', firstMessages, ['first', 'milestone']), {
    requestId: 'first', messages: firstMessages, startIndex: 0, endIndex: 2, sendStarted: false,
  });
  store.acknowledgeReply(batch.throughSeq, 0);
  store.acknowledgeReply(batch.throughSeq, 1);
  assert.throws(() => store.completeBatch(batch.throughSeq), /generation has finished/);
  assert.equal(store.getCursor(), 0);
  assert.equal(store.getBatch(batch.throughSeq).generationDone, false);
  const secondMessages: OutputMessage[] = [{ type: 'image', path: '/workspace/chart.png' }];
  assert.deepEqual(store.appendReplyRequest(batch.throughSeq, 'second', secondMessages,
    [{ type: 'image', file: '/workspace/chart.png' }]), {
    requestId: 'second', messages: secondMessages, startIndex: 2, endIndex: 3, sendStarted: false,
  });
  assert.equal(store.getBatch(batch.throughSeq).nextReplyIndex, 2);
  store.finishGeneration(batch.throughSeq);
  assert.throws(() => store.completeBatch(batch.throughSeq), /all replies/);
  store.saveImage(batch.throughSeq, 2, 'base64://cG5n');
  store.acknowledgeReply(batch.throughSeq, 2);
  store.completeBatch(batch.throughSeq);
  assert.equal(store.getCursor(), batch.throughSeq);
  assert.deepEqual(store.listReplyRequests(batch.throughSeq), []);
  assert.equal(store.getReplyRequest(batch.throughSeq, 'first'), null);
  assert.throws(() => store.getBatch(batch.throughSeq), /does not match/);
});

test('reuses a request ID without redrawing prepared parts and rejects changed message contents', t => {
  const store = fixture(t).open();
  store.insert(message('1'));
  const batch = store.openOrCreateBatch(50)!;
  const messages: OutputMessage[] = [{ type: 'text', text: 'spoken progress' }];
  const saved = store.appendReplyRequest(batch.throughSeq, 'stable-id', messages, [{ type: 'voice', text: 'spoken progress' }]);
  store.saveVoice(batch.throughSeq, 0, voiceSnapshot);
  store.acknowledgeReply(batch.throughSeq, 0);
  const repeated = store.appendReplyRequest(batch.throughSeq, 'stable-id', structuredClone(messages), ['different random route']);
  assert.deepEqual(repeated, saved);
  assert.deepEqual(store.appendReplyRequest(batch.throughSeq, 'stable-id', messages, []), saved);
  assert.deepEqual(store.getBatch(batch.throughSeq).replies, [{ type: 'voice', text: 'spoken progress', file: voiceSnapshot }]);
  assert.equal(store.getBatch(batch.throughSeq).nextReplyIndex, 1);
  assert.throws(() => store.appendReplyRequest(batch.throughSeq, 'stable-id', [{ type: 'text', text: 'changed' }], ['changed']), /different messages/);
  assert.equal(store.listReplyRequests(batch.throughSeq).length, 1);
  store.finishGeneration(batch.throughSeq);
  assert.deepEqual(store.appendReplyRequest(batch.throughSeq, 'stable-id', messages, ['unused']), saved);
  assert.throws(() => store.appendReplyRequest(batch.throughSeq, 'new-id', messages, ['new']), /already finished/);
});

test('persists uncertain send attempts before ACK and does not mark adjacent requests', t => {
  const files = fixture(t);
  const first = files.open();
  first.insert(message('1'));
  const batch = first.openOrCreateBatch(50)!;
  first.appendReplyRequest(batch.throughSeq, 'first', [{ type: 'text', text: 'first' }], ['first A', 'first B']);
  first.appendReplyRequest(batch.throughSeq, 'second', [{ type: 'text', text: 'second' }], ['second']);
  assert.equal(first.getReplyRequest(batch.throughSeq, 'first')?.sendStarted, false);
  first.markReplySending(batch.throughSeq, 0);
  first.markReplySending(batch.throughSeq, 0);
  first.acknowledgeReply(batch.throughSeq, 0);
  assert.equal(first.getReplyRequest(batch.throughSeq, 'first')?.sendStarted, true);
  assert.equal(first.getReplyRequest(batch.throughSeq, 'second')?.sendStarted, false);
  first.close();
  const restarted = files.open();
  assert.equal(restarted.getReplyRequest(batch.throughSeq, 'first')?.sendStarted, true);
  assert.equal(restarted.getBatch(batch.throughSeq).nextReplyIndex, 1);
  assert.throws(() => restarted.markReplySending(batch.throughSeq, 0), /invalid/);
  for (const index of [-1, 0.5, 3, NaN, Infinity]) {
    assert.throws(() => restarted.markReplySending(batch.throughSeq, index), /invalid/);
  }
  restarted.markReplySending(batch.throughSeq, 1);
  restarted.acknowledgeReply(batch.throughSeq, 1);
  restarted.markReplySending(batch.throughSeq, 2);
  assert.equal(restarted.getReplyRequest(batch.throughSeq, 'second')?.sendStarted, true);
  restarted.acknowledgeReply(batch.throughSeq, 2);
  restarted.finishGeneration(batch.throughSeq);
  restarted.completeBatch(batch.throughSeq);
});

test('persists requests, prepared snapshots and in-flight generation through a restart', t => {
  const files = fixture(t);
  const first = files.open();
  first.insert(message('1'));
  const batch = first.openOrCreateBatch(50)!;
  const messages: OutputMessage[] = [{ type: 'image', path: '/workspace/chart.png' }, { type: 'text', text: 'voice' }];
  const record = first.appendReplyRequest(batch.throughSeq, 'request', messages,
    [{ type: 'image', file: '/workspace/chart.png' }, { type: 'voice', text: 'voice' }]);
  first.saveImage(batch.throughSeq, 0, 'base64://cG5n');
  first.acknowledgeReply(batch.throughSeq, 0);
  first.saveVoice(batch.throughSeq, 1, voiceSnapshot);
  first.close();
  const restarted = files.open();
  assert.equal(restarted.getBatch(batch.throughSeq).generationDone, false);
  assert.deepEqual(restarted.getReplyRequest(batch.throughSeq, 'request'), record);
  assert.deepEqual(restarted.listReplyRequests(batch.throughSeq), [record]);
  assert.deepEqual(restarted.getBatch(batch.throughSeq).replies,
    [{ type: 'image', file: 'base64://cG5n' }, { type: 'voice', text: 'voice', file: voiceSnapshot }]);
  assert.equal(restarted.getBatch(batch.throughSeq).nextReplyIndex, 1);
  restarted.acknowledgeReply(batch.throughSeq, 1);
  assert.throws(() => restarted.completeBatch(batch.throughSeq), /generation has finished/);
  restarted.finishGeneration(batch.throughSeq);
  restarted.completeBatch(batch.throughSeq);
});

test('rejects stale batches, disallowed replies and malformed requests without partial persistence', t => {
  const store = fixture(t).open();
  store.insert(message('context', false));
  store.insert(message('trigger'));
  const silent = store.openOrCreateBatch(1)!;
  const messages: OutputMessage[] = [{ type: 'text', text: 'hello' }];
  assert.throws(() => store.appendReplyRequest(silent.throughSeq, 'forbidden', messages, ['hello']), /does not allow/);
  assert.equal(store.getBatch(silent.throughSeq).replies, null);
  assert.deepEqual(store.listReplyRequests(silent.throughSeq), []);
  store.finishGeneration(silent.throughSeq);
  store.completeBatch(silent.throughSeq);
  const allowed = store.openOrCreateBatch(1)!;
  assert.throws(() => store.appendReplyRequest(silent.throughSeq, 'stale', messages, ['hello']), /does not match/);
  assert.throws(() => store.finishGeneration(silent.throughSeq), /does not match/);
  for (const requestId of ['', '  ']) {
    assert.throws(() => store.appendReplyRequest(allowed.throughSeq, requestId, messages, ['hello']), /ID must not be empty/);
  }
  for (const invalidMessages of [[], [{ type: 'text', text: ' ' }], [{ type: 'image', path: '' }], [{ type: 'unknown', text: 'x' }]]) {
    assert.throws(() => store.appendReplyRequest(allowed.throughSeq, 'invalid', invalidMessages as OutputMessage[], ['hello']), /request messages/);
  }
  for (const parts of [[], [{ type: 'image', file: 'base64://unchecked' }], [{ type: 'voice', text: 'hello', file: voiceSnapshot }]]) {
    assert.throws(() => store.appendReplyRequest(allowed.throughSeq, 'invalid', messages, parts as ReplyPart[]), /Reply parts/);
  }
  assert.equal(store.getBatch(allowed.throughSeq).replies, null);
  assert.deepEqual(store.listReplyRequests(allowed.throughSeq), []);
});

test('rolls back appended parts if request persistence fails', t => {
  const files = fixture(t);
  const store = files.open();
  store.insert(message('1'));
  const batch = store.openOrCreateBatch(50)!;
  store.appendReplyRequest(batch.throughSeq, 'first', [{ type: 'text', text: 'first' }], ['first']);
  const db = new DatabaseSync(files.path);
  try {
    db.exec(`CREATE TRIGGER reject_request BEFORE INSERT ON reply_requests
      BEGIN SELECT RAISE(ABORT, 'injected request failure'); END;`);
    assert.throws(() => store.appendReplyRequest(batch.throughSeq, 'second', [{ type: 'text', text: 'second' }], ['second']), /injected request failure/);
    assert.deepEqual(store.getBatch(batch.throughSeq).replies, ['first']);
    assert.deepEqual(store.listReplyRequests(batch.throughSeq).map(record => record.requestId), ['first']);
    assert.equal(store.getReplyRequest(batch.throughSeq, 'second'), null);
  } finally { db.close(); }
});

test('new command clears pending requests atomically and legacy saveReplies still marks generation done', t => {
  const files = fixture(t);
  const store = files.open();
  store.insert(message('1'));
  const batch = store.openOrCreateBatch(50)!;
  store.appendReplyRequest(batch.throughSeq, 'progress', [{ type: 'text', text: 'progress' }], ['progress']);
  store.insert({ ...message('reset'), command: 'new' });
  const command = store.getPendingCommand()!;
  const db = new DatabaseSync(files.path);
  try {
    db.exec(`CREATE TRIGGER reject_reset BEFORE DELETE ON pending_batch
      BEGIN SELECT RAISE(ABORT, 'injected reset failure'); END;`);
    assert.throws(() => store.resetSessionForCommand(command.id), /injected reset failure/);
    assert.equal(store.listReplyRequests(batch.throughSeq).length, 1);
    db.exec('DROP TRIGGER reject_reset');
    store.resetSessionForCommand(command.id);
    assert.deepEqual(store.listReplyRequests(batch.throughSeq), []);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM reply_requests').get()?.count, 0);
  } finally { db.close(); }
  store.acknowledgeCommand(command.id);
  store.insert(message('2'));
  const next = store.openOrCreateBatch(50)!;
  store.saveReplies(next.throughSeq, ['legacy reply']);
  store.saveReplies(next.throughSeq, ['legacy reply']);
  assert.equal(store.getBatch(next.throughSeq).generationDone, true);
  store.markReplySending(next.throughSeq, 0);
  assert.deepEqual(store.listReplyRequests(next.throughSeq), []);
  assert.throws(() => store.appendReplyRequest(next.throughSeq, 'late', [{ type: 'text', text: 'late' }], ['late']), /already finished/);
  store.acknowledgeReply(next.throughSeq, 0);
  store.completeBatch(next.throughSeq);
});
