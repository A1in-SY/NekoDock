import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeHeyboxPost, normalizeHeyboxLink, heyboxResources } from '../src/plugins/heybox/recognize.js';
import { fetchPostDetail } from '../src/plugins/heybox/api.js';
import { POST_LIMITS, parsePostDetail, validatePostContent, postContentText, postImageUrl } from '../src/plugins/heybox/post-content.js';
import { HEYBOX_DEFAULTS, validateHeyboxConfig } from '../src/plugins/heybox/config.js';
import createPlugin from '../src/plugins/heybox/index.js';
import { executeHeyboxJob, type HeyboxRun } from '../src/plugins/heybox/runner.js';
import type { PluginManifest, PluginRunnerJob, PluginContent } from '../src/plugin-system/contracts.js';
import { defaultNetworkProxy } from '../src/network.js';
import { ConsoleDatabase } from '../src/console/database.js';

const source = () => normalizeHeyboxPost('https://api.xiaoheihe.cn/v3/bbs/app/api/web/share?link_id=synthetic-share')!;
const image = (i: number) => ({ type: 'img', url: `https://imgheybox1.max-c.com/synthetic/${i}.png?imageMogr2/thumbnail/100x100`, width: '2', height: '3' });
const detail = (count = 2) => ({ linkid: 123456, title: '合成图文帖子', user: { userid: 42, username: '合成作者', avatar: 'https://cdn.max-c.com/synthetic/avatar.png' },
  create_at: 1700000000, update_at: 1700000100,
  text: JSON.stringify([{ type: 'text', text: '第一段\\n第二行[cube_鳄鱼]' }, ...Array.from({ length: count }, (_, i) => image(i)), { type: 'text', text: '最后一段' }]) });
const signal = () => new AbortController().signal;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAFElEQVR4nGPUaLrEwMDAxAAGUAoAG94BgqFCKSEAAAAASUVORK5CYII=', 'base64');
async function directory(t: TestContext) { const path = await mkdtemp(join(tmpdir(), 'nekodock-post-test-')); t.after(() => rm(path, { recursive: true, force: true })); return path; }
const job = (operation: PluginRunnerJob['operation'] = 'resolve'): PluginRunnerJob => ({ id: 'synthetic-job', lease: 'synthetic-lease', botId: 'synthetic-bot', pluginId: 'heybox', operation,
  resource: source(), config: { ...HEYBOX_DEFAULTS }, networkProxy: defaultNetworkProxy(), expiresAt: Date.now() + 60000 });
const prepare = (content = parsePostDetail(detail(), source()), mode: 'card' | 'none' = 'card'): PluginRunnerJob => ({ ...job('prepare'), content,
  resource: normalizeHeyboxPost(content.url)!, presentation: { mode, provideContext: true } });

test('post shares, clean pages and QQ news cards normalize identities without share tracking fields', () => {
  const url = 'https://api.xiaoheihe.cn/v3/bbs/app/api/web/share?h_session_id=synthetic-tracking&link_id=synthetic-share&new_post_share_style_v2=1';
  assert.equal(normalizeHeyboxPost(url)?.url, 'https://www.xiaoheihe.cn/app/bbs/link/synthetic-share');
  const resources = heyboxResources({ message: [{ type: 'text', data: { text: `分享（${url}） https://www.xiaoheihe.cn/app/bbs/link/synthetic-share` } },
    { type: 'json', data: { data: JSON.stringify({ meta: { news: { jumpUrl: url.replaceAll('&', '&amp;') } } }) } }] });
  assert.equal(resources.length, 1); assert.equal(resources[0]?.id, 'post:synthetic-share');
  assert.equal(normalizeHeyboxLink('https://www.xiaoheihe.cn/app/topic/game/pc/101')?.kind, 'game');
  for (const url of ['https://api.xiaoheihe.cn.evil.test/app/bbs/link/101', 'https://user:secret@api.xiaoheihe.cn/app/bbs/link/101',
    'https://api.xiaoheihe.cn:444/app/bbs/link/101', 'https://api.xiaoheihe.cn/v3/bbs/app/api/web/share?link_id=../101',
    'https://api.xiaoheihe.cn/app/bbs/link/%2e%2e', 'https://api.xiaoheihe.cn/other/101']) assert.equal(normalizeHeyboxPost(url), null);
});

test('post resolution uses the signed first-page API and returns the post without comments or cookies', async () => {
  const post = await fetchPostDetail(source(), async (input, init) => {
    const url = new URL(String(input)); assert.equal(url.pathname, '/bbs/app/link/tree'); assert.equal(url.searchParams.get('link_id'), 'synthetic-share');
    assert.equal(url.searchParams.get('limit'), '1'); assert.match(url.searchParams.get('hkey')!, /^[A-Z0-9]{5}\d{2}$/u);
    assert.equal(init?.redirect, 'error'); assert.equal(new Headers(init?.headers).has('cookie'), false);
    return Response.json({ status: 'ok', result: { link: detail(), comments: [{ text: 'Synthetic comment excluded' }] } });
  }, signal());
  const content = parsePostDetail(post, source()); assert.equal(content.resourceId, 'post:123456');
  assert.doesNotMatch(JSON.stringify(content), /comment excluded|h_session_id/u);
  await assert.rejects(fetchPostDetail(normalizeHeyboxPost('https://www.xiaoheihe.cn/app/bbs/link/999')!, async () => Response.json({ status: 'ok', result: { link: detail() } }), signal()), { code: 'HEYBOX_POST_MISMATCH' });
  await assert.rejects(fetchPostDetail(source(), async () => new Response('', { status: 403 }), signal()), { code: 'HEYBOX_ACCESS_RESTRICTED' });
  await assert.rejects(fetchPostDetail(source(), async () => Response.json({ status: 'ok', result: {} }), signal()), { code: 'HEYBOX_RESPONSE_INVALID' });
  await assert.rejects(fetchPostDetail(source(), async () => new Response('{}', { headers: { 'content-length': String(5 * 1024 * 1024) } }), signal()), { code: 'HEYBOX_RESPONSE_TOO_LARGE' });
});

test('post parsing preserves text/image order and actual metadata while canonicalizing original images', () => {
  const content = parsePostDetail(detail(), source(), 1700000200);
  assert.equal(content.author, '合成作者'); assert.equal(content.publishedAt, 1700000000); assert.equal(content.editedAt, 1700000100);
  assert.deepEqual(content.blocks?.map(b => b.type), ['paragraph', 'image', 'image', 'paragraph']);
  assert.equal(content.blocks?.[0]?.type === 'paragraph' && content.blocks[0].text, '第一段\n第二行🐊');
  assert.equal(content.blocks?.[1]?.type === 'image' && content.blocks[1].image.url, 'https://imgheybox1.max-c.com/synthetic/0.png');
  assert.equal(validatePostContent(content, source()).retrieval.status, 'ready');
  assert.match(postContentText(content), /原帖配图 2 张/u); assert.doesNotMatch(postContentText(content), /imageMogr2/u);
  assert.equal(postImageUrl('https://imgheybox1.max-c.com.evil.test/a'), undefined); assert.equal(postImageUrl('https://steamstatic.com/a'), undefined);
});

test('unsupported blocks, excess images/text and rejected images explicitly retain partial status', () => {
  const many = parsePostDetail(detail(14), source()); assert.equal(many.blocks?.filter(b => b.type === 'image').length, POST_LIMITS.images);
  assert.equal(many.retrieval.status, 'partial'); assert.match(postContentText(many), /超过处理上限/u); validatePostContent(many, source());
  const body = detail(); body.text = JSON.stringify([{ type: 'text', text: '长'.repeat(25000) }, { type: 'video' }, { type: 'img', url: 'https://127.0.0.1/private' }]);
  const partial = parsePostDetail(body, source()); assert.equal(partial.retrieval.status, 'partial'); assert.match(postContentText(partial), /配图未能取得/u); validatePostContent(partial, source());
  assert.throws(() => parsePostDetail({ ...detail(), text: '<html>not a structured post</html>' }, source()), { code: 'HEYBOX_POST_FORMAT_UNSUPPORTED' });
  const content = parsePostDetail(detail(), source());
  assert.throws(() => validatePostContent({ ...content, url: 'https://evil.test/post' }, source()));
  assert.throws(() => validatePostContent(content, normalizeHeyboxPost('https://www.xiaoheihe.cn/app/bbs/link/999')!));
  assert.throws(() => validatePostContent({ ...content, blocks: [content.blocks![1], content.blocks![1]] }, source()));
});

test('post switches are independent of game switches and upgrade existing settings with defaults', () => {
  const plugin = createPlugin({ id: 'heybox', name: 'Synthetic', required: false } as PluginManifest), content = parsePostDetail(detail(), source());
  const settings = validateHeyboxConfig({ enhance: false, autoCard: false });
  assert.equal(settings.postAutoCard, true); assert.equal(plugin.shouldProcess(settings), true); assert.equal(plugin.shouldProcess(settings, source()), true);
  assert.equal(plugin.shouldProcess({ ...settings, postEnhance: false, postAutoCard: false }), false);
  assert.deepEqual(plugin.afterResolve('share', source(), { ...settings, postEnhance: false }, content), { provideContext: false, prepare: { mode: 'card', provideContext: false } });
  assert.deepEqual(plugin.afterResolve('share', source(), { ...settings, postAutoCard: false }, content), { provideContext: true, prepare: { mode: 'none', provideContext: true } });
});

const rendering: HeyboxRun = async (_command, args, options) => {
  if (args[1] === 'inspect') return JSON.stringify({ width: 2, height: 3 });
  const request = JSON.parse(await readFile(args[2]!, 'utf8')); assert.equal(request.maxPages, 4);
  await writeFile(join(options.cwd, 'card-0.png'), png); return JSON.stringify({ files: ['card-0.png'], truncated: false });
};
test('post preparation caches images and avatar once, publishes presentation assets and cleans up', async t => {
  const root = await directory(t), seen: string[] = [];
  const result = await executeHeyboxJob(prepare(), root, signal(), { fetch: async input => { seen.push(String(input)); return new Response(png); }, run: rendering });
  assert.equal(seen.length, 3); assert.ok(seen.every(url => !url.includes('?')));
  assert.deepEqual(result.files?.map(f => f.role), ['content', 'content', 'avatar', 'presentation']);
  assert.deepEqual(result.outputs, [{ kind: 'image', assetKey: 'card-0', assetRole: 'presentation' }]);
  assert.equal(result.content?.blocks?.[1]?.type === 'image' && result.content.blocks[1].image.status, 'ready');
  const path = result.files![0]!.path; await result.cleanup(); await assert.rejects(stat(path), { code: 'ENOENT' });
});

test('context-only preparation caches semantic images without rendering or sending cards', async t => {
  const root = await directory(t); let requests = 0;
  const result = await executeHeyboxJob(prepare(undefined, 'none'), root, signal(), { fetch: async () => { requests++; return new Response(png); },
    run: async (_command, args) => { assert.equal(args[1], 'inspect'); return JSON.stringify({ width: 2, height: 3 }); } });
  assert.equal(requests, 2); assert.deepEqual(result.outputs, []); assert.equal(result.files?.length, 2); await result.cleanup();
});

test('failed downloads reject hostile redirects and remain explicit; render failure retains available originals', async t => {
  const root = await directory(t); let calls = 0;
  const partial = await executeHeyboxJob(prepare(), root, signal(), { fetch: async () => { calls++; return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } }); }, run: rendering });
  assert.equal(calls, 3); assert.equal(partial.content?.retrieval.error, 'HEYBOX_POST_IMAGES_PARTIAL'); assert.equal(partial.files?.length, 1); await partial.cleanup();
  const fallback = await executeHeyboxJob(prepare(), root, signal(), { fetch: async () => new Response(png), run: async (command, args, options) => {
    if (args[1] === 'render') throw new Error('synthetic sensitive failure'); return rendering(command, args, options);
  } });
  assert.deepEqual(fallback.outputs?.map(o => o.kind), ['reply', 'image', 'image']); assert.match(fallback.outputs?.[0]?.text ?? '', /部分资料/u);
  assert.doesNotMatch(JSON.stringify(fallback), /synthetic sensitive failure/u); await fallback.cleanup();
});

test('page-limit output is partial and invalid card paths never become published assets', async t => {
  const root = await directory(t);
  const result = await executeHeyboxJob(prepare(), root, signal(), { fetch: async () => new Response(png), run: async (command, args, options) => {
    const raw = await rendering(command, args, options); return args[1] === 'render' ? JSON.stringify({ files: ['card-0.png'], truncated: true }) : raw;
  } });
  assert.equal(result.content?.retrieval.error, 'HEYBOX_POST_PAGE_LIMIT'); await result.cleanup();
  const bad = await executeHeyboxJob(prepare(), root, signal(), { fetch: async () => new Response(png), run: async (_command, args) => args[1] === 'inspect'
    ? JSON.stringify({ width: 2, height: 3 }) : JSON.stringify({ files: ['../../outside.png'] }) });
  assert.equal(bad.outputs?.[0]?.kind, 'reply'); assert.ok(bad.files?.every(f => f.role !== 'presentation')); await bad.cleanup();
});

test('Console deduplicates aliases by resolved post identity before creating presentation jobs', t => {
  const root = mkdtempSync(join(tmpdir(), 'nekodock-post-console-')), db = new ConsoleDatabase(join(root, 'console.sqlite3'), join(root, 'master.key'));
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const bot = db.createBot({ name: 'Synthetic bot', targetType: 'group', targetId: '1001', config: {} }); db.setDesiredState(bot.id, 'running');
  db.plugins.update(bot.id, 'heybox', { expectedRevision: 0, enabled: true });
  db.enqueueNapcatEvent(bot.id, { post_type: 'message', message_type: 'group', message_id: '2001', user_id: '3001', self_id: '9999', group_id: '1001', time: 1,
    message: [{ type: 'text', data: { text: source().url + ' https://www.xiaoheihe.cn/app/bbs/link/123456' } }] }, 'synthetic-post');
  db.plugins.sync(bot.id, { bindings: [{ messageId: '2001', conversationId: 'synthetic-conversation' }], conversationId: 'synthetic-conversation' });
  for (let i = 0; i < 2; i++) { const job = db.plugins.claim()!; assert.equal(job.operation, 'resolve');
    db.plugins.complete(job.id, job.lease, { content: parsePostDetail(detail(), normalizeHeyboxPost(job.resource.url)!) }); }
  const next = db.plugins.claim()!; assert.equal(next.operation, 'prepare'); assert.equal(next.resource.id, 'post:123456');
  assert.equal(db.plugins.claim(), null);
});

const pillow = spawnSync('python3', ['-c', 'import PIL'], { stdio: 'ignore' }).status === 0;
const pythonSite = spawnSync('python3', ['-c', 'import site;print(site.getusersitepackages())'], { encoding: 'utf8' }).stdout.trim();
const actualRender: HeyboxRun = async (command, args, options) => (await promisify(execFile)(command, args,
  { cwd: options.cwd, env: { ...options.env, PYTHONPATH: pythonSite }, signal: options.signal, timeout: options.timeoutMs, encoding: 'utf8' })).stdout;
test('actual post renderer paginates twelve source pictures into four readable cards', { skip: !pillow }, async t => {
  const root = await directory(t), input = prepare(parsePostDetail(detail(12), source()));
  const wide = spawnSync('python3', ['-c', 'from PIL import Image;import io,sys;s=io.BytesIO();Image.new("RGB",(2,1),"#275c61").save(s,format="PNG");sys.stdout.buffer.write(s.getvalue())']).stdout;
  const result = await executeHeyboxJob(input, root, signal(), { fetch: async input => new Response(String(input).endsWith('/0.png') ? wide : png), run: actualRender });
  assert.equal(result.content?.retrieval.status, 'ready'); assert.equal(result.outputs?.length, 4);
  assert.equal(result.files?.filter(f => f.role === 'content').length, 12);
  for (const card of result.files!.filter(f => f.role === 'presentation')) { const bytes = await readFile(card.path); assert.equal(bytes.readUInt32BE(16), 1080); assert.ok(bytes.readUInt32BE(20) <= 5250); }
  await result.cleanup();
});

test('actual renderer splits very tall images and reports page overflow without silently dropping content', { skip: !pillow }, async t => {
  const root = await directory(t), content = parsePostDetail(detail(1), source());
  const image = content.blocks!.find(b => b.type === 'image')!;
  const path = join(root, 'tall.png');
  assert.equal(spawnSync('python3', ['-c', 'from PIL import Image;import sys;Image.new("RGB",(100,2000),"#275c61").save(sys.argv[1])', path]).status, 0);
  if (image.type !== 'image') assert.fail(); image.image.assetKey = 'tall'; image.image.status = 'ready';
  const request = join(root, 'render.json'); await writeFile(request, JSON.stringify({ content, paths: { tall: path }, maxPages: 4 }));
  const result = spawnSync('python3', ['src/plugins/heybox/render/post.py', 'render', request], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); const value = JSON.parse(result.stdout); assert.equal(value.truncated, true); assert.equal(value.files.length, 4);
});
