import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { ConsoleDatabase } from '../src/console/database.js';
import { ConsoleImagePrefetch, IMAGE_TRANSIT_TASK_LIMITS } from '../src/console/incoming-images.js';
import { createConsole } from '../src/console/server.js';
import { DockerClient } from '../src/console/docker.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ioAAAAASUVORK5CYII=', 'base64');
const event = (id: string, ...sources: string[]) => ({ post_type: 'message', message_type: 'group', group_id: '1001', user_id: '123',
  self_id: '999', message_id: id, time: 1792727200, message: sources.map(url => ({ type: 'image', data: { url } })) });
const quiet = { info() {}, warn() {}, error() {} };
async function until(condition: () => boolean, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!condition()) { assert.ok(Date.now() < deadline, 'image preparation timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
async function fixture(t: TestContext, fetch: typeof globalThis.fetch, config: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'nekodock-image-transit-'));
  const database = join(root, 'console.sqlite3'), key = join(root, 'master.key');
  const db = new ConsoleDatabase(database, key);
  const bot = db.createBot({ name: 'Example', targetType: 'group', targetId: '1001', config });
  db.setDesiredState(bot.id, 'running');
  const prefetch = new ConsoleImagePrefetch({ store: db.images, root: join(root, 'media'), bot: id => db.getBot(id), logger: quiet, fetch });
  prefetch.start(false);
  t.after(async () => { await prefetch.close(); db.close(); await rm(root, { recursive: true, force: true }); });
  return { root, database, key, db, bot, prefetch };
}

test('Console snapshots untriggered images before a Worker is online, and message ACK does not release them', async t => {
  let expired = false, downloads = 0;
  const f = await fixture(t, async () => { downloads++; return expired ? new Response('', { status: 403 }) : new Response(png); });
  const seq = f.db.enqueueNapcatEvent(f.bot.id, event('1', 'https://example.invalid/photo?auth=synthetic-private-token'), 'one')!;
  const manifest = f.db.pendingNapcatEvents(f.bot.id)[0]!.attachments!;
  assert.equal(manifest.length, 1);
  assert.equal(manifest[0]!.status, 'pending');
  assert.doesNotMatch(JSON.stringify(manifest), /synthetic-private-token|example.invalid/);
  f.db.ackNapcatEvents(f.bot.id, seq);
  assert.equal(f.db.pendingNapcatEventCount(f.bot.id), 0);
  await until(() => f.db.images.get(f.bot.id, manifest[0]!.id).status === 'ready');
  expired = true;
  assert.deepEqual((await f.prefetch.content(f.bot.id, manifest[0]!.id)).bytes, png);
  assert.equal(downloads, 1);
  assert.equal(f.db.enqueueNapcatEvent(f.bot.id, event('1', 'https://example.invalid/other'), 'one'), null);
  assert.equal(f.db.images.list(f.bot.id).length, 1);
  const raw = new DatabaseSync(f.database, { readOnly: true });
  t.after(() => raw.close());
  const sourceCipher = raw.prepare('SELECT source_cipher FROM console_incoming_images').get()!.source_cipher;
  assert.equal(sourceCipher, null, 'download credentials should be discarded after a successful snapshot');
});

test('encrypted durable downloads recover after Console reconstruction and retain completed snapshots', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nekodock-image-recover-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'console.sqlite3'), key = join(root, 'master.key');
  let db = new ConsoleDatabase(file, key);
  const bot = db.createBot({ name: 'Example', targetType: 'group', targetId: '1001', config: {} });
  db.setDesiredState(bot.id, 'running');
  db.enqueueNapcatEvent(bot.id, event('1', 'https://example.invalid/image?token=synthetic-private-source'), 'one');
  const image = db.images.list(bot.id)[0]!;
  const sql = new DatabaseSync(file);
  assert.doesNotMatch(String(sql.prepare('SELECT source_cipher FROM console_incoming_images').get()!.source_cipher), /synthetic-private-source/);
  sql.close();
  assert.equal(db.images.claim(image.id), true);
  db.close();
  db = new ConsoleDatabase(file, key);
  let requests = 0;
  let prefetch = new ConsoleImagePrefetch({ store: db.images, root: join(root, 'media'), bot: id => db.getBot(id), logger: quiet,
    fetch: async () => { requests++; return new Response(png); } });
  prefetch.start(false);
  await until(() => db.images.get(bot.id, image.id).status === 'ready');
  await prefetch.close(); db.close();
  db = new ConsoleDatabase(file, key);
  prefetch = new ConsoleImagePrefetch({ store: db.images, root: join(root, 'media'), bot: id => db.getBot(id), logger: quiet,
    fetch: async () => { throw new Error('expired source must not be retried'); } });
  prefetch.start(false);
  try { assert.deepEqual((await prefetch.content(bot.id, image.id)).bytes, png); assert.equal(requests, 1); }
  finally { await prefetch.close(); db.close(); }
});

test('media ACK verifies bytes and releases shared content only after all instance-local references transfer', async t => {
  const f = await fixture(t, async () => new Response(png));
  f.db.enqueueNapcatEvent(f.bot.id, event('1', 'https://example.invalid/one', 'https://example.invalid/two'), 'one');
  await until(() => f.db.images.list(f.bot.id).filter(image => image.status === 'ready').length === 2);
  const [first, second] = f.db.images.list(f.bot.id);
  assert.equal(first!.sha256, second!.sha256);
  await assert.rejects(f.prefetch.acknowledge(f.bot.id, first!.id, 'bad-hash'), /校验值无效/);
  await f.prefetch.acknowledge(f.bot.id, first!.id, first!.sha256);
  assert.deepEqual((await f.prefetch.content(f.bot.id, second!.id)).bytes, png);
  await f.prefetch.acknowledge(f.bot.id, second!.id, second!.sha256);
  await assert.rejects(f.prefetch.content(f.bot.id, second!.id));
  assert.deepEqual(await readdir(join(f.root, 'media', f.bot.id, '.qq-images')), []);
  assert.equal(f.db.images.list(f.bot.id).length, 0);
});

test('identical immutable image sources share a Console download while each message retains its own attachment', async t => {
  let downloads = 0;
  const f = await fixture(t, async () => { downloads++; await new Promise(resolve => setTimeout(resolve, 20)); return new Response(png); });
  const source = 'https://multimedia.nt.qq.com.cn/download?appid=1&fileid=synthetic-image&spec=0&rkey=synthetic-private-key';
  f.db.enqueueNapcatEvent(f.bot.id, event('shared-1', source), 'shared-1');
  f.db.enqueueNapcatEvent(f.bot.id, event('shared-2', source), 'shared-2');
  await until(() => f.db.images.list(f.bot.id).filter(i => i.status === 'ready').length === 2);
  const images = f.db.images.list(f.bot.id);
  assert.equal(downloads, 1);
  assert.notEqual(images[0]!.id, images[1]!.id);
  assert.equal(images[0]!.sha256, images[1]!.sha256);
  assert.deepEqual((await f.prefetch.content(f.bot.id, images[1]!.id)).bytes, png);
  const path = join(f.root, 'media', f.bot.id, '.qq-images', `${images[0]!.sha256}.png`), previous = new Date('2025-01-01T00:00:00Z');
  await utimes(path, previous, previous);
  f.db.enqueueNapcatEvent(f.bot.id, event('shared-3', source), 'shared-3');
  await until(() => f.db.images.forMessage(f.bot.id, 'shared-3')[0]?.status === 'ready');
  assert.equal(downloads, 1);
  assert.equal((await stat(path)).mtimeMs, previous.getTime());
  const raw = new DatabaseSync(f.database, {readOnly: true});
  try {
    const rows = raw.prepare('SELECT source_cipher,source_fingerprint FROM console_incoming_images').all();
    assert.equal(new Set(rows.map(r => r.source_fingerprint)).size, 1);
    assert.doesNotMatch(JSON.stringify(rows), /synthetic-private-key|multimedia\.nt\.qq/);
  } finally { raw.close(); }
});

test('source reuse retains every URL parameter and stays inside one instance', async t => {
  let downloads = 0;
  const f = await fixture(t, async () => { downloads++; return new Response(png); });
  const source = 'https://multimedia.nt.qq.com.cn/download?appid=1&fileid=synthetic-image&spec=0&rkey=first';
  f.db.enqueueNapcatEvent(f.bot.id, event('source-1', source), 'source-1');
  await until(() => f.db.images.forMessage(f.bot.id, 'source-1')[0]?.status === 'ready');
  f.db.enqueueNapcatEvent(f.bot.id, event('source-2', source.replace('rkey=first', 'rkey=second')), 'source-2');
  await until(() => f.db.images.forMessage(f.bot.id, 'source-2')[0]?.status === 'ready');
  assert.equal(downloads, 2);
  const second = f.db.createBot({name: 'Other', targetType: 'group', targetId: '1002', config: {}});
  f.db.setDesiredState(second.id, 'running');
  f.db.enqueueNapcatEvent(second.id, event('source-other', source), 'source-other');
  await until(() => f.db.images.forMessage(second.id, 'source-other')[0]?.status === 'ready');
  assert.equal(downloads, 3);
  f.db.enqueueNapcatEvent(f.bot.id, event('mutable-1', 'https://example.invalid/current-image'), 'mutable-1');
  await until(() => f.db.images.forMessage(f.bot.id, 'mutable-1')[0]?.status === 'ready');
  f.db.enqueueNapcatEvent(f.bot.id, event('mutable-2', 'https://example.invalid/current-image'), 'mutable-2');
  await until(() => f.db.images.forMessage(f.bot.id, 'mutable-2')[0]?.status === 'ready');
  assert.equal(downloads, 5, 'arbitrary mutable HTTP resources must not reuse an old snapshot');
});

test('Console source reuse checks the real file and redownloads after corruption or transfer cleanup', async t => {
  let downloads = 0;
  const f = await fixture(t, async () => { downloads++; return new Response(png); });
  const source = 'https://multimedia.nt.qq.com.cn/download?appid=1&fileid=synthetic-repair&spec=0&rkey=synthetic';
  f.db.enqueueNapcatEvent(f.bot.id, event('repair-1', source), 'repair-1');
  await until(() => f.db.images.forMessage(f.bot.id, 'repair-1')[0]?.status === 'ready');
  const first = f.db.images.forMessage(f.bot.id, 'repair-1')[0]!, path = join(f.root, 'media', f.bot.id, '.qq-images', `${first.sha256}.png`);
  await writeFile(path, Buffer.alloc(png.length));
  f.db.enqueueNapcatEvent(f.bot.id, event('repair-2', source), 'repair-2');
  await until(() => f.db.images.forMessage(f.bot.id, 'repair-2')[0]?.status === 'ready');
  assert.deepEqual(await readFile(path), png);
  assert.equal(f.db.images.get(f.bot.id, first.id).status, 'failed');
  const second = f.db.images.forMessage(f.bot.id, 'repair-2')[0]!;
  await f.prefetch.acknowledge(f.bot.id, second.id, second.sha256);
  assert.deepEqual(await readdir(join(f.root, 'media', f.bot.id, '.qq-images')), []);
  f.db.enqueueNapcatEvent(f.bot.id, event('repair-3', source), 'repair-3');
  await until(() => f.db.images.forMessage(f.bot.id, 'repair-3')[0]?.status === 'ready');
  assert.deepEqual((await f.prefetch.content(f.bot.id, f.db.images.forMessage(f.bot.id, 'repair-3')[0]!.id)).bytes, png);
  assert.equal(downloads, 3, 'corrupt and cleaned-up snapshots must fetch usable bytes again');
});

test('identical base64 image files share their snapshot without accessing the network', async t => {
  const f = await fixture(t, async () => { throw new Error('Base64 must not use HTTP'); });
  const picture = (id: string) => ({...event(id), message: [{type: 'image', data: {file: `base64://${png.toString('base64')}`}}]});
  f.db.enqueueNapcatEvent(f.bot.id, picture('base64-1'), 'base64-1');
  f.db.enqueueNapcatEvent(f.bot.id, picture('base64-2'), 'base64-2');
  await until(() => f.db.images.list(f.bot.id).filter(i => i.status === 'ready').length === 2);
  assert.equal(f.db.images.list(f.bot.id)[0]!.sha256, f.db.images.list(f.bot.id)[1]!.sha256);
  assert.deepEqual((await f.prefetch.content(f.bot.id, f.db.images.list(f.bot.id)[1]!.id)).bytes, png);
});

test('inspection lease retains a transferred picture until its independent consumer releases it', async t => {
  const f = await fixture(t, async () => new Response(png));
  f.db.enqueueNapcatEvent(f.bot.id, event('lease-image', 'https://example.invalid/image'), 'lease-image');
  await until(() => f.db.images.list(f.bot.id)[0]?.status === 'ready');
  const image = f.db.images.list(f.bot.id)[0]!;
  assert.equal(f.db.images.pin(f.bot.id, image.id, 'inspection-a', Date.now() + 60_000), true);
  await f.prefetch.acknowledge(f.bot.id, image.id, image.sha256);
  await assert.rejects(f.prefetch.content(f.bot.id, image.id));
  assert.deepEqual((await f.prefetch.contentForConsumer(f.bot.id, image.id, 'inspection-a')).bytes, png);
  await assert.rejects(f.prefetch.contentForConsumer(f.bot.id, image.id, 'another-consumer'));
  f.db.images.releaseConsumer(f.bot.id, 'inspection-a');
  await assert.rejects(f.prefetch.contentForConsumer(f.bot.id, image.id, 'inspection-a'));
  await until(() => f.db.images.references(f.bot.id, image.sha256!) === 0);
  assert.equal(f.db.images.pin(f.bot.id, image.id, 'too-late', Date.now() + 60_000), false);
});

test('extra sampled assets stay outside ordinary attachment manifests and do not consume the sixty-four slots', async t => {
  const f = await fixture(t, async () => new Response(png));
  const extra = f.db.images.registerInspectionSource(f.bot.id, 'forward-extra', 'forward:s0/n99/s0', 'https://example.invalid/extra', 'inspection-extra', Date.now() + 60_000)!;
  assert.ok(extra);
  assert.deepEqual(f.db.images.forMessage(f.bot.id, 'forward-extra'), []);
  assert.deepEqual(f.db.images.list(f.bot.id), []);
  for (let index = 0; index < 64; index++) assert.ok(f.db.images.registerForwardSource(f.bot.id, 'forward-extra', `forward:s0/n${index}/s0`, 'https://example.invalid/normal'));
  assert.equal(f.db.images.registerForwardSource(f.bot.id, 'forward-extra', 'forward:s0/n100/s0', 'https://example.invalid/overflow'), null);
  assert.equal(f.db.images.forMessage(f.bot.id, 'forward-extra').length, 64);
  await until(() => f.db.images.get(f.bot.id, extra.id).status === 'ready');
  assert.deepEqual((await f.prefetch.contentForConsumer(f.bot.id, extra.id, 'inspection-extra')).bytes, png);
  f.db.images.release(f.bot.id, extra.id, 'inspection-extra');
  assert.equal(f.db.images.get(f.bot.id, extra.id).status, 'expired');
});

test('inspection-only source can become an ordinary attachment and its lease cannot cross instances', async t => {
  const f = await fixture(t, async () => new Response(png));
  const extra = f.db.images.registerInspectionSource(f.bot.id, 'promoted', 'forward:s0/n0/s0', 'https://example.invalid/extra', 'inspection-promoted', Date.now() + 60_000)!;
  const ordinary = f.db.images.registerForwardSource(f.bot.id, 'promoted', 'forward:s0/n0/s0', 'https://example.invalid/extra')!;
  assert.equal(ordinary.id, extra.id);
  assert.equal(ordinary.index, 0);
  assert.equal(f.db.images.forMessage(f.bot.id, 'promoted').length, 1);
  const other = f.db.createBot({ name: 'Other', targetType: 'group', targetId: '1002', config: {} });
  assert.throws(() => f.db.images.pin(other.id, ordinary.id, 'inspection-promoted', Date.now() + 60_000));
  assert.equal(f.db.images.hasLease(other.id, ordinary.id, 'inspection-promoted'), false);
  f.db.images.releaseConsumer(f.bot.id, 'inspection-promoted');
  assert.notEqual(f.db.images.get(f.bot.id, ordinary.id).status, 'expired');
});

test('expired inspection leases release private sources and their bounded queue slots', async t => {
  const f = await fixture(t, async () => new Response(png));
  const now = Date.now();
  for (let index = 0; index < 16; index++) assert.ok(f.db.images.registerInspectionSource(f.bot.id, 'bounded', `forward:s0/n${index}/s0`, 'https://example.invalid/extra', 'inspection-bound', now + 1000, now));
  assert.equal(f.db.images.registerInspectionSource(f.bot.id, 'bounded', 'forward:s0/n16/s0', 'https://example.invalid/extra', 'inspection-bound', now + 1000, now), null);
  const id = f.db.images.pending()[0]!.id;
  f.db.images.expire(now + 1001);
  assert.equal(f.db.images.get(f.bot.id, id).status, 'expired');
  assert.equal(f.db.images.hasLease(f.bot.id, id, 'inspection-bound', now + 1001), false);
  assert.deepEqual(f.db.images.pending(), []);
});

test('completed inspection records survive their TTL while released sample files are actually removed', async t => {
  const f = await fixture(t, async () => new Response(png));
  f.db.plugins.update(f.bot.id, 'forward-nsfw', { expectedRevision: 0, enabled: true, config: { apiKey: 'synthetic-inspection-key' } });
  const store = f.db.plugins.inspections;
  const job = store.begin(f.bot.id, 'completed-inspection', '999')!;
  const image = f.db.images.registerInspectionSource(f.bot.id, 'completed-inspection', 'forward:s0/n0/s0',
    'https://example.invalid/completed', job.id, job.expiresAt)!;
  await until(() => f.db.images.get(f.bot.id, image.id).status === 'ready');
  store.complete(job.id, { messageCount: 1, imageMessageCount: 1, imageCount: 1, structuralComplete: true,
    samples: [{ sourceKey: image.sourceKey!, attachmentId: image.id }] });
  assert.equal(store.claim(new Set())!.id, job.id);
  store.finish(job.id, [{ sourceKey: image.sourceKey!, score: 0.1 }]);
  assert.equal(store.view(job.id)!.outcome, 'not_detected');
  for (const item of store.retention()) { f.db.images.releaseConsumer(item.botId, item.consumer); store.released(item.consumer); }
  assert.deepEqual(store.retention(), [], 'completed consumers are released once, not rescanned forever');
  await until(() => f.db.images.get(f.bot.id, image.id).status === 'expired');
  const directory = join(f.root, 'media', f.bot.id, '.qq-images');
  for (let attempt = 0; attempt < 20 && (await readdir(directory)).length; attempt++) {
    f.prefetch.tick(); await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.deepEqual(await readdir(directory), []);
  assert.equal(store.claim(new Set(), job.expiresAt + 60_000), null);
  assert.equal(store.view(job.id)!.outcome, 'not_detected', 'job TTL governs execution, not durable completed inspection results');
  assert.equal(f.db.plugins.jobs(f.bot.id, 50, 'forward-nsfw')[0]!.state, 'completed');
});

test('orphaned inspection leases expire and the cache cleanup removes their completed files', async t => {
  const f = await fixture(t, async () => new Response(png));
  const expiresAt = Date.now() + 1000;
  const image = f.db.images.registerInspectionSource(f.bot.id, 'orphaned-inspection', 'forward:s0/n0/s0',
    'https://example.invalid/orphaned', 'orphaned-consumer', expiresAt)!;
  await until(() => f.db.images.get(f.bot.id, image.id).status === 'ready');
  const directory = join(f.root, 'media', f.bot.id, '.qq-images');
  assert.equal((await readdir(directory)).length, 1);
  f.db.images.expire(expiresAt + 1);
  assert.equal(f.db.images.get(f.bot.id, image.id).status, 'expired');
  for (let attempt = 0; attempt < 20 && (await readdir(directory)).length; attempt++) {
    f.prefetch.tick(); await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.deepEqual(await readdir(directory), []);
  await assert.rejects(f.prefetch.contentForConsumer(f.bot.id, image.id, 'orphaned-consumer'));
});

test('Worker ACK racing a plugin read keeps bytes available until all consumer leases release', async t => {
  const f = await fixture(t, async () => new Response(png));
  f.db.enqueueNapcatEvent(f.bot.id, event('racing-ack', 'https://example.invalid/shared'), 'racing-ack');
  await until(() => f.db.images.list(f.bot.id)[0]?.status === 'ready');
  const image = f.db.images.list(f.bot.id)[0]!;
  f.db.images.pin(f.bot.id, image.id, 'inspection-one', Date.now() + 60_000);
  f.db.images.pin(f.bot.id, image.id, 'inspection-two', Date.now() + 60_000);
  const [reading] = await Promise.all([f.prefetch.contentForConsumer(f.bot.id, image.id, 'inspection-one'), f.prefetch.acknowledge(f.bot.id, image.id, image.sha256)]);
  assert.deepEqual(reading.bytes, png);
  f.db.images.releaseConsumer(f.bot.id, 'inspection-one');
  assert.deepEqual((await f.prefetch.contentForConsumer(f.bot.id, image.id, 'inspection-two')).bytes, png);
  f.db.images.releaseConsumer(f.bot.id, 'inspection-two');
  await assert.rejects(f.prefetch.contentForConsumer(f.bot.id, image.id, 'inspection-two'));
});

test('releasing an inspection-only consumer aborts its active download', async t => {
  let started = false, aborted = false;
  const f = await fixture(t, async (_input, init) => new Promise<Response>((_resolve, reject) => {
    started = true;
    init!.signal!.addEventListener('abort', () => { aborted = true; reject(init!.signal!.reason); }, { once: true });
  }));
  const image = f.db.images.registerInspectionSource(f.bot.id, 'cancel-inspection', 'forward:s0/n0/s0',
    'https://example.invalid/inflight', 'inspection-cancel', Date.now() + 60_000)!;
  await until(() => started);
  f.db.images.releaseConsumer(f.bot.id, 'inspection-cancel');
  await until(() => aborted);
  assert.equal(f.db.images.get(f.bot.id, image.id).status, 'expired');
  assert.deepEqual(f.db.images.pending(), []);
});

test('releasing a plugin lease leaves the ordinary chat download running', async t => {
  let started = false, aborted = false;
  const f = await fixture(t, async (_input, init) => new Promise<Response>((_resolve, reject) => {
    started = true;
    init!.signal!.addEventListener('abort', () => { aborted = true; reject(init!.signal!.reason); }, { once: true });
  }));
  f.db.enqueueNapcatEvent(f.bot.id, event('shared-inflight', 'https://example.invalid/inflight'), 'shared-inflight');
  const image = f.db.images.list(f.bot.id)[0]!;
  f.db.images.pin(f.bot.id, image.id, 'inspection-share', Date.now() + 60_000);
  await until(() => started);
  f.db.images.releaseConsumer(f.bot.id, 'inspection-share');
  f.prefetch.tick();
  assert.equal(aborted, false);
  assert.equal(f.db.images.get(f.bot.id, image.id).status, 'pending', 'public descriptors normalize downloading to pending');
});

test('expired and oversized images terminate independently, while text ingress keeps working', async t => {
  const f = await fixture(t, async input => String(input).includes('/large') ? new Response(Buffer.alloc(1024 * 1024 + 1)) : new Response(png), { imageMaxMiB: 1 });
  f.db.enqueueNapcatEvent(f.bot.id, event('1', 'https://example.invalid/large'), 'one');
  f.db.enqueueNapcatEvent(f.bot.id, event('2', 'https://example.invalid/photo'), 'two');
  await until(() => f.db.images.list(f.bot.id).every(image => image.status !== 'pending'));
  const images = f.db.images.list(f.bot.id);
  assert.equal(images.find(image => image.messageId === '1')!.status, 'failed');
  assert.equal(images.find(image => image.messageId === '2')!.status, 'ready');
  assert.equal(f.db.images.expire(Date.now() + 25 * 3600_000), 1);
  assert.equal(f.db.images.get(f.bot.id, images.find(image => image.messageId === '2')!.id).status, 'expired');
  const failed = images.find(image => image.messageId === '1')!;
  await f.prefetch.acknowledge(f.bot.id, failed.id);
  const text = { ...event('3'), message: [{ type: 'text', data: { text: 'hello' } }] };
  assert.ok(f.db.enqueueNapcatEvent(f.bot.id, text, 'three'));
});

test('transit quota rejects new content without evicting untransferred snapshots', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nekodock-image-quota-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const db = new ConsoleDatabase(join(root, 'console.sqlite3'), join(root, 'master.key'));
  t.after(() => db.close());
  const bot = db.createBot({ name: 'Quota', targetType: 'group', targetId: '1001', config: { imageTransitMaxMiB: 1 } });
  db.setDesiredState(bot.id, 'running');
  db.enqueueNapcatEvent(bot.id, event('1', 'https://example.invalid/one', 'https://example.invalid/two', 'https://example.invalid/duplicate'), 'one');
  const [one, two, duplicate] = db.images.list(bot.id);
  for (const image of [one, two, duplicate]) assert.equal(db.images.claim(image!.id), true);
  assert.equal(db.images.complete(one!.id, 'a'.repeat(64), 'image/png', 800 * 1024), true);
  assert.equal(db.images.complete(two!.id, 'b'.repeat(64), 'image/png', 400 * 1024), false);
  assert.equal(db.images.get(bot.id, two!.id).error, '图片中转缓存空间不足');
  assert.equal(db.images.get(bot.id, one!.id).status, 'ready');
  assert.equal(db.images.complete(duplicate!.id, 'a'.repeat(64), 'image/png', 800 * 1024), true);
});

test('transferred content retained by a plugin still counts toward the instance transit quota', async t => {
  const f = await fixture(t, async () => new Response(png), { imageTransitMaxMiB: 1 });
  f.db.enqueueNapcatEvent(f.bot.id, event('quota-leased', 'https://example.invalid/retained', 'https://example.invalid/new'), 'quota-leased');
  // Claim synchronously before the prefetch notification can start real fixture downloads.
  const [retained, next] = f.db.images.list(f.bot.id);
  assert.equal(f.db.images.claim(retained!.id), true);
  assert.equal(f.db.images.complete(retained!.id, 'a'.repeat(64), 'image/png', 800 * 1024), true);
  assert.equal(f.db.images.pin(f.bot.id, retained!.id, 'inspection-quota', Date.now() + 60_000), true);
  f.db.images.acknowledge(f.bot.id, retained!.id, 'a'.repeat(64));
  assert.equal(f.db.images.claim(next!.id), true);
  assert.equal(f.db.images.complete(next!.id, 'b'.repeat(64), 'image/png', 400 * 1024), false);
  assert.equal(f.db.images.get(f.bot.id, next!.id).error, '图片中转缓存空间不足');
});

test('ordinary image media routes enforce Worker ownership and never expose source credentials', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nekodock-image-api-'));
  const docker = new DockerClient({ socketPath: 'unused', image: 'unused', network: 'unused', consoleUrl: 'unused' });
  const { app, db } = await createConsole({ dataDir: directory, docker, timers: false, staticDir: '/nonexistent', incomingImageFetch: async () => new Response(png) });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const first = db.createBot({ name: 'First', targetType: 'group', targetId: '1001', config: {} });
  const second = db.createBot({ name: 'Second', targetType: 'group', targetId: '1002', config: {} });
  db.setDesiredState(first.id, 'running');
  db.enqueueNapcatEvent(first.id, event('1', 'https://example.invalid/photo?token=synthetic-secret'), 'one');
  await until(() => db.images.list(first.id)[0]?.status === 'ready');
  const image = db.images.list(first.id)[0]!;
  const path = `/internal/workers/${first.id}/incoming-images`;
  const headers = { authorization: `Bearer ${first.workerToken}` };
  assert.equal((await app.inject(path)).statusCode, 401);
  assert.equal((await app.inject({ url: path, headers: { authorization: `Bearer ${second.workerToken}` } })).statusCode, 401);
  const list = await app.inject({ url: path, headers });
  assert.equal(list.statusCode, 200); assert.doesNotMatch(list.body, /example.invalid|synthetic-secret/);
  assert.equal((await app.inject({ url: `/internal/workers/${second.id}/incoming-images/${image.id}`, headers: { authorization: `Bearer ${second.workerToken}` } })).statusCode, 404);
  const content = await app.inject({ url: `${path}/${image.id}/content`, headers });
  assert.equal(content.statusCode, 200); assert.equal(content.headers['content-type'], 'image/png'); assert.deepEqual(content.rawPayload, png);
  assert.equal((await app.inject({ method: 'POST', url: `${path}/${image.id}/ack`, headers, payload: {} })).statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url: `${path}/${image.id}/ack`, headers, payload: { sha256: image.sha256 } })).statusCode, 200);
  assert.equal((await app.inject({ url: `${path}/${image.id}/content`, headers })).statusCode, 410);
});

test('prefetch limits downloads to four globally and two per instance without blocking other instances', async t => {
  let active = 0, maximum = 0;
  const perBot = new Map<string, number>(), maximumPerBot = new Map<string, number>();
  const releases: Array<() => void> = [];
  const f = await fixture(t, async (input, init) => {
    const bot = new URL(String(input)).pathname.split('/')[1]!;
    active++; maximum = Math.max(maximum, active);
    perBot.set(bot, (perBot.get(bot) ?? 0) + 1);
    maximumPerBot.set(bot, Math.max(maximumPerBot.get(bot) ?? 0, perBot.get(bot)!));
    await new Promise<void>((resolve, reject) => {
      releases.push(resolve);
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    });
    active--; perBot.set(bot, perBot.get(bot)! - 1);
    return new Response(png);
  });
  const bots = [f.bot, f.db.createBot({ name: 'Second', targetType: 'group', targetId: '1002', config: {} }), f.db.createBot({ name: 'Third', targetType: 'group', targetId: '1003', config: {} })];
  for (const bot of bots) {
    f.db.setDesiredState(bot.id, 'running');
    f.db.enqueueNapcatEvent(bot.id, event('1', ...[1, 2, 3].map(index => `https://example.invalid/${bot.id}/${index}`)), bot.id);
  }
  await until(() => active === 4);
  assert.ok([...perBot.values()].filter(count => count > 0).length >= 2);
  const deadline = Date.now() + 3000;
  while (bots.some(bot => f.db.images.list(bot.id).some(image => image.status === 'pending'))) {
    assert.ok(Date.now() < deadline, 'bounded downloads did not finish');
    while (releases.length) releases.shift()!();
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(maximum, 4);
  assert.ok([...maximumPerBot.values()].every(value => value <= 2));
  assert.ok(bots.every(bot => f.db.images.list(bot.id).length === 3));
});

test('proxy failures terminate as media failures and never retry the source directly', async t => {
  let directRequests = 0;
  const server = createServer((_request, response) => { directRequests++; response.end(png); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const f = await fixture(t, undefined as unknown as typeof globalThis.fetch, {
    proxyEnabled: true, proxyUrl: 'http://127.0.0.1:1', proxyNoProxy: '', imageTimeout: 1,
  });
  f.db.enqueueNapcatEvent(f.bot.id, event('1', `http://127.0.0.1:${address.port}/synthetic-photo`), 'one');
  await until(() => f.db.images.list(f.bot.id)[0]?.status === 'failed');
  const image = f.db.images.list(f.bot.id)[0]!;
  assert.equal(image.error, '图片读取失败');
  assert.equal(image.sha256, undefined);
  assert.equal(directRequests, 0);
});

test('closing Console cancels downloads, preserves pending jobs, and stops background work', async t => {
  let started = false;
  const f = await fixture(t, async (_input, init) => {
    started = true;
    await new Promise<void>((_resolve, reject) => {
      if (init?.signal?.aborted) reject(init.signal.reason);
      else init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    });
    throw new Error('cancelled');
  });
  f.db.enqueueNapcatEvent(f.bot.id, event('1', 'https://example.invalid/pending'), 'one');
  await until(() => started);
  await f.prefetch.close();
  assert.equal(f.db.images.list(f.bot.id)[0]!.status, 'pending');
});

test('image task backlog bounds both queued count and encrypted source bytes independently of message ACKs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nekodock-image-backlog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'console.sqlite3');
  const db = new ConsoleDatabase(path, join(root, 'master.key'));
  t.after(() => db.close());
  const bot = db.createBot({ name: 'Bounded', targetType: 'group', targetId: '1001', config: {} }); db.setDesiredState(bot.id, 'running');
  let rejected = 0;
  db.images.subscribe(event => { rejected += event.rejected; });
  const sources = Array.from({ length: IMAGE_TRANSIT_TASK_LIMITS.count + 2 }, (_, index) => `https://example.invalid/${index}`);
  const images = [];
  for (let offset = 0; offset < sources.length; offset += 32) {
    const messageId = `batch-${offset}`;
    const seq = db.enqueueNapcatEvent(bot.id, event(messageId, ...sources.slice(offset, offset + 32)), messageId)!;
    db.ackNapcatEvents(bot.id, seq);
    images.push(...db.images.forMessage(bot.id, messageId));
  }
  assert.equal(images.filter(image => image.status === 'pending').length, IMAGE_TRANSIT_TASK_LIMITS.count);
  assert.equal(images.filter(image => image.status === 'failed').length, 2);
  assert.equal(rejected, 2);
  const sql = new DatabaseSync(path);
  t.after(() => sql.close());
  const one = images.find(image => image.status === 'pending')!;
  sql.prepare("UPDATE console_incoming_images SET source_cipher=printf('%.*c',?,'x') WHERE id=?").run(IMAGE_TRANSIT_TASK_LIMITS.encryptedSourceBytes, one.id);
  for (const image of images.filter(image => image.status === 'pending').slice(1)) db.images.fail(image.id, '图片读取失败');
  assert.ok(db.enqueueNapcatEvent(bot.id, event('2', 'https://example.invalid/new'), 'two'));
  assert.equal(db.images.forMessage(bot.id, '2')[0]!.status, 'failed');
  assert.equal(db.images.forMessage(bot.id, '2')[0]!.error, '图片下载队列已满');
});

test('lists drain more than one hundred ready and failed attachments without losing the tail', async t => {
  const f = await fixture(t, async () => new Response(png));
  const count = 125;
  const all = [];
  for (let offset = 0; offset < count; offset += 32) {
    const messageId = `batch-${offset}`;
    f.db.enqueueNapcatEvent(f.bot.id, event(messageId, ...Array.from({ length: Math.min(32, count - offset) }, (_, index) => `https://example.invalid/${offset + index}`)), messageId);
    all.push(...f.db.images.forMessage(f.bot.id, messageId));
  }
  // Complete a mixed backlog synchronously so list pagination can be tested independently of downloader timing.
  for (const [index, image] of all.entries()) {
    if (index % 3 === 0) f.db.images.fail(image.id, '图片下载失败');
    else { f.db.images.claim(image.id); f.db.images.complete(image.id, 'a'.repeat(64), 'image/png', png.length); }
  }
  const firstPage = f.db.images.list(f.bot.id);
  assert.equal(firstPage.length, 100);
  const tail = f.db.images.list(f.bot.id, firstPage.at(-1)!.id);
  assert.equal(tail.length, 25, 'unacknowledged first page must not block the rest of the backlog');
  assert.ok(tail.every(image => !firstPage.some(previous => previous.id === image.id)));
  assert.equal(f.db.images.list(f.bot.id, 'unknown-cursor').length, 100);
  let drained = 0;
  while (f.db.images.list(f.bot.id).length) {
    const page = f.db.images.list(f.bot.id); assert.ok(page.length <= 100);
    for (const image of page) { f.db.images.acknowledge(f.bot.id, image.id, image.sha256); drained++; }
  }
  assert.equal(drained, count);
});
