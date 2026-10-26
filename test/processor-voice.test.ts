import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BridgeStore } from '../src/store.js';
import { Processor } from '../src/processor.js';
import type { SpeechProvider } from '../src/tts.js';
import type { AgentResult, MessageSegment } from '../src/types.js';

const target = { type: 'group' as const, id: '1001' };
const audio = `base64://${Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0]).toString('base64')}`;
const result = (...texts: string[]): AgentResult => ({ messages: texts.map(text => ({ type: 'text', text })) });

async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 3000;
  while (!check()) { assert.ok(Date.now() < end, '等待语音批次完成超时'); await delay(5); }
}

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'bridge-voice-processor-'));
  const path = join(directory, 'bridge.sqlite3');
  const store = new BridgeStore(path, target);
  const logs: string[] = [];
  const sent: Array<{ type: string; value: string | MessageSegment[] }> = [];
  const spoken: string[] = [];
  let generated = 0;
  let sampled = 0;
  const runs: Array<{ controller: AbortController; running: Promise<void> }> = [];
  t.after(async () => {
    for (const run of runs) run.controller.abort();
    await Promise.all(runs.map(run => run.running));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const insert = (id = 1) => store.insert({ messageId: String(id), senderId: '2001', senderName: '用户', time: id,
    text: 'private-incoming-text', replyTo: null, trigger: true, rawJson: '{}' });
  const start = (options: {
    result?: AgentResult; enabled?: boolean; probability?: number; random?: () => number;
    maxChars?: number; replyMaxChars?: number; synthesize?: SpeechProvider['synthesize'];
    noProvider?: boolean; sendVoice?: (file: string) => Promise<void>; sendText?: (text: string) => Promise<void>;
  } = {}) => {
    const controller = new AbortController();
    const processor = new Processor({
      store, logger: { info: value => logs.push(value), warn: value => logs.push(value), error: value => logs.push(value) },
      agent: { async run() { generated++; return options.result ?? result('private-outgoing-text'); } },
      sender: {
        async sendText(text) { sent.push({ type: 'text', value: text }); await options.sendText?.(text); },
        async sendImage(file) { sent.push({ type: 'image', value: file }); },
        async sendMessage(segments) { sent.push({ type: 'message', value: segments }); },
        async sendVoice(file) { sent.push({ type: 'voice', value: file }); await options.sendVoice?.(file); },
      },
      speech: options.noProvider ? null : { name: 'test', async synthesize(text, signal) {
        spoken.push(text); return options.synthesize ? options.synthesize(text, signal) : { file: audio };
      } },
      voiceReplyEnabled: options.enabled ?? true, voiceReplyProbability: options.probability ?? 1,
      ttsMaxChars: options.maxChars ?? 300, random: () => { sampled++; return options.random?.() ?? 0.1; },
      batchSize: 50, replyMaxChars: options.replyMaxChars ?? 1500, retryMs: 1,
      workspace: directory, imageMaxBytes: 10485760, imageTimeoutMs: 1000,
    });
    const running = processor.run(controller.signal);
    const run = { controller, running }; runs.push(run);
    return { ...run, async stop() { controller.abort(); await running; } };
  };
  return { directory, path, store, sent, spoken, logs, insert, start,
    get generated() { return generated; }, get sampled() { return sampled; } };
}

test('语音关闭、概率零或无供应商均不抽样、不合成，保持普通文字', async t => {
  for (const settings of [{ enabled: false }, { probability: 0 }, { noProvider: true }]) {
    await t.test(JSON.stringify(settings), async t => {
      const f = fixture(t); f.insert(); f.start(settings);
      await until(() => f.store.getCursor() === 1);
      assert.equal(f.sampled, 0); assert.deepEqual(f.spoken, []);
      assert.deepEqual(f.sent, [{ type: 'text', value: 'private-outgoing-text' }]);
    });
  }
});

test('每条模型回复独立抽样，长语音按Unicode分段且不对分段再次抽样', async t => {
  const f = fixture(t); f.insert();
  const draws = [0.19, 0.2, 0.01];
  f.start({ probability: 0.2, random: () => draws.shift()!, maxChars: 2,
    result: result('你😀好', '第二条文字', '第三条') });
  await until(() => f.store.getCursor() === 1);
  assert.equal(f.sampled, 3); assert.equal(f.generated, 1);
  assert.deepEqual(f.spoken, ['你😀', '好', '第三', '条']);
  assert.deepEqual(f.sent.map(value => value.type), ['voice', 'voice', 'text', 'voice', 'voice']);
});

test('语音发送前快照已落库，发送失败不重发、不重跑模型或合成', async t => {
  const f = fixture(t); f.insert(); let attempts = 0;
  f.start({ probability: 0.2, sendVoice: async file => {
    assert.deepEqual(f.store.openOrCreateBatch(50)?.replies, [{ type: 'voice', text: 'private-outgoing-text', file }]);
    if (++attempts === 1) throw new Error('private-send-error');
  } });
  await until(() => f.store.getCursor() === 1);
  assert.equal(f.generated, 1); assert.equal(f.sampled, 1); assert.equal(f.spoken.length, 1);
  assert.deepEqual(f.sent, [{ type: 'voice', value: audio }]);
  assert.match(f.logs.join('\n'), /processor\.voice\.prepared .*reply_index=0/);
  assert.match(f.logs.join('\n'), /processor\.reply\.failed .*stage="send"/);
  assert.doesNotMatch(f.logs.join('\n'), /private-incoming-text|private-outgoing-text|private-send-error|base64:\/\//);
});

test('合成失败原位持久化文字回退，文字发送失败结束发送项', async t => {
  const f = fixture(t); f.insert(); let attempts = 0;
  f.start({ synthesize: async () => { throw new Error('private-upstream-error token=hidden'); }, sendText: async text => {
    assert.deepEqual(f.store.openOrCreateBatch(50)?.replies, [text]);
    if (++attempts === 1) throw new Error('private-send-error');
  } });
  await until(() => f.store.getCursor() === 1);
  assert.equal(f.generated, 1); assert.equal(f.spoken.length, 1);
  assert.deepEqual(f.sent.map(value => value.type), ['text']);
  assert.match(f.logs.join('\n'), /processor\.voice\.fallback/);
  assert.doesNotMatch(f.logs.join('\n'), /private-upstream-error|private-outgoing-text|token=hidden/);
});

test('供应商返回无效音频时回退文字，不发送损坏的语音', async t => {
  const f = fixture(t); f.insert(); f.start({ synthesize: async () => ({ file: 'base64://not-audio' }) });
  await until(() => f.store.getCursor() === 1);
  assert.deepEqual(f.sent, [{ type: 'text', value: 'private-outgoing-text' }]);
});

test('语音快照存储失败不误判为TTS失败，不将结果降为文字', async t => {
  const f = fixture(t); f.insert(); let attempts = 0;
  const save = f.store.saveVoice.bind(f.store);
  f.store.saveVoice = (...args) => { if (++attempts === 1) throw new Error('private-storage-error'); save(...args); };
  f.start();
  await until(() => f.store.getCursor() === 1);
  assert.equal(f.generated, 1); assert.equal(f.spoken.length, 1);
  assert.deepEqual(f.sent, []);
  assert.match(f.logs.join('\n'), /processor\.reply\.failed .*stage="voice_save"/);
  assert.doesNotMatch(f.logs.join('\n'), /processor\.voice\.fallback|private-storage-error/);
});

test('语音分段尊重文字分段上限，保留原生艾特且不朗读QQ号，图片保持原顺序', async t => {
  const f = fixture(t); f.insert();
  const imagePath = join(f.directory, 'test.png');
  writeFileSync(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/XtQAAAAASUVORK5CYII=', 'base64'));
  f.start({ replyMaxChars: 2, maxChars: 300, result: { messages: [
    { type: 'message', segments: [{ type: 'at', userId: '2001' }, { type: 'text', text: '你😀好' }] },
    { type: 'image', path: imagePath },
    { type: 'message', segments: [{ type: 'at', userId: '2002' }] },
  ] } });
  await until(() => f.store.getCursor() === 1);
  assert.equal(f.sampled, 0);
  assert.deepEqual(f.spoken, ['你😀', '好']);
  assert.deepEqual(f.sent.map(value => value.type), ['message', 'voice', 'voice', 'image', 'message']);
  assert.deepEqual(f.sent[0]?.value, [{ type: 'at', userId: '2001' }]);
  assert.deepEqual(f.sent.at(-1)?.value, [{ type: 'at', userId: '2002' }]);
});

test('成功合成与关机交错时结束批次，后续启动不补发已有音频', async t => {
  const f = fixture(t); f.insert();
  let first: ReturnType<typeof f.start>;
  first = f.start({ synthesize: async () => { first.controller.abort(); return { file: audio }; } });
  await first.running;
  assert.equal(f.store.getCursor(), 1); assert.equal(f.store.peekPendingBatch(), null);
  assert.deepEqual(f.sent, []);
  f.start({ enabled: false, noProvider: true }); await delay(10);
  assert.equal(f.generated, 1); assert.equal(f.spoken.length, 1); assert.deepEqual(f.sent, []);
});

test('合成期间取消结束未准备语音，后续启动不补发或回退', async t => {
  const f = fixture(t); f.insert();
  const first = f.start({ synthesize: async (_text, signal) => {
    await delay(3000, undefined, { signal }); return { file: audio };
  } });
  await until(() => f.spoken.length === 1); await first.stop();
  assert.equal(f.store.peekPendingBatch(), null); assert.equal(f.store.getCursor(), 1);
  assert.deepEqual(f.sent, []); assert.doesNotMatch(f.logs.join('\n'), /processor\.voice\.fallback/);
  f.start({ enabled: false }); await delay(10);
  assert.equal(f.generated, 1); assert.equal(f.spoken.length, 1); assert.deepEqual(f.sent, []);
});

test('TTS开启时指令确认仍为文字，且不进入模型与合成调用', async t => {
  const f = fixture(t);
  f.store.insert({ messageId: 'help', senderId: '2001', senderName: '用户', time: 1,
    text: '/help', replyTo: null, trigger: true, rawJson: '{}', command: 'help' });
  f.start(); await until(() => f.store.getPendingCommand() === null);
  assert.equal(f.generated, 0); assert.equal(f.sampled, 0); assert.deepEqual(f.spoken, []);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0]?.type, 'text');
  assert.match(String(f.sent[0]?.value), /\/help.*\n\/new.*\n\/compact/);
});
