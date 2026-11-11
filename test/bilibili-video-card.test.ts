import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BILIBILI_DEFAULTS, validateBilibiliConfig } from '../src/plugins/bilibili/config.js';
import { validatePluginContent } from '../src/plugins/bilibili/content.js';
import { normalizeBilibiliResource } from '../src/plugins/bilibili/recognize.js';
import { executeBilibiliJob } from '../src/plugins/bilibili/runner.js';
import { contentPlugin } from '../src/plugin-system/registry.js';
import { pluginSourceImageIds } from '../src/plugin-images.js';
import type { PluginContent, PluginRunnerJob } from '../src/plugin-system/contracts.js';

const resource = normalizeBilibiliResource('https://www.bilibili.com/video/BV1234567890')!;
const plugin = contentPlugin('bilibili');
const coverUrl = 'https://i0.hdslb.com/bfs/archive/synthetic-cover.jpg';
const signal = () => new AbortController().signal;
const disabled = () => ({ ...BILIBILI_DEFAULTS, enhance: false, autoVideo: false,
  dynamicEnhance: false, dynamicDisplay: 'off' as const, liveEnhance: false, liveDisplay: 'off' as const });
const content = (): PluginContent => ({ type: 'video', platform: 'bilibili', resourceId: resource.id, url: resource.url,
  title: 'Synthetic video', author: 'Synthetic author', durationSeconds: 222, description: 'Synthetic description.',
  publishedAt: 1700000000, part: 1, coverUrl, blocks: [{ type: 'image', image: {
    id: `${resource.id}:cover`, url: coverUrl, role: 'cover', status: 'pending',
  } }], retrieval: { status: 'ready' } });
const job = (): PluginRunnerJob => ({ id: 'synthetic-video-job', lease: 'synthetic-lease', botId: 'synthetic-bot',
  pluginId: 'bilibili', operation: 'resolve', resource, command: 'share', config: { ...disabled(), videoDisplay: 'card', subtitles: false },
  networkProxy: { enabled: false, url: '', noProxy: '', forTools: true }, expiresAt: Date.now() + 60000 });
async function directory(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'nekodock-video-card-core-'));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}

test('old video settings default to no automatic card and only supported modes are accepted', () => {
  const old = { ...BILIBILI_DEFAULTS }; delete (old as Record<string, unknown>).videoDisplay;
  assert.equal(validateBilibiliConfig(old).videoDisplay, 'off');
  assert.equal(validateBilibiliConfig({ videoDisplay: 'card' }).videoDisplay, 'card');
  for (const value of ['original', 'screenshot', '', true, null]) assert.throws(() => validateBilibiliConfig({ videoDisplay: value }));
});

test('video-card-only configuration processes direct and unresolved short shares', () => {
  const settings = disabled(); assert.equal(plugin.shouldProcess(settings, resource), false);
  const card = { ...settings, videoDisplay: 'card' };
  assert.equal(plugin.shouldProcess(card, resource), true);
  assert.equal(plugin.shouldProcess(card, normalizeBilibiliResource('https://b23.tv/Synthetic')!), true);
  assert.equal(plugin.shouldProcess(card), true);
  assert.equal(plugin.shouldProcess(card, normalizeBilibiliResource('https://www.bilibili.com/opus/100001')!), false);
});

test('video cards, contextual enrichment and video download have independent policies', () => {
  for (const enhance of [false, true]) for (const autoVideo of [false, true]) {
    const next = plugin.afterResolve('share', resource, { ...BILIBILI_DEFAULTS, enhance, autoVideo, videoDisplay: 'card' }, content());
    assert.equal(next.provideContext, enhance);
    assert.deepEqual(next.prepare, { mode: 'card', provideContext: enhance });
    assert.equal(Boolean(next.download), autoVideo);
    assert.equal(next.replyText, undefined);
  }
  assert.equal(plugin.afterResolve('share', resource, { ...BILIBILI_DEFAULTS, videoDisplay: 'off' }, content()).prepare, undefined);
});

test('unavailable or excessive duration suppresses download while retaining the automatic card', () => {
  for (const durationSeconds of [undefined, BILIBILI_DEFAULTS.maxDurationSeconds + 1]) {
    const next = plugin.afterResolve('share', resource, { ...BILIBILI_DEFAULTS, autoVideo: true, videoDisplay: 'card' }, { ...content(), durationSeconds });
    assert.equal(next.download, undefined); assert.equal(next.prepare?.mode, 'card');
  }
});

test('explicit video info and download commands do not add automatic cards', () => {
  const settings = { ...BILIBILI_DEFAULTS, enhance: false, autoVideo: true, videoDisplay: 'card' };
  const info = plugin.afterResolve('info', resource, settings, content());
  assert.match(info.replyText ?? '', /Synthetic video/u); assert.equal(info.provideContext, true);
  assert.equal(info.prepare, undefined); assert.equal(info.download, undefined);
  const download = plugin.afterResolve('download', resource, settings, content());
  assert.equal(download.prepare, undefined); assert.equal(download.download?.id, resource.id);
  const tooLong = plugin.afterResolve('download', resource, settings, { ...content(), durationSeconds: 3601 });
  assert.equal(tooLong.prepare, undefined); assert.equal(tooLong.download, undefined); assert.match(tooLong.replyText ?? '', /时长超过/u);
});

test('video validation retains a single trusted cover and filters unrelated or hostile blocks', () => {
  const raw = content(), valid = raw.blocks![0]!;
  const validated = validatePluginContent({ ...raw, blocks: [
    { type: 'paragraph', text: 'Not a video body block' },
    { type: 'image', image: { id: 'semantic', url: coverUrl, role: 'content' } },
    { type: 'image', image: { id: 'hostile', url: 'https://127.0.0.1/private', role: 'cover' } },
    valid,
    { type: 'image', image: { id: 'second-cover', url: 'https://i1.hdslb.com/bfs/archive/other.jpg', role: 'cover' } },
  ] }, resource);
  assert.deepEqual(validated.blocks, [valid]);
  assert.equal(validated.description, raw.description); assert.equal(validated.type, 'video');
  assert.deepEqual(pluginSourceImageIds([{ ...validated, blocks: validated.blocks!.map(block => block.type === 'image'
    ? { ...block, image: { ...block.image, assetId: 'synthetic-cover', status: 'ready' } } : block) }]), []);
  assert.equal(validatePluginContent({ ...raw, coverUrl: 'https://example.invalid/cover.jpg', blocks: [] }, resource).coverUrl, undefined);
});

test('video metadata extraction uses existing fields and exposes a normalized pending cover without fetching images', async t => {
  const root = await directory(t); let calls = 0;
  const result = await executeBilibiliJob(job(), root, signal(), {
    fetch: async () => assert.fail('Metadata extraction must not fetch a cover'),
    run: async (command, args) => {
      calls++; assert.equal(command, 'yt-dlp'); assert.ok(args.includes('--skip-download')); assert.ok(args.includes('--dump-single-json'));
      return JSON.stringify({ title: 'Extracted title', uploader: 'Extracted author', description: 'Extracted description', duration: 222,
        timestamp: 1700000000, thumbnail: '//i0.hdslb.com/bfs/archive/synthetic-cover.jpg', webpage_url: resource.url });
    },
  });
  try {
    assert.equal(calls, 1); assert.equal(result.content?.title, 'Extracted title'); assert.equal(result.content?.author, 'Extracted author');
    assert.equal(result.content?.publishedAt, 1700000000); assert.equal(result.content?.coverUrl, coverUrl);
    assert.deepEqual(result.content?.blocks, content().blocks);
    assert.equal(result.content?.subtitle, undefined);
  } finally { await result.cleanup(); }
});

test('card-only short links resolve into video metadata rather than a disabled placeholder', async t => {
  const root = await directory(t); let redirects = 0, extracts = 0;
  const result = await executeBilibiliJob({ ...job(), resource: normalizeBilibiliResource('https://b23.tv/Synthetic')! }, root, signal(), {
    fetch: async input => { redirects++; assert.match(String(input), /^https:\/\/b23\.tv\//u); return new Response(null, { status: 302, headers: { location: resource.url } }); },
    run: async () => { extracts++; return JSON.stringify({ title: 'Resolved video title', thumbnail: coverUrl }); },
  });
  try { assert.equal(redirects, 1); assert.equal(extracts, 1); assert.equal(result.content?.resourceId, resource.id); assert.equal(result.content?.title, 'Resolved video title'); }
  finally { await result.cleanup(); }
});

test('a video share with all video features disabled does not run metadata extraction', async t => {
  const root = await directory(t);
  const result = await executeBilibiliJob({ ...job(), config: disabled() }, root, signal(), {
    fetch: async () => assert.fail('Disabled direct video must not fetch'), run: async () => assert.fail('Disabled video must not run the extractor'),
  });
  try { assert.equal(result.content?.title, '哔哩哔哩分享'); assert.equal(result.content?.blocks, undefined); }
  finally { await result.cleanup(); }
});

test('a requested video part survives an extractor webpage URL without its part query', async t => {
  const root = await directory(t), second = normalizeBilibiliResource(`${resource.url}?p=2`)!;
  const result = await executeBilibiliJob({ ...job(), resource: second }, root, signal(), {
    fetch: async () => assert.fail('Unexpected network'),
    run: async () => JSON.stringify({ title: 'Second part', webpage_url: resource.url, thumbnail: coverUrl }),
  });
  try {
    assert.equal(result.content?.resourceId, second.id); assert.equal(result.content?.url, second.url); assert.equal(result.content?.part, 2);
    assert.equal(validatePluginContent(result.content, second).resourceId, second.id);
    assert.equal(result.content?.blocks?.[0]?.type, 'image');
    const block = result.content?.blocks?.[0]; assert.ok(block?.type === 'image'); assert.equal(block.image.id, `${second.id}:cover`);
  } finally { await result.cleanup(); }
});

test('invalid or absent thumbnails do not create a cover asset', async t => {
  const root = await directory(t);
  for (const thumbnail of [undefined, 'https://example.invalid/cover.jpg', 'https://i0.hdslb.com:8443/cover.jpg', 'file:///private/cover.jpg']) {
    const result = await executeBilibiliJob(job(), root, signal(), {
      fetch: async () => assert.fail('Unexpected network'), run: async () => JSON.stringify({ title: 'Video without cover', thumbnail }),
    });
    try { assert.equal(result.content?.coverUrl, undefined); assert.equal(result.content?.blocks, undefined); }
    finally { await result.cleanup(); }
  }
});
