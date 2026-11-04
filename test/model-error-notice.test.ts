import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { BridgeStore } from '../src/store.js';
import { MemoryStore } from '../src/memory-store.js';
import { modelErrorReply, Processor } from '../src/processor.js';
import type { AgentRunner, IncomingMessage, MessageSender } from '../src/types.js';

const incoming = (id: number, trigger = true): IncomingMessage => ({ messageId: String(id), senderId: '2001',
  senderName: 'Example', time: id, text: `question-${id}`, replyTo: null, trigger, rawJson: '{}' });
const modelFailure = () => Object.assign(new Error('private-provider-error'), { modelFailure: true });
const expectedNotice = modelErrorReply(modelFailure());
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) { assert.ok(Date.now() < deadline, 'processor did not reach expected state'); await delay(5); }
}
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'model-error-notice-'));
  const path = join(directory, 'bridge.sqlite3');
  const store = new BridgeStore(path, { type: 'group', id: '1001' });
  const memory = new MemoryStore(path); memory.enableChatProjection();
  const controller = new AbortController(), logs: string[] = [];
  let running: Promise<void> | undefined;
  t.after(async () => { controller.abort(); await running; memory.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, memory, controller, logs,
    start(agent: AgentRunner, sendText: MessageSender['sendText'], batchSize = 50) {
      const unexpected = async () => { assert.fail('unexpected media send'); };
      const processor = new Processor({ store, agent, sender: { sendText, sendImage: unexpected, sendMessage: unexpected },
        logger: { info: line => logs.push(line), warn: line => logs.push(line), error: line => logs.push(line) },
        batchSize, replyMaxChars: 1500, retryMs: 1, workspace: directory, imageMaxBytes: 1024, imageTimeoutMs: 1000 });
      running = processor.run(controller.signal); return processor;
    },
  };
}

test('model error sends one transport-only notice and the next turn retains no notice context', async t => {
  const f = fixture(t), sent: string[] = [], calls: number[] = [];
  f.store.insert(incoming(1));
  const processor = f.start({ async run(batch, _session, onSession) {
    calls.push(batch.throughSeq); onSession('example-session');
    assert.ok(!JSON.stringify(batch.context).includes(expectedNotice));
    if (batch.throughSeq === 1) throw modelFailure();
    return { messages: [{ type: 'text', text: 'healthy answer' }] };
  } }, async text => { sent.push(text); return { messageId: `qq-${sent.length}` }; });
  await until(() => f.store.getCursor() === 1);
  assert.deepEqual(sent, [expectedNotice]);
  for (const [table, column] of [['messages', 'text'], ['chat_messages', 'text'], ['outgoing_history', 'text'], ['memory_ingest', 'text'], ['console_events', 'payload_json']])
    assert.equal(f.memory.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} LIKE ?`).get(`%${expectedNotice}%`)!.n, 0, table);
  f.store.insert(incoming(2)); processor.notify();
  await until(() => f.store.getCursor() === 2);
  assert.deepEqual(calls, [1, 2]); assert.deepEqual(sent, [expectedNotice, 'healthy answer']);
  assert.doesNotMatch(f.logs.join('\n'), /private-provider-error/);
});

test('model error notice waits for accepted replies to finish sending', async t => {
  const f = fixture(t), order: string[] = [];
  let release!: () => void;
  const ack = new Promise<void>(resolve => { release = resolve; });
  f.controller.signal.addEventListener('abort', () => release(), { once: true });
  f.store.insert(incoming(1));
  f.start({ async run(_batch, _session, _onSession, _signal, tools) {
    await tools!.send({ messages: [{ type: 'text', text: 'progress' }] });
    throw modelFailure();
  } }, async text => {
    order.push(text);
    if (text === 'progress') { await ack; order.push('ack'); }
  });
  await until(() => order.length === 1);
  assert.deepEqual(order, ['progress']); release();
  await until(() => f.store.getCursor() === 1);
  assert.deepEqual(order, ['progress', 'ack', expectedNotice]);
});

test('failed model error notice is attempted once and later messages still run', async t => {
  const f = fixture(t), sent: string[] = [], calls: number[] = [];
  f.store.insert(incoming(1));
  const processor = f.start({ async run(batch) {
    calls.push(batch.throughSeq);
    if (batch.throughSeq === 1) throw modelFailure();
    return { messages: [{ type: 'text', text: 'next answer' }] };
  } }, async text => { sent.push(text); if (text === expectedNotice) throw new Error('private-notice-send-error'); });
  await until(() => f.store.getCursor() === 1);
  f.store.insert(incoming(2)); processor.notify();
  await until(() => f.store.getCursor() === 2);
  assert.deepEqual(calls, [1, 2]); assert.deepEqual(sent, [expectedNotice, 'next answer']);
  assert.match(f.logs.join('\n'), /processor\.model_error_reply\.failed/);
  assert.doesNotMatch(f.logs.join('\n'), /private-notice-send-error/);
});

test('background batches, local runtime errors and cancellation do not send model error notices', async t => {
  for (const reason of ['background', 'runtime', 'cancelled']) await t.test(reason, async t => {
    const f = fixture(t), sent: string[] = [];
    f.store.insert(incoming(1, reason !== 'background'));
    if (reason === 'background') f.store.insert(incoming(2));
    f.start({ async run(batch) {
      if (reason === 'cancelled') f.controller.abort();
      if (reason === 'runtime') throw new Error('PI_EXECUTION_FAILED');
      if (batch.throughSeq === 1) throw modelFailure();
      return { messages: [] };
    } }, async text => { sent.push(text); }, 1);
    await until(() => f.store.getCursor() === (reason === 'background' ? 2 : 1));
    assert.deepEqual(sent, []);
  });
});
