import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BridgeStore } from '../src/store.js';

const target = { type: 'group' as const, id: '123' };
const message = (id: string) => ({ messageId: id, senderId: '1', senderName: 'test', time: 1,
  text: 'old message', replyTo: null, trigger: true, rawJson: '{}' });
test('Pi activation advances a single cutoff and never replays legacy input or pending replies', () => {
  const store = new BridgeStore(':memory:', target);
  store.insert(message('old-1')); store.insert(message('old-2'));
  store.setSessionId('old-codex-session');
  const batch = store.openOrCreateBatch(10)!;
  store.markGenerationStarted(batch.throughSeq);
  store.saveReplies(batch.throughSeq, ['old unsent reply']);
  const oldConversation = store.recorder.conversationId;
  store.initializeAgentRuntime();
  assert.equal(store.getSessionId(), null); assert.equal(store.getCursor(), 2);
  assert.equal(store.openOrCreateBatch(10), null);
  assert.notEqual(store.recorder.conversationId, oldConversation);
  const newConversation = store.recorder.conversationId;
  store.insert(message('new-3')); store.setSessionId('/data/pi/sessions/new.jsonl');
  store.initializeAgentRuntime();
  assert.equal(store.getCursor(), 2); assert.equal(store.getSessionId(), '/data/pi/sessions/new.jsonl');
  assert.equal(store.recorder.conversationId, newConversation);
  assert.deepEqual(store.openOrCreateBatch(10)!.messages.map(m => m.messageId), ['new-3']);
  store.close();
});
test('Pi activation persists across process-style reopen without clearing the new session or queued input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-activation-')), path = join(dir, 'bridge.sqlite3');
  try {
    let store = new BridgeStore(path, target); store.initializeAgentRuntime();
    store.setSessionId('/data/pi/sessions/current.jsonl'); store.insert(message('new'));
    const conversation = store.recorder.conversationId; store.close();
    store = new BridgeStore(path, target); store.initializeAgentRuntime();
    assert.equal(store.getSessionId(), '/data/pi/sessions/current.jsonl');
    assert.equal(store.getCursor(), 0); assert.equal(store.recorder.conversationId, conversation);
    assert.equal(store.openOrCreateBatch(10)!.messages[0]!.messageId, 'new'); store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
