import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {ConsoleDatabase} from '../src/console/database.js';
import {createConsole} from '../src/console/server.js';
import {DockerClient} from '../src/console/docker.js';
import {defaultSettings} from '../src/console/settings.js';
import {modelSettings} from '../src/model-preset-contract.js';

const a = {...modelSettings(defaultSettings()), model: 'model-a', baseUrl: 'https://a.example/v1', modelApiKey: 'synthetic-key-a'};
const b = {...a, model: 'model-b', baseUrl: 'https://b.example/v1', modelApiKey: 'synthetic-key-b', modelApi: 'openai-completions' as const,
  supportsImages: false, supportsReasoning: false, reasoning: 'none' as const, contextWindow: 64000, compactLimit: 48000, compactKeepRecentTokens: 8000, compactSummaryMaxTokens: 2000, maxOutputTokens: 4096};
function database(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'model-presets-')), path = join(directory, 'console.sqlite3');
  const db = new ConsoleDatabase(path, join(directory, 'master.key'));
  t.after(() => {db.close(); rmSync(directory, {recursive: true, force: true});});
  return {db, path};
}
function bot(db: ConsoleDatabase) {return db.createBot({name: 'example', targetType: 'group', targetId: '1001', config: {...defaultSettings(), ...a, persona: 'synthetic persona', modelTimeout: 500}});}

test('presets encrypt credentials, return only public metadata and validate complete model settings', t => {
  const {db, path} = database(t);
  const preset = db.modelPresets.create({name: ' Example ', config: a});
  assert.equal(preset.name, 'Example'); assert.equal(preset.keyConfigured, true);
  assert.equal(JSON.stringify(db.modelPresets.list()).includes(a.modelApiKey), false);
  assert.equal('modelApiKey' in preset.config, false);
  const inspector = new DatabaseSync(path, {readOnly: true});
  assert.equal(JSON.stringify(inspector.prepare('SELECT * FROM model_presets').all()).includes(a.modelApiKey), false); inspector.close();
  for (const config of [{model: ''}, {baseUrl: 'https://user:pass@a.example'}, {persona: 'invalid'}, {compactLimit: 200000}, {modelApiKey: 123}, {supportsImages: 'yes'}])
    assert.throws(() => db.modelPresets.create({name: 'invalid', config: {...a, ...config}}));
  assert.equal(db.modelPresets.list().length, 1);
});

test('applying and switching presets atomically replaces connection, credentials, capabilities and token settings', t => {
  const {db} = database(t), instance = bot(db);
  const first = db.modelPresets.create({name: 'A', config: a}), second = db.modelPresets.create({name: 'B', config: b});
  let current = db.updateBot(instance.id, {expectedRevision: 1, modelPreset: {id: second.id, revision: 1}, config: {...a, persona: 'kept persona'}});
  assert.deepEqual(modelSettings(current.config), {...b, baseUrl: 'https://b.example/v1'});
  assert.equal(current.config.persona, 'kept persona'); assert.equal(current.config.modelTimeout, 500);
  assert.deepEqual(current.modelPreset, {id: second.id, name: 'B', revision: 1});
  const env = db.getWorkerSnapshot(instance.id).env;
  assert.equal(env.AGENT_API_KEY, b.modelApiKey); assert.equal(env.AGENT_MODEL, b.model); assert.equal(env.AGENT_BASE_URL, b.baseUrl);
  assert.equal(env.AGENT_API, 'openai-completions'); assert.equal(env.AGENT_CONTEXT_WINDOW, '64000');
  current = db.updateBot(instance.id, {expectedRevision: current.desiredRevision, modelPreset: {id: first.id, revision: 1}});
  assert.deepEqual(modelSettings(current.config), a);
  assert.equal(db.getWorkerSnapshot(instance.id).env.AGENT_API_KEY, a.modelApiKey);
});

test('a keyless preset clears the previous key, including stale keys submitted by the browser', t => {
  const {db} = database(t), instance = bot(db);
  const preset = db.modelPresets.create({name: 'No auth', config: {...b, modelApiKey: null}});
  const current = db.updateBot(instance.id, {modelPreset: {id: preset.id, revision: 1}, config: {modelApiKey: 'stale-browser-key'}});
  assert.equal(current.config.modelApiKey, undefined);
  assert.equal(db.getWorkerSnapshot(instance.id).env.AGENT_API_KEY, undefined);
  assert.equal(db.getPublicBot(instance.id)!.configuredSecrets.modelApiKey, false);
});

test('editing or deleting a preset leaves applied snapshots and their historical bindings intact', t => {
  const {db, path} = database(t), instance = bot(db), preset = db.modelPresets.create({name: 'A', config: a});
  const applied = db.updateBot(instance.id, {modelPreset: {id: preset.id, revision: 1}});
  db.modelPresets.update(preset.id, {expectedRevision: 1, name: 'Updated', config: b});
  assert.deepEqual(db.getBot(instance.id), applied);
  assert.throws(() => db.updateBot(instance.id, {expectedRevision: applied.desiredRevision, config: {persona: 'must rollback'}, modelPreset: {id: preset.id, revision: 1}}), /版本冲突/u);
  assert.deepEqual(db.getBot(instance.id), applied);
  const updated = db.updateBot(instance.id, {modelPreset: {id: preset.id, revision: 2}});
  assert.equal(updated.config.modelApiKey, b.modelApiKey);
  assert.equal(updated.modelPreset?.name, 'Updated');
  db.modelPresets.delete(preset.id, 2);
  assert.equal(db.modelPresets.list().length, 0); assert.deepEqual(db.getBot(instance.id), updated);
  const inspect = new DatabaseSync(path, {readOnly: true});
  assert.equal(inspect.prepare('SELECT preset_revision FROM model_preset_bindings WHERE bot_id=? AND config_revision=?').get(instance.id, applied.desiredRevision)!.preset_revision, 1);inspect.close();
});

test('non-model changes preserve provenance while custom model changes detach it', t => {
  const {db} = database(t), instance = bot(db), preset = db.modelPresets.create({name: 'A', config: a});
  const applied = db.updateBot(instance.id, {modelPreset: {id: preset.id, revision: 1}});
  const persona = db.updateBot(instance.id, {config: {persona: 'new persona'}});
  assert.deepEqual(persona.modelPreset, applied.modelPreset);
  const connection = db.getNapcatConnection(instance.connectionId)!;
  db.updateNapcatConnection(connection.id, {actionTimeout: 22});
  assert.deepEqual(db.getBot(instance.id)!.modelPreset, applied.modelPreset);
  const custom = db.updateBot(instance.id, {config: {reasoning: 'high'}});
  assert.equal(custom.modelPreset, undefined); assert.equal(custom.config.modelApiKey, a.modelApiKey);
  assert.equal(db.getPublicBot(instance.id)!.modelPreset, undefined);
});

test('saving an existing instance as a preset copies its encrypted key without changing the instance', t => {
  const {db} = database(t), instance = bot(db);
  const preset = db.modelPresets.fromBot(instance.id, {name: 'Saved', expectedRevision: 1});
  assert.equal(preset.keyConfigured, true); assert.deepEqual(db.getBot(instance.id), instance);
  assert.equal(db.modelPresets.resolve({id: preset.id, revision: 1}).config.modelApiKey, a.modelApiKey);
  assert.throws(() => db.modelPresets.fromBot(instance.id, {name: 'stale', expectedRevision: 0}), /版本冲突/u);
});

test('stale instance or preset revisions, invalid selections and invalid patches leave config unchanged', t => {
  const {db} = database(t), instance = bot(db), preset = db.modelPresets.create({name: 'A', config: a});
  for (const input of [
    {expectedRevision: 0, modelPreset: {id: preset.id, revision: 1}},
    {modelPreset: {id: preset.id, revision: 0}}, {modelPreset: {id: 'missing', revision: 1}},
    {modelPreset: {id: preset.id, revision: 1, modelApiKey: 'forged'}},
    {modelPreset: {id: preset.id, revision: 1}, config: {persona: 123}},
  ]) {assert.throws(() => db.updateBot(instance.id, input)); assert.deepEqual(db.getBot(instance.id), instance);}
  db.modelPresets.update(preset.id, {expectedRevision: 1, config: {model: 'renamed'}});
  assert.equal(db.modelPresets.resolve({id: preset.id, revision: 2}).config.modelApiKey, a.modelApiKey);
  assert.throws(() => db.modelPresets.delete(preset.id, 1), /版本冲突/u);
});

class FakeDocker extends DockerClient {
  constructor() {super({socketPath: 'unused', image: 'unused', network: 'unused', consoleUrl: 'unused'});}
  override async inspect() {return null;}
}
test('model preset API enforces authentication, CSRF and optimistic revisions without exposing credentials', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'model-presets-api-'));
  const {app, db} = await createConsole({dataDir: directory, docker: new FakeDocker(), timers: false, staticDir: '/nonexistent'});
  t.after(async () => {await app.close(); rmSync(directory, {recursive: true, force: true});});
  assert.equal((await app.inject('/api/model-presets')).statusCode, 401);
  const setup = await app.inject({method: 'POST', url: '/api/setup', headers: {'x-console-request': '1'}, payload: {password: 'synthetic-admin-password'}});
  const headers = {'x-console-request': '1', cookie: setup.headers['set-cookie']!.toString().split(';')[0]!};
  assert.equal((await app.inject({method: 'POST', url: '/api/model-presets', headers: {cookie: headers.cookie}, payload: {name: 'A', config: a}})).statusCode, 403);
  const create = await app.inject({method: 'POST', url: '/api/model-presets', headers, payload: {name: 'A', config: a}});
  assert.equal(create.statusCode, 201, create.body); assert.equal(create.body.includes(a.modelApiKey), false);const preset = create.json();
  const instance = bot(db);
  const apply = await app.inject({method: 'PUT', url: `/api/bots/${instance.id}`, headers, payload: {expectedRevision: 1, modelPreset: {id: preset.id, revision: 1}}});
  assert.equal(apply.statusCode, 200, apply.body); assert.equal(apply.json().modelPreset.id, preset.id); assert.equal(apply.body.includes(a.modelApiKey), false);
  assert.equal((await app.inject({method: 'PUT', url: `/api/model-presets/${preset.id}`, headers, payload: {expectedRevision: 0, config: b}})).statusCode, 409);
  assert.equal((await app.inject({method: 'PUT', url: `/api/bots/${instance.id}`, headers, payload: {expectedRevision: 1, modelPreset: {id: preset.id, revision: 1}}})).statusCode, 409);
  const saved = await app.inject({method: 'POST', url: `/api/bots/${instance.id}/model-presets`, headers, payload: {expectedRevision: 2, name: 'Copy'}});
  assert.equal(saved.statusCode, 201, saved.body); assert.equal(saved.body.includes(a.modelApiKey), false);
  assert.equal((await app.inject({method: 'DELETE', url: `/api/model-presets/${preset.id}`, headers, payload: {expectedRevision: 1}})).statusCode, 200);
  assert.equal(db.getWorkerSnapshot(instance.id).env.AGENT_API_KEY, a.modelApiKey);
});
