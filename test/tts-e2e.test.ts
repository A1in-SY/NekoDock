import assert from 'node:assert/strict';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { assertAccepted, dockerImage, piFixture, respond, sendReply, type Outgoing } from './fixtures/pi-e2e.js';

const spokenText = '语音回复测试正文-private-spoken-fixture';
const fallbackText = 'fallback-private-spoken-fixture';

test('Pi Worker 发送 Edge 原生语音、合成失败回退，开关/概率与重启不补发保持有效', { timeout: dockerImage ? 100_000 : 65_000 }, async t => {
  const f = await piFixture(t, (call, response) => {
    if (call.results.length) { assertAccepted(call); respond(call, response, 'Internal final.'); return; }
    const text = call.batch.at(-1)!.text; const content = text.includes('fallback') ? fallbackText : spokenText;
    sendReply(call, response, [text.includes('mention') ? { type: 'message', segments: [{ type: 'at', userId: '501' }, { type: 'text', text: content }] } : { type: 'text', text: content }]);
  });
  const edgeBin = join(f.directory, 'mock-edge.mjs');
  await writeFile(edgeBin, `#!/usr/bin/env node
import assert from 'node:assert/strict';import {appendFileSync} from 'node:fs';
let text='';for await(const chunk of process.stdin)text+=chunk;
const args=process.argv.slice(2);assert.equal(args[args.indexOf('--file')+1],'-');assert.equal(args[args.indexOf('--write-media')+1],'-');
appendFileSync(process.env.DATA_DIR+'/edge-calls.jsonl',JSON.stringify({text,args})+'\\n');
if(text.includes('fallback')){process.stderr.write('raw-stderr-private-fixture '+text);process.exit(7);}
const frame=Buffer.alloc(417);frame.set([0xff,0xfb,0x90,0x64]);process.stdout.write(Buffer.concat([frame,Buffer.from(text)]));
`);
  await chmod(edgeBin, 0o755);
  const calls = async (): Promise<Array<{ text: string; args: string[] }>> => { try { return (await readFile(join(f.dataPath(), 'edge-calls.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; } };
  let blockRecord = false;
  f.onSend = message => { assert.equal(message.action, 'send_group_msg'); assert.ok(message.params.message.every(segment => ['record', 'text', 'at'].includes(segment.type))); if (blockRecord && message.params.message.some(segment => segment.type === 'record')) return false; };
  const start = (enabled: boolean, probability: number) => f.start('1001', { TTS_PROVIDER: 'edge-tts', VOICE_REPLY_ENABLED: String(enabled), VOICE_REPLY_PROBABILITY: String(probability),
    EDGE_TTS_BIN: dockerImage ? '/mock-edge.mjs' : edgeBin, TTS_TIMEOUT_MS: '2000', TTS_MAX_CHARS: '300', TTS_MAX_BYTES: '4096', ACTION_TIMEOUT_MS: '5000' }, [{ source: edgeBin, target: '/mock-edge.mjs' }]);
  const assertRecord = (message: Outgoing) => {
    assert.equal(message.params.message.length, 1, '原生语音不混合艾特或文字'); assert.equal(message.params.message[0]?.type, 'record');
    const file = message.params.message[0]!.data.file!; assert.ok(file.startsWith('base64://'));
    assert.deepEqual([...Buffer.from(file.slice(9), 'base64').subarray(0, 4)], [0xff, 0xfb, 0x90, 0x64]); return file;
  };
  const first = await start(true, 1); await f.waitFor(() => f.napcat.clients.size === 1, 'Worker 应连接');
  f.send('voice-success'); await f.waitFor(() => f.outgoing.length === 1 && f.complete(1), '概率 1 应发送原生语音'); assertRecord(f.outgoing[0]!);
  assert.equal((await calls()).length, 1); assert.ok((await calls())[0]!.args.includes('zh-CN-XiaoxiaoNeural'));
  assert.ok((await calls())[0]!.args.every(argument => !argument.includes(spokenText)), '朗读正文不进入 argv');
  f.send('voice-mention'); await f.waitFor(() => f.outgoing.length === 3 && f.complete(2), '艾特应在语音前独立发送');
  assert.deepEqual(f.outgoing[1]!.params.message, [{ type: 'at', data: { qq: '501' } }]); assertRecord(f.outgoing[2]!); assert.equal((await calls())[1]!.text, spokenText);
  f.send('voice-fallback'); await f.waitFor(() => f.outgoing.length === 4 && f.complete(3), '失败回退文字');
  assert.deepEqual(f.outgoing[3]!.params.message, [{ type: 'text', data: { text: fallbackText } }]);
  const beforeHelp = (await calls()).length; f.send('help', '/help'); await f.waitFor(() => f.outgoing.length === 5, 'help 直接发文字');
  assert.match(f.outgoing[4]!.params.message[0]!.data.text!, /\/help.*查看指令/s);
  assert.equal((await calls()).length, beforeHelp); assert.equal(f.calls.filter(call => !call.results.length).length, 3);
  blockRecord = true; f.send('voice-restart'); await f.waitFor(() => f.outgoing.length === 6, '发送前应持久化音频快照');
  const pendingFile = assertRecord(f.outgoing[5]!);
  f.read('1001', db => { const row = db.prepare('SELECT replies_json,next_reply_index FROM pending_batch').get(); assert.equal(row?.next_reply_index, 0); assert.ok(JSON.parse(String(row?.replies_json)).some((part: { type: string; file: string }) => part.type === 'voice' && part.file === pendingFile)); });
  const callsBeforeRestart = (await calls()).length; await f.stop(first); await f.waitFor(() => f.napcat.clients.size === 0, '停止后应释放连接');
  blockRecord = false; const disabled = await start(false, 1); await f.waitFor(() => f.napcat.clients.size === 1 && f.complete(4), '重启不补发中断语音');
  assert.equal(f.outgoing.length, 6); assert.equal((await calls()).length, callsBeforeRestart); assert.equal(f.calls.filter(call => !call.results.length).length, 4);
  f.send('voice-disabled'); await f.waitFor(() => f.outgoing.length === 7 && f.complete(5), '关闭开关应发文字');
  assert.deepEqual(f.outgoing[6]!.params.message, [{ type: 'text', data: { text: spokenText } }]); assert.equal((await calls()).length, callsBeforeRestart);
  await f.stop(disabled); await f.waitFor(() => f.napcat.clients.size === 0, '关闭开关实例停止');
  const zero = await start(true, 0); await f.waitFor(() => f.napcat.clients.size === 1, '概率 0 实例启动');
  f.send('voice-probability-zero'); await f.waitFor(() => f.outgoing.length === 8 && f.complete(6), '概率 0 应发文字');
  assert.deepEqual(f.outgoing[7]!.params.message, [{ type: 'text', data: { text: spokenText } }]); assert.equal((await calls()).length, callsBeforeRestart);
  await f.stop(zero);
  assert.doesNotMatch(f.processes.flatMap(process => process.logs).join('\n'), /private-spoken-fixture|raw-stderr-private-fixture|pi-e2e-private-token|fake-provider-key-/);
});
