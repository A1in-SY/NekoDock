import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { normalizeHeyboxResource, heyboxResources } from '../src/plugins/heybox/recognize.js';
import { heyboxHkey, heyboxSignedUrl } from '../src/plugins/heybox/signing.js';
import { fetchGameDetail, heyboxImageUrl, boundedBytes } from '../src/plugins/heybox/api.js';
import { parseGameDetail, validateHeyboxContent, contentText } from '../src/plugins/heybox/content.js';
import { HEYBOX_DEFAULTS, validateHeyboxConfig } from '../src/plugins/heybox/config.js';
import createPlugin from '../src/plugins/heybox/index.js';
import { executeHeyboxJob, type HeyboxRun } from '../src/plugins/heybox/runner.js';
import type { PluginManifest, PluginRunnerJob } from '../src/plugin-system/contracts.js';
import { defaultNetworkProxy } from '../src/network.js';

const source = () => normalizeHeyboxResource('https://api.xiaoheihe.cn/game/share_game_detail?appid=101&game_type=pc')!;
const detail = () => ({ appid: 101, steam_appid: 101, game_type: 'pc', name: '合成游戏：冒险', name_en: 'Synthetic Adventure',
  image: 'https://imgheybox.max-c.com/synthetic/cover.png', about_the_game: '<p>合成简介 &amp; 游戏内容。</p>', score: '8.6', comment_stats: { score_comment: 42 },
  is_free: false, platf: 'steam', platforms_list: [{ appid: 101, game_type: 'pc', platf: 'steam', name: 'Steam' }, { appid: 900001, game_type: 'pc', platf: 'epic', name: 'Epic' }],
  common_tags: [{ detail_list: [{ name: '支持中文', desc: '是' }, { name: '手柄', desc: '完全支持' }] }],
  price: { current: '45', initial: '90', discount: 50, lowest_price: '30', region_name: '测试地区' },
  heybox_price: { cost_coin: 44000, original_coin: 90000, coupon_info: { final_price: '40', coupon_desc: '需领券', sub_title: '以商品页面条件为准' } },
});
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
async function directory(t: TestContext) { const path = await mkdtemp(join(tmpdir(), 'nekodock-heybox-test-')); t.after(() => rm(path, { recursive: true, force: true })); return path; }
const job = (operation: PluginRunnerJob['operation'] = 'resolve'): PluginRunnerJob => ({ id: 'synthetic-job', lease: 'synthetic-lease', botId: 'synthetic-bot', pluginId: 'heybox', operation, resource: source(), config: { ...HEYBOX_DEFAULTS }, networkProxy: defaultNetworkProxy(), expiresAt: Date.now() + 60000 });
const signal = () => new AbortController().signal;

test('game share recognition supports numeric and opaque IDs, explicit platforms and QQ cards', () => {
  for (const type of ['pc', 'console', 'mobile']) {
    const resource = normalizeHeyboxResource(`https://api.xiaoheihe.cn/game/share_game_detail?appid=abc123def456&game_type=${type}`)!;
    assert.equal(resource.id, `game:${type}:abc123def456`); assert.equal(resource.gameType, type);
  }
  assert.equal(normalizeHeyboxResource('https://api.xiaoheihe.cn/game/share_game_detail?appid=101')?.gameType, undefined);
  assert.equal(normalizeHeyboxResource('https://www.xiaoheihe.cn/games/detail/101')?.gameType, 'pc');
  const resources = heyboxResources({ message: [{ type: 'text', data: { text: '来玩 https://www.xiaoheihe.cn/app/topic/game/pc/101 https://www.xiaoheihe.cn/app/topic/game/pc/101' } },
    { type: 'json', data: { data: JSON.stringify({ meta: { detail_1: { qqdocurl: 'https://api.xiaoheihe.cn/game/share_game_detail?appid=202&game_type=console' } } }) } }] });
  assert.deepEqual(resources.map(resource => resource.id), ['game:pc:101', 'game:console:202']);
});

test('recognition rejects unrelated pages, deceptive hosts, credentials and malformed identities', () => {
  for (const input of ['https://www.xiaoheihe.cn.evil.test/app/topic/game/pc/101', 'https://api.xiaoheihe.cn@evil.test/game/share_game_detail?appid=101&game_type=pc',
    'https://api.xiaoheihe.cn:444/game/share_game_detail?appid=101&game_type=pc', 'https://www.xiaoheihe.cn/app/topic/game/unknown/101',
    'https://api.xiaoheihe.cn/game/share_game_detail?appid=../101&game_type=pc', 'https://www.xiaoheihe.cn/app/bbs/link/101', 'file:///app/topic/game/pc/101']) assert.equal(normalizeHeyboxResource(input), null);
  assert.deepEqual(heyboxResources({ message: [{ type: 'json', data: { data: '{invalid' } }] }), []);
});

test('website signatures use the current path normalization and timestamp offset', () => {
  // Public Web-client vectors with a synthetic fixed clock and nonce.
  assert.equal(heyboxHkey('/game/get_game_detail/', 1700000000, 'A'.repeat(32)), '2UP3P84');
  assert.equal(heyboxHkey('game/console/get_game_detail', 1700000000, 'A'.repeat(32)), '77PSV59');
  const url = heyboxSignedUrl('/game/get_game_detail/', { steam_appid: '101' }, 1700000000000, 'A'.repeat(32));
  assert.equal(url.searchParams.get('_time'), '1700000000'); assert.equal(url.searchParams.get('version'), '999.0.4'); assert.equal(url.searchParams.get('steam_appid'), '101');
  assert.equal(url.searchParams.get('hkey'), heyboxHkey(url.pathname, 1700000000, 'A'.repeat(32)));
});

test('resolve uses the signed matching game API and bounded response without requiring cookies', async () => {
  const requested: URL[] = [];
  const data = await fetchGameDetail(source(), async (input, init) => {
    const url = new URL(String(input)); requested.push(url); assert.equal(init?.redirect, 'error'); assert.equal(new Headers(init?.headers).has('cookie'), false);
    assert.match(url.searchParams.get('hkey')!, /^[A-Z0-9]{5}\d{2}$/u); assert.equal(url.searchParams.get('app'), 'heybox'); assert.equal(url.searchParams.get('os_type'), 'web'); return Response.json({ status: 'ok', result: detail() });
  }, signal());
  assert.equal(data.appid, 101); assert.equal(requested[0]!.pathname, '/game/get_game_detail/'); assert.equal(requested[0]!.searchParams.get('steam_appid'), '101');
});

test('opaque share resolution accepts actual game IDs and handles console and mobile routes', async () => {
  for (const type of ['console', 'mobile'] as const) {
    const resource = normalizeHeyboxResource(`https://www.xiaoheihe.cn/app/topic/game/${type}/abc123def456`)!;
    const result = await fetchGameDetail(resource, async input => {
      const url = new URL(String(input)); assert.equal(url.pathname, `/game/${type}/get_game_detail/`); assert.equal(url.searchParams.get('appid'), 'abc123def456');
      return Response.json({ status: 'ok', result: { ...detail(), appid: 202, game_type: type } });
    }, signal());
    assert.equal(result.appid, 202);
  }
});

test('missing game types are resolved by checked official redirects without fetching arbitrary targets', async () => {
  const unknown = normalizeHeyboxResource('https://api.xiaoheihe.cn/game/share_game_detail?appid=101')!; let calls = 0;
  await fetchGameDetail(unknown, async input => { calls++; return calls === 1 ? new Response(null, { status: 302, headers: { location: 'https://www.xiaoheihe.cn/app/topic/game/pc/101' } }) : Response.json({ status: 'ok', result: detail() }); }, signal());
  assert.equal(calls, 2); calls = 0;
  await assert.rejects(fetchGameDetail(unknown, async () => { calls++; return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }); }, signal()), { code: 'HEYBOX_REDIRECT_REJECTED' });
  assert.equal(calls, 1);
});

test('wrong game identity, rejected access and oversized JSON never become ready metadata', async () => {
  await assert.rejects(fetchGameDetail(source(), async () => Response.json({ status: 'ok', result: { ...detail(), appid: 202 } }), signal()), { code: 'HEYBOX_GAME_MISMATCH' });
  await assert.rejects(fetchGameDetail(source(), async () => new Response('', { status: 403 }), signal()), { code: 'HEYBOX_ACCESS_RESTRICTED' });
  await assert.rejects(fetchGameDetail(source(), async () => new Response('{}', { headers: { 'content-length': String(5 * 1024 * 1024) } }), signal()), { code: 'HEYBOX_RESPONSE_TOO_LARGE' });
  await assert.rejects(boundedBytes(new Response(new Uint8Array(9)), 8), { code: 'HEYBOX_RESPONSE_TOO_LARGE' });
});

test('game metadata preserves platform and coupon price meanings without assuming Steam identity', () => {
  const content = parseGameDetail(detail(), source(), 1700000000); assert.equal(content.type, 'game'); assert.equal(content.description, '合成简介 & 游戏内容。');
  assert.deepEqual(content.game?.score, { value: 8.6, scale: 10, count: 42, source: '小黑盒' });
  assert.equal(content.game?.prices?.[0]?.label, 'Steam商店价'); assert.equal(content.game?.prices?.[0]?.recordedLowest, '30');
  assert.equal(content.game?.prices?.[1]?.current, '44'); assert.match(content.game?.prices?.[1]?.condition ?? '', /需领券；券后 40/u);
  assert.equal(content.game?.prices?.[0]?.currency, undefined);
  const epic = parseGameDetail({ ...detail(), appid: 900001, steam_appid: 900001, platf: 'epic' }, normalizeHeyboxResource('https://www.xiaoheihe.cn/app/topic/game/pc/900001')!);
  assert.equal(epic.game?.platform, 'epic'); assert.equal(epic.game?.platformName, 'Epic'); assert.equal(epic.game?.platforms?.find(p => p.id === 'steam')?.appId, '101');
  assert.match(contentText(content), /小黑盒记录史低 30/u); assert.match(contentText(content), /UTC\+8/u);
});

test('missing optional metadata stays absent and validated content cannot switch platforms or IDs', () => {
  const content = parseGameDetail({ appid: 'abc1', game_type: 'mobile', name: '合成手机游戏' }, normalizeHeyboxResource('https://www.xiaoheihe.cn/app/topic/game/mobile/abc1')!);
  assert.equal(content.game?.score, undefined); assert.equal(content.game?.prices, undefined); assert.equal(content.game?.isFree, undefined);
  assert.equal(validateHeyboxContent(parseGameDetail(detail(), source()), source()).game?.appId, '101');
  assert.throws(() => validateHeyboxContent({ ...content, url: 'https://evil.test/101' }, source()), /无效/u);
  assert.throws(() => validateHeyboxContent({ ...parseGameDetail(detail(), source()), resourceId: 'game:pc:202' }, source()), /无效/u);
});

test('enhancement and automatic card settings are independent and enforce bounded policy', () => {
  const plugin = createPlugin({ id: 'heybox', name: 'Synthetic', required: false } as PluginManifest), content = parseGameDetail(detail(), source());
  assert.deepEqual(plugin.afterResolve('share', source(), { ...HEYBOX_DEFAULTS, enhance: false }, content), { provideContext: false, prepare: { mode: 'card', provideContext: false } });
  assert.deepEqual(plugin.afterResolve('share', source(), { ...HEYBOX_DEFAULTS, autoCard: false }, content), { provideContext: true });
  assert.equal(plugin.shouldProcess({ ...HEYBOX_DEFAULTS, enhance: false, autoCard: false }, source()), false);
  assert.throws(() => validateHeyboxConfig({ maxMiB: 100 })); assert.throws(() => validateHeyboxConfig({ cookie: 'sensitive\nvalue' })); assert.throws(() => validateHeyboxConfig({ unexpected: true }));
  assert.deepEqual(plugin.command({ message: '/heybox' }), undefined);
});

const rendering: HeyboxRun = async (_command, args, options) => {
  if (args[1] === 'inspect') return JSON.stringify({ width: 1, height: 1 });
  await writeFile(join(options.cwd, 'card.png'), png); return JSON.stringify({ file: 'card.png' });
};
test('preparation snapshots a checked cover and publishes one presentation card with cleanup', async t => {
  const root = await directory(t), input = job('prepare'); input.content = parseGameDetail(detail(), source()); input.presentation = { mode: 'card', provideContext: true };
  const seen: string[] = [];
  const result = await executeHeyboxJob(input, root, signal(), { fetch: async input => { seen.push(String(input)); return new Response(png); }, run: rendering });
  assert.equal(seen.length, 1); assert.equal(result.content?.blocks?.[0]?.type, 'image');
  assert.deepEqual(result.outputs, [{ kind: 'image', assetKey: 'card', assetRole: 'presentation' }]);
  assert.deepEqual(result.files?.map(file => file.role), ['cover', 'presentation']);
  const path = result.files![1]!.path; await result.cleanup(); await assert.rejects(stat(path), { code: 'ENOENT' });
});

test('bad covers keep a text-only card and renderer failure falls back to structured text', async t => {
  const root = await directory(t), input = job('prepare'); input.content = parseGameDetail(detail(), source()); input.presentation = { mode: 'card', provideContext: true };
  const card = await executeHeyboxJob(input, root, signal(), { fetch: async () => new Response('not an image'), run: rendering });
  assert.equal(card.content?.retrieval.status, 'partial'); assert.equal(card.files?.length, 1); assert.equal(card.outputs?.[0]?.kind, 'image'); await card.cleanup();
  const fallback = await executeHeyboxJob(input, root, signal(), { fetch: async () => new Response(png), run: async () => { throw new Error('sensitive-renderer-details'); } });
  assert.equal(fallback.content?.retrieval.error, 'HEYBOX_PRESENTATION_FALLBACK'); assert.equal(fallback.outputs?.[0]?.kind, 'reply');
  assert.match(fallback.outputs?.[0]?.text ?? '', /合成游戏/u); assert.doesNotMatch(JSON.stringify(fallback), /sensitive-renderer-details/u); await fallback.cleanup();
});

test('image redirects are bounded and reject untrusted hosts before a second request', async t => {
  assert.equal(heyboxImageUrl('http://127.0.0.1/a.png'), undefined); assert.equal(heyboxImageUrl('https://cdn.max-c.com.evil.test/a.png'), undefined);
  const root = await directory(t), input = job('prepare'); input.content = parseGameDetail(detail(), source()); input.presentation = { mode: 'card', provideContext: true }; let calls = 0;
  const result = await executeHeyboxJob(input, root, signal(), { fetch: async () => { calls++; return new Response(null, { status: 302, headers: { location: 'https://evil.test/a.png' } }); }, run: rendering });
  assert.equal(calls, 1); assert.equal(result.content?.retrieval.status, 'partial'); await result.cleanup();
});

test('cancelled jobs never fetch or render', async t => {
  const root = await directory(t), controller = new AbortController(); controller.abort();
  await assert.rejects(executeHeyboxJob(job(), root, controller.signal, { fetch: async () => assert.fail('Unexpected request'), run: async () => assert.fail('Unexpected render') }));
});

const pillow = spawnSync('python3', ['-c', 'import PIL'], { stdio: 'ignore' }).status === 0;
test('actual Pillow game cards keep Unicode text on shared baselines and bounded canvases', { skip: !pillow }, async t => {
  const root = await directory(t), content = parseGameDetail(detail(), source(), 1700000000);
  content.title = '合成冒险 🎮：新世界'; content.description = '中文与 English 的排版。\n'.repeat(100);
  const path = join(root, 'render.json'); await writeFile(path, JSON.stringify({ content, showPrices: true }));
  const result = spawnSync('python3', ['src/plugins/heybox/render/card.py', 'render', path], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), { file: 'card.png' });
  const header = await readFile(join(root, 'card.png')); assert.equal(header.readUInt32BE(16), 1080); assert.ok(header.readUInt32BE(20) <= 3800);
});
