import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, randomBytes } from 'node:crypto';
import { ConsoleDatabase } from '../src/console/database.js';
import { defaultSettings, normalizeSettings, settingsFromEnv, settingsToEnv, validateSettings } from '../src/console/settings.js';
import type { BotRecord, ConsoleEvent, WorkerHeartbeat } from '../src/console/contracts.js';
import { loadConfig } from '../src/config.js';

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
  assert.equal(db.getWorkerSnapshot(bot.id).env.NAPCAT_TOKEN, 'credential-napcat-123');
  const second = new ConsoleDatabase(path, keyPath); t.after(() => second.close());
  assert.equal(second.getBot(bot.id)!.workerToken, bot.workerToken);
  const wrongKey = join(dirname(keyPath), 'wrong.key'); writeFileSync(wrongKey, Buffer.alloc(32, 1));
  assert.throws(() => new ConsoleDatabase(path, wrongKey), /解密失败/u);
  assert.equal(db.getBot('missing'), null); assert.equal(db.getPublicBot('missing'), null);
});

test('configuration revisions are optimistic, names do not restart worker, and target is immutable', t => {
  const { db } = database(t); const bot = create(db);
  assert.equal(bot.desiredRevision, 1); assert.equal(bot.appliedRevision, 0); assert.equal(bot.desiredState, 'stopped');
  assert.equal(db.updateBot(bot.id, { name: 'renamed', expectedRevision: 1 }).desiredRevision, 1);
  const updated = db.updateBot(bot.id, { config: { replyProbability: 100, napcatToken: 'keep-this-secret' }, expectedRevision: 1 });
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
  assert.throws(() => db.updateBot(differentConnection.id, { config: { wsUrl: two.config.wsUrl } }), /已有运行中的实例/u);
  assert.equal(db.listPublicBots().length, 4);
});

test('a stopped desired state does not release target ownership while its worker is still draining', t => {
  const { db } = database(t); const one = create(db, 'one'); const two = create(db, 'two');
  db.setDesiredState(one.id, 'running'); db.setRuntime(one.id, { state: 'running' });
  db.setDesiredState(one.id, 'stopped'); db.setRuntime(one.id, { state: 'stopping' });
  assert.throws(() => db.setDesiredState(two.id, 'running'), /已有运行中的实例/u);
  const anotherEndpoint = db.createBot({ name: 'another endpoint', targetType: 'group', targetId: one.targetId, config: { wsUrl: 'ws://another.example:3002' } });
  db.setDesiredState(anotherEndpoint.id, 'running');
  assert.throws(() => db.updateBot(anotherEndpoint.id, { config: { wsUrl: one.config.wsUrl } }), /已有运行中的实例/u);
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
  assert.ok(changes.length >= 3); assert.equal(changes[0]!.type, 'bot.created');
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
