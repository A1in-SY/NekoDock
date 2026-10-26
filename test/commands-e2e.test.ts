import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { assertAccepted, dockerImage, piFixture, respond, sendReply } from './fixtures/pi-e2e.js';

test('Pi Worker 在桥接层执行 help/new/compact，控制消息不进入模型历史', { timeout: dockerImage ? 80_000 : 45_000 }, async t => {
  let round = 0; let compactCalls = 0;
  const f = await piFixture(t, (call, response) => {
    if (!call.batch.length) { compactCalls++; respond(call, response, 'A compact checkpoint for the isolated test conversation.'); return; }
    if (call.results.length) { assertAccepted(call); respond(call, response, 'Internal final.'); return; }
    round++; sendReply(call, response, [{ type: 'text', text: `model-reply-${round}` }]);
  });
  const textSent = () => f.outgoing.flatMap(message => message.params.message.filter(segment => segment.type === 'text').map(segment => segment.data.text!));
  const helpReplies = () => textSent().filter(text => ['/help', '/new', '/compact'].every(command => text.includes(command)));
  const sessionId = () => f.read('1001', db => String(db.prepare('SELECT session_id FROM instance_state WHERE id=1').get()?.session_id));
  const older = 'first message ' + 'older context '.repeat(1000);
  const newer = 'second message ' + 'newer context '.repeat(1000);
  await f.start('1001', { AGENT_CONTEXT_WINDOW: '12000', AGENT_AUTO_COMPACT_TOKEN_LIMIT: '8000', AGENT_MAX_OUTPUT_TOKENS: '1000' }); await f.waitFor(() => f.napcat.clients.size === 1, 'Worker 应连接 NapCat');
  f.send('help-first', '/help', false);
  await f.waitFor(() => helpReplies().length === 1, 'help 应立即确认'); assert.equal(f.calls.length, 0);
  f.send('compact-empty', '/compact', false);
  await f.waitFor(() => textSent().includes('当前没有可压缩的会话。'), '无会话压缩应明确回复'); assert.equal(f.calls.length, 0);
  f.send('first', older);
  await f.waitFor(() => textSent().includes('model-reply-1') && f.complete(1), '首轮应完成'); const firstSession = sessionId();
  f.send('second', newer);
  await f.waitFor(() => textSent().includes('model-reply-2') && f.complete(2), '积累可实际压缩的第二轮上下文');
  f.send('compact-existing', '/compact', false);
  await f.waitFor(() => textSent().includes('上下文已压缩。'), '真实 Pi 应完成手动压缩');
  assert.equal(compactCalls, 1); assert.equal(round, 2); assert.equal(sessionId(), firstSession);
  const sessionFile = dockerImage ? join(f.dataPath(), firstSession.replace(/^\/data\//, '')) : firstSession;
  assert.match(await readFile(sessionFile, 'utf8'), /"type":"compaction"/);
  f.send('queued', 'queued before new', false); f.send('new', '/new', false);
  await f.waitFor(() => textSent().includes('已重置会话，下条消息将开启新对话。'), 'new 应立即确认');
  f.send('fresh', 'fresh message');
  await f.waitFor(() => textSent().includes('model-reply-3') && f.complete(4), 'new 后应创建空白 Pi 会话');
  const freshSession = sessionId(); assert.notEqual(freshSession, firstSession);
  const beforeHelp = f.calls.length; f.send('help-mentioned', '/help');
  await f.waitFor(() => helpReplies().length === 2, '艾特 help 仍由桥接处理'); assert.equal(f.calls.length, beforeHelp);
  f.send('continued', 'continued message');
  await f.waitFor(() => textSent().includes('model-reply-4') && f.complete(5), '续聊应复用新会话'); assert.equal(sessionId(), freshSession);
  const starts = f.calls.filter(call => call.batch.length && !call.results.length);
  assert.deepEqual(starts.map(call => call.batch.map(message => message.text)), [[`[@999]${older}`], [`[@999]${newer}`], ['[@999]fresh message'], ['[@999]continued message']]);
  assert.doesNotMatch(JSON.stringify(starts[2]!.body), /first message|model-reply-1|queued before new/);
  assert.match(JSON.stringify(starts[3]!.body), /fresh message|model-reply-3/);
  for (const call of starts) assert.ok(call.body.max_output_tokens >= 16 && call.body.max_output_tokens <= 1000, 'Pi 可按剩余上下文收紧输出，不能超过配置上限');
  assert.equal(starts[2]!.body.max_output_tokens, 1000, '全新会话使用完整的配置输出上限');
  f.read('1001', db => {
    assert.deepEqual(db.prepare('SELECT text FROM messages ORDER BY seq').all().map(row => row.text), [`[@999]${older}`, `[@999]${newer}`, 'queued before new', '[@999]fresh message', '[@999]continued message']);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM control_commands').get()?.n, 5);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM control_commands WHERE kind='help' AND done=1").get()?.n, 2);
  });
  const persisted = await readFile(dockerImage ? join(f.dataPath(), freshSession.replace(/^\/data\//, '')) : freshSession, 'utf8');
  const users = persisted.trim().split('\n').map(line => JSON.parse(line)).filter(entry => entry.type === 'message' && entry.message.role === 'user');
  assert.deepEqual(users.map(entry => JSON.parse(entry.message.content[0].text).map((message: { messageId: string }) => message.messageId)), [['fresh'], ['continued']]);
});
