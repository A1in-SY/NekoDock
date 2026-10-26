import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BridgeStore } from '../src/store.js';
import { Processor, splitMessage, splitReply } from '../src/processor.js';
import type { BridgeCommand, AgentResult, AgentRunner, IncomingMessage, MessageSegment, MessageSender, SegmentMessage } from '../src/types.js';

const target = { type: 'group' as const, id: '1001' };
const logger = { info() {}, warn() {}, error() {} };
const noImages = async () => { assert.fail('Unexpected image'); };
const noMessages = async () => { assert.fail('Unexpected segment message'); };
const result = (text: string | null): AgentResult => ({ messages: text === null ? [] : [{ type: 'text', text }] });
function message(id: number, trigger = true): IncomingMessage {
  return { messageId: String(id), senderId: '2001', senderName: '用户', time: id, text: `消息${id}`, replyTo: null, trigger, rawJson: '{}' };
}
function command(id: number, kind: BridgeCommand): IncomingMessage {
  return { ...message(id), text: `/${kind}`, command: kind, rawJson: `{"text":"/${kind}"}` };
}
async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > end) throw new Error('等待处理结果超时');
    await delay(5);
  }
}
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'bridge-processor-'));
  const store = new BridgeStore(join(directory, 'bridge.sqlite3'), target);
  const controller = new AbortController();
  const logs: string[] = [];
  const capturedLogger = { info: (value: string) => logs.push(value), warn: (value: string) => logs.push(value), error: (value: string) => logs.push(value) };
  let running: Promise<void> | undefined;
  t.after(async () => { controller.abort(); await running; store.close(); rmSync(directory, { recursive: true, force: true }); });
  return {
    store,
    directory,
    logs,
    start(agent: AgentRunner, sender: Pick<MessageSender, 'sendText'> & Partial<Pick<MessageSender, 'sendImage' | 'sendMessage'>>, batchSize = 50, replyMaxChars = 1500) {
      const processor = new Processor({ store, agent, sender: { sendImage: noImages, sendMessage: noMessages, ...sender }, logger: capturedLogger, batchSize, replyMaxChars, retryMs: 1, workspace: directory, imageMaxBytes: 10485760, imageTimeoutMs: 1000 });
      running = processor.run(controller.signal);
      return processor;
    },
  };
}

test('未触发消息保留，后续触发时一起作为上下文提交', async (t) => {
  const f = fixture(t);
  const received: string[][] = [];
  const replies: string[] = [];
  f.store.insert(message(1, false));
  const processor = f.start({ async run(batch) { received.push(batch.messages.map((m) => m.messageId)); return result('回复'); } }, { async sendText(text) { replies.push(text); } });
  await delay(15);
  assert.equal(received.length, 0);
  assert.equal(f.store.getCursor(), 0);
  f.store.insert(message(2)); processor.notify();
  await until(() => f.store.getCursor() === 2);
  assert.deepEqual(received, [['1', '2']]);
  assert.deepEqual(replies, ['回复']);
});

test('批次日志记录一次发送失败与耗时，隐藏正文和原始错误', async (t) => {
  const f = fixture(t);
  f.store.insert({ ...message(1), text: 'private-incoming-body', senderName: 'private-sender-name' });
  let generated = 0;
  let sent = 0;
  f.start({ async run() {
    generated++;
    return result('private-outgoing-body');
  } }, { async sendText() {
    if (++sent === 1) throw new Error('private-error-message token=private-secret');
  } });
  await until(() => f.store.getCursor() === 1);
  assert.equal(generated, 1);
  assert.equal(sent, 1);
  const logs = f.logs.join('\n');
  assert.match(logs, /processor\.batch\.started through_seq=1 count=1 reply_allowed=true next_reply_index=0/);
  assert.match(logs, /processor\.batch\.result_saved .*reply_count=1/);
  assert.match(logs, /processor\.reply\.failed .*stage="send".*status="unconfirmed"/);
  assert.doesNotMatch(logs, /processor\.batch\.resumed/);
  assert.match(logs, /processor\.reply\.send_started .*reply_index=0 type="text"/);
  assert.doesNotMatch(logs, /processor\.reply\.sent |processor\.reply\.acknowledged /);
  assert.match(logs, /processor\.batch\.completed .*cursor=1.*duration_ms=\d+/);
  assert.doesNotMatch(logs, /private-incoming-body|private-sender-name|private-outgoing-body|private-error-message|private-secret/);
});

test('同一助手消息的思考快照逐条记录并保留批次 runId',async t=>{
 const f=fixture(t);f.store.insert(message(1));
 f.start({async run(_batch,_session,_onSession,_signal,_tools,observe){
   observe?.({type:'thinking.updated',itemId:'assistant-one',payload:{text:'first visible step',status:'in_progress'}});
   observe?.({type:'thinking.updated',itemId:'assistant-one',payload:{text:'first visible step and result',status:'completed'}});
   return result('answer');
 }},{async sendText(){}});
 await until(()=>f.store.getCursor()===1);
 const events=f.store.recorder.pending().filter(event=>event.type==='thinking.updated');
 assert.equal(events.length,2);assert.deepEqual(events.map(event=>event.payload.status),['in_progress','completed']);
 assert.equal(new Set(events.map(event=>event.runId)).size,1);assert.ok(events[0]!.runId);
 assert.deepEqual(events.map(event=>event.itemId),['assistant-one','assistant-one']);assert.doesNotMatch(f.logs.join('\n'),/first visible step/);
});

test('批次失败日志区分模型生成、结果保存与发送后 ACK 阶段', async (t) => {
  for (const stage of ['agent', 'replies_save', 'reply_ack']) await t.test(stage, async (t) => {
    const f = fixture(t);
    f.store.insert(message(1));
    let failed = false;
    const failOnce = () => {
      if (!failed) { failed = true; throw new Error('sensitive-detail https://secret.example/?token=hidden'); }
    };
    if (stage === 'replies_save') {
      const save = f.store.saveReplies.bind(f.store);
      f.store.saveReplies = (...args) => { failOnce(); save(...args); };
    } else if (stage === 'reply_ack') {
      const acknowledge = f.store.acknowledgeReply.bind(f.store);
      f.store.acknowledgeReply = (...args) => { failOnce(); return acknowledge(...args); };
    }
    f.start({ async run() {
      if (stage === 'agent') failOnce();
      return result('答复');
    } }, { async sendText() {} });
    await until(() => f.store.getCursor() === 1);
    const logs = f.logs.join('\n');
    assert.match(logs, new RegExp(`processor\\.batch\\.failed .*stage="${stage}".*replayed=false`));
    assert.doesNotMatch(logs, /sensitive-detail|secret\.example|token=hidden/);
  });
});

test('执行期间继续落库，下一批立即处理且最多一个 CLI', async (t) => {
  const f = fixture(t);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const batches: string[][] = [];
  let active = 0;
  f.store.insert(message(1));
  const processor = f.start({ async run(batch) {
    assert.equal(++active, 1);
    batches.push(batch.messages.map((m) => m.messageId));
    if (batches.length === 1) await gate;
    active--;
    return result('完成');
  } }, { async sendText() {} });
  await until(() => batches.length === 1);
  assert.equal(f.store.insert(message(2)), true);
  assert.equal(f.store.insert(message(3)), true);
  processor.notify();
  assert.equal(f.store.getCursor(), 0);
  assert.deepEqual(f.store.openOrCreateBatch(50)?.messages.map((m) => m.messageId), ['1']);
  release();
  await until(() => f.store.getCursor() === 3);
  assert.deepEqual(batches, [['1'], ['2', '3']]);
});

test('忙碌时收到两位用户的问题，下一轮同批生成并分别发送艾特回复', async (t) => {
  const f = fixture(t);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const batches: string[][] = [];
  const sent: (string | MessageSegment[])[] = [];
  const separateReplies: SegmentMessage[] = [
    { type: 'message', segments: [{ type: 'at', userId: '2001' }, { type: 'text', text: ' 问题1的回答' }] },
    { type: 'message', segments: [{ type: 'at', userId: '2002' }, { type: 'text', text: ' 问题2的回答' }] },
  ];
  f.store.insert(message(1));
  const processor = f.start({ async run(batch) {
    batches.push(batch.messages.map((entry) => entry.messageId));
    if (batches.length === 1) { await gate; return result('上一轮回复'); }
    assert.deepEqual(batch.messages.map((entry) => [entry.senderId, entry.text]), [
      ['2001', '问题1'], ['2002', '问题2'],
    ]);
    return { messages: separateReplies };
  } }, {
    async sendText(text) { sent.push(text); },
    async sendMessage(segments) {
      assert.deepEqual(f.store.openOrCreateBatch(50)?.replies, separateReplies);
      sent.push(segments);
    },
  });
  await until(() => batches.length === 1);
  f.store.insert({ ...message(2), text: '问题1' });
  f.store.insert({ ...message(3), senderId: '2002', senderName: '用户B', text: '问题2' });
  processor.notify();
  assert.deepEqual(batches, [['1']]);
  release();
  await until(() => f.store.getCursor() === 3);
  assert.deepEqual(batches, [['1'], ['2', '3']]);
  assert.deepEqual(sent, ['上一轮回复', ...separateReplies.map((entry) => entry.segments)]);
});

test('发送失败结束当前分段并继续后续分段，不再次生成回复', async (t) => {
  const f = fixture(t);
  let generated = 0;
  const attempts: string[] = [];
  f.store.insert(message(1));
  f.start({ async run() { generated++; return result('a😀b'); } }, { async sendText(text) {
    attempts.push(text);
    if (attempts.length === 1) { assert.equal(f.store.getCursor(), 0); throw new Error('模拟断线'); }
  } }, 50, 2);
  await until(() => f.store.getCursor() === 1);
  assert.equal(generated, 1);
  assert.deepEqual(attempts, ['a😀', 'b']);
});

test('重启放弃旧待发结果，不调用 CLI', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'bridge-restart-'));
  const path = join(directory, 'bridge.sqlite3');
  const first = new BridgeStore(path, target);
  first.insert(message(1));
  first.setSessionId('existing-session');
  const batch = first.openOrCreateBatch(50)!;
  first.saveReplies(batch.throughSeq, ['已确认', '待发送']);
  first.acknowledgeReply(batch.throughSeq, 0);
  first.close();
  const store = new BridgeStore(path, target);
  const controller = new AbortController();
  const sent: string[] = [];
  let called = false;
  const processor = new Processor({ store, logger, batchSize: 50, replyMaxChars: 1500, retryMs: 1, workspace: directory, imageMaxBytes: 10485760, imageTimeoutMs: 1000,
    agent: { async run() { called = true; throw new Error('不能重新执行'); } },
    sender: { sendImage: noImages, sendMessage: noMessages, async sendText(text) { sent.push(text); } },
  });
  const running = processor.run(controller.signal);
  t.after(async () => { controller.abort(); await running; store.close(); rmSync(directory, { recursive: true, force: true }); });
  await until(() => store.getCursor() === 1);
  assert.equal(called, false);
  assert.equal(store.getSessionId(), 'existing-session');
  assert.deepEqual(sent, []);
});

test('CLI 失败结束当前批次并保留会话，继续处理新消息', async (t) => {
  const f = fixture(t);
  f.store.insert(message(1));
  const calls: string[][] = [];
  f.start({ async run(batch, sessionId, onSession) {
    calls.push(batch.messages.map((m) => m.messageId));
    if (calls.length === 1) {
      onSession('session-1');
      f.store.insert(message(2));
      throw new Error('模拟 CLI 失败');
    }
    assert.equal(sessionId, 'session-1');
    if (calls.length === 2) assert.equal(f.store.getCursor(), 1);
    return result('回复');
  } }, { async sendText() {} });
  await until(() => f.store.getCursor() === 2);
  assert.deepEqual(calls, [['1'], ['2']]);
});

test('长上下文按批补齐，未触发前缀不发言', async (t) => {
  const f = fixture(t);
  f.store.insert(message(1, false)); f.store.insert(message(2, false)); f.store.insert(message(3));
  const permissions: boolean[] = [];
  const sent: string[] = [];
  f.start({ async run(batch) { permissions.push(batch.replyAllowed); return result(batch.replyAllowed ? '最终回复' : null); } }, { async sendText(text) { sent.push(text); } }, 2);
  await until(() => f.store.getCursor() === 3);
  assert.deepEqual(permissions, [false, true]);
  assert.deepEqual(sent, ['最终回复']);
});

test('分段保持 Unicode 字符完整', () => {
  assert.deepEqual(splitReply('你好😀世界', 2), ['你好', '😀世', '界']);
  assert.deepEqual(splitReply('', 2), []);
  assert.throws(() => splitReply('x', 0));
});

test('组合消息按 Unicode 文字总长度分段，艾特保序且只保留一次', () => {
  const source: MessageSegment[] = [
    { type: 'at', userId: '2001' }, { type: 'text', text: 'a😀b' },
    { type: 'at', userId: '2002' }, { type: 'text', text: 'cd' }, { type: 'at', userId: '2003' },
  ];
  const original = structuredClone(source);
  assert.deepEqual(splitMessage(source, 2), [
    { type: 'message', segments: [{ type: 'at', userId: '2001' }, { type: 'text', text: 'a😀' }] },
    { type: 'message', segments: [
      { type: 'text', text: 'b' }, { type: 'at', userId: '2002' }, { type: 'text', text: 'c' },
    ] },
    { type: 'message', segments: [{ type: 'text', text: 'd' }, { type: 'at', userId: '2003' }] },
  ]);
  assert.deepEqual(source, original);
  assert.deepEqual(splitMessage([], 2), []);
  for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => splitMessage(source, limit), /无效/);
  }
});

test('分段边界的艾特跟随后续文字，结尾艾特保留在最后一条', () => {
  assert.deepEqual(splitMessage([
    { type: 'text', text: 'ab' }, { type: 'at', userId: '2001' }, { type: 'at', userId: '2002' },
    { type: 'text', text: '😀c' }, { type: 'at', userId: '2003' },
  ], 2), [
    { type: 'message', segments: [{ type: 'text', text: 'ab' }] },
    { type: 'message', segments: [
      { type: 'at', userId: '2001' }, { type: 'at', userId: '2002' },
      { type: 'text', text: '😀c' }, { type: 'at', userId: '2003' },
    ] },
  ]);
  assert.deepEqual(splitMessage([{ type: 'at', userId: '2001' }, { type: 'at', userId: '2002' }], 2), [
    { type: 'message', segments: [{ type: 'at', userId: '2001' }, { type: 'at', userId: '2002' }] },
  ]);
  assert.deepEqual(splitMessage([{ type: 'text', text: 'ab  cd' }], 2), ['ab', '  ', 'cd'].map((text) => ({
    type: 'message', segments: [{ type: 'text', text }],
  })));
});

test('组合回复使用配置的长度持久化分段，发送时保留艾特与表情字符', async (t) => {
  const f = fixture(t);
  const expected: SegmentMessage[] = [
    { type: 'message', segments: [{ type: 'text', text: 'ab' }] },
    { type: 'message', segments: [{ type: 'at', userId: '2001' }, { type: 'text', text: '😀c' }] },
    { type: 'message', segments: [{ type: 'text', text: 'd' }, { type: 'at', userId: '2002' }] },
  ];
  const sent: MessageSegment[][] = [];
  f.store.insert(message(1));
  f.start({ async run() { return { messages: [{ type: 'message', segments: [
    { type: 'text', text: 'ab' }, { type: 'at', userId: '2001' },
    { type: 'text', text: '😀cd' }, { type: 'at', userId: '2002' },
  ] }] }; } }, {
    async sendText() { assert.fail('组合消息不能降为纯文字'); },
    async sendMessage(segments) {
      assert.deepEqual(f.store.openOrCreateBatch(50)?.replies, expected);
      sent.push(segments);
    },
  }, 50, 2);
  await until(() => f.store.getCursor() === 1);
  assert.deepEqual(sent, expected.map((entry) => entry.segments));
});

test('关机信号与成功结果交错时结束批次，不保留待发结果', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'bridge-shutdown-'));
  const path = join(directory, 'bridge.sqlite3');
  const store = new BridgeStore(path, target);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.insert(message(1));
  const controller = new AbortController();
  let sent = false;
  const processor = new Processor({ store, logger, batchSize: 50, replyMaxChars: 1500, retryMs: 1, workspace: directory, imageMaxBytes: 10485760, imageTimeoutMs: 1000,
    agent: { async run() { controller.abort(); return result('已完成的结果'); } },
    sender: { sendImage: noImages, sendMessage: noMessages, async sendText() { sent = true; } },
  });
  await processor.run(controller.signal);
  assert.equal(sent, false);
  assert.equal(store.getCursor(), 1);
  assert.equal(store.peekPendingBatch(), null);
});

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH8sAAAAASUVORK5CYII=', 'base64');

test('图片与文字按输出顺序发送，图片失败结束发送项且不重跑 CLI', async (t) => {
  const f = fixture(t);
  const path = join(f.directory, 'chart.png');
  writeFileSync(path, png);
  f.store.insert(message(1));
  const sent: string[] = [];
  let generated = 0;
  let imageAttempts = 0;
  f.start({ async run() { generated++; return { messages: [
    { type: 'text', text: '结果' }, { type: 'image', path }, { type: 'text', text: '说明' },
  ] }; } }, {
    async sendText(text) { sent.push(text); },
    async sendImage(file) {
      sent.push('image');
      assert.equal(file, `base64://${png.toString('base64')}`);
      assert.equal(generated, 1);
      assert.deepEqual(f.store.openOrCreateBatch(50)?.replies?.[1], { type: 'image', file });
      if (++imageAttempts === 1) { rmSync(path); throw new Error('模拟图片发送失败'); }
    },
  });
  await until(() => f.store.getCursor() === 1);
  assert.equal(generated, 1);
  assert.deepEqual(sent, ['结果', 'image', '说明']);
  const logs = f.logs.join('\n');
  assert.equal(f.logs.filter(line => line.startsWith('processor.image.prepare_started ')).length, 1);
  assert.match(logs, /processor\.image\.prepared .*reply_index=1.*duration_ms=\d+/);
  assert.match(logs, /processor\.reply\.failed .*reply_index=1.*status="unconfirmed"/);
  assert.doesNotMatch(logs, /chart\.png|base64:\/\/|模拟图片发送失败/);
});

test('混合文字图片与多人艾特回复，组合消息失败只尝试一次且不重跑 CLI', async (t) => {
  const f = fixture(t);
  const path = join(f.directory, 'chart.png');
  writeFileSync(path, png);
  f.store.insert(message(1));
  const first: SegmentMessage = { type: 'message', segments: [
    { type: 'at', userId: '2001' }, { type: 'text', text: ' 回答A' },
  ] };
  const second: SegmentMessage = { type: 'message', segments: [
    { type: 'at', userId: '2002' }, { type: 'text', text: ' 回答B' },
  ] };
  const sent: (string | MessageSegment[])[] = [];
  let generated = 0;
  let secondAttempts = 0;
  f.start({ async run() {
    generated++;
    return { messages: [{ type: 'text', text: '结果' }, first, { type: 'image', path }, second] };
  } }, {
    async sendText(text) { sent.push(text); },
    async sendImage(file) {
      assert.equal(file, `base64://${png.toString('base64')}`);
      sent.push('image');
    },
    async sendMessage(segments) {
      sent.push(segments);
      if (segments[0]?.type === 'at' && segments[0].userId === '2002' && ++secondAttempts === 1) {
        assert.equal(f.store.openOrCreateBatch(50)?.nextReplyIndex, 3);
        throw new Error('模拟组合消息发送失败');
      }
    },
  });
  await until(() => f.store.getCursor() === 1);
  assert.equal(generated, 1);
  assert.equal(secondAttempts, 1);
  assert.deepEqual(sent, ['结果', first.segments, 'image', second.segments]);
});

test('重启不补发旧格式文字图片及组合消息', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'bridge-segments-restart-'));
  const path = join(directory, 'bridge.sqlite3');
  const first = new BridgeStore(path, target);
  first.insert(message(1));
  first.setSessionId('existing-session');
  const batch = first.openOrCreateBatch(50)!;
  const confirmed: SegmentMessage = { type: 'message', segments: [
    { type: 'at', userId: '2001' }, { type: 'text', text: ' 已确认' },
  ] };
  const waiting: SegmentMessage = { type: 'message', segments: [
    { type: 'at', userId: '2002' }, { type: 'text', text: ' 待发送' },
  ] };
  first.saveReplies(batch.throughSeq, [confirmed, '旧格式文字', { type: 'image', file: '/deleted/chart.png' }, waiting]);
  first.saveImage(batch.throughSeq, 2, `base64://${png.toString('base64')}`);
  first.acknowledgeReply(batch.throughSeq, 0);
  first.close();
  const store = new BridgeStore(path, target);
  const controller = new AbortController();
  const sent: (string | MessageSegment[])[] = [];
  const processor = new Processor({ store, logger, batchSize: 50, replyMaxChars: 1500, retryMs: 1,
    workspace: directory, imageMaxBytes: 10485760, imageTimeoutMs: 1000,
    agent: { async run() { assert.fail('不能重新执行 CLI'); } },
    sender: {
      async sendText(text) { sent.push(text); },
      async sendImage(file) { assert.equal(file, `base64://${png.toString('base64')}`); sent.push('image'); },
      async sendMessage(segments) { sent.push(segments); },
    },
  });
  const running = processor.run(controller.signal);
  t.after(async () => { controller.abort(); await running; store.close(); rmSync(directory, { recursive: true, force: true }); });
  await until(() => store.getCursor() === 1);
  assert.equal(store.getSessionId(), 'existing-session');
  assert.deepEqual(sent, []);
});

test('图片读取失败结束发送项，后续文件出现也不自动补发', async t => {
  const f = fixture(t); const path = join(f.directory, 'late.png');
  f.store.insert(message(1)); let generated = 0; let images = 0;
  f.start({ async run() { generated++; return { messages: [{ type: 'image', path }] }; } }, {
    async sendText() { assert.fail('不应发送文字'); }, async sendImage() { images++; },
  });
  await until(() => f.store.getCursor() === 1);
  writeFileSync(path, png); await delay(10);
  assert.equal(generated, 1); assert.equal(images, 0);
  assert.match(f.logs.join('\n'), /processor\.reply\.failed .*stage="image_prepare".*status="failed"/);
  assert.doesNotMatch(f.logs.join('\n'), /late\.png/);
});

test('/new 由桥接层处理，指令和确认均不进入模型输入', async (t) => {
  const f = fixture(t);
  f.store.setSessionId('old-session');
  f.store.insert(message(1, false));
  f.store.insert(command(2, 'new'));
  f.store.insert(message(3));
  const calls: string[][] = [];
  const sent: string[] = [];
  f.start({ async run(batch, sessionId) {
    assert.equal(sessionId, null);
    calls.push(batch.messages.map((entry) => entry.text));
    return result('新回复');
  } }, { async sendText(text) { sent.push(text); } });
  await until(() => f.store.getCursor() === 2);
  assert.deepEqual(calls, [['消息3']]);
  assert.deepEqual(sent, ['已重置会话，下条消息将开启新对话。', '新回复']);
  assert.equal(f.store.getPendingCommand(), null);
  assert.equal(f.store.openOrCreateBatch(50), null);
  assert.equal(f.store.insert(command(2, 'new')), false);
});

test('忙碌时先完成当前轮，再执行 /new，之后收到的消息保留到新会话', async (t) => {
  const f = fixture(t);
  f.store.setSessionId('old-session');
  f.store.insert(message(1));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const calls: string[][] = [];
  const sessions: (string | null)[] = [];
  const sent: string[] = [];
  const processor = f.start({ async run(batch, sessionId, onSession) {
    calls.push(batch.messages.map((entry) => entry.messageId));
    sessions.push(sessionId);
    if (calls.length === 1) { await gate; return result('旧轮已完成'); }
    onSession('new-session');
    return result('新轮已完成');
  } }, { async sendText(text) { sent.push(text); } });
  await until(() => calls.length === 1);
  f.store.insert(message(2));
  f.store.insert(command(3, 'new'));
  f.store.insert(message(4));
  processor.notify();
  assert.equal(f.store.getSessionId(), 'old-session');
  assert.deepEqual(sent, []);
  release();
  await until(() => f.store.getCursor() === 3);
  assert.deepEqual(calls, [['1'], ['4']]);
  assert.deepEqual(sessions, ['old-session', null]);
  assert.deepEqual(sent, ['旧轮已完成', '已重置会话，下条消息将开启新对话。', '新轮已完成']);
  assert.equal(f.store.getSessionId(), 'new-session');
});

test('/new 可清除 CLI 失败的旧批次，下一批不会继续旧会话', async (t) => {
  const f = fixture(t);
  f.store.insert(message(1));
  const calls: string[][] = [];
  const sent: string[] = [];
  f.start({ async run(batch, sessionId, onSession) {
    calls.push(batch.messages.map((entry) => entry.messageId));
    if (calls.length === 1) {
      onSession('failed-session');
      f.store.insert(command(2, 'new'));
      f.store.insert(message(3));
      throw new Error('模拟 CLI 失败');
    }
    assert.equal(sessionId, null);
    return result('恢复完成');
  } }, { async sendText(text) { sent.push(text); } });
  await until(() => f.store.getCursor() === 2);
  assert.deepEqual(calls, [['1'], ['3']]);
  assert.deepEqual(sent, ['已重置会话，下条消息将开启新对话。', '恢复完成']);
});

test('/new 确认发送失败仅重发确认，不再次重置会话', async (t) => {
  const f = fixture(t);
  f.store.setSessionId('old-session');
  f.store.insert(command(1, 'new'));
  let resets = 0;
  const reset = f.store.resetSessionForCommand.bind(f.store);
  f.store.resetSessionForCommand = (id) => { resets++; reset(id); };
  let attempts = 0;
  f.start({ async run() { assert.fail('指令不能进入模型'); } }, { async sendText(text) {
    assert.equal(text, '已重置会话，下条消息将开启新对话。');
    assert.equal(f.store.getPendingCommand()?.result, 'new');
    if (++attempts === 1) {
      f.store.setSessionId('retained-marker');
      throw new Error('模拟发送失败');
    }
  } });
  await until(() => f.store.getPendingCommand() === null);
  assert.equal(attempts, 2);
  assert.equal(resets, 1);
  assert.equal(f.store.getSessionId(), 'retained-marker');
});

test('/help 列出指令，不启动模型且保留会话与尚未触发的消息', async (t) => {
  const f = fixture(t);
  f.store.setSessionId('existing-session');
  f.store.insert(message(1, false));
  f.store.insert(command(2, 'help'));
  const sent: string[] = [];
  const calls: string[][] = [];
  const processor = f.start({
    async compact() { assert.fail('/help 不能压缩会话'); },
    async run(batch, sessionId) {
      assert.equal(sessionId, 'existing-session');
      calls.push(batch.messages.map((entry) => entry.text));
      return result('正常回复');
    },
  }, { async sendText(text) {
    if (sent.length === 0) assert.equal(f.store.getPendingCommand()?.result, 'help');
    sent.push(text);
  } });
  await until(() => f.store.getPendingCommand() === null);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /\/help.*查看指令/);
  assert.match(sent[0]!, /\/new.*重置会话.*保留聊天记录.*文件/);
  assert.match(sent[0]!, /\/compact.*压缩.*保留会话/);
  assert.match(sent[0]!, /群聊和私聊均可用.*无需 @.*当前轮完成后执行并回复结果/);
  assert.equal(f.store.getSessionId(), 'existing-session');
  assert.equal(f.store.getCursor(), 0);
  assert.equal(f.store.openOrCreateBatch(50), null);
  assert.equal(f.store.insert(command(2, 'help')), false);
  assert.deepEqual(calls, []);

  f.store.insert(message(3));
  processor.notify();
  await until(() => f.store.getCursor() === 2);
  assert.deepEqual(calls, [['消息1', '消息3']]);
  assert.equal(sent[1], '正常回复');
});

test('/help 不改变已有普通消息批次，旧执行随后结束且不补发', async (t) => {
  const f = fixture(t);
  f.store.setSessionId('existing-session');
  f.store.insert(message(1));
  const batch = f.store.openOrCreateBatch(50)!;
  f.store.saveReplies(batch.throughSeq, ['已有回复']);
  const before = f.store.openOrCreateBatch(50);
  f.store.insert(command(2, 'help'));
  const sent: string[] = [];
  f.start({
    async compact() { assert.fail('/help 不能压缩会话'); },
    async run() { assert.fail('帮助和已生成的回复不能调用模型'); },
  }, { async sendText(text) {
    if (sent.length === 0) {
      assert.match(text, /^可用指令：/);
      assert.deepEqual(f.store.openOrCreateBatch(50), before);
      assert.equal(f.store.getSessionId(), 'existing-session');
      assert.equal(f.store.getCursor(), 0);
    }
    sent.push(text);
  } });
  await until(() => f.store.getCursor() === 1);
  assert.equal(sent.length, 1);
  assert.equal(f.store.getSessionId(), 'existing-session');
});

test('/help 发送失败只重试已持久化的帮助，不改变会话', async (t) => {
  const f = fixture(t);
  f.store.setSessionId('existing-session');
  f.store.insert(command(1, 'help'));
  const save = f.store.saveCommandResult.bind(f.store);
  let saved = 0;
  f.store.saveCommandResult = (id, result) => { saved++; save(id, result); };
  const attempts: string[] = [];
  f.start({
    async compact() { assert.fail('/help 不能压缩会话'); },
    async run() { assert.fail('/help 不能进入模型'); },
  }, { async sendText(text) {
    assert.equal(f.store.getPendingCommand()?.result, 'help');
    attempts.push(text);
    if (attempts.length === 1) throw new Error('模拟帮助发送失败');
  } });
  await until(() => f.store.getPendingCommand() === null);
  assert.equal(saved, 1);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0], attempts[1]);
  assert.equal(f.store.getSessionId(), 'existing-session');
  assert.equal(f.store.getCursor(), 0);
  const logs = f.logs.join('\n');
  assert.match(logs, /processor\.command\.started command_id=1 kind="help" result=null confirmation_only=false/);
  assert.match(logs, /processor\.command\.result_saved .*result="help"/);
  assert.match(logs, /processor\.command\.failed .*stage="confirmation_send".*retry_ms=1/);
  assert.match(logs, /processor\.command\.resumed .*confirmation_only=true/);
  assert.match(logs, /processor\.command\.confirmation_sent .*result="help"/);
  assert.match(logs, /processor\.command\.completed .*duration_ms=\d+/);
  assert.doesNotMatch(logs, /模拟帮助发送失败|可用指令：|existing-session/);
});

test('/compact 压缩现有会话，不提前提交尚未触发的 QQ 消息', async (t) => {
  const f = fixture(t);
  f.store.setSessionId('existing-session');
  f.store.insert(message(1, false));
  f.store.insert(command(2, 'compact'));
  const operations: string[] = [];
  const calls: string[][] = [];
  const processor = f.start({
    async compact(sessionId) { assert.equal(sessionId, 'existing-session'); operations.push('compact'); },
    async run(batch, sessionId) {
      assert.equal(sessionId, 'existing-session');
      calls.push(batch.messages.map((entry) => entry.messageId));
      operations.push('model');
      return result('正常回复');
    },
  }, { async sendText(text) { operations.push(text); } });
  await until(() => f.store.getPendingCommand() === null);
  assert.equal(f.store.getCursor(), 0);
  assert.deepEqual(calls, []);
  assert.deepEqual(operations, ['compact', '上下文已压缩。']);
  f.store.insert(message(3)); processor.notify();
  await until(() => f.store.getCursor() === 2);
  assert.deepEqual(calls, [['1', '3']]);
  assert.deepEqual(operations, ['compact', '上下文已压缩。', 'model', '正常回复']);
});

test('/compact 没有会话时仅返回桥接确认，不启动模型', async (t) => {
  const f = fixture(t);
  f.store.insert(command(1, 'compact'));
  const sent: string[] = [];
  f.start({
    async compact() { assert.fail('没有会话不能压缩'); },
    async run() { assert.fail('指令不能作为新会话输入'); },
  }, { async sendText(text) { sent.push(text); } });
  await until(() => f.store.getPendingCommand() === null);
  assert.deepEqual(sent, ['当前没有可压缩的会话。']);
  assert.equal(f.store.getSessionId(), null);
  assert.equal(f.store.getCursor(), 0);
});

test('/compact 失败后返回一次失败确认，继续正常消息且不自动重跑压缩', async (t) => {
  const f = fixture(t);
  f.store.setSessionId('existing-session');
  f.store.insert(command(1, 'compact'));
  f.store.insert(message(2));
  let compactions = 0;
  const sent: string[] = [];
  f.start({
    async compact() { compactions++; throw new Error('模拟压缩失败'); },
    async run(batch, sessionId) {
      assert.equal(sessionId, 'existing-session');
      assert.deepEqual(batch.messages.map((entry) => entry.messageId), ['2']);
      return result('正常回复');
    },
  }, { async sendText(text) {
    if (sent.length === 0) assert.equal(f.store.getPendingCommand()?.result, 'failed');
    sent.push(text);
  } });
  await until(() => f.store.getCursor() === 1);
  assert.equal(compactions, 1);
  assert.deepEqual(sent, ['上下文压缩失败，请稍后重试 /compact。', '正常回复']);
  assert.equal(f.store.getPendingCommand(), null);
});

test('/compact 确认发送失败只重试确认，压缩结果先持久化', async (t) => {
  const f = fixture(t);
  f.store.setSessionId('existing-session');
  f.store.insert(command(1, 'compact'));
  let compactions = 0;
  let attempts = 0;
  f.start({
    async compact() { compactions++; },
    async run() { assert.fail('指令和确认不进入模型'); },
  }, { async sendText(text) {
    assert.equal(text, '上下文已压缩。');
    assert.equal(f.store.getPendingCommand()?.result, 'compacted');
    if (++attempts === 1) throw new Error('模拟确认发送失败');
  } });
  await until(() => f.store.getPendingCommand() === null);
  assert.equal(compactions, 1);
  assert.equal(attempts, 2);
});

test('重启后只补发已持久化的指令确认，不重复重置、压缩或帮助处理', async (t) => {
  for (const kind of ['new', 'compact', 'help'] as const) {
    const directory = mkdtempSync(join(tmpdir(), 'bridge-command-restart-'));
    const path = join(directory, 'bridge.sqlite3');
    const first = new BridgeStore(path, target);
    first.setSessionId('existing-session');
    first.insert(command(1, kind));
    const pending = first.getPendingCommand()!;
    if (kind === 'new') first.resetSessionForCommand(pending.id);
    else first.saveCommandResult(pending.id, kind === 'compact' ? 'compacted' : 'help');
    first.setSessionId('retained-marker');
    first.close();
    const store = new BridgeStore(path, target);
    const controller = new AbortController();
    const sent: string[] = [];
    store.saveCommandResult = () => { assert.fail('不能重新处理已持久化的指令结果'); };
    const processor = new Processor({ store, logger, batchSize: 50, replyMaxChars: 1500, retryMs: 1, workspace: directory, imageMaxBytes: 10485760, imageTimeoutMs: 1000,
      agent: {
        async compact() { assert.fail('不能重复执行压缩'); },
        async run() { assert.fail('指令不能进入模型'); },
      },
      sender: { sendImage: noImages, sendMessage: noMessages, async sendText(text) { sent.push(text); } },
    });
    const running = processor.run(controller.signal);
    try {
      await until(() => store.getPendingCommand() === null);
      assert.equal(sent.length, 1);
      if (kind === 'help') assert.match(sent[0]!, /^可用指令：/);
      else assert.deepEqual(sent, [kind === 'new' ? '已重置会话，下条消息将开启新对话。' : '上下文已压缩。']);
      assert.equal(store.getSessionId(), 'retained-marker');
    } finally {
      controller.abort(); await running; store.close(); rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('关机中断 /compact 不持久化失败，重启后恢复压缩', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'bridge-command-abort-'));
  const path = join(directory, 'bridge.sqlite3');
  const store = new BridgeStore(path, target);
  const controller = new AbortController();
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.setSessionId('existing-session');
  store.insert(command(1, 'compact'));
  const pending = store.getPendingCommand()!;
  let compactions = 0;
  let sent = false;
  const processor = new Processor({ store, logger, batchSize: 50, replyMaxChars: 1500, retryMs: 1, workspace: directory, imageMaxBytes: 10485760, imageTimeoutMs: 1000,
    agent: {
      async compact(_sessionId, signal) { compactions++; controller.abort(); assert.equal(signal.aborted, true); throw new Error('中断'); },
      async run() { assert.fail('指令不能进入模型'); },
    },
    sender: { sendImage: noImages, sendMessage: noMessages, async sendText() { sent = true; } },
  });
  await processor.run(controller.signal);
  assert.equal(sent, false);
  assert.deepEqual(store.getPendingCommand(), pending);
  assert.equal(store.getSessionId(), 'existing-session');
  store.close();
  const restarted = new BridgeStore(path, target);
  const resumedController = new AbortController();
  const resumed = new Processor({ store: restarted, logger, batchSize: 50, replyMaxChars: 1500, retryMs: 1, workspace: directory, imageMaxBytes: 10485760, imageTimeoutMs: 1000,
    agent: {
      async compact(sessionId) { assert.equal(sessionId, 'existing-session'); compactions++; },
      async run() { assert.fail('指令不能进入模型'); },
    },
    sender: { sendImage: noImages, sendMessage: noMessages, async sendText() { sent = true; } },
  });
  const running = resumed.run(resumedController.signal);
  try {
    await until(() => restarted.getPendingCommand() === null);
    assert.equal(sent, true);
    assert.equal(compactions, 2);
  } finally { resumedController.abort(); await running; restarted.close(); }
});
