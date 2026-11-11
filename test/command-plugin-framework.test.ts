import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ConsoleDatabase } from '../src/console/database.js';
import { PLUGIN_MANIFESTS, commandPlugins } from '../src/plugin-system/registry.js';
import type { CommandPluginDefinition, PluginManifest } from '../src/plugin-system/contracts.js';

function fixture(t: TestContext) {
  const id = 'example-command';
  const manifest: PluginManifest = { id, name: 'Synthetic command plugin', version: '1.0.0', apiVersion: 1, required: false,
    capabilities: ['commands'], resourceTypes: [], commands: [{ name: '/example', description: 'Synthetic command.', pluginId: id, executor: 'console', contextPolicy: 'chat' }] };
  let executions = 0;
  const plugin: CommandPluginDefinition = {
    kind: 'command', manifest, defaults: {},
    validateConfig(value) { assert.deepEqual(value, {}); return {}; },
    command(event) {
      const source = event as { message_id?: string; message?: Array<{ type: string; data: { text?: string } }> };
      const text = source.message?.filter(segment => segment.type === 'text').map(segment => segment.data.text ?? '').join('') ?? '';
      if (!source.message_id || !/^\/example(?:$|\s)/u.test(text)) return;
      return { pluginId: id, command: 'example', args: text.slice('/example'.length).trim(), sourceMessageId: source.message_id, executor: 'console', contextPolicy: 'chat' };
    },
    execute(dispatch) { executions++; return { text: 'Synthetic result ' + executions, summary: 'Synthetic command summary', details: [{ label: 'Input', value: dispatch.args }] }; },
  };
  (PLUGIN_MANIFESTS as PluginManifest[]).push(manifest);
  (commandPlugins as CommandPluginDefinition[]).push(plugin);
  const root = mkdtempSync(join(tmpdir(), 'nekodock-command-plugin-'));
  const path = join(root, 'console.sqlite3'), key = join(root, 'master.key');
  let db = new ConsoleDatabase(path, key);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); (PLUGIN_MANIFESTS as PluginManifest[]).pop(); (commandPlugins as CommandPluginDefinition[]).pop(); });
  const bot = db.createBot({ name: 'Synthetic bot', targetType: 'group', targetId: '1001', config: {} });
  db.setDesiredState(bot.id, 'running');
  const event = (messageId: string, args = 'synthetic-input') => ({ post_type: 'message', message_type: 'group', group_id: '1001', message_id: messageId, user_id: '2001', self_id: '9999', time: 1,
    message: [{ type: 'text', data: { text: '/example ' + args } }] });
  return { id, bot, path, plugin, event, get db() { return db; }, get executions() { return executions; }, restart() { db.close(); db = new ConsoleDatabase(path, key); } };
}

test('optional command plugins use independent settings and advertise only enabled commands', t => {
  const f = fixture(t);
  assert.equal(f.db.plugins.view(f.bot.id, f.id).enabled, false);
  assert.ok(!f.db.plugins.commands(f.bot.id).some(command => command.pluginId === f.id));
  f.db.enqueueNapcatEvent(f.bot.id, f.event('disabled'), 'synthetic:disabled');
  assert.equal(f.executions, 0);
  assert.equal(f.db.plugins.dispatch(f.bot.id, 'disabled'), undefined);
  const enabled = f.db.plugins.update(f.bot.id, f.id, { expectedRevision: 0, enabled: true });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.revision, 1);
  assert.ok(f.db.plugins.commands(f.bot.id).some(command => command.name === '/example'));
  const other = f.db.createBot({ name: 'Other bot', targetType: 'group', targetId: '1002', connectionId: f.bot.connectionId, config: {} });
  assert.equal(f.db.plugins.view(other.id, f.id).enabled, false);
  assert.throws(() => f.db.plugins.update(f.bot.id, f.id, { expectedRevision: 0, enabled: false }), /版本冲突/u);
});

test('a command executes once in the inbound transaction and survives redelivery and Console restart', t => {
  const f = fixture(t);
  f.db.plugins.update(f.bot.id, f.id, { expectedRevision: 0, enabled: true });
  f.db.enqueueNapcatEvent(f.bot.id, f.event('source'), 'synthetic:source');
  assert.equal(f.executions, 1);
  const dispatch = f.db.plugins.dispatch(f.bot.id, 'source')!;
  assert.equal(dispatch.contextPolicy, 'chat');
  assert.equal(dispatch.executor, 'console');
  assert.ok(dispatch.jobId);
  assert.equal(f.db.plugins.claim(), null);
  const before = f.db.plugins.view(f.bot.id, f.id).jobs[0]!;
  assert.equal(before.operation, 'execute');
  assert.equal(before.state, 'completed');
  assert.equal(before.resource, undefined);
  assert.equal(before.commandName, '/example');
  assert.deepEqual(before.commandExecution, { input: 'synthetic-input', text: 'Synthetic result 1', summary: 'Synthetic command summary', details: [{ label: 'Input', value: 'synthetic-input' }] });
  assert.deepEqual(f.db.plugins.snapshot(f.bot.id).results, []);
  assert.deepEqual(f.db.plugins.snapshot(f.bot.id).pendingBindings, ['source']);
  const inspector = new DatabaseSync(f.path, { readOnly: true });
  const stored = String(inspector.prepare('SELECT command_execution_cipher FROM plugin_jobs WHERE id=?').get(dispatch.jobId)?.command_execution_cipher);
  assert.ok(!stored.includes('synthetic-input'));
  assert.ok(!stored.includes('Synthetic result'));
  inspector.close();
  assert.equal(f.db.enqueueNapcatEvent(f.bot.id, f.event('source'), 'synthetic:source'), null);
  f.restart();
  f.db.enqueueNapcatEvent(f.bot.id, f.event('source'), 'synthetic:redelivery-with-new-key');
  assert.equal(f.executions, 1);
  assert.deepEqual(f.db.plugins.view(f.bot.id, f.id).jobs[0], before);
  f.db.plugins.sync(f.bot.id, { bindings: [{ messageId: 'source', conversationId: 'synthetic-conversation' }] });
  const result = f.db.plugins.snapshot(f.bot.id).results[0]!;
  assert.equal(result.text, 'Synthetic result 1');
  assert.equal(result.replyTo, 'source');
  assert.equal(result.conversationId, 'synthetic-conversation');
  assert.equal(f.db.plugins.authorizeSend(f.bot.id, result.id).id, result.id);
  assert.throws(() => f.db.plugins.sync(f.bot.id, { acknowledgements: [result.id] }), /尚未完成/u);
  f.db.plugins.finishSend(f.bot.id, result.id, { ok: true, messageId: 'actual-qq-reply' });
  assert.deepEqual(f.db.plugins.view(f.bot.id, f.id).jobs[0]!.deliveries, [{ kind: 'reply', status: 'acknowledged', messageId: 'actual-qq-reply' }]);
  f.db.plugins.sync(f.bot.id, { acknowledgements: [result.id] });
  assert.deepEqual(f.db.plugins.snapshot(f.bot.id).results, []);
});

test('disabling a command plugin cancels unsent output and Runner never claims local execution records', t => {
  const f = fixture(t);
  f.db.plugins.update(f.bot.id, f.id, { expectedRevision: 0, enabled: true });
  f.db.enqueueNapcatEvent(f.bot.id, f.event('source'), 'synthetic:source');
  f.db.plugins.sync(f.bot.id, { bindings: [{ messageId: 'source', conversationId: 'synthetic-conversation' }] });
  const result = f.db.plugins.snapshot(f.bot.id).results[0]!;
  f.db.plugins.update(f.bot.id, f.id, { expectedRevision: 1, enabled: false });
  assert.equal(f.db.plugins.getResult(f.bot.id, result.id)?.delivery?.code, 'PLUGIN_CONFIGURATION_CHANGED');
  const inspector = new DatabaseSync(f.path);
  inspector.prepare("UPDATE plugin_jobs SET state='queued' WHERE plugin_id=?").run(f.id);
  assert.equal(f.db.plugins.claim(), null);
  inspector.prepare("UPDATE plugin_jobs SET state='running',lease_until=0,attempts=3 WHERE plugin_id=?").run(f.id);
  assert.equal(f.db.plugins.claim(), null);
  assert.equal(inspector.prepare('SELECT state FROM plugin_jobs WHERE plugin_id=?').get(f.id)?.state, 'running');
  inspector.close();
});

test('a failed local execution rolls back its inbound dedup and result together', t => {
  const f = fixture(t);
  f.db.plugins.update(f.bot.id, f.id, { expectedRevision: 0, enabled: true });
  const execute = f.plugin.execute;
  f.plugin.execute = () => { throw new Error('Synthetic execution failure'); };
  assert.throws(() => f.db.enqueueNapcatEvent(f.bot.id, f.event('source'), 'synthetic:source'), /Synthetic execution failure/u);
  assert.equal(f.db.plugins.dispatch(f.bot.id, 'source'), undefined);
  assert.deepEqual(f.db.plugins.view(f.bot.id, f.id).jobs, []);
  f.plugin.execute = execute;
  assert.ok(f.db.enqueueNapcatEvent(f.bot.id, f.event('source'), 'synthetic:source'));
  assert.equal(f.executions, 1);
});

test('Console validates full command arguments while bounding the dispatch sent to the Worker', t => {
  const f = fixture(t), input = 'invalid-'.repeat(4000);
  f.db.plugins.update(f.bot.id, f.id, { expectedRevision: 0, enabled: true });
  let actual = '';
  f.plugin.execute = dispatch => {
    actual = dispatch.args;
    return { text: 'Synthetic usage hint.', summary: 'Invalid arguments', details: [] };
  };
  f.db.enqueueNapcatEvent(f.bot.id, f.event('source', input), 'synthetic:source');
  assert.equal(actual, input);
  assert.equal(f.db.plugins.dispatch(f.bot.id, 'source')!.args, input.slice(0, 16384));
  assert.equal(f.db.plugins.view(f.bot.id, f.id).jobs[0]!.commandExecution!.input, input.slice(0, 1000));
  const inbound = f.db.pendingNapcatEvents(f.bot.id)[0]!;
  assert.equal((inbound.event as ReturnType<typeof f.event>).message[0]!.data.text, '/example ' + input);
  f.db.plugins.sync(f.bot.id, { bindings: [{ messageId: 'source', conversationId: 'synthetic-conversation' }] });
  assert.equal(f.db.plugins.snapshot(f.bot.id).results[0]!.text, 'Synthetic usage hint.');
});

test('the initial conversation event preserves command output until its source receives a real binding', t => {
  const f = fixture(t);
  f.db.plugins.update(f.bot.id, f.id, { expectedRevision: 0, enabled: true });
  f.db.enqueueNapcatEvent(f.bot.id, f.event('source'), 'synthetic:source');
  f.db.ingestEvents(f.bot.id, [{ seq: 1, type: 'conversation.started', conversationId: 'synthetic-current', time: Date.now(), payload: {} }]);
  assert.deepEqual(f.db.plugins.view(f.bot.id, f.id).jobs[0]!.deliveries, [{ kind: 'reply', status: 'pending' }]);
  assert.deepEqual(f.db.plugins.snapshot(f.bot.id).results, []);
  f.db.plugins.sync(f.bot.id, { bindings: [{ messageId: 'source', conversationId: 'synthetic-current' }], conversationId: 'synthetic-current' });
  const result = f.db.plugins.snapshot(f.bot.id).results[0]!;
  assert.equal(result.delivery, undefined);
  assert.equal(f.db.plugins.authorizeSend(f.bot.id, result.id).replyTo, 'source');
  f.db.plugins.finishSend(f.bot.id, result.id, { ok: true, messageId: 'actual-qq-reply' });
  assert.equal(f.db.plugins.getResult(f.bot.id, result.id)?.delivery?.status, 'acknowledged');
});

test('a new conversation cancels bound old command output while leaving unbound output pending', t => {
  const f = fixture(t);
  f.db.plugins.update(f.bot.id, f.id, { expectedRevision: 0, enabled: true });
  f.db.enqueueNapcatEvent(f.bot.id, f.event('old-source'), 'synthetic:old-source');
  f.db.plugins.sync(f.bot.id, { bindings: [{ messageId: 'old-source', conversationId: 'synthetic-old' }] });
  const oldResult = f.db.plugins.snapshot(f.bot.id).results[0]!;
  f.db.enqueueNapcatEvent(f.bot.id, f.event('pending-source'), 'synthetic:pending-source');
  f.db.ingestEvents(f.bot.id, [{ seq: 1, type: 'conversation.started', conversationId: 'synthetic-current', time: Date.now(), payload: {} }]);
  assert.equal(f.db.plugins.getResult(f.bot.id, oldResult.id)?.delivery?.code, 'PLUGIN_CONVERSATION_CHANGED');
  const pending = f.db.plugins.view(f.bot.id, f.id).jobs.find(job => job.sourceMessageId === 'pending-source')!;
  assert.deepEqual(pending.deliveries, [{ kind: 'reply', status: 'pending' }]);
});

test('disabling a command plugin still cancels output whose source has no conversation binding', t => {
  const f = fixture(t);
  f.db.plugins.update(f.bot.id, f.id, { expectedRevision: 0, enabled: true });
  f.db.enqueueNapcatEvent(f.bot.id, f.event('source'), 'synthetic:source');
  f.db.ingestEvents(f.bot.id, [{ seq: 1, type: 'conversation.started', conversationId: 'synthetic-current', time: Date.now(), payload: {} }]);
  f.db.plugins.update(f.bot.id, f.id, { expectedRevision: 1, enabled: false });
  assert.deepEqual(f.db.plugins.view(f.bot.id, f.id).jobs[0]!.deliveries, [{ kind: 'reply', status: 'failed', code: 'PLUGIN_CONFIGURATION_CHANGED' }]);
  f.db.plugins.sync(f.bot.id, { bindings: [{ messageId: 'source', conversationId: 'synthetic-current' }] });
  assert.equal(f.db.plugins.snapshot(f.bot.id).results[0]!.delivery?.code, 'PLUGIN_CONFIGURATION_CHANGED');
});
