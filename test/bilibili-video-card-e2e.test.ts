import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import type WebSocket from 'ws';
import { createConsole } from '../src/console/server.js';
import { DockerClient } from '../src/console/docker.js';
import type { PluginContent, PluginRunnerJob } from '../src/plugin-contract.js';
import { assertAccepted, bindHost, dockerImage, piFixture, pngBase64, requestHost, respond, sendReply, type ModelCall, type Outgoing } from './fixtures/pi-e2e.js';

const coverPng = Buffer.from(pngBase64, 'base64');
const cardPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAFElEQVR4nGPUaLrEwMDAxAAGUAoAG94BgqFCKSEAAAAASUVORK5CYII=', 'base64');
const media = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(24)]);

function inputMessages(call: ModelCall): Array<Record<string, unknown>> {
  return (call.body.input ?? call.body.messages ?? []).filter((entry: { role?: string }) => entry.role === 'user')
    .flatMap((entry: { content?: unknown }) => {
      const value = typeof entry.content === 'string' ? entry.content : Array.isArray(entry.content)
        ? entry.content.filter((part: { type?: string }) => part.type === 'text' || part.type === 'input_text').map((part: { text?: string }) => part.text ?? '').join('') : '';
      try { const parsed = JSON.parse(value); return Array.isArray(parsed.messages) ? parsed.messages : []; } catch { return []; }
    });
}

for (const scenario of [
  { name: 'card and video', enhance: true, video: 'success', part: 1 },
  { name: 'card despite failed video', enhance: true, video: 'failed', part: 2 },
  { name: 'card without enrichment or download', enhance: false, video: 'off', part: 2 },
] as const) {
  test(`managed Bilibili ${scenario.name} preserves actual ACK facts without extra vision or model turns`, { timeout: dockerImage ? 100_000 : 60_000 }, async t => {
    const f = await piFixture(t, (call, response) => {
      if (call.results.length) { assertAccepted(call); respond(call, response, 'Internal completion.'); return; }
      assert.deepEqual(call.replyTargetMessageIds, ['question']);
      const messages = inputMessages(call);
      const shares = messages.filter(message => message.messageId === 'share');
      assert.equal(shares.length, 1, 'The original share remains a single human message');
      assert.equal(shares[0]?.origin, 'human');
      if (scenario.enhance) {
        const contents = shares[0]?.contents as PluginContent[];
        assert.equal(contents.length, 1);
        assert.equal(contents[0]?.type, 'video');
        assert.equal(contents[0]?.part, scenario.part);
        assert.equal(contents[0]?.description, 'Verified video description');
        assert.equal(contents[0]?.subtitle?.text, 'Verified subtitle');
        assert.equal(contents[0]?.authorId, '2001');
        assert.equal(contents[0]?.authorAvatar?.role, 'avatar');
        assert.equal(contents[0]?.authorAvatar?.status, 'ready');
        const cover = contents[0]?.blocks?.find(block => block.type === 'image');
        assert.equal(cover?.type, 'image');
        if (cover?.type === 'image') { assert.equal(cover.image.role, 'cover'); assert.equal(cover.image.status, 'ready'); }
      } else assert.equal(shares[0]?.contents, undefined, 'Display does not silently enable context enrichment');
      const cards = messages.filter(message => message.messageId === '94001');
      assert.equal(cards.length, 1, 'Only a confirmed card becomes one actual chat fact');
      assert.equal(cards[0]?.origin, 'plugin');
      assert.equal(cards[0]?.sourceMessageId, 'share');
      assert.equal(cards[0]?.replyTo, null);
      assert.equal((cards[0]?.assets as Array<{ modelInput?: boolean; role?: string }>)[0]?.modelInput, false);
      assert.equal((cards[0]?.assets as Array<{ role?: string }>)[0]?.role, 'presentation');
      assert.equal(messages.filter(message => message.messageId === '94002').length, scenario.video === 'success' ? 1 : 0);
      const blocks = (call.body.input ?? call.body.messages ?? []).flatMap((entry: { content?: unknown }) => Array.isArray(entry.content) ? entry.content : []);
      assert.ok(blocks.every((block: { type?: string }) => !['image', 'image_url', 'input_image'].includes(block.type ?? '')),
        'Neither the video cover nor the generated card is added as vision input');
      assert.doesNotMatch(JSON.stringify(call.body), /externalEvents|contextBatch/);
      sendReply(call, response, [{ type: 'text', text: 'The confirmed card is in the chat.' }]);
    });
    const directory = await mkdtemp(join(tmpdir(), 'managed-video-card-e2e-'));
    const runnerToken = 'synthetic-video-card-runner';
    const app = await createConsole({ dataDir: directory, timers: false, staticDir: '/nonexistent', pluginRunnerToken: runnerToken,
      docker: new DockerClient({ socketPath: 'unused', image: 'unused', network: 'unused', consoleUrl: 'unused' }) });
    t.after(async () => { await app.app.close(); await rm(directory, { recursive: true, force: true }); });
    let assetRequests = 0;
    app.app.addHook('onRequest', async request => { if (request.url.includes('/plugins/assets/')) assetRequests++; });
    await app.app.listen({ host: bindHost, port: 0 });
    const port = (app.app.server.address() as AddressInfo).port;
    const connection = app.db.createNapcatConnection({ name: 'Isolated video card fixture', wsUrl: f.localWsUrl, mediaBaseUrl: `http://127.0.0.1:${port}` });
    const bot = app.db.createBot({ name: 'Synthetic video card bot', targetType: 'group', targetId: '1001', connectionId: connection.id,
      config: { model: 'synthetic-model', baseUrl: f.modelUrl, modelApi: 'openai-responses', memoryEnabled: false, replyProbability: 0,
        supportsImages: true, supportsReasoning: false, voiceEnabled: false, allowCommands: false, allowFileWrites: false } });
    assert.equal(app.db.plugins.view(bot.id, 'bilibili').config.videoDisplay, 'off');
    app.db.plugins.update(bot.id, 'bilibili', { expectedRevision: 0, enabled: true,
      config: { enhance: scenario.enhance, autoVideo: scenario.video !== 'off', videoDisplay: 'card' } });
    app.db.setDesiredState(bot.id, 'running'); app.db.setRuntime(bot.id, { state: 'starting' });
    await app.gateway.reconcile();
    await f.waitFor(() => app.gateway.getConnectionStatus(connection.id).online, 'mock NapCat login');
    const overrides = { CONSOLE_URL: `http://${requestHost}:${port}`, BOT_INSTANCE_ID: bot.id, WORKER_TOKEN: bot.workerToken };
    const worker = await f.start('1001', overrides);
    await f.waitFor(() => app.gateway.getBotStatus(bot.id).channelConnected, 'managed Worker transport');
    const url = 'https://www.bilibili.com/video/BV1234567890' + (scenario.part > 1 ? `?p=${scenario.part}` : '');
    const event = f.event('share', url, false);
    f.broadcast(event);
    let resolve: PluginRunnerJob | null = null;
    await f.waitFor(() => { resolve = app.db.plugins.claim(); return resolve?.operation === 'resolve'; }, 'video resolve');
    const content: PluginContent = { type: 'video', platform: 'bilibili', resourceId: `BV1234567890:p${scenario.part}`, url, part: scenario.part,
      title: 'Synthetic video', author: 'Synthetic creator', authorId: '2001', durationSeconds: 60, publishedAt: 1792727200, description: 'Verified video description',
      coverUrl: 'https://i0.hdslb.com/bfs/archive/synthetic-cover.png',
      blocks: [{ type: 'image', image: { id: 'synthetic-cover', url: 'https://i0.hdslb.com/bfs/archive/synthetic-cover.png', role: 'cover', status: 'pending' } }],
      subtitle: { status: 'ready', language: 'zh', text: 'Verified subtitle' }, retrieval: { status: 'ready' } };
    app.db.plugins.complete(resolve!.id, resolve!.lease, { content });
    const followups = new Map<string, PluginRunnerJob>();
    await f.waitFor(() => {
      const job = app.db.plugins.claim(); if (job) followups.set(job.operation, job);
      return followups.size === (scenario.video === 'off' ? 1 : 2);
    }, 'independent presentation and download jobs');
    const prepare = followups.get('prepare')!;
    assert.ok(prepare); assert.equal(prepare.presentation?.mode, 'card');
    assert.equal(prepare.presentation?.provideContext, scenario.enhance);
    const upload = async (key: string, role: string, bytes: Buffer) => {
      const response = await app.app.inject({ method: 'POST', url: `/internal/plugin-runner/jobs/${prepare.id}/asset`,
        headers: { authorization: `Bearer ${runnerToken}`, 'x-plugin-lease': prepare.lease, 'x-plugin-asset-key': key,
          'x-plugin-asset-type': 'image', 'x-plugin-asset-role': role, 'content-type': 'application/octet-stream' }, payload: bytes });
      assert.equal(response.statusCode, 200, response.body); return response.json().assetId as string;
    };
    const coverAsset = await upload('cover', 'cover', coverPng), cardAsset = await upload('card', 'presentation', cardPng);
    const avatarAsset = await upload('avatar', 'avatar', coverPng);
    const prepared = structuredClone(content);
    prepared.authorAvatar = { id: `${prepared.resourceId}:avatar`, url: 'https://i0.hdslb.com/bfs/face/synthetic-avatar.png',
      role: 'avatar', status: 'ready', assetId: avatarAsset, fetchedAt: 1792727301 };
    const cover = prepared.blocks![0]!; assert.equal(cover.type, 'image');
    if (cover.type === 'image') Object.assign(cover.image, { assetId: coverAsset, status: 'ready', fetchedAt: 1792727301 });
    let held: { message: Outgoing; socket: WebSocket } | undefined;
    let videoSends = 0, cardSends = 0;
    f.onSend = (message, socket) => {
      if (message.params.message.some(segment => segment.type === 'image')) {
        cardSends++; held = { message, socket }; return false;
      }
      if (message.params.message.some(segment => segment.type === 'video')) {
        videoSends++; assert.equal(message.params.message.length, 1);
        socket.send(JSON.stringify({ echo: message.echo, status: 'ok', retcode: 0, data: { message_id: '94002' } })); return false;
      }
    };
    app.db.plugins.complete(prepare.id, prepare.lease, { content: prepared, outputs: [{ kind: 'image', assetId: cardAsset, assetRole: 'presentation' }] });
    await f.waitFor(() => !!held, 'card waits for actual NapCat ACK');
    assert.equal(f.read('1001', db => Number(db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE origin='plugin'").get()?.n)), 0);
    assert.equal(held!.message.params.message.length, 1, 'The card is a standalone media message');
    assert.equal(held!.message.params.message[0]?.type, 'image');
    assert.equal(held!.message.params.message[0]?.data.file, 'base64://' + cardPng.toString('base64'));
    const download = followups.get('download');
    if (download) {
      if (scenario.video === 'failed') app.db.plugins.complete(download.id, download.lease, { error: 'BILIBILI_DOWNLOAD_FAILED' });
      else {
        const response = await app.app.inject({ method: 'POST', url: `/internal/plugin-runner/jobs/${download.id}/asset`,
          headers: { authorization: `Bearer ${runnerToken}`, 'x-plugin-lease': download.lease, 'content-type': 'application/octet-stream' }, payload: media });
        assert.equal(response.statusCode, 200, response.body);
        app.db.plugins.complete(download.id, download.lease, { assetId: response.json().assetId });
      }
    }
    assert.equal(f.calls.length, 0, 'Parsing, presentation and download do not trigger the model');
    held!.socket.send(JSON.stringify({ echo: held!.message.echo, status: 'ok', retcode: 0, data: { message_id: '94001' } }));
    const replies = scenario.video === 'success' ? 2 : 1;
    await f.waitFor(() => f.read('1001', db => Number(db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE origin='plugin' AND qq_message_id IS NOT NULL").get()?.n)) === replies,
      'confirmed plugin output facts');
    assert.equal(assetRequests, 0, 'Display assets are not fetched into the Worker vision cache');
    assert.equal(videoSends, scenario.video === 'success' ? 1 : 0);
    assert.equal(cardSends, 1);
    assert.equal(f.calls.length, 0);
    f.broadcast(event);
    await f.stop(worker); await f.start('1001', overrides);
    await f.waitFor(() => app.gateway.getBotStatus(bot.id).channelConnected, 'replacement Worker transport');
    const question = f.event('question', 'Discuss the shared video.');
    f.broadcast({ ...question, message: [{ type: 'reply', data: { id: '94001' } }, ...question.message] });
    await f.waitFor(() => f.complete(2), 'next model turn uses persisted source and confirmed delivery');
    assert.equal(cardSends, 1, 'Duplicate events and Worker restart do not resend the card');
    assert.equal(videoSends, scenario.video === 'success' ? 1 : 0);
    assert.equal(assetRequests, 0);
    assert.equal(app.db.plugins.view(bot.id, 'bilibili').jobs.length, scenario.video === 'off' ? 2 : 3);
  });
}
