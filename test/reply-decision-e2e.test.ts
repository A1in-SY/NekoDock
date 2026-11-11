import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createConsole } from '../src/console/server.js';
import { DockerClient } from '../src/console/docker.js';
import { assertAccepted, bindHost, delay, piFixture, requestHost, respond, sendReply } from './fixtures/pi-e2e.js';

test('managed Jev decisions do not hold ingress ACKs or leak into Pi, and a real mention invalidates late decisions', { timeout: 45_000 }, async t => {
  const turns: string[][] = [];
  const f = await piFixture(t, (call, response) => {
    if (call.results.length) { assertAccepted(call); respond(call, response, 'Done.'); return; }
    turns.push(call.replyTargetMessageIds);
    assert.doesNotMatch(JSON.stringify(call.body), /private-judge-key|unique-classifier-guidance|reply_0|"noul"/);
    sendReply(call, response, [{ type: 'text', text: 'A synthetic chat reply.' }]);
  });
  const requests: Array<{ body: Record<string, any>; response: ServerResponse }> = [];
  const errors: unknown[] = [];
  const judge = createServer((request, response) => { void (async () => {
    assert.equal(request.url, '/proxy/v1/systemone');
    assert.equal(request.headers.authorization, 'Bearer private-judge-key');
    let raw = ''; for await (const chunk of request) raw += String(chunk);
    const body = JSON.parse(raw);
    assert.equal(body.model, 'synthetic-classifier');
    assert.ok(Array.isArray(body.state.candidates));
    assert.ok(Object.values(body.questions).every((question: any) => question.type === 'noul'));
    assert.doesNotMatch(raw, /data:image|base64|function_call/);
    requests.push({ body, response });
  })().catch(error => { errors.push(error); response.writeHead(500); response.end('{}'); }); });
  await new Promise<void>(resolve => judge.listen(0, bindHost, resolve));
  t.after(async () => { judge.closeAllConnections(); await new Promise<void>(resolve => judge.close(() => resolve())); });
  const directory = await mkdtemp(join(tmpdir(), 'reply-decision-console-'));
  const consoleApp = await createConsole({ dataDir: directory, timers: false, staticDir: '/nonexistent',
    docker: new DockerClient({ socketPath: 'unused', image: 'unused', network: 'unused', consoleUrl: 'unused' }) });
  t.after(async () => { await consoleApp.app.close(); await rm(directory, { recursive: true, force: true }); });
  await consoleApp.app.listen({ host: bindHost, port: 0 });
  const connection = consoleApp.db.createNapcatConnection({ name: 'Isolated', wsUrl: f.localWsUrl });
  const bot = consoleApp.db.createBot({ name: 'Example', targetType: 'group', targetId: '1001', connectionId: connection.id,
    config: { model: 'synthetic-chat', baseUrl: f.modelUrl, modelApi: 'openai-responses', memoryEnabled: false,
      replyMode: 'jev', replyProbability: 100,
      replyJudgeBaseUrl: `http://${requestHost}:${(judge.address() as AddressInfo).port}/proxy/v1`,
      replyJudgeModel: 'synthetic-classifier', replyJudgeApiKey: 'private-judge-key', replyJudgeThreshold: 0.7,
      replyJudgeTimeout: 3, replyJudgeInstructions: 'unique-classifier-guidance',
      voiceEnabled: false, allowCommands: false, allowFileWrites: false } });
  consoleApp.db.setDesiredState(bot.id, 'running'); consoleApp.db.setRuntime(bot.id, { state: 'starting' });
  await consoleApp.gateway.reconcile();
  await f.waitFor(() => consoleApp.gateway.getConnectionStatus(connection.id).online, 'mock NapCat ready');
  const worker = await f.start('1001', { CONSOLE_URL: `http://${requestHost}:${(consoleApp.app.server.address() as AddressInfo).port}`,
    BOT_INSTANCE_ID: bot.id, WORKER_TOKEN: bot.workerToken });
  await f.waitFor(() => consoleApp.gateway.getBotStatus(bot.id).channelConnected, 'managed Worker connected');
  const answer = (index: number, scores: number[]) => {
    const request = requests[index]!;
    const keys = Object.keys(request.body.questions);
    assert.equal(keys.length, scores.length);
    request.response.writeHead(200, { 'content-type': 'application/json' });
    request.response.end(JSON.stringify({ model: 'resolved-synthetic-classifier', answers: Object.fromEntries(keys.map((key, i) =>
      [key, { type: 'noul', noul: scores[i] }])), usage: { input_tokens: 80, output_tokens: 0 } }));
  };
  f.send('judge-background', 'A casual remark.', false);
  f.send('judge-question', 'Can you explain the previous point?', false);
  await f.waitFor(() => requests.length === 1 || errors.length > 0, 'Jev receives the idle batch');
  assert.deepEqual(errors, []);
  assert.equal(requests[0]!.body.state.candidates.length, 2);
  assert.equal(turns.length, 0, '100% legacy probability is inactive in Jev mode');
  assert.equal(f.read('1001', db => db.prepare('SELECT COUNT(*) n FROM messages').get()!.n), 2,
    'both incoming messages are durable while Jev is pending');
  await f.waitFor(() => consoleApp.db.getNapcatQueueStats(bot.id).pending === 0,
    'Console ACK proceeds independently of Jev');
  answer(0, [0.1, 0.9]);
  await f.waitFor(() => f.complete(2), 'approved candidate reaches Pi');
  assert.deepEqual(turns, [['judge-question']]);
  assert.deepEqual(f.calls[0]!.batch.map(message => message.messageId), ['judge-background', 'judge-question']);
  f.send('judge-late', 'Another ordinary question.', false);
  await f.waitFor(() => requests.length === 2, 'second decision is in flight');
  f.send('hard-mention', 'Please answer this directly.', true);
  await f.waitFor(() => f.complete(4), 'mention bypasses pending Jev');
  answer(1, [0.99]);
  await delay(450);
  assert.deepEqual(turns, [['judge-question'], ['hard-mention']], 'late approval cannot start an extra turn');
  f.send('judge-error', 'An ordinary question during a provider failure.', false);
  await f.waitFor(() => requests.length === 3, 'third decision starts');
  requests[2]!.response.writeHead(500, { 'content-type': 'application/json' });
  requests[2]!.response.end(JSON.stringify({ error: 'private-judge-key unique-classifier-guidance' }));
  await f.waitFor(() => worker.logs.some(line => /reply[._-]decision.*(?:failed|error)/.test(line)), 'decision failure is logged');
  await delay(350);
  assert.deepEqual(turns, [['judge-question'], ['hard-mention']]);
  assert.equal(f.outgoing.filter(message => message.action === 'send_group_msg').length, 2, 'judge errors remain transport-silent');
  assert.doesNotMatch(worker.logs.join('\n'), /private-judge-key|unique-classifier-guidance/);
  assert.deepEqual(errors, []);
  await f.stop(worker);
});
