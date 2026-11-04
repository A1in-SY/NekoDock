import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { createConsole } from '../src/console/server.js';
import { DockerClient } from '../src/console/docker.js';
import { piFixture, assertAccepted, respond, sendReply, bindHost, requestHost } from './fixtures/pi-e2e.js';
import type { PluginRunnerJob } from '../src/plugin-contract.js';

test('Bilibili enrichment and actual video replies share the managed chat context without another model turn', { timeout: 65000 }, async t => {
  const f = await piFixture(t, (call, response) => {
    if (call.results.length) { assertAccepted(call); respond(call, response, 'Internal completion.'); return; }
    assert.deepEqual(call.replyTargetMessageIds, ['question']);
    const share = call.batch.find(message => message.messageId === 'share')!;
    assert.ok(share); assert.doesNotMatch(share.text, /tracking-secret|miniapp/);
    assert.match(JSON.stringify(share), /Verified video description|Verified subtitle/);
    const videos = call.batch.filter(message => message.messageId === '1');
    assert.equal(videos.length, 1, 'One actual plugin reply appears once in the unified timeline');
    assert.equal(videos[0]!.origin, 'plugin');
    assert.equal(videos[0]!.replyTo, null, 'A standalone video does not claim an actual QQ quote');
    assert.equal(videos[0]!.sourceMessageId, 'share', 'The source association remains available');
    assert.equal(call.batch.find(message => message.messageId === 'question')!.replyTo, '1');
    assert.doesNotMatch(JSON.stringify(call.body), /externalEvents|contextBatch|tracking-secret/);
    sendReply(call, response, [{ type: 'text', text: 'The verified subtitle describes the example.' }]);
  });
  const directory = await mkdtemp(join(tmpdir(), 'managed-plugin-e2e-'));
  const runnerToken = 'isolated-plugin-runner';
  const app = await createConsole({ dataDir: directory, timers: false, staticDir: '/nonexistent', pluginRunnerToken: runnerToken,
    docker: new DockerClient({ socketPath: 'unused', image: 'unused', network: 'unused', consoleUrl: 'unused' }) });
  t.after(async () => { await app.app.close(); await rm(directory, { recursive: true, force: true }); });
  await app.app.listen({ host: bindHost, port: 0 });
  const port = (app.app.server.address() as AddressInfo).port;
  const hostUrl = `http://127.0.0.1:${port}`;
  const connection = app.db.createNapcatConnection({ name: 'Isolated', wsUrl: f.localWsUrl, mediaBaseUrl: hostUrl });
  const bot = app.db.createBot({ name: 'Example', targetType: 'group', targetId: '1001', connectionId: connection.id,
    config: { model: 'synthetic-model', baseUrl: f.modelUrl, modelApi: 'openai-responses', memoryEnabled: false, replyProbability: 0,
      voiceEnabled: false, allowCommands: false, allowFileWrites: false } });
  const configuration = app.db.plugins.view(bot.id, 'bilibili');
  app.db.plugins.update(bot.id, 'bilibili', { expectedRevision: configuration.revision, enabled: true, config: { autoVideo: true } });
  app.db.setDesiredState(bot.id, 'running'); app.db.setRuntime(bot.id, { state: 'starting' });
  await app.gateway.reconcile(); await f.waitFor(() => app.gateway.getConnectionStatus(connection.id).online, 'mock QQ login');
  await f.start('1001', { CONSOLE_URL: `http://${requestHost}:${port}`, BOT_INSTANCE_ID: bot.id, WORKER_TOKEN: bot.workerToken });
  await f.waitFor(() => app.gateway.getBotStatus(bot.id).channelConnected, 'Worker transport');
  const event = f.event('share', '', false);
  f.broadcast({ ...event, message: [{ type: 'json', data: { data: JSON.stringify({ app: 'com.tencent.miniapp_01', config: { token: 'tracking-secret' },
    meta: { detail_1: { title: '哔哩哔哩', desc: 'Synthetic video', qqdocurl: 'https://www.bilibili.com/video/BV1234567890/' } } }) } }] });
  let resolveJob: PluginRunnerJob | null = null;
  await f.waitFor(() => { resolveJob = app.db.plugins.claim(); return resolveJob?.operation === 'resolve'; }, 'durable resolve job');
  const content = { type: 'video' as const, platform: 'bilibili' as const, resourceId: 'BV1234567890:p1', url: 'https://www.bilibili.com/video/BV1234567890',
    title: 'Synthetic video', durationSeconds: 1, description: 'Verified video description', part: 1,
    subtitle: { status: 'ready' as const, language: 'zh', text: 'Verified subtitle' }, retrieval: { status: 'ready' as const } };
  app.db.plugins.complete(resolveJob!.id, resolveJob!.lease, { content });
  let download: PluginRunnerJob | null = null;
  await f.waitFor(() => { download = app.db.plugins.claim(); return download?.operation === 'download'; }, 'source-bound download job');
  const media = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(24)]);
  const uploaded = await app.app.inject({ method: 'POST', url: `/internal/plugin-runner/jobs/${download!.id}/asset`,
    headers: { authorization: `Bearer ${runnerToken}`, 'x-plugin-lease': download!.lease, 'content-type': 'application/octet-stream' }, payload: media });
  assert.equal(uploaded.statusCode, 200, uploaded.body);
  const assetId = uploaded.json().assetId;
  let videoFetched = false;
  f.onSend = (message, socket) => {
    const video = message.params.message.find(segment => segment.type === 'video');
    if (!video) return;
    assert.deepEqual(message.params.message, [video], 'NapCat receives a standalone video');
    void (async () => {
      const partial = await fetch(video.data.file!, { headers: { range: 'bytes=0-15' } });
      assert.equal(partial.status, 206); assert.equal((await partial.arrayBuffer()).byteLength, 16);
      const full = await fetch(video.data.file!); assert.equal(full.status, 200);
      assert.deepEqual(Buffer.from(await full.arrayBuffer()), media);
      videoFetched = true;
      socket.send(JSON.stringify({ echo: message.echo, status: 'ok', retcode: 0, data: { message_id: 1 } }));
    })().catch(error => f.failures.push(error));
    return false;
  };
  app.db.plugins.complete(download!.id, download!.lease, { assetId });
  await f.waitFor(() => videoFetched, 'NapCat fetches a signed media asset');
  await f.waitFor(() => f.read('1001', db => Number(db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE origin='plugin' AND qq_message_id='1'").get()?.n) === 1), 'durable actual plugin message');
  assert.equal(f.calls.length, 0, 'Share processing and video delivery do not launch a model turn');
  const follow = f.event('question', 'What does this video describe?');
  f.broadcast({ ...follow, message: [{ type: 'reply', data: { id: '1' } }, ...follow.message] });
  await f.waitFor(() => f.complete(2), 'model receives enriched share and actual plugin reply');
  assert.equal(f.outgoing.filter(message => message.params.message.some(segment => segment.type === 'video')).length, 1);
});
