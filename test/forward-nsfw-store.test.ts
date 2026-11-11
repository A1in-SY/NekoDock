import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { ConsoleDatabase } from '../src/console/database.js';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'nekodock-nsfw-store-')), file = join(root, 'console.sqlite3'), key = join(root, 'master.key');
  let db = new ConsoleDatabase(file, key);
  const bot = db.createBot({name: 'Example', targetType: 'group', targetId: '1001', config: {}});
  db.setDesiredState(bot.id, 'running');
  t.after(() => { db.close(); rmSync(root, {recursive: true, force: true}); });
  return {bot, file, get db() {return db;}, restart() {db.close(); db = new ConsoleDatabase(file, key); return db;},
    enable() {return db.plugins.update(bot.id, 'forward-nsfw', {expectedRevision: 0, enabled: true, settings: {apiKey: 'synthetic-classifier-key'}});} };
}
const summary = (imageMessageCount = 7, structuralComplete = true) => ({messageCount: 10, imageMessageCount, imageCount: 20, structuralComplete,
  samples: [{sourceKey: 'forward:s0/n9/s0', attachmentId: 'synthetic-cache-id'}]});

test('inspection configuration is independent, encrypted and restricted to group instances', t => {
  const f = fixture(t);
  assert.equal(f.db.plugins.inspections.begin(f.bot.id, 'disabled', '999'), null);
  assert.throws(() => f.db.plugins.update(f.bot.id, 'forward-nsfw', {expectedRevision: 0, enabled: true}), /API Key/);
  const enabled = f.enable();
  assert.equal(enabled.configuredSecrets.apiKey, true);
  assert.equal(enabled.config.apiKey, undefined);
  assert.equal(f.db.getBot(f.bot.id)!.config.replyMode, 'random');
  const saved = f.db.plugins.update(f.bot.id, 'forward-nsfw', {expectedRevision: 1, settings: {maxImages: 8}});
  assert.equal(saved.configuredSecrets.apiKey, true);
  assert.throws(() => f.db.plugins.update(f.bot.id, 'forward-nsfw', {expectedRevision: 1}), /版本冲突/);
  const privateBot = f.db.createBot({name: 'Private example', targetType: 'private', targetId: '2002', connectionId: f.bot.connectionId, config: {}});
  assert.throws(() => f.db.plugins.update(privateBot.id, 'forward-nsfw', {expectedRevision: 0, enabled: true, settings: {apiKey: 'synthetic-key'}}), /群聊/);
  const sql = new DatabaseSync(f.file, {readOnly: true});
  try { assert.doesNotMatch(String(sql.prepare("SELECT config_cipher FROM plugin_configs WHERE plugin_id='forward-nsfw'").get()!.config_cipher), /synthetic-classifier-key/); }
  finally {sql.close();}
});

test('image count below the minimum and incomplete structures skip classification', t => {
  const f = fixture(t); f.enable();
  f.db.plugins.update(f.bot.id, 'forward-nsfw', {expectedRevision: 1, config: {minImages: 3}});
  for (const [id, input, reason] of [
    ['below-minimum', {...summary(1), imageCount: 2}, 'IMAGE_COUNT_BELOW_THRESHOLD'], ['incomplete', summary(9, false), 'FORWARD_INCOMPLETE'],
    ['empty', {...summary(0), imageCount: 0, samples: []}, 'NO_IMAGES'],
  ] as const) {
    const job = f.db.plugins.inspections.begin(f.bot.id, id, '999')!;
    f.db.plugins.inspections.complete(job.id, input);
    assert.equal(f.db.plugins.inspections.view(job.id)!.outcome, 'skipped');
    assert.equal(f.db.plugins.inspections.view(job.id)!.reason, reason);
  }
  assert.equal(f.db.plugins.inspections.claim(new Set()), null);
  assert.deepEqual(f.db.plugins.inspections.pendingNotifications(), []);
});

test('image count includes every picture and starts at the configured minimum regardless of surrounding text', t => {
  const f = fixture(t); f.enable();
  const first = f.db.plugins.inspections.begin(f.bot.id, 'one-picture', '999')!;
  assert.equal(first.minImages, 1);
  f.db.plugins.inspections.complete(first.id, {...summary(1), messageCount: 101, imageCount: 1});
  assert.equal(f.db.plugins.inspections.claim(new Set())!.id, first.id);
  f.db.plugins.inspections.finish(first.id, [{sourceKey: 'forward:s0/n9/s0', score: 0.2}]);
  f.db.plugins.update(f.bot.id, 'forward-nsfw', {expectedRevision: 1, config: {minImages: 3}});
  const boundary = f.db.plugins.inspections.begin(f.bot.id, 'three-pictures-one-message', '999')!;
  f.db.plugins.inspections.complete(boundary.id, {...summary(1), messageCount: 101, imageCount: 3});
  assert.equal(f.db.plugins.inspections.claim(new Set())!.id, boundary.id);
});

test('persisted legacy plugin configuration can be read, restarted and saved with the image-count threshold', t => {
  const f = fixture(t); f.enable();
  const encrypt = (f.db as unknown as {encrypt(value: unknown): string}).encrypt.bind(f.db);
  const sql = new DatabaseSync(f.file);
  try {
    sql.prepare("UPDATE plugin_configs SET config_cipher=? WHERE bot_id=? AND plugin_id='forward-nsfw'")
      .run(encrypt({imageRatioPercent: 100, maxImages: 8, nsfwThresholdPercent: 90, timeoutSeconds: 30,
        apiKey: 'synthetic-legacy-key', instructions: 'Synthetic classifier criteria', warningText: 'Synthetic reminder'}), f.bot.id);
  } finally { sql.close(); }
  f.restart();
  const view = f.db.plugins.view(f.bot.id, 'forward-nsfw');
  assert.equal(view.config.minImages, 1);
  assert.equal(view.config.imageRatioPercent, undefined);
  assert.equal(view.config.maxImages, 8);
  assert.equal(view.config.nsfwThresholdPercent, 90);
  assert.equal(view.config.timeoutSeconds, 30);
  assert.equal(view.config.instructions, 'Synthetic classifier criteria');
  assert.equal(view.config.warningText, 'Synthetic reminder');
  assert.equal(view.configuredSecrets.apiKey, true);
  const saved = f.db.plugins.update(f.bot.id, 'forward-nsfw', {expectedRevision: view.revision, config: {minImages: 2}});
  assert.equal(saved.config.minImages, 2);
  assert.equal(saved.configuredSecrets.apiKey, true);
  f.restart();
  assert.equal(f.db.plugins.view(f.bot.id, 'forward-nsfw').config.minImages, 2);
});

test('fixed samples survive recovery and only acknowledged reminders can become chat facts', t => {
  const f = fixture(t); f.enable();
  const job = f.db.plugins.inspections.begin(f.bot.id, 'source-101', '999')!;
  f.db.plugins.inspections.complete(job.id, summary());
  assert.deepEqual(f.db.plugins.snapshot(f.bot.id).pendingBindings, []);
  const first = f.db.plugins.inspections.claim(new Set())!;
  assert.equal(first.samples[0]!.attachmentId, 'synthetic-cache-id');
  f.restart().plugins.inspections.recover();
  const recovered = f.db.plugins.inspections.claim(new Set())!;
  assert.deepEqual(recovered.samples, first.samples);
  assert.equal(recovered.id, first.id);
  f.db.plugins.inspections.finish(recovered.id, [{sourceKey: recovered.samples[0]!.sourceKey, score: 0.8}]);
  const notifications = f.db.plugins.inspections.pendingNotifications();
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]!.replyTo, 'source-101');
  assert.equal(notifications[0]!.contextPolicy, 'chat');
  assert.equal(f.db.plugins.inspections.begin(f.bot.id, 'source-101', '999'), null);
  assert.deepEqual(f.db.plugins.snapshot(f.bot.id).results, []);
  assert.deepEqual(f.db.plugins.snapshot(f.bot.id).pendingSources, []);
  f.db.plugins.inspections.startNotification(recovered.id);
  f.restart();
  assert.equal(f.db.plugins.inspections.pendingNotifications()[0]!.deliveryId, notifications[0]!.deliveryId);
  f.db.plugins.inspections.finishNotification(recovered.id, {ok: false, code: 'NAPCAT_SEND_UNCONFIRMED', deliveryStatus: 'unconfirmed'});
  assert.deepEqual(f.db.plugins.inspections.pendingNotifications(), []);
  const view = f.db.plugins.jobs(f.bot.id)[0]!;
  assert.equal(view.inspection!.outcome, 'detected');
  assert.equal(view.deliveries[0]!.kind, 'notification');
  assert.equal(view.deliveries[0]!.status, 'unconfirmed');
  const sql = new DatabaseSync(f.file, {readOnly: true});
  try {assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM plugin_results').get()!.n, 0); assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM event_projection').get()!.n, 0);}
  finally {sql.close();}
});

test('main conversation boundaries do not cancel the independent observer queue', t => {
  const f = fixture(t); f.enable();
  const job = f.db.plugins.inspections.begin(f.bot.id, 'source', '999')!;
  f.db.plugins.inspections.complete(job.id, summary());
  f.db.plugins.observe(f.bot.id, {seq: 1, type: 'message.received', time: 1, conversationId: 'old', payload: {messageId: 'source'}});
  f.db.plugins.observe(f.bot.id, {seq: 2, type: 'conversation.started', time: 2, conversationId: 'new', payload: {}});
  assert.equal(f.db.plugins.inspections.active(job.id), true);
  assert.ok(f.db.plugins.inspections.claim(new Set()));
});

test('config changes cancel work and stop old positive results from authorizing a notification', t => {
  const f = fixture(t); f.enable();
  const queued = f.db.plugins.inspections.begin(f.bot.id, 'queued', '999')!;
  f.db.plugins.inspections.complete(queued.id, summary());
  f.db.plugins.inspections.claim(new Set());
  f.db.plugins.inspections.finish(queued.id, [{sourceKey: 'forward:s0/n9/s0', score: 0.95}]);
  assert.equal(f.db.plugins.inspections.notificationAllowed(queued.id, '999'), true);
  assert.equal(f.db.plugins.inspections.notificationAllowed(queued.id, 'different-account'), false);
  const resolving = f.db.plugins.inspections.begin(f.bot.id, 'resolving', '999')!;
  f.db.plugins.update(f.bot.id, 'forward-nsfw', {expectedRevision: 1, enabled: false});
  assert.equal(f.db.plugins.inspections.notificationAllowed(queued.id, '999'), false);
  assert.equal(f.db.plugins.inspections.active(resolving.id), false);
  assert.equal(f.db.plugins.inspections.view(resolving.id)!.outcome, 'skipped');
  assert.ok(f.db.plugins.inspections.retention().some(item => item.consumer === resolving.id));
  f.db.plugins.inspections.released(resolving.id);
  assert.ok(!f.db.plugins.inspections.retention().some(item => item.consumer === resolving.id));
});

test('unreadable or failed judgments are unknown, partial negatives remain explicitly sampled', t => {
  const f = fixture(t); f.enable();
  const negative = f.db.plugins.inspections.begin(f.bot.id, 'negative', '999')!;
  f.db.plugins.inspections.complete(negative.id, {...summary(), samples: [...summary().samples, {sourceKey: 'forward:s0/n10/s0'}]});
  assert.equal(f.db.plugins.inspections.claim(new Set([f.bot.id])), null);
  f.db.plugins.inspections.claim(new Set());
  f.db.plugins.inspections.finish(negative.id, [{sourceKey: 'forward:s0/n9/s0', score: 0.2}], 'PARTIAL_IMAGE_COVERAGE');
  assert.equal(f.db.plugins.inspections.view(negative.id)!.checkedCount, 1);
  assert.equal(f.db.plugins.inspections.view(negative.id)!.reason, 'PARTIAL_IMAGE_COVERAGE');
  assert.equal(f.db.plugins.inspections.view(negative.id)!.outcome, 'not_detected');
  const failed = f.db.plugins.inspections.begin(f.bot.id, 'failed', '999')!;
  f.db.plugins.inspections.complete(failed.id, summary()); f.db.plugins.inspections.claim(new Set());
  f.db.plugins.inspections.finish(failed.id, [], 'NSFW_TIMEOUT');
  assert.equal(f.db.plugins.inspections.view(failed.id)!.outcome, 'unknown');
  assert.deepEqual(f.db.plugins.inspections.pendingNotifications(), []);
});

test('inspection deadline includes all single-image request waves and keeps individual failure details', t => {
  const f = fixture(t); f.enable();
  const first = f.db.plugins.inspections.begin(f.bot.id, 'timed-source', '999', 1000)!;
  assert.equal(first.expiresAt, 241_000, 'four default samples have two 60-second waves plus bounded queue/prepare time');
  f.db.plugins.inspections.complete(first.id, summary());
  f.db.plugins.inspections.claim(new Set(), 1001);
  f.db.plugins.inspections.finish(first.id, [{sourceKey: 'forward:s0/n9/s0', score: 0.9}], 'PARTIAL_IMAGE_COVERAGE', 1002,
    {requestCount: 2, cacheHits: 1, preparedCacheHits: 1, failures: [{sourceKey: 'forward:s0/n10/s0', code: 'NSFW_TIMEOUT'}]});
  const view = f.db.plugins.inspections.view(first.id)!;
  assert.equal(view.outcome, 'detected'); assert.equal(view.requestCount, 2); assert.equal(view.cacheHits, 1);
  assert.deepEqual(view.failures, [{sourceKey: 'forward:s0/n10/s0', code: 'NSFW_TIMEOUT'}]);
  const current = f.db.plugins.view(f.bot.id, 'forward-nsfw');
  f.db.plugins.update(f.bot.id, 'forward-nsfw', {expectedRevision: current.revision, config: {maxImages: 16, timeoutSeconds: 60}});
  const largest = f.db.plugins.inspections.begin(f.bot.id, 'large-sample', '999', 2000)!;
  assert.equal(largest.expiresAt, 602_000, 'maximum sample size remains bounded to ten minutes');
});
