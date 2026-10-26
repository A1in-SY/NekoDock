import assert from 'node:assert/strict';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { assertAccepted, busyReply, deferred, delay, dockerImage, piFixture, respond, sendReply } from './fixtures/pi-e2e.js';

test('Pi 忙碌时概率 100% 不触发普通消息，艾特等待提示不进入上下文或语音', { timeout: dockerImage ? 65_000 : 40_000 }, async t => {
  const gates = { 'idle-first': deferred(), 'idle-second': deferred() };
  t.after(() => Object.values(gates).forEach(gate => gate.resolve()));
  const f = await piFixture(t, async (call, response) => {
    if (call.results.length) { assertAccepted(call); respond(call, response, 'Internal final.'); return; }
    const id = call.batch.at(-1)!.messageId;
    if (id === 'idle-first' || id === 'idle-second') await gates[id].promise;
    sendReply(call, response, [{ type: 'text', text: `answer-${id}` }]);
  });
  const edgeBin = join(f.directory, 'mock-edge.mjs');
  await writeFile(edgeBin, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
let text='';for await(const chunk of process.stdin)text+=chunk;
appendFileSync(process.env.DATA_DIR+'/edge-calls.jsonl',JSON.stringify({text})+'\\n');
const frame=Buffer.alloc(417);frame.set([0xff,0xfb,0x90,0x64]);process.stdout.write(Buffer.concat([frame,Buffer.from(text)]));
`);
  await chmod(edgeBin, 0o755);
  const edgeCalls = async (): Promise<Array<{ text: string }>> => {
    try { return (await readFile(join(f.dataPath(), 'edge-calls.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  };
  const bridge = await f.start('1001', { RANDOM_REPLY_PROBABILITY: '1', TTS_PROVIDER: 'edge-tts', VOICE_REPLY_ENABLED: 'true', VOICE_REPLY_PROBABILITY: '1',
    EDGE_TTS_BIN: dockerImage ? '/mock-edge.mjs' : edgeBin, TTS_TIMEOUT_MS: '2000', TTS_MAX_CHARS: '300', TTS_MAX_BYTES: '4096' }, [{ source: edgeBin, target: '/mock-edge.mjs' }]);
  await f.waitFor(() => f.napcat.clients.size === 1, 'Worker 应连接 NapCat');
  f.send('idle-first', 'idle-first', false);
  await f.waitFor(() => f.calls.length === 1, '空闲普通消息应按 100% 概率启动');
  f.send('busy-background-a', 'busy-background-a', false); f.send('busy-background-b', 'busy-background-b', false);
  await f.waitFor(() => f.read('1001', db => db.prepare('SELECT COUNT(*) AS n FROM messages').get()?.n === 3), '忙碌背景应落库');
  assert.deepEqual(f.read('1001', db => db.prepare('SELECT message_id,trigger FROM messages ORDER BY seq').all()).map(row => [row.message_id, row.trigger]), [['idle-first', 1], ['busy-background-a', 0], ['busy-background-b', 0]]);
  assert.equal(f.outgoing.length, 0, '忙碌普通消息不提示');
  gates['idle-first'].resolve();
  await f.waitFor(() => f.outgoing.length === 1 && f.complete(1), '首轮完成但背景不触发新调用');
  await delay(150); assert.equal(f.calls.filter(call => !call.results.length).length, 1);
  f.send('idle-second', 'idle-second', false);
  await f.waitFor(() => f.calls.filter(call => !call.results.length).length === 2, '下一空闲触发携带背景');
  assert.deepEqual(f.calls.filter(call => !call.results.length)[1]!.batch.map(message => message.messageId), ['busy-background-a', 'busy-background-b', 'idle-second']);
  f.send('busy-mentioned'); f.send('busy-mentioned');
  await f.waitFor(() => f.outgoing.length === 2 && f.read('1001', db => db.prepare('SELECT COUNT(*) AS n FROM messages').get()?.n === 5), '重复艾特只保存并提示一次');
  assert.deepEqual(f.outgoing[1]!.params.message, [{ type: 'text', data: { text: busyReply } }]);
  assert.deepEqual((await edgeCalls()).map(call => call.text), ['answer-idle-first']);
  gates['idle-second'].resolve();
  await f.waitFor(() => f.outgoing.length === 4 && f.complete(5), '当前轮结束后继续回答原艾特');
  const starts = f.calls.filter(call => !call.results.length);
  assert.deepEqual(starts.map(call => call.batch.map(message => message.messageId)), [['idle-first'], ['busy-background-a', 'busy-background-b', 'idle-second'], ['busy-mentioned']]);
  assert.ok(f.calls.every(call => !JSON.stringify(call.body).includes(busyReply)));
  assert.deepEqual((await edgeCalls()).map(call => call.text), ['answer-idle-first', 'answer-idle-second', 'answer-busy-mentioned']);
  assert.deepEqual(f.outgoing.map(message => message.params.message[0]!.type), ['record', 'text', 'record', 'record']);
  f.read('1001', db => {
    for (const [table, columns] of [['messages', ['text', 'raw_json']], ['pending_batch', ['replies_json']], ['reply_requests', ['messages_json']]] as const)
      for (const column of columns) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} LIKE ?`).get(`%${busyReply}%`)?.n, 0);
  });
  assert.doesNotMatch(bridge.logs.join('\n'), /pi-e2e-private-token|我正在想上面的消息怎么回/);
});
