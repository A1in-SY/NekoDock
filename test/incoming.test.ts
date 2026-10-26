import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { busyReply, handleIncomingEvent } from '../src/incoming.js';
import { BridgeStore } from '../src/store.js';
import type { IncomingMessage, Target } from '../src/types.js';

const target: Target = { type: 'group', id: '1001' };
const text = (value: string) => ({ type: 'text', data: { text: value } });
const at = (qq: string) => ({ type: 'at', data: { qq } });
const event = (id: number, overrides: Record<string, unknown> = {}) => ({
  post_type: 'message', message_type: 'group', group_id: 1001, self_id: 999,
  message_id: id, user_id: 123, time: 1_792_727_200,
  sender: { nickname: 'private-sender-name' }, message: [text(`正文${id}`)], ...overrides,
});
const queued: IncomingMessage = {
  messageId: '1', senderId: '123', senderName: '用户', time: 1, text: '正在处理',
  replyTo: null, trigger: true, rawJson: '{}',
};

function fixture(t: TestContext, options: {
  target?: Target;
  probability?: number;
  sendText?: (text: string, signal: AbortSignal) => Promise<void>;
} = {}) {
  const selectedTarget = options.target ?? target;
  const store = new BridgeStore(':memory:', selectedTarget);
  const controller = new AbortController();
  const sent: string[] = [];
  const logs: string[] = [];
  let notifications = 0;
  let randomCalls = 0;
  t.after(() => { controller.abort(); store.close(); });
  const inputOptions = {
    target: selectedTarget, randomReplyProbability: options.probability ?? 1, store,
    processor: { notify() { notifications++; } },
    sender: { sendText: options.sendText ?? (async (value: string, signal: AbortSignal) => {
      assert.equal(signal, controller.signal);
      sent.push(value);
    }) },
    logger: { info: (value: string) => logs.push(value), warn: (value: string) => logs.push(value), error: (value: string) => logs.push(value) },
    signal: controller.signal,
    random: () => { randomCalls++; return 0.1; },
  };
  return {
    store, sent, logs, inputOptions,
    handle: (input: unknown) => handleIncomingEvent(input, inputOptions),
    get notifications() { return notifications; },
    get randomCalls() { return randomCalls; },
  };
}

test('busy ordinary group messages remain context without a trigger or acknowledgement at probability one', async t => {
  const f = fixture(t);
  f.store.insert(queued);
  f.handle(event(2));
  f.handle(event(3, { message: [at('888'), text('另一个话题')] }));
  await nextTurn();
  const batch = f.store.openOrCreateBatch(50)!;
  assert.deepEqual(batch.messages.map(message => [message.messageId, message.trigger]), [['1', true], ['2', false], ['3', false]]);
  assert.equal(f.notifications, 2);
  assert.equal(f.randomCalls, 0);
  assert.deepEqual(f.sent, []);
  assert.ok(f.logs.every(line => !line.includes('busy_reply')));
});

test('first idle trigger immediately marks the queue busy before a batch opens', t => {
  const f = fixture(t);
  assert.equal(f.store.isBusy(), false);
  f.handle(event(1));
  assert.equal(f.store.isBusy(), true);
  f.handle(event(2));
  assert.deepEqual(f.store.openOrCreateBatch(50)?.messages.map(message => message.trigger), [true, false]);
  assert.deepEqual(f.sent, []);
});

test('idle group messages preserve normal probability sampling and mention replies need no busy notice', async t => {
  const f = fixture(t, { probability: 0.5 });
  f.handle(event(1));
  assert.equal(f.randomCalls, 1);
  f.handle(event(2));
  assert.equal(f.randomCalls, 1);
  assert.deepEqual(f.store.openOrCreateBatch(50)?.messages.map(message => message.trigger), [true, false]);
  const idleMention = fixture(t, { probability: 0 });
  idleMention.handle(event(1, { message: [at('999'), text('你好')] }));
  await nextTurn();
  assert.deepEqual(idleMention.sent, []);
  assert.equal(idleMention.store.openOrCreateBatch(50)?.messages[0]?.trigger, true);
});

test('busy direct mention queues the actual message and sends the fixed text outside stored conversation', async t => {
  const f = fixture(t);
  f.store.insert(queued);
  const input = event(2, { message: '[CQ:reply,id=42][CQ:at,qq=999]private-incoming-body' });
  f.handle(input);
  await nextTurn();
  assert.deepEqual(f.sent, ['我正在想上面的消息怎么回，你等会哦']);
  const messages = f.store.openOrCreateBatch(50)!.messages;
  assert.equal(messages.length, 2);
  assert.equal(messages[1]?.trigger, true);
  assert.equal(messages[1]?.text, '[引用 42][@999]private-incoming-body');
  assert.deepEqual(JSON.parse(messages[1]!.rawJson), input);
  assert.ok(messages.every(message => !message.text.includes(busyReply)));
  assert.match(f.logs.join('\n'), /message\.busy_reply\.sent/);
  assert.doesNotMatch(f.logs.join('\n'), /private-incoming-body|private-sender-name|我正在想/);
});

test('busy mention replays, other groups, own messages and escaped mentions never duplicate the notice', async t => {
  const f = fixture(t);
  f.store.insert(queued);
  const mention = event(2, { message: [at('999'), text('问一下')] });
  f.handle(mention); f.handle(mention);
  f.handle(event(3, { group_id: 1002, message: [at('999')] }));
  f.handle(event(4, { user_id: 999, message: [at('999')] }));
  f.handle(event(5, { message: [at('888'), text('你好')] }));
  f.handle(event(6, { message: '&#91;CQ:at,qq=999&#93;' }));
  await nextTurn();
  assert.deepEqual(f.sent, [busyReply]);
  assert.equal(f.notifications, 3);
  assert.deepEqual(f.store.openOrCreateBatch(50)?.messages.map(message => [message.messageId, message.trigger]), [
    ['1', true], ['2', true], ['5', false], ['6', false],
  ]);
});

test('busy private messages keep normal trigger and queue behavior without a busy notice', async t => {
  const f = fixture(t, { target: { type: 'private', id: '123' }, probability: 0 });
  f.store.insert(queued);
  f.handle(event(2, { message_type: 'private', message: [text('正常私聊')] }));
  f.handle(event(3, { message_type: 'private', message: [{ type: 'face', data: { id: '1' } }] }));
  await nextTurn();
  assert.deepEqual(f.sent, []);
  assert.equal(f.randomCalls, 0);
  assert.deepEqual(f.store.openOrCreateBatch(50)?.messages.map(message => message.trigger), [true, true, true]);
});

test('commands stay outside conversation and only explicit busy group mentions get the notice', async t => {
  const f = fixture(t);
  f.store.insert(queued);
  f.handle(event(2, { message: [text('/help')] }));
  f.handle(event(3, { message: [at('999'), text(' /compact')] }));
  f.handle(event(3, { message: [at('999'), text(' /compact')] }));
  await nextTurn();
  assert.deepEqual(f.sent, [busyReply]);
  assert.equal(f.notifications, 2);
  assert.equal(f.store.getPendingCommand()?.kind, 'help');
  assert.deepEqual(f.store.openOrCreateBatch(50)?.messages.map(message => message.messageId), ['1']);
});

test('slow busy acknowledgement does not block later message persistence', async t => {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const sent: string[] = [];
  const f = fixture(t, { sendText: async text => { sent.push(text); await wait; } });
  f.store.insert(queued);
  f.handle(event(2, { message: [at('999'), text('问一下')] }));
  f.handle(event(3));
  assert.deepEqual(sent, [busyReply]);
  assert.equal(f.notifications, 2);
  assert.deepEqual(f.store.openOrCreateBatch(50)?.messages.map(message => message.messageId), ['1', '2', '3']);
  release();
  await nextTurn();
  assert.match(f.logs.join('\n'), /message\.busy_reply\.sent/);
});

test('busy acknowledgement failure is sanitized and never rejects or stops the ordinary queue', async t => {
  for (const sendText of [
    () => { throw new Error('private-token private-error'); },
    () => Promise.reject(new Error('private-token private-error')),
  ]) {
    const f = fixture(t, { sendText });
    f.store.insert(queued);
    assert.doesNotThrow(() => f.handle(event(2, { message: [at('999'), text('问一下')] })));
    await nextTurn();
    f.handle(event(3));
    assert.equal(f.inputOptions.signal.aborted, false);
    assert.equal(f.notifications, 2);
    assert.deepEqual(f.store.openOrCreateBatch(50)?.messages.map(message => message.messageId), ['1', '2', '3']);
    assert.match(f.logs.join('\n'), /message\.busy_reply\.failed/);
    assert.doesNotMatch(f.logs.join('\n'), /private-token|private-error/);
  }
});

test('persistence failure still propagates to the main fatal handler before any send or notify', t => {
  const f = fixture(t);
  f.store.insert(queued);
  f.inputOptions.store.insert = () => { throw new Error('storage unavailable'); };
  assert.throws(() => f.handle(event(2, { message: [at('999'), text('问一下')] })), /storage unavailable/);
  assert.deepEqual(f.sent, []);
  assert.equal(f.notifications, 0);
});
