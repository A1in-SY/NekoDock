import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { ConsoleDatabase } from '../src/console/database.js';
import { defaultSettings, normalizeSettings, settingsFromEnv, settingsToEnv, validateSettings } from '../src/console/settings.js';
import { loadConfig } from '../src/config.js';
import { DEFAULT_NO_PROXY } from '../src/network.js';

const proxy = {
  proxyEnabled: true, proxyUrl: 'http://proxy.example:7890', proxyUsername: 'synthetic-proxy-account',
  proxyPassword: 'synthetic-proxy-password', proxyNoProxy: 'localhost\n.model.example\n192.0.2.1:8080', proxyForTools: false,
};

test('old instance settings normalize to disabled proxy without changing their tool permissions', () => {
  const old = normalizeSettings({model: 'synthetic-model', allowCommands: false});
  assert.equal(old.proxyEnabled, false); assert.equal(old.proxyUrl, '');
  assert.equal(old.proxyNoProxy, DEFAULT_NO_PROXY); assert.equal(old.proxyForTools, true);
  assert.equal(old.allowCommands, false); assert.equal(old.proxyUsername, undefined); assert.equal(old.proxyPassword, undefined);
});

test('proxy settings round-trip through managed snapshots and explicit imports', () => {
  const config = validateSettings(proxy);
  const env = settingsToEnv(config, {type: 'private', id: '10001'});
  assert.equal(env.NETWORK_PROXY_ENABLED, 'true'); assert.equal(env.NETWORK_PROXY_FOR_TOOLS, 'false');
  assert.equal(env.NETWORK_PROXY_USERNAME, proxy.proxyUsername); assert.equal(env.NETWORK_PROXY_PASSWORD, proxy.proxyPassword);
  const loaded = loadConfig(env);
  assert.equal(loaded.networkProxy.enabled, true); assert.equal(loaded.networkProxy.url, config.proxyUrl);
  assert.equal(loaded.networkProxy.noProxy, config.proxyNoProxy); assert.equal(loaded.networkProxy.forTools, false);
  assert.equal(loaded.networkProxy.username, proxy.proxyUsername); assert.equal(loaded.networkProxy.password, proxy.proxyPassword);
  const imported = settingsFromEnv(env);
  assert.equal(imported.proxyUrl, config.proxyUrl); assert.equal(imported.proxyNoProxy, config.proxyNoProxy);
  assert.equal(imported.proxyPassword, config.proxyPassword); assert.equal(imported.proxyUsername, config.proxyUsername);
});

test('proxy validation rejects unsupported protocols, embedded credentials and malformed input without echoing secrets', () => {
  const secret = 'synthetic-private-credential';
  for (const proxyUrl of ['socks5://proxy.example:1080', 'file:///tmp/proxy', `http://user:${secret}@proxy.example:7890`, `http://proxy.example:7890/?key=${secret}`, 'http://proxy.example:7890/path']) {
    assert.throws(() => validateSettings({...proxy, proxyUrl}), error => error instanceof Error && !error.message.includes(secret));
  }
  assert.throws(() => validateSettings({...proxy, proxyUrl: ''}));
  assert.throws(() => validateSettings({...proxy, proxyEnabled: 'true'}));
  assert.throws(() => validateSettings({...proxy, proxyForTools: 'false'}));
  assert.throws(() => validateSettings({...proxy, proxyPassword: 'line\nbreak'}));
  assert.throws(() => loadConfig({...settingsToEnv(defaultSettings(), {type: 'group', id: '10001'}), NETWORK_PROXY_ENABLED: 'yes'}));
});

test('proxy credentials are encrypted, omitted from API views, retained on patch and cleared explicitly', t => {
  const directory = mkdtempSync(join(tmpdir(), 'nekodock-proxy-settings-'));
  const path = join(directory, 'console.sqlite3');
  const db = new ConsoleDatabase(path, join(directory, 'master.key'));
  const inspector = new DatabaseSync(path);
  t.after(() => {inspector.close(); db.close(); rmSync(directory, {recursive: true, force: true});});
  const first = db.createBot({name: 'Proxy example', targetType: 'group', targetId: '10001', config: proxy});
  const second = db.createBot({name: 'Direct example', targetType: 'private', targetId: '10002', config: {}});
  const visible = db.getPublicBot(first.id)!;
  assert.equal('proxyPassword' in visible.config, false); assert.equal('proxyUsername' in visible.config, false);
  assert.equal(visible.configuredSecrets.proxyPassword, true); assert.equal(visible.configuredSecrets.proxyUsername, true);
  const stored = JSON.stringify(inspector.prepare('SELECT config_cipher FROM config_revisions').all());
  assert.equal(stored.includes(proxy.proxyPassword), false); assert.equal(stored.includes(proxy.proxyUsername), false);
  const updated = db.updateBot(first.id, {config: {proxyForTools: true}, expectedRevision: 1});
  assert.equal(updated.config.proxyPassword, proxy.proxyPassword); assert.equal(updated.config.proxyUsername, proxy.proxyUsername);
  assert.equal(updated.desiredRevision, 2); assert.equal(updated.volume, first.volume); assert.equal(updated.targetId, first.targetId);
  assert.equal(db.getBot(second.id)!.config.proxyEnabled, false); assert.equal(db.getBot(second.id)!.desiredRevision, 1);
  const cleared = db.updateBot(first.id, {config: {proxyEnabled: false, proxyUsername: null, proxyPassword: null}, expectedRevision: 2});
  assert.equal(cleared.config.proxyUsername, undefined); assert.equal(cleared.config.proxyPassword, undefined);
  assert.equal(cleared.config.proxyUrl, updated.config.proxyUrl);
  assert.equal(db.getPublicBot(first.id)!.configuredSecrets.proxyPassword, false);
  assert.equal(db.getWorkerSnapshot(second.id).env.NETWORK_PROXY_ENABLED, 'false');
  assert.equal(db.getWorkerSnapshot(first.id).env.NETWORK_PROXY_PASSWORD, '');
});
