import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { get as httpGet, type ClientRequest, type ServerResponse } from 'node:http';
import { test, type TestContext } from 'node:test';
import Fastify from 'fastify';
import { WebSocketServer, type WebSocket } from 'ws';
import { ConsoleDatabase } from '../src/console/database.js';
import { NapcatGateway } from '../src/console/napcat-gateway.js';
import { defaultSettings } from '../src/console/settings.js';
import { NAPCAT_EVENT_MAX_BYTES, NAPCAT_MEDIA_MAX_BYTES, NAPCAT_SSE_MAX_BYTES, type NapcatSendRequest } from '../src/transport-protocol.js';

async function waitFor(condition: () => boolean, timeout = 2000): Promise<void> {
  const end = Date.now() + timeout;
  while (!condition()) { assert.ok(Date.now() < end, 'condition timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
const message = (group = '1001', messageId = '1', extra: Record<string, unknown> = {}) => ({
  post_type: 'message', message_type: 'group', group_id: group, user_id: '123', self_id: '999', message_id: messageId,
  time: 1792727200, message: [{ type: 'text', data: { text: 'sensitive-incoming-content' } }], ...extra,
});

async function fixture(t: TestContext, overrides: { paused?: boolean; maxConcurrentSends?: number; actionTimeout?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'nekodock-gateway-'));
  const db = new ConsoleDatabase(join(directory, 'console.sqlite3'), join(directory, 'master.key'));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const sockets: WebSocket[] = []; const requests: Record<string, unknown>[] = []; const logs: string[] = [];
  let online = true;
  server.on('connection', socket => {
    sockets.push(socket);
    socket.on('message', raw => {
      const request = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (request.action === 'get_status' || request.action === 'get_login_info') {
        socket.send(JSON.stringify({ status: 'ok', retcode: 0, echo: request.echo,
          data: request.action === 'get_status' ? { online, good: true } : { user_id: '999' } }));
      } else requests.push(request);
    });
  });
  const connection = db.createNapcatConnection({ name: 'Shared connection', wsUrl: `ws://127.0.0.1:${address.port}`, token: 'synthetic-token', actionTimeout: overrides.actionTimeout ?? 1, reconnectSeconds: 1, enabled: true });
  const createBot = (targetId: string, targetType: 'group' | 'private' = 'group') => {
    const bot = db.createBot({ name: `Bot ${targetId}`, targetType, targetId, connectionId: connection.id, config: defaultSettings() });
    db.setDesiredState(bot.id, 'running'); db.setRuntime(bot.id, { state: 'running' }); return bot;
  };
  const first = createBot('1001'); const second = createBot('1002'); const privateBot = createBot('123', 'private');
  const paused = new Set<string>(overrides.paused ? [first.id] : []);
  const gateway = new NapcatGateway({ db, logger: { info: text => logs.push(text), warn: text => logs.push(text), error: text => logs.push(text) },
    canDeliver: botId => !paused.has(botId) && db.getBot(botId)?.desiredState === 'running',
    maxConcurrentSends: overrides.maxConcurrentSends, heartbeatMs: 30, healthIntervalMs: 100, shutdownTimeoutMs: 50 });
  const app = Fastify();
  const httpResponses = new Map<string, ServerResponse>();
  app.get<{ Params: { id: string } }>('/events/:id', async (req, reply) => {
    httpResponses.set(req.params.id, reply.raw); gateway.openStream(req.params.id, req, reply);
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const httpAddress = app.server.address(); assert.ok(httpAddress && typeof httpAddress !== 'string');
  const streams: AbortController[] = [];
  const pausedRequests: ClientRequest[] = [];
  const openPaused = async (botId: string) => {
    const request = httpGet(`http://127.0.0.1:${httpAddress.port}/events/${botId}`);
    pausedRequests.push(request);
    const [response] = await once(request, 'response');
    response.pause(); return response as import('node:http').IncomingMessage;
  };
  const open = async (botId: string) => {
    const controller = new AbortController(); streams.push(controller);
    const response = await fetch(`http://127.0.0.1:${httpAddress.port}/events/${botId}`, { signal: controller.signal });
    assert.equal(response.status, 200); const reader = response.body!.getReader();
    const events: { type: string; data: Record<string, unknown> }[] = []; let buffer = '';
    const reading = (async () => {
      try {
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break;
          buffer += Buffer.from(chunk.value).toString();
          let end;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            const type = /^event: (.+)$/m.exec(frame)?.[1]; const data = /^data: (.+)$/m.exec(frame)?.[1];
            if (type && data) events.push({ type, data: JSON.parse(data) });
          }
        }
      } catch { /* Test cleanup or a deliberately disconnected stream. */ }
    })();
    return { events, close: async () => { controller.abort(); await reading; } };
  };
  t.after(async () => {
    for (const request of pausedRequests) request.destroy();
    for (const stream of streams) stream.abort();
    await gateway.close(); await app.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.close(); await rm(directory, { recursive: true, force: true });
  });
  await gateway.reconcile(); await waitFor(() => gateway.getConnectionStatus(connection.id).online);
  const emit = (event: unknown) => sockets.at(-1)!.send(JSON.stringify(event));
  const answer = (request: Record<string, unknown>, extra: Record<string, unknown> = {}) => sockets.at(-1)!.send(JSON.stringify({ status: 'ok', retcode: 0, echo: request.echo, data: { message_id: '555' }, ...extra }));
  const send = (botId: string, deliveryId: string, text = 'sensitive-outgoing-content', duration = 1500) => gateway.send(botId, { deliveryId, kind: 'text', text, deadline: Date.now() + duration });
  const video = async () => {
    const baseUrl = `http://127.0.0.1:${httpAddress.port}`;
    db.updateNapcatConnection(connection.id, { mediaBaseUrl: baseUrl });
    const asset = await db.pluginAssets.upload(join(directory, 'media'), first.id,
      Readable.from([Buffer.from('0000ftypisom0000', 'ascii')]), { maxBytes: 1024, cacheMaxBytes: 1024, cacheHours: 1 });
    return db.pluginAssets.signedUrl(first.id, asset, baseUrl);
  };
  return { db, gateway, connection, first, second, privateBot, paused, sockets, requests, logs, open, openPaused, httpResponses, emit, answer, send, video, setOnline: (value: boolean) => { online = value; } };
}

test('one shared WebSocket routes group and private messages without applying reply probability', async t => {
  const f = await fixture(t);
  const first = await f.open(f.first.id); const second = await f.open(f.second.id); const privateStream = await f.open(f.privateBot.id);
  f.emit(message('1001')); f.emit(message('1002', '2')); f.emit(message('1003', '3'));
  f.emit(message('1001', '4', { message_type: 'private' }));
  f.emit(message('1001', '5', { user_id: '999' })); f.emit(message('1001', '6', { post_type: 'message_sent' }));
  await waitFor(() => [first, second, privateStream].every(stream => stream.events.some(event => event.type === 'message')));
  assert.equal(f.sockets.length, 1);
  for (const stream of [first, second, privateStream]) assert.equal(stream.events.filter(event => event.type === 'message').length, 1);
  assert.equal(f.db.pendingNapcatEventCount(f.first.id), 1);
  assert.equal((first.events.find(event => event.type === 'message')!.data.event as Record<string, unknown>).message_id, '1');
  assert.ok(first.events.some(event => event.type === 'status' && event.data.connected === true && event.data.online === true));
  assert.doesNotMatch(f.logs.join('\n'), /sensitive-|synthetic-token|127\.0\.0\.1/);
});

test('forward expansion shares the existing socket and delivers content updates with independent ACKs', async t => {
  const f = await fixture(t);
  const stream = await f.open(f.first.id);
  f.emit(message('1001', 'forward-outer', {message: [{type: 'forward', data: {id: 'private-forward-resource'}}]}));
  await waitFor(() => f.requests.some(request => request.action === 'get_forward_msg') && stream.events.some(event => event.type === 'message'));
  const original = stream.events.find(event => event.type === 'message')!;
  assert.equal((original.data.forwards as {contents: Array<{status: string}>}).contents[0]!.status, 'pending');
  assert.equal(f.sockets.length, 1);
  const request = f.requests.find(request => request.action === 'get_forward_msg')!;
  assert.deepEqual(request.params, {message_id: 'private-forward-resource'});
  f.answer(request, {data: {messages: [{sender: {nickname: 'Original'}, user_id: '321', time: 100,
    message: [{type: 'text', data: {text: 'forwarded discussion'}}, {type: 'forward', data: {id: 'inner-short-id', content: [{sender: {nickname: 'Nested'}, user_id: '432', time: 90, message: [{type: 'text', data: {text: 'nested discussion'}}]}]}}]}]}});
  await waitFor(() => f.db.forwards.get(f.first.id, 'forward-outer')!.contents[0]!.status === 'ready');
  assert.equal(stream.events.some(event => event.type === 'content-update'), false);
  f.gateway.acknowledge(f.first.id, original.data.seq as number);
  await waitFor(() => stream.events.some(event => event.type === 'content-update'));
  const update = stream.events.find(event => event.type === 'content-update')!;
  assert.equal(update.data.event, null);
  assert.match(JSON.stringify(update.data.update), /nested discussion/);
  assert.equal(f.requests.filter(request => request.action === 'get_forward_msg').length, 1);
  f.gateway.acknowledge(f.first.id, update.data.seq as number);
  assert.equal(f.db.pendingNapcatEventCount(f.first.id), 0);
  assert.doesNotMatch(f.logs.join('\n'), /forwarded discussion|private-forward-resource|inner-short-id/);
});

test('the same forward resource across routed targets shares one in-flight API request', async t => {
  const f = await fixture(t);
  const segment = [{type: 'forward', data: {id: 'shared-forward-resource'}}];
  f.emit(message('1001', 'first-forward', {message: segment}));
  f.emit(message('1002', 'second-forward', {message: segment}));
  await waitFor(() => f.requests.some(request => request.action === 'get_forward_msg'));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.requests.filter(request => request.action === 'get_forward_msg').length, 1);
  f.answer(f.requests.find(request => request.action === 'get_forward_msg')!, {data: {messages: [{sender: {nickname: 'Shared'}, user_id: '321', time: 100, message: [{type: 'text', data: {text: 'shared content'}}]}]}});
  await waitFor(() => [f.first, f.second].every(bot => f.db.forwards.get(bot.id, bot.id === f.first.id ? 'first-forward' : 'second-forward')?.contents[0]?.status === 'ready'));
  assert.equal(f.db.forwards.get(f.privateBot.id, 'first-forward'), null);
  assert.equal(f.sockets.length, 1);
});

test('SSE holds one unacknowledged event, reconnect replays it and duplicate ACKs remain safe', async t => {
  const f = await fixture(t); const first = await f.open(f.first.id);
  f.emit(message()); f.emit(message('1001', '2'));
  await waitFor(() => f.db.pendingNapcatEventCount(f.first.id) === 2 && first.events.some(event => event.type === 'message'));
  assert.equal(first.events.filter(event => event.type === 'message').length, 1);
  const seq = first.events.find(event => event.type === 'message')!.data.seq as number;
  assert.throws(() => f.gateway.acknowledge(f.first.id, seq + 1), /序号无效/);
  await first.close(); const reconnected = await f.open(f.first.id);
  await waitFor(() => reconnected.events.some(event => event.type === 'message'));
  assert.equal(reconnected.events.find(event => event.type === 'message')!.data.seq, seq);
  f.gateway.acknowledge(f.first.id, seq); f.gateway.acknowledge(f.first.id, seq);
  await waitFor(() => reconnected.events.filter(event => event.type === 'message').length === 2);
  assert.equal(f.db.pendingNapcatEventCount(f.first.id), 1);
  const next = reconnected.events.filter(event => event.type === 'message')[1]!.data.seq as number;
  f.gateway.acknowledge(f.first.id, next); f.emit(message()); f.emit(message('1001', '2'));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.db.pendingNapcatEventCount(f.first.id), 0);
});

test('paused workers cache messages while a manually stopped instance does not accumulate new messages', async t => {
  const f = await fixture(t, { paused: true }); const stream = await f.open(f.first.id);
  f.emit(message()); await waitFor(() => f.db.pendingNapcatEventCount(f.first.id) === 1);
  assert.equal(stream.events.filter(event => event.type === 'message').length, 0);
  f.paused.delete(f.first.id); await f.gateway.reconcile();
  await waitFor(() => stream.events.some(event => event.type === 'message'));
  f.db.setDesiredState(f.first.id, 'stopped'); await f.gateway.reconcile(); f.emit(message('1001', '2'));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.db.pendingNapcatEventCount(f.first.id), 1);
});

test('stable delivery IDs return the original outcome and cannot address another target or action', async t => {
  const f = await fixture(t);
  const first = f.send(f.first.id, 'stable-id'); const duplicate = f.send(f.first.id, 'stable-id');
  await waitFor(() => f.requests.length === 1); assert.equal(f.gateway.pendingSends(f.first.id), 1);
  assert.deepEqual(f.requests[0]!.params, { group_id: '1001', message: [{ type: 'text', data: { text: 'sensitive-outgoing-content' } }] });
  f.answer(f.requests[0]!); assert.deepEqual(await first, { ok: true, messageId: '555' }); assert.deepEqual(await duplicate, await first);
  assert.deepEqual(await f.send(f.first.id, 'stable-id'), await first);
  assert.deepEqual(await f.send(f.first.id, 'stable-id', 'different'), { ok: false, code: 'NAPCAT_DELIVERY_ID_CONFLICT', deliveryStatus: 'failed' });
  const invalid = await f.gateway.send(f.first.id, { deliveryId: 'arbitrary', kind: 'text', text: 'x', targetId: '1002', action: 'send_private_msg', deadline: Date.now() + 1000 });
  assert.deepEqual(invalid, { ok: false, code: 'NAPCAT_INVALID_SEND_REQUEST', deliveryStatus: 'failed' }); assert.equal(f.requests.length, 1);
});

test('quoted text reaches the bound group and its reference participates in delivery identity', async t => {
  const f = await fixture(t);
  const request: NapcatSendRequest = { deliveryId: 'quoted-id', kind: 'text', text: 'Please wait', replyTo: 'trigger-42', deadline: Date.now() + 1500 };
  const first = f.gateway.send(f.first.id, request);
  const duplicate = f.gateway.send(f.first.id, request);
  await waitFor(() => f.requests.length === 1);
  assert.deepEqual(f.requests[0]!.params, { group_id: '1001', message: [
    { type: 'reply', data: { id: 'trigger-42' } }, { type: 'text', data: { text: 'Please wait' } },
  ] });
  f.answer(f.requests[0]!);
  assert.deepEqual(await first, { ok: true, messageId: '555' });
  assert.deepEqual(await duplicate, await first);
  assert.deepEqual(await f.gateway.send(f.first.id, request), await first);
  assert.deepEqual(await f.gateway.send(f.first.id, { ...request, replyTo: 'different-trigger' }), {
    ok: false, code: 'NAPCAT_DELIVERY_ID_CONFLICT', deliveryStatus: 'failed',
  });
  assert.equal(f.requests.length, 1);
});

test('invalid quote references are rejected before claiming or sending a delivery', async t => {
  const f = await fixture(t);
  for (const [index, replyTo] of ['', null, 42, {}, ['trigger-42']].entries()) {
    const deliveryId = `invalid-quote-${index}`;
    assert.deepEqual(await f.gateway.send(f.first.id, { deliveryId, kind: 'text', text: 'Please wait', replyTo, deadline: Date.now() + 1500 }), {
      ok: false, code: 'NAPCAT_INVALID_SEND_REQUEST', deliveryStatus: 'failed',
    });
    assert.equal(f.db.getNapcatDelivery(f.first.id, deliveryId), null);
  }
  assert.deepEqual(await f.gateway.send(f.first.id, { deliveryId: 'quote-image', kind: 'image', file: 'base64://aGVsbG8=', replyTo: 'trigger-42', deadline: Date.now() + 1500 }), {
    ok: false, code: 'NAPCAT_INVALID_SEND_REQUEST', deliveryStatus: 'failed',
  });
  assert.deepEqual(await f.gateway.send(f.first.id, { deliveryId: 'quote-video', kind: 'video', file: 'https://media.example/video.mp4', replyTo: 'trigger-42', deadline: Date.now() + 1500 }), {
    ok: false, code: 'NAPCAT_INVALID_SEND_REQUEST', deliveryStatus: 'failed',
  });
  assert.equal(f.db.getNapcatDelivery(f.first.id, 'quote-video'), null);
  assert.equal(f.requests.length, 0);
});

test('a missing send receipt remains unconfirmed and leaves the shared connection usable', async t => {
  const f = await fixture(t);
  const lost = f.send(f.first.id, 'lost', 'lost', 70); const other = f.send(f.second.id, 'other');
  await waitFor(() => f.requests.length === 2); f.answer(f.requests[1]!);
  assert.deepEqual(await other, { ok: true, messageId: '555' });
  assert.deepEqual(await lost, { ok: false, code: 'NAPCAT_RESPONSE_TIMEOUT', deliveryStatus: 'unconfirmed' });
  assert.deepEqual(await f.send(f.first.id, 'lost', 'lost'), await lost); assert.equal(f.requests.length, 2); assert.equal(f.sockets.length, 1);
  const next = f.send(f.first.id, 'next'); await waitFor(() => f.requests.length === 3);
  f.answer(f.requests[0]!); f.answer(f.requests[2]!); assert.deepEqual(await next, { ok: true, messageId: '555' });
});

test('internal image receipt timeouts persist as unconfirmed and are not resent after gateway recreation', async t => {
  const f = await fixture(t);
  const request: NapcatSendRequest = { deliveryId: 'image-receipt-timeout', kind: 'image', file: 'base64://aGVsbG8=', deadline: Date.now() + 1500 };
  const sending = f.gateway.send(f.first.id, request);
  await waitFor(() => f.requests.length === 1);
  f.answer(f.requests[0]!, { status: 'failed', retcode: 1200, data: null,
    message: 'Timeout: NTEvent serviceAndMethod:NodeIKernelMsgService/sendMsg ListenerName:NodeIKernelMsgListener/onMsgInfoListUpdate EventRet:\n{}\nsensitive-provider-detail',
    wording: 'sensitive-provider-wording' });
  const expected = { ok: false, code: 'NAPCAT_SEND_RECEIPT_TIMEOUT', deliveryStatus: 'unconfirmed' };
  assert.deepEqual(await sending, expected);
  assert.equal(f.db.getNapcatDelivery(f.first.id, request.deliveryId)!.state, 'unconfirmed');
  assert.deepEqual(f.db.getNapcatDelivery(f.first.id, request.deliveryId)!.result, expected);
  assert.deepEqual(await f.gateway.send(f.first.id, request), expected);
  assert.equal(f.requests.length, 1);

  await f.gateway.close();
  const restarted = new NapcatGateway({ db: f.db,
    logger: { info: text => f.logs.push(text), warn: text => f.logs.push(text), error: text => f.logs.push(text) },
    healthIntervalMs: 100, shutdownTimeoutMs: 50 });
  try {
    await restarted.reconcile();
    await waitFor(() => restarted.getConnectionStatus(f.connection.id).online);
    assert.deepEqual(await restarted.send(f.first.id, { ...request, deadline: Date.now() + 1500 }), expected);
    assert.equal(f.requests.length, 1);
    const rejected = restarted.send(f.first.id, { ...request, deliveryId: 'image-explicit-rejection', deadline: Date.now() + 1500 });
    await waitFor(() => f.requests.length === 2);
    f.answer(f.requests[1]!, { status: 'failed', retcode: 1200, data: null, message: 'sensitive-explicit-rejection' });
    assert.deepEqual(await rejected, { ok: false, code: 'NAPCAT_API_REJECTED', deliveryStatus: 'failed' });
    const next = restarted.send(f.first.id, { ...request, deliveryId: 'next-image', deadline: Date.now() + 1500 });
    await waitFor(() => f.requests.length === 3);
    f.answer(f.requests[2]!);
    assert.deepEqual(await next, { ok: true, messageId: '555' });
    assert.equal(f.requests.length, 3);
    assert.doesNotMatch(f.logs.join('\n'), /sensitive-|NTEvent|NodeIKernel|base64:\/\//);
  } finally { await restarted.close(); }
});

test('per-instance send order and limited global concurrency do not block other instances', async t => {
  const f = await fixture(t, { maxConcurrentSends: 2 });
  const one = f.send(f.first.id, 'one'); const two = f.send(f.first.id, 'two'); const other = f.send(f.second.id, 'other');
  await waitFor(() => f.requests.length === 2);
  assert.equal((f.requests[0]!.params as Record<string, unknown>).group_id, '1001');
  assert.equal((f.requests[1]!.params as Record<string, unknown>).group_id, '1002');
  f.answer(f.requests[1]!); await other; assert.equal(f.requests.length, 2);
  f.answer(f.requests[0]!); await one; await waitFor(() => f.requests.length === 3); f.answer(f.requests[2]!); await two;
});

test('expired queued sends never reach NapCat and stopping workers can finish current sends', async t => {
  const f = await fixture(t, { maxConcurrentSends: 1 });
  const first = f.send(f.first.id, 'blocked'); const expired = f.send(f.second.id, 'expired', 'expire', 30);
  await waitFor(() => f.requests.length === 1); assert.deepEqual(await expired, { ok: false, code: 'NAPCAT_SEND_DEADLINE_EXPIRED', deliveryStatus: 'failed' });
  f.db.setDesiredState(f.first.id, 'stopped'); f.db.setRuntime(f.first.id, { state: 'stopping' });
  f.answer(f.requests[0]!); await first;
  const finishing = f.send(f.first.id, 'finishing'); await waitFor(() => f.requests.length === 2); f.answer(f.requests[1]!); await finishing;
  f.db.setRuntime(f.first.id, { state: 'stopped' });
  assert.deepEqual(await f.send(f.first.id, 'stopped'), { ok: false, code: 'NAPCAT_INSTANCE_STOPPED', deliveryStatus: 'failed' }); assert.equal(f.requests.length, 2);
});

test('media relay accepts portable image/voice snapshots and preserves native mentions', async t => {
  const f = await fixture(t);
  const requests: NapcatSendRequest[] = [
    { deliveryId: 'image', kind: 'image', file: 'base64://aGVsbG8=', deadline: Date.now() + 1500 },
    { deliveryId: 'voice', kind: 'voice', file: `base64://${Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0]).toString('base64')}`, deadline: Date.now() + 1500 },
    { deliveryId: 'mentions', kind: 'message', segments: [{ type: 'at', userId: '123' }, { type: 'text', text: ' reply' }], deadline: Date.now() + 1500 },
  ];
  for (const [index, request] of requests.entries()) {
    const sending = f.gateway.send(f.first.id, request); await waitFor(() => f.requests.length === index + 1);
    f.answer(f.requests[index]!); assert.equal((await sending).ok, true);
  }
  assert.deepEqual((f.requests[2]!.params as Record<string, unknown>).message, [{ type: 'at', data: { qq: '123' } }, { type: 'text', data: { text: ' reply' } }]);
  for (const file of ['/tmp/private.png', 'file:///tmp/private.png', 'https://example.com/private.png']) {
    assert.equal((await f.gateway.send(f.first.id, { kind: 'image', deliveryId: file, file, deadline: Date.now() + 1000 })).ok, false);
  }
  assert.equal(f.requests.length, 3);
  const oversizedVoice = Buffer.alloc(5 * 1024 * 1024 + 1);
  oversizedVoice.set([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0]);
  assert.deepEqual(await f.gateway.send(f.first.id, {
    deliveryId: 'oversized-voice', kind: 'voice', file: `base64://${oversizedVoice.toString('base64')}`, deadline: Date.now() + 1000,
  }), { ok: false, code: 'NAPCAT_INVALID_SEND_REQUEST', deliveryStatus: 'failed' });
  assert.equal(f.requests.length, 3, '语音必须遵守实例的 5 MiB 上限');
  const getBot = f.db.getBot.bind(f.db);
  t.mock.method(f.db, 'getBot', (id: string) => {
    const bot = getBot(id);
    return bot?.id === f.first.id ? { ...bot, config: { ...bot.config, imageMaxMiB: 32 } } : bot;
  });
  assert.deepEqual(await f.gateway.send(f.first.id, {
    deliveryId: 'oversized-image', kind: 'image', file: `base64://${Buffer.alloc(NAPCAT_MEDIA_MAX_BYTES + 1).toString('base64')}`, deadline: Date.now() + 1000,
  }), { ok: false, code: 'NAPCAT_INVALID_SEND_REQUEST', deliveryStatus: 'failed' });
  assert.equal(f.requests.length, 3, '实例上限较大时仍执行全局 16 MiB 图片上限');
});

test('health status distinguishes a live socket from an offline QQ account', async t => {
  const f = await fixture(t); const stream = await f.open(f.first.id); f.setOnline(false);
  await waitFor(() => !f.gateway.getConnectionStatus(f.connection.id).online);
  assert.equal(f.gateway.getConnectionStatus(f.connection.id).connected, true);
  await waitFor(() => stream.events.some(event => event.type === 'status' && event.data.online === false));
  assert.deepEqual(await f.send(f.first.id, 'offline'), { ok: false, code: 'NAPCAT_CONNECTION_UNAVAILABLE', deliveryStatus: 'failed' });
  f.setOnline(true); await waitFor(() => f.gateway.getConnectionStatus(f.connection.id).online); assert.equal(f.sockets.length, 1);
});

test('connection edits wait for current acknowledgements before replacing the upstream', async t => {
  const f = await fixture(t); const pending = f.send(f.first.id, 'before-edit');
  await waitFor(() => f.requests.length === 1);
  f.db.updateNapcatConnection(f.connection.id, { token: 'updated-synthetic-token', expectedRevision: f.connection.revision });
  let reconciled = false; const reconciling = f.gateway.reconcile().then(() => { reconciled = true; });
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(reconciled, false); assert.equal(f.sockets.length, 1);
  f.answer(f.requests[0]!); assert.equal((await pending).ok, true); await reconciling;
  await waitFor(() => f.sockets.length === 2 && f.gateway.getConnectionStatus(f.connection.id).online);
});

test('connection edits preserve video ACKs beyond the ordinary action timeout and settle queued sends', async t => {
  const f = await fixture(t, { maxConcurrentSends: 1 });
  const file = await f.video();
  const pending = f.gateway.send(f.first.id, { deliveryId: 'video-before-edit', kind: 'video', file, deadline: Date.now() + 5000 });
  await waitFor(() => f.requests.length === 1);
  const queued = f.send(f.second.id, 'queued-before-edit', 'queued', 5000);
  const queuedVideo = f.gateway.send(f.first.id, { deliveryId: 'queued-video-before-edit', kind: 'video', file, deadline: Date.now() + 5000 });
  f.db.updateNapcatConnection(f.connection.id, { token: 'updated-synthetic-token' });
  let reconciled = false;
  const reconciling = f.gateway.reconcile().then(() => { reconciled = true; });
  await new Promise(resolve => setTimeout(resolve, 2200));
  assert.equal(reconciled, false, '视频 ACK 仍在请求期限内，不能按普通操作的 2 秒排空上限断开');
  assert.equal(f.sockets.length, 1);
  assert.equal(f.gateway.pendingSends(f.first.id), 2);
  f.answer(f.requests[0]!);
  assert.deepEqual(await pending, { ok: true, messageId: '555' });
  assert.equal(f.db.getNapcatDelivery(f.first.id, 'video-before-edit')!.state, 'acknowledged');
  assert.deepEqual(await queued, { ok: false, code: 'NAPCAT_SEND_DEADLINE_EXPIRED', deliveryStatus: 'failed' });
  assert.deepEqual(await queuedVideo, { ok: false, code: 'NAPCAT_CONNECTION_RECONFIGURING', deliveryStatus: 'failed' });
  await reconciling;
  await waitFor(() => f.sockets.length === 2 && f.gateway.getConnectionStatus(f.connection.id).online);
  assert.equal(f.requests.length, 1);
});

test('connection edits finish when an unanswered video reaches its bounded deadline', async t => {
  const f = await fixture(t);
  const file = await f.video();
  const pending = f.gateway.send(f.first.id, { deliveryId: 'video-expired', kind: 'video', file, deadline: Date.now() + 150 });
  await waitFor(() => f.requests.length === 1);
  f.db.updateNapcatConnection(f.connection.id, { token: 'updated-synthetic-token' });
  const started = Date.now();
  await f.gateway.reconcile();
  assert.ok(Date.now() - started < 1500);
  assert.deepEqual(await pending, { ok: false, code: 'NAPCAT_RESPONSE_TIMEOUT', deliveryStatus: 'unconfirmed' });
  assert.equal(f.db.getNapcatDelivery(f.first.id, 'video-expired')!.state, 'unconfirmed');
  await waitFor(() => f.sockets.length === 2 && f.gateway.getConnectionStatus(f.connection.id).online);
});

test('shutdown interrupts connection draining without waiting for the video deadline', async t => {
  const f = await fixture(t);
  const file = await f.video();
  const pending = f.gateway.send(f.first.id, { deliveryId: 'video-shutdown', kind: 'video', file, deadline: Date.now() + 120_000 });
  await waitFor(() => f.requests.length === 1);
  f.db.updateNapcatConnection(f.connection.id, { token: 'updated-synthetic-token' });
  const reconciling = f.gateway.reconcile();
  const started = Date.now();
  await f.gateway.close();
  await reconciling;
  assert.ok(Date.now() - started < 1500);
  const result = await pending;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.deliveryStatus, 'unconfirmed');
  assert.equal(f.db.getNapcatDelivery(f.first.id, 'video-shutdown')!.state, 'unconfirmed');
  assert.equal(f.sockets.length, 1, '关闭过程中不能启动替代连接');
});

test('another endpoint logged into the same QQ cannot activate a duplicate conversation', async t => {
  const f = await fixture(t);
  const duplicateConnection = f.db.createNapcatConnection({ name: 'Another address', wsUrl: `${f.connection.wsUrl.replace(/\/$/, '')}/alias`, token: 'another-token' });
  const duplicateBot = f.db.createBot({ name: 'Duplicate binding', targetType: 'group', targetId: '1001', connectionId: duplicateConnection.id, config: defaultSettings() });
  f.db.setDesiredState(duplicateBot.id, 'running'); f.db.setRuntime(duplicateBot.id, { state: 'running' });
  await f.gateway.reconcile();
  await waitFor(() => f.gateway.getConnectionStatus(duplicateConnection.id).error === 'NAPCAT_ACCOUNT_TARGET_CONFLICT');
  assert.equal(f.gateway.getConnectionStatus(duplicateConnection.id).connected, true);
  assert.equal(f.gateway.getConnectionStatus(duplicateConnection.id).online, false);
  assert.equal(f.gateway.getConnectionStatus(f.connection.id).online, true);
  assert.deepEqual(await f.send(duplicateBot.id, 'conflict'), { ok: false, code: 'NAPCAT_CONNECTION_UNAVAILABLE', deliveryStatus: 'failed' });
});

test('bounded shutdown records uncertain in-flight sends and never automatically retries them', async t => {
  const f = await fixture(t);
  const pending = f.send(f.first.id, 'shutdown'); await waitFor(() => f.requests.length === 1);
  await f.gateway.close();
  const result = await pending; assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.deliveryStatus, 'unconfirmed');
  assert.equal(f.db.getNapcatDelivery(f.first.id, 'shutdown')!.state, 'unconfirmed');
  assert.equal(f.db.pendingNapcatDeliveryCount(f.first.id), 0); assert.equal(f.requests.length, 1);
});

test('oversized caller deadlines cannot extend queued sends past the connection timeout budget', async t => {
  const f = await fixture(t, { maxConcurrentSends: 1 });
  const started = Date.now();
  const blocker = f.send(f.first.id, 'deadline-blocker', 'blocker', 100);
  const queued = [f.second.id, f.privateBot.id].map((botId, index) => f.gateway.send(botId, {
    deliveryId: `far-future-${index}`, kind: 'text', text: 'bounded wait', deadline: Number.MAX_SAFE_INTEGER,
  }));
  const results = await Promise.all([blocker, ...queued]);
  assert.ok(Date.now() - started < 1500, '请求排队和发送共用连接的 1 秒期限');
  assert.ok(results.every(result => !result.ok));
  assert.equal(f.gateway.pendingSends(f.second.id), 0); assert.equal(f.gateway.pendingSends(f.privateBot.id), 0);
});

test('one maximum-size SSE event survives a slow reader without blocking another worker', async t => {
  const f = await fixture(t);
  const slow = await f.openPaused(f.first.id);
  const other = await f.open(f.second.id);
  const event = message('1001', 'maximum-frame');
  const size = Buffer.byteLength(JSON.stringify(event));
  event.message[0]!.data.text = 'x'.repeat(NAPCAT_EVENT_MAX_BYTES - size + event.message[0]!.data.text.length);
  assert.equal(Buffer.byteLength(JSON.stringify(event)), NAPCAT_EVENT_MAX_BYTES);
  f.emit(event);
  await waitFor(() => f.db.pendingNapcatEventCount(f.first.id) === 1);
  const response = f.httpResponses.get(f.first.id)!;
  assert.ok(response.writableLength > 2 * 1024 * 1024, '模拟客户端停止读取后的真实背压');
  assert.ok(response.writableLength <= NAPCAT_SSE_MAX_BYTES + 1024);
  f.emit(message('1002', 'independent'));
  await waitFor(() => other.events.some(value => value.type === 'message'));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(f.gateway.getBotStatus(f.first.id).channelConnected, true, '多个心跳周期后仍保留合法大帧');
  let buffer = ''; let delivered: Record<string, unknown> | undefined;
  reading: for await (const chunk of slow) {
    buffer += Buffer.from(chunk).toString();
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      if (!frame.includes('event: message\n')) continue;
      const data = /^data: (.+)$/m.exec(frame)?.[1]; assert.ok(data);
      assert.ok(Buffer.byteLength(frame) <= NAPCAT_SSE_MAX_BYTES);
      delivered = JSON.parse(data) as Record<string, unknown>; break reading;
    }
  }
  assert.equal((delivered?.event as Record<string, unknown>).message_id, 'maximum-frame');
});
