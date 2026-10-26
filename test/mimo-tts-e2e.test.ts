import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { assertAccepted, bindHost, dockerImage, piFixture, requestHost, respond, sendReply, type Outgoing } from './fixtures/pi-e2e.js';

const spokenText = 'MiMo-private-spoken-fixture'; const fallbackText = 'MiMo-private-fallback-fixture';
const firstStyle = '清亮柔和、轻微俏皮的 MiMo-private-style-fixture'; const changedStyle = '自然舒缓的 MiMo-private-changed-style-fixture';
const apiKey = 'mimo-fake-private-api-key';
interface MimoBody { model: string; messages: Array<{ role: string; content: string }>; audio: { format: string; voice: string }; stream: boolean }
interface MimoCall { path?: string; method?: string; key?: string; body: MimoBody }

test('Pi Worker 的 MiMo 原生语音保留独立风格、失败回退与重启不补发', { timeout: dockerImage ? 100_000 : 65_000 }, async t => {
  const f = await piFixture(t, (call, response) => {
    if (call.results.length) { assertAccepted(call); respond(call, response, 'Internal final.'); return; }
    sendReply(call, response, [{ type: 'text', text: call.batch.at(-1)!.text.includes('fallback') ? fallbackText : spokenText }]);
  });
  const calls: MimoCall[] = []; const frame = Buffer.alloc(417); frame.set([0xff, 0xfb, 0x90, 0x64]);
  const audio = Buffer.concat([frame, Buffer.from('MiMo-private-audio-fixture')]).toString('base64');
  const http = createServer((request, response) => { void (async () => {
    let raw = ''; for await (const chunk of request) raw += String(chunk);
    const body = JSON.parse(raw) as MimoBody; calls.push({ path: request.url, method: request.method, key: request.headers['api-key'] as string | undefined, body });
    response.setHeader('content-type', 'application/json');
    if (body.messages.at(-1)?.content === fallbackText) { response.writeHead(429); response.end(JSON.stringify({ error: `${apiKey} ${firstStyle} ${fallbackText}` })); }
    else response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', audio: { data: audio } } }] }));
  })().catch(error => { f.failures.push(error); response.writeHead(500); response.end('{}'); }); });
  await new Promise<void>(resolve => http.listen(0, bindHost, resolve));
  t.after(() => { http.closeAllConnections(); return new Promise<void>(resolve => http.close(() => resolve())); });
  const baseUrl = `http://${requestHost}:${(http.address() as AddressInfo).port}/v1`;
  let blockRecord = false;
  f.onSend = message => { assert.equal(message.action, 'send_group_msg'); assert.ok(message.params.message.every(segment => ['record', 'text', 'at'].includes(segment.type))); if (blockRecord && message.params.message.some(segment => segment.type === 'record')) return false; };
  const start = (style: string) => f.start('1001', { TTS_PROVIDER: 'mimo', VOICE_REPLY_ENABLED: 'true', VOICE_REPLY_PROBABILITY: '1',
    MIMO_TTS_API_KEY: apiKey, MIMO_TTS_BASE_URL: baseUrl, MIMO_TTS_MODEL: 'mimo-v2.5-tts', MIMO_TTS_VOICE: '冰糖', MIMO_TTS_STYLE: style,
    TTS_TIMEOUT_MS: '2000', TTS_MAX_CHARS: '300', TTS_MAX_BYTES: '4096', ACTION_TIMEOUT_MS: '5000' });
  const assertRecord = (message: Outgoing) => { assert.equal(message.params.message.length, 1); assert.equal(message.params.message[0]?.type, 'record'); assert.equal(message.params.message[0]?.data.file, `base64://${audio}`); return `base64://${audio}`; };
  const assertCall = (call: MimoCall, style: string, text = spokenText) => {
    assert.equal(call.path, '/v1/chat/completions'); assert.equal(call.method, 'POST'); assert.equal(call.key, apiKey);
    assert.deepEqual(call.body, { model: 'mimo-v2.5-tts', messages: [...(style ? [{ role: 'user', content: style }] : []), { role: 'assistant', content: text }], audio: { format: 'mp3', voice: '冰糖' }, stream: false });
  };
  const first = await start(firstStyle); await f.waitFor(() => f.napcat.clients.size === 1, 'Worker 应连接');
  f.send('mimo-success'); await f.waitFor(() => f.outgoing.length === 1 && f.complete(1), '自定义风格合成为原生语音'); assertRecord(f.outgoing[0]!); assert.equal(calls.length, 1); assertCall(calls[0]!, firstStyle);
  f.send('mimo-fallback'); await f.waitFor(() => f.outgoing.length === 2 && f.complete(2), 'HTTP 失败回退文字');
  assert.deepEqual(f.outgoing[1]!.params.message, [{ type: 'text', data: { text: fallbackText } }]); assert.equal(calls.length, 2); assertCall(calls[1]!, firstStyle, fallbackText);
  blockRecord = true; f.send('mimo-restart'); await f.waitFor(() => f.outgoing.length === 3, '发送前持久化快照'); const pendingFile = assertRecord(f.outgoing[2]!);
  f.read('1001', db => { const row = db.prepare('SELECT replies_json,next_reply_index FROM pending_batch').get(); assert.equal(row?.next_reply_index, 0); assert.ok(JSON.parse(String(row?.replies_json)).some((part: { type: string; file: string }) => part.type === 'voice' && part.file === pendingFile)); });
  const beforeRestart = calls.length; await f.stop(first); await f.waitFor(() => f.napcat.clients.size === 0, '停止应释放连接');
  blockRecord = false; const empty = await start(''); await f.waitFor(() => f.napcat.clients.size === 1 && f.complete(3), '重启应结束中断批次');
  assert.equal(f.outgoing.length, 3); assert.equal(calls.length, beforeRestart); assert.equal(f.calls.filter(call => !call.results.length).length, 3);
  f.send('mimo-empty-style'); await f.waitFor(() => f.outgoing.length === 4 && f.complete(4), '空风格使用音色默认朗读'); assertRecord(f.outgoing[3]!); assertCall(calls.at(-1)!, '');
  await f.stop(empty); await f.waitFor(() => f.napcat.clients.size === 0, '空风格实例停止');
  const changed = await start(changedStyle); await f.waitFor(() => f.napcat.clients.size === 1, '修改风格实例启动');
  f.send('mimo-changed-style'); await f.waitFor(() => f.outgoing.length === 5 && f.complete(5), '新风格应应用到下一条语音'); assertRecord(f.outgoing[4]!); assertCall(calls.at(-1)!, changedStyle); assert.equal(calls.length, beforeRestart + 2);
  await f.stop(changed);
  const modelInputs = JSON.stringify(f.calls.map(call => call.body)); const logs = f.processes.flatMap(process => process.logs).join('\n');
  for (const value of [firstStyle, changedStyle, apiKey]) assert.equal(modelInputs.includes(value), false, 'TTS 风格和凭据不进入 Agent 会话');
  for (const value of [firstStyle, changedStyle, apiKey, spokenText, fallbackText, audio, 'pi-e2e-private-token']) assert.equal(logs.includes(value), false);
  assert.match(logs, /tts\.synthesis\.completed .*provider="mimo"/); assert.match(logs, /tts\.synthesis\.failed .*provider="mimo"/);
});
