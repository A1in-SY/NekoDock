import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConsoleDatabase } from '../src/console/database.js';
import { PLUGIN_MANIFESTS, contentPlugins } from '../src/plugin-system/registry.js';
import { pluginRunner } from '../src/plugin-system/runner-registry.js';
import { runnerDefinitions } from '../src/plugin-system/generated/runner.js';
import { PluginExecutionError, type ContentPluginDefinition, type PluginContent, type PluginManifest, type PluginResource, type PluginRunnerDefinition } from '../src/plugin-system/contracts.js';
import { runPluginRunner } from '../src/plugin-runner.js';

test('a content plugin owns its config, article identity, summary and policy without platform-specific host fields', t => {
  const id = 'example-article';
  const resource: PluginResource = { kind: 'article', id: 'article-42', url: 'https://example.invalid/articles/42' };
  const content: PluginContent = { type: 'article', platform: id, resourceId: resource.id, url: resource.url, title: 'Synthetic article', author: 'Synthetic author', retrieval: { status: 'ready' } };
  const manifest: PluginManifest = { id, name: 'Synthetic article plugin', version: '1.0.0', apiVersion: 1, required: false, capabilities: ['content-enrichment'], resourceTypes: ['article'], commands: [] };
  const plugin: ContentPluginDefinition = {
    kind: 'content', manifest, defaults: { fetchBudgetSeconds: 7 },
    validateConfig(input) { assert.deepEqual(input, { fetchBudgetSeconds: 7 }); return { fetchBudgetSeconds: 7 }; },
    match: () => [resource], command: () => undefined, validateContent: value => { assert.deepEqual(value, content); return content; },
    contentText: value => value.title, failureContent: (source, error) => ({ ...content, resourceId: source.id, retrieval: { status: 'failed', error } }),
    errorText: code => code, shouldProcess: () => true,
    policy: () => ({ timeoutSeconds: 7, waitSeconds: 1, maxAssetBytes: 1024, cacheMaxBytes: 4096, cacheHours: 1 }),
    summarize: (source, value) => source ? { id: source.id, url: source.url, title: value?.title, author: value?.author } : undefined,
    missingResourceText: 'Synthetic missing article.', afterResolve: () => ({ provideContext: true }),
  };
  (PLUGIN_MANIFESTS as PluginManifest[]).push(manifest);
  (contentPlugins as ContentPluginDefinition[]).push(plugin);
  t.after(() => { (PLUGIN_MANIFESTS as PluginManifest[]).pop(); (contentPlugins as ContentPluginDefinition[]).pop(); });
  const root = mkdtempSync(join(tmpdir(), 'nekodock-generic-plugin-'));
  const db = new ConsoleDatabase(join(root, 'console.sqlite3'), join(root, 'master.key'));
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const bot = db.createBot({ name: 'Synthetic bot', targetType: 'group', targetId: '1001', config: {} });
  db.setDesiredState(bot.id, 'running');
  const config = db.plugins.update(bot.id, id, { expectedRevision: 0, enabled: true, config: { fetchBudgetSeconds: 7 } });
  assert.deepEqual(config.config, { fetchBudgetSeconds: 7 });
  const now = Date.now();
  db.plugins.register(bot.id, { message_id: 'synthetic-source', message: [{ type: 'text', data: { text: resource.url } }] }, now);
  db.plugins.sync(bot.id, { bindings: [{ messageId: 'synthetic-source', conversationId: 'synthetic-conversation' }] });
  const job = db.plugins.claim(now)!;
  assert.equal(job.pluginId, id);
  assert.deepEqual(job.resource, resource);
  assert.deepEqual(job.config, { fetchBudgetSeconds: 7 });
  assert.equal(job.expiresAt, now + 37_000);
  assert.equal(db.plugins.snapshot(bot.id).waitSeconds, 1);
  assert.equal(db.plugins.complete(job.id, job.lease, { content }, now + 100).accepted, true);
  const result = db.plugins.snapshot(bot.id).results.find(result => result.pluginId === id)!;
  assert.deepEqual(result.content, content);
  assert.deepEqual(result.contents, [content]);
  const record = db.plugins.view(bot.id, id).jobs[0]!;
  assert.deepEqual(record.resource, { id: resource.id, url: resource.url, title: content.title, author: content.author });
  assert.equal(record.durationMs, 100);
  assert.equal(db.plugins.view(bot.id, 'core').jobs.length, 0);
});

test('the shared runner dispatches a registered non-video plugin and preserves common error codes', async t => {
  const controller = new AbortController();
  const id = 'example-article';
  const definition: PluginRunnerDefinition = { execute: async job => { assert.equal(job.pluginId, id); throw new PluginExecutionError('EXAMPLE_RATE_LIMITED', true); } };
  (runnerDefinitions as Array<{pluginId: string; definition: PluginRunnerDefinition}>).push({ pluginId: id, definition });
  t.after(() => { (runnerDefinitions as Array<{pluginId: string; definition: PluginRunnerDefinition}>).pop(); });
  assert.equal(pluginRunner(id), definition);
  assert.throws(() => pluginRunner('not-installed'), error => error instanceof PluginExecutionError && error.code === 'PLUGIN_RUNNER_NOT_FOUND');
  let claimed = false, result: unknown;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/claim')) {
      assert.equal(claimed, false); claimed = true;
      return Response.json({ job: { id: 'synthetic-job', lease: 'synthetic-lease', pluginId: id, config: {}, resource: { kind: 'article', id: '42', url: 'https://example.invalid/42' } } });
    }
    if (url.pathname.endsWith('/result')) { result = JSON.parse(String(init?.body)).result; controller.abort(); return Response.json({ accepted: true }); }
    throw new Error('Unexpected synthetic runner endpoint');
  };
  await runPluginRunner({ url: 'http://console.invalid', token: 'synthetic-runner-token', workspace: '/nonexistent', signal: controller.signal, fetch: fetcher });
  assert.deepEqual(result, { error: 'EXAMPLE_RATE_LIMITED', retryable: true });
});
