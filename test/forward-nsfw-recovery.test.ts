import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { ConsoleDatabase } from '../src/console/database.js';
import { ConsoleImagePrefetch } from '../src/console/incoming-images.js';
import { ForwardInspectionCoordinator } from '../src/console/inspection-coordinator.js';
import type { NapcatGateway } from '../src/console/napcat-gateway.js';

const quiet = { info() {}, warn() {}, error() {} };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
const sourceKey = 'forward:s0/n74/s0';
const summary = (attachmentId: string) => ({ messageCount: 75, imageMessageCount: 75, imageCount: 75,
  structuralComplete: true, samples: [{ sourceKey, attachmentId }] });

async function until(condition: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) { assert.ok(Date.now() < deadline, description); await delay(5); }
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'nekodock-nsfw-recovery-'));
  const file = join(root, 'console.sqlite3'), key = join(root, 'master.key');
  let db = new ConsoleDatabase(file, key);
  const bot = db.createBot({ name: 'Synthetic recovery bot', targetType: 'group', targetId: '1001', config: {} });
  db.bindNapcatAccount(bot.connectionId, '999');
  db.setDesiredState(bot.id, 'running');
  db.plugins.update(bot.id, 'forward-nsfw', { expectedRevision: 0, enabled: true, config: { apiKey: 'synthetic-recovery-key' } });
  const prefetches: ConsoleImagePrefetch[] = [], coordinators: ForwardInspectionCoordinator[] = [];
  let sends = 0;
  const gateway = { async send() { sends++; throw new Error('This isolated recovery fixture must not send QQ messages.'); } } as unknown as NapcatGateway;
  const images = () => {
    const prefetch = new ConsoleImagePrefetch({ store: db.images, root: join(root, 'media'), bot: id => db.getBot(id), logger: quiet,
      fetch: async () => new Response(png) });
    prefetches.push(prefetch); return prefetch;
  };
  const coordinator = (prefetch: ConsoleImagePrefetch, fetch?: typeof globalThis.fetch) => {
    const value = new ForwardInspectionCoordinator({ db, images: prefetch, gateway, logger: quiet, fetch });
    coordinators.push(value); return value;
  };
  t.after(async () => {
    for (const coordinator of coordinators) await coordinator.close();
    for (const prefetch of prefetches) await prefetch.close();
    db.close(); await rm(root, { recursive: true, force: true });
  });
  return { bot, images, coordinator, get db() { return db; }, get sends() { return sends; },
    restart() { db.close(); db = new ConsoleDatabase(file, key); },
  };
}

test('switching the main conversation preserves an already running forwarded-image check', async t => {
  const f = await fixture(t);
  const store = f.db.plugins.inspections;
  const job = store.begin(f.bot.id, 'synthetic-running-source', '999')!;
  store.complete(job.id, summary('synthetic-attachment'));
  assert.equal(store.claim(new Set())?.id, job.id);
  f.db.plugins.observe(f.bot.id, { seq: 1, type: 'message.received', time: 1,
    conversationId: 'synthetic-old-conversation', payload: { messageId: 'synthetic-running-source' } });
  f.db.plugins.observe(f.bot.id, { seq: 2, type: 'conversation.started', time: 2,
    conversationId: 'synthetic-new-conversation', payload: {} });
  assert.equal(store.active(job.id), true);
  assert.equal(f.db.plugins.jobs(f.bot.id).find(item => item.id === job.id)!.state, 'running');
});

test('durable notification ACK wins over a later cancellation condition and never causes a resend', async t => {
  for (const condition of ['disabled', 'recalled', 'expired'] as const) await t.test(condition, async t => {
    const f = await fixture(t), store = f.db.plugins.inspections;
    const createdAt = condition === 'expired' ? Date.now() - 700_000 : Date.now();
    const source = `synthetic-acked-${condition}`;
    const job = store.begin(f.bot.id, source, '999', createdAt)!;
    store.complete(job.id, summary('synthetic-attachment'));
    assert.equal(store.claim(new Set(), createdAt + 1)?.id, job.id);
    store.finish(job.id, [{ sourceKey, score: 0.95 }], undefined, createdAt + 2);
    const notification = store.pendingNotifications()[0]!;
    store.startNotification(job.id);
    f.db.beginNapcatDelivery(f.bot.id, notification.deliveryId, 'a'.repeat(64));
    f.db.finishNapcatDelivery(f.bot.id, notification.deliveryId, 'acknowledged', { ok: true, messageId: 'synthetic-actual-qq-ack' });
    if (condition === 'disabled') f.db.plugins.update(f.bot.id, 'forward-nsfw', { expectedRevision: 1, enabled: false });
    if (condition === 'recalled') {
      f.db.messageState.register(f.bot.id, source, '123', 'human');
      f.db.messageState.recalled(f.bot.id, source, Date.now() / 1000, '123', '123');
    }
    // Simulate interruption between the gateway ACK and the plugin receipt write.
    f.restart();
    const recovered = f.db.plugins.inspections;
    assert.equal(recovered.deliveries(job.id)[0]!.status, 'acknowledged', 'The UI prefers the durable gateway fact even before reconciliation.');
    const coordinator = f.coordinator(f.images());
    coordinator.start(false);
    await until(() => recovered.pendingNotifications().length === 0, 'Persisted notification ACK was not reconciled.');
    assert.deepEqual(recovered.deliveries(job.id), [{ kind: 'notification', status: 'acknowledged', messageId: 'synthetic-actual-qq-ack' }]);
    f.db.plugins.sync(f.bot.id, { bindings: [{ messageId: source, conversationId: 'synthetic-recovered-chat' }] });
    coordinator.tick();
    const facts = f.db.plugins.snapshot(f.bot.id).results;
    assert.equal(facts.length, 1, 'A recovered ACK publishes the actual reminder once for Worker history synchronization.');
    assert.equal(facts[0]!.kind, 'reply');
    assert.equal(facts[0]!.replyTo, source);
    assert.equal(facts[0]!.delivery?.messageId, 'synthetic-actual-qq-ack');
    assert.doesNotMatch(JSON.stringify(facts), /sourceKey|nsfwThresholdPercent|scores|synthetic-recovery-key/u);
    assert.equal(f.sends, 0);
  });
});

test('an interrupted notification with no ACK remains unconfirmed even after plugin shutdown', async t => {
  const f = await fixture(t), store = f.db.plugins.inspections;
  const job = store.begin(f.bot.id, 'synthetic-unconfirmed-source', '999')!;
  store.complete(job.id, summary('synthetic-attachment'));
  store.claim(new Set()); store.finish(job.id, [{ sourceKey, score: 0.95 }]);
  const notification = store.pendingNotifications()[0]!;
  store.startNotification(job.id);
  f.db.beginNapcatDelivery(f.bot.id, notification.deliveryId, 'b'.repeat(64));
  f.db.plugins.update(f.bot.id, 'forward-nsfw', { expectedRevision: 1, enabled: false });
  f.restart();
  const coordinator = f.coordinator(f.images()); coordinator.start(false);
  await until(() => f.db.plugins.inspections.pendingNotifications().length === 0, 'Interrupted notification was not settled.');
  assert.equal(f.db.plugins.inspections.deliveries(job.id)[0]!.status, 'unconfirmed');
  f.db.plugins.sync(f.bot.id, { bindings: [{ messageId: 'synthetic-unconfirmed-source', conversationId: 'synthetic-recovered-chat' }] });
  assert.deepEqual(f.db.plugins.snapshot(f.bot.id).results, [], 'An unconfirmed send must not become an assistant chat fact.');
  assert.equal(f.sends, 0);
});

test('Console shutdown preserves sampled-image leases so the same bytes resume after reconstruction', { timeout: 20_000 }, async t => {
  const f = await fixture(t), store = f.db.plugins.inspections;
  const job = store.begin(f.bot.id, 'synthetic-lease-source', '999')!;
  const image = f.db.images.registerInspectionSource(f.bot.id, 'synthetic-lease-source', sourceKey,
    'https://example.invalid/synthetic-sample', job.id, job.expiresAt)!;
  store.complete(job.id, summary(image.id));
  const firstPrefetch = f.images(); firstPrefetch.start(false);
  await until(() => f.db.images.get(f.bot.id, image.id).status === 'ready', 'Synthetic sample was not cached.');
  const payloads: string[] = [];
  let firstStarted = false;
  const first = f.coordinator(firstPrefetch, async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { assets: Record<string, { data_base64: string }> };
    payloads.push(Object.values(body.assets)[0]!.data_base64); firstStarted = true;
    return new Promise<Response>((_resolve, reject) => {
      const signal = init!.signal!;
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  first.start(false);
  await until(() => firstStarted || store.view(job.id)?.outcome === 'unknown', 'Initial classification did not reach the simulated Jev service.');
  assert.equal(firstStarted, true, `Initial classification failed: ${store.view(job.id)?.reason ?? 'unknown reason'}`);
  await first.close();
  assert.equal(store.active(job.id), true, 'Shutdown keeps the recoverable task active in the database.');
  assert.equal(f.db.images.hasLease(f.bot.id, image.id, job.id), true);
  assert.deepEqual((await firstPrefetch.contentForConsumer(f.bot.id, image.id, job.id)).bytes, png);
  await firstPrefetch.close(); f.restart();
  assert.equal(f.db.images.hasLease(f.bot.id, image.id, job.id), true);
  const secondPrefetch = f.images();
  const second = f.coordinator(secondPrefetch, async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { assets: Record<string, { data_base64: string }>; questions: Record<string, unknown> };
    payloads.push(Object.values(body.assets)[0]!.data_base64);
    return Response.json({ answers: Object.fromEntries(Object.keys(body.questions).map(key => [key, { type: 'noul', noul: 0.1 }])) });
  });
  second.start(false);
  await until(() => f.db.plugins.inspections.view(job.id)?.outcome === 'not_detected', 'Recovered task did not classify its fixed sample.');
  await second.close();
  assert.equal(payloads.length, 2);
  assert.equal(payloads[1], payloads[0], 'Recovery must reuse the persisted sample, with byte-stable image preparation.');
  assert.equal(f.db.plugins.inspections.view(job.id)!.checkedCount, 1);
  assert.equal(f.db.images.hasLease(f.bot.id, image.id, job.id), false, 'Terminal completion releases the consumer.');
  assert.equal(f.db.images.get(f.bot.id, image.id).status, 'expired');
  assert.equal(f.sends, 0);
});
