import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { defaultNetworkProxy } from '../src/network.js';
import type { PluginContent, PluginManifest, PluginRunnerJob } from '../src/plugin-system/contracts.js';
import createPlugin from '../src/plugins/douyin/index.js';
import { DOUYIN_DEFAULTS, validateDouyinConfig } from '../src/plugins/douyin/config.js';
import { contentText, validateDouyinContent } from '../src/plugins/douyin/content.js';
import { createDouyinState, DouyinClient, mediaResponse, mediaUrl, parseDouyinInfo, parseRouterData, videoCandidates } from '../src/plugins/douyin/api.js';
import { douyinResources, normalizeDouyinResource } from '../src/plugins/douyin/recognize.js';
import { executeDouyinJob, type DouyinTools } from '../src/plugins/douyin/runner.js';

const id = '1000000000000000001', url = `https://www.douyin.com/video/${id}`;
const secondId = '1000000000000000002';
const manifest: PluginManifest = { id: 'douyin', name: '抖音增强', version: '1.0.0', apiVersion: 1, required: false, resourceTypes: ['video'], commands: [] };
const mp4 = Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.alloc(40)]);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=','base64');
const item = (patch: Record<string,any> = {}): Record<string,any> => ({ aweme_id: id, aweme_type: 0, desc: 'Synthetic caption #topic', create_time: 1700000000,
  author: { uid: '12345', nickname: 'Synthetic author' }, video: { duration: 12000, width: 720, height: 1280,
    play_addr: { uri: 'synthetic_video', url_list: [`https://aweme.snssdk.com/aweme/v1/playwm/?video_id=synthetic_video&ratio=720p`] },
    cover: { url_list: ['https://p1.douyinpic.com/cover.png?x-signature=synthetic-signature&x-expires=1700000001'] } }, ...patch });
const router = (value = item()) => ({ loaderData: { 'video_(id)/page': { videoInfoRes: { item_list: [value] } } } });
const html = (value = item()) => `<html><script>window._ROUTER_DATA = ${JSON.stringify(router(value))};</script></html>`;
const probe = (width = 720,height = 1280,codec = 'h264') => JSON.stringify({ format: { duration: '12.0' }, streams: [
  { codec_type: 'video', codec_name: codec, width, height }, { codec_type: 'audio', codec_name: 'aac' },
] });
const code = (expected: string) => (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === expected;

async function fixture(t: TestContext, options: { share?: (count: number) => Response; media?: (url: URL,count: number) => Response; run?: DouyinTools['run']; proxy?: PluginRunnerJob['networkProxy'] } = {}) {
  const root = await mkdtemp(join(tmpdir(),'nekodock-douyin-')); t.after(() => rm(root,{ recursive: true,force: true }));
  const requests: Array<{ url: URL; init?: RequestInit }> = []; let registrations = 0, shares = 0, media = 0;
  const state = createDouyinState();
  const fetcher: typeof fetch = async (input,init) => {
    const target = new URL(String(input)); requests.push({ url: target, init });
    if (target.hostname === 'ttwid.bytedance.com') {
      registrations++; return Response.json({ status_code: 0, redirect_url: 'https://www.iesdouyin.com/ttwid/union/register/callback/?ticket=synthetic' },{ headers: { 'set-cookie': `ttwid=synthetic-guest-${registrations}; Domain=.bytedance.com; Max-Age=86400; Secure; HttpOnly` } });
    }
    if (target.pathname.startsWith('/ttwid/union/register/callback/')) return new Response('ok',{ headers: { 'set-cookie': `ttwid=synthetic-visitor-${registrations}; Domain=.iesdouyin.com; Secure; HttpOnly` } });
    if (target.pathname.startsWith('/share/video/')) { shares++; return options.share?.(shares) ?? new Response(html(),{ headers: { 'content-type': 'text/html' } }); }
    if (target.hostname.endsWith('.douyinpic.com')) return new Response(png,{ headers: { 'content-type': 'image/png' } });
    media++; return options.media?.(target,media) ?? new Response(mp4,{ headers: { 'content-type': 'video/mp4', 'content-length': String(mp4.length) } });
  };
  const run: DouyinTools['run'] = options.run ?? (async (_command,args) => args.includes('-show_format') ? probe() : JSON.stringify({ streams: [{ codec_type: 'video', width: 1, height: 1 }] }));
  const job = (operation: PluginRunnerJob['operation'] = 'resolve', config: Record<string,unknown> = {}): PluginRunnerJob => ({
    id: 'synthetic-job', lease: 'synthetic-lease', botId: 'synthetic-bot', pluginId: 'douyin', operation, resource: normalizeDouyinResource(url)!,
    networkProxy: options.proxy ?? defaultNetworkProxy(), config, expiresAt: Date.now() + 120000,
  });
  const tools = { fetch: fetcher, run, state };
  return { root, requests, state, tools, fetcher, job, counts: () => ({ registrations, shares, media }),
    execute: (value = job()) => executeDouyinJob(value,root,new AbortController().signal,tools) };
}

test('Douyin recognition extracts shared text and card URLs while retaining numeric identifiers as strings', () => {
  for (const input of [url,`https://www.iesdouyin.com/share/video/${id}/?from=copy`,`https://www.douyin.com/discover?modal_id=${id}`]) {
    assert.deepEqual(normalizeDouyinResource(input),{ kind: 'video',id: `video:${id}`,url });
  }
  assert.equal(normalizeDouyinResource('https://v.douyin.com/ABC_123-/')?.kind,'short');
  const resources = douyinResources({ message: [{ type: 'text',data: { text: `3.14 复制打开抖音 ${url}，看看作品！ https://v.douyin.com/ABC_123-/` } },
    { type: 'json',data: { data: JSON.stringify({ meta: { detail_1: { qqdocurl: url } } }) } }] });
  assert.deepEqual(resources.map(value => value.id),[`video:${id}`,'short:v.douyin.com:ABC_123-']);
  for (const input of ['https://douyin.com.evil.example/video/'+id,'https://user@www.douyin.com/video/'+id,'https://www.douyin.com:444/video/'+id,
    'file:///video/'+id,'https://127.0.0.1/video/'+id,'https://live.douyin.com/1234']) assert.equal(normalizeDouyinResource(input),null);
  assert.equal(normalizeDouyinResource(`https://www.douyin.com/note/${id}`)?.kind,'note');
});

test('Douyin configuration is independent, bounded and matches the two enabled behaviors', () => {
  assert.equal(validateDouyinConfig({}).enhance,true); assert.equal(validateDouyinConfig({}).autoVideo,true);
  assert.equal(validateDouyinConfig({ maxResolution: 540 }).maxResolution,540);
  for (const input of [{ enhance: 1 },{ autoVideo: 'true' },{ unknown: true },{ maxMiB: 0 },{ maxDurationSeconds: NaN },{ timeoutSeconds: 601 },{ maxResolution: 2000 }]) assert.throws(() => validateDouyinConfig(input));
  const plugin = createPlugin(manifest), content = parseDouyinInfo(router(),id).content, resource = normalizeDouyinResource(url)!;
  assert.equal(plugin.command({ message: '/douyin download' }),undefined);
  const next = plugin.afterResolve('share',resource,DOUYIN_DEFAULTS,content);
  assert.equal(next.provideContext,true); assert.equal(next.download?.id,`video:${id}`); assert.equal(next.prepare?.mode,'none');
  assert.equal(plugin.afterResolve('share',resource,{ ...DOUYIN_DEFAULTS,autoVideo: false },content).download,undefined);
  assert.equal(plugin.afterResolve('share',resource,{ ...DOUYIN_DEFAULTS,enhance: false },content).provideContext,false);
  assert.equal(plugin.afterResolve('share',resource,{ ...DOUYIN_DEFAULTS,enhance: false },content).prepare,undefined);
  assert.equal(plugin.afterResolve('share',resource,DOUYIN_DEFAULTS,{ ...content,durationSeconds: undefined }).download,undefined);
  assert.equal(plugin.afterResolve('share',resource,DOUYIN_DEFAULTS,{ ...content,durationSeconds: 301 }).download,undefined);
});

test('SSR parsing requires an exact work ID and never evaluates JavaScript or treats galleries as videos', () => {
  const content = parseDouyinInfo(parseRouterData(html()),id).content;
  assert.equal(content.author,'Synthetic author'); assert.equal(content.durationSeconds,12); assert.equal(content.publishedAt,1700000000);
  assert.deepEqual(content.subtitle,{ status: 'absent' });
  assert.match(contentText(content),/未取得可用字幕/);
  assert.doesNotMatch(JSON.stringify(content),/x-signature|x-expires|synthetic-guest|video_id=|playwm/);
  assert.throws(() => parseDouyinInfo(router(item({ aweme_id: secondId })),id),code('DOUYIN_NOT_FOUND'));
  assert.throws(() => parseDouyinInfo({ loaderData: { 'video_(id)/page': { videoInfoRes: { filter_list: [{ aweme_id: id }] } } } },id),code('DOUYIN_NOT_FOUND'));
  assert.throws(() => parseRouterData('<script>window._ROUTER_DATA = (() => ({}))()</script>'),code('DOUYIN_RESPONSE_INVALID'));
  assert.throws(() => parseDouyinInfo(router(item({ images: [{ url_list: ['synthetic'] }] })),id),code('DOUYIN_NOT_VIDEO'));
  assert.throws(() => parseDouyinInfo(router(item({ aweme_type: 68 })),id),code('DOUYIN_NOT_VIDEO'));
  assert.throws(() => parseDouyinInfo({ loaderData: { page: { config: true } } },id),code('DOUYIN_VISITOR_REJECTED'));
  assert.equal(parseRouterData(html(item({ desc: 'Text with braces { and quoted "value" }' }))).loaderData['video_(id)/page'].videoInfoRes.item_list[0].desc,'Text with braces { and quoted "value" }');
});

test('content validation strips signed URLs and raw fields and rejects unrelated work identities', () => {
  const content = parseDouyinInfo(router(),id).content;
  const clean = validateDouyinContent({ ...content,ttwid: 'synthetic-visitor',play_addr: 'https://private.invalid' },normalizeDouyinResource(url)!);
  assert.doesNotMatch(JSON.stringify(clean),/synthetic-visitor|private.invalid|x-signature/);
  assert.throws(() => validateDouyinContent({ ...content,url: `https://www.douyin.com/video/${secondId}`,resourceId: `video:${secondId}` },normalizeDouyinResource(url)!));
  assert.throws(() => validateDouyinContent({ ...content,platform: 'other' },normalizeDouyinResource(url)!));
});

test('anonymous visitor session follows a trusted callback and caches metadata only within the instance route', async t => {
  const f = await fixture(t), execution = await f.execute();
  assert.equal(execution.content?.resourceId,`video:${id}`); await execution.cleanup();
  assert.deepEqual(f.counts(),{ registrations: 1,shares: 1,media: 0 });
  const share = f.requests.find(value => value.url.pathname.startsWith('/share/video/'))!;
  assert.equal(new Headers(share.init?.headers).get('cookie'),'ttwid=synthetic-visitor-1');
  assert.equal(new Headers(share.init?.headers).get('user-agent')?.includes('iPhone'),true);
  assert.equal(f.requests.every(value => value.init?.redirect === 'manual'),true);
  const client = new DouyinClient(f.fetcher,'synthetic-bot',defaultNetworkProxy(),f.state);
  await client.info(normalizeDouyinResource(url)!,new AbortController().signal);
  assert.equal(f.counts().shares,1);
  const other = new DouyinClient(f.fetcher,'second-bot',defaultNetworkProxy(),f.state);
  await other.info(normalizeDouyinResource(url)!,new AbortController().signal);
  assert.equal(f.counts().registrations,2);
  const proxy = new DouyinClient(f.fetcher,'synthetic-bot',{ ...defaultNetworkProxy(),enabled: true,url: 'http://proxy.example:3128' },f.state);
  await proxy.info(normalizeDouyinResource(url)!,new AbortController().signal);
  assert.equal(f.counts().registrations,3);
});

test('empty HTTP 200 pages refresh the guest once and fail without an unbounded retry', async t => {
  const f = await fixture(t,{ share: () => new Response('<script>window._ROUTER_DATA = {"loaderData":{"page":{"config":true}}};</script>') });
  await assert.rejects(f.execute(),code('DOUYIN_VISITOR_REJECTED'));
  assert.equal(f.counts().registrations,2); assert.equal(f.counts().shares,2);
  assert.deepEqual(await readdir(f.root),[]);
  const recovered = await fixture(t,{ share: count => count === 1 ? new Response('empty shell') : new Response(html()) });
  const execution = await recovered.execute(); assert.equal(execution.content?.resourceId,`video:${id}`); await execution.cleanup();
  assert.equal(recovered.counts().registrations,2);
});

test('visitor initialization is shared for simultaneous requests and rejects an off-platform callback', async t => {
  const f = await fixture(t), client = new DouyinClient(f.fetcher,'synthetic-bot',defaultNetworkProxy(),f.state);
  await Promise.all([client.info(normalizeDouyinResource(url)!,new AbortController().signal),client.info(normalizeDouyinResource(url)!,new AbortController().signal)]);
  assert.equal(f.counts().registrations,1);
  const seen: string[] = [], fetcher: typeof fetch = async input => { seen.push(String(input)); return Response.json({ status_code: 0,redirect_url: 'https://private.example/ttwid/union/register/callback/' },{ headers: { 'set-cookie': 'ttwid=synthetic' } }); };
  const bad = new DouyinClient(fetcher,'synthetic-bot',defaultNetworkProxy(),createDouyinState());
  await assert.rejects(bad.info(normalizeDouyinResource(url)!,new AbortController().signal),code('DOUYIN_REDIRECT_REJECTED'));
  assert.equal(seen.length,1);
});

test('cancelling one visitor waiter does not cancel registration or another active job', async t => {
  const f = await fixture(t), first = new AbortController(), second = new AbortController();
  let release!: () => void, started!: () => void, sharedSignal: AbortSignal | null | undefined, closes = 0, transports = 0;
  const began = new Promise<void>(resolve => { started = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const transport = () => { transports++; return { fetch: (async (input,init) => {
    if (String(input).includes('ttwid.bytedance.com')) { sharedSignal = init?.signal; started(); await gate; }
    return f.fetcher(input,init);
  }) as typeof fetch, close: async () => { closes++; } }; };
  const a = new DouyinClient(f.fetcher,'synthetic-bot',defaultNetworkProxy(),f.state,transport);
  const b = new DouyinClient(f.fetcher,'synthetic-bot',defaultNetworkProxy(),f.state,transport);
  const cancelled = assert.rejects(a.info(normalizeDouyinResource(url)!,first.signal),{ name: 'AbortError' });
  const active = b.info(normalizeDouyinResource(url)!,second.signal);
  await began; first.abort(); await cancelled;
  assert.equal(second.signal.aborted,false); assert.equal(sharedSignal?.aborted,false); assert.equal(closes,0);
  release(); assert.equal((await active).content.resourceId,`video:${id}`);
  assert.equal(transports,1); assert.equal(closes,1); assert.equal(f.counts().registrations,1);
});

test('registration is cancelled and its transport closed when every waiter has left', async t => {
  const f = await fixture(t), first = new AbortController(), second = new AbortController();
  let started!: () => void, closed = 0, sharedSignal: AbortSignal | null | undefined;
  const began = new Promise<void>(resolve => { started = resolve; });
  const transport = () => ({ fetch: (async (_input,init) => {
    sharedSignal = init?.signal; started();
    return await new Promise<Response>((_resolve,reject) => {
      const abort = () => reject(init?.signal?.reason);
      init?.signal?.addEventListener('abort',abort,{ once: true }); if (init?.signal?.aborted) abort();
    });
  }) as typeof fetch, close: async () => { closed++; } });
  const a = new DouyinClient(f.fetcher,'synthetic-bot',defaultNetworkProxy(),f.state,transport);
  const b = new DouyinClient(f.fetcher,'synthetic-bot',defaultNetworkProxy(),f.state,transport);
  const cancelledA = assert.rejects(a.info(normalizeDouyinResource(url)!,first.signal),{ name: 'AbortError' });
  const cancelledB = assert.rejects(b.info(normalizeDouyinResource(url)!,second.signal),{ name: 'AbortError' });
  await began; first.abort(); second.abort(); await Promise.all([cancelledA,cancelledB]);
  await new Promise(resolve => setTimeout(resolve,0));
  assert.equal(sharedSignal?.aborted,true); assert.equal(closed,1); assert.equal(f.state.sessions.size,0);
});

test('short links resolve only through known hosts and never fetch an arbitrary redirect', async t => {
  const f = await fixture(t), short = normalizeDouyinResource('https://v.douyin.com/synthetic/')!;
  const base = f.fetcher, requests: string[] = [];
  const fetcher: typeof fetch = async (input,init) => { requests.push(String(input)); return String(input).includes('v.douyin.com') ? new Response(null,{ status: 302,headers: { location: `https://www.iesdouyin.com/share/video/${id}/?from=copy` } }) : base(input,init); };
  const client = new DouyinClient(fetcher,'synthetic-bot',defaultNetworkProxy(),f.state);
  assert.equal((await client.info(short,new AbortController().signal)).content.resourceId,`video:${id}`);
  const rejected: typeof fetch = async input => { assert.match(String(input),/^https:\/\/v\.douyin\.com/u); return new Response(null,{ status: 302,headers: { location: 'http://127.0.0.1/private' } }); };
  await assert.rejects(new DouyinClient(rejected,'synthetic-bot',defaultNetworkProxy(),createDouyinState()).info(short,new AbortController().signal),code('DOUYIN_REDIRECT_REJECTED'));
});

test('media routes allow observed CDN families and validate each redirect without carrying visitor cookies', async () => {
  for (const value of ['https://v1.douyinvod.com/video','https://v1.zjcdn.com/video','https://aweme.snssdk.com/aweme/v1/play/?video_id=synthetic']) assert.equal(mediaUrl(value),value);
  for (const value of ['https://douyinvod.com.evil.example/video','http://v1.douyinvod.com/video','https://v1.douyinvod.com:444/video','https://user@v1.douyinvod.com/video','https://127.0.0.1/video','https://aweme.snssdk.com/private']) assert.equal(mediaUrl(value),undefined);
  let count = 0;
  const fetcher: typeof fetch = async (input,init) => { count++; assert.equal(new Headers(init?.headers).has('cookie'),false);
    if (String(input).includes('snssdk.com')) return new Response(null,{ status: 302,headers: { location: 'https://v1.zjcdn.com/video' } });
    return new Response(mp4,{ headers: { 'content-type': 'video/mp4' } }); };
  const response = await mediaResponse('https://aweme.snssdk.com/aweme/v1/play/?video_id=synthetic',fetcher,new AbortController().signal); await response.body?.cancel(); assert.equal(count,2);
  await assert.rejects(mediaResponse('https://v1.zjcdn.com/video',async () => new Response(null,{ status: 302,headers: { location: 'https://private.example/file' } }),new AbortController().signal),code('DOUYIN_MEDIA_URL_REJECTED'));
});

test('video selection filters oversized and HEVC variants and uses the short edge for portrait clips', () => {
  const value = item(), video = value.video;
  video.bit_rate = [
    { bit_rate: 2000,is_h265: 1,play_addr: { width: 720,height: 1280,url_list: ['https://v1.zjcdn.com/hevc'] } },
    { bit_rate: 3000,play_addr: { width: 1080,height: 1920,url_list: ['https://v1.zjcdn.com/large-resolution'] } },
    { bit_rate: 1000,play_addr: { width: 720,height: 1280,data_size: 999999999,url_list: ['https://v1.zjcdn.com/too-large'] } },
    { bit_rate: 1000,play_addr: { width: 720,height: 1280,url_list: ['https://v1.zjcdn.com/portrait'] } },
  ];
  const candidates = videoCandidates(parseDouyinInfo(router(value),id),720,1024 * 1024);
  assert.equal(candidates[0],'https://v1.zjcdn.com/portrait'); assert.equal(candidates.length,3);
  assert.doesNotMatch(candidates.join('\n'),/hevc|large-resolution|too-large/);
  assert.match(candidates[1]!,/ratio=720p/);
});

test('multiple native CDN candidates retain a bounded generic lower-quality fallback', async t => {
  const value = item(); value.video.bit_rate = [{ bit_rate: 1000,play_addr: { width: 720,height: 1280,
    url_list: ['https://v1.zjcdn.com/native-a','https://v2.zjcdn.com/native-b','https://v3.zjcdn.com/native-c'] } }];
  const candidates = videoCandidates(parseDouyinInfo(router(value),id),720,1024 * 1024);
  assert.equal(candidates.length,3); assert.match(candidates[2]!,/aweme\.snssdk\.com.*ratio=540p/u);
  let count = 0;
  const f = await fixture(t,{ share: () => new Response(html(value)), run: async () => ++count < 3 ? probe(720,1280,'hevc') : probe(540,960) });
  const result = await f.execute({ ...f.job('download'),content: parseDouyinInfo(router(value),id).content });
  assert.ok(result.file); assert.equal(f.counts().media,3); assert.equal(count,3); await result.cleanup();
});

test('a complete bounded MP4 is inspected before it becomes a native-video upload file', async t => {
  const f = await fixture(t), resolved = await f.execute();
  const job = { ...f.job('download'),content: resolved.content }; await resolved.cleanup();
  const result = await f.execute(job); assert.ok(result.file); assert.deepEqual(await readFile(result.file!),mp4);
  assert.equal(result.outputs,undefined); assert.equal(result.files,undefined);
  assert.equal(f.counts().shares,1); assert.equal(f.counts().media,1); await result.cleanup(); assert.deepEqual(await readdir(f.root),[]);
});

test('download checks both saved and fresh durations before reading video bytes', async t => {
  const f = await fixture(t), resolved = await f.execute(); const content = resolved.content!; await resolved.cleanup();
  for (const durationSeconds of [undefined,0,301]) await assert.rejects(f.execute({ ...f.job('download'),content: { ...content,durationSeconds } }),code('DOUYIN_DURATION_LIMIT'));
  assert.equal(f.counts().media,0);
});

test('download falls back when the server ignores requested quality and validates actual codecs and dimensions', async t => {
  let probes = 0;
  const f = await fixture(t,{ run: async () => ++probes === 1 ? probe(1080,1920) : probe() });
  const content = parseDouyinInfo(router(),id).content;
  const result = await f.execute({ ...f.job('download'),content });
  assert.ok(result.file); assert.equal(probes,2);
  const media = f.requests.filter(value => value.url.hostname === 'aweme.snssdk.com');
  assert.deepEqual(media.map(value => value.url.searchParams.get('ratio')),['720p','540p']); await result.cleanup();
});

test('oversized, partial, HTML and unsupported-codec responses never become video assets', async t => {
  for (const options of [
    { media: () => new Response(mp4,{ headers: { 'content-type': 'video/mp4','content-length': '99999999' } }),expected: 'DOUYIN_MEDIA_TOO_LARGE' },
    { media: () => new Response(mp4,{ status: 206,headers: { 'content-type': 'video/mp4','content-range': 'bytes 0-51/9999' } }),expected: 'DOUYIN_MEDIA_FORMAT_UNSUPPORTED' },
    { media: () => new Response('<html>blocked</html>',{ headers: { 'content-type': 'text/html' } }),expected: 'DOUYIN_MEDIA_FORMAT_UNSUPPORTED' },
    { media: () => new Response(Buffer.alloc(1024 * 1024 + 1),{ headers: { 'content-type': 'video/mp4' } }),expected: 'DOUYIN_MEDIA_TOO_LARGE' },
    { run: async () => probe(720,1280,'hevc'),expected: 'DOUYIN_MEDIA_FORMAT_UNSUPPORTED' },
  ]) {
    const f = await fixture(t,options);
    await assert.rejects(f.execute({ ...f.job('download',{ maxMiB: 1 }),content: parseDouyinInfo(router(),id).content }),code(options.expected));
    assert.ok(f.counts().media <= 3); assert.deepEqual(await readdir(f.root),[]);
  }
});

test('prepare stores a bounded cover asset separately and preserves text if its source fails', async t => {
  const f = await fixture(t), content = parseDouyinInfo(router(),id).content;
  const result = await f.execute({ ...f.job('prepare'),content,presentation: { mode: 'none',provideContext: true },imageMaxBytes: 1024 });
  assert.equal(result.outputs,undefined); assert.equal(result.files?.[0]?.role,'cover'); assert.equal(result.files?.[0]?.key,'cover');
  assert.deepEqual(await readFile(result.files![0]!.path),png);
  assert.equal(result.content?.blocks?.find(block => block.type === 'image')?.image.status,'ready');
  assert.doesNotMatch(JSON.stringify(result.content),/x-signature|x-expires/); await result.cleanup();
  const failed = await fixture(t), fallback = await failed.execute({ ...failed.job('prepare'),content,presentation: { mode: 'none',provideContext: true },imageMaxBytes: 1 });
  assert.equal(fallback.content?.retrieval.status,'partial'); assert.equal(fallback.files?.length,0); assert.equal(fallback.content?.description,content.description); await fallback.cleanup();
});
