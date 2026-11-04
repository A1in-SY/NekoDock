import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { ConsoleDatabase } from '../src/console/database.js';
import { BridgeStore } from '../src/store.js';
import { PluginCoordinator } from '../src/plugin-coordinator.js';
import { pluginSourceImageIds } from '../src/plugin-images.js';
import type { PluginContent } from '../src/plugin-contract.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAFElEQVR4nGPUaLrEwMDAxAAGUAoAG94BgqFCKSEAAAAASUVORK5CYII=', 'base64');
const gif = Buffer.from('R0lGODdhAgADAIEAACiC0gAAAAAAAAAAACwAAAAAAgADAAAIBgABCBwYEAA7', 'base64');
const logger = { info() {}, warn() {}, error() {} };

function picture(content: PluginContent) {
  return content.blocks?.find(block => block.type === 'image')?.image;
}

test('same-millisecond resource enrichments retain both ready images when IDs sort against publication order', async t => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-enrichment-order-'));
  const path = join(root, 'console.sqlite3');
  const db = new ConsoleDatabase(path, join(root, 'key'));
  const raw = new DatabaseSync(path);
  const store = new BridgeStore(':memory:', { type: 'group', id: '10001' });
  let coordinator: PluginCoordinator | undefined;
  t.after(async () => {
    await coordinator?.close();
    store.close();
    raw.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  const bot = db.createBot({ name: 'Synthetic bot', targetType: 'group', targetId: '10001', config: {} });
  db.setDesiredState(bot.id, 'running');
  db.plugins.update(bot.id, 'bilibili', { expectedRevision: 0, enabled: true });
  const source = 'synthetic-share';
  const resourceIds = ['post:1234567890123456781', 'post:1234567890123456782'];
  const urls = resourceIds.map(id => 'https://www.bilibili.com/opus/' + id.slice('post:'.length));
  const text = urls.join('\n');
  const rawJson = JSON.stringify({ message: [{ type: 'text', data: { text } }] });
  store.insert({ messageId: source, senderId: '2001', senderName: 'Synthetic sender', time: 1, text, replyTo: null, trigger: true, rawJson });
  const conversationId = store.recorder.conversationId;
  // All four publications share one clock tick; IDs make the old time/ID order deterministically stale.
  const now = Date.now() + 60_000;
  db.plugins.register(bot.id, { message_id: source, message: [{ type: 'text', data: { text } }] }, now - 1);
  db.plugins.sync(bot.id, { bindings: [{ messageId: source, conversationId }], conversationId });

  const assignQueuedId = (operation: string, resourceId: string, id: string) => {
    assert.equal(raw.prepare("UPDATE plugin_jobs SET id=? WHERE bot_id=? AND source_message_id=? AND operation=? AND resource_key=? AND state='queued'")
      .run(id, bot.id, source, operation, resourceId).changes, 1);
  };
  for (const [index, resourceId] of resourceIds.entries()) assignQueuedId('resolve', resourceId, `z-resolve-${index}`);

  for (const [index, resourceId] of resourceIds.entries()) {
    const job = db.plugins.claim(now)!;
    assert.equal(job.operation, 'resolve');
    assert.equal(job.resource.id, resourceId);
    const content: PluginContent = {
      type: 'post', platform: 'bilibili', resourceId, url: urls[index]!, title: `Synthetic post ${index}`,
      blocks: [{ type: 'image', image: { id: `picture-${index}`, url: `https://i0.hdslb.com/bfs/new_dyn/synthetic-${index}.png`, role: 'content', status: 'pending' } }],
      retrieval: { status: 'ready' },
    };
    assert.equal(db.plugins.complete(job.id, job.lease, { content }, now).accepted, true);
  }
  for (const [index, resourceId] of resourceIds.entries()) assignQueuedId('prepare', resourceId, `a-prepare-${index}`);

  const expectedAssets = new Map<string, string>();
  for (const [index, resourceId] of resourceIds.entries()) {
    const job = db.plugins.claim(now)!;
    assert.equal(job.operation, 'prepare');
    assert.equal(job.resource.id, resourceId);
    const assetId = await db.pluginAssets.upload(join(root, 'assets'), bot.id, Readable.from([index === 0 ? png : gif]),
      { type: 'image', maxBytes: 1024, cacheMaxBytes: 4096, cacheHours: 1 });
    db.plugins.attachAsset(job.id, job.lease, assetId, 'source', 'image', 'content');
    expectedAssets.set(resourceId, assetId);
    const content = structuredClone(job.content!);
    Object.assign(picture(content)!, { status: 'ready', assetId });
    assert.equal(db.plugins.complete(job.id, job.lease, { content, outputs: [] }, now).accepted, true);
  }
  assert.equal(new Set(expectedAssets.values()).size, 2);
  const publications = db.plugins.snapshot(bot.id).results.filter(result => result.kind === 'enrichment');
  assert.deepEqual(publications.map(result => result.revision), [3, 4, 1, 2]);
  const latest = publications.find(result => result.revision === 4)!;
  for (const content of latest.contents!) {
    assert.equal(picture(content)?.status, 'ready');
    assert.equal(picture(content)?.assetId, expectedAssets.get(content.resourceId));
  }
  assert.equal(latest.contents?.length, 2);

  coordinator = new PluginCoordinator({
    identity: { url: 'http://console.invalid', botId: bot.id, token: 'synthetic-worker-token', dataDir: root },
    store, logger, notify() {},
    request: async (endpoint, body) => {
      if (endpoint === 'plugins') return db.plugins.snapshot(bot.id);
      if (endpoint === 'plugins/sync') return db.plugins.sync(bot.id, body);
      throw new Error('Unexpected fixture endpoint');
    },
  }, new AbortController().signal);
  coordinator.register(source);
  await coordinator.synchronize();
  const projected = store.chatMessageForQQ(source)?.contents as PluginContent[];
  assert.equal(projected.length, 2);
  for (const content of projected) {
    assert.equal(picture(content)?.status, 'ready');
    assert.equal(picture(content)?.assetId, expectedAssets.get(content.resourceId));
  }
  assert.deepEqual(pluginSourceImageIds(projected).sort(), [...expectedAssets.values()].sort());
});
