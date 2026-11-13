import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { ConsoleDatabase } from '../src/console/database.js';
import { defaultSettings, normalizeSettings, settingsFromEnv, settingsToEnv, validateSettings } from '../src/console/settings.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logging.js';

test('DeepSeek settings roundtrip through Worker configuration with independent credentials', () => {
  const settings = validateSettings({ napcatToken: '', searchProvider: 'deepseek', deepseekSearchApiKey: 'synthetic-search-secret',
    deepseekSearchBaseUrl: 'https://API.example.com:443/gateway///', searchResults: 12, searchTimeout: 15 });
  const env = settingsToEnv(settings, { type: 'private', id: '10001' });
  assert.equal(env.DEEPSEEK_SEARCH_API_KEY, 'synthetic-search-secret');
  assert.equal(env.DEEPSEEK_SEARCH_BASE_URL, 'https://api.example.com/gateway');
  assert.equal(env.DEEPSEEK_SEARCH_MAX_RESULTS, '12'); assert.equal(env.WEB_SEARCH_TIMEOUT_MS, '15000');
  assert.equal(env.TAVILY_API_KEY, undefined); assert.equal(env.AGENT_API_KEY, undefined);
  assert.deepEqual(loadConfig(env).webSearch, { provider: 'deepseek', apiKey: 'synthetic-search-secret', baseUrl: 'https://api.example.com/gateway', maxResults: 12, timeoutMs: 15000 });
  assert.deepEqual(settingsFromEnv(env), settings);
  const disabled = settingsToEnv({ ...settings, searchProvider: 'none' }, { type: 'group', id: '10001' });
  assert.equal(disabled.DEEPSEEK_SEARCH_API_KEY, undefined); assert.equal(disabled.DEEPSEEK_SEARCH_BASE_URL, undefined);
});

test('legacy settings receive defaults and provider switches preserve each service configuration', () => {
  const { deepseekSearchBaseUrl: _removed, ...legacy } = defaultSettings();
  assert.equal(normalizeSettings(legacy).deepseekSearchBaseUrl, 'https://api.deepseek.com');
  assert.equal(normalizeSettings(legacy).searchProvider, 'none');
  const tavily = validateSettings({ searchProvider: 'tavily', tavilyApiKey: 'synthetic-tavily-secret', searchBaseUrl: 'https://tavily.example.com/proxy' });
  const deepseek = validateSettings({ searchProvider: 'deepseek', deepseekSearchApiKey: 'synthetic-deepseek-secret' }, tavily);
  assert.equal(deepseek.deepseekSearchBaseUrl, 'https://api.deepseek.com'); assert.equal(deepseek.searchBaseUrl, tavily.searchBaseUrl);
  assert.equal(deepseek.tavilyApiKey, tavily.tavilyApiKey);
  const reverted = validateSettings({ searchProvider: 'tavily' }, deepseek);
  assert.equal(reverted.searchBaseUrl, tavily.searchBaseUrl); assert.equal(reverted.deepseekSearchApiKey, deepseek.deepseekSearchApiKey);
  assert.equal(settingsToEnv(deepseek, { type: 'group', id: '10001' }).TAVILY_API_KEY, undefined);
  assert.equal(settingsToEnv(reverted, { type: 'group', id: '10001' }).DEEPSEEK_SEARCH_API_KEY, undefined);
  assert.throws(() => validateSettings({ searchProvider: 'deepseek', modelApiKey: 'synthetic-model-secret' }), /DEEPSEEK_SEARCH_API_KEY/u);
  assert.throws(() => validateSettings({ searchProvider: 'deepseek', deepseekSearchApiKey: 'key', deepseekSearchBaseUrl: 'invalid' }), /DEEPSEEK_SEARCH_BASE_URL/u);
  assert.throws(() => validateSettings({ searchResults: 21 }, deepseek), /DEEPSEEK_SEARCH_MAX_RESULTS/u);
  assert.throws(() => validateSettings({ searchTimeout: 301 }, deepseek), /WEB_SEARCH_TIMEOUT_MS/u);
  assert.equal(validateSettings({ deepseekSearchBaseUrl: 'invalid inactive URL' }).deepseekSearchBaseUrl, 'invalid inactive URL');
});

test('Console encrypts and masks the DeepSeek key, and projects it only to the active Worker revision', t => {
  const directory = mkdtempSync(join(tmpdir(), 'deepseek-settings-'));
  const path = join(directory, 'console.sqlite3');
  const db = new ConsoleDatabase(path, join(directory, 'master.key'));
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  const bot = db.createBot({ name: 'Search example', targetType: 'group', targetId: '10001', config: {
    searchProvider: 'deepseek', deepseekSearchApiKey: 'synthetic-search-key-private',
  } });
  const reader = new DatabaseSync(path, { readOnly: true }); t.after(() => reader.close());
  const stored = JSON.stringify(reader.prepare('SELECT * FROM config_revisions').all());
  assert.doesNotMatch(stored, /synthetic-search-key-private/);
  const publicBot = db.getPublicBot(bot.id)!;
  assert.equal(publicBot.configuredSecrets.deepseekSearchApiKey, true);
  assert.equal('deepseekSearchApiKey' in publicBot.config, false);
  assert.doesNotMatch(JSON.stringify(publicBot), /synthetic-search-key-private/);
  const snapshot = db.getWorkerSnapshot(bot.id);
  assert.equal(snapshot.revision, bot.desiredRevision); assert.equal(snapshot.env.DEEPSEEK_SEARCH_API_KEY, 'synthetic-search-key-private');
  const updated = db.updateBot(bot.id, { config: { searchProvider: 'none' }, expectedRevision: bot.desiredRevision });
  assert.equal(updated.desiredRevision, bot.desiredRevision + 1);
  assert.equal(db.getWorkerSnapshot(bot.id).env.DEEPSEEK_SEARCH_API_KEY, undefined);
  assert.equal(db.getPublicBot(bot.id)!.configuredSecrets.deepseekSearchApiKey, true);
  db.updateBot(bot.id, { config: { deepseekSearchApiKey: null } as never, expectedRevision: updated.desiredRevision });
  assert.equal(db.getPublicBot(bot.id)!.configuredSecrets.deepseekSearchApiKey, false);
});

test('default logger redacts the independent DeepSeek search credential', () => {
  const previous = process.env.DEEPSEEK_SEARCH_API_KEY;
  const lines: string[] = [];
  try {
    process.env.DEEPSEEK_SEARCH_API_KEY = 'synthetic-deepseek-logging-key';
    createLogger({ write: (_level, line) => lines.push(line) }).warn('credential=synthetic-deepseek-logging-key');
    assert.match(lines[0]!, /credential=\[redacted\]/u); assert.doesNotMatch(lines[0]!, /synthetic-deepseek-logging-key/u);
  } finally {
    if (previous === undefined) delete process.env.DEEPSEEK_SEARCH_API_KEY;
    else process.env.DEEPSEEK_SEARCH_API_KEY = previous;
  }
});
