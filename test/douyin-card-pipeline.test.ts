import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { BILIBILI_DEFAULTS } from '../src/plugins/bilibili/config.js';
import { preparePresentation } from '../src/plugins/bilibili/presentation.js';
import { DOUYIN_DEFAULTS } from '../src/plugins/douyin/config.js';
import { prepareDouyinCard } from '../src/plugins/douyin/presentation.js';
import { ConsoleDatabase } from '../src/console/database.js';
import type { PluginContent, PluginRunnerJob } from '../src/plugin-contract.js';

const url = 'https://www.douyin.com/video/1000000000000000001';
const content: PluginContent = { type: 'video', platform: 'douyin', resourceId: 'video:1000000000000000001', url,
  title: 'Synthetic caption', author: 'Synthetic author', authorId: '2001', durationSeconds: 60,
  subtitle: { status: 'absent' }, retrieval: { status: 'ready' } };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAFElEQVR4nGPUaLrEwMDAxAAGUAoAG94BgqFCKSEAAAAASUVORK5CYII=', 'base64');
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(24)]);

async function fixture(t: TestContext, config: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'douyin-card-pipeline-'));
  const path = join(root, 'console.sqlite3'), key = join(root, 'master.key');
  let db = new ConsoleDatabase(path, key);
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  const bot = db.createBot({ name: 'Synthetic bot', targetType: 'group', targetId: '1001', config: {} });
  db.setDesiredState(bot.id, 'running');
  db.plugins.update(bot.id, 'douyin', { expectedRevision: 0, enabled: true, config: { videoDisplay: 'card', autoVideo: true, ...config } });
  const event = { message_id: 'source', message: [{ type: 'text', data: { text: url } }] };
  const register = () => {
    db.plugins.register(bot.id, event);
    db.plugins.sync(bot.id, { bindings: [{ messageId: 'source', conversationId: 'conversation' }], conversationId: 'conversation' });
  };
  register();
  const resolve = db.plugins.claim()!; assert.equal(resolve.operation, 'resolve');
  const resolveWith = (value = content) => {
    assert.deepEqual(db.plugins.complete(resolve.id, resolve.lease, { content: value }), { accepted: true });
    const jobs = new Map<string, PluginRunnerJob>();
    for (let index = 0; index < 2; index++) { const job = db.plugins.claim(); if (job) jobs.set(job.operation, job); }
    return jobs;
  };
  const asset = async (job: PluginRunnerJob, type: 'image' | 'video', bytes = type === 'image' ? png : mp4) => {
    const id = await db.pluginAssets.upload(join(root, 'assets'), bot.id, Readable.from([bytes]),
      { type, maxBytes: 4096, cacheMaxBytes: 16384, cacheHours: 1 });
    if (type === 'image') db.plugins.attachAsset(job.id, job.lease, id, 'card', 'image', 'presentation');
    else db.plugins.attachAsset(job.id, job.lease, id);
    return id;
  };
  const card = async (prepare: PluginRunnerJob) => {
    const id = await asset(prepare, 'image');
    assert.deepEqual(db.plugins.complete(prepare.id, prepare.lease,
      { content: prepare.content, outputs: [{ kind: 'image', assetId: id, assetRole: 'presentation' }] }), { accepted: true });
    return `output:${prepare.id}:000`;
  };
  return { get db() { return db; }, bot, event, register, resolve, resolveWith, asset, card,
    restart() { db.close(); db = new ConsoleDatabase(path, key); } };
}

for (const failure of ['prepare', 'delivery'] as const) {
  test(`a Douyin card ${failure} failure leaves the independently completed video sendable`, async t => {
    const f = await fixture(t), jobs = f.resolveWith(), prepare = jobs.get('prepare')!, download = jobs.get('download')!;
    assert.ok(prepare); assert.ok(download);
    const videoAsset = await f.asset(download, 'video');
    f.db.plugins.complete(download.id, download.lease, { assetId: videoAsset });
    const video = f.db.plugins.snapshot(f.bot.id).results.find(result => result.kind === 'video')!;
    assert.equal(f.db.plugins.authorizeSend(f.bot.id, video.id).assetId, videoAsset,
      'A running card job imposes no cross-job delivery barrier');
    if (failure === 'prepare') f.db.plugins.complete(prepare.id, prepare.lease, { error: 'PLUGIN_ASSET_UPLOAD_FAILED', retryable: false });
    else {
      const card = await f.card(prepare);
      f.db.plugins.finishSend(f.bot.id, card, { ok: false, code: 'NAPCAT_SEND_FAILED', deliveryStatus: 'failed' });
    }
    assert.equal(f.db.plugins.getResult(f.bot.id, video.id)?.delivery, undefined);
    f.db.plugins.finishSend(f.bot.id, video.id, { ok: true, messageId: 'actual-video-id' });
    assert.equal(f.db.plugins.getResult(f.bot.id, video.id)?.delivery?.messageId, 'actual-video-id');
  });
}

test('a ready Douyin card can finish its ACK while video download is still running or fails', async t => {
  const f = await fixture(t), jobs = f.resolveWith(), prepare = jobs.get('prepare')!, download = jobs.get('download')!;
  assert.ok(prepare); assert.ok(download);
  const id = await f.card(prepare);
  assert.equal(f.db.plugins.authorizeSend(f.bot.id, id).replyTo, null);
  assert.equal(f.db.plugins.view(f.bot.id, 'douyin').jobs.find(job => job.id === download.id)?.state, 'running');
  f.db.plugins.finishSend(f.bot.id, id, { ok: true, messageId: 'actual-card-id' });
  f.db.plugins.complete(download.id, download.lease, { error: 'DOUYIN_MEDIA_UNAVAILABLE', retryable: false });
  assert.deepEqual(f.db.plugins.getResult(f.bot.id, id)?.delivery, { status: 'acknowledged', messageId: 'actual-card-id' });
  assert.equal(f.db.plugins.snapshot(f.bot.id).results.filter(result => result.kind === 'video').length, 0);
});

for (const scenario of [
  { name: 'only card enabled', config: { enhance: false, autoVideo: false }, duration: 60 },
  { name: 'video duration exceeds the download limit', config: { enhance: false, autoVideo: true }, duration: 301 },
] as const) {
  test(`Douyin prepares a card with no enrichment or download when ${scenario.name}`, async t => {
    const f = await fixture(t, scenario.config), jobs = f.resolveWith({ ...content, durationSeconds: scenario.duration });
    assert.deepEqual([...jobs.keys()], ['prepare']);
    const prepare = jobs.get('prepare')!;
    assert.deepEqual(prepare.presentation, { mode: 'card', provideContext: false });
    const id = await f.card(prepare);
    const results = f.db.plugins.snapshot(f.bot.id).results;
    assert.deepEqual(results.map(result => result.kind), ['image']);
    assert.equal(results[0]?.content?.durationSeconds, scenario.duration);
    assert.equal(f.db.plugins.authorizeSend(f.bot.id, id).assetRole, 'presentation');
  });
}

test('Douyin card jobs and ACK facts remain stable across duplicate shares and Console restart', async t => {
  const f = await fixture(t, { enhance: false, autoVideo: false }), jobs = f.resolveWith();
  const prepare = jobs.get('prepare')!, id = await f.card(prepare);
  const deliveryId = f.db.plugins.authorizeSend(f.bot.id, id).deliveryId;
  f.db.plugins.finishSend(f.bot.id, id, { ok: true, messageId: 'actual-card-id' });
  f.db.plugins.sync(f.bot.id, { acknowledgements: [id] });
  f.restart(); f.register();
  assert.equal(f.db.plugins.claim(), null);
  assert.equal(f.db.plugins.view(f.bot.id, 'douyin').jobs.length, 2);
  assert.equal(f.db.plugins.getResult(f.bot.id, id)?.deliveryId, deliveryId);
  assert.equal(f.db.plugins.getResult(f.bot.id, id)?.delivery?.messageId, 'actual-card-id');
  assert.equal(f.db.plugins.snapshot(f.bot.id).results.length, 0, 'An acknowledged result does not become a fresh output after restart');
});

for (const boundary of ['configuration', 'conversation'] as const) {
  test(`a ${boundary} boundary cancels an unsent Douyin card and rejects its previous in-flight download lease`, async t => {
    const f = await fixture(t), jobs = f.resolveWith(), prepare = jobs.get('prepare')!, download = jobs.get('download')!;
    const id = await f.card(prepare);
    if (boundary === 'configuration') {
      f.db.plugins.update(f.bot.id, 'douyin', { expectedRevision: 1, config: { videoDisplay: 'off' } });
    } else {
      f.db.plugins.observe(f.bot.id, { type: 'conversation.started', conversationId: 'new-conversation',
        payload: {}, seq: 1, time: Date.now() });
    }
    const code = boundary === 'configuration' ? 'PLUGIN_CONFIGURATION_CHANGED' : 'PLUGIN_CONVERSATION_CHANGED';
    assert.deepEqual(f.db.plugins.getResult(f.bot.id, id)?.delivery, { status: 'failed', code });
    assert.equal(f.db.plugins.authorizeSend(f.bot.id, id).delivery?.status, 'failed');
    assert.deepEqual(f.db.plugins.complete(download.id, download.lease, { error: 'DOUYIN_MEDIA_UNAVAILABLE' }), { accepted: false });
    assert.equal(f.db.plugins.view(f.bot.id, 'douyin').jobs.find(job => job.id === download.id)?.state, 'cancelled');
    assert.equal(f.db.plugins.claim(), null);
  });
}


test('Bilibili and Douyin presentation jobs share one render slot', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cross-platform-render-slot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bilibiliDir = join(root, 'bilibili'), douyinDir = join(root, 'douyin');
  await Promise.all([mkdir(bilibiliDir), mkdir(douyinDir)]);
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const firstStarted = new Promise<void>(resolve => { started = resolve; });
  t.after(() => release());
  let active = 0, peakActive = 0;
  const platforms: string[] = [];
  const execute = async (_command: string, args: string[], options: { cwd: string }) => {
    assert.equal(args[1], 'render');
    const request = JSON.parse(await readFile(args[2]!, 'utf8')) as { content: PluginContent };
    platforms.push(request.content.platform);
    active++; peakActive = Math.max(peakActive, active); started();
    await gate;
    try { await writeFile(join(options.cwd, 'card-0.png'), png); return JSON.stringify({ files: ['card-0.png'] }); }
    finally { active--; }
  };
  const signal = new AbortController().signal;
  const base = { id: 'synthetic-job', lease: 'synthetic-lease', botId: 'synthetic-bot',
    operation: 'prepare' as const, networkProxy: { enabled: false, url: '', username: '', password: '', noProxy: '', forTools: true },
    presentation: { mode: 'card' as const, provideContext: false }, expiresAt: Date.now() + 120000 };
  const first = preparePresentation({ ...base, pluginId: 'bilibili', config: BILIBILI_DEFAULTS,
    resource: { kind: 'video', id: 'BV1234567890:p1', url: 'https://www.bilibili.com/video/BV1234567890' },
    content: { ...content, platform: 'bilibili', resourceId: 'BV1234567890:p1', url: 'https://www.bilibili.com/video/BV1234567890', part: 1 } },
    bilibiliDir, async () => { throw new Error('No source images in this fixture'); }, execute, {}, signal);
  await firstStarted;
  const second = prepareDouyinCard({ ...base, pluginId: 'douyin', config: DOUYIN_DEFAULTS,
    resource: { kind: 'video', id: content.resourceId, url }, content }, douyinDir, undefined,
    async () => { throw new Error('No source images in this fixture'); }, execute, {}, signal);
  await delay(60);
  assert.deepEqual(platforms, ['bilibili'], 'The second platform waits while the first renderer owns the slot');
  release();
  const results = await Promise.all([first, second]);
  assert.deepEqual(platforms, ['bilibili', 'douyin']);
  assert.equal(peakActive, 1);
  assert.ok(results.every(result => result.outputs?.[0]?.kind === 'image'));
});
