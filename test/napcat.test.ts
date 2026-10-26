import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { imageSources, NapCatClient, normalizeMessage } from '../src/napcat.js';
import type { Logger, MessageSegment, Target } from '../src/types.js';

const target: Target = { type: 'group', id: '1001' };
const voiceSnapshot = `base64://${Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0]).toString('base64')}`;
const text = (value: string) => ({ type: 'text', data: { text: value } });
const at = (qq: string) => ({ type: 'at', data: { qq } });
const reply = (id: string) => ({ type: 'reply', data: { id } });
const baseEvent = (overrides: Record<string, unknown> = {}) => ({
  time: 1_792_727_200, self_id: 999, post_type: 'message', message_type: 'group',
  group_id: 1001, message_id: -101, user_id: 123,
  sender: { nickname: '昵称', card: '群名片' }, message: [text('hello')], ...overrides,
});

test('normalization preserves IDs, sender, time, reply, raw event and readable segments', () => {
  const event = baseEvent({ message: [reply('-100'), at('456'), text('正文'), { type: 'image', data: { file: 'photo.png' } }, { type: 'custom', data: {} }] });
  const normalized = normalizeMessage(event, target, 0);
  assert.ok(normalized);
  assert.equal(normalized.messageId, '-101');
  assert.equal(normalized.senderId, '123');
  assert.equal(normalized.senderName, '群名片');
  assert.equal(normalized.time, event.time);
  assert.equal(normalized.replyTo, '-100');
  assert.equal(normalized.text, '[引用 -100][@456]正文[图片 photo.png][custom]');
  assert.equal(normalized.trigger, false);
  assert.deepEqual(JSON.parse(normalized.rawJson), event);
  assert.equal(normalizeMessage(baseEvent({ sender: { nickname: '昵称', card: '' } }), target, 0)?.senderName, '昵称');
  assert.equal(normalizeMessage(baseEvent({ sender: {} }), target, 0)?.senderName, '123');
});

test('normalization filters other targets, non-message events, own messages and malformed input', () => {
  const rejected: unknown[] = [
    null, [], {}, baseEvent({ group_id: 1002 }), baseEvent({ message_type: 'private' }),
    baseEvent({ post_type: 'notice' }), baseEvent({ post_type: 'message_sent' }),
    baseEvent({ user_id: '999' }), baseEvent({ message_id: undefined }),
    baseEvent({ time: undefined }), baseEvent({ message: [{ data: {} }] }),
  ];
  for (const event of rejected) assert.equal(normalizeMessage(event, target, 1), null);
  assert.equal(normalizeMessage(baseEvent({ message_type: 'private', user_id: 123 }), { type: 'private', id: '124' }, 1), null);
});

test('direct self mention triggers and other group content uses exactly the configured probability', () => {
  let randomCalls = 0;
  const random = () => { randomCalls++; return 0.2; };
  assert.equal(normalizeMessage(baseEvent({ message: [at('999'), { type: 'face', data: { id: '1' } }] }), target, 0, random)?.trigger, true);
  assert.equal(randomCalls, 0);
  assert.equal(normalizeMessage(baseEvent({ message: [at('888'), text('你好')] }), target, 0.25, random)?.trigger, true);
  assert.equal(randomCalls, 1);
  assert.equal(normalizeMessage(baseEvent(), target, 0.2, random)?.trigger, false);
  assert.equal(randomCalls, 2);
  assert.equal(normalizeMessage(baseEvent({ message: [at('888')] }), target, 1, random)?.trigger, false);
  assert.equal(normalizeMessage(baseEvent({ message: [reply('robot-message'), text('引用机器人')] }), target, 0, random)?.trigger, false);
});

test('pure stickers remain stored without probability sampling; text and ordinary images can trigger', () => {
  const neverSample = () => { throw new Error('pure stickers must not sample'); };
  for (const segment of [
    { type: 'face', data: { id: '1' } }, { type: 'mface', data: { summary: '表情' } },
    { type: 'bface', data: {} }, { type: 'sface', data: {} },
    { type: 'image', data: { sub_type: 1, file: 'sticker.gif' } },
    { type: 'image', data: { subtype: '1', file: 'sticker.gif' } },
    { type: 'image', data: { file: 'marketface', url: 'https://example.com/sticker.gif' } },
    { type: 'image', data: { emoji_id: 'abc', url: 'https://example.com/sticker.gif' } },
    { type: 'image', data: { emoji_package_id: 123, url: 'https://example.com/sticker.gif' } },
  ]) {
    const normalized = normalizeMessage(baseEvent({ message: [reply('1'), at('888'), text(' \n'), segment] }), target, 1, neverSample);
    assert.ok(normalized);
    assert.equal(normalized.trigger, false);
    assert.match(normalized.text, /表情包/);
  }
  for (const message of [
    [{ type: 'image', data: { sub_type: 0, file: 'photo.png' } }],
    [{ type: 'face', data: { id: '1' } }, text('这是什么')],
    [{ type: 'file', data: { name: 'report.txt' } }],
  ]) assert.equal(normalizeMessage(baseEvent({ message }), target, 0.5, () => 0.1)?.trigger, true);
});

test('private messages trigger normally, including sticker messages', () => {
  const event = baseEvent({ message_type: 'private', message: [{ type: 'face', data: { id: '1' } }] });
  assert.equal(normalizeMessage(event, { type: 'private', id: '123' }, 0, () => { throw new Error('must not sample private'); })?.trigger, true);
});

test('bridge commands accept exact text with optional self mention and bypass group probability', () => {
  const neverSample = () => { throw new Error('commands must not sample'); };
  for (const name of ['new', 'compact', 'help'] as const) {
    for (const message of [
      [text(` /${name}\n`)],
      [reply('-100'), at('999'), text(` /${name} `)],
      [text('/'), text(name)],
      `[CQ:at,qq=999] /${name}`,
    ]) {
      const normalized = normalizeMessage(baseEvent({ message }), target, 0.5, neverSample);
      assert.equal(normalized?.command, name);
      assert.equal(normalized?.trigger, true);
    }
    const privateMessage = normalizeMessage(baseEvent({ message_type: 'private', message: [text(`/${name}`)] }),
      { type: 'private', id: '123' }, 0, neverSample);
    assert.equal(privateMessage?.command, name);
  }
});

test('quoted command text, arguments, other mentions and attachments remain ordinary messages', () => {
  for (const name of ['new', 'compact', 'help']) {
    for (const message of [
      [text(`解释 /${name}`)], [text(`/${name} please`)], [text(`/${name}\n其他内容`)], [text(`/${name.toUpperCase()}`)],
      [at('888'), text(`/${name}`)], [at('all'), text(`/${name}`)],
      [text(`/${name}`), { type: 'image', data: { file: 'photo.png' } }],
      [text(`/${name}`), { type: 'face', data: { id: '1' } }],
      [text(`[CQ:at,qq=999] /${name}`)],
    ]) assert.equal(normalizeMessage(baseEvent({ message }), target, 0)?.command, undefined);
    assert.equal(normalizeMessage(baseEvent({ group_id: 1002, message: [text(`/${name}`)] }), target, 0), null);
    assert.equal(normalizeMessage(baseEvent({ user_id: 999, message: [text(`/${name}`)] }), target, 0), null);
    assert.equal(normalizeMessage(baseEvent({ post_type: 'message_sent', message: [text(`/${name}`)] }), target, 0), null);
  }
});

test('CQ strings preserve reply and mention semantics and decode entities once after parsing', () => {
  const message = '[CQ:reply,id=-100][CQ:at,qq=999]你好 &amp; &#91;x&#93;[CQ:image,file=https://x/?a=1&amp;b=2&#44;3,sub_type=0]';
  const normalized = normalizeMessage(baseEvent({ message }), target, 0);
  assert.ok(normalized);
  assert.equal(normalized.replyTo, '-100');
  assert.equal(normalized.trigger, true);
  assert.match(normalized.text, /你好 & \[x\]/);
  assert.match(normalized.text, /https:\/\/x\/\?a=1&b=2,3/);
  const escaped = normalizeMessage(baseEvent({ message: '&#91;CQ:at,qq=999&#93; &amp;#91;' }), target, 0);
  assert.equal(escaped?.trigger, false);
  assert.equal(escaped?.text, '[CQ:at,qq=999] &#91;');
  assert.equal(normalizeMessage(baseEvent({ message: '[CQ:face,id=1][CQ:image,sub_type=1,file=a.gif]' }), target, 1)?.trigger, false);
});

test('image sources prefer HTTP URLs and accept portable file URLs or inline Base64 in segment order', () => {
  const event = baseEvent({ message: [
    text('查看图片'),
    { type: 'image', data: { sub_type: 0, url: 'https://example.com/preferred.png', file: 'https://example.com/fallback.png' } },
    { type: 'image', data: { url: '/napcat/cache/local.png', file: 'http://example.com/fallback.png' } },
    { type: 'image', data: { file: 'base64://aGVsbG8=' } },
    { type: 'image', data: { url: 'file:///napcat/photo.png', file: 'photo.png' } },
    { type: 'image', data: { url: 'https://', file: 'file:///napcat/photo.png' } },
    { type: 'file', data: { url: 'https://example.com/file.png' } },
  ] });
  assert.deepEqual(imageSources(JSON.stringify(event)), [
    'https://example.com/preferred.png', 'http://example.com/fallback.png', 'base64://aGVsbG8=',
  ]);
});

test('image sources decode CQ parameters and exclude custom and marketplace stickers', () => {
  const cq = '[CQ:image,file=https://example.com/photo?a=1&amp;b=2&#44;3,sub_type=0]'
    + '[CQ:image,file=https://example.com/custom.gif,sub_type=1]'
    + '[CQ:image,url=https://example.com/market.gif,emoji_id=abc,emoji_package_id=123]';
  assert.deepEqual(imageSources(JSON.stringify(baseEvent({ message: cq }))), ['https://example.com/photo?a=1&b=2,3']);
  const stickers = [
    { type: 'image', data: { subtype: '1', url: 'https://example.com/custom.gif' } },
    { type: 'image', data: { file: 'marketface', url: 'https://example.com/market.gif' } },
    { type: 'image', data: { emoji_package_id: 123, url: 'https://example.com/market.gif' } },
    { type: 'mface', data: { url: 'https://example.com/market.gif' } },
  ];
  assert.deepEqual(imageSources(JSON.stringify(baseEvent({ message: stickers }))), []);
});

test('image sources ignore malformed or non-message data without throwing', () => {
  for (const raw of ['invalid', 'null', '[]', '{}', '{"message":null}', '{"message":[{"data":{}}]}']) {
    assert.deepEqual(imageSources(raw), []);
  }
});

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'condition timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function fixture(t: TestContext, options: { target?: Target; actionTimeoutMs?: number } = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const events: unknown[] = [];
  const logs: string[] = [];
  const connections: WebSocket[] = [];
  const requests: Record<string, unknown>[] = [];
  const authorization: (string | undefined)[] = [];
  const logger: Logger = {
    info: value => logs.push(value), warn: value => logs.push(value), error: value => logs.push(value),
  };
  server.on('connection', (socket, request) => {
    connections.push(socket);
    authorization.push(request.headers.authorization);
    socket.on('message', data => requests.push(JSON.parse(data.toString()) as Record<string, unknown>));
  });
  const client = new NapCatClient({
    url: `ws://127.0.0.1:${address.port}`, token: 'test-secret', target: options.target ?? target,
    reconnectMs: 10, actionTimeoutMs: options.actionTimeoutMs ?? 1_000,
    logger, onEvent: event => events.push(event),
  });
  t.after(async () => {
    await client.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const sendResponse = (request: Record<string, unknown>, overrides: Record<string, unknown> = {}, socket = connections.at(-1)!) => {
    socket.send(JSON.stringify({ echo: request.echo, status: 'ok', retcode: 0, data: { message_id: 100 }, ...overrides }));
  };
  return { server, client, events, logs, connections, requests, authorization, sendResponse };
}

test('client authenticates, waits for connection, correlates echoes, receives events and sends literal text', async t => {
  const f = await fixture(t);
  f.client.start();
  const controller = new AbortController();
  const first = f.client.sendText('[CQ:at,qq=all]', controller.signal);
  const second = f.client.sendText('第二条', controller.signal);
  await waitFor(() => f.requests.length === 2);
  assert.deepEqual(f.authorization, ['Bearer test-secret']);
  assert.notEqual(f.requests[0]!.echo, f.requests[1]!.echo);
  assert.equal(f.requests[0]!.action, 'send_group_msg');
  assert.deepEqual(f.requests[0]!.params, { group_id: '1001', message: [text('[CQ:at,qq=all]')] });
  f.sendResponse(f.requests[1]!);
  await second;
  let firstDone = false;
  void first.then(() => { firstDone = true; });
  f.sendResponse({ echo: 'unrelated' });
  f.connections[0]!.send(JSON.stringify(baseEvent()));
  await waitFor(() => f.events.length === 1);
  assert.equal(firstDone, false);
  f.sendResponse(f.requests[0]!);
  await first;
  assert.deepEqual(f.events, [baseEvent()]);
});

test('API and connection logs retain correlation, status and timing without payloads or server reasons', async t => {
  const f = await fixture(t);
  f.client.start();
  const signal = new AbortController().signal;
  const sending = f.client.sendText('sensitive-outgoing-text [CQ:at,qq=all]', signal);
  await waitFor(() => f.requests.length === 1);
  const firstEcho = f.requests[0]!.echo as string;
  f.sendResponse(f.requests[0]!);
  await sending;
  const failed = assert.rejects(f.client.sendImage('base64://sensitive-image', signal), /NapCat API request failed/);
  await waitFor(() => f.requests.length === 2);
  const secondEcho = f.requests[1]!.echo as string;
  f.sendResponse(f.requests[1]!, { status: 'failed', retcode: 1200, message: 'sensitive-api-error', wording: 'sensitive-wording' });
  await failed;
  f.connections[0]!.close(1000, 'sensitive-close-reason');
  await waitFor(() => f.connections.length === 2);
  const logs = f.logs.join('\n');
  assert.match(logs, /napcat\.connection\.started timeout_ms=1000/);
  assert.match(logs, /napcat\.connection\.connected duration_ms=\d+/);
  assert.ok(f.logs.some(line => line.startsWith('napcat.api.send_started ') && line.includes(`echo="${firstEcho}"`) && line.includes('action="send_group_msg"') && line.includes('segment_count=1')));
  assert.ok(f.logs.some(line => line.startsWith('napcat.api.succeeded ') && line.includes(`echo="${firstEcho}"`) && line.includes('retcode=0') && /duration_ms=\d+/.test(line)));
  assert.ok(f.logs.some(line => line.startsWith('napcat.api.failed ') && line.includes(`echo="${secondEcho}"`) && line.includes('reason="api_rejected"') && line.includes('retcode=1200') && line.includes('pending_count=0')));
  assert.match(logs, /napcat\.connection\.closed code=1000 reconnecting=true/);
  assert.match(logs, /napcat\.connection\.reconnect_scheduled retry_ms=10/);
  assert.doesNotMatch(logs, /sensitive-|test-secret|127\.0\.0\.1|base64:\/\/|\[CQ:/);
});

test('delivery errors distinguish explicit rejection, missing receipt and failure before sending', async t => {
  const f = await fixture(t, { actionTimeoutMs: 80 });
  const signal = new AbortController().signal;
  await assert.rejects(f.client.sendText('before start', signal), { code: 'NAPCAT_CONNECTION_UNAVAILABLE', deliveryStatus: 'failed' });
  assert.equal(f.requests.length, 0);
  f.client.start();
  const rejected = assert.rejects(f.client.sendText('rejected', signal), { code: 'NAPCAT_API_REJECTED', deliveryStatus: 'failed', retcode: 1200 });
  await waitFor(() => f.requests.length === 1);
  f.sendResponse(f.requests[0]!, { status: 'failed', retcode: 1200, message: 'sensitive-provider-message' });
  await rejected;
  const timeout = assert.rejects(f.client.sendText('lost receipt', signal), { code: 'NAPCAT_RESPONSE_TIMEOUT', deliveryStatus: 'unconfirmed' });
  await waitFor(() => f.requests.length === 2);
  await timeout;
  assert.doesNotMatch(f.logs.join('\n'), /sensitive-provider-message/);
});

test('private send uses send_private_msg and only ok plus zero retcode confirms success', async t => {
  const f = await fixture(t, { target: { type: 'private', id: '123' } });
  f.client.start();
  for (const [index, response] of [{ status: 'failed', retcode: 0 }, { status: 'ok', retcode: 1200 }].entries()) {
    const sending = f.client.sendText('hi', new AbortController().signal);
    const rejection = assert.rejects(sending, /NapCat API request failed/);
    await waitFor(() => f.requests.length === index + 1);
    assert.equal(f.requests[index]!.action, 'send_private_msg');
    assert.deepEqual(f.requests[index]!.params, { user_id: '123', message: [text('hi')] });
    f.sendResponse(f.requests[index]!, response);
    await rejection;
  }
});

test('group segment replies preserve multiple and inline mentions in one acknowledged QQ message', async t => {
  const f = await fixture(t);
  f.client.start();
  const signal = new AbortController().signal;
  const sending = f.client.sendMessage([
    { type: 'at', userId: '123' },
    { type: 'text', text: ' 你的问题，以及 ' },
    { type: 'at', userId: '456' },
    { type: 'text', text: ' 的补充：[CQ:at,qq=all]' },
  ], signal);
  let done = false;
  void sending.then(() => { done = true; });
  await waitFor(() => f.requests.length === 1);
  assert.equal(f.requests[0]!.action, 'send_group_msg');
  assert.deepEqual(f.requests[0]!.params, {
    group_id: '1001', message: [at('123'), text(' 你的问题，以及 '), at('456'), text(' 的补充：[CQ:at,qq=all]')],
  });
  assert.equal(done, false, '所有消息段共同等待同一个发送回执');
  f.sendResponse(f.requests[0]!);
  await sending;
  assert.equal(done, true);
  assert.equal(f.requests.length, 1);
});

test('segment replies reject private targets and invalid segments before sending', async t => {
  const group = await fixture(t);
  const privateClient = await fixture(t, { target: { type: 'private', id: '123' } });
  group.client.start();
  privateClient.client.start();
  const signal = new AbortController().signal;
  for (const segments of [[{ type: 'at', userId: '456' }], [{ type: 'text', text: '正文' }]] as MessageSegment[][]) {
    await assert.rejects(privateClient.client.sendMessage(segments, signal), /require a group target/);
  }
  for (const segments of [
    [], null, {}, [{ type: 'at', userId: 'all' }], [{ type: 'at', userId: '00123' }],
    [{ type: 'at', userId: '' }], [{ type: 'at', userId: 123 }], [{ type: 'at', userId: '-123' }],
    [{ type: 'at', userId: '123', extra: true }], [{ type: 'text', text: '' }],
    [{ type: 'text', text: 123 }],
    [{ type: 'image', path: '/tmp/image.png' }], [{ type: 'reply', messageId: '1' }],
  ]) {
    await assert.rejects(group.client.sendMessage(segments as MessageSegment[], signal), /Invalid outgoing message segments/);
  }
  assert.equal(group.requests.length, 0);
  assert.equal(privateClient.requests.length, 0);
});

test('segment replies reject failed acknowledgements and can retry using the same connection', async t => {
  const f = await fixture(t);
  f.client.start();
  const signal = new AbortController().signal;
  const segments: MessageSegment[] = [{ type: 'at', userId: '123' }, { type: 'text', text: ' 答复' }];
  const rejected = assert.rejects(f.client.sendMessage(segments, signal), /NapCat API request failed/);
  await waitFor(() => f.requests.length === 1);
  f.sendResponse(f.requests[0]!, { status: 'failed', retcode: 1200 });
  await rejected;
  const retry = f.client.sendMessage(segments, signal);
  await waitFor(() => f.requests.length === 2);
  assert.deepEqual(f.requests[0]!.params, f.requests[1]!.params);
  assert.notEqual(f.requests[0]!.echo, f.requests[1]!.echo);
  f.sendResponse(f.requests[1]!);
  await retry;
  assert.equal(f.connections.length, 1);
});

test('segment replies share disconnect recovery and reject stale acknowledgements', async t => {
  const f = await fixture(t);
  f.client.start();
  const signal = new AbortController().signal;
  const segments: MessageSegment[] = [{ type: 'at', userId: '123' }, { type: 'text', text: ' 答复' }];
  const rejected = assert.rejects(f.client.sendMessage(segments, signal), /connection lost/);
  await waitFor(() => f.requests.length === 1);
  f.connections[0]!.terminate();
  await rejected;
  await waitFor(() => f.connections.length === 2);
  const retry = f.client.sendMessage(segments, signal);
  await waitFor(() => f.requests.length === 2);
  let done = false;
  void retry.then(() => { done = true; });
  f.sendResponse(f.requests[0]!);
  f.connections[1]!.send(JSON.stringify(baseEvent()));
  await waitFor(() => f.events.length === 1);
  assert.equal(done, false);
  f.sendResponse(f.requests[1]!);
  await retry;
});

test('group images use ordinary image segments and correlate their acknowledgements with concurrent text sends', async t => {
  const f = await fixture(t);
  f.client.start();
  const signal = new AbortController().signal;
  const image = f.client.sendImage('base64://aGVsbG8=', signal);
  const message = f.client.sendText('图片说明', signal);
  await waitFor(() => f.requests.length === 2);
  assert.equal(f.requests[0]!.action, 'send_group_msg');
  assert.deepEqual(f.requests[0]!.params, {
    group_id: '1001', message: [{ type: 'image', data: { file: 'base64://aGVsbG8=', sub_type: 0 } }],
  });
  assert.notEqual(f.requests[0]!.echo, f.requests[1]!.echo);
  let imageDone = false;
  void image.then(() => { imageDone = true; });
  f.sendResponse(f.requests[1]!);
  await message;
  assert.equal(imageDone, false);
  f.sendResponse(f.requests[0]!);
  await image;
});

test('private images reject failed echoes and can send another image using the same connection', async t => {
  const f = await fixture(t, { target: { type: 'private', id: '123' } });
  f.client.start();
  const signal = new AbortController().signal;
  const rejected = assert.rejects(f.client.sendImage('base64://ZmFpbA==', signal), /NapCat API request failed/);
  await waitFor(() => f.requests.length === 1);
  assert.equal(f.requests[0]!.action, 'send_private_msg');
  assert.deepEqual(f.requests[0]!.params, {
    user_id: '123', message: [{ type: 'image', data: { file: 'base64://ZmFpbA==', sub_type: 0 } }],
  });
  f.sendResponse(f.requests[0]!, { status: 'failed', retcode: 1200 });
  await rejected;
  const sending = f.client.sendImage('base64://b2s=', signal);
  await waitFor(() => f.requests.length === 2);
  f.sendResponse(f.requests[1]!);
  await sending;
  assert.equal(f.connections.length, 1);
});

for (const voiceTarget of [target, { type: 'private', id: '123' } satisfies Target]) {
  test(`${voiceTarget.type} voice replies send one native record segment and await the matching acknowledgement`, async t => {
    const f = await fixture(t, { target: voiceTarget });
    f.client.start();
    const sending = f.client.sendVoice(voiceSnapshot, new AbortController().signal);
    let done = false;
    void sending.then(() => { done = true; });
    await waitFor(() => f.requests.length === 1);
    assert.equal(f.requests[0]!.action, voiceTarget.type === 'group' ? 'send_group_msg' : 'send_private_msg');
    assert.deepEqual(f.requests[0]!.params, {
      [voiceTarget.type === 'group' ? 'group_id' : 'user_id']: voiceTarget.id,
      message: [{ type: 'record', data: { file: voiceSnapshot } }],
    });
    assert.equal(done, false);
    f.sendResponse({ echo: 'unrelated' });
    f.connections[0]!.send(JSON.stringify(baseEvent()));
    await waitFor(() => f.events.length === 1);
    assert.equal(done, false);
    f.sendResponse(f.requests[0]!);
    await sending;
    assert.equal(f.requests.length, 1);
    assert.doesNotMatch(f.logs.join('\n'), /base64:\/\/|upload_.*file|\/tmp\//);
  });
}

test('voice replies reject non-MP3 or nonportable sources before making any API request', async t => {
  const f = await fixture(t);
  f.client.start();
  for (const file of ['', '/tmp/audio.mp3', 'file:///tmp/audio.mp3', 'https://example.com/audio.mp3',
    'base64://', 'base64://aGVsbG8=', 'base64://////']) {
    await assert.rejects(f.client.sendVoice(file, new AbortController().signal), /Invalid outgoing voice snapshot/);
  }
  assert.equal(f.requests.length, 0);
});

test('voice replies reject failed ACKs, support cancellation and ignore cancelled send acknowledgements', async t => {
  const f = await fixture(t);
  f.client.start();
  const signal = new AbortController().signal;
  const failed = assert.rejects(f.client.sendVoice(voiceSnapshot, signal), /NapCat API request failed/);
  await waitFor(() => f.requests.length === 1);
  f.sendResponse(f.requests[0]!, { status: 'failed', retcode: 1200, message: 'private voice error' });
  await failed;

  const controller = new AbortController();
  const cancelled = assert.rejects(f.client.sendVoice(voiceSnapshot, controller.signal), { name: 'AbortError' });
  await waitFor(() => f.requests.length === 2);
  controller.abort();
  await cancelled;
  const retry = f.client.sendVoice(voiceSnapshot, signal);
  let done = false;
  void retry.then(() => { done = true; });
  await waitFor(() => f.requests.length === 3);
  f.sendResponse(f.requests[1]!);
  f.connections[0]!.send(JSON.stringify(baseEvent()));
  await waitFor(() => f.events.length === 1);
  assert.equal(done, false);
  assert.deepEqual(f.requests[0]!.params, f.requests[2]!.params);
  assert.notEqual(f.requests[1]!.echo, f.requests[2]!.echo);
  f.sendResponse(f.requests[2]!);
  await retry;
  assert.equal(f.connections.length, 1);
  assert.doesNotMatch(f.logs.join('\n'), /base64:\/\/|private voice error/);
});

test('image sends use the shared timeout and reconnect flow and accept no stale acknowledgement', async t => {
  const f = await fixture(t, { actionTimeoutMs: 50 });
  f.client.start();
  const signal = new AbortController().signal;
  const timedOut = assert.rejects(f.client.sendImage('base64://Zmlyc3Q=', signal), /timed out/);
  await waitFor(() => f.requests.length === 1);
  await timedOut;
  await waitFor(() => f.connections.length === 2);
  const sending = f.client.sendImage('base64://bmV4dA==', signal);
  await waitFor(() => f.requests.length === 2);
  let imageDone = false;
  void sending.then(() => { imageDone = true; });
  f.sendResponse(f.requests[0]!);
  f.connections[1]!.send(JSON.stringify(baseEvent()));
  await waitFor(() => f.events.length === 1);
  assert.equal(imageDone, false);
  f.sendResponse(f.requests[1]!);
  await sending;
});

test('pending sends reject on disconnect and new sends work after reconnect', async t => {
  const f = await fixture(t);
  f.client.start();
  const sending = f.client.sendText('first', new AbortController().signal);
  const rejection = assert.rejects(sending, /connection lost/);
  await waitFor(() => f.requests.length === 1);
  f.connections[0]!.terminate();
  await rejection;
  await waitFor(() => f.connections.length === 2);
  const next = f.client.sendText('next', new AbortController().signal);
  await waitFor(() => f.requests.length === 2);
  f.sendResponse(f.requests[1]!);
  await next;
});

test('API timeout terminates the socket and reconnects before the next send', async t => {
  const f = await fixture(t, { actionTimeoutMs: 50 });
  f.client.start();
  const timedOut = assert.rejects(f.client.sendText('timeout', new AbortController().signal), /timed out/);
  await waitFor(() => f.requests.length === 1);
  await timedOut;
  await waitFor(() => f.connections.length === 2);
  assert.equal(f.connections[0]!.readyState, WebSocket.CLOSED);
  const next = f.client.sendText('after timeout', new AbortController().signal);
  await waitFor(() => f.requests.length === 2);
  let nextDone = false;
  void next.then(() => { nextDone = true; });
  f.sendResponse(f.requests[0]!);
  f.connections[1]!.send(JSON.stringify(baseEvent()));
  await waitFor(() => f.events.length === 1);
  assert.equal(nextDone, false);
  f.sendResponse(f.requests[1]!);
  await next;
  assert.match(f.logs.join('\n'), /napcat\.api\.timeout .*reason="response_timeout".*duration_ms=\d+/);
});

test('abort rejects without accepting late acknowledgements', async t => {
  const f = await fixture(t);
  f.client.start();
  const controller = new AbortController();
  const sending = f.client.sendText('abort', controller.signal);
  const rejection = assert.rejects(sending, { name: 'AbortError' });
  await waitFor(() => f.requests.length === 1);
  controller.abort();
  await rejection;
  f.sendResponse(f.requests[0]!);
});

test('authentication failures without echo terminate the socket and log only a static message', async t => {
  const f = await fixture(t);
  let failures = 0;
  f.server.on('connection', socket => {
    if (failures++ >= 2) return;
    socket.send(JSON.stringify({
      status: 'failed', retcode: 1403,
      ...(failures === 1 ? { echo: null } : {}),
      message: 'sensitive-packet-value test-secret ws://secret-host/?access_token=secret',
    }));
  });
  f.client.start();
  await waitFor(() => f.connections.length === 3);
  assert.equal(f.connections[0]!.readyState, WebSocket.CLOSED);
  assert.equal(f.connections[1]!.readyState, WebSocket.CLOSED);
  assert.equal(f.logs.filter(log => log === 'NapCat WebSocket authentication failed; reconnecting').length, 2);
  assert.doesNotMatch(f.logs.join('\n'), /sensitive-packet-value|test-secret|secret-host|access_token/);
  const sending = f.client.sendText('after auth reconnect', new AbortController().signal);
  await waitFor(() => f.requests.length === 1);
  f.sendResponse(f.requests[0]!);
  await sending;
});

test('stop rejects pending sends, prevents reconnect and is idempotent', async t => {
  const f = await fixture(t);
  f.client.start();
  f.client.start();
  const sending = f.client.sendText('pending', new AbortController().signal);
  const rejection = assert.rejects(sending, /client stopped/);
  await waitFor(() => f.requests.length === 1);
  await f.client.stop();
  await rejection;
  await f.client.stop();
  await assert.rejects(f.client.sendText('later', new AbortController().signal), /client stopped/);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.connections.length, 1);
  assert.match(f.logs.join('\n'), /napcat\.stopping pending_count=1/);
  assert.match(f.logs.join('\n'), /napcat\.api\.failed .*reason="stopped"/);
});

test('stop and abort also reject while establishing a connection', async t => {
  const f = await fixture(t);
  f.client.start();
  const controller = new AbortController();
  const abortedSend = assert.rejects(f.client.sendText('abort', controller.signal), { name: 'AbortError' });
  controller.abort();
  await abortedSend;
  const stoppedSend = assert.rejects(f.client.sendText('stop', new AbortController().signal), /client stopped/);
  await f.client.stop();
  await stoppedSend;
});

test('connection errors never log URL credentials or the configured token', async t => {
  const logs: string[] = [];
  const client = new NapCatClient({
    url: 'ws://127.0.0.1:1/?access_token=url-secret', token: 'header-secret', target,
    reconnectMs: 10, actionTimeoutMs: 50,
    logger: { info: x => logs.push(x), warn: x => logs.push(x), error: x => logs.push(x) },
    onEvent: () => {},
  });
  t.after(() => client.stop());
  client.start();
  await waitFor(() => logs.some(line => line.startsWith('napcat.connection.error ')));
  assert.doesNotMatch(logs.join('\n'), /url-secret|header-secret|127\.0\.0\.1/);
});
