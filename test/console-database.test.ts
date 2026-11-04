import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, randomBytes } from 'node:crypto';
import { ConsoleDatabase, NAPCAT_QUEUE_LIMITS } from '../src/console/database.js';
import { defaultSettings, normalizeNapcatUrl, normalizeSettings, settingsFromEnv, settingsToEnv, validateSettings } from '../src/console/settings.js';
import type { BotRecord, ConsoleEvent, WorkerHeartbeat } from '../src/console/contracts.js';
import { loadConfig } from '../src/config.js';
import { NAPCAT_EVENT_MAX_BYTES } from '../src/transport-protocol.js';

function database(t: test.TestContext): { db: ConsoleDatabase; path: string; keyPath: string; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), 'napcat-console-db-test-'));
  const path = join(directory, 'console.sqlite3'); const keyPath = join(directory, 'master.key');
  const db = new ConsoleDatabase(path, keyPath);
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { db, path, keyPath, directory };
}
function create(db: ConsoleDatabase, name = 'test', targetId = '10001'): BotRecord {
  return db.createBot({ name, targetType: 'group', targetId, config: defaultSettings() });
}
function event(seq: number, type: string, payload: Record<string, unknown> = {}, time = Date.now(), conversationId = 'conversation-1'): ConsoleEvent {
  return { seq, type, payload, time, conversationId };
}
function heartbeat(events: ConsoleEvent[] = [], patch: Partial<WorkerHeartbeat> = {}): WorkerHeartbeat {
  return { revision: 1, connected: true, processing: false, drained: true, conversationId: 'conversation-1', events, ...patch };
}

test('management settings have independent defaults and validate active providers', () => {
  const first = defaultSettings(); first.persona = 'changed';
  assert.equal(defaultSettings().persona, '');
  assert.deepEqual(validateSettings({}), defaultSettings());
  assert.throws(() => validateSettings({ replyProbability: 101 }), /0 至 100/u);
  assert.throws(() => validateSettings({ baseUrl: 'https://model.example/v1' }), /AGENT_MODEL/u);
  assert.throws(() => validateSettings({ modelApi: 'invalid' }), /modelApi/u);
  assert.throws(() => validateSettings({ reasoning: 'ultra' }), /reasoning/u);
  assert.throws(() => validateSettings({ batchSize: 1001 }), /BATCH_SIZE/u);
  assert.throws(() => validateSettings({ searchProvider: 'tavily' }), /TAVILY_API_KEY/u);
  assert.throws(() => validateSettings({ voiceEnabled: true }), /TTS_PROVIDER/u);
  assert.throws(() => validateSettings({ ttsProvider: 'mimo' }), /MIMO_TTS_API_KEY/u);
  assert.throws(() => validateSettings({ modelTimeout: NaN }), /modelTimeout/u);
  assert.throws(() => validateSettings({ voiceEnabled: 'true' }), /voiceEnabled/u);
  assert.throws(() => validateSettings({ unexpected: 1 }), /未知配置项/u);
  assert.throws(() => validateSettings(null), /配置必须为对象/u);
  const inactive = validateSettings({ searchBaseUrl: 'invalid inactive URL', ttsBaseUrl: 'invalid inactive URL' });
  assert.equal(inactive.searchBaseUrl, 'invalid inactive URL');
  assert.throws(() => validateSettings({ searchProvider: 'tavily', tavilyApiKey: 'test-credential' }, inactive), /TAVILY_SEARCH_BASE_URL/u);
});

test('NapCat resources encrypt tokens, normalize URLs, mask public responses and enforce optimistic changes', t => {
  const {db, path} = database(t);
  const connection = db.createNapcatConnection({name: ' Shared connection ', wsUrl: 'WS://NAPCAT.EXAMPLE:80', token: 'synthetic-napcat-token', actionTimeout: 22});
  assert.equal(connection.name, 'Shared connection'); assert.equal(connection.wsUrl, 'ws://napcat.example/');
  assert.equal(connection.revision, 1); assert.equal(connection.reconnectSeconds, 3);
  const inspector = new DatabaseSync(path); t.after(() => inspector.close());
  const stored = JSON.stringify(inspector.prepare('SELECT * FROM napcat_connections').all());
  assert.equal(stored.includes('synthetic-napcat-token'), false);
  assert.equal(db.getPublicNapcatConnection(connection.id)!.tokenConfigured, true);
  assert.equal('token' in db.getPublicNapcatConnection(connection.id)!, false);
  assert.throws(() => db.createNapcatConnection({name: 'duplicate', wsUrl: connection.wsUrl, token: connection.token}), /已有连接/u);
  const renamed = db.updateNapcatConnection(connection.id, {name: 'Renamed', expectedRevision: 1});
  assert.equal(renamed.token, connection.token); assert.equal(renamed.revision, 2);
  assert.throws(() => db.updateNapcatConnection(connection.id, {name: 'stale', expectedRevision: 1}), /版本冲突/u);
  assert.equal(db.updateNapcatConnection(connection.id, {token: null}).token, undefined);
  assert.equal(db.getPublicNapcatConnection(connection.id)!.tokenConfigured, false);
  for (const wsUrl of ['http://napcat.example/', 'ws://user:pass@napcat.example/', 'ws://napcat.example/?token=secret', 'ws://napcat.example/#token']) {
    assert.throws(() => normalizeNapcatUrl(wsUrl), /地址/u);
  }
  assert.throws(() => db.createNapcatConnection({name: 'invalid', wsUrl: 'ws://napcat.example/', token: 'line\nbreak'}), /Token/u);
  assert.throws(() => db.updateNapcatConnection(connection.id, {reconnectSeconds: 0}), /正数/u);
  db.deleteNapcatConnection(connection.id); assert.equal(db.getNapcatConnection(connection.id), null);
});

test('instances share resources, keep connection credentials out of snapshots, and protect referenced connections', t => {
  const {db} = database(t);
  const connection = db.createNapcatConnection({name: 'Primary', wsUrl: 'ws://primary.example/', token: 'synthetic-resource-token', actionTimeout: 21});
  const bot = db.createBot({name: 'First', targetType: 'group', targetId: '10001', connectionId: connection.id, config: {modelApiKey: 'synthetic-model-token'}});
  const second = db.createBot({name: 'Second', targetType: 'private', targetId: '10002', connectionId: connection.id, config: {}});
  assert.deepEqual(new Set(db.getPublicNapcatConnection(connection.id)!.botIds), new Set([bot.id, second.id]));
  assert.throws(() => db.deleteNapcatConnection(connection.id), /引用/u);
  const snapshot = db.getWorkerSnapshot(bot.id);
  assert.equal(snapshot.env.NAPCAT_WS_URL, 'ws://console.invalid/'); assert.equal(snapshot.env.NAPCAT_TOKEN, '');
  assert.equal(snapshot.env.ACTION_TIMEOUT_MS, '21000'); assert.equal(snapshot.env.AGENT_API_KEY, 'synthetic-model-token');
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes(connection.wsUrl), false); assert.equal(serialized.includes(connection.token!), false);
  const other = db.createNapcatConnection({name: 'Secondary', wsUrl: 'ws://secondary.example/'});
  db.bindNapcatAccount(connection.id, '12345'); db.bindNapcatAccount(other.id, '12345');
  const updated = db.updateBot(bot.id, {connectionId: other.id, expectedRevision: 1});
  assert.equal(updated.desiredRevision, 2); assert.equal(updated.volume, bot.volume); assert.equal(updated.connectionId, other.id);
  db.updateNapcatConnection(other.id, {enabled: false});
  assert.throws(() => db.setDesiredState(bot.id, 'running'), /停用/u);
});

test('known account IDs prevent duplicate target ownership across different resource URLs', t => {
  const {db} = database(t);
  const first = db.createNapcatConnection({name: 'First', wsUrl: 'ws://one.example/'});
  const second = db.createNapcatConnection({name: 'Second', wsUrl: 'ws://two.example/'});
  const one = db.createBot({name: 'One', targetType: 'group', targetId: '10001', connectionId: first.id, config: {}});
  const two = db.createBot({name: 'Two', targetType: 'group', targetId: '10001', connectionId: second.id, config: {}});
  db.setDesiredState(one.id, 'running'); db.setDesiredState(two.id, 'running');
  db.bindNapcatAccount(first.id, '12345');
  assert.throws(() => db.bindNapcatAccount(second.id, '12345'), /已有运行中的实例/u);
  assert.equal(db.getNapcatConnection(second.id)!.accountId, null);
  db.setDesiredState(one.id, 'stopped'); db.bindNapcatAccount(second.id, '12345');
  assert.throws(() => db.setDesiredState(one.id, 'running'), /已有运行中的实例/u);
  db.updateNapcatConnection(first.id, {wsUrl: 'ws://changed.example/'});
  assert.equal(db.getNapcatConnection(first.id)!.accountId, '12345');
  assert.throws(() => db.bindNapcatAccount(first.id, '54321'), /登录账号已改变/u);
});

test('connection references can change only after full stop and verified identical account ownership', t => {
  const {db} = database(t); const bot = create(db);
  const original = db.getNapcatConnection(bot.connectionId)!;
  const sameAccount = db.createNapcatConnection({name: 'Alternate endpoint', wsUrl: 'ws://alternate.example/'});
  assert.throws(() => db.updateBot(bot.id, {connectionId: sameAccount.id}), /必须先验证登录账号/u);
  db.bindNapcatAccount(original.id, '12345');
  assert.throws(() => db.updateBot(bot.id, {connectionId: sameAccount.id}), /必须先验证登录账号/u);
  db.bindNapcatAccount(sameAccount.id, '12345');
  db.setDesiredState(bot.id, 'running');
  assert.throws(() => db.updateBot(bot.id, {connectionId: sameAccount.id}), /必须完全停止/u);
  db.setDesiredState(bot.id, 'stopped'); db.setRuntime(bot.id, {state: 'stopping'});
  assert.throws(() => db.updateBot(bot.id, {connectionId: sameAccount.id}), /必须完全停止/u);
  db.setRuntime(bot.id, {state: 'stopped', drained: false});
  assert.throws(() => db.updateBot(bot.id, {connectionId: sameAccount.id}), /必须完全停止/u);
  db.setRuntime(bot.id, {drained: true, processing: true});
  assert.throws(() => db.updateBot(bot.id, {connectionId: sameAccount.id}), /必须完全停止/u);
  db.setRuntime(bot.id, {processing: false});
  db.beginNapcatDelivery(bot.id, 'in-flight', 'a'.repeat(64));
  assert.throws(() => db.updateBot(bot.id, {connectionId: sameAccount.id}), /必须完全停止/u);
  db.finishNapcatDelivery(bot.id, 'in-flight', 'acknowledged');
  const different = db.createNapcatConnection({name: 'Other account', wsUrl: 'ws://other-account.example/'});
  db.bindNapcatAccount(different.id, '54321');
  assert.throws(() => db.updateBot(bot.id, {connectionId: different.id}), /其他 QQ 账号，请新建实例/u);
  const changed = db.updateBot(bot.id, {connectionId: sameAccount.id});
  assert.equal(changed.connectionId, sameAccount.id); assert.equal(changed.volume, bot.volume); assert.equal(changed.desiredRevision, 2);
});

test('connection send deadlines revise referencing Workers while credentials and upstream reconnect changes stay central', t => {
  const {db} = database(t); const one = create(db); const two = create(db, 'Other', '10002');
  const id = one.connectionId; db.bindNapcatAccount(id, '12345');
  db.updateNapcatConnection(id, {name: 'Renamed', token: 'synthetic-updated-token', wsUrl: 'ws://new-endpoint.example/', reconnectSeconds: 8});
  assert.equal(db.getNapcatConnection(id)!.accountId, '12345');
  assert.equal(db.getBot(one.id)!.desiredRevision, 1); assert.equal(db.getBot(two.id)!.desiredRevision, 1);
  assert.equal(db.getWorkerSnapshot(one.id).env.RECONNECT_MS, '3000');
  db.updateNapcatConnection(id, {actionTimeout: 22});
  assert.equal(db.getBot(one.id)!.desiredRevision, 2); assert.equal(db.getBot(two.id)!.desiredRevision, 2);
  assert.equal(db.getWorkerSnapshot(one.id).env.ACTION_TIMEOUT_MS, '22000');
  assert.equal(db.getBot(one.id)!.volume, one.volume);
  db.updateNapcatConnection(id, {actionTimeout: 22});
  assert.equal(db.getBot(one.id)!.desiredRevision, 2);
});

test('legacy endpoint settings merge connections without altering instance revisions, volumes or stored history', t => {
  const directory = mkdtempSync(join(tmpdir(), 'console-connection-migration-'));
  const path = join(directory, 'console.sqlite3'); const keyPath = join(directory, 'master.key');
  const initial = new ConsoleDatabase(path, keyPath);
  const first = create(initial, 'First', '10001'); const second = create(initial, 'Second', '10002');
  initial.ingestHeartbeat(first.id, heartbeat([event(1, 'conversation.started'), event(2, 'message.received', {messageId: 'persisted', text: 'Synthetic history'})]));
  initial.close();
  const inspector = new DatabaseSync(path);
  const legacyConfig = {...defaultSettings(), wsUrl: 'ws://legacy.example:3002/', napcatToken: 'synthetic-legacy-token'};
  const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', readFileSync(keyPath), nonce);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(legacyConfig), 'utf8'), cipher.final()]);
  const stored = Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64');
  inspector.prepare('UPDATE config_revisions SET config_cipher=?').run(stored);
  inspector.exec('UPDATE bots SET connection_id=NULL; DELETE FROM napcat_connections');
  inspector.close();
  const db = new ConsoleDatabase(path, keyPath); t.after(() => {db.close(); rmSync(directory, {recursive: true, force: true});});
  assert.equal(db.listNapcatConnections().length, 1);
  assert.equal(db.getBot(first.id)!.connectionId, db.getBot(second.id)!.connectionId);
  assert.equal(db.getBot(first.id)!.volume, first.volume); assert.equal(db.getBot(first.id)!.workerToken, first.workerToken);
  assert.equal(db.getBot(first.id)!.desiredRevision, first.desiredRevision); assert.equal(db.getBot(first.id)!.appliedRevision, 1);
  assert.equal(db.getConversation(first.id)!.items.length, 2);
  const resource = db.listNapcatConnections()[0]!; assert.equal(resource.wsUrl, legacyConfig.wsUrl); assert.equal(resource.token, legacyConfig.napcatToken);
  const reopened = new ConsoleDatabase(path, keyPath); t.after(() => reopened.close());
  assert.equal(reopened.listNapcatConnections().length, 1);
});

test('persistent inbound queue preserves order, isolates ACKs, deduplicates after ACK and survives reconnects', t => {
  const {db, path, keyPath} = database(t); const bot = create(db); const other = create(db, 'Other', '10002');
  assert.equal(db.enqueueNapcatEvent(bot.id, {text: 'not running'}, 'stopped'), null);
  db.setDesiredState(bot.id, 'running'); db.setDesiredState(other.id, 'running');
  const first = db.enqueueNapcatEvent(bot.id, {text: 'first synthetic message'}, 'conn:one')!;
  const foreign = db.enqueueNapcatEvent(other.id, {text: 'another instance'}, 'conn:one')!;
  const second = db.enqueueNapcatEvent(bot.id, {text: 'second synthetic message'}, 'conn:two')!;
  assert.ok(second > first); assert.deepEqual(db.pendingNapcatEvents(bot.id).map(item => item.seq), [first, second]);
  const inspector = new DatabaseSync(path); t.after(() => inspector.close());
  assert.equal(JSON.stringify(inspector.prepare('SELECT * FROM napcat_inbound').all()).includes('first synthetic message'), false);
  db.ackNapcatEvents(bot.id, first); db.ackNapcatEvents(bot.id, first);
  assert.equal(db.napcatAcknowledgedSeq(bot.id), first); assert.equal(db.pendingNapcatEventCount(other.id), 1);
  assert.equal(db.enqueueNapcatEvent(bot.id, {text: 'duplicate'}, 'conn:one'), null);
  const reopened = new ConsoleDatabase(path, keyPath); t.after(() => reopened.close());
  assert.equal(reopened.napcatAcknowledgedSeq(bot.id), first);
  assert.deepEqual(reopened.pendingNapcatEvents(bot.id), [{seq: second, event: {text: 'second synthetic message'}}]);
  assert.deepEqual(reopened.pendingNapcatEvents(other.id).map(item => item.seq), [foreign]);
  reopened.ackNapcatEvents(bot.id, second); reopened.ackNapcatEvents(bot.id, first);
  assert.equal(reopened.napcatAcknowledgedSeq(bot.id), second); assert.equal(reopened.pendingNapcatEventCount(bot.id), 0);
});

test('inbound queue bounds reject newest messages and expire retained data with inspectable counts', t => {
  t.mock.timers.enable({apis: ['Date'], now: Date.parse('2026-01-01T00:00:00Z')});
  const {db} = database(t); const bot = create(db); db.setDesiredState(bot.id, 'running');
  for (let index = 0; index < NAPCAT_QUEUE_LIMITS.messages; index++) assert.notEqual(db.enqueueNapcatEvent(bot.id, {id: index}, `id:${index}`), null);
  assert.equal(db.enqueueNapcatEvent(bot.id, {id: 'overflow'}, 'overflow'), null);
  assert.equal(db.getNapcatQueueStats(bot.id).pending, NAPCAT_QUEUE_LIMITS.messages); assert.equal(db.getNapcatQueueStats(bot.id).dropped, 1);
  t.mock.timers.tick(NAPCAT_QUEUE_LIMITS.retentionMs + 1);
  assert.equal(db.pendingNapcatEventCount(bot.id), 0); assert.equal(db.getNapcatQueueStats(bot.id).expired, NAPCAT_QUEUE_LIMITS.messages);
  const large = 'x'.repeat(NAPCAT_QUEUE_LIMITS.bytes);
  assert.equal(db.enqueueNapcatEvent(bot.id, {text: large}, 'oversized'), null);
  assert.equal(db.getNapcatQueueStats(bot.id).dropped, 2);
  assert.notEqual(db.enqueueNapcatEvent(bot.id, {id: 'fresh'}, 'id:0'), null);
});

test('inbound event byte limit accepts its boundary and drops oversized packets before they can block delivery', t => {
  const {db} = database(t); const bot = create(db); db.setDesiredState(bot.id, 'running');
  const overhead = Buffer.byteLength(JSON.stringify({text: ''}));
  const boundary = {text: 'x'.repeat(NAPCAT_EVENT_MAX_BYTES - overhead)};
  assert.equal(Buffer.byteLength(JSON.stringify(boundary)), NAPCAT_EVENT_MAX_BYTES);
  const accepted = db.enqueueNapcatEvent(bot.id, boundary, 'exact-boundary');
  assert.notEqual(accepted, null);
  assert.equal(db.getNapcatQueueStats(bot.id).bytes, NAPCAT_EVENT_MAX_BYTES);
  assert.equal(db.enqueueNapcatEvent(bot.id, {text: `${boundary.text}x`}, 'one-byte-over'), null);
  const unicode = {text: '中'.repeat(Math.floor((NAPCAT_EVENT_MAX_BYTES - overhead) / 3) + 1)};
  assert.ok(Buffer.byteLength(JSON.stringify(unicode)) > NAPCAT_EVENT_MAX_BYTES);
  assert.equal(db.enqueueNapcatEvent(bot.id, unicode, 'unicode-over'), null);
  assert.equal(db.getNapcatQueueStats(bot.id).dropped, 2);
  assert.equal(db.pendingNapcatEventCount(bot.id), 1);
  db.ackNapcatEvents(bot.id, accepted!);
  const normal = db.enqueueNapcatEvent(bot.id, {text: 'normal message'}, 'normal-message');
  assert.deepEqual(db.pendingNapcatEvents(bot.id), [{seq: normal, event: {text: 'normal message'}}]);
});

test('outbound ledger is idempotent, isolates instances, and recovers started requests without retries', t => {
  const {db, path, keyPath} = database(t); const bot = create(db); const other = create(db, 'Other', '10002');
  const hash = 'a'.repeat(64);
  assert.equal(db.beginNapcatDelivery(bot.id, 'delivery-one', hash).created, true);
  assert.equal(db.beginNapcatDelivery(bot.id, 'delivery-one', hash).created, false);
  assert.throws(() => db.beginNapcatDelivery(bot.id, 'delivery-one', 'b'.repeat(64)), /不同内容/u);
  db.beginNapcatDelivery(other.id, 'delivery-one', hash);
  db.finishNapcatDelivery(bot.id, 'delivery-one', 'acknowledged', {message_id: 42});
  db.finishNapcatDelivery(bot.id, 'delivery-one', 'failed');
  assert.equal(db.getNapcatDelivery(bot.id, 'delivery-one')!.state, 'acknowledged');
  assert.equal(db.pendingNapcatDeliveryCount(other.id), 1);
  const reopened = new ConsoleDatabase(path, keyPath); t.after(() => reopened.close());
  assert.equal(reopened.getNapcatDelivery(other.id, 'delivery-one')!.state, 'started');
  assert.equal(reopened.recoverNapcatDeliveries(), 1);
  assert.equal(reopened.getNapcatDelivery(other.id, 'delivery-one')!.state, 'unconfirmed');
  assert.equal(reopened.beginNapcatDelivery(other.id, 'delivery-one', hash).created, false);
  assert.equal(reopened.pendingNapcatDeliveryCount(other.id), 0);
  assert.deepEqual(reopened.getNapcatDelivery(bot.id, 'delivery-one')!.result, {message_id: 42});
});

test('partial updates preserve credentials; explicit null clears only the selected secret', () => {
  const existing = validateSettings({ napcatToken: 'credential-napcat', modelApiKey: 'credential-model' });
  assert.equal(validateSettings({ persona: 'new persona' }, existing).napcatToken, 'credential-napcat');
  assert.equal(validateSettings({ napcatToken: undefined }, existing).napcatToken, 'credential-napcat');
  const cleared = validateSettings({ napcatToken: null }, existing);
  assert.equal(cleared.napcatToken, undefined); assert.equal(cleared.modelApiKey, 'credential-model');
  assert.throws(() => validateSettings({ modelApiKey: 4 }, existing), /密钥/u);
  assert.throws(() => validateSettings({ contextWindow: -1 }), /contextWindow/u);
  assert.equal(validateSettings({ contextWindow: null }, existing).contextWindow, 200000);
});

test('settings map percentages, seconds and MiB to existing worker env, and import roundtrips', () => {
  const settings = validateSettings({
    wsUrl: 'ws://host.docker.internal:3002', napcatToken: 'credential-napcat', modelApi: 'openai-completions',
    model: 'provider/model', baseUrl: 'https://model.example/v1', modelApiKey: 'credential-model', reasoning: 'low',
    contextWindow: 256000, compactLimit: 200000, replyProbability: 15, batchSize: 25, modelTimeout: 120,
    retrySeconds: 2.5, imageMaxMiB: 2, imageTimeout: 10, persona: 'persona',
    searchProvider: 'tavily', tavilyApiKey: 'credential-search', searchTimeout: 15,
    ttsProvider: 'mimo', mimoApiKey: 'credential-voice', ttsVoice: '冰糖', ttsStyle: '轻快', voiceEnabled: true, voiceProbability: 100,
  });
  const env = settingsToEnv(settings, { type: 'private', id: '10001' });
  assert.equal(env.RANDOM_REPLY_PROBABILITY, '0.15'); assert.equal(env.VOICE_REPLY_PROBABILITY, '1');
  assert.equal(env.RETRY_MS, '2500'); assert.equal(env.IMAGE_MAX_BYTES, String(2 * 1024 * 1024));
  assert.equal(env.AGENT_HOME, '/data/pi'); assert.equal(env.WEB_SEARCH_TIMEOUT_MS, '15000');
  assert.equal(env.MIMO_TTS_STYLE, '轻快'); assert.equal(env.TARGET_TYPE, 'private');
  assert.equal(loadConfig(env).target.id, '10001');
  assert.deepEqual(settingsFromEnv(env, settings.persona), settings);
  const edge = validateSettings({ ttsProvider: 'edge-tts', edgeRate: '+10%', voiceEnabled: true });
  assert.equal(settingsFromEnv(settingsToEnv(edge, { type: 'group', id: '1' })).edgeRate, '+10%');
  const inactive = settingsToEnv({ ...settings, baseUrl: '', modelApiKey: undefined, searchProvider: 'none', ttsProvider: 'none', voiceEnabled: false }, { type: 'group', id: '1' });
  assert.equal(inactive.AGENT_API_KEY, undefined); assert.equal(inactive.AGENT_BASE_URL, undefined);
  assert.equal(inactive.TAVILY_API_KEY, undefined); assert.equal(inactive.MIMO_TTS_API_KEY, undefined);
});

test('database encrypts configuration and worker token at rest, keeps key private, and returns public masks', t => {
  const { db, path, keyPath } = database(t);
  const bot = db.createBot({ name: 'private credentials', targetType: 'group', targetId: '10001', config: { ...defaultSettings(), napcatToken: 'credential-napcat-123', modelApiKey: 'credential-model-123' } });
  assert.equal(statSync(keyPath).mode & 0o777, 0o600); assert.equal(statSync(path).mode & 0o777, 0o600);
  const inspector = new DatabaseSync(path); t.after(() => inspector.close());
  const encrypted = JSON.stringify(inspector.prepare('SELECT * FROM bots').all()) + JSON.stringify(inspector.prepare('SELECT * FROM config_revisions').all());
  for (const secret of ['credential-napcat-123', 'credential-model-123', bot.workerToken]) assert.equal(encrypted.includes(secret), false);
  const publicBot = db.getPublicBot(bot.id)!;
  assert.equal('workerToken' in publicBot, false); assert.equal('napcatToken' in publicBot.config, false);
  assert.equal(publicBot.configuredSecrets.napcatToken, true); assert.equal(publicBot.configuredSecrets.tavilyApiKey, false);
  assert.equal(db.verifyWorkerToken(bot.id, bot.workerToken), true); assert.equal(db.verifyWorkerToken(bot.id, 'wrong'), false);
  assert.equal(db.verifyWorkerToken('missing', bot.workerToken), false);
  const snapshot = db.getWorkerSnapshot(bot.id);
  assert.equal(snapshot.env.NAPCAT_TOKEN, ''); assert.equal(snapshot.env.NAPCAT_WS_URL, 'ws://console.invalid/');
  assert.equal(snapshot.connectionId, bot.connectionId); assert.equal(snapshot.transport, 'console');
  assert.equal('wsUrl' in publicBot.config, false); assert.equal('actionTimeout' in publicBot.config, false);
  assert.equal('reconnectSeconds' in publicBot.config, false);
  const second = new ConsoleDatabase(path, keyPath); t.after(() => second.close());
  assert.equal(second.getBot(bot.id)!.workerToken, bot.workerToken);
  const wrongKey = join(dirname(keyPath), 'wrong.key'); writeFileSync(wrongKey, Buffer.alloc(32, 1));
  assert.throws(() => new ConsoleDatabase(path, wrongKey), /解密失败/u);
  assert.equal(db.getBot('missing'), null); assert.equal(db.getPublicBot('missing'), null);
});

test('configuration revisions are optimistic, names do not restart worker, and target is immutable', t => {
  const { db } = database(t); const bot = db.createBot({name: 'test', targetType: 'group', targetId: '10001', config: {napcatToken: 'keep-this-secret'}});
  assert.equal(bot.desiredRevision, 1); assert.equal(bot.appliedRevision, 0); assert.equal(bot.desiredState, 'stopped');
  assert.equal(db.updateBot(bot.id, { name: 'renamed', expectedRevision: 1 }).desiredRevision, 1);
  const updated = db.updateBot(bot.id, { config: { replyProbability: 100 }, expectedRevision: 1 });
  assert.equal(updated.desiredRevision, 2); assert.equal(db.getWorkerSnapshot(bot.id).revision, 2);
  assert.throws(() => db.updateBot(bot.id, { config: { replyProbability: 10 }, expectedRevision: 1 }), /配置版本冲突/u);
  assert.equal(db.getBot(bot.id)!.desiredRevision, 2);
  assert.throws(() => db.updateBot(bot.id, { targetId: '20002' }), /不能修改/u);
  assert.throws(() => db.updateBot(bot.id, { targetType: 'private' }), /不能修改/u);
  assert.equal(db.updateBot(bot.id, { targetId: bot.targetId, config: { persona: 'new' } }).config.napcatToken, 'keep-this-secret');
  db.markApplied(bot.id, 2); assert.equal(db.getBot(bot.id)!.appliedRevision, 2);
  assert.throws(() => db.markApplied(bot.id, 999), /生效配置版本无效/u);
  assert.throws(() => db.createBot({ name: 'invalid', targetType: 'group', targetId: '0', config: {} }), /目标号码/u);
});

test('only one active worker per NapCat endpoint and immutable target is allowed', t => {
  const { db } = database(t); const one = create(db, 'one'); const two = create(db, 'two');
  db.setDesiredState(one.id, 'running');
  assert.throws(() => db.setDesiredState(two.id, 'running'), /已有运行中的实例/u);
  db.setDesiredState(one.id, 'stopped'); db.setDesiredState(two.id, 'running');
  const differentTarget = create(db, 'third', '10002'); db.setDesiredState(differentTarget.id, 'running');
  const differentConnection = db.createBot({ name: 'different endpoint', targetType: 'group', targetId: two.targetId, config: { wsUrl: 'ws://another-napcat.example:3002' } });
  db.setDesiredState(differentConnection.id, 'running');
  assert.throws(() => db.updateBot(differentConnection.id, { config: { wsUrl: two.config.wsUrl } }), /必须完全停止/u);
  assert.equal(db.listPublicBots().length, 4);
});

test('a stopped desired state does not release target ownership while its worker is still draining', t => {
  const { db } = database(t); const one = create(db, 'one'); const two = create(db, 'two');
  db.setDesiredState(one.id, 'running'); db.setRuntime(one.id, { state: 'running' });
  db.setDesiredState(one.id, 'stopped'); db.setRuntime(one.id, { state: 'stopping' });
  assert.throws(() => db.setDesiredState(two.id, 'running'), /已有运行中的实例/u);
  const anotherEndpoint = db.createBot({ name: 'another endpoint', targetType: 'group', targetId: one.targetId, config: { wsUrl: 'ws://another.example:3002' } });
  db.setDesiredState(anotherEndpoint.id, 'running');
  assert.throws(() => db.updateBot(anotherEndpoint.id, { config: { wsUrl: one.config.wsUrl } }), /必须完全停止/u);
  db.setRuntime(one.id, { state: 'error' });
  assert.throws(() => db.setDesiredState(two.id, 'running'), /已有运行中的实例/u);
  db.setRuntime(one.id, { state: 'stopped' }); db.setDesiredState(two.id, 'running');
  assert.equal(db.getBot(two.id)!.desiredState, 'running');
});

test('heartbeat ingestion is atomic, idempotent, updates runtime and redacts secrets in nested tools', t => {
  const { db } = database(t); const bot = db.createBot({ name: 'bot', targetType: 'group', targetId: '10001', config: { napcatToken: 'private-napcat-secret', modelApiKey: 'private-model-secret' } });
  const events = [event(1, 'conversation.started'), event(2, 'session.established', { agentSessionId: 'thread-1' }), event(3, 'message.received', { messageId: 'qq-1', text: 'hello', senderName: 'Alice', time: Math.floor(Date.now() / 1000) }), event(4, 'tool.completed', { result: { apiKey: 'hidden-unrecognized-key', token: 'plain text', nested: { authorization: 'Bearer strange', value: 'private-model-secret' } }, command: 'echo private-napcat-secret' })];
  assert.equal(db.ingestHeartbeat(bot.id, heartbeat(events)), 4); assert.equal(db.ingestHeartbeat(bot.id, heartbeat(events)), 4);
  assert.equal(db.getPublicBot(bot.id)!.statistics.totalMessages, 1);
  assert.equal(db.getRuntime(bot.id).connected, true); assert.equal(db.getRuntime(bot.id).drained, true);
  assert.equal(db.getBot(bot.id)!.appliedRevision, 1);
  const conversation = db.getConversation(bot.id)!;
  assert.equal(conversation.agentSessionId, 'thread-1'); assert.equal(conversation.items.length, 4);
  const serialized = JSON.stringify(conversation);
  assert.equal(serialized.includes('hidden-unrecognized-key'), false); assert.equal(serialized.includes('private-model-secret'), false); assert.equal(serialized.includes('private-napcat-secret'), false);
  const invalid = event(6, 'tool.started'); invalid.seq = -1;
  assert.throws(() => db.ingestHeartbeat(bot.id, heartbeat([event(5, 'message.received', { messageId: 'qq-2' }), invalid])), /Worker 事件无效/u);
  assert.equal(db.getPublicBot(bot.id)!.statistics.totalMessages, 1);
  assert.equal(db.getConversation(bot.id)!.items.length, 4);
  db.setRuntime(bot.id, { state: 'stopping', error: 'failed private-model-secret' });
  assert.equal(db.getRuntime(bot.id).error, 'failed [REDACTED]');
  db.ingestHeartbeat(bot.id, heartbeat([], { processing: true, drained: false }));
  assert.equal(db.getRuntime(bot.id).state, 'stopping'); assert.equal(db.getRuntime(bot.id).processing, true);
});

test('counters use Shanghai calendar dates, exclude controls, and deduplicate incoming IDs and delivery IDs', t => {
  const now = Date.parse('2026-10-24T00:30:00+08:00'); t.mock.timers.enable({ apis: ['Date'], now });
  const { db } = database(t); const bot = create(db);
  const yesterday = Date.parse('2026-10-23T23:59:59+08:00'); const today = Date.parse('2026-10-24T00:00:00+08:00');
  db.ingestHeartbeat(bot.id, heartbeat([
    event(1, 'message.received', { messageId: 'yesterday', time: yesterday / 1000 }, yesterday),
    event(2, 'message.received', { messageId: 'today', time: today / 1000 }, today),
    event(3, 'message.received', { messageId: 'today', time: today / 1000 }, today),
    event(4, 'message.received', { messageId: 'command', command: 'help' }, now),
    event(5, 'delivery.acknowledged', { deliveryId: 'first', normal: true }, yesterday),
    event(6, 'delivery.acknowledged', { deliveryId: 'second', normal: true }, today),
    event(7, 'delivery.acknowledged', { deliveryId: 'second', normal: true }, today),
    event(8, 'delivery.acknowledged', { deliveryId: 'busy', normal: false }, now),
  ]));
  assert.deepEqual(db.getPublicBot(bot.id)!.statistics, { todayMessages: 1, totalMessages: 2, todayReplies: 1, totalReplies: 2, replyCountSince: now });
  db.importIncomingCounts(bot.id, [{ time: yesterday, count: 10 }]);
  db.importIncomingCounts(bot.id, [{ time: yesterday, count: 10 }]);
  assert.equal(db.getPublicBot(bot.id)!.statistics.totalMessages, 12);
});

test('conversation paging, per-run usage deduplication and unknown fields preserve accurate totals', t => {
  const { db } = database(t); const bot = create(db);
  db.ingestHeartbeat(bot.id, heartbeat([
    event(1, 'conversation.started'), event(2, 'message.received', { messageId: 'one' }),
    event(3, 'usage.recorded', { usageId: 'run-1', input_tokens: 100, cached_input_tokens: 90, output_tokens: 10 }),
    event(4, 'usage.recorded', { usageId: 'run-1', input_tokens: 100, cached_input_tokens: 90, output_tokens: 10 }),
    event(5, 'usage.recorded', { usageId: 'run-2', input_tokens: 200, cached_input_tokens: 180, output_tokens: 20 }),
    event(6, 'context.updated', { used: 300, window: 1000, compactLimit: 800 }),
  ]));
  const page1 = db.getConversation(bot.id, undefined, 2)!;
  assert.deepEqual(page1.items.map(item => item.seq), [5, 6]); assert.equal(page1.nextBefore, 5);
  assert.deepEqual(page1.usage, { input: 300, cached: 270, output: 30, total: 330 });
  assert.deepEqual(page1.context, { used: 300, window: 1000, compactLimit: 800 });
  assert.deepEqual(db.getConversation(bot.id, page1.nextBefore!, 2)!.items.map(item => item.seq), [3, 4]);
  assert.equal(db.getConversation(bot.id, 3, 2)!.nextBefore, null);
  db.ingestHeartbeat(bot.id, heartbeat([event(7, 'usage.recorded', { usageId: 'run-3', input_tokens: 10, cached_input_tokens: null, output_tokens: 1 })]));
  assert.deepEqual(db.getConversation(bot.id)!.usage, { input: 310, cached: null, output: 31, total: 341 });
});

test('new conversation moves only queued input projection without changing lifetime counters', t => {
  const { db } = database(t); const bot = create(db);
  db.ingestHeartbeat(bot.id, heartbeat([event(1, 'conversation.started'), event(2, 'message.received', { messageId: 'old' }), event(3, 'message.received', { messageId: 'queued' })]));
  db.ingestHeartbeat(bot.id, heartbeat([
    event(4, 'conversation.started', {}, Date.now(), 'conversation-2'),
    event(5, 'conversation.messages_moved', { messageIds: ['queued'] }, Date.now(), 'conversation-2'),
  ], { conversationId: 'conversation-2' }));
  const conversation = db.getConversation(bot.id)!;
  assert.equal(conversation.id, 'conversation-2'); assert.deepEqual(conversation.items.map(item => item.seq), [3, 4, 5]);
  assert.equal(db.getPublicBot(bot.id)!.statistics.totalMessages, 2); assert.equal(conversation.usage.total, null);
});

test('change cursor is persistent and contains no secrets; settings and latency use stable APIs', t => {
  const { db } = database(t); const before = db.getEventCursor(); const bot = create(db);
  db.setSetting('admin.password', 'hash:example'); assert.equal(db.getSetting('admin.password'), 'hash:example');
  db.setSetting('admin.password', undefined); assert.equal(db.getSetting('admin.password'), null);
  assert.equal(db.getLatencyP95(bot.id, 0), null);
  db.ingestHeartbeat(bot.id, heartbeat([
    ...Array.from({ length: 20 }, (_, index) => event(index + 1, 'batch.completed', { durationMs: (index + 1) * 1000 }, 1000 + index)),
    event(21, 'batch.completed', { durationMs: null }, 1030), event(22, 'batch.completed', { durationMs: -1 }, 1031),
  ]));
  assert.equal(db.getLatencyP95(bot.id, 0), 19); assert.equal(db.getLatencyP95(bot.id, 1025), null);
  const changes = db.listChanges(before);
  assert.ok(changes.length >= 3); assert.ok(changes.some(change => change.type === 'bot.created'));
  assert.equal(changes.at(-1)!.seq, db.getEventCursor()); assert.equal(db.listChanges(db.getEventCursor()).length, 0);
  assert.equal(JSON.stringify(changes).includes(bot.workerToken), false);
});


test('stored legacy model and sandbox settings normalize without widening permissions or changing secrets', () => {
  for (const [sandbox, commands, writes] of [['read-only', false, false], ['workspace-write', false, true], ['danger-full-access', true, true]] as const) {
    const config = normalizeSettings({ modelProvider: 'custom', sandbox, model: 'legacy-model', baseUrl: 'https://legacy.example/v1',
      modelApiKey: 'preserved-secret', contextWindow: 200000, compactLimit: 160000 });
    assert.equal(config.modelApi, 'openai-responses'); assert.equal(config.allowCommands, commands); assert.equal(config.allowFileWrites, writes);
    assert.equal(config.modelApiKey, 'preserved-secret'); assert.equal(config.maxOutputTokens, 8192);
    assert.equal('sandbox' in config, false); assert.equal('modelProvider' in config, false);
  }
  const native = normalizeSettings({ modelProvider: 'native', sandbox: 'workspace-write', model: 'old-default' });
  assert.equal(native.baseUrl, ''); assert.equal(native.model, 'old-default');
  assert.equal(normalizeSettings({ sandbox: 'danger-full-access', allowCommands: false }).allowCommands, false);
});

test('new model capabilities and context budgets validate independently of provider credentials', () => {
  const settings = validateSettings({ model: 'custom/model', baseUrl: 'http://local.example/v1', modelApi: 'openai-completions',
    supportsImages: false, supportsReasoning: false, reasoning: 'high', allowCommands: true, allowFileWrites: false, maxOutputTokens: 10000 });
  const env = settingsToEnv(settings, { type: 'group', id: '1' });
  assert.equal(env.AGENT_API, 'openai-completions'); assert.equal(env.AGENT_REASONING, undefined);
  assert.equal(env.AGENT_SUPPORTS_IMAGES, 'false'); assert.equal(env.AGENT_ALLOW_COMMANDS, 'true'); assert.equal(env.AGENT_ALLOW_FILE_WRITES, 'false');
  assert.throws(() => validateSettings({ compactLimit: 200000 }), /compactLimit/u);
  assert.throws(() => validateSettings({ maxOutputTokens: 40001 }), /maxOutputTokens/u);
  assert.throws(() => validateSettings({ supportsImages: 'true' }), /类型/u);
});


test('legacy database reads Pi defaults without revising configuration or importing Codex sessions', t => {
  const directory = mkdtempSync(join(tmpdir(), 'napcat-console-legacy-schema-'));
  const path = join(directory, 'console.sqlite3'); const keyPath = join(directory, 'master.key');
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE conversations (bot_id TEXT NOT NULL, id TEXT NOT NULL, codex_session_id TEXT, started_at INTEGER NOT NULL, PRIMARY KEY(bot_id,id))`);
  legacy.close();
  const first = new ConsoleDatabase(path, keyPath);
  const bot = create(first);
  first.close();
  const inspector = new DatabaseSync(path);
  const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', readFileSync(keyPath), nonce);
  const oldConfig = { ...defaultSettings(), modelProvider: 'custom', sandbox: 'workspace-write', model: 'legacy/model', baseUrl: 'https://model.example/v1', modelApiKey: 'preserved-secret' } as Record<string, unknown>;
  for (const key of ['modelApi', 'maxOutputTokens', 'supportsImages', 'supportsReasoning', 'allowCommands', 'allowFileWrites']) delete oldConfig[key];
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(oldConfig), 'utf8'), cipher.final()]);
  inspector.prepare('UPDATE config_revisions SET config_cipher=? WHERE bot_id=?').run(Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64'), bot.id);
  inspector.prepare('INSERT INTO conversations (bot_id,id,codex_session_id,started_at) VALUES (?,?,?,?)').run(bot.id, 'old-chat', 'old-codex-session', 1);
  inspector.prepare('UPDATE runtime SET conversation_id=? WHERE bot_id=?').run('old-chat', bot.id);
  const before = inspector.prepare('SELECT revision,config_cipher FROM config_revisions WHERE bot_id=?').all(bot.id);
  inspector.close();
  const db = new ConsoleDatabase(path, keyPath);
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  const current = db.getBot(bot.id)!;
  assert.equal(current.desiredRevision, 1); assert.equal(current.config.modelApiKey, 'preserved-secret');
  assert.equal(current.config.allowCommands, false); assert.equal(current.config.allowFileWrites, true);
  assert.equal(db.getConversation(bot.id)!.agentSessionId, null);
  assert.equal(db.getWorkerSnapshot(bot.id).env.AGENT_MODEL, 'legacy/model');
  const check = new DatabaseSync(path); t.after(() => check.close());
  assert.deepEqual(check.prepare('SELECT revision,config_cipher FROM config_revisions WHERE bot_id=?').all(bot.id), before);
  db.ingestHeartbeat(bot.id, heartbeat([event(1, 'conversation.started', {}, Date.now(), 'pi-chat'), event(2, 'session.established', { agentSessionId: '/data/pi/sessions/new.jsonl' }, Date.now(), 'pi-chat')], { conversationId: 'pi-chat' }));
  assert.equal(db.getConversation(bot.id)!.agentSessionId, '/data/pi/sessions/new.jsonl');
});


test('Pi usage accumulates multiple model calls within one run and remains idempotent after restart', t => {
  const { db, path, keyPath } = database(t); const bot = create(db);
  const events = [event(1, 'conversation.started'),
    { ...event(2, 'usage.recorded', { usageId: 'pi-one:1', input_tokens: 100, cached_input_tokens: 90, output_tokens: 10 }), runId: 'same-run' },
    { ...event(3, 'usage.recorded', { usageId: 'pi-one:2', input_tokens: 200, cached_input_tokens: 180, output_tokens: 20 }), runId: 'same-run' },
    { ...event(4, 'usage.recorded', { usageId: 'pi-one:2', input_tokens: 200, cached_input_tokens: 180, output_tokens: 20 }), runId: 'same-run' },
    { ...event(5, 'usage.recorded', { usageId: 'pi-one:3', input_tokens: 50, cached_input_tokens: 0, output_tokens: 5 }), runId: 'same-run' },
    event(6, 'context.updated', { used: 8000, window: 200000, compactLimit: 160000, estimated: true }),
  ];
  db.ingestHeartbeat(bot.id, heartbeat(events)); db.ingestHeartbeat(bot.id, heartbeat(events));
  assert.deepEqual(db.getConversation(bot.id)!.usage, { input: 350, cached: 270, output: 35, total: 385 });
  assert.deepEqual(db.getConversation(bot.id)!.context, { used: 8000, window: 200000, compactLimit: 160000, estimated: true });
  const reopened = new ConsoleDatabase(path, keyPath); t.after(() => reopened.close());
  assert.deepEqual(reopened.getConversation(bot.id)!.usage, { input: 350, cached: 270, output: 35, total: 385 });
  assert.equal(reopened.getConversation(bot.id)!.items.filter(item => item.type === 'usage.recorded').length, 4);
});

test('standalone Agent persona imports from env unless explicitly overridden', () => {
  const env = { TARGET_TYPE: 'group', TARGET_ID: '1', NAPCAT_WS_URL: 'ws://localhost:3002', AGENT_PERSONA: 'Env persona' };
  assert.equal(settingsFromEnv(env).persona, 'Env persona');
  assert.equal(settingsFromEnv(env, '').persona, '');
  assert.equal(settingsFromEnv(env, 'Explicit persona').persona, 'Explicit persona');
});

test('conversation pages include complete thinking from earlier model calls without skipping older history', t => {
  const { db } = database(t); const bot = create(db);
  const events = [event(1, 'conversation.started'), event(2, 'message.received', {messageId:'question'})];
  const thought = (seq:number,itemId:string,text:string):ConsoleEvent => ({...event(seq,'thinking.updated',{text,status:'completed'}),runId:'one-run',itemId});
  events.push(thought(3,'first-call','first model call'));
  for(let seq=4;seq<=110;seq++) events.push({...event(seq,'tool.completed',{tool:'read'}),runId:'one-run',itemId:`tool-${seq}`});
  events.push(thought(111,'second-call','second model call'),{...event(112,'run.completed'),runId:'one-run'});
  db.ingestEvents(bot.id,events);
  const page=db.getConversation(bot.id)!;
  assert.deepEqual(page.items.filter(item=>item.type==='thinking.updated').map(item=>item.payload.text),['first model call','second model call']);
  assert.equal(page.nextBefore,13,'The older-page cursor must not jump back to the supplemental thought');
  assert.equal(page.cursor,112);
  const older=db.getConversation(bot.id,page.nextBefore!)!;
  const merged=new Set([...older.items,...page.items].map(item=>item.seq));
  assert.ok([...Array(112)].every((_,index)=>merged.has(index+1)));
});
