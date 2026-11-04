import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage as HttpRequest, type ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { ConsoleTransport, TransportEventParser } from '../src/console-transport.js';
import { handleIncomingEvent } from '../src/incoming.js';
import { BridgeStore } from '../src/store.js';
import type { Logger, MessageSegment, Target } from '../src/types.js';
import type { ForwardSnapshot } from '../src/forward-contract.js';

type RecordedRequest = { path: string; authorization: string | undefined; body: Record<string, unknown> };
type RequestHandler = (request: HttpRequest, response: ServerResponse, body: Record<string, unknown>) => void;
const target: Target = { type: 'group', id: '1001' };
const signal = () => new AbortController().signal;
const event = (id: number) => ({
  post_type: 'message', message_type: 'group', group_id: 1001, self_id: 999,
  message_id: id, user_id: 123, time: 1_792_727_200,
  sender: { nickname: 'Synthetic sender' }, message: [{ type: 'text', data: { text: `Message ${id} 中文` } }],
});
const frame = (type: string, value: unknown, newline = '\n') => `event: ${type}${newline}data: ${JSON.stringify(value)}${newline}${newline}`;
const json = (response: ServerResponse, value: unknown, status = 200) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
};

async function waitFor(condition: () => boolean, message = 'condition timed out'): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, message);
    await delay(5);
  }
}

async function fixture(t: TestContext, options: {
  onEvent?: ConstructorParameters<typeof ConsoleTransport>[0]['onEvent'];
  onContentUpdate?: ConstructorParameters<typeof ConsoleTransport>[0]['onContentUpdate'];
  onStream?: (response: ServerResponse, index: number) => void;
  onAck?: RequestHandler;
  onSend?: RequestHandler;
  online?: boolean;
  upstreamConnected?: boolean;
  actionTimeoutMs?: number;
} = {}) {
  const requests: RecordedRequest[] = [], streams: ServerResponse[] = [], logs: string[] = [], received: unknown[] = [];
  const logger: Logger = { info: value => logs.push(value), warn: value => logs.push(value), error: value => logs.push(value) };
  const server = createServer(async (request, response) => {
    const path = new URL(request.url!, 'http://localhost').pathname;
    if (path.endsWith('/napcat/events')) {
      requests.push({ path, authorization: request.headers.authorization, body: {} });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(frame('status', { connected: options.upstreamConnected ?? true, online: options.online ?? true }));
      streams.push(response);
      options.onStream?.(response, streams.length);
      return;
    }
    let text = '';
    for await (const bytes of request) text += bytes;
    const body = JSON.parse(text) as Record<string, unknown>;
    requests.push({ path, authorization: request.headers.authorization, body });
    if (path.endsWith('/napcat/ack')) {
      if (options.onAck) options.onAck(request, response, body);
      else json(response, { ok: true });
    } else if (path.endsWith('/napcat/send')) {
      if (options.onSend) options.onSend(request, response, body);
      else json(response, { ok: true, messageId: 'receipt-123' });
    } else json(response, { error: 'unknown endpoint' }, 404);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const identity = { url: `http://127.0.0.1:${address.port}`, botId: 'synthetic-worker', token: 'synthetic-worker-token', dataDir: '/unused' };
  const client = new ConsoleTransport({
    identity, logger, actionTimeoutMs: options.actionTimeoutMs ?? 500, reconnectMs: 10,
    onEvent: options.onEvent ?? (input => received.push(input)),
    ...(options.onContentUpdate?{onContentUpdate:options.onContentUpdate}:{}),
  });
  t.after(async () => {
    await client.stop();
    for (const stream of streams) stream.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const sends = () => requests.filter(request => request.path.endsWith('/napcat/send'));
  const acks = () => requests.filter(request => request.path.endsWith('/napcat/ack'));
  const status = (value: { connected: boolean; online: boolean; paused?: boolean }) => streams.at(-1)!.write(frame('status', value));
  return { client, identity, requests, streams, logs, received, sends, acks, status };
}

test('SSE parser preserves fragmented CRLF records, multiline data and asynchronous record order', async () => {
  const records: [string, string][] = [];
  let release!: () => void;
  const first = new Promise<void>(resolve => { release = resolve; });
  const parser = new TransportEventParser(async (type, data) => {
    if (!records.length) await first;
    records.push([type, data]);
  });
  await parser.push(': heartbeat\r\n\r\neve');
  await parser.push('nt: message\r\ndata: first\r\ndata: second\r');
  const completing = parser.push('\n\r\nevent: status\ndata: {"online":true}\n\n');
  await delay(1);
  assert.deepEqual(records, []);
  release();
  await completing;
  assert.deepEqual(records, [['message', 'first\nsecond'], ['status', '{"online":true}']]);
});

test('SSE parser bounds both completed and unfinished UTF-8 event records', async () => {
  await assert.rejects(new TransportEventParser(async () => {}, 8).push('中文中文'), /exceeds limit/);
  await assert.rejects(new TransportEventParser(async () => {}, 8).push('data: oversized\n\n'), /exceeds limit/);
});

test('worker persists ordered streamed messages before posting each authenticated HTTP ACK', async t => {
  const persisted: number[] = [], order: string[] = [];
  const f = await fixture(t, {
    onEvent: value => {
      const input = value as { message_id: number; message: { data: { text: string } }[] };
      const id = input.message_id;
      assert.equal(input.message[0]?.data.text, `Message ${id} 中文`);
      persisted.push(id);
      order.push(`persist:${id}`);
    },
    onStream: response => {
      const bytes = Buffer.from(frame('message', { seq: 1, event: event(101) }, '\r\n') + frame('message', { seq: 2, event: event(102) }));
      const split = bytes.indexOf(Buffer.from('中')) + 1;
      response.write(bytes.subarray(0, split));
      setImmediate(() => response.write(bytes.subarray(split)));
    },
    onAck: (_request, response, body) => {
      assert.equal(persisted.length, body.seq);
      order.push(`ack:${body.seq}`);
      json(response, { ok: true });
    },
  });
  f.client.start();
  await waitFor(() => f.acks().length === 2);
  assert.deepEqual(persisted, [101, 102]);
  assert.deepEqual(order, ['persist:101', 'ack:1', 'persist:102', 'ack:2']);
  assert.deepEqual(f.acks().map(request => request.body), [{ seq: 1 }, { seq: 2 }]);
  for (const request of f.requests) {
    assert.equal(request.authorization, `Bearer ${f.identity.token}`);
    assert.match(request.path, /^\/internal\/workers\/synthetic-worker\/napcat\/(events|ack)$/);
  }
});

test('an unacknowledged stream replay is deduplicated by the existing Worker store and handler', async t => {
  const store = new BridgeStore(':memory:', target);
  const controller = new AbortController();
  t.after(() => { controller.abort(); store.close(); });
  let notifications = 0, deliveries = 0, acknowledgementAttempts = 0;
  const f = await fixture(t, {
    onStream: response => response.write(frame('message', { seq: 4, event: event(104) })),
    onEvent: input => {
      deliveries++;
      handleIncomingEvent(input, {
        target, randomReplyProbability: 1, store, signal: controller.signal,
        processor: { notify() { notifications++; } }, sender: { sendText: async () => {} },
        logger: { info() {}, warn() {}, error() {} }, random: () => 0,
      });
    },
    onAck: (request, response) => {
      if (acknowledgementAttempts++ === 0) request.socket.destroy();
      else json(response, { ok: true });
    },
  });
  f.client.start();
  await waitFor(() => f.acks().length === 2);
  assert.equal(f.streams.length, 2);
  assert.equal(deliveries, 2);
  assert.equal(notifications, 1);
  assert.deepEqual(store.openOrCreateBatch(10)?.messages.map(message => message.messageId), ['104']);
  assert.deepEqual(f.acks().map(request => request.body), [{ seq: 4 }, { seq: 4 }]);
});

test('forward content snapshots and durable updates persist in order before ACK without a second chat event',async t=>{
  const snapshot:ForwardSnapshot={messageId:'104',revision:1,deadline:Date.now()+15_000,
    contents:[{type:'forward',path:'0',status:'pending',nodes:[]}]};
  const ready:ForwardSnapshot={...snapshot,revision:2,contents:[{type:'forward',path:'0',status:'ready',nodes:[
    {path:'0/0',segments:[{type:'text',text:'Quoted text'}]},
  ]}]};
  const store=new BridgeStore(':memory:',target);t.after(()=>store.close());
  let received=0,updates=0;
  const f=await fixture(t,{
    onEvent:(value,_attachments,_dispatch,forwards)=>{
      received++;
      handleIncomingEvent(value,{target,randomReplyProbability:0,store,signal:signal(),processor:{notify(){}},sender:{async sendText(){}},logger:{info(){},warn(){},error(){}}});
      store.recordForwardContent(forwards!);
    },
    onContentUpdate:update=>{updates++;store.recordForwardContent(update);},
    onStream:response=>{
      response.write(frame('message',{seq:1,event:event(104),forwards:snapshot}));
      response.write(frame('content-update',{seq:2,update:ready,attachments:[]}));
    },
    onAck:(_request,response,body)=>{
      assert.equal(store.forwardSnapshot('104')!.revision,body.seq);
      json(response,{ok:true});
    },
  });
  f.client.start();await waitFor(()=>f.acks().length===2);
  assert.equal(received,1);assert.equal(updates,1);assert.equal(store.isBusy(),false);
  assert.equal(store.recorder.pending().filter(record=>record.type==='message.received').length,1);
  assert.deepEqual(store.chatMessageForQQ('104')!.contents,ready.contents);
});

test('outgoing text, image, native voice, video and mention segments use only the authenticated Worker send endpoint', async t => {
  const f = await fixture(t);
  f.client.start();
  await waitFor(() => f.client.connected);
  const segments: MessageSegment[] = [{ type: 'at', userId: '321' }, { type: 'text', text: 'Hello [CQ:at,qq=all]' }];
  const bodies = [
    { kind: 'text', text: 'Plain text' },
    { kind: 'image', file: 'base64://c3ludGhldGljLWltYWdl' },
    { kind: 'voice', file: 'base64://c3ludGhldGljLXZvaWNl' },
    { kind: 'video', file: 'https://media.example/video.mp4' },
    { kind: 'message', segments },
  ];
  assert.deepEqual(await f.client.sendText('Plain text', signal()), { messageId: 'receipt-123' });
  await f.client.sendImage(bodies[1]!.file!, signal());
  await f.client.sendVoice(bodies[2]!.file!, signal());
  await f.client.sendVideo(bodies[3]!.file!, signal());
  await f.client.sendMessage(segments, signal());
  const sends = f.sends();
  assert.equal(sends.length, 5);
  sends.forEach((request, index) => {
    const { deliveryId, deadline, ...body } = request.body;
    assert.deepEqual(body, bodies[index]);
    assert.match(String(deliveryId), /^[0-9a-f-]{36}$/u);
    assert.equal(Number.isSafeInteger(deadline), true);
    assert.equal(request.path, '/internal/workers/synthetic-worker/napcat/send');
    assert.equal(request.authorization, `Bearer ${f.identity.token}`);
    for (const field of ['target', 'targetId', 'group_id', 'user_id', 'action']) assert.equal(field in request.body, false);
  });
  assert.equal(new Set(sends.map(request => request.body.deliveryId)).size, 5);
});

test('quoted text preserves the trigger message ID in the authenticated send request', async t => {
  const f = await fixture(t);
  f.client.start();
  await waitFor(() => f.client.connected);
  assert.deepEqual(await f.client.sendText('Please wait', signal(), 'trigger-42'), { messageId: 'receipt-123' });
  const { deliveryId, deadline, ...message } = f.sends()[0]!.body;
  assert.deepEqual(message, { kind: 'text', text: 'Please wait', replyTo: 'trigger-42' });
  assert.equal(f.sends()[0]!.authorization, `Bearer ${f.identity.token}`);
  assert.match(String(deliveryId), /^[0-9a-f-]{36}$/u);
  assert.equal(Number.isSafeInteger(deadline), true);
});

test('QQ offline keeps the internal channel available but rejects sends without sending HTTP requests', async t => {
  const f = await fixture(t, { online: false, actionTimeoutMs: 30 });
  f.client.start();
  await waitFor(() => f.client.transportConnected);
  assert.equal(f.client.upstreamConnected, true);
  assert.equal(f.client.qqOnline, false);
  assert.equal(f.client.connected, false);
  await assert.rejects(f.client.sendText('Unavailable', signal()), { code: 'NAPCAT_CONNECTION_UNAVAILABLE', deliveryStatus: 'failed' });
  assert.equal(f.sends().length, 0);
  f.status({ connected: true, online: true });
  await waitFor(() => f.client.connected);
  assert.deepEqual(await f.client.sendText('Restored', signal()), { messageId: 'receipt-123' });
});

test('pausing inbound delivery does not abort a send already waiting for its HTTP receipt', async t => {
  let finish!: ServerResponse;
  const f = await fixture(t, { onSend: (_request, response) => { finish = response; } });
  f.client.start();
  await waitFor(() => f.client.connected);
  let settled = false;
  const pending = f.client.sendText('Final reply during drain', signal()).then(receipt => { settled = true; return receipt; });
  await waitFor(() => f.sends().length === 1);
  f.status({ connected: true, online: true, paused: true });
  await delay(10);
  assert.equal(f.client.connected, true);
  assert.equal(settled, false);
  json(finish, { ok: true, messageId: 'drain-ack' });
  assert.deepEqual(await pending, { messageId: 'drain-ack' });
  assert.equal(f.sends().length, 1);
});

for (const failure of ['http-5xx', 'disconnect', 'timeout'] as const) {
  test(`${failure} leaves a send unconfirmed and never retries the POST`, async t => {
    const f = await fixture(t, {
      actionTimeoutMs: failure === 'timeout' ? 35 : 500,
      onSend: (request, response) => {
        if (failure === 'http-5xx') json(response, { error: 'synthetic-provider-secret' }, 502);
        else if (failure === 'disconnect') request.socket.destroy();
      },
    });
    f.client.start();
    await waitFor(() => f.client.connected);
    await assert.rejects(f.client.sendText('Synthetic reply body', signal()), error => {
      assert.ok(error instanceof Error);
      assert.equal((error as Error & { deliveryStatus: string }).deliveryStatus, 'unconfirmed');
      assert.doesNotMatch(error.message, /synthetic-provider-secret|Synthetic reply body|synthetic-worker-token/);
      return true;
    });
    await delay(30);
    assert.equal(f.sends().length, 1);
    assert.equal(f.streams.length, 1);
  });
}

test('explicit gateway refusal and HTTP client rejection are failed rather than unconfirmed', async t => {
  let attempt = 0;
  const f = await fixture(t, {
    onSend: (_request, response) => {
      if (attempt++ === 0) json(response, { ok: false, code: 'NAPCAT_TARGET_FORBIDDEN', deliveryStatus: 'failed' });
      else json(response, { error: 'Synthetic authorization failure' }, 403);
    },
  });
  f.client.start();
  await waitFor(() => f.client.connected);
  await assert.rejects(f.client.sendText('First attempt', signal()), { code: 'NAPCAT_TARGET_FORBIDDEN', deliveryStatus: 'failed' });
  await assert.rejects(f.client.sendText('Second attempt', signal()), { code: 'NAPCAT_GATEWAY_REJECTED', deliveryStatus: 'failed' });
  assert.equal(f.sends().length, 2);
});

test('stopping aborts active HTTP sends, ends the event stream and logs no credentials or payloads', async t => {
  const f = await fixture(t, { onSend: () => {} });
  f.client.start();
  f.client.start();
  await waitFor(() => f.client.connected);
  const rejecting = assert.rejects(f.client.sendText('synthetic-sensitive-reply', signal()), { deliveryStatus: 'unconfirmed' });
  await waitFor(() => f.sends().length === 1);
  await f.client.stop();
  await rejecting;
  await waitFor(() => f.streams[0]!.destroyed);
  await f.client.stop();
  assert.equal(f.client.connected, false);
  assert.equal(f.client.transportConnected, false);
  await assert.rejects(f.client.sendText('After stop', signal()), { deliveryStatus: 'failed' });
  await delay(25);
  assert.equal(f.streams.length, 1);
  assert.equal(f.sends().length, 1);
  assert.doesNotMatch(f.logs.join('\n'), /synthetic-worker-token|synthetic-sensitive-reply|127\.0\.0\.1|base64:\/\//u);
});
