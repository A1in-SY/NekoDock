import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FORWARD_LIMITS, isForwardSnapshot, type ForwardContent } from '../src/forward-contract.js';
import { pendingForwardContents, resolveForwardContents } from '../src/forward-resolver.js';
import { normalizeMessage } from '../src/napcat.js';

const text = (value: string) => ({type: 'text', data: {text: value}});
const forward = (id: string, content?: unknown) => ({type: 'forward', data: {id, ...(content === undefined ? {} : {content})}});
const event = (...message: unknown[]) => ({message});
const message = (...segments: unknown[]) => ({user_id: '123', sender: {nickname: 'Original speaker'}, time: 100, message: segments});
const valid = (contents: ForwardContent[]) => assert.ok(isForwardSnapshot({messageId: 'outer', revision: 2, deadline: Date.now(), contents}));
const resolve = (value: unknown, fetch: (id: string) => Promise<unknown> = async () => { throw Error('unexpected request'); }) => resolveForwardContents(value, {
  signal: new AbortController().signal, deadline: Date.now() + 2000, fetch,
  image: key => `asset:${key}`,
});

test('pending manifests reveal no resource IDs and plain chat does not create a manifest', () => {
  assert.deepEqual(pendingForwardContents(event(text('hello'))), []);
  assert.deepEqual(pendingForwardContents(event(forward('private-resource'))), [{type: 'forward', path: 's0', status: 'pending', nodes: []}]);
});

test('a resource reference loads once and retains its original speakers and timestamps', async () => {
  const calls: string[] = [];
  const contents = await resolve(event(forward('root')), async id => { calls.push(id); return {messages: [message(text('original discussion'))]}; });
  assert.deepEqual(calls, ['root']);
  assert.equal(contents[0]!.status, 'ready');
  assert.deepEqual(contents[0]!.nodes[0], {path: 's0/n0', senderId: '123', senderName: 'Original speaker', time: 100, segments: [{type: 'text', text: 'original discussion'}]});
  valid(contents);
});

test('already expanded multi-layer content is parsed without querying internal short IDs', async () => {
  const contents = await resolve(event(forward('root', [message(text('first'), forward('inner-short-id', [message(text('second'), forward('deep', [message(text('third'))]))]))])));
  const inner = contents[0]!.nodes[0]!.segments[1] as ForwardContent;
  const deep = inner.nodes[0]!.segments[1] as ForwardContent;
  assert.equal(deep.nodes[0]!.segments[0]!.type, 'text');
  assert.match(JSON.stringify(contents), /third/);
  assert.doesNotMatch(JSON.stringify(contents), /inner-short-id/);
  valid(contents);
});

test('OneBot node content, alternate message and API message wrappers interoperate', async () => {
  const contents = await resolve(event(forward('root')), async () => ({message: [{type: 'node', data: {uin: '12', name: 'Named', time: '42', content: [], message: [text('one'), {type: 'node', data: {nickname: 'Inner', content: '[CQ:at,qq=999] /new'}}]}}]}));
  assert.match(JSON.stringify(contents), /"senderName":"Named"/);
  assert.match(JSON.stringify(contents), /"senderName":"Inner"/);
  assert.match(JSON.stringify(contents), /\/new/);
  assert.match(JSON.stringify(contents), /"time":42/);
  valid(contents);
});

test('repeated branches preserve both positions while sharing one resource lookup', async () => {
  let calls = 0;
  const contents = await resolve(event(forward('root', [message(forward('same'), forward('same'))])), async () => { calls++; return {messages: [message(text('repeated'))]}; });
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(contents).match(/repeated/g)?.length, 2);
  const segments = contents[0]!.nodes[0]!.segments as ForwardContent[];
  assert.notEqual(segments[0]!.path, segments[1]!.path);
  valid(contents);
});

test('empty sender fields fall back to the supplied original identity', async () => {
  const contents = await resolve(event(forward('root', [{user_id: '', nickname: '  ', sender: {user_id: '432', card: '', nickname: 'Original nickname'}, message: [text('quoted')]}])));
  assert.equal(contents[0]!.nodes[0]!.senderId, '432');
  assert.equal(contents[0]!.nodes[0]!.senderName, 'Original nickname');
  valid(contents);
});

test('cyclic resource references stop only the affected branch', async () => {
  const contents = await resolve(event(forward('root')), async () => ({messages: [message(text('retained'), forward('root'))]}));
  assert.equal(contents[0]!.status, 'partial');
  assert.match(JSON.stringify(contents), /循环转发/);
  assert.match(JSON.stringify(contents), /retained/);
  valid(contents);
});

test('missing branch content does not discard successful sibling content', async () => {
  const contents = await resolve(event(forward('root', [message(text('retained'), forward('missing'))])));
  assert.equal(contents[0]!.status, 'partial');
  assert.match(JSON.stringify(contents), /retained/);
  assert.match(JSON.stringify(contents), /已失效/);
  valid(contents);
});

test('forward images register stable positional keys and credentials do not enter content', async () => {
  const calls: Array<[string, string]> = [];
  const contents = await resolveForwardContents(event(forward('root', [message({type: 'image', data: {url: 'https://example.invalid/image?token=private'}}, forward('inner', [message({type: 'image', data: {file: 'base64://aGVsbG8='}})]))])), {
    signal: new AbortController().signal, deadline: Date.now() + 1000, fetch: async () => { throw Error(); },
    image: (key, source) => { calls.push([key, source]); return `asset-${calls.length}`; },
  });
  assert.deepEqual(calls.map(call => call[0]), ['forward:s0/n0/s0', 'forward:s0/n0/s1/n0/s0']);
  assert.doesNotMatch(JSON.stringify(contents), /token=|https:|base64:/);
  assert.match(JSON.stringify(contents), /asset-1/);
  assert.match(JSON.stringify(contents), /asset-2/);
  valid(contents);
});

test('images without portable sources and stickers keep useful placeholders', async () => {
  const contents = await resolve(event(forward('root', [message({type: 'image', data: {file: '/private/unavailable'}}, {type: 'image', data: {url: 'https://example.invalid/sticker', sub_type: 1, summary: 'smile'}})])));
  assert.equal(contents[0]!.status, 'partial');
  assert.match(JSON.stringify(contents), /图片来源不可用/);
  assert.match(JSON.stringify(contents), /smile/);
  valid(contents);
});

test('forward images use the same empty-field fallbacks and sticker detection as top-level images', async () => {
  const sources: string[] = [];
  const contents = await resolveForwardContents(event(forward('root', [message(
    {type: 'image', data: {url: '', file: 'https://example.invalid/fallback.jpg'}},
    {type: 'image', data: {url: 'https://example.invalid/ordinary.jpg', emoji_id: '', emoji_package_id: ''}},
  )])), {signal: new AbortController().signal, deadline: Date.now() + 1000, fetch: async () => { throw Error(); },
    image: (key, source) => {sources.push(source); return key;}});
  assert.deepEqual(sources, ['https://example.invalid/fallback.jpg', 'https://example.invalid/ordinary.jpg']);
  assert.equal(contents[0]!.status, 'ready');
  valid(contents);
});

test('nested speech never changes the live command, mention or reply decision', () => {
  const value = {post_type: 'message', message_type: 'group', group_id: '1', user_id: '2', self_id: '999', message_id: '100', time: 100,
    message: [forward('root', [message({type: 'at', data: {qq: '999'}}, text('/new'))])]};
  const incoming = normalizeMessage(value, {type: 'group', id: '1'}, 0)!;
  assert.equal(incoming.text, '[聊天记录]');
  assert.equal(incoming.trigger, false);
  assert.equal(incoming.command, undefined);
  assert.equal(incoming.directlyMentioned, undefined);
  assert.equal(incoming.replyTo, null);
});

test('depth truncation remains a valid eight-layer content tree', async () => {
  let value = forward('last', [message(text('bottom'))]);
  for (let index = 0; index < 12; index++) value = forward(`level-${index}`, [message(value)]);
  const contents = await resolve(event(value));
  assert.match(JSON.stringify(contents), /超过 8 层/);
  valid(contents);
});

test('the cumulative node limit applies across nested branches', async () => {
  const contents = await resolve(event(forward('root', Array.from({length: 250}, (_, index) => message(text(`line-${index}`))))));
  assert.equal(contents[0]!.nodes.length, FORWARD_LIMITS.nodes);
  assert.equal(contents[0]!.status, 'partial');
  valid(contents);
});

test('large multi-root input stays within the complete JSON byte limit including error markers', async () => {
  const contents = await resolve(event(forward('large', [message(text('word '.repeat(100000)))]), ...Array.from({length: 199}, (_, index) => forward(`missing-${index}`))));
  assert.ok(Buffer.byteLength(JSON.stringify(contents)) <= FORWARD_LIMITS.bytes);
  valid(contents);
});

test('more than two hundred root forwards report explicit truncation', async () => {
  const contents = await resolve(event(...Array.from({length: 201}, (_, index) => forward(`root-${index}`, []))));
  assert.equal(contents.length, 200);
  assert.equal(contents.at(-1)!.status, 'partial');
  assert.match(contents.at(-1)!.error!, /后续转发未展开/);
  valid(contents);
});

test('an uncooperative resource fetch still terminates at the resolver deadline', async () => {
  const keepAlive = setTimeout(() => {}, 300);
  try {
    const started = Date.now();
    const contents = await resolveForwardContents(event(forward('root')), {
      signal: new AbortController().signal, deadline: Date.now() + 30, fetch: async () => new Promise(() => {}), image: () => null,
    });
    assert.ok(Date.now() - started < 250);
    assert.equal(contents[0]!.status, 'failed');
    assert.match(contents[0]!.error!, /超时/);
    valid(contents);
  } finally { clearTimeout(keepAlive); }
});
