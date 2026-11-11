import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { WorkerIncomingImages, type WorkerIncomingImageOptions } from '../src/incoming-image-cache.js';
import type { IncomingImageDescriptor, IncomingImageRemote } from '../src/incoming-image-contract.js';
import type { StoredMessage } from '../src/types.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ioAAAAASUVORK5CYII=', 'base64');
const sha256 = createHash('sha256').update(png).digest('hex');
const logger = { info() {}, warn() {}, error() {} };
const signal = () => new AbortController().signal;
const message = (id = '1', sources = ['https://image.invalid/snapshot?credential=private']): StoredMessage => ({
  seq: Number(id), messageId: id, senderId: '1001', senderName: 'Example', time: 0, text: '[图片]', replyTo: null, trigger: false,
  rawJson: JSON.stringify({ message: sources.map(url => ({ type: 'image', data: { url } })) }),
});

async function fixture(t: TestContext, overrides: Partial<WorkerIncomingImageOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'incoming-image-cache-'));
  const options: WorkerIncomingImageOptions = {
    dbPath: join(root, 'bridge.sqlite3'), workspace: join(root, 'workspace'), maxBytes: 1024,
    timeoutMs: 300, cacheDays: 30, cacheMaxBytes: 1024, logger, ...overrides,
  };
  const cache = new WorkerIncomingImages(options);
  t.after(async () => { await cache.close(); await rm(root, { recursive: true, force: true }); });
  return { root, options, cache };
}

async function until(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Expected media state was not reached.');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function remoteFixture(overrides: Partial<IncomingImageRemote> = {}) {
  let transferred = false, contentReads = 0, acknowledgements = 0;
  const descriptor: IncomingImageDescriptor = { id: 'remote-image', messageId: '1', index: 0, status: 'ready', sha256, size: png.length, mimeType: 'image/png' };
  const remote: IncomingImageRemote = {
    async list() { return transferred ? [] : [descriptor]; },
    async get() { return descriptor; },
    async content() { contentReads++; return png; },
    async acknowledge(id, digest) { assert.equal(id, descriptor.id); assert.equal(digest, sha256); acknowledgements++; transferred = true; },
    ...overrides,
  };
  return { descriptor, remote, contentReads: () => contentReads, acknowledgements: () => acknowledgements };
}

test('an untriggered image is cached immediately and remains available after its URL expires', async t => {
  let expired = false, requests = 0;
  const { cache, options } = await fixture(t, { fetch: async () => { requests++; return expired ? new Response('', { status: 403 }) : new Response(png); } });
  cache.start();
  const incoming = message();
  cache.register(incoming);
  await until(() => cache.lookup('1')[0]?.status === 'ready');
  expired = true;
  const prepared = await cache.prepare([incoming], signal());
  assert.equal(requests, 1);
  assert.equal(prepared.files.length, 1);
  assert.deepEqual(await readFile(prepared.files[0]!), png);
  assert.equal(prepared.byMessageId.get('1')![0]!.path, join(options.workspace, '.qq-images', `${sha256}.png`));
  assert.doesNotMatch(JSON.stringify([...prepared.byMessageId]), /credential|image.invalid|private/);
});

test('cached mappings survive restart and duplicate events do not redownload content', async t => {
  let requests = 0;
  const { cache, options } = await fixture(t, { fetch: async () => { requests++; return new Response(png); } });
  cache.start(); cache.register(message()); cache.register(message());
  await until(() => cache.lookup('1')[0]?.status === 'ready');
  await cache.close();
  const restored = new WorkerIncomingImages({ ...options, fetch: async () => { throw new Error('Expired URL must never be accessed.'); } });
  t.after(() => restored.close());
  restored.start();
  assert.equal((await restored.prepare([message()], signal())).files.length, 1);
  assert.equal(requests, 1);
});

test('managed ingress waits for Console descriptors without using the authenticated source URL', async t => {
  let descriptors: IncomingImageDescriptor[] = [], rawReads = 0;
  const fixtureRemote = remoteFixture({ async list() { return descriptors; } });
  const { cache } = await fixture(t, { remote: fixtureRemote.remote, fetch: async () => { rawReads++; throw new Error('Raw fetch forbidden.'); } });
  cache.start(); cache.register(message(), []);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(rawReads, 0);
  descriptors = [fixtureRemote.descriptor];
  const result = await cache.prepare([message()], signal());
  assert.equal(result.files.length, 1);
  await until(() => fixtureRemote.acknowledgements() === 1);
  assert.equal(rawReads, 0);
  assert.equal(fixtureRemote.contentReads(), 1);
});

test('Console descriptors arriving before the text message retain stable attachment identities', async t => {
  const remote = remoteFixture();
  const { cache } = await fixture(t, { remote: remote.remote });
  cache.start();
  await until(() => cache.lookup('1')[0]?.status === 'ready');
  cache.register(message(), [remote.descriptor]);
  assert.equal(cache.lookup('1')[0]!.attachmentId, 'remote-image');
  const prepared = await cache.prepare([message()], signal());
  assert.equal(prepared.files.length, 1);
  assert.equal(remote.contentReads(), 1);
});

test('nested forwarded images retain their Console asset identity and source position after restart',async t=>{
  const remote=remoteFixture();
  remote.descriptor.sourceKey='0/1/2/0/3';
  const incoming={...message(),text:'[聊天记录]',rawJson:JSON.stringify({message:[{type:'forward',data:{id:'synthetic-resource'}}]})};
  const {cache,options}=await fixture(t,{remote:remote.remote});
  cache.start();cache.register(incoming,[remote.descriptor]);
  await until(()=>cache.lookup('1')[0]?.status==='ready');
  assert.equal(cache.lookup('1')[0]!.attachmentId,'remote-image');
  assert.equal(cache.lookup('1')[0]!.sourceKey,'0/1/2/0/3');
  assert.doesNotMatch(JSON.stringify(cache.lookup('1')),/credential|image.invalid/);
  await cache.close();
  const restored=new WorkerIncomingImages({...options,remote:{...remote.remote,async list(){return [];}}});
  t.after(()=>restored.close());restored.start();
  const result=await restored.prepare([incoming],signal());
  assert.equal(result.files.length,1);assert.equal(result.byMessageId.get('1')![0]!.attachmentId,'remote-image');
  assert.equal(result.byMessageId.get('1')![0]!.sourceKey,'0/1/2/0/3');
  assert.equal(remote.contentReads(),1);
});

test('a failed media ACK retries after restart without downloading or losing the saved image', async t => {
  let allowAck = false, attempts = 0;
  const remote = remoteFixture({ async acknowledge(_id, digest) { attempts++; assert.equal(digest, sha256); if (!allowAck) throw new Error('Offline'); } });
  const { cache, options } = await fixture(t, { remote: remote.remote });
  cache.start(); cache.register(message(), [remote.descriptor]);
  await until(() => cache.lookup('1')[0]?.status === 'ready' && attempts > 0);
  await cache.close();
  allowAck = true;
  const restored = new WorkerIncomingImages({ ...options, remote: { ...remote.remote, async list() { return []; } } });
  t.after(() => restored.close()); restored.start();
  await until(() => attempts > 1, 4000);
  assert.equal(remote.contentReads(), 1);
  assert.equal((await restored.prepare([message()], signal())).files.length, 1);
});

test('different managed messages share verified content and retain independent attachment ACKs', async t => {
  const descriptors: IncomingImageDescriptor[] = ['1', '2', '3'].map(messageId => ({id: `remote-${messageId}`, messageId, index: 0, status: 'ready', sha256, size: png.length, mimeType: 'image/png'}));
  const acknowledged = new Set<string>(), logs: string[] = [];
  let reads = 0;
  const {cache} = await fixture(t, {logger: {info: s => logs.push(s), warn() {}, error() {}}, remote: {
    async list() { return []; },
    async get(id) { return descriptors.find(d => d.id === id)!; },
    async content() { reads++; await new Promise(resolve => setTimeout(resolve, 20)); return png; },
    async acknowledge(id, digest) { assert.equal(digest, sha256); acknowledged.add(id); },
  }});
  cache.start();
  cache.register(message('1'), [descriptors[0]!]);
  await until(() => acknowledged.has('remote-1'));
  const path = cache.lookup('1')[0]!.path!, previous = new Date('2025-01-01T00:00:00Z');
  await utimes(path, previous, previous);
  cache.register(message('2'), [descriptors[1]!]);
  cache.register(message('3'), [descriptors[2]!]);
  await until(() => acknowledged.size === 3);
  assert.equal(reads, 1);
  assert.equal((await stat(path)).mtimeMs, previous.getTime());
  assert.deepEqual(['1', '2', '3'].map(id => cache.lookup(id)[0]!.path), [path, path, path]);
  assert.deepEqual(['1', '2', '3'].map(id => cache.lookup(id)[0]!.attachmentId), descriptors.map(d => d.id));
  assert.equal(logs.filter(s => s.startsWith('image.cache.started ')).length, 1);
  assert.equal(logs.filter(s => s.startsWith('image.cache.hit ')).length, 2);
});

test('simultaneous managed messages download shared content once and cache damage is repaired on the next message', async t => {
  const descriptors: IncomingImageDescriptor[] = ['1', '2', '3', '4'].map(messageId => ({id: `remote-${messageId}`, messageId, index: 0, status: 'ready', sha256, size: png.length, mimeType: 'image/png'}));
  const acknowledged = new Set<string>(); let reads = 0;
  const {cache} = await fixture(t, {remote: {
    async list() { return []; }, async get(id) { return descriptors.find(d => d.id === id)!; },
    async content() { reads++; await new Promise(resolve => setTimeout(resolve, 20)); return png; },
    async acknowledge(id) { acknowledged.add(id); },
  }});
  cache.start();
  cache.register(message('1'), [descriptors[0]!]); cache.register(message('2'), [descriptors[1]!]);
  await until(() => acknowledged.size === 2);
  assert.equal(reads, 1);
  const path = cache.lookup('1')[0]!.path!;
  await writeFile(path, Buffer.alloc(png.length));
  cache.register(message('3'), [descriptors[2]!]); await until(() => acknowledged.has('remote-3'));
  assert.equal(reads, 2); assert.deepEqual(await readFile(path), png);
  await rm(path);
  cache.register(message('4'), [descriptors[3]!]); await until(() => acknowledged.has('remote-4'));
  assert.equal(reads, 3); assert.deepEqual(await readFile(path), png);
});

test('waiting for managed descriptors does not log a content download', async t => {
  const logs: string[] = [];
  const {cache} = await fixture(t, {logger: {info: s => logs.push(s), warn() {}, error() {}}, remote: {
    async list() { return []; }, async get() { throw new Error('No descriptor'); }, async content() { throw new Error('No content'); }, async acknowledge() {},
  }});
  cache.start(); cache.register(message(), []);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(logs.filter(s => s.startsWith('image.cache.started ')).length, 0);
});

test('Worker content reuse distinguishes different hashes and never crosses instance workspaces', async t => {
  const other = Buffer.concat([png, Buffer.from('different-synthetic-picture')]);
  const descriptors: IncomingImageDescriptor[] = [{id: 'shared-id', messageId: '1', index: 0, status: 'ready', sha256, mimeType: 'image/png', size: png.length},
    {id: 'different-id', messageId: '2', index: 0, status: 'ready', sha256: createHash('sha256').update(other).digest('hex'), mimeType: 'image/png', size: other.length}];
  const reads = [0, 0], acks = [0, 0];
  const caches = await Promise.all([0, 1].map(async index => fixture(t, {remote: {
    async list() { return []; }, async get(id) { return descriptors.find(d => d.id === id)!; },
    async content(id) { reads[index] = (reads[index] ?? 0) + 1; return id === 'different-id' ? other : png; }, async acknowledge() { acks[index] = (acks[index] ?? 0) + 1; },
  }})));
  for (const {cache} of caches) { cache.start(); cache.register(message('1'), [descriptors[0]!]); }
  await until(() => acks.every(n => n === 1));
  assert.deepEqual(reads, [1, 1]);
  assert.notEqual(caches[0]!.cache.lookup('1')[0]!.path, caches[1]!.cache.lookup('1')[0]!.path);
  caches[0]!.cache.register(message('2'), [descriptors[1]!]);
  await until(() => acks[0] === 2);
  assert.deepEqual(reads, [2, 1]);
  assert.deepEqual(await readFile(caches[0]!.cache.lookup('2')[0]!.path!), other);
});

test('content hash mismatch does not acknowledge a Console snapshot or expose response details', async t => {
  let acked = 0;
  const remote = remoteFixture({ async content() { return Buffer.concat([png, Buffer.from('secret-body')]); }, async acknowledge() { acked++; } });
  const logs: string[] = [];
  const { cache } = await fixture(t, { remote: remote.remote, logger: { info: line => logs.push(line), warn: line => logs.push(line), error: line => logs.push(line) } });
  cache.start(); cache.register(message(), [remote.descriptor]);
  const prepared = await cache.prepare([message()], signal());
  assert.equal(prepared.files.length, 0);
  assert.equal(prepared.byMessageId.get('1')![0]!.error, '图片内容校验失败');
  assert.equal(acked, 0);
  assert.doesNotMatch(logs.join('\n'), /secret-body|credential|image.invalid/);
});

test('pending media use a single batch wait budget and caller cancellation still propagates', async t => {
  const { cache } = await fixture(t, { timeoutMs: 80, remote: {
    async list() { await new Promise(resolve => setTimeout(resolve, 300)); return []; },
    async get() { throw new Error('Offline'); }, async content() { throw new Error('Offline'); }, async acknowledge() {},
  } });
  cache.start();
  const images = message('1', ['https://image.invalid/a', 'https://image.invalid/b', 'https://image.invalid/c']);
  cache.register(images, []);
  const started = Date.now();
  const result = await cache.prepare([images], signal());
  assert.equal(result.files.length, 0);
  assert.equal(result.byMessageId.get('1')!.length, 3);
  assert.ok(Date.now() - started < 220, 'Three images must not multiply the wait budget.');
  const aborted = new AbortController(); aborted.abort(new Error('cancelled by caller'));
  await assert.rejects(cache.prepare([images], aborted.signal), /cancelled by caller/);
});

test('unconsumed images are protected against quota eviction and consumed images can be evicted', async t => {
  const other = Buffer.concat([png, Buffer.from('different-content')]);
  const { cache } = await fixture(t, { cacheMaxBytes: png.length + 5, fetch: async input => new Response(String(input).includes('second') ? other : png) });
  cache.start(); cache.register(message('1'));
  await until(() => cache.lookup('1')[0]?.status === 'ready');
  cache.register(message('2', ['https://image.invalid/second']));
  await until(() => cache.lookup('2')[0]?.status === 'failed');
  assert.equal(cache.lookup('2')[0]!.error, '图片缓存空间不足');
  assert.equal(cache.lookup('1')[0]!.status, 'ready');
  await cache.prepare([message('1')], signal());
  await cache.cleanup(Date.now() + 31 * 86400_000);
  assert.equal(cache.lookup('1')[0]!.status, 'expired');
});

test('retained turn files remain protected through cleanup after prepare returns', async t => {
  const { cache } = await fixture(t, { fetch: async () => new Response(png) });
  cache.start(); cache.register(message());
  await until(() => cache.lookup('1')[0]?.status === 'ready');
  const release = cache.retain(['1']);
  await cache.prepare([message()], signal());
  await cache.cleanup(Date.now() + 31 * 86400_000);
  assert.equal(cache.lookup('1')[0]!.status, 'ready');
  release(); release();
  await cache.cleanup(Date.now() + 31 * 86400_000);
  assert.equal(cache.lookup('1')[0]!.status, 'expired');
});

test('content-addressed files are shared within an instance and survive until all references are releasable', async t => {
  const { cache, options } = await fixture(t, { fetch: async () => new Response(png) });
  cache.start(); cache.register(message('1')); cache.register(message('2'));
  await until(() => cache.lookup('1')[0]?.status === 'ready' && cache.lookup('2')[0]?.status === 'ready');
  assert.deepEqual((await readdir(join(options.workspace, '.qq-images'))).filter(name => !name.endsWith('.tmp')), [`${sha256}.png`]);
  await cache.prepare([message('1')], signal());
  await cache.cleanup(Date.now() + 31 * 86400_000);
  assert.equal(cache.lookup('1')[0]!.status, 'ready');
  await cache.prepare([message('2')], signal());
  await cache.cleanup(Date.now() + 31 * 86400_000);
  assert.equal(cache.lookup('1')[0]!.status, 'expired');
  assert.equal(cache.lookup('2')[0]!.status, 'expired');
});

test('legacy session paths must match their bytes and stay inside the actual cache directory', async t => {
  const { cache, options, root } = await fixture(t);
  const directory = join(options.workspace, '.qq-images'); await mkdir(directory);
  const path = join(directory, `${sha256}.png`); await writeFile(path, png);
  assert.equal(await cache.adoptLegacy('1', 0, path, signal()), true);
  assert.equal(await cache.adoptLegacy('1', 0, path, signal()), true);
  const prepared = await cache.prepare([message()], signal()); assert.equal(prepared.files.length, 1);
  const outside = join(root, 'outside.png'); await writeFile(outside, png);
  assert.equal(await cache.adoptLegacy('2', 0, outside, signal()), false);
  const falsePath = join(directory, `${'0'.repeat(64)}.png`); await writeFile(falsePath, png);
  assert.equal(await cache.adoptLegacy('2', 0, falsePath, signal()), false);
  const link = join(directory, `${'1'.repeat(64)}.png`); await symlink(path, link);
  assert.equal(await cache.adoptLegacy('2', 0, link, signal()), false);
});

test('corrupted saved bytes are marked unavailable instead of being passed to the model', async t => {
  const { cache } = await fixture(t, { fetch: async () => new Response(png) });
  cache.start(); cache.register(message());
  await until(() => cache.lookup('1')[0]?.status === 'ready');
  await writeFile(cache.lookup('1')[0]!.path!, Buffer.from('not-an-image'));
  const prepared = await cache.prepare([message()], signal());
  assert.equal(prepared.files.length, 0);
  assert.equal(prepared.byMessageId.get('1')![0]!.status, 'failed');
});

test('one failed image does not hide a successful image and failures retain no signed URL', async t => {
  const { cache } = await fixture(t, { fetch: async input => String(input).includes('/bad') ? new Response('private response', { status: 403 }) : new Response(png) });
  cache.start();
  const incoming = message('1', ['https://image.invalid/bad?credential=private', 'https://image.invalid/good?credential=private']);
  cache.register(incoming);
  const prepared = await cache.prepare([incoming], signal());
  assert.equal(prepared.files.length, 1);
  assert.deepEqual(prepared.byMessageId.get('1')!.map(image => image.status), ['failed', 'ready']);
  assert.doesNotMatch(JSON.stringify([...prepared.byMessageId]), /private|credential|image.invalid/);
});

test('shutdown leaves interrupted downloads pending for restart rather than recording a false terminal error', async t => {
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const { cache, options } = await fixture(t, { fetch: async (_input, init) => {
    began();
    return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }));
  } });
  cache.start(); cache.register(message()); await started;
  await cache.close();
  const restored = new WorkerIncomingImages({ ...options, fetch: async () => new Response(png) });
  t.after(() => restored.close()); restored.start();
  const prepared = await restored.prepare([message()], signal());
  assert.equal(prepared.files.length, 1);
  assert.equal(prepared.byMessageId.get('1')![0]!.status, 'ready');
});

test('remote failure metadata is acknowledged as a terminal outcome without fetching any image bytes', async t => {
  let contentReads = 0, acknowledgements = 0;
  const descriptor: IncomingImageDescriptor = { id: 'failed-image', messageId: '1', index: 0, status: 'failed', error: 'private response token' };
  const { cache } = await fixture(t, { remote: {
    async list() { return [descriptor]; }, async get() { return descriptor; },
    async content() { contentReads++; return png; },
    async acknowledge(id, digest) { assert.equal(id, descriptor.id); assert.equal(digest, undefined); acknowledgements++; },
  } });
  cache.start(); cache.register(message(), [descriptor]);
  await until(() => acknowledgements > 0);
  const prepared = await cache.prepare([message()], signal());
  assert.equal(contentReads, 0);
  assert.equal(prepared.byMessageId.get('1')![0]!.error, '图片读取失败');
});

test('a new-session cursor can release an unconsumed image skipped by the previous conversation', async t => {
  let pending = true;
  const { cache } = await fixture(t, { fetch: async () => new Response(png), isProtected: () => pending });
  cache.start(); cache.register(message());
  await until(() => cache.lookup('1')[0]?.status === 'ready');
  await cache.cleanup(Date.now() + 31 * 86400_000);
  assert.equal(cache.lookup('1')[0]!.status, 'ready');
  // /new advances the source-message cursor without ever passing this image to prepare().
  pending = false;
  await cache.cleanup(Date.now() + 31 * 86400_000);
  assert.equal(cache.lookup('1')[0]!.status, 'expired');
});

test('unchanged image presentations are deduplicated across redelivery, preparation and restart', async t => {
  const updates: string[] = [];
  const { cache, options } = await fixture(t, { fetch: async () => new Response(png), onUpdated: (_id, images) => { updates.push(JSON.stringify(images)); } });
  cache.start(); cache.register(message());
  await until(() => cache.lookup('1')[0]?.status === 'ready');
  const readyCount = updates.length;
  cache.register(message()); cache.register(message());
  await cache.prepare([message()], signal());
  assert.equal(updates.length, readyCount);
  await cache.close();
  const restored = new WorkerIncomingImages(options); t.after(() => restored.close()); restored.start();
  await restored.prepare([message()], signal());
  assert.equal(updates.length, readyCount);
});

test('a descriptor preceding ingress can defer presentation and message registration retries it after commit', async t => {
  let messagePresent = false;
  const published: string[] = [];
  const remote = remoteFixture();
  const { cache, options } = await fixture(t, { remote: remote.remote, onUpdated: (_id, images) => {
    if (!messagePresent) return false;
    // The real presentation recorder uses another connection to the same SQLite file.
    const presentation = new DatabaseSync(options.dbPath);
    try {
      presentation.exec('PRAGMA busy_timeout=20; CREATE TABLE IF NOT EXISTS presentation_probe(value TEXT)');
      presentation.prepare('INSERT INTO presentation_probe(value) VALUES(?)').run(JSON.stringify(images));
    } finally { presentation.close(); }
    published.push(JSON.stringify(images));
    return true;
  } });
  cache.start();
  await until(() => cache.lookup('1')[0]?.status === 'ready');
  assert.equal(published.length, 0);
  messagePresent = true;
  cache.register(message(), [{ ...remote.descriptor, status: 'failed', error: '图片下载失败' }]);
  assert.equal(published.length, 1);
  assert.equal(JSON.parse(published[0]!)[0].status, 'ready');
});

test('terminal descriptors publish only after attachment registration commits', async t => {
  let publications = 0;
  const { cache, options } = await fixture(t, { onUpdated: () => {
    const recorder = new DatabaseSync(options.dbPath);
    try { recorder.exec('PRAGMA busy_timeout=20; CREATE TABLE presentation_commit_probe(value INTEGER)'); }
    finally { recorder.close(); }
    publications++;
  } });
  cache.register(message(), [{ id: 'terminal-image', messageId: '1', index: 0, status: 'failed', error: '图片下载失败' }]);
  assert.equal(publications, 1);
  assert.equal(cache.lookup('1')[0]!.status, 'failed');
});

test('startup recovers a committed ready attachment whose presentation was never published', async t => {
  const { cache, options } = await fixture(t, { fetch: async () => new Response(png), onUpdated: () => false });
  cache.start(); cache.register(message());
  await until(() => cache.lookup('1')[0]?.status === 'ready');
  await cache.close();
  const recovered: string[] = [];
  const restored = new WorkerIncomingImages({ ...options, onUpdated: (_id, images) => { recovered.push(JSON.stringify(images)); return true; } });
  t.after(() => restored.close()); restored.start();
  await until(() => recovered.length === 1);
  assert.equal(JSON.parse(recovered[0]!)[0].status, 'ready');
  restored.register(message());
  await restored.prepare([message()], signal());
  assert.equal(recovered.length, 1);
});
