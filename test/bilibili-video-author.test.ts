import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareVideoAuthor } from '../src/plugins/bilibili/video-author.js';
import { executeBilibiliJob } from '../src/plugins/bilibili/runner.js';
import { normalizeBilibiliResource } from '../src/plugins/bilibili/recognize.js';
import { BILIBILI_DEFAULTS } from '../src/plugins/bilibili/config.js';
import { pluginSourceImageIds } from '../src/plugin-images.js';
import type { PluginContent, PluginRunnerJob } from '../src/plugin-system/contracts.js';

const avatarUrl = 'https://i2.hdslb.com/bfs/face/synthetic-avatar.jpg';
const resource = normalizeBilibiliResource('https://www.bilibili.com/video/BV1234567890?p=2')!;
const content = (): PluginContent => ({ type: 'video', platform: 'bilibili', resourceId: resource.id, url: resource.url,
  part: 2, title: 'Synthetic video', author: 'Extracted author', authorId: '2001', retrieval: { status: 'ready' } });
const signal = () => new AbortController().signal;
const owner = () => ({ mid: 2001, name: 'Synthetic video owner', face: avatarUrl });
const response = (data: unknown) => new Response(JSON.stringify({ code: 0, data }));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1sAAAAASUVORK5CYII=', 'base64');

test('video card author comes from the video owner and preserves the selected part', async () => {
  let reads = 0;
  const result = await prepareVideoAuthor(content(), resource, async (input, options) => {
    reads++; assert.equal(String(input), 'https://api.bilibili.com/x/web-interface/view?bvid=BV1234567890');
    assert.equal(options?.redirect, 'error'); assert.equal(new Headers(options?.headers).get('cookie'), 'SESSDATA=synthetic-cookie');
    return response({ owner: owner(), staff: [{ mid: 3001, name: 'Another participant', face: 'https://i0.hdslb.com/bfs/face/another.jpg' }] });
  }, signal(), 'SESSDATA=synthetic-cookie');
  assert.equal(reads, 1); assert.equal(result.author, 'Synthetic video owner'); assert.equal(result.authorId, '2001');
  assert.equal(result.url, resource.url); assert.equal(result.part, 2);
  assert.deepEqual(result.authorAvatar, { id: `${resource.id}:avatar`, url: avatarUrl, role: 'avatar', status: 'pending' });
  assert.deepEqual(pluginSourceImageIds([{ ...result, authorAvatar: { ...result.authorAvatar, assetId: 'avatar-one', status: 'ready' } }]), []);
});

test('av links use aid while author metadata already provided can skip the detail request', async () => {
  const av = normalizeBilibiliResource('https://www.bilibili.com/video/av123456?p=3')!;
  const result = await prepareVideoAuthor({ ...content(), resourceId: av.id, url: av.url, part: 3 }, av, async input => {
    assert.equal(String(input), 'https://api.bilibili.com/x/web-interface/view?aid=123456'); return response({ owner: owner() });
  }, signal());
  assert.equal(result.authorAvatar?.id, `${av.id}:avatar`); assert.equal(result.part, 3);
  const existing = { ...content(), authorAvatar: { id: 'existing-avatar', url: avatarUrl, role: 'avatar' as const, status: 'pending' as const } };
  assert.equal(await prepareVideoAuthor(existing, resource, async () => assert.fail('Known avatar must not trigger another detail request'), signal()), existing);
});

test('missing and untrusted video avatars do not become image assets', async () => {
  for (const face of [undefined, '', 'file:///private/avatar.jpg', 'https://127.0.0.1/avatar', 'https://i0.hdslb.com:8443/avatar.jpg', 'https://example.invalid/avatar.jpg']) {
    const result = await prepareVideoAuthor(content(), resource, async () => response({ owner: { ...owner(), face } }), signal());
    assert.equal(result.authorAvatar, undefined); assert.equal(result.author, 'Synthetic video owner');
    assert.equal(result.retrieval.status, 'ready');
  }
  const original = content();
  assert.equal(await prepareVideoAuthor(original, resource, async () => response({ owner: { ...owner(), mid: 3001 } }), signal()), original,
    'An unrelated owner cannot replace the known uploader');
  assert.equal(await prepareVideoAuthor(original, resource, async () => response({ staff: [owner()] }), signal()), original);
});

test('optional author HTTP, platform and parsing failures preserve the usable video data', async () => {
  const original = content();
  for (const reply of [() => new Response(null, { status: 412 }), () => new Response(null, { status: 500 }),
    () => new Response(JSON.stringify({ code: -403 })), () => new Response('not json')]) {
    assert.equal(await prepareVideoAuthor(original, resource, async () => reply(), signal()), original);
  }
  assert.equal(await prepareVideoAuthor(original, resource, async () => { throw new Error('synthetic network failure'); }, signal()), original);
});

test('an optional author timeout settles independently while a cancelled video task still aborts', async () => {
  const original = content(); let timedOut = false;
  const result = await prepareVideoAuthor(original, resource, async (_input, options) => await new Promise<Response>((_resolve, reject) => {
    const guard = setTimeout(() => reject(new Error('Abort did not reach the request')), 5000);
    options!.signal!.addEventListener('abort', () => { clearTimeout(guard); timedOut = true; reject(options!.signal!.reason); }, { once: true });
  }), signal());
  assert.equal(timedOut, true); assert.equal(result, original);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(prepareVideoAuthor(original, resource, async () => assert.fail('Cancelled task must not request author data'), controller.signal));
  const active = new AbortController();
  await assert.rejects(prepareVideoAuthor(original, resource, async (_input, options) => {
    active.abort(new Error('Synthetic task cancellation')); options!.signal!.throwIfAborted();
    return response({ owner: owner() });
  }, active.signal), /Synthetic task cancellation/u, 'A parent cancellation during lookup must not become a missing-avatar fallback');
});

test('video resolve stores uploader identity without doing the optional author request', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bili-author-resolve-')); t.after(() => rm(root, { recursive: true, force: true }));
  const job: PluginRunnerJob = { id: 'job', lease: 'lease', botId: 'synthetic-bot', pluginId: 'bilibili', operation: 'resolve', resource,
    command: 'share', config: { ...BILIBILI_DEFAULTS, subtitles: false, videoDisplay: 'card' },
    networkProxy: { enabled: false, url: '', noProxy: '', forTools: true }, expiresAt: Date.now() + 60000 };
  const result = await executeBilibiliJob(job, root, signal(), { fetch: async () => assert.fail('Resolve cannot wait for optional author metadata'),
    run: async () => JSON.stringify({ title: 'Synthetic video', uploader: 'Extracted author', uploader_id: 2001, webpage_url: resource.url }) });
  try { assert.equal(result.content?.authorId, '2001'); assert.equal(result.content?.authorAvatar, undefined); }
  finally { await result.cleanup(); }
});

test('video prepare obtains and downloads the avatar before drawing the shared author header', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bili-author-prepare-')); t.after(() => rm(root, { recursive: true, force: true }));
  const job: PluginRunnerJob = { id: 'job', lease: 'lease', botId: 'synthetic-bot', pluginId: 'bilibili', operation: 'prepare', resource,
    command: 'share', config: { ...BILIBILI_DEFAULTS, videoDisplay: 'card' }, content: content(), presentation: { mode: 'card', provideContext: true },
    networkProxy: { enabled: false, url: '', noProxy: '', forTools: true }, expiresAt: Date.now() + 60000 };
  const requests: string[] = [];
  const result = await executeBilibiliJob(job, root, signal(), { fetch: async input => {
    requests.push(String(input)); return String(input).startsWith('https://api.bilibili.com/') ? response({ owner: owner() }) : new Response(png);
  }, run: async (_command, args, options) => {
    if (args[1] === 'inspect') return '{"width":1,"height":1}';
    const request = JSON.parse(await readFile(args[2]!, 'utf8'));
    assert.equal(request.content.authorAvatar.status, 'ready'); assert.ok(request.paths[request.content.authorAvatar.assetKey]);
    await writeFile(join(options.cwd, 'card-0.png'), png); return '{"files":["card-0.png"]}';
  } });
  try {
    assert.equal(requests.length, 2); assert.equal(requests[1], avatarUrl);
    assert.equal(result.content?.authorAvatar?.status, 'ready'); assert.equal(result.files?.[0]?.role, 'avatar');
    assert.equal(result.outputs?.[0]?.assetRole, 'presentation'); assert.deepEqual(pluginSourceImageIds([result.content]), []);
  } finally { await result.cleanup(); }
  const none = await executeBilibiliJob({ ...job, presentation: { mode: 'none', provideContext: true } }, root, signal(),
    { fetch: async () => assert.fail('Context-only preparation does not fetch an avatar'), run: async () => assert.fail('No source images to inspect') });
  await none.cleanup();
});
