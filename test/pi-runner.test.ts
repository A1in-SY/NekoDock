import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { PiRunner, piEnvironment, piFailure, validatePiSession, type PiRunnerOptions } from '../src/pi.js';
import { createPiTools, shellEnvironment, workspacePath } from '../src/pi-tools.js';
import type { PendingBatch, ReplyToolRequest, RunObservation } from '../src/types.js';
import { decodeModelCall, respond } from './fixtures/pi-e2e.js';

const batch = (text = 'hello', replyAllowed = true): PendingBatch => ({ throughSeq: 1, messages: [{ seq: 1, messageId: 'm1', senderId: '123', senderName: 'A', time: 123, text, replyTo: null, trigger: true, rawJson: '{}' }], replyAllowed, replies: null, nextReplyIndex: 0 });
type Request = Record<string, any>;
function completion(response: ServerResponse, content: string | Array<{ name: string; arguments: unknown }>, options: { finish?: string; tokens?: number; cached?: number } = {}) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const emit = (choices: unknown[], usage?: unknown) => response.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 123, model: 'test-model', choices, ...(usage ? { usage } : {}) })}\n\n`);
  emit([{ index: 0, delta: { role: 'assistant', ...(typeof content === 'string' ? { content } : { tool_calls: content.map((call, index) => ({ index, id: `call-${index}-${Date.now()}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) }) }, finish_reason: null }]);
  emit([{ index: 0, delta: {}, finish_reason: options.finish ?? (typeof content === 'string' ? 'stop' : 'tool_calls') }], { prompt_tokens: options.tokens ?? 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: options.cached ?? 40 } });
  response.end('data: [DONE]\n\n');
}

async function fixture(handler: (request: Request, response: ServerResponse, count: number) => void | Promise<void>, overrides: Partial<PiRunnerOptions> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-runner-')); const workspace = join(dir, 'workspace'); const home = join(dir, 'pi');
  await mkdir(workspace); await mkdir(home);
  const requests: Request[] = []; const logs: string[] = [];
  const server = createServer((request, response) => { void (async () => {
    let data = ''; for await (const chunk of request) data += String(chunk);
    const input = JSON.parse(data) as Request; requests.push(input); await handler(input, response, requests.length);
  })().catch(error => { response.writeHead(500); response.end(String(error)); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const options: PiRunnerOptions = { home, workspace, timeoutMs: 15_000, logger: { info: message => logs.push(message), warn: message => logs.push(message), error: message => logs.push(message) },
    model: 'test-model', baseUrl: `http://127.0.0.1:${address.port}/v1`, api: 'openai-completions', apiKey: 'test-secret-key', reasoning: 'off',
    contextWindow: 200_000, compactLimit: 160_000, maxOutputTokens: 10_000, supportsImages: true, supportsReasoning: false,
    allowCommands: false, allowFileWrites: false, persona: 'You are Test Persona.', targetType: 'group', webSearch: { provider: 'none' }, ...overrides };
  const calls: ReplyToolRequest[] = []; const events: RunObservation[] = []; let session: string | null = null;
  const runner = new PiRunner(options);
  return { dir, workspace, home, options, requests, logs, calls, events, runner, get session() { return session; },
    run: (input = batch(), signal = new AbortController().signal) => runner.run(input, session, id => { session = id; }, signal,
      { send: async request => { assert.ok(session, 'Persist the session reference before accepting the first reply'); await access(session); calls.push(request); return { accepted: true }; } }, event => events.push(event)),
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); } };
}

test('Pi SDK persists a new session, executes accepted replies before final, resumes without replay and reports usage', async () => {
  const f = await fixture((_input, response, count) => completion(response, count % 2 ? [{ name: 'send_message', arguments: { messages: [{ type: 'text', text: 'hello A' }, { type: 'text', text: 'hello B' }] } }] : 'Internal completion.'));
  try {
    assert.deepEqual(await f.run(), { messages: [] });
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0]!.messages.length, 2);
    assert.ok(f.session); await validatePiSession(f.home, f.session!);
    assert.ok(f.events.some(event => event.type === 'tool.started')); assert.ok(f.events.some(event => event.type === 'tool.completed'));
    const usage = f.events.filter(event => event.type === 'usage.recorded');
    assert.equal(usage.length, 2); assert.equal(usage[0]!.payload.input_tokens, 100); assert.equal(usage[0]!.payload.cached_input_tokens, 40);
    assert.equal(new Set(usage.map(event => event.payload.usageId)).size, 2);
    assert.equal(f.requests.length, 2);
    assert.match(JSON.stringify(f.requests[0]!.messages), /You are Test Persona/);
    const names = f.requests[0]!.tools.map((tool: any) => tool.function.name);
    assert.ok(names.includes('send_message')); assert.ok(names.includes('read')); assert.ok(!names.includes('bash')); assert.ok(!names.includes('write'));
    await f.run(batch('second')); assert.equal(f.calls.length, 2); assert.equal(f.requests.length, 4);
    assert.match(JSON.stringify(f.requests[2]!.messages), /hello A/);
    assert.ok(!f.logs.join('\n').includes('test-secret-key'));
    const stored = await readFile(f.session!, 'utf8'); assert.match(stored, /"role":"user"/); assert.match(stored, /"toolName":"send_message"/);
  } finally { await f.close(); }
});

test('Pi append-only batches persist context without model requests or tools', async () => {
  const f = await fixture((_input, response) => completion(response, 'should not happen'));
  try {
    await f.run(batch('background', false)); assert.equal(f.requests.length, 0); assert.equal(f.calls.length, 0); assert.ok(f.session);
    const stored = await readFile(f.session!, 'utf8'); assert.match(stored, /background/); assert.ok(!stored.includes('"role":"assistant"'));
  } finally { await f.close(); }
});

test('Pi final text alone never sends QQ and fails the required-reply turn', async () => {
  const f = await fixture((_input, response) => completion(response, 'This is final text.'));
  try { await assert.rejects(f.run(), /PI_NO_REPLY/); assert.equal(f.calls.length, 0); assert.equal(f.requests.length, 1); }
  finally { await f.close(); }
});

test('Pi does not retry HTTP errors or output length stops', async t => {
  for (const failure of ['http', 'length', 'overflow']) await t.test(failure, async () => {
    const f = await fixture((_input, response) => {
      if (failure === 'length') completion(response, 'too long', { finish: 'length' });
      else { response.writeHead(failure === 'overflow' ? 400 : 503, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: failure === 'overflow' ? 'maximum context length exceeded' : 'temporarily unavailable', type: 'server_error' } })); }
    });
    try { await assert.rejects(f.run(), /PI_EXECUTION_FAILED/); assert.equal(f.requests.length, 1); assert.equal(f.calls.length, 0); }
    finally { await f.close(); }
  });
});

test('Pi timeout and external cancellation end the child without leaving a model retry', async t => {
  for (const reason of ['timeout', 'cancel']) await t.test(reason, async () => {
    const f = await fixture((_input, response) => { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(': waiting\n\n'); }, { timeoutMs: reason === 'timeout' ? 800 : 15_000 });
    const abort = new AbortController(); const timer = reason === 'cancel' ? setTimeout(() => abort.abort(), 800) : undefined;
    try { await assert.rejects(f.run(batch(), abort.signal), reason === 'timeout' ? /PI_TIMEOUT/ : /PI_ABORTED/); assert.ok(f.requests.length <= 1); }
    finally { clearTimeout(timer); await f.close(); }
  });
});

test('Pi tool file permissions reject lexical and symlink escapes; write switches remove mutation tools', async () => {
  const f = await fixture((_input, response) => completion(response, 'unused'));
  try {
    await writeFile(join(f.workspace, 'inside'), 'inside'); await writeFile(join(f.dir, 'outside'), 'outside');
    await symlink(f.dir, join(f.workspace, 'escape'));
    await assert.rejects(workspacePath(f.workspace, '../outside'), /outside/);
    await assert.rejects(workspacePath(f.workspace, 'escape/outside'), /outside/);
    await assert.rejects(workspacePath(f.workspace, 'escape/new-file', true), /outside/);
    const tools = createPiTools(f.options, async () => {}); assert.deepEqual(tools.map(tool => tool.name), ['read', 'send_message']);
    const writeTools = createPiTools({ ...f.options, allowFileWrites: true }, async () => {});
    const write = writeTools.find(tool => tool.name === 'write')!;
    await assert.rejects(write.execute('id', { path: 'escape/new', content: 'x' }, undefined, undefined, {} as any), /outside/);
    await write.execute('id', { path: 'nested/new', content: 'new' }, undefined, undefined, {} as any);
    assert.equal(await readFile(join(f.workspace, 'nested/new'), 'utf8'), 'new');
  } finally { await f.close(); }
});

test('Pi child and terminal environments never inherit model/console credentials', () => {
  const source = { PATH: '/bin', HOME: '/home/node', MODEL_API_KEY: 'secret', CODEX_API_KEY: 'secret', CONSOLE_MASTER_KEY: 'secret', NAPCAT_TOKEN: 'secret', NODE_OPTIONS: '--import=evil' };
  assert.deepEqual(shellEnvironment(source), { PATH: '/bin', HOME: '/home/node' });
  assert.deepEqual(piEnvironment(source), { PATH: '/bin', HOME: '/home/node', PI_SKIP_VERSION_CHECK: '1' });
});

test('Pi SDK keeps normal threshold compaction and manual compact adds no user message', async () => {
  const f = await fixture((input, response, count) => {
    if (!input.tools?.length) completion(response, '## Goal\nRemember earlier context.\n## Progress\nReply accepted.');
    else completion(response, count === 1 ? [{ name: 'send_message', arguments: { messages: [{ type: 'text', text: 'done' }] } }] : 'Internal completion.', { tokens: 8500 });
  }, { contextWindow: 12000, compactLimit: 8000, maxOutputTokens: 1000 });
  try {
    await f.run(batch('old context '.repeat(3000), false));
    await f.run(batch('more context '.repeat(3000), false));
    await f.run();
    assert.ok(f.events.some(event => event.type === 'compact.started' && event.payload.reason === 'threshold'));
    assert.ok(f.events.some(event => event.type === 'compact.completed'));
    assert.equal(f.calls.length, 1);
    assert.equal(f.events.filter(event => event.type === 'usage.recorded').length, 3, 'Include the summary request in usage');
    assert.match(await readFile(f.session!, 'utf8'), /"type":"compaction"/);
    const userCount = (await readFile(f.session!, 'utf8')).split('\n').filter(line => line.includes('"role":"user"')).length;
    await f.run(batch('recent context '.repeat(3000), false));
    const compactEvents: RunObservation[] = [];
    await f.runner.compact(f.session!, new AbortController().signal, event => compactEvents.push(event));
    assert.ok(compactEvents.some(event => event.type === 'usage.recorded'));
    assert.ok(compactEvents.some(event => event.type === 'context.updated'));
    const after = (await readFile(f.session!, 'utf8')).split('\n').filter(line => line.includes('"role":"user"')).length;
    assert.equal(after, userCount + 1); // Only the explicit background message was added.
  } finally { await f.close(); }
});

test('Pi overflow and length recovery are cancelled even when enough history exists to compact', async t => {
  for (const failure of ['overflow', 'length']) await t.test(failure, async () => {
    const f = await fixture((_input, response) => {
      if (failure === 'length') completion(response, 'partial response', { finish: 'length', tokens: 3000 });
      else { response.writeHead(400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'maximum context length exceeded', type: 'invalid_request_error' } })); }
    }, { contextWindow: 12000, compactLimit: 8000, maxOutputTokens: 1000 });
    try {
      await f.run(batch('old context '.repeat(3000), false)); await f.run(batch('more context '.repeat(3000), false));
      await assert.rejects(f.run(), /PI_EXECUTION_FAILED/);
      assert.equal(f.requests.length, 1); assert.equal(f.calls.length, 0);
      assert.ok(!f.events.some(event => event.type === 'compact.completed'));
    } finally { await f.close(); }
  });
});

test('Pi SDK send acceptance is awaited before ending and later failures never repeat the accepted tool', async () => {
  const f = await fixture((_input, response, count) => {
    if (count === 1) completion(response, [{ name: 'send_message', arguments: { messages: [{ type: 'text', text: 'accepted milestone' }] } }]);
    else { response.writeHead(503, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'failure after accepted' } })); }
  });
  try {
    let committed = false; let count = 0;
    await assert.rejects(f.runner.run(batch(), null, () => {}, new AbortController().signal, { send: async () => {
      count++; await new Promise(resolve => setTimeout(resolve, 100)); committed = true; return { accepted: true };
    } }), /PI_EXECUTION_FAILED/);
    assert.equal(committed, true); assert.equal(count, 1); assert.equal(f.requests.length, 2);
  } finally { await f.close(); }
});

test('Pi SDK passes incoming images only when model vision is enabled', async t => {
  for (const supportsImages of [true, false]) await t.test(String(supportsImages), async () => {
    const f = await fixture((_input, response, count) => completion(response, count % 2 ? [{ name: 'send_message', arguments: { messages: [{ type: 'text', text: 'image received' }] } }] : 'done'), { supportsImages });
    try {
      const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
      const input = batch(); input.messages[0]!.rawJson = JSON.stringify({ message: [{ type: 'image', data: { file: `base64://${image}` } }] });
      await f.run(input);
      const user = f.requests[0]!.messages.find((message: any) => message.role === 'user');
      const imageCount = Array.isArray(user.content) ? user.content.filter((part: any) => part.type === 'image_url').length : 0;
      assert.equal(imageCount, supportsImages ? 1 : 0);
    } finally { await f.close(); }
  });
});

test('Pi SDK uses bash with filtered environment and a cancelled turn kills shell descendants', async () => {
  const f = await fixture((_input, response, count) => {
    completion(response, count === 1 ? [{ name: 'bash', arguments: { command: 'sleep 30 & echo $! > sleeper.pid; wait' } }] : 'done');
  }, { allowCommands: true, timeoutMs: 15_000 });
  try {
    const abort = new AbortController();
    const run = f.run(batch(), abort.signal); let pid: number | undefined;
    for (let i = 0; i < 100; i++) {
      try { pid = Number(await readFile(join(f.workspace, 'sleeper.pid'), 'utf8')); break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.ok(pid); abort.abort(); await assert.rejects(run, /PI_ABORTED/);
    for (let i = 0; i < 30; i++) {
      try { process.kill(pid, 0); } catch { pid = undefined; break; }
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.equal(pid, undefined, 'sleep process must be terminated with the cancelled Agent');
    assert.equal(f.requests.length, 1); assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('Pi custom resource loader ignores local AGENTS and extension config', async () => {
  const f = await fixture((_input, response, count) => completion(response, count % 2 ? [{ name: 'send_message', arguments: { messages: [{ type: 'text', text: 'done' }] } }] : 'done'));
  try {
    await writeFile(join(f.workspace, 'AGENTS.md'), 'UNAPPROVED_LOCAL_PERSONA');
    await mkdir(join(f.workspace, '.pi', 'extensions'), { recursive: true });
    await writeFile(join(f.workspace, '.pi', 'extensions', 'unapproved.js'), `import {writeFileSync} from 'node:fs'; writeFileSync('extension-was-loaded','bad'); export default function() {}`);
    await writeFile(join(f.home, 'settings.json'), JSON.stringify({ defaultModel: 'wrong-model', retry: { enabled: true }, extensions: [join(f.workspace, '.pi', 'extensions', 'unapproved.js')] }));
    await f.run(); assert.equal(f.requests[0]!.model, 'test-model');
    assert.ok(!JSON.stringify(f.requests).includes('UNAPPROVED_LOCAL_PERSONA'));
    await assert.rejects(access(join(f.workspace, 'extension-was-loaded')));
  } finally { await f.close(); }
});

test('Pi resume closes unfinished tool records without executing them or continuing the old turn', async () => {
  const f = await fixture((_input, response, count) => completion(response, count % 2 ? [{ name: 'send_message', arguments: { messages: [{ type: 'text', text: 'new reply' }] } }] : 'done'), { allowCommands: true });
  try {
    await f.run(batch('old input', false));
    const manager = SessionManager.open(f.session!, join(f.home, 'sessions'), f.workspace);
    manager.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: 'unfinished-old-tool', name: 'bash', arguments: { command: 'touch old-tool-replayed' } }],
      api: 'openai-completions', provider: 'bridge', model: 'test-model', stopReason: 'toolUse', timestamp: Date.now(),
      usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    await f.run(batch('new input'));
    await assert.rejects(access(join(f.workspace, 'old-tool-replayed')));
    assert.equal(f.requests.length, 2); assert.equal(f.calls.length, 1);
    const history = f.requests[0]!.messages;
    const closed = history.find((message: any) => message.role === 'tool' && message.tool_call_id === 'unfinished-old-tool');
    assert.ok(closed); assert.match(closed.content, /interrupted/);
    assert.ok(history.some((message: any) => message.role === 'user' && JSON.stringify(message.content).includes('new input')));
  } finally { await f.close(); }
});

test('Pi cancellation waits for an in-flight durable acceptance and does not start another model request', async () => {
  const f = await fixture((_input, response) => completion(response, [{ name: 'send_message', arguments: { messages: [{ type: 'text', text: 'accepted while cancelled' }] } }]));
  try {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void; const accepting = new Promise<void>(resolve => { entered = resolve; });
    let committed = false; let count = 0;
    const abort = new AbortController();
    const run = f.runner.run(batch(), null, () => {}, abort.signal, { send: async () => {
      count++; entered(); await gate; committed = true; return { accepted: true };
    } });
    await accepting; abort.abort(); release();
    await assert.rejects(run, /PI_ABORTED/);
    assert.equal(committed, true); assert.equal(count, 1); assert.equal(f.requests.length, 1);
  } finally { await f.close(); }
});

test('Pi refuses later sends in the same tool batch after the first acceptance fails', async () => {
  const f = await fixture((_input, response) => completion(response, [
    { name: 'send_message', arguments: { messages: [{ type: 'text', text: 'first' }] } },
    { name: 'send_message', arguments: { messages: [{ type: 'text', text: 'second' }] } },
  ]));
  try {
    let count = 0;
    await assert.rejects(f.runner.run(batch(), null, () => {}, new AbortController().signal, { send: async () => {
      count++; throw new Error('Storage unavailable.');
    } }), /PI_REPLY_ACCEPT_FAILED/);
    assert.equal(count, 1); assert.equal(f.requests.length, 1);
  } finally { await f.close(); }
});

test('Pi passes every configured reasoning effort without silent SDK clamping in both APIs', async t => {
  for (const api of ['openai-responses', 'openai-completions'] as const) await t.test(api, async () => {
    const f = await fixture((body, response, count) => {
      const call = decodeModelCall(api === 'openai-responses' ? '/v1/responses' : '/v1/chat/completions', undefined, body);
      respond(call, response, count % 2 ? [{ name: 'send_message', arguments: { messages: [{ type: 'text', text: 'done' }] } }] : 'done');
    }, { api, supportsReasoning: true });
    try {
      for (const reasoning of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
        f.options.reasoning = reasoning;
        await f.run(batch(`effort ${reasoning}`));
        for (const body of f.requests.slice(-2)) assert.equal(api === 'openai-responses' ? body.reasoning?.effort : body.reasoning_effort, reasoning);
      }
      f.options.supportsReasoning = false; f.options.reasoning = 'high'; await f.run(batch('no thinking'));
      assert.equal(f.requests.at(-2)!.reasoning, undefined); assert.equal(f.requests.at(-2)!.reasoning_effort, undefined);
    } finally { await f.close(); }
  });
});

test('Pi failure diagnostics redact keys, URLs and hosts and expose only bounded error metadata', async () => {
  const error = piFailure('PI_EXECUTION_FAILED', '503 service error at https://private.example/v1?token=secret-value host.docker.internal:18080/api key abc-private-key Bearer sensitive-header', ['abc-private-key']);
  assert.equal(error.code, 'PI_EXECUTION_FAILED'); assert.equal(error.providerStatus, 503);
  assert.ok(!/private\.example|secret-value|abc-private-key|host\.docker\.internal|sensitive-header/.test(error.message));
  assert.match(error.message, /\[url\]/); assert.match(error.message, /\[redacted\]/);
  assert.equal(piFailure('invalid provider prose', 'not an HTTP status 503', []).code, 'PI_EXECUTION_FAILED');
  assert.equal(piFailure('PI_EXECUTION_FAILED', 'not an HTTP status 503', []).providerStatus, undefined);
  const f = await fixture((_input, response) => { response.writeHead(503, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'temporary upstream https://private.example/v1 key=test-secret-key' } })); });
  try {
    await assert.rejects(f.run(), error => {
      assert.equal((error as { providerStatus?: number }).providerStatus, 503);
      assert.ok(!/private\.example|test-secret-key/.test((error as Error).message)); return true;
    });
  } finally { await f.close(); }
});

test('Pi threshold summary failure ends the turn without another generation or repeated compaction', async () => {
  const kinds: string[] = [];
  const f = await fixture((input, response) => {
    const summary = !input.tools?.length; kinds.push(summary ? 'summary' : 'agent');
    if (summary) { response.writeHead(503, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'summary unavailable' } })); }
    else completion(response, [{ name: 'send_message', arguments: { messages: [{ type: 'text', text: 'accepted' }] } }], { tokens: 8500 });
  }, { contextWindow: 12000, compactLimit: 8000, maxOutputTokens: 1000 });
  try {
    await f.run(batch('old context '.repeat(3000), false)); await f.run(batch('more context '.repeat(3000), false));
    await assert.rejects(f.run(), /PI_EXECUTION_FAILED/);
    assert.deepEqual(kinds, ['agent', 'summary']); assert.equal(f.calls.length, 1);
    assert.equal(f.events.filter(event => event.type === 'compact.failed').length, 1);
  } finally { await f.close(); }
});

test('Pi requires explicit model and base URL for generation and compact, while append-only context remains available', async t => {
  for (const missing of ['model', 'baseUrl'] as const) await t.test(missing, async () => {
    const f = await fixture((_input, response) => completion(response, 'must not call a provider'), { [missing]: '   ' });
    try {
      await f.run(batch('background', false)); assert.ok(f.session);
      const prior = await readFile(f.session!, 'utf8');
      const configurationError = (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'PI_CONFIGURATION_REQUIRED'); return true;
      };
      await assert.rejects(f.run(), configurationError);
      await assert.rejects(f.runner.compact(f.session!, new AbortController().signal), configurationError);
      assert.equal(f.requests.length, 0); assert.equal(f.calls.length, 0);
      assert.equal(await readFile(f.session!, 'utf8'), prior);
    } finally { await f.close(); }
  });
});


test('Pi publishes provider-visible thinking before completion, merges blocks, redacts credentials and keeps a stable item per message', async () => {
  let firstChunk!: () => void;
  const started = new Promise<void>(resolve => { firstChunk = resolve; });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(async (input, response, count) => {
    if (count > 1) { respond(decodeModelCall('/v1/responses',undefined,input),response,'done'); return; }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (type: string, payload: Record<string, unknown>) => response.write(`event: ${type}\ndata: ${JSON.stringify({type,...payload})}\n\n`);
    const output: unknown[] = [];
    emit('response.created', {response:{id:'resp_thinking',object:'response',status:'in_progress',output:[]}});
    for (let index=0;index<2;index++) {
      const text=index===0?'visible step with test-secret-key and napcat-private-key':'second visible block';
      const item={type:'reasoning',id:`rs_${index}`,summary:[{type:'summary_text',text}],encrypted_content:'opaque-signature-never-publish'};
      emit('response.output_item.added',{output_index:index,item:{type:'reasoning',id:item.id,summary:[]}});
      emit('response.reasoning_summary_text.delta',{output_index:index,item_id:item.id,summary_index:0,delta:text});
      if(index===0){firstChunk();await gate;}
      emit('response.output_item.done',{output_index:index,item});output.push(item);
    }
    const item={type:'function_call',id:'fc_thinking',call_id:'call_thinking',name:'send_message',arguments:JSON.stringify({messages:[{type:'text',text:'done'}]}),status:'completed'};
    emit('response.output_item.added',{output_index:2,item:{...item,arguments:''}});
    emit('response.function_call_arguments.delta',{output_index:2,item_id:item.id,delta:item.arguments});
    emit('response.output_item.done',{output_index:2,item});output.push(item);
    emit('response.completed',{response:{id:'resp_thinking',object:'response',status:'completed',model:input.model,output,
      usage:{input_tokens:100,output_tokens:10,total_tokens:110,input_tokens_details:{cached_tokens:40}}}});response.end();
  },{api:'openai-responses',supportsReasoning:true,reasoning:'low',presentationSecrets:['napcat-private-key']});
  try {
    const run=f.run();await started;
    for(let index=0;index<100&&!f.events.some(event=>event.type==='thinking.updated');index++)await new Promise(resolve=>setTimeout(resolve,10));
    const early=f.events.filter(event=>event.type==='thinking.updated');assert.ok(early.length>0);assert.equal(early[0]!.payload.status,'in_progress');
    assert.equal(f.calls.length,0);release();await run;
    const thoughts=f.events.filter(event=>event.type==='thinking.updated');assert.equal(new Set(thoughts.map(event=>event.itemId)).size,1);
    const final=thoughts.at(-1)!;assert.equal(final.payload.status,'completed');assert.match(String(final.payload.text),/visible step.*\[redacted\].*\[redacted\]\n\nsecond visible block/);
    assert.doesNotMatch(JSON.stringify(thoughts),/test-secret-key|napcat-private-key|thinkingSignature|encrypted_content|opaque-signature/);
    assert.doesNotMatch(f.logs.join('\n'),/visible step|second visible block/);
  }finally{release();await f.close();}
});

test('Pi cancellation retains visible partial thinking and marks it failed',async()=>{
 let entered!:()=>void;const streaming=new Promise<void>(resolve=>{entered=resolve;});
 const f=await fixture((_input,response)=>{
   response.writeHead(200,{'content-type':'text/event-stream'});
   response.write(`data: ${JSON.stringify({id:'partial',object:'chat.completion.chunk',created:123,model:'test-model',choices:[{index:0,delta:{role:'assistant',reasoning_content:'visible unfinished thought'},finish_reason:null}]})}\n\n`);entered();
 },{supportsReasoning:true,reasoning:'low'});
 const abort=new AbortController();
 try {
   const run=f.run(batch(),abort.signal);const rejected=assert.rejects(run,/PI_ABORTED/);await streaming;
   for(let index=0;index<100&&!f.events.some(event=>event.type==='thinking.updated');index++)await new Promise(resolve=>setTimeout(resolve,10));
   assert.ok(f.events.some(event=>event.type==='thinking.updated'));abort.abort();await rejected;
   const thoughts=f.events.filter(event=>event.type==='thinking.updated');assert.equal(thoughts.at(-1)!.payload.text,'visible unfinished thought');
   assert.equal(thoughts.at(-1)!.payload.status,'failed');assert.equal(new Set(thoughts.map(event=>event.itemId)).size,1);
 }finally{abort.abort();await f.close();}
});
