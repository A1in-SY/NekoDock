import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import test, { type TestContext } from 'node:test';
import { defaultNetworkProxy } from '../src/network.js';
import { pluginSourceImageIds } from '../src/plugin-images.js';
import { renderLimited } from '../src/plugin-render.js';
import { contentPlugin } from '../src/plugin-system/registry.js';
import type { PluginContent, PluginRunnerJob } from '../src/plugin-system/contracts.js';
import { createDouyinState, parseDouyinInfo } from '../src/plugins/douyin/api.js';
import { DOUYIN_DEFAULTS, validateDouyinConfig } from '../src/plugins/douyin/config.js';
import { validateDouyinContent } from '../src/plugins/douyin/content.js';
import { normalizeDouyinResource } from '../src/plugins/douyin/recognize.js';
import { executeDouyinJob, type DouyinTools } from '../src/plugins/douyin/runner.js';

const id = '1000000000000000001', resource = normalizeDouyinResource(`https://www.douyin.com/video/${id}`)!;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=', 'base64');
const cover = 'https://p1.douyinpic.com/cover.png?x-signature=synthetic-cover';
const avatar = 'https://p3.douyinpic.com/avatar.png?x-signature=synthetic-avatar';
const item = (): Record<string, any> => ({ aweme_id: id, aweme_type: 0, desc: 'Synthetic caption #topic', create_time: 1700000000,
  author: { uid: '12345', nickname: 'Synthetic author', avatar_larger: { url_list: [avatar] } },
  video: { duration: 12000, play_addr: { uri: 'synthetic_video' }, cover: { url_list: [cover] } } });
const router = (value = item()) => ({ loaderData: { page: { videoInfoRes: { item_list: [value] } } } });
const content = () => parseDouyinInfo(router(), id).content;
const plugin = contentPlugin('douyin');

async function fixture(t: TestContext, options: {
  content?: PluginContent; source?: Record<string, any>; rejectMetadata?: boolean;
  media?: (url: URL, init?: RequestInit) => Response; render?: (request: any, path: string) => Promise<string>;
  inspect?: () => string; controller?: AbortController;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'nekodock-douyin-card-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requests: Array<{ url: URL; init?: RequestInit }> = [], rendered: any[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); requests.push({ url, init });
    if (url.hostname === 'ttwid.bytedance.com') {
      return Response.json({ status_code: 0 }, { headers: { 'set-cookie': 'ttwid=synthetic-guest; Max-Age=600; Secure; HttpOnly' } });
    }
    if (url.pathname.startsWith('/share/video/')) return options.rejectMetadata ? new Response('empty')
      : new Response(`<script>window._ROUTER_DATA = ${JSON.stringify(router(options.source))};</script>`);
    assert.equal(new Headers(init?.headers).has('cookie'), false);
    return options.media?.(url, init) ?? new Response(png);
  };
  const run: NonNullable<DouyinTools['run']> = async (command, args) => {
    assert.equal(command, 'python3'); assert.match(args[0]!, /douyin\/render\/card\.py$/u);
    if (args[1] === 'inspect') return options.inspect?.() ?? JSON.stringify({ width: 1, height: 1 });
    assert.equal(args[1], 'render');
    const request = JSON.parse(await readFile(args[2]!, 'utf8')); rendered.push(request);
    assert.equal(request.maxPages, 1); assert.doesNotMatch(JSON.stringify(request), /x-signature|ttwid=|synthetic-guest/u);
    if (options.render) return options.render(request, args[2]!);
    await writeFile(join(root, args[2]!.split('/').at(-2)!, 'card-0.png'), png);
    return JSON.stringify({ files: ['card-0.png'] });
  };
  const job: PluginRunnerJob = { id: 'synthetic-job', lease: 'synthetic-lease', botId: 'synthetic-bot', pluginId: 'douyin', operation: 'prepare',
    resource, content: options.content ?? content(), config: { videoDisplay: 'card' }, presentation: { mode: 'card', provideContext: true },
    networkProxy: defaultNetworkProxy(), expiresAt: Date.now() + 60000 };
  const signal = options.controller?.signal ?? new AbortController().signal;
  const execute = (patch: Partial<PluginRunnerJob> = {}) => executeDouyinJob({ ...job, ...patch }, root, signal, { fetch: fetcher, run, state: createDouyinState() });
  return { root, job, requests, rendered, execute };
}

test('old Douyin settings acquire a disabled display mode and unsupported values are rejected', () => {
  const previous = { ...DOUYIN_DEFAULTS }; delete (previous as Record<string, unknown>).videoDisplay;
  assert.equal(validateDouyinConfig(previous).videoDisplay, 'off');
  assert.equal(validateDouyinConfig({}, previous).videoDisplay, 'off');
  assert.equal(validateDouyinConfig({ videoDisplay: 'card' }).videoDisplay, 'card');
  for (const value of ['original', 'screenshot', '', true, null]) assert.throws(() => validateDouyinConfig({ videoDisplay: value }));
});

test('automatic cards independently process direct and short shares without enrichment or video downloads', () => {
  const disabled = { ...DOUYIN_DEFAULTS, enhance: false, autoVideo: false };
  assert.equal(plugin.shouldProcess(disabled, resource), false);
  for (const source of [resource, normalizeDouyinResource('https://v.douyin.com/Synthetic/')!]) {
    assert.equal(plugin.shouldProcess({ ...disabled, videoDisplay: 'card' }, source), true);
  }
  for (const enhance of [false, true]) for (const autoVideo of [false, true]) for (const videoDisplay of ['off', 'card']) {
    const next = plugin.afterResolve('share', resource, { ...DOUYIN_DEFAULTS, enhance, autoVideo, videoDisplay }, content());
    assert.equal(next.provideContext, enhance); assert.equal(Boolean(next.download), autoVideo);
    assert.deepEqual(next.prepare, videoDisplay === 'card' ? { mode: 'card', provideContext: enhance }
      : enhance ? { mode: 'none', provideContext: true } : undefined);
  }
  for (const durationSeconds of [undefined, 0, 301]) {
    const next = plugin.afterResolve('share', resource, { ...DOUYIN_DEFAULTS, videoDisplay: 'card' }, { ...content(), durationSeconds });
    assert.equal(next.download, undefined); assert.equal(next.prepare?.mode, 'card');
  }
});

test('the same SSR response supplies a canonical author avatar without exposing signatures or raw fields', () => {
  const info = parseDouyinInfo(router(), id);
  assert.equal(info.avatars[0], avatar);
  assert.deepEqual(info.content.authorAvatar, { id: `${resource.id}:avatar`, role: 'avatar', url: 'https://p3.douyinpic.com/avatar.png', status: 'pending' });
  const validated = validateDouyinContent({ ...info.content, authorAvatar: { ...info.content.authorAvatar, url: avatar, ttwid: 'synthetic-visitor' } }, resource);
  assert.equal(validated.authorAvatar?.url, 'https://p3.douyinpic.com/avatar.png');
  assert.doesNotMatch(JSON.stringify(validated), /x-signature|synthetic-visitor/u);
  for (const authorAvatar of [
    { ...info.content.authorAvatar, id: 'wrong:avatar' },
    { ...info.content.authorAvatar, role: 'content' },
    { ...info.content.authorAvatar, url: 'https://127.0.0.1/private' },
    { ...info.content.authorAvatar, url: 'https://douyinpic.com.evil.invalid/avatar.png' },
  ]) assert.equal(validateDouyinContent({ ...info.content, authorAvatar }, resource).authorAvatar, undefined);
});

test('avatar selection skips unsafe candidates and does not require extra metadata requests', async t => {
  const source = item(); source.author.avatar_larger.url_list = ['http://p3.douyinpic.com/unsafe', 'https://untrusted.invalid/avatar'];
  source.author.avatar_medium = { url_list: [avatar] };
  const f = await fixture(t, { source });
  const result = await f.execute({ operation: 'resolve', content: undefined, presentation: undefined });
  try {
    assert.equal(result.content?.authorAvatar?.url, 'https://p3.douyinpic.com/avatar.png');
    assert.equal(f.requests.length, 2); assert.equal(f.rendered.length, 0);
  } finally { await result.cleanup(); }
});

test('a card prepares cover and avatar with signed memory URLs and returns only a presentation image', async t => {
  const f = await fixture(t), result = await f.execute();
  try {
    assert.deepEqual(result.files?.map(file => file.role), ['cover', 'avatar', 'presentation']);
    assert.deepEqual(result.outputs, [{ kind: 'image', assetKey: 'card-0', assetRole: 'presentation' }]);
    assert.equal(result.content?.authorAvatar?.status, 'ready');
    const imageRequests = f.requests.filter(request => request.url.hostname.endsWith('.douyinpic.com'));
    assert.deepEqual(imageRequests.map(request => request.url.toString()), [cover, avatar]);
    assert.equal(f.rendered.length, 1); assert.deepEqual(Object.keys(f.rendered[0].paths), ['cover', 'avatar']);
    assert.deepEqual(pluginSourceImageIds([result.content]), []);
    assert.doesNotMatch(JSON.stringify(result.content), /x-signature|synthetic-guest/u);
  } finally { await result.cleanup(); }
  assert.deepEqual(await readdir(f.root), []);
});

test('missing or failed decorations retain the usable card and never send standalone covers', async t => {
  for (const missing of [true, false]) {
    const saved = content();
    if (missing) { delete saved.authorAvatar; delete saved.blocks; }
    const source = item(); if (missing) { delete source.author.avatar_larger; delete source.video.cover; }
    const f = await fixture(t, { content: saved, source, media: () => new Response('blocked', { status: 403 }) });
    const result = await f.execute();
    try {
      assert.equal(result.files?.length, 1); assert.equal(result.files?.[0]?.role, 'presentation');
      assert.deepEqual(result.outputs, [{ kind: 'image', assetKey: 'card-0', assetRole: 'presentation' }]);
      assert.deepEqual(f.rendered[0].paths, {});
      if (!missing) assert.equal(result.content?.retrieval.error, 'DOUYIN_IMAGES_PARTIAL');
    } finally { await result.cleanup(); }
  }
});

test('metadata refresh failure still renders saved information instead of discarding the card', async t => {
  const f = await fixture(t, { rejectMetadata: true }), result = await f.execute();
  try { assert.equal(result.content?.title, content().title); assert.equal(result.outputs?.[0]?.kind, 'image'); }
  finally { await result.cleanup(); }
});

test('invalid render results produce one bounded text fallback with no standalone source images', async t => {
  for (const response of ['not-json', '{"files":[]}', '{"files":["../../unsafe.png"]}', '{"files":["card-0.png","card-1.png"]}']) {
    const saved = content(); saved.description = '长'.repeat(12000);
    const f = await fixture(t, { content: saved, render: async () => response }), result = await f.execute();
    try {
      assert.equal(result.outputs?.length, 1); assert.equal(result.outputs?.[0]?.kind, 'reply');
      assert.ok(result.outputs![0]!.text!.length < 1400); assert.match(result.outputs![0]!.text!, /douyin\.com\/video/u);
      assert.equal(result.content?.description?.length, 12000); assert.equal(result.content?.retrieval.error, 'DOUYIN_PRESENTATION_FALLBACK');
      assert.equal(result.files?.some(file => file.role === 'presentation'), false);
    } finally { await result.cleanup(); }
  }
});

test('image byte and pixel limits retain partial text and do not expose unvalidated source files', async t => {
  for (const options of [{ inspect: () => JSON.stringify({ width: 5000, height: 5000 }) }, { inspect: () => JSON.stringify({ width: -1, height: 1 }) },
    { media: () => new Response(Buffer.alloc(8 * 1024 * 1024 + 1)) }]) {
    const f = await fixture(t, options), result = await f.execute();
    try {
      assert.equal(result.files?.length, 1); assert.equal(result.files?.[0]?.role, 'presentation');
      assert.equal(result.content?.retrieval.error, 'DOUYIN_IMAGES_PARTIAL');
    } finally { await result.cleanup(); }
  }
});

test('oversized or invalid rendered files produce a text fallback within the job image limit', async t => {
  for (const bytes of [Buffer.concat([png, Buffer.alloc(100)]), Buffer.alloc(32)]) {
    const f = await fixture(t, { render: async (_request, path) => {
      await writeFile(join(dirname(path), 'card-0.png'), bytes);
      return JSON.stringify({ files: ['card-0.png'] });
    } });
    const result = await f.execute({ imageMaxBytes: 100 });
    try {
      assert.equal(result.outputs?.[0]?.kind, 'reply'); assert.equal(result.outputs?.length, 1);
      assert.equal(result.content?.retrieval.error, 'DOUYIN_PRESENTATION_FALLBACK');
      assert.deepEqual(result.files?.map(file => file.role), ['cover', 'avatar']);
    } finally { await result.cleanup(); }
  }
});

test('cancelling card preparation removes its working directory without returning a fallback', async t => {
  const controller = new AbortController(), f = await fixture(t, { controller, media: () => { controller.abort(); return new Response(png); } });
  await assert.rejects(f.execute(), (error: any) => error.code === 'PLUGIN_CANCELLED');
  assert.deepEqual(await readdir(f.root), []); assert.equal(f.rendered.length, 0);
});

test('the shared rendering budget serializes plugins and a cancelled waiter does not stop the active render', async () => {
  const first = new AbortController(), waiting = new AbortController(), third = new AbortController();
  let release!: () => void, started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const order: string[] = [];
  const active = renderLimited(async () => { order.push('first-start'); started(); await gate; order.push('first-end'); }, first.signal);
  await began;
  const cancelled = assert.rejects(renderLimited(async () => { assert.fail('Cancelled waiter must not render'); }, waiting.signal), { name: 'AbortError' });
  const next = renderLimited(async () => { order.push('third'); }, third.signal);
  waiting.abort(); await cancelled; assert.deepEqual(order, ['first-start']);
  release(); await Promise.all([active, next]); assert.deepEqual(order, ['first-start', 'first-end', 'third']);
});
