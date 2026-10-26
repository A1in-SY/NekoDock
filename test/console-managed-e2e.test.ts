import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AddressInfo } from 'node:net';
import type { ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createConsole } from '../src/console/server.js';
import { DockerClient } from '../src/console/docker.js';
import type { ConsoleEvent, ConversationUpdate, PublicBot } from '../src/console/contracts.js';
import { assertAccepted, piFixture, respond, sendReply, type ModelCall } from './fixtures/pi-e2e.js';

const image = process.env.BRIDGE_E2E_IMAGE;
const run = promisify(execFile);

async function thinkingReply(call: ModelCall, response: ServerResponse, visible: string, gate: Promise<void>, completed: () => void): Promise<void> {
  assert.ok(call.path.endsWith('/responses'));
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const id = randomUUID().replaceAll('-', ''); let sequence = 0;
  const emit = (type: string, value: Record<string, unknown>) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: ++sequence, ...value })}\n\n`);
  emit('response.created', { response: { id: `resp_${id}`, object: 'response', status: 'in_progress', output: [] } });
  const output: unknown[] = [];
  for (const [index, text] of [visible, 'Second visible managed step.'].entries()) {
    const item = { type: 'reasoning', id: `rs_${id}_${index}`, summary: [{ type: 'summary_text', text }], encrypted_content: 'opaque-managed-signature-never-publish' };
    emit('response.output_item.added', { output_index: index, item: { type: item.type, id: item.id, summary: [] } });
    emit('response.reasoning_summary_text.delta', { output_index: index, item_id: item.id, summary_index: 0, delta: text });
    if (index === 0) await gate;
    if (response.destroyed) return;
    emit('response.output_item.done', { output_index: index, item }); output.push(item);
  }
  const tool = { type: 'function_call', id: `fc_${id}`, call_id: `call_${id}`, name: 'send_message', arguments: JSON.stringify({ messages: [{ type: 'text', text: 'managed-reply-1' }] }), status: 'completed' };
  emit('response.output_item.added', { output_index: 2, item: { ...tool, arguments: '' } });
  emit('response.function_call_arguments.delta', { output_index: 2, item_id: tool.id, delta: tool.arguments });
  emit('response.function_call_arguments.done', { output_index: 2, item_id: tool.id, arguments: tool.arguments });
  emit('response.output_item.done', { output_index: 2, item: tool }); output.push(tool);
  completed();
  emit('response.completed', { response: { id: `resp_${id}`, object: 'response', status: 'completed', model: call.body.model, output,
    usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110, input_tokens_details: { cached_tokens: 40 } } } });
  response.end();
}

test('isolated Docker managed Pi worker applies DB config and preserves real Pi session across replacement', { skip: !image, timeout: 140_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'napcat-console-managed-e2e-'));
  let round = 0, firstResponseCompleted = false, workerToken = '';
  let releaseThinking!: () => void;
  const thinkingGate = new Promise<void>(resolve => { releaseThinking = resolve; });
  t.after(() => releaseThinking());
  const f = await piFixture(t, async (call, response) => {
    if (call.results.length) { assertAccepted(call); respond(call, response, 'Internal completion.'); return; }
    round++;
    if (round === 1) {
      await thinkingReply(call, response, `Visible managed step with managed-private-model-key, managed-private-napcat-key and ${workerToken}.`, thinkingGate, () => { firstResponseCompleted = true; });
      return;
    }
    sendReply(call, response, [{ type: 'text', text: `managed-reply-${round}` }]);
  });
  const network = `napcat-console-e2e-${randomUUID()}`;
  const docker = new DockerClient({ socketPath: process.env.DOCKER_SOCKET ?? '/var/run/docker.sock', image: image!, network, consoleUrl: '' });
  const consoleApp = await createConsole({ dataDir: directory, docker, staticDir: '/nonexistent' });
  const eventUploadTypes: string[] = [], heartbeatEventTypes: string[] = [];
  consoleApp.app.addHook('preHandler', async request => {
    if (request.method !== 'POST' || !request.url.startsWith('/internal/workers/')) return;
    const body = request.body as { events?: Array<{ type?: unknown }> } | undefined;
    const types = Array.isArray(body?.events) ? body.events.flatMap(event => typeof event.type === 'string' ? [event.type] : []) : [];
    if (request.url.endsWith('/events')) eventUploadTypes.push(...types);
    if (request.url.endsWith('/heartbeat')) heartbeatEventTypes.push(...types);
  });
  const owned = new Map<string, string>();
  t.after(async () => {
    await consoleApp.app.close();
    for (const [id, volume] of owned) {
      const container = await docker.inspect(id);
      if (container) { assert.equal(container.Config.Labels['io.napcat.console.bot'], id); await docker.stop(id); await docker.remove(id); }
      const metadata = await docker.request<{ Labels: Record<string, string> }>('GET', `/volumes/${encodeURIComponent(volume)}`);
      assert.equal(metadata.Labels['io.napcat.console.bot'], id); await docker.request('DELETE', `/volumes/${encodeURIComponent(volume)}`);
    }
    try { await docker.request('DELETE', `/networks/${encodeURIComponent(network)}`); } catch {}
    await rm(directory, { recursive: true, force: true });
  });
  await consoleApp.app.listen({ host: '0.0.0.0', port: 0 });
  const port = (consoleApp.app.server.address() as AddressInfo).port;
  docker.options.consoleUrl = `http://host.docker.internal:${port}`;
  let cookie = '';
  async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'x-console-request': '1', ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json(); assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(value)}`);
    const setCookie = response.headers.get('set-cookie'); if (setCookie) cookie = setCookie.split(';')[0]!; return value as T;
  }
  async function until(condition: () => Promise<boolean>, label: string, timeout = 30_000) {
    const end = Date.now() + timeout;
    while (!await condition()) {
      assert.ok(Date.now() < end, `${label}; states=${JSON.stringify(consoleApp.db.listPublicBots().map(bot => ({ id: bot.id, state: bot.state, connected: bot.connected, revision: bot.appliedRevision, error: bot.error })))}`);
      await delay(100);
    }
  }
  await api('/api/setup', 'POST', { password: 'isolated-e2e-admin-password' });
  const bot = await api<PublicBot>('/api/bots', 'POST', { name: `e2e-${randomUUID()}`, targetType: 'group', targetId: '1001', config: {
    wsUrl: f.wsUrl, napcatToken: 'managed-private-napcat-key', persona: 'First isolated persona', model: 'provider-model-1001', baseUrl: f.modelUrl, modelApiKey: 'managed-private-model-key',
    modelApi: 'openai-responses', supportsReasoning: true, allowCommands: false, allowFileWrites: false,
    reasoning: 'low', searchProvider: 'none', ttsProvider: 'none', voiceEnabled: false, replyProbability: 0,
  } });
  workerToken = consoleApp.db.getBot(bot.id)!.workerToken;
  owned.set(bot.id, bot.volume);
  await api(`/api/bots/${bot.id}/start`, 'POST', {});
  await until(async () => { const value = consoleApp.db.getPublicBot(bot.id)!; return value.state === 'running' && value.connected && value.appliedRevision === 1; }, 'worker initially online');
  const first = await docker.inspect(bot.id); assert.ok(first?.State.Running); assert.ok(first.Mounts?.some(mount => mount.Name === bot.volume && mount.Destination === '/data'));
  const streamAbort = new AbortController();
  const streamResponse = await fetch(`http://127.0.0.1:${port}/api/bots/${bot.id}/conversation/stream?after=0`, { headers: { cookie }, signal: streamAbort.signal });
  assert.equal(streamResponse.status, 200); assert.match(streamResponse.headers.get('content-type') ?? '', /text\/event-stream/u);
  const updates: ConversationUpdate[] = [], observedEvents = new Map<number, ConsoleEvent>();
  const reader = streamResponse.body!.getReader();
  const streamRead = (async () => {
    let pending = ''; const decoder = new TextDecoder();
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) return;
      pending += decoder.decode(chunk.value, { stream: true }); let end: number;
      while ((end = pending.indexOf('\n\n')) >= 0) {
        const block = pending.slice(0, end); pending = pending.slice(end + 2);
        if (!/^event: conversation$/mu.test(block)) continue;
        const data = /^data: (.*)$/mu.exec(block)?.[1]; if (!data) continue;
        const update = JSON.parse(data) as ConversationUpdate; updates.push(update);
        for (const event of update.view?.items ?? []) observedEvents.set(event.seq, event);
      }
    }
  })().catch(error => { if (!streamAbort.signal.aborted) f.failures.push(error); });
  t.after(async () => { streamAbort.abort(); await streamRead; });
  const thoughts = () => [...observedEvents.values()].filter(event => event.type === 'thinking.updated').sort((a, b) => a.seq - b.seq);
  f.send('managed-first');
  try {
    await f.waitFor(() => thoughts().some(event => event.payload.status === 'in_progress'), '受管 Pi 思考应在模型完成前经独立事件上传和 SSE 可见');
    assert.equal(firstResponseCompleted, false); assert.equal(f.outgoing.length, 0); assert.equal(f.calls.length, 1);
    assert.ok(eventUploadTypes.includes('thinking.updated')); assert.deepEqual(heartbeatEventTypes, []);
    assert.equal(f.calls[0]!.body.reasoning?.effort, 'low');
    assert.match(String(thoughts()[0]!.payload.text), /Visible managed step/u);
  } finally { releaseThinking(); }
  await f.waitFor(() => f.outgoing.length === 1 && f.calls.length === 2, '真实 Pi 应从受管 Worker 发送回复');
  await f.waitFor(() => thoughts().at(-1)?.payload.status === 'completed', '最终思考应经 SSE 标记完成');
  assert.ok(thoughts().length >= 2);
  assert.ok(thoughts().every(event => Boolean(event.runId) && Boolean(event.itemId)));
  assert.equal(new Set(thoughts().map(event => event.runId)).size, 1); assert.equal(new Set(thoughts().map(event => event.itemId)).size, 1);
  assert.match(String(thoughts().at(-1)!.payload.text), /Visible managed step.*\n\nSecond visible managed step\./u);
  assert.match(String(thoughts().at(-1)!.payload.text), /redacted/iu);
  const publicEvents = JSON.stringify(updates);
  for (const secret of ['managed-private-model-key', 'managed-private-napcat-key', workerToken, 'opaque-managed-signature-never-publish', 'encrypted_content', 'thinkingSignature']) assert.equal(publicEvents.includes(secret), false);
  const inspectData = async () => {
    const code = `import {DatabaseSync} from 'node:sqlite';import {existsSync,readFileSync} from 'node:fs';const db=new DatabaseSync('/data/bridge.sqlite3',{readOnly:true});const state=db.prepare('SELECT session_id,cursor FROM instance_state WHERE id=1').get();const count=db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;const pending=db.prepare('SELECT COUNT(*) AS n FROM pending_batch').get().n;db.close();console.log(JSON.stringify({state,count,pending,sessionExists:existsSync(state.session_id),marker:existsSync('/data/workspace/e2e-marker.txt')?readFileSync('/data/workspace/e2e-marker.txt','utf8'):null}));`;
    const result = await run('docker', ['exec', docker.name(bot.id), 'node', '--input-type=module', '-e', code], { timeout: 15_000, maxBuffer: 64 * 1024 });
    return JSON.parse(result.stdout) as { state: { session_id: string; cursor: number }; count: number; pending: number; sessionExists: boolean; marker: string | null };
  };
  await until(async () => (await inspectData()).state.cursor === 1, 'first batch committed');
  const initial = await inspectData(); assert.match(initial.state.session_id, /^\/data\/pi\/sessions\/.+\.jsonl$/); assert.equal(initial.sessionExists, true); assert.equal(initial.count, 1);
  const marker = `e2e-workspace-${randomUUID()}`;
  await run('docker', ['exec', docker.name(bot.id), 'node', '--input-type=module', '-e', `import{writeFileSync}from'node:fs';writeFileSync('/data/workspace/e2e-marker.txt',${JSON.stringify(marker)});`], { timeout: 15_000, maxBuffer: 64 * 1024 });
  await api(`/api/bots/${bot.id}`, 'PUT', { expectedRevision: 1, config: { persona: 'Updated isolated persona' } });
  await until(async () => consoleApp.db.getPublicBot(bot.id)!.appliedRevision === 2 && consoleApp.db.getPublicBot(bot.id)!.connected, 'revision 2 applied');
  assert.equal((await docker.inspect(bot.id))!.Id, first.Id, 'configuration reload should replace runtime, not container');
  f.send('managed-second');
  await f.waitFor(() => f.outgoing.length === 2 && f.calls.length === 4, '新配置使用同一真实会话');
  await until(async () => (await inspectData()).state.cursor === 2, 'second batch committed');
  const second = await inspectData(); assert.equal(second.state.session_id, initial.state.session_id); assert.equal(second.marker, marker); assert.equal(second.count, 2);
  const secondCall = f.calls.filter(call => !call.results.length)[1]!;
  assert.match(JSON.stringify(secondCall.body), /Updated isolated persona/); assert.match(JSON.stringify(secondCall.body), /managed-reply-1/);
  await until(async () => consoleApp.db.getConversation(bot.id)?.agentSessionId === initial.state.session_id, 'Pi session projected to console');
  await api(`/api/bots/${bot.id}/restart`, 'POST', {});
  await until(async () => { const current = await docker.inspect(bot.id), value = consoleApp.db.getPublicBot(bot.id)!; return current !== null && current.Id !== first.Id && current.State.Running && value.connected && value.appliedRevision === 2 && consoleApp.lifecycle.operation(bot.id) === null; }, 'replacement worker online', 40_000);
  assert.deepEqual(await inspectData(), second, 'volume, real session, cursor and workspace survive replacement');
  f.send('managed-third'); await f.waitFor(() => f.outgoing.length === 3 && f.calls.length === 6, '替换容器之后继续同一个 Pi 会话');
  await until(async () => (await inspectData()).state.cursor === 3, 'third batch committed');
  assert.equal((await inspectData()).state.session_id, initial.state.session_id); assert.equal(round, 3); assert.ok(f.connections >= 3);
  assert.ok(f.calls.every(call => call.authorization === 'Bearer managed-private-model-key'));
  await api(`/api/bots/${bot.id}/stop`, 'POST', {});
  await until(async () => !(await docker.inspect(bot.id))!.State.Running && consoleApp.db.getPublicBot(bot.id)!.state === 'stopped', 'worker safely stopped');
});
