import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {AddressInfo} from 'node:net';
import type {ServerResponse} from 'node:http';
import {crc32, deflateSync} from 'node:zlib';
import {createConsole} from '../src/console/server.js';
import {DockerClient} from '../src/console/docker.js';
import {assertAccepted, bindHost, delay, piFixture, pngBase64, requestHost, respond, sendReply,
  type ModelCall, type Outgoing} from './fixtures/pi-e2e.js';

const warning = 'Synthetic private image-check reminder.';
const messageText = (request: Outgoing) => request.params.message?.filter(item => item.type === 'text').map(item => item.data.text ?? '').join('') ?? '';
const notifications = (outgoing: Outgoing[]) => outgoing.filter(item => item.action === 'send_group_msg' && messageText(item) === warning);
const unsafeResponse = (body: Record<string, any>) => Response.json({answers: Object.fromEntries(Object.keys(body.questions).map(key => [key, {type: 'noul', noul: 0.98}]))});

async function setup(t: TestContext, f: Awaited<ReturnType<typeof piFixture>>, inspectionFetch: typeof globalThis.fetch, notificationResult?: 'failed' | 'unconfirmed', secondImage?: Buffer) {
  const directory = await mkdtemp(join(tmpdir(), 'nekodock-forward-nsfw-e2e-'));
  const consoleApp = await createConsole({dataDir: directory, timers: false, staticDir: '/nonexistent',
    docker: new DockerClient({socketPath: 'unused', image: 'unused', network: 'unused', consoleUrl: 'unused'}),
    incomingImageFetch: async url => new Response(new Uint8Array(secondImage && String(url).includes('/two?') ? secondImage : Buffer.from(pngBase64, 'base64'))), inspectionFetch});
  t.after(async () => { await consoleApp.app.close(); await rm(directory, {recursive: true, force: true}); });
  await consoleApp.app.listen({host: bindHost, port: 0});
  const connection = consoleApp.db.createNapcatConnection({name: 'Isolated inspection fixture', wsUrl: f.localWsUrl, ...(notificationResult ? {actionTimeout: 1} : {})});
  const bot = consoleApp.db.createBot({name: 'Synthetic observer bot', targetType: 'group', targetId: '1001', connectionId: connection.id,
    config: {model: 'synthetic-chat', baseUrl: f.modelUrl, modelApi: 'openai-responses', memoryEnabled: false,
      replyProbability: 0, imageTimeout: 2, voiceEnabled: false, allowCommands: false, allowFileWrites: false}});
  const view = consoleApp.db.plugins.view(bot.id, 'forward-nsfw'); assert.equal(view.enabled, false);
  consoleApp.db.plugins.update(bot.id, 'forward-nsfw', {expectedRevision: view.revision, enabled: true,
    config: {apiKey: 'isolated-vision-key', baseUrl: 'https://judge.invalid/v1', warningText: warning, maxImages: 2}});
  consoleApp.db.setDesiredState(bot.id, 'running'); consoleApp.db.setRuntime(bot.id, {state: 'running'});
  f.onSend = (request, socket) => {
    if (notificationResult && request.action === 'send_group_msg' && messageText(request) === warning) {
      if (notificationResult === 'failed') socket.send(JSON.stringify({echo: request.echo, status: 'failed', retcode: 1200, message: 'Synthetic send rejection.'}));
      return false;
    }
    if (request.action !== 'get_forward_msg') return;
    const messages = [{sender: {user_id: '601', nickname: 'Original author'}, message: [
      {type: 'forward', data: {content: [{sender: {user_id: '602', nickname: 'Nested author'}, message: [
        {type: 'image', data: {url: 'https://image.invalid/one?token=synthetic-private'}},
      ]}]}},
    ]}, {sender: {user_id: '603', nickname: 'Another author'}, message: [
      {type: 'text', data: {text: 'Forward context detail'}}, {type: 'image', data: {url: 'https://image.invalid/two?token=synthetic-private'}},
    ]}];
    socket.send(JSON.stringify({echo: request.echo, status: 'ok', retcode: 0, data: {messages}})); return false;
  };
  await consoleApp.gateway.reconcile();
  await f.waitFor(() => consoleApp.gateway.getConnectionStatus(connection.id).online, 'isolated mock NapCat login');
  const broadcastForward = (id: string) => f.broadcast({...f.event(id, '', false), message: [{type: 'forward', data: {id: `resource-${id}`}}]});
  const jobs = () => consoleApp.db.plugins.view(bot.id, 'forward-nsfw').jobs;
  const wait = (condition: () => boolean, description: string) => f.waitFor(() => {consoleApp.inspections.tick(); return condition();}, description);
  return {consoleApp, bot, connection, broadcastForward, jobs, wait,
    environment: {CONSOLE_URL: `http://${requestHost}:${(consoleApp.app.server.address() as AddressInfo).port}`, BOT_INSTANCE_ID: bot.id, WORKER_TOKEN: bot.workerToken}};
}

test('forward NSFW notification quotes the real outer message while chat is busy and enters the next context once after ACK', {timeout: 50_000}, async t => {
  let held: {call: ModelCall; response: ServerResponse} | undefined, turns = 0;
  const f = await piFixture(t, (call, response) => {
    if (call.results.length) {assertAccepted(call); respond(call, response, 'Done.'); return;}
    turns++;
    if (turns === 1) {
      assert.doesNotMatch(JSON.stringify(call.body), /Synthetic private image-check reminder\./u);
      assert.deepEqual(call.replyTargetMessageIds, ['busy-start']); held = {call, response};
    }
    else {
      assert.deepEqual(call.replyTargetMessageIds, ['follow-up']);
      assert.ok(call.batch.some(message => message.messageId === 'forward-check'));
      assert.match(JSON.stringify(call.batch), /Forward context detail/u);
      const reminders = call.batch.filter(message => message.origin === 'plugin' && message.text === warning);
      assert.equal(reminders.length, 1, 'only the confirmed reminder is appended as an actual chat message');
      assert.equal(reminders[0]!.pluginId, 'forward-nsfw');
      assert.equal(reminders[0]!.replyTo, 'forward-check');
      assert.doesNotMatch(JSON.stringify(call.body), /"nsfw_0"|"score":0\.98|additional_criteria|isolated-vision-key/u);
      sendReply(call, response, [{type: 'text', text: 'The original forwarded content remains visible.'}]);
    }
  });
  const judgeRequests: Record<string, any>[] = [];
  const s = await setup(t, f, async (url, init) => {
    assert.equal(url, 'https://judge.invalid/v1/systemone');
    assert.equal(new Headers(init?.headers).get('TypeSafe-Danger-Zone-Images'), 'true');
    const body = JSON.parse(String(init?.body)); judgeRequests.push(body);
    assert.equal(Object.keys(body.assets).length, 1);
    assert.doesNotMatch(JSON.stringify(body), /busy-start|Forward context detail|Original author|synthetic-private/u);
    return unsafeResponse(body);
  });
  const worker = await f.start('1001', s.environment);
  await f.waitFor(() => s.consoleApp.gateway.getBotStatus(s.bot.id).channelConnected, 'isolated managed Worker transport');
  f.send('busy-start', 'Hold this ordinary model turn.', true);
  await f.waitFor(() => !!held, 'main model generation remains held');
  s.broadcastForward('forward-check');
  await s.wait(() => notifications(f.outgoing).length === 1 && s.jobs()[0]?.deliveries[0]?.status === 'acknowledged', 'NSFW reminder completes independently of the busy model');
  assert.equal(turns, 1, 'inspection does not wake another main-model turn');
  assert.equal(s.jobs()[0]!.inspection!.imageCount, 2);
  assert.equal(s.jobs()[0]!.inspection!.messageCount, 2, 'a nested forward wrapper is not a third message');
  assert.equal(s.jobs()[0]!.inspection!.ratioPercent, 100);
  assert.equal(s.jobs()[0]!.inspection!.outcome, 'detected');
  assert.equal(notifications(f.outgoing)[0]!.params.message.find(item => item.type === 'reply')?.data.id, 'forward-check');
  await f.waitFor(() => f.read('1001', db => db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE origin='plugin' AND text=?").get(warning)!.n) === 1, 'the actual reminder ACK is recorded while the model remains busy');
  assert.equal(turns, 1, 'recording the reminder never wakes a model turn');
  const notificationId = s.jobs()[0]!.deliveries[0]!.messageId!;
  assert.equal(s.consoleApp.db.messageState.get(s.bot.id, notificationId)?.origin, 'system', 'a notification is not a recallable model reply');
  s.broadcastForward('forward-check');
  await delay(150); s.consoleApp.inspections.tick();
  assert.equal(s.jobs().length, 1); assert.equal(judgeRequests.length, 1); assert.equal(notifications(f.outgoing).length, 1);
  sendReply(held!.call, held!.response, [{type: 'text', text: 'The ordinary model turn is complete.'}]);
  await f.waitFor(() => f.outgoing.some(item => messageText(item) === 'The ordinary model turn is complete.'), 'ordinary held reply sends');
  await f.waitFor(() => f.read('1001', db => db.prepare('SELECT COUNT(*) AS n FROM pending_batch').get()!.n) === 0, 'ordinary model turn finishes');
  f.send('follow-up', 'What was in the forwarded content?', true);
  await f.waitFor(() => f.complete(3), 'follow-up sees the original forward and the confirmed reminder');
  assert.equal(turns, 2);
  const history = f.read('1001', db => ({
    messages: db.prepare('SELECT * FROM chat_messages').all(), outgoing: db.prepare('SELECT * FROM outgoing_history').all(),
    memory: db.prepare('SELECT * FROM memory_ingest').all(),
  }));
  assert.equal(history.messages.filter(item => item.origin === 'plugin' && item.text === warning).length, 1);
  assert.equal(history.outgoing.filter(item => item.text === warning).length, 1);
  assert.equal(history.memory.filter(item => item.text === warning).length, 1, 'only the sent reminder is a memory source, not the classification');
  assert.doesNotMatch(JSON.stringify(history), /"nsfw_0"|"score":0\.98|isolated-vision-key/u);
  assert.equal(judgeRequests.length, 1);
  await f.stop(worker);
});

test('ordinary images do not create inspections and changing plugin configuration cancels an in-flight positive result', {timeout: 30_000}, async t => {
  const f = await piFixture(t, () => {throw new Error('No main model call is allowed.');});
  let release: (() => void) | undefined, judgeCalls = 0;
  const s = await setup(t, f, async (_url, init) => {
    judgeCalls++; const body = JSON.parse(String(init?.body));
    await new Promise<void>(resolve => {release = resolve;}); return unsafeResponse(body);
  });
  f.broadcast({...f.event('ordinary-picture', '', false), message: [{type: 'image', data: {url: 'https://image.invalid/ordinary'}}]});
  await f.waitFor(() => s.consoleApp.db.images.forMessage(s.bot.id, 'ordinary-picture').length === 1, 'ordinary image arrives');
  s.consoleApp.inspections.tick(); assert.equal(s.jobs().length, 0); assert.equal(judgeCalls, 0);
  s.broadcastForward('cancelled-forward');
  await s.wait(() => !!release, 'inspection request is in flight');
  const current = s.consoleApp.db.plugins.view(s.bot.id, 'forward-nsfw');
  s.consoleApp.db.plugins.update(s.bot.id, 'forward-nsfw', {expectedRevision: current.revision, enabled: false});
  s.consoleApp.inspections.tick(); release!();
  await s.wait(() => s.jobs()[0]?.state === 'cancelled', 'old configuration is cancelled');
  await delay(150); s.consoleApp.inspections.tick();
  assert.equal(judgeCalls, 1); assert.equal(notifications(f.outgoing).length, 0); assert.equal(s.jobs()[0]!.deliveries.length, 0);
  assert.equal(s.consoleApp.db.plugins.snapshot(s.bot.id).results.length, 0);
});

test('picture-count gating checks a lone picture among text and includes the configured boundary', {timeout: 30_000}, async t => {
  const f = await piFixture(t, () => {throw new Error('Image inspection must not invoke the main model.');});
  let calls = 0;
  const s = await setup(t, f, async (_url, init) => {calls++; return unsafeResponse(JSON.parse(String(init?.body)));});
  const previous = f.onSend;
  f.onSend = (request, socket) => {
    if (request.action !== 'get_forward_msg') return previous?.(request, socket);
    const id = String((request.params as unknown as {message_id?: string}).message_id);
    const count = id.includes('single-picture') ? 1 : id.includes('below-count') ? 2 : 3;
    const messages = [...Array.from({length: 100}, () => ({message: [{type: 'text', data: {text: 'Synthetic discussion'}}]})),
      {message: Array.from({length: count}, (_, index) => ({type: 'image', data: {url: `https://image.invalid/picture-${index}`}}))}];
    socket.send(JSON.stringify({echo: request.echo, status: 'ok', retcode: 0, data: {messages}})); return false;
  };
  s.broadcastForward('single-picture');
  await s.wait(() => s.jobs().find(job => job.sourceMessageId === 'single-picture')?.deliveries[0]?.status === 'acknowledged', 'one picture among text is classified and its reminder is acknowledged');
  assert.equal(calls, 1);
  assert.equal(s.jobs()[0]!.inspection!.imageCount, 1);
  assert.equal(s.jobs()[0]!.inspection!.messageCount, 101);
  const view = s.consoleApp.db.plugins.view(s.bot.id, 'forward-nsfw');
  s.consoleApp.db.plugins.update(s.bot.id, 'forward-nsfw', {expectedRevision: view.revision, config: {minImages: 3}});
  s.broadcastForward('below-count');
  await s.wait(() => s.jobs().find(job => job.sourceMessageId === 'below-count')?.inspection?.outcome === 'skipped', 'two pictures are below the three-picture minimum');
  assert.equal(s.jobs().find(job => job.sourceMessageId === 'below-count')!.inspection!.reason, 'IMAGE_COUNT_BELOW_THRESHOLD');
  assert.equal(calls, 1);
  s.broadcastForward('at-count-boundary');
  await s.wait(() => s.jobs().find(job => job.sourceMessageId === 'at-count-boundary')?.deliveries[0]?.status === 'acknowledged', 'three pictures in one message reach the minimum even when text dominates');
  const boundary = s.jobs().find(job => job.sourceMessageId === 'at-count-boundary')!.inspection!;
  assert.equal(boundary.imageCount, 3);
  assert.equal(boundary.imageMessageCount, 1);
  assert.equal(boundary.checkedCount, 2);
  assert.equal(notifications(f.outgoing).length, 2);
});

test('a failed Jev image request stays an unknown plugin result and never emits a group error or reminder', {timeout: 30_000}, async t => {
  const f = await piFixture(t, () => {throw new Error('No main model call is allowed.');});
  let calls = 0;
  const s = await setup(t, f, async () => {calls++; return new Response('synthetic private upstream details', {status: 503});});
  s.broadcastForward('failed-forward');
  await s.wait(() => s.jobs()[0]?.state === 'failed', 'Jev failure is durably recorded');
  assert.equal(calls, 1); assert.equal(s.jobs()[0]!.inspection!.outcome, 'unknown');
  assert.equal(s.jobs()[0]!.inspection!.reason, 'NSFW_HTTP_ERROR');
  assert.equal(s.jobs()[0]!.deliveries.length, 0);
  assert.equal(f.outgoing.filter(item => item.action === 'send_group_msg').length, 0);
  assert.equal(s.consoleApp.db.plugins.snapshot(s.bot.id).results.length, 0);
  assert.doesNotMatch(JSON.stringify(s.jobs()), /private upstream details|isolated-vision-key|synthetic-private/u);
});


for (const status of ['failed', 'unconfirmed'] as const) {
  test(`a ${status} reminder never publishes a sent chat fact`, {timeout: 30_000}, async t => {
    const f = await piFixture(t, () => {throw new Error('No main model call is allowed.');});
    const s = await setup(t, f, async (_url, init) => unsafeResponse(JSON.parse(String(init?.body))), status);
    s.broadcastForward(`delivery-${status}`);
    await s.wait(() => s.jobs()[0]?.deliveries[0]?.status === status, 'real gateway records the unsuccessful reminder delivery');
    assert.equal(s.jobs()[0]!.inspection!.outcome, 'detected');
    assert.equal(notifications(f.outgoing).length, 1);
    assert.equal(s.consoleApp.db.plugins.snapshot(s.bot.id).results.length, 0, 'only a genuine ACK can publish the reminder into context');
    for (let index = 0; index < 3; index++) s.consoleApp.inspections.tick();
    await delay(100);
    assert.equal(notifications(f.outgoing).length, 1, 'uncertain deliveries never create another send intent');
    assert.equal(s.consoleApp.db.plugins.snapshot(s.bot.id).results.length, 0);
  });
}

function bluePixel(): Buffer {
  const chunk = (type: string, value: Buffer) => {
    const name = Buffer.from(type), length = Buffer.alloc(4), sum = Buffer.alloc(4);
    length.writeUInt32BE(value.length); sum.writeUInt32BE(crc32(Buffer.concat([name, value])));
    return Buffer.concat([length, name, value, sum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0,0,0,255]))), chunk('IEND', Buffer.alloc(0))]);
}

test('partial image failure retains a positive score, reports the failed sample and reuses only successful scores across new messages', {timeout: 40_000}, async t => {
  const f = await piFixture(t, () => {throw new Error('This observer must not invoke the main model.');});
  let calls = 0;
  const s = await setup(t, f, async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(Object.keys(body.assets).length, 1);
    calls++;
    return calls === 1 ? unsafeResponse(body) : new Response('synthetic unavailable image judgment', {status: 503});
  }, undefined, bluePixel());
  s.broadcastForward('partial-first');
  await s.wait(() => s.jobs().find(j => j.sourceMessageId === 'partial-first')?.deliveries[0]?.status === 'acknowledged', 'successful positive sample still produces its acknowledged reminder');
  const first = s.jobs().find(j => j.sourceMessageId === 'partial-first')!.inspection!;
  assert.equal(first.outcome, 'detected'); assert.equal(first.checkedCount, 1); assert.equal(first.requestCount, 2);
  assert.equal(first.reason, 'PARTIAL_IMAGE_COVERAGE'); assert.equal(first.failures?.length, 1);
  assert.equal(first.failures![0]!.code, 'NSFW_HTTP_ERROR'); assert.equal(first.failures![0]!.httpStatus, 503);
  s.broadcastForward('partial-second');
  await s.wait(() => s.jobs().find(j => j.sourceMessageId === 'partial-second')?.deliveries[0]?.status === 'acknowledged', 'a new message can reuse the successful score without caching the failed score');
  const second = s.jobs().find(j => j.sourceMessageId === 'partial-second')!.inspection!;
  assert.equal(second.outcome, 'detected'); assert.equal(second.checkedCount, 1);
  assert.equal(second.cacheHits, 1); assert.equal(second.requestCount, 1); assert.equal(second.preparedCacheHits, 1);
  assert.equal(second.failures?.length, 1); assert.equal(calls, 3);
  assert.equal(notifications(f.outgoing).length, 2, 'new real messages keep their own quoted reminders');
  assert.deepEqual(notifications(f.outgoing).map(v => v.params.message.find(m => m.type === 'reply')?.data.id).sort(), ['partial-first', 'partial-second']);
});
