import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.js';
import { ConsoleDatabase } from '../src/console/database.js';
import { defaultSettings, normalizeSettings, settingsFromEnv, settingsToEnv, validateSettings } from '../src/console/settings.js';
import { materializeSnapshot } from '../src/managed-worker.js';

test('task creator restriction defaults on for legacy settings and validates explicit boolean changes', () => {
  assert.equal(defaultSettings().taskCreatorOnly, true);
  assert.equal(normalizeSettings({ model: 'example-model' }).taskCreatorOnly, true);
  assert.equal(validateSettings({ taskCreatorOnly: false }).taskCreatorOnly, false);
  assert.equal(validateSettings({}, validateSettings({ taskCreatorOnly: false })).taskCreatorOnly, false);
  for (const value of ['false', 0, null]) {
    assert.throws(() => validateSettings({ taskCreatorOnly: value }), /taskCreatorOnly.*类型/);
  }
  const env = settingsToEnv(defaultSettings(), { type: 'group', id: '10001' });
  delete env.TASK_CREATOR_ONLY;
  assert.equal(loadConfig(env).taskCreatorOnly, true);
  assert.throws(() => loadConfig({ ...env, TASK_CREATOR_ONLY: 'no' }), /TASK_CREATOR_ONLY/);
});

test('task creator policy survives snapshot serialization, runtime loading and explicit imports', () => {
  for (const taskCreatorOnly of [true, false]) {
    const env = settingsToEnv(validateSettings({ taskCreatorOnly }), { type: 'private', id: '10001' });
    assert.equal(env.TASK_CREATOR_ONLY, String(taskCreatorOnly));
    assert.equal(loadConfig(env).taskCreatorOnly, taskCreatorOnly);
    assert.equal(settingsFromEnv(env).taskCreatorOnly, taskCreatorOnly);
  }
});

test('task creator policy persists per instance and reaches its managed runtime without changing task ownership', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nekodock-task-owner-'));
  const path = join(directory, 'console.sqlite3'), key = join(directory, 'master.key');
  let db = new ConsoleDatabase(path, key);
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  const bot = db.createBot({ name: 'Shared tasks', targetType: 'group', targetId: '10001', config: { taskCreatorOnly: false } });
  const other = db.createBot({ name: 'Creator tasks', targetType: 'group', targetId: '10002', config: {} });
  const task = db.tasks.create(bot.id, { name: 'Daily report', kind: 'model', instructions: 'Say good morning.', schedule: { kind: 'cron', expression: '0 8 * * *' } }, '1001');
  assert.equal(db.getPublicBot(bot.id)!.config.taskCreatorOnly, false);
  assert.equal(db.getPublicBot(other.id)!.config.taskCreatorOnly, true);
  const snapshot = db.getWorkerSnapshot(bot.id);
  const identity = { url: 'http://console.invalid', botId: bot.id, token: 'synthetic-control-token', dataDir: join(directory, 'worker') };
  const runtime = await materializeSnapshot(identity, snapshot, { TASK_CREATOR_ONLY: 'true' });
  assert.equal(runtime.taskCreatorOnly, false, 'the database snapshot takes precedence over ambient configuration');
  db.close(); db = new ConsoleDatabase(path, key);
  assert.equal(db.getBot(bot.id)!.config.taskCreatorOnly, false);
  assert.equal(db.getBot(bot.id)!.desiredRevision, 1);
  assert.equal(db.tasks.get(bot.id, task.id)!.creatorId, '1001');
  db.updateBot(bot.id, { expectedRevision: 1, config: { taskCreatorOnly: true } });
  assert.equal(db.getWorkerSnapshot(bot.id).env.TASK_CREATOR_ONLY, 'true');
  assert.equal(db.tasks.get(bot.id, task.id)!.creatorId, '1001');
});
