import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createConsole } from '../src/console/server.js';
import { DockerClient } from '../src/console/docker.js';
import { ConversationStreams } from '../src/console/conversation-streams.js';
import type { ConsoleEvent, ConversationUpdate } from '../src/console/contracts.js';

class ConversationDocker extends DockerClient {
  constructor() { super({ socketPath: 'unused', image: 'unused', network: 'unused', consoleUrl: 'unused' }); }
  override async inspect() { return null; }
}

async function until(check: () => boolean, timeout = 2000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error('conversation stream timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

interface StreamEvent { event: string; id?: string; data: ConversationUpdate }
async function connect(url: string, cookie: string, lastEventId?: string) {
  const events: StreamEvent[] = [];
  let ended = false, pending = '';
  let response: http.IncomingMessage | undefined;
  const request = http.get(url, { headers: { cookie, ...(lastEventId ? { 'last-event-id': lastEventId } : {}) } }, res => {
    response = res;
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      pending += chunk;
      let index: number;
      while ((index = pending.indexOf('\n\n')) >= 0) {
        const block = pending.slice(0, index); pending = pending.slice(index + 2);
        const event = /^event:\s*(.*)$/mu.exec(block)?.[1];
        const data = /^data:\s*(.*)$/mu.exec(block)?.[1];
        const id = /^id:\s*(.*)$/mu.exec(block)?.[1];
        if (event && data) events.push({ event, id, data: JSON.parse(data) as ConversationUpdate });
      }
    });
    res.on('end', () => { ended = true; });
    res.on('close', () => { ended = true; });
  });
  request.on('error', () => { ended = true; });
  await until(() => Boolean(response));
  return {
    events,
    get ended() { return ended; },
    get status() { return response?.statusCode; },
    close() { response?.destroy(); request.destroy(); },
  };
}

async function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'napcat-conversation-stream-'));
  const console = await createConsole({ dataDir: directory, docker: new ConversationDocker(), timers: false, conversationHeartbeatMs: 20, staticDir: '/nonexistent' });
  const clients: Array<Awaited<ReturnType<typeof connect>>> = [];
  t.after(async () => {
    for (const client of clients) client.close();
    await console.app.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await console.app.listen({ port: 0, host: '127.0.0.1' });
  const setup = await console.app.inject({ method: 'POST', url: '/api/setup', headers: { 'x-console-request': '1' }, payload: { password: 'stream-test-password' } });
  assert.equal(setup.statusCode, 200);
  const cookie = setup.headers['set-cookie']!.toString().split(';')[0]!;
  const bot = console.db.createBot({ name: 'one', targetType: 'group', targetId: '10001', config: {} });
  const another = console.db.createBot({ name: 'two', targetType: 'private', targetId: '10002', config: {} });
  const base = console.app.listeningOrigin;
  const upload = async (events: ConsoleEvent[], target = bot) => {
    const result = await console.app.inject({ method: 'POST', url: `/internal/workers/${target.id}/events`, headers: { authorization: `Bearer ${target.workerToken}` }, payload: { events } });
    assert.equal(result.statusCode, 200, result.body);
    return result.json<{ acknowledgedSeq: number }>();
  };
  const open = async (after: number, target = bot, lastEventId?: string) => {
    const client = await connect(`${base}/api/bots/${target.id}/conversation/stream?after=${after}`, cookie, lastEventId);
    clients.push(client); assert.equal(client.status, 200);
    return client;
  };
  const changes = async (after: number, target = bot) => {
    const result = await console.app.inject({ url: `/api/bots/${target.id}/conversation/events?after=${after}`, headers: { cookie } });
    assert.equal(result.statusCode, 200, result.body);
    return result.json<ConversationUpdate>();
  };
  return { ...console, cookie, bot, another, base, upload, open, changes };
}

function event(seq: number, type = 'message.received', payload: Record<string, unknown> = { messageId: `message-${seq}`, text: `fake-${seq}` }, conversationId = 'chat-one'): ConsoleEvent {
  return { seq, type, payload, conversationId, time: 1_790_000_000_000 + seq };
}
function conversationEvents(client: Awaited<ReturnType<typeof connect>>): StreamEvent[] { return client.events.filter(item => item.event === 'conversation'); }

test('worker event upload authenticates per bot, acknowledges once and validates the batch atomically', async t => {
  const { app, cookie, bot, another, upload, changes } = await fixture(t);
  const path = `/internal/workers/${bot.id}/events`;
  assert.equal((await app.inject({ method: 'POST', url: path, payload: { events: [] } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: path, headers: { authorization: `Bearer ${another.workerToken}` }, payload: { events: [] } })).statusCode, 401);
  assert.equal((await app.inject({ url: `/api/bots/${bot.id}/conversation/events?after=0` })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/bots/missing/conversation/stream', headers: { cookie } })).statusCode, 404);
  assert.deepEqual(await upload([event(1, 'conversation.started', {}), event(2)]), { acknowledgedSeq: 2 });
  assert.deepEqual(await upload([event(1, 'conversation.started', {}), event(2)]), { acknowledgedSeq: 2 });
  const invalid = await app.inject({ method: 'POST', url: path, headers: { authorization: `Bearer ${bot.workerToken}` }, payload: { events: [event(3), { ...event(4), seq: -1 }] } });
  assert.equal(invalid.statusCode, 400);
  const update = await changes(1);
  assert.equal(update.cursor, 2);
  assert.deepEqual(update.view!.items.map(item => item.seq), [2]);
});

test('conversation SSE sends bot-specific deltas immediately without waiting for a heartbeat and ignores duplicate uploads', async t => {
  const { upload, open, bot, another, app } = await fixture(t);
  await upload([event(1, 'conversation.started', {}), event(2)]);
  const first = await open(2), second = await open(0, another);
  const firstCount = conversationEvents(first).length, secondCount = conversationEvents(second).length;
  const started = Date.now();
  await upload([event(3)]);
  await until(() => conversationEvents(first).length > firstCount);
  assert.ok(Date.now() - started < 2000);
  const update = conversationEvents(first).at(-1)!;
  assert.equal(update.id, '3'); assert.equal(update.data.cursor, 3); assert.equal(update.data.reset, false);
  assert.deepEqual(update.data.view!.items.map(item => item.seq), [3]);
  await upload([event(3)]);
  const heartbeat = await app.inject({ method: 'POST', url: `/internal/workers/${bot.id}/heartbeat`, headers: { authorization: `Bearer ${bot.workerToken}` }, payload: { revision: 1, connected: true, processing: true, drained: false, conversationId: 'chat-one', events: [] } });
  assert.equal(heartbeat.statusCode, 200, heartbeat.body);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(conversationEvents(first).length, firstCount + 1);
  assert.equal(conversationEvents(second).length, secondCount);
});

test('conversation deltas carry complete session, usage and context metadata while only returning new items', async t => {
  const { app, cookie, bot, upload, changes } = await fixture(t);
  await upload([
    event(1, 'conversation.started', {}),
    event(2, 'session.established', { agentSessionId: '/data/pi/sessions/fake.jsonl' }),
    event(3, 'usage.recorded', { usageId: 'call-one', input_tokens: 100, cached_input_tokens: 90, output_tokens: 10 }),
    event(4, 'context.updated', { used: 1500, window: 200000, compactLimit: 160000, estimated: true }),
  ]);
  const snapshot = await app.inject({ url: `/api/bots/${bot.id}/conversation`, headers: { cookie } });
  assert.equal(snapshot.statusCode, 200); assert.equal(snapshot.json().cursor, 4);
  await upload([event(5, 'usage.recorded', { usageId: 'call-two', input_tokens: 200, cached_input_tokens: 170, output_tokens: 20 })]);
  const update = await changes(4);
  assert.equal(update.reset, false); assert.equal(update.cursor, 5);
  assert.deepEqual(update.view!.items.map(item => item.seq), [5]);
  assert.equal(update.view!.agentSessionId, '/data/pi/sessions/fake.jsonl');
  assert.deepEqual(update.view!.usage, { input: 300, cached: 260, output: 30, total: 330 });
  assert.deepEqual(update.view!.context, { used: 1500, window: 200000, compactLimit: 160000, estimated: true });
});

test('a delayed runtime-only heartbeat cannot replace a conversation selected by a newer event', async t => {
  const { app, bot, upload, changes } = await fixture(t);
  await upload([event(1, 'conversation.started', {}), event(2)]);
  await upload([event(3, 'conversation.started', {}, 'chat-two'), event(4, 'message.received', { messageId: 'new-message', text: 'fake-new' }, 'chat-two')]);
  const heartbeat = await app.inject({ method: 'POST', url: `/internal/workers/${bot.id}/heartbeat`, headers: { authorization: `Bearer ${bot.workerToken}` }, payload: { revision: 1, connected: true, processing: false, drained: true, conversationId: 'chat-one', events: [] } });
  assert.equal(heartbeat.statusCode, 200, heartbeat.body);
  const update = await changes(2);
  assert.equal(update.reset, true); assert.equal(update.view!.id, 'chat-two');
  assert.deepEqual(update.view!.items.map(item => item.seq), [3, 4]);
});

test('reconnecting SSE resumes after Last-Event-ID in preference to the stale query cursor', async t => {
  const { upload, open } = await fixture(t);
  await upload([event(1, 'conversation.started', {}), event(2)]);
  const first = await open(2);
  await upload([event(3)]); await until(() => conversationEvents(first).some(item => item.data.cursor === 3));
  first.close(); await upload([event(4), event(5)]);
  const reconnected = await open(1, undefined, '3');
  await until(() => conversationEvents(reconnected).some(item => item.data.cursor === 5));
  const items = conversationEvents(reconnected).flatMap(item => item.data.view?.items ?? []);
  assert.deepEqual(items.map(item => item.seq), [4, 5]);
  assert.ok(conversationEvents(reconnected).every(item => item.data.reset === false));
});

test('new conversations and future cursors reset to the latest snapshot, including already received messages moved into the new session', async t => {
  const { upload, open, changes } = await fixture(t);
  await upload([event(1, 'conversation.started', {}), event(2), event(3)]);
  const stream = await open(3);
  await upload([
    event(4, 'conversation.started', {}, 'chat-two'),
    event(5, 'conversation.messages_moved', { messageIds: ['message-3'] }, 'chat-two'),
    event(6, 'session.established', { agentSessionId: '/data/pi/sessions/fresh.jsonl' }, 'chat-two'),
  ]);
  await until(() => conversationEvents(stream).some(item => item.data.cursor === 6));
  const reset = conversationEvents(stream).at(-1)!.data;
  assert.equal(reset.reset, true); assert.equal(reset.view!.id, 'chat-two');
  assert.deepEqual(reset.view!.items.map(item => item.seq), [3, 4, 5, 6]);
  assert.equal(reset.view!.usage.total, null);
  const future = await changes(999999);
  assert.equal(future.reset, true); assert.equal(future.cursor, 6); assert.equal(future.view!.id, 'chat-two');
});

test('reconnect replay traverses a backlog larger than one page without missing or repeating events', async t => {
  const { upload, open, changes } = await fixture(t);
  await upload([event(1, 'conversation.started', {}), ...Array.from({ length: 329 }, (_, i) => event(i + 2))]);
  let cursor = 1; const pulled: number[] = [];
  for (let page = 0; cursor < 330 && page < 10; page++) {
    const update = await changes(cursor);
    assert.equal(update.reset, false); assert.ok(update.cursor > cursor);
    const seqs = update.view!.items.map(item => item.seq);
    assert.ok(seqs.every(seq => seq > cursor && seq <= update.cursor));
    pulled.push(...seqs); cursor = update.cursor;
  }
  assert.equal(cursor, 330); assert.deepEqual(pulled, Array.from({ length: 329 }, (_, i) => i + 2));
  const stream = await open(1);
  await until(() => conversationEvents(stream).some(item => item.data.cursor === 330));
  const replayed = conversationEvents(stream).flatMap(item => item.data.view?.items.map(event => event.seq) ?? []);
  assert.deepEqual(replayed, pulled);
  const reset = await changes(0);
  assert.equal(reset.reset, true); assert.equal(reset.cursor, 330);
  assert.deepEqual(reset.view!.items.map(item => item.seq), Array.from({ length: 100 }, (_, i) => i + 231));
});

test('conversation streams close on logout and on expired authentication before delivering another event', async t => {
  const { app, db, cookie, upload, open, bot } = await fixture(t);
  await upload([event(1, 'conversation.started', {})]);
  const expired = await open(1);
  const initial = conversationEvents(expired).length;
  db.setSetting('session.' + createHash('sha256').update(cookie.split('=')[1]!).digest('hex'), String(Date.now() - 1));
  await until(() => expired.ended);
  await upload([event(2)]);
  assert.equal(conversationEvents(expired).length, initial);
  const login = await app.inject({ method: 'POST', url: '/api/login', headers: { 'x-console-request': '1' }, payload: { password: 'stream-test-password' } });
  const activeCookie = login.headers['set-cookie']!.toString().split(';')[0]!;
  const active = await connect(`${app.listeningOrigin}/api/bots/${bot.id}/conversation/stream?after=2`, activeCookie);
  t.after(() => active.close());
  await app.inject({ method: 'POST', url: '/api/logout', headers: { 'x-console-request': '1', cookie: activeCookie } });
  await until(() => active.ended);
});

test('conversation streams disconnect an oversized response buffer before writing more data', async t => {
  const { db, auth, cookie, bot } = await fixture(t);
  class SlowResponse extends EventEmitter {
    writableLength = 512 * 1024 + 1;
    destroyed = false;
    writes: string[] = [];
    writeHead() {}
    flushHeaders() {}
    write(value: string) { this.writes.push(value); return false; }
    end() { this.destroyed = true; this.emit('close'); }
    destroy() { this.end(); }
  }
  const response = new SlowResponse(), raw = new EventEmitter();
  const streams = new ConversationStreams(db, auth, 20);
  t.after(() => streams.close());
  streams.open({ raw, cookies: { console_session: cookie.split('=')[1]! } } as unknown as FastifyRequest, { raw: response, hijack() {} } as unknown as FastifyReply, bot.id, 0);
  await until(() => response.destroyed);
  assert.equal(response.writes.filter(value => value.includes('event: conversation')).length, 0);
  const writes = response.writes.length;
  streams.notify(bot.id);
  assert.equal(response.writes.length, writes);
});

test('conversation replay respects the frame byte budget without skipping large events', async t => {
  const { upload, changes } = await fixture(t);
  await upload([event(1, 'conversation.started', {}), ...Array.from({ length: 5 }, (_, index) => event(index + 2, 'message.received', { messageId: `large-${index}`, text: 'x'.repeat(140000) }))]);
  const received: number[] = []; let cursor = 1;
  while (cursor < 6) {
    const update = await changes(cursor);
    assert.equal(update.reset, false); assert.ok(update.cursor > cursor);
    assert.ok(Buffer.byteLength(JSON.stringify(update)) < 512 * 1024);
    if (cursor === 1) assert.ok(update.cursor < 6);
    received.push(...update.view!.items.map(item => item.seq)); cursor = update.cursor;
  }
  assert.deepEqual(received, [2, 3, 4, 5, 6]);
});

test('large reset snapshots retain the latest bounded page and expose earlier messages for history paging', async t => {
  const { app, cookie, bot, upload, changes, open } = await fixture(t);
  await upload([event(1, 'conversation.started', {}), ...Array.from({ length: 5 }, (_, index) => event(index + 2, 'message.received', { messageId: `reset-large-${index}`, text: 'y'.repeat(140000) }))]);
  for (const after of [0, 999999]) {
    const reset = await changes(after);
    assert.equal(reset.reset, true); assert.equal(reset.cursor, 6);
    assert.ok(Buffer.byteLength(JSON.stringify(reset)) < 512 * 1024);
    assert.ok(reset.view!.items.length < 6); assert.equal(reset.view!.items.at(-1)!.seq, 6);
    const before = reset.view!.nextBefore;
    assert.equal(before, reset.view!.items[0]!.seq);
    const earlier = await app.inject({ url: `/api/bots/${bot.id}/conversation?before=${before}`, headers: { cookie } });
    assert.equal(earlier.statusCode, 200); assert.equal(earlier.json().cursor, 6);
    assert.deepEqual([...earlier.json().items, ...reset.view!.items].map((item: ConsoleEvent) => item.seq), [1, 2, 3, 4, 5, 6]);
  }
  const snapshot = await app.inject({ url: `/api/bots/${bot.id}/conversation`, headers: { cookie } });
  assert.ok(Buffer.byteLength(snapshot.body) < 512 * 1024);
  const stream = await open(999999);
  await until(() => conversationEvents(stream).length > 0);
  const pushed = conversationEvents(stream)[0]!;
  assert.equal(pushed.id, '6'); assert.equal(pushed.data.reset, true); assert.equal(pushed.data.cursor, 6);
  assert.ok(Buffer.byteLength(JSON.stringify(pushed.data)) < 512 * 1024);
});

test('conversation streams pause replay after a false write until drain, then resume from the sent cursor', async t => {
  const { db, auth, cookie, bot, upload } = await fixture(t);
  await upload([event(1, 'conversation.started', {}), event(2)]);
  class BlockedResponse extends EventEmitter {
    writableLength = 16000;
    destroyed = false;
    chunks: string[] = [];
    writeHead() {}
    write(value: string) { this.chunks.push(value); return !value.includes('event: conversation'); }
    end() { this.destroyed = true; this.emit('close'); }
    destroy() { this.end(); }
  }
  const response = new BlockedResponse(), streams = new ConversationStreams(db, auth, 20);
  t.after(() => streams.close());
  streams.open({ raw: new EventEmitter(), cookies: { console_session: cookie.split('=')[1]! } } as unknown as FastifyRequest, { raw: response, hijack() {} } as unknown as FastifyReply, bot.id, 1);
  const frames = () => response.chunks.filter(value => value.includes('event: conversation'));
  await until(() => frames().length === 1);
  await upload([event(3)]); streams.notify(bot.id);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(frames().length, 1);
  response.emit('drain'); await until(() => frames().length === 2);
  assert.match(frames()[0]!, /^id: 2\n/u); assert.match(frames()[1]!, /^id: 3\n/u);
});
