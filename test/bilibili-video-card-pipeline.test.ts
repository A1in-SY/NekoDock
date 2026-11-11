import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { ConsoleDatabase } from '../src/console/database.js';
import type { PluginContent, PluginRunnerJob } from '../src/plugin-contract.js';

const url = 'https://www.bilibili.com/video/BV1234567890';
const content: PluginContent = { type: 'video', platform: 'bilibili', resourceId: 'BV1234567890:p1', url,
  title: 'Synthetic video', durationSeconds: 60, part: 1, retrieval: { status: 'ready' } };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAFElEQVR4nGPUaLrEwMDAxAAGUAoAG94BgqFCKSEAAAAASUVORK5CYII=', 'base64');
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(24)]);

for (const failure of ['prepare', 'delivery'] as const) {
  test(`a video card ${failure} failure leaves its independently prepared video available`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'video-card-pipeline-'));
    const db = new ConsoleDatabase(join(root, 'console.sqlite3'), join(root, 'master.key'));
    t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
    const bot = db.createBot({ name: 'Synthetic bot', targetType: 'group', targetId: '1001', config: {} });
    db.setDesiredState(bot.id, 'running');
    db.plugins.update(bot.id, 'bilibili', { expectedRevision: 0, enabled: true, config: { videoDisplay: 'card', autoVideo: true } });
    db.plugins.register(bot.id, { message_id: 'source', message: [{ type: 'text', data: { text: url } }] });
    db.plugins.sync(bot.id, { bindings: [{ messageId: 'source', conversationId: 'conversation' }], conversationId: 'conversation' });
    const resolve = db.plugins.claim()!; assert.equal(resolve.operation, 'resolve');
    db.plugins.complete(resolve.id, resolve.lease, { content });
    const jobs = new Map<string, PluginRunnerJob>();
    for (let index = 0; index < 2; index++) { const job = db.plugins.claim()!; assert.ok(job); jobs.set(job.operation, job); }
    const prepare = jobs.get('prepare')!, download = jobs.get('download')!;
    assert.ok(prepare); assert.ok(download);
    const videoAsset = await db.pluginAssets.upload(join(root, 'assets'), bot.id, Readable.from([mp4]),
      { maxBytes: 4096, cacheMaxBytes: 8192, cacheHours: 1 });
    db.plugins.attachAsset(download.id, download.lease, videoAsset);
    db.plugins.complete(download.id, download.lease, { assetId: videoAsset });
    if (failure === 'prepare') db.plugins.complete(prepare.id, prepare.lease, { error: 'PLUGIN_ASSET_UPLOAD_FAILED', retryable: false });
    else {
      const cardAsset = await db.pluginAssets.upload(join(root, 'assets'), bot.id, Readable.from([png]),
        { type: 'image', maxBytes: 4096, cacheMaxBytes: 8192, cacheHours: 1 });
      db.plugins.attachAsset(prepare.id, prepare.lease, cardAsset, 'card', 'image', 'presentation');
      db.plugins.complete(prepare.id, prepare.lease, { content, outputs: [{ kind: 'image', assetId: cardAsset, assetRole: 'presentation' }] });
      db.plugins.finishSend(bot.id, `output:${prepare.id}:000`, { ok: false, code: 'NAPCAT_SEND_FAILED', deliveryStatus: 'failed' });
    }
    const video = db.plugins.snapshot(bot.id).results.find(result => result.kind === 'video')!;
    assert.ok(video, 'The card failure does not hide the video output');
    assert.equal(video.delivery, undefined);
    assert.equal(db.plugins.authorizeSend(bot.id, video.id).assetId, videoAsset);
    db.plugins.finishSend(bot.id, video.id, { ok: true, messageId: 'actual-video-id' });
    assert.equal(db.plugins.getResult(bot.id, video.id)?.delivery?.messageId, 'actual-video-id');
  });
}
