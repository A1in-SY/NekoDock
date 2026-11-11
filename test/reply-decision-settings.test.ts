import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../src/config.js';
import { ConsoleDatabase } from '../src/console/database.js';
import { defaultSettings, normalizeSettings, settingsFromEnv, settingsToEnv, validateSettings } from '../src/console/settings.js';

const base = { NAPCAT_WS_URL: 'ws://napcat.example', TARGET_TYPE: 'group', TARGET_ID: '10001' };
const active = { replyMode: 'jev', replyJudgeBaseUrl: 'https://JUDGE.example:443/gateway/v1///', replyJudgeModel: 'example-judge', replyJudgeApiKey: 'synthetic-judge-key' };

test('older settings remain random and retain their configured percentage', () => {
  const settings = normalizeSettings({ replyProbability: 23 });
  assert.equal(settings.replyMode, 'random');
  assert.equal(settings.replyProbability, 23);
  const runtime = loadConfig(base);
  assert.deepEqual(runtime.replyDecision, { mode: 'random', baseUrl: 'https://api.typesafe.ai/v1', model: 'jev-latest', apiKey: undefined, threshold: 0.7, timeoutMs: 3000, instructions: '' });
  assert.equal(runtime.randomReplyProbability, 0.05);
  assert.equal(validateSettings({ replyJudgeBaseUrl: 'inactive URL', replyJudgeModel: '' }).replyJudgeBaseUrl, 'inactive URL');
});

test('Jev settings round-trip independently from the main model and preserve a custom prefix', () => {
  const settings = validateSettings({ ...active, model: 'chat-model', baseUrl: 'https://chat.example/v1', modelApiKey: 'synthetic-chat-key',
    replyJudgeThreshold: 0.82, replyJudgeTimeout: 2.5, replyJudgeInstructions: 'Prefer natural follow-ups.', replyProbability: 17 });
  assert.equal(settings.replyJudgeBaseUrl, 'https://judge.example/gateway/v1');
  const env = settingsToEnv(settings, { type: 'group', id: '10001' });
  const runtime = loadConfig(env);
  assert.deepEqual(runtime.replyDecision, { mode: 'jev', baseUrl: 'https://judge.example/gateway/v1', model: 'example-judge', apiKey: active.replyJudgeApiKey,
    threshold: 0.82, timeoutMs: 2500, instructions: 'Prefer natural follow-ups.' });
  assert.equal(runtime.agentModel, 'chat-model');
  assert.equal(runtime.agentApiKey, 'synthetic-chat-key');
  assert.equal(runtime.randomReplyProbability, 0.17);
  const restored = settingsFromEnv(env);
  for (const key of ['replyMode', 'replyJudgeBaseUrl', 'replyJudgeModel', 'replyJudgeApiKey', 'replyJudgeThreshold', 'replyJudgeTimeout', 'replyJudgeInstructions', 'replyProbability'] as const)
    assert.equal(restored[key], settings[key]);
});

test('Jev active configuration validates URL, model, credential, threshold and timeout boundaries', () => {
  assert.throws(() => validateSettings({ replyMode: 'invalid' }), /replyMode/u);
  assert.throws(() => validateSettings({ replyMode: 'jev' }), /REPLY_JUDGE_API_KEY/u);
  for (const replyJudgeBaseUrl of ['', 'invalid', 'file:///tmp/model', 'https://user:pass@judge.example/v1', 'https://judge.example/v1?key=placeholder', 'https://judge.example/v1#fragment', 'https://judge.example/v1/systemone/'])
    assert.throws(() => validateSettings({ ...active, replyJudgeBaseUrl }), /REPLY_JUDGE_BASE_URL/u);
  for (const replyJudgeModel of ['', ' ', 'line\nbreak', 'x'.repeat(1025)])
    assert.throws(() => validateSettings({ ...active, replyJudgeModel }), /REPLY_JUDGE_MODEL/u);
  for (const replyJudgeApiKey of ['', ' ', 'line\nbreak', null])
    assert.throws(() => validateSettings({ ...active, replyJudgeApiKey }), /replyJudgeApiKey|REPLY_JUDGE_API_KEY/u);
  for (const replyJudgeThreshold of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY])
    assert.throws(() => validateSettings({ ...active, replyJudgeThreshold }), /replyJudgeThreshold/u);
  for (const replyJudgeTimeout of [0, -1, 60.001, 0.0001])
    assert.throws(() => validateSettings({ ...active, replyJudgeTimeout }), /replyJudgeTimeout/u);
  for (const replyJudgeThreshold of [0, 1]) assert.equal(validateSettings({ ...active, replyJudgeThreshold }).replyJudgeThreshold, replyJudgeThreshold);
  assert.equal(validateSettings({ ...active, replyJudgeTimeout: 0.001 }).replyJudgeTimeout, 0.001);
  assert.equal(validateSettings({ ...active, replyJudgeTimeout: 60 }).replyJudgeTimeout, 60);
  assert.throws(() => validateSettings({ ...active, replyJudgeInstructions: 'x'.repeat(16001) }), /replyJudgeInstructions/u);
});

test('standalone parser rejects invalid Jev values without including supplied secrets in errors', () => {
  const env = { ...base, REPLY_MODE: 'jev', REPLY_JUDGE_API_KEY: 'synthetic-private-key' };
  for (const patch of [{ REPLY_MODE: 'other' }, { REPLY_JUDGE_THRESHOLD: '' }, { REPLY_JUDGE_THRESHOLD: 'NaN' }, { REPLY_JUDGE_THRESHOLD: '1.1' },
    { REPLY_JUDGE_TIMEOUT_MS: '0' }, { REPLY_JUDGE_TIMEOUT_MS: '60001' }, { REPLY_JUDGE_MODEL: '' }, { REPLY_JUDGE_API_KEY: '' }, { REPLY_JUDGE_API_KEY: 'line\nbreak' },
    { REPLY_JUDGE_BASE_URL: 'https://synthetic-private-key@judge.example/v1' }, { REPLY_JUDGE_INSTRUCTIONS: 'x'.repeat(16001) }]) {
    assert.throws(() => loadConfig({ ...env, ...patch }), error => error instanceof Error && !error.message.includes('synthetic-private-key'));
  }
});

test('Jev credential is encrypted, masked publicly, preserved on ordinary edits and explicitly clearable', t => {
  const directory = mkdtempSync(join(tmpdir(), 'nekodock-judge-settings-'));
  const path = join(directory, 'console.sqlite3');
  const keyPath = join(directory, 'master.key');
  let db = new ConsoleDatabase(path, keyPath);
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  const bot = db.createBot({ name: 'Example', targetType: 'group', targetId: '10001', config: active });
  assert.equal(db.getPublicBot(bot.id)!.configuredSecrets.replyJudgeApiKey, true);
  assert.equal('replyJudgeApiKey' in db.getPublicBot(bot.id)!.config, false);
  assert.equal(db.getWorkerSnapshot(bot.id).env.REPLY_JUDGE_API_KEY, active.replyJudgeApiKey);
  const inspector = new DatabaseSync(path);
  assert.equal(JSON.stringify(inspector.prepare('SELECT * FROM config_revisions').all()).includes(active.replyJudgeApiKey), false);
  inspector.close();
  const edited = db.updateBot(bot.id, { config: { replyJudgeThreshold: 0.9 }, expectedRevision: 1 });
  assert.equal(edited.config.replyJudgeApiKey, active.replyJudgeApiKey);
  db.close(); db = new ConsoleDatabase(path, keyPath);
  assert.equal(db.getBot(bot.id)!.config.replyJudgeApiKey, active.replyJudgeApiKey);
  assert.throws(() => db.updateBot(bot.id, { config: { replyJudgeApiKey: null } }), /REPLY_JUDGE_API_KEY/u);
  db.updateBot(bot.id, { config: { replyMode: 'random', replyJudgeApiKey: null } });
  assert.equal(db.getPublicBot(bot.id)!.configuredSecrets.replyJudgeApiKey, false);
  assert.equal(db.getBot(bot.id)!.config.replyJudgeApiKey, undefined);
  assert.equal(defaultSettings().replyMode, 'random');
});
