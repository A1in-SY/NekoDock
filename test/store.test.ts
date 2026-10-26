import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test, type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { BridgeStore } from '../src/store.js';
import type { BridgeCommand, IncomingMessage, ReplyPart, Target } from '../src/types.js';

const target: Target = { type: 'group', id: '1001' };
const voiceSnapshot = `base64://${Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0]).toString('base64')}`;
const differentVoiceSnapshot = `base64://${Buffer.from([0xff, 0xfb, 0x90, 0x64, 1, 0, 0, 0]).toString('base64')}`;

function message(id: string, trigger = true): IncomingMessage {
  return {
    messageId: id,
    senderId: '2001',
    senderName: 'Alice',
    time: 1_792_742_400,
    text: `message ${id}`,
    replyTo: id === '2' ? '1' : null,
    trigger,
    rawJson: JSON.stringify({ message_id: id }),
  };
}

function command(id: string, kind: BridgeCommand): IncomingMessage {
  return { ...message(id), command: kind, text: `/${kind} private-command-body`, rawJson: 'private-command-raw' };
}

function fixture(t: TestContext): { path: string; open: (identity?: Target) => BridgeStore } {
  const directory = mkdtempSync(join(tmpdir(), 'napcat-store-'));
  const path = join(directory, 'nested', 'bridge.sqlite3');
  const stores: BridgeStore[] = [];
  t.after(() => {
    for (const store of stores) store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    path,
    open(identity = target) {
      const store = new BridgeStore(path, identity);
      stores.push(store);
      return store;
    },
  };
}

test('deduplicates incoming message IDs and preserves the first raw message', (t) => {
  const store = fixture(t).open();
  const first = message('1');
  assert.equal(store.insert(first), true);
  assert.equal(store.insert({ ...first, text: 'duplicate', trigger: false }), false);
  const batch = store.openOrCreateBatch(10);
  assert.ok(batch);
  assert.equal(batch.messages.length, 1);
  assert.deepEqual(batch.messages[0], { ...first, seq: batch.throughSeq });
  assert.equal(store.getCursor(), 0);
  assert.equal(store.getSessionId(), null);
});

test('persists mixed replies and an image snapshot across restart', (t) => {
  const files = fixture(t);
  const first = files.open();
  first.insert(message('1'));
  const batch = first.openOrCreateBatch(10)!;
  assert.throws(() => first.saveReplies(batch.throughSeq, [{ type: 'image', file: 'base64://unchecked' }]), /text or images/);
  first.saveReplies(batch.throughSeq, ['text', { type: 'image', file: '/workspace/chart.png' }]);
  first.acknowledgeReply(batch.throughSeq, 0);
  first.saveImage(batch.throughSeq, 1, 'base64://cG5n');
  first.close();
  const restarted = files.open();
  const pending = restarted.openOrCreateBatch(10)!;
  assert.deepEqual(pending.replies, ['text', { type: 'image', file: 'base64://cG5n' }]);
  assert.equal(pending.nextReplyIndex, 1);
  assert.throws(() => restarted.saveImage(batch.throughSeq, 0, 'base64://cG5n'), /invalid/);
  assert.throws(() => restarted.saveImage(batch.throughSeq, 1, 'base64://Y2hhbmdlZA=='), /already/);
  restarted.acknowledgeReply(batch.throughSeq, 1);
  restarted.completeBatch(batch.throughSeq);
  assert.equal(restarted.getCursor(), batch.throughSeq);
});

test('persists ordered segment replies with legacy text and images without a schema migration', (t) => {
  const files = fixture(t);
  const first = files.open();
  first.insert(message('1'));
  const batch = first.openOrCreateBatch(10)!;
  const parts: ReplyPart[] = ['legacy text', { type: 'message', segments: [
    { type: 'at', userId: '2001' }, { type: 'text', text: ' answer A ' }, { type: 'at', userId: '2002' },
  ] }, { type: 'image', file: '/workspace/chart.png' }, { type: 'message', segments: [
    { type: 'text', text: '  ' },
  ] }];
  first.saveReplies(batch.throughSeq, parts);
  first.saveReplies(batch.throughSeq, structuredClone(parts));
  assert.throws(() => first.saveImage(batch.throughSeq, 1, 'base64://cG5n'), /invalid/);
  assert.throws(() => first.saveImage(batch.throughSeq, 3, 'base64://cG5n'), /invalid/);
  first.saveImage(batch.throughSeq, 2, 'base64://cG5n');
  first.acknowledgeReply(batch.throughSeq, 0);
  first.acknowledgeReply(batch.throughSeq, 1);
  first.close();

  const restarted = files.open();
  const pending = restarted.openOrCreateBatch(10)!;
  assert.deepEqual(pending.replies, [parts[0], parts[1], { type: 'image', file: 'base64://cG5n' }, parts[3]]);
  assert.equal(pending.nextReplyIndex, 2);
  const connection = new DatabaseSync(files.path);
  try { assert.equal(connection.prepare('PRAGMA user_version').get()?.user_version, 1); }
  finally { connection.close(); }
  restarted.acknowledgeReply(batch.throughSeq, 2);
  restarted.acknowledgeReply(batch.throughSeq, 3);
  restarted.completeBatch(batch.throughSeq);
  assert.equal(restarted.getCursor(), batch.throughSeq);
});

test('persists voice snapshots and acknowledgement position across restart without a schema migration', t => {
  const files = fixture(t);
  const first = files.open();
  first.insert(message('1'));
  const batch = first.openOrCreateBatch(10)!;
  const parts: ReplyPart[] = ['text first', { type: 'voice', text: '语音正文' }, { type: 'voice', text: '后续正文' }];
  first.saveReplies(batch.throughSeq, parts);
  first.saveReplies(batch.throughSeq, structuredClone(parts));
  first.saveVoice(batch.throughSeq, 1, voiceSnapshot);
  first.saveVoice(batch.throughSeq, 1, voiceSnapshot);
  assert.throws(() => first.saveVoice(batch.throughSeq, 1, differentVoiceSnapshot), /already been saved/);
  assert.throws(() => first.saveImage(batch.throughSeq, 1, 'base64://cG5n'), /invalid/);
  assert.throws(() => first.fallbackVoice(batch.throughSeq, 1), /Prepared voice/);
  first.acknowledgeReply(batch.throughSeq, 0);
  first.close();

  const restarted = files.open();
  assert.deepEqual(restarted.openOrCreateBatch(10)?.replies, [
    'text first', { type: 'voice', text: '语音正文', file: voiceSnapshot }, { type: 'voice', text: '后续正文' },
  ]);
  assert.equal(restarted.openOrCreateBatch(10)?.nextReplyIndex, 1);
  const connection = new DatabaseSync(files.path);
  try { assert.equal(connection.prepare('PRAGMA user_version').get()?.user_version, 1); }
  finally { connection.close(); }
  restarted.saveVoice(batch.throughSeq, 1, voiceSnapshot);
  restarted.acknowledgeReply(batch.throughSeq, 1);
  assert.throws(() => restarted.saveVoice(batch.throughSeq, 1, voiceSnapshot), /invalid/);
  assert.throws(() => restarted.fallbackVoice(batch.throughSeq, 1), /invalid/);
  restarted.fallbackVoice(batch.throughSeq, 2);
  restarted.acknowledgeReply(batch.throughSeq, 2);
  restarted.completeBatch(batch.throughSeq);
  assert.equal(restarted.getCursor(), batch.throughSeq);
});

test('rejects malformed or preprepared voice replies before saving the batch', t => {
  const store = fixture(t).open();
  store.insert(message('1'));
  const batch = store.openOrCreateBatch(10)!;
  for (const part of [
    { type: 'voice' }, { type: 'voice', text: '' }, { type: 'voice', text: ' \n ' },
    { type: 'voice', text: 123 }, { type: 'voice', file: voiceSnapshot },
    { type: 'voice', text: 'hello', file: voiceSnapshot },
    { type: 'voice', text: 'hello', file: undefined }, { type: 'voice', text: 'hello', extra: true },
  ]) {
    assert.throws(() => store.saveReplies(batch.throughSeq, [part] as ReplyPart[]), /Reply parts/);
    assert.equal(store.openOrCreateBatch(10)?.replies, null);
  }
});

test('voice preparation rejects stale batches, invalid indices and non-MP3 snapshots', t => {
  const store = fixture(t).open();
  store.insert(message('1'));
  const batch = store.openOrCreateBatch(10)!;
  assert.throws(() => store.saveVoice(batch.throughSeq, 0, voiceSnapshot), /invalid/);
  assert.throws(() => store.fallbackVoice(batch.throughSeq, 0), /invalid/);
  store.saveReplies(batch.throughSeq, ['text', { type: 'voice', text: 'voice' }]);
  for (const index of [-1, 0, 0.5, 2, NaN, Infinity]) {
    assert.throws(() => store.saveVoice(batch.throughSeq, index, voiceSnapshot), /invalid/);
    assert.throws(() => store.fallbackVoice(batch.throughSeq, index), /invalid/);
  }
  assert.throws(() => store.saveVoice(batch.throughSeq + 1, 1, voiceSnapshot), /does not match/);
  assert.throws(() => store.fallbackVoice(batch.throughSeq + 1, 1), /does not match/);
  for (const file of ['', '/tmp/audio.mp3', 'https://example.com/audio.mp3', 'base64://', 'base64://aGVsbG8=', 'base64://////']) {
    assert.throws(() => store.saveVoice(batch.throughSeq, 1, file), /valid MP3 base64 snapshot/);
  }
  assert.deepEqual(store.openOrCreateBatch(10)?.replies, ['text', { type: 'voice', text: 'voice' }]);
});

test('voice fallback durably replaces only the pending unprepared part with its original text', t => {
  const files = fixture(t);
  const first = files.open();
  first.insert(message('1'));
  const batch = first.openOrCreateBatch(10)!;
  first.saveReplies(batch.throughSeq, [{ type: 'voice', text: '  保留原文\n和格式  ' }, 'next']);
  first.fallbackVoice(batch.throughSeq, 0);
  assert.throws(() => first.saveVoice(batch.throughSeq, 0, voiceSnapshot), /invalid/);
  assert.throws(() => first.fallbackVoice(batch.throughSeq, 0), /invalid/);
  first.close();

  const restarted = files.open();
  assert.deepEqual(restarted.openOrCreateBatch(10)?.replies, ['  保留原文\n和格式  ', 'next']);
  assert.equal(restarted.openOrCreateBatch(10)?.nextReplyIndex, 0);
  restarted.acknowledgeReply(batch.throughSeq, 0);
  restarted.acknowledgeReply(batch.throughSeq, 1);
  restarted.completeBatch(batch.throughSeq);
  assert.equal(restarted.getCursor(), batch.throughSeq);
});

test('rejects malformed segment replies before saving any result', (t) => {
  const store = fixture(t).open();
  store.insert(message('1'));
  const batch = store.openOrCreateBatch(10)!;
  const invalid: unknown[] = [
    { type: 'message', segments: [] },
    { type: 'message', segments: [{ type: 'at', userId: 'all' }] },
    { type: 'message', segments: [{ type: 'at', userId: '0' }] },
    { type: 'message', segments: [{ type: 'at', userId: 2001 }] },
    { type: 'message', segments: [{ type: 'at', userId: '2001', extra: true }] },
    { type: 'message', segments: [{ type: 'text', text: '' }] },
    { type: 'message', segments: [{ type: 'text', text: 'valid' }], extra: true },
    { type: 'message', segments: [{ type: 'image', path: '/workspace/chart.png' }] },
  ];
  for (const part of invalid) {
    assert.throws(() => store.saveReplies(batch.throughSeq, [part] as ReplyPart[]), /Reply parts/);
    assert.equal(store.openOrCreateBatch(10)?.replies, null);
  }
});

test('binds persisted state to both target type and target ID', (t) => {
  const files = fixture(t);
  files.open().close();
  assert.throws(() => files.open({ type: 'group', id: '1002' }), /different target/);
  assert.throws(() => files.open({ type: 'private', id: target.id }), /different target/);
  assert.equal(files.open().getCursor(), 0);
});

test('persists session and active batch while later messages wait for the next batch', (t) => {
  const files = fixture(t);
  const first = files.open();
  first.insert(message('1'));
  const batch = first.openOrCreateBatch(10);
  assert.ok(batch);
  first.setSessionId('thread-1');
  first.insert(message('2'));
  first.close();

  const restarted = files.open();
  assert.equal(restarted.getSessionId(), 'thread-1');
  assert.deepEqual(restarted.openOrCreateBatch(100), batch);
  restarted.saveReplies(batch.throughSeq, []);
  restarted.completeBatch(batch.throughSeq);
  assert.equal(restarted.getCursor(), batch.throughSeq);
  const next = restarted.openOrCreateBatch(10);
  assert.ok(next);
  assert.deepEqual(next.messages.map((entry) => entry.messageId), ['2']);
});

test('retains untriggered messages until a trigger arrives, processing context prefixes in bounded batches', (t) => {
  const store = fixture(t).open();
  store.insert(message('1', false));
  store.insert(message('2', false));
  assert.equal(store.openOrCreateBatch(1), null);
  assert.equal(store.getCursor(), 0);
  store.insert(message('3'));

  for (const expectedId of ['1', '2']) {
    const context = store.openOrCreateBatch(1);
    assert.ok(context);
    assert.equal(context.replyAllowed, false);
    assert.deepEqual(context.messages.map((entry) => entry.messageId), [expectedId]);
    assert.throws(() => store.saveReplies(context.throughSeq, ['forbidden']), /does not allow/);
    store.saveReplies(context.throughSeq, []);
    store.completeBatch(context.throughSeq);
  }

  const triggered = store.openOrCreateBatch(1);
  assert.ok(triggered);
  assert.equal(triggered.replyAllowed, true);
  assert.deepEqual(triggered.messages.map((entry) => entry.messageId), ['3']);
  store.saveReplies(triggered.throughSeq, []);
  store.completeBatch(triggered.throughSeq);
  store.insert(message('4', false));
  assert.equal(store.openOrCreateBatch(1), null);
});

test('resumes durable replies and acknowledgement position after a send failure and restart', (t) => {
  const files = fixture(t);
  const first = files.open();
  first.insert(message('1'));
  const batch = first.openOrCreateBatch(10);
  assert.ok(batch);
  first.saveReplies(batch.throughSeq, ['first', 'second']);
  first.acknowledgeReply(batch.throughSeq, 0);
  assert.throws(() => first.completeBatch(batch.throughSeq), /all replies/);
  first.close();

  const restarted = files.open();
  const pending = restarted.openOrCreateBatch(10);
  assert.ok(pending);
  assert.deepEqual(pending.replies, ['first', 'second']);
  assert.equal(pending.nextReplyIndex, 1);
  assert.equal(restarted.getCursor(), 0);
  restarted.acknowledgeReply(batch.throughSeq, 0);
  assert.equal(restarted.openOrCreateBatch(10)?.nextReplyIndex, 1);
  restarted.acknowledgeReply(batch.throughSeq, 1);
  restarted.completeBatch(batch.throughSeq);
  restarted.close();

  const completed = files.open();
  assert.equal(completed.getCursor(), batch.throughSeq);
  assert.equal(completed.openOrCreateBatch(10), null);
  assert.equal(completed.insert(message('1')), false);
});

test('keeps a CLI-failed batch pending and rejects stale or out-of-order transitions', (t) => {
  const files = fixture(t);
  const first = files.open();
  first.insert(message('1'));
  const batch = first.openOrCreateBatch(10);
  assert.ok(batch);
  assert.equal(batch.replies, null);
  assert.throws(() => first.completeBatch(batch.throughSeq), /all replies/);
  assert.throws(() => first.acknowledgeReply(batch.throughSeq, 0), /not been saved/);
  assert.throws(() => first.saveReplies(batch.throughSeq + 1, []), /does not match/);
  first.close();

  const restarted = files.open();
  assert.deepEqual(restarted.openOrCreateBatch(10), batch);
  restarted.saveReplies(batch.throughSeq, ['first', 'second']);
  restarted.saveReplies(batch.throughSeq, ['first', 'second']);
  assert.throws(() => restarted.saveReplies(batch.throughSeq, ['changed']), /already been saved/);
  assert.throws(() => restarted.acknowledgeReply(batch.throughSeq, 1), /in order/);
  assert.throws(() => restarted.acknowledgeReply(batch.throughSeq, -1), /out of range/);
  assert.throws(() => restarted.acknowledgeReply(batch.throughSeq, 2), /out of range/);
  assert.throws(() => restarted.completeBatch(batch.throughSeq + 1), /does not match/);
  assert.equal(restarted.getCursor(), 0);
  assert.equal(restarted.openOrCreateBatch(10)?.nextReplyIndex, 0);
});

test('distinguishes a generated silent result from a result that has not been generated', (t) => {
  const files = fixture(t);
  const first = files.open();
  first.insert(message('1'));
  const batch = first.openOrCreateBatch(10);
  assert.ok(batch);
  assert.equal(batch.replies, null);
  first.saveReplies(batch.throughSeq, []);
  first.close();

  const restarted = files.open();
  assert.deepEqual(restarted.openOrCreateBatch(10)?.replies, []);
  restarted.completeBatch(batch.throughSeq);
  assert.equal(restarted.getCursor(), batch.throughSeq);
});

test('rolls back cursor advancement when completing the batch fails inside the transaction', (t) => {
  const files = fixture(t);
  const store = files.open();
  store.insert(message('1'));
  const batch = store.openOrCreateBatch(10);
  assert.ok(batch);
  store.saveReplies(batch.throughSeq, []);

  const connection = new DatabaseSync(files.path);
  try {
    connection.exec(`
      CREATE TRIGGER reject_batch_delete BEFORE DELETE ON pending_batch
      BEGIN SELECT RAISE(ABORT, 'injected completion failure'); END;
    `);
    assert.throws(() => store.completeBatch(batch.throughSeq), /injected completion failure/);
    assert.equal(store.getCursor(), 0);
    assert.equal(store.openOrCreateBatch(10)?.throughSeq, batch.throughSeq);
    connection.exec('DROP TRIGGER reject_batch_delete');
    store.completeBatch(batch.throughSeq);
    assert.equal(store.getCursor(), batch.throughSeq);
  } finally {
    connection.close();
  }
});

test('validates batch limits and rejects empty session IDs', (t) => {
  const store = fixture(t).open();
  for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => store.openOrCreateBatch(limit), /positive integer/);
  }
  assert.throws(() => store.setSessionId('  '), /must not be empty/);
  assert.equal(store.getSessionId(), null);
});

test('stores only command metadata and captures its boundary in receive order', (t) => {
  const files = fixture(t);
  const store = files.open();
  store.insert(message('before', false));
  store.insert(command('control', 'compact'));
  store.insert(message('after'));
  assert.deepEqual(store.getPendingCommand(), { id: 1, kind: 'compact', throughSeq: 1, result: null });
  assert.deepEqual(store.openOrCreateBatch(50)?.messages.map((entry) => entry.messageId), ['before', 'after']);
  const connection = new DatabaseSync(files.path);
  try {
    const columns = connection.prepare('PRAGMA table_info(control_commands)').all().map((row) => row.name);
    assert.deepEqual(columns, ['id', 'message_id', 'kind', 'through_seq', 'result', 'done']);
    const persisted = JSON.stringify([
      connection.prepare('SELECT * FROM messages').all(), connection.prepare('SELECT * FROM control_commands').all(),
    ]);
    assert.doesNotMatch(persisted, /private-command-body|private-command-raw/);
    assert.equal(connection.prepare("SELECT COUNT(*) AS count FROM messages WHERE message_id = 'control'").get()?.count, 0);
  } finally { connection.close(); }
});

test('deduplicates command IDs against ordinary messages and completed commands across restart', (t) => {
  const files = fixture(t);
  const store = files.open();
  assert.equal(store.insert(message('ordinary')), true);
  assert.equal(store.insert(command('ordinary', 'new')), false);
  assert.equal(store.insert(command('control', 'compact')), true);
  assert.equal(store.insert(command('control', 'new')), false);
  assert.equal(store.insert(message('control')), false);
  const pending = store.getPendingCommand()!;
  assert.throws(() => store.acknowledgeCommand(pending.id), /not been saved/);
  store.saveCommandResult(pending.id, 'empty');
  store.acknowledgeCommand(pending.id);
  store.acknowledgeCommand(pending.id);
  assert.equal(store.getPendingCommand(), null);
  store.close();
  const restarted = files.open();
  assert.equal(restarted.insert(command('control', 'compact')), false);
  assert.equal(restarted.insert(message('control')), false);
  assert.equal(restarted.getPendingCommand(), null);
  assert.deepEqual(restarted.openOrCreateBatch(50)?.messages.map((entry) => entry.messageId), ['ordinary']);
});

test('new command atomically clears a failed pending batch and skips only preceding messages', (t) => {
  const files = fixture(t);
  const store = files.open();
  store.insert(message('failed'));
  store.setSessionId('old-session');
  const failed = store.openOrCreateBatch(50)!;
  assert.equal(failed.replies, null);
  store.insert(message('before-new', false));
  store.insert(command('control', 'new'));
  store.insert(message('after-new'));
  const pending = store.getPendingCommand()!;
  assert.equal(pending.throughSeq, 2);
  store.resetSessionForCommand(pending.id);
  assert.equal(store.getSessionId(), null);
  assert.equal(store.getCursor(), 2);
  assert.deepEqual(store.getPendingCommand(), { ...pending, result: 'new' });
  assert.deepEqual(store.openOrCreateBatch(50)?.messages.map((entry) => entry.messageId), ['after-new']);
  store.setSessionId('replacement-session');
  store.resetSessionForCommand(pending.id);
  assert.equal(store.getSessionId(), 'replacement-session');
  store.close();
  const restarted = files.open();
  assert.deepEqual(restarted.getPendingCommand(), { ...pending, result: 'new' });
  restarted.acknowledgeCommand(pending.id);
  assert.equal(restarted.getPendingCommand(), null);
  assert.deepEqual(restarted.openOrCreateBatch(50)?.messages.map((entry) => entry.messageId), ['after-new']);
});

test('new command reset rolls back every state change when clearing the pending batch fails', (t) => {
  const files = fixture(t);
  const store = files.open();
  store.insert(message('before'));
  store.setSessionId('old-session');
  const batch = store.openOrCreateBatch(50)!;
  store.saveReplies(batch.throughSeq, ['unsent']);
  store.insert(command('control', 'new'));
  const pending = store.getPendingCommand()!;
  const connection = new DatabaseSync(files.path);
  try {
    connection.exec(`CREATE TRIGGER reject_reset_delete BEFORE DELETE ON pending_batch
      BEGIN SELECT RAISE(ABORT, 'injected reset failure'); END;`);
    assert.throws(() => store.resetSessionForCommand(pending.id), /injected reset failure/);
    assert.equal(store.getCursor(), 0);
    assert.equal(store.getSessionId(), 'old-session');
    assert.equal(store.getPendingCommand()?.result, null);
    assert.deepEqual(store.openOrCreateBatch(50)?.replies, ['unsent']);
  } finally { connection.close(); }
});

test('command result and queue order survive restart without changing the model cursor or pending batch', (t) => {
  const files = fixture(t);
  const store = files.open();
  store.insert(message('ordinary'));
  store.setSessionId('existing-session');
  const batch = store.openOrCreateBatch(50)!;
  store.insert(command('first', 'compact'));
  store.insert(command('second', 'new'));
  const pending = store.getPendingCommand()!;
  assert.throws(() => store.resetSessionForCommand(pending.id), /Only a new/);
  store.saveCommandResult(pending.id, 'compacted');
  store.saveCommandResult(pending.id, 'compacted');
  assert.throws(() => store.saveCommandResult(pending.id, 'failed'), /already been saved/);
  assert.equal(store.getCursor(), 0);
  assert.equal(store.getSessionId(), 'existing-session');
  assert.deepEqual(store.openOrCreateBatch(50), batch);
  store.close();
  const restarted = files.open();
  assert.deepEqual(restarted.getPendingCommand(), { ...pending, result: 'compacted' });
  restarted.acknowledgeCommand(pending.id);
  const next = restarted.getPendingCommand()!;
  assert.equal(next.kind, 'new');
  assert.throws(() => restarted.saveCommandResult(next.id, 'empty'), /does not match/);
  restarted.resetSessionForCommand(next.id);
  restarted.acknowledgeCommand(next.id);
  assert.equal(restarted.getPendingCommand(), null);
  assert.equal(restarted.openOrCreateBatch(50), null);
});

test('new command before any ordinary message leaves subsequent messages available for a new session', (t) => {
  const store = fixture(t).open();
  store.insert(command('control', 'new'));
  assert.equal(store.getPendingCommand()?.throughSeq, 0);
  store.insert(message('after'));
  const pending = store.getPendingCommand()!;
  store.resetSessionForCommand(pending.id);
  store.acknowledgeCommand(pending.id);
  assert.equal(store.getCursor(), 0);
  assert.deepEqual(store.openOrCreateBatch(50)?.messages.map((entry) => entry.messageId), ['after']);
});

test('help stores metadata and a durable result without changing the session, cursor, or active batch', (t) => {
  const files = fixture(t);
  const first = files.open();
  first.insert(message('ordinary'));
  first.setSessionId('existing-session');
  const batch = first.openOrCreateBatch(50)!;
  first.saveReplies(batch.throughSeq, ['unsent']);
  assert.equal(first.insert(command('help-command', 'help')), true);
  assert.equal(first.insert(command('help-command', 'help')), false);
  assert.equal(first.insert(message('help-command')), false);
  const pending = first.getPendingCommand()!;
  assert.deepEqual(pending, { id: 1, kind: 'help', throughSeq: 1, result: null });
  assert.throws(() => first.resetSessionForCommand(pending.id), /Only a new/);
  for (const result of ['compacted', 'empty', 'failed'] as const) {
    assert.throws(() => first.saveCommandResult(pending.id, result), /does not match/);
  }
  first.saveCommandResult(pending.id, 'help');
  first.saveCommandResult(pending.id, 'help');
  first.close();

  const restarted = files.open();
  assert.deepEqual(restarted.getPendingCommand(), { ...pending, result: 'help' });
  assert.equal(restarted.getSessionId(), 'existing-session');
  assert.equal(restarted.getCursor(), 0);
  assert.deepEqual(restarted.openOrCreateBatch(50), { ...batch, replies: ['unsent'], generationDone: true });
  const connection = new DatabaseSync(files.path);
  try {
    const rows = connection.prepare('SELECT * FROM messages').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.message_id, 'ordinary');
    assert.doesNotMatch(JSON.stringify(connection.prepare('SELECT * FROM control_commands').all()), /private-command-body|private-command-raw/);
  } finally { connection.close(); }
  restarted.acknowledgeCommand(pending.id);
  restarted.insert(command('compact-command', 'compact'));
  assert.throws(() => restarted.saveCommandResult(restarted.getPendingCommand()!.id, 'help'), /does not match/);
  restarted.close();

  const completed = files.open();
  assert.equal(completed.insert(command('help-command', 'help')), false);
  assert.equal(completed.getPendingCommand()?.kind, 'compact');
  assert.equal(completed.getSessionId(), 'existing-session');
  assert.equal(completed.getCursor(), 0);
});

function restoreLegacyCommandSchema(connection: DatabaseSync): void {
  connection.exec(`
    DROP TABLE control_commands;
    CREATE TABLE control_commands (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK (kind IN ('new', 'compact')),
      through_seq INTEGER NOT NULL CHECK (through_seq >= 0),
      result TEXT CHECK (result IN ('new', 'compacted', 'empty', 'failed')),
      done INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1))
    );
    PRAGMA user_version = 0;
  `);
}

test('migrates legacy commands atomically while retaining all rows, state, batches, and the command ID sequence', (t) => {
  const files = fixture(t);
  const original = files.open();
  original.insert(message('completed'));
  const completed = original.openOrCreateBatch(50)!;
  original.saveReplies(completed.throughSeq, []);
  original.completeBatch(completed.throughSeq);
  original.insert(message('pending'));
  const pendingBatch = original.openOrCreateBatch(50)!;
  original.saveReplies(pendingBatch.throughSeq, ['sent', 'unsent']);
  original.acknowledgeReply(pendingBatch.throughSeq, 0);
  original.setSessionId('preserved-session');
  original.close();

  const connection = new DatabaseSync(files.path);
  let oldCommands: unknown[];
  let oldState: unknown[];
  let oldMessages: unknown[];
  let oldBatch: unknown[];
  try {
    restoreLegacyCommandSchema(connection);
    connection.exec(`
      INSERT INTO control_commands VALUES
        (2, 'old-new', 'new', 0, 'new', 1),
        (4, 'old-empty', 'compact', 1, 'empty', 1),
        (7, 'pending-confirmation', 'compact', 1, 'compacted', 0),
        (8, 'pending-reset', 'new', 2, NULL, 0),
        (9, 'failed-confirmation', 'compact', 2, 'failed', 0),
        (30, 'deleted', 'compact', 2, NULL, 0);
      DELETE FROM control_commands WHERE id = 30;
    `);
    oldCommands = connection.prepare('SELECT * FROM control_commands ORDER BY id').all();
    oldState = connection.prepare('SELECT * FROM instance_state').all();
    oldMessages = connection.prepare('SELECT * FROM messages ORDER BY seq').all();
    oldBatch = connection.prepare('SELECT * FROM pending_batch').all();
  } finally { connection.close(); }

  const migrated = files.open();
  assert.deepEqual(migrated.getPendingCommand(), { id: 7, kind: 'compact', throughSeq: 1, result: 'compacted' });
  assert.equal(migrated.getSessionId(), 'preserved-session');
  assert.equal(migrated.getCursor(), 1);
  assert.deepEqual(migrated.openOrCreateBatch(50), { ...pendingBatch, replies: ['sent', 'unsent'], nextReplyIndex: 1, generationDone: true });
  const check = new DatabaseSync(files.path);
  try {
    assert.equal(check.prepare('PRAGMA user_version').get()?.user_version, 1);
    assert.deepEqual(check.prepare('SELECT * FROM control_commands ORDER BY id').all(), oldCommands);
    assert.deepEqual(check.prepare('SELECT * FROM instance_state').all(), oldState);
    assert.deepEqual(check.prepare('SELECT * FROM messages ORDER BY seq').all(), oldMessages);
    assert.deepEqual(check.prepare('SELECT * FROM pending_batch').all(), oldBatch);
    assert.equal(check.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'control_commands'").get()?.seq, 30);
  } finally { check.close(); }
  assert.equal(migrated.insert(command('new-help', 'help')), true);
  assert.equal(migrated.insert(command('old-new', 'help')), false);
  migrated.acknowledgeCommand(7);
  migrated.resetSessionForCommand(8);
  migrated.acknowledgeCommand(8);
  migrated.acknowledgeCommand(9);
  assert.deepEqual(migrated.getPendingCommand(), { id: 31, kind: 'help', throughSeq: 2, result: null });
  migrated.saveCommandResult(31, 'help');
  migrated.close();
  const restarted = files.open();
  assert.deepEqual(restarted.getPendingCommand(), { id: 31, kind: 'help', throughSeq: 2, result: 'help' });
  restarted.acknowledgeCommand(31);
  assert.equal(restarted.insert(command('next-help', 'help')), true);
  assert.equal(restarted.getPendingCommand()?.id, 32);
});

test('rolls back a failed legacy migration without replacing the source schema or losing rows', (t) => {
  const files = fixture(t);
  const original = files.open();
  original.insert(message('ordinary'));
  original.setSessionId('existing-session');
  original.openOrCreateBatch(50);
  original.close();
  const connection = new DatabaseSync(files.path);
  try {
    restoreLegacyCommandSchema(connection);
    connection.exec(`
      PRAGMA ignore_check_constraints = ON;
      INSERT INTO control_commands VALUES (5, 'invalid', 'unknown', 1, NULL, 0);
      PRAGMA ignore_check_constraints = OFF;
    `);
    const oldSchema = connection.prepare("SELECT sql FROM sqlite_schema WHERE name = 'control_commands'").get()?.sql;
    const oldRows = connection.prepare('SELECT * FROM control_commands').all();
    assert.throws(() => files.open(), /CHECK constraint failed/);
    assert.equal(connection.prepare('PRAGMA user_version').get()?.user_version, 0);
    assert.equal(connection.prepare("SELECT sql FROM sqlite_schema WHERE name = 'control_commands'").get()?.sql, oldSchema);
    assert.deepEqual(connection.prepare('SELECT * FROM control_commands').all(), oldRows);
    assert.equal(connection.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'control_commands_v1'").get(), undefined);
    assert.equal(connection.prepare('SELECT session_id FROM instance_state').get()?.session_id, 'existing-session');
    assert.equal(connection.prepare('SELECT COUNT(*) AS count FROM messages').get()?.count, 1);
    assert.equal(connection.prepare('SELECT COUNT(*) AS count FROM pending_batch').get()?.count, 1);
    connection.prepare("UPDATE control_commands SET kind = 'compact' WHERE id = 5").run();
  } finally { connection.close(); }
  assert.deepEqual(files.open().getPendingCommand(), { id: 5, kind: 'compact', throughSeq: 1, result: null });
});
