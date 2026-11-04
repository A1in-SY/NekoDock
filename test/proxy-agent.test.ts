import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { defaultNetworkProxy, type NetworkProxyConfig } from '../src/network.js';
import { PiRunner, type PiRunnerOptions } from '../src/pi.js';
import { runTaskScript } from '../src/task-script.js';
import type { ScheduledInput, ScheduledTask } from '../src/scheduled-contract.js';
import type { PendingBatch, ReplyToolRequest, RunObservation } from '../src/types.js';
import { assertAccepted, decodeModelCall, respond, type ModelCall } from './fixtures/pi-e2e.js';

function batch(text = 'Synthetic current question', replyAllowed = true): PendingBatch {
  return { throughSeq: 1, messages: [{seq: 1, messageId: 'message-example', senderId: '10001', senderName: 'Example',
    time: 123, text, replyTo: null, trigger: replyAllowed, rawJson: '{}'}], replyAllowed, replies: null, nextReplyIndex: 0 };
}

function invocation(): ScheduledInput {
  const now = new Date().toISOString();
  return {kind: 'scheduled_task', task: {id: 'task-example', name: 'Scheduled example', instructions: 'Send one synthetic greeting.'},
    context: {}, invocation: {runId: randomUUID(), scheduledAt: now, startedAt: now, timezone: 'Asia/Shanghai'}};
}

/** Uses a real OpenAI event stream, with deliberately large usage to exercise threshold summaries. */
function replyWithUsage(call: ModelCall, response: ServerResponse, inputTokens = 100): void {
  if (call.path.endsWith('/responses') || inputTokens === 100) { respond(call, response, 'Internal completion.'); return; }
  response.writeHead(200, {'content-type': 'text/event-stream'});
  const emit = (choices: unknown[], usage?: unknown) => response.write(`data: ${JSON.stringify({id: randomUUID(), object: 'chat.completion.chunk', created: 123, model: call.body.model, choices, ...(usage ? {usage} : {})})}\n\n`);
  emit([{index: 0, delta: {role: 'assistant', content: 'Internal completion.'}, finish_reason: null}]);
  emit([{index: 0, delta: {}, finish_reason: 'stop'}], {prompt_tokens: inputTokens, completion_tokens: 10, prompt_tokens_details: {cached_tokens: 0}});
  response.end('data: [DONE]\n\n');
}

interface Received {call: ModelCall; proxy: string | null}
type ModelHandler = (call: ModelCall, response: ServerResponse, count: number) => void;

async function fixture(t: TestContext, handler?: ModelHandler) {
  const directory = await mkdtemp(join(tmpdir(), 'nekodock-proxy-agent-'));
  const sockets = new Set<Socket>(); const servers: Server[] = [];
  const received: Received[] = []; const proxyRequests: Array<{proxy: string; url: string; authorization?: string}> = [];
  const failures: unknown[] = [];
  const serve = async (handle: (request: IncomingMessage, response: ServerResponse) => void) => {
    const server = createServer(handle); servers.push(server);
    server.on('connection', socket => {sockets.add(socket); socket.on('close', () => sockets.delete(socket));});
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    return {server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`};
  };
  const model = await serve((request, response) => {void (async () => {
    let raw = ''; for await (const chunk of request) raw += String(chunk);
    const call = decodeModelCall(request.url ?? '', request.headers.authorization, JSON.parse(raw));
    const proxy = typeof request.headers['x-fixture-proxy'] === 'string' ? request.headers['x-fixture-proxy'] : null;
    assert.equal(request.headers['proxy-authorization'], undefined, 'Proxy credentials must not reach a model endpoint');
    received.push({call, proxy});
    const count = received.filter(item => item.call.path === call.path).length;
    if (handler) handler(call, response, count);
    else if (call.results.length) {assertAccepted(call); respond(call, response, 'Internal completion.');}
    else respond(call, response, [{name: 'send_message', arguments: {messages: [{type: 'text', text: 'Synthetic answer.'}]}}]);
  })().catch(error => {failures.push(error); if (!response.headersSent) response.writeHead(500); response.end('{}');});});
  const proxy = async (name: string, reject = false) => {
    const endpoint = await serve((request, response) => {
      proxyRequests.push({proxy: name, url: request.url ?? '', authorization: request.headers['proxy-authorization']});
      if (reject) {response.writeHead(407, {'proxy-authenticate': 'Basic realm="isolated-test"'}); response.end('Synthetic proxy denial.'); return;}
      const url = new URL(request.url!);
      assert.equal(url.origin, model.url, 'The fixture proxy only forwards to its isolated model endpoint');
      const headers = {...request.headers, 'x-fixture-proxy': name}; delete headers['proxy-authorization'];
      const forward = httpRequest(url, {method: request.method, headers}, upstream => {response.writeHead(upstream.statusCode ?? 502, upstream.headers); upstream.pipe(response);});
      forward.on('error', error => {failures.push(error); response.destroy();}); request.pipe(forward);
    });
    // Node's native environment proxy uses CONNECT, including for plain HTTP destinations.
    endpoint.server.on('connect', (request, socket, head) => {
      proxyRequests.push({proxy: name, url: request.url ?? '', authorization: request.headers['proxy-authorization']});
      if (reject) {socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n'); return;}
      assert.equal(request.url, new URL(model.url).host);
      const target = new URL(model.url); const upstream = connect(Number(target.port), '127.0.0.1');
      sockets.add(upstream); upstream.once('close', () => sockets.delete(upstream));
      upstream.once('connect', () => {socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket);});
      upstream.once('error', () => socket.destroy()); socket.once('error', () => upstream.destroy()); socket.once('close', () => upstream.destroy());
    });
    return endpoint.url;
  };
  const runner = async (name: string, networkProxy: NetworkProxyConfig, extra: Partial<PiRunnerOptions> = {}) => {
    const home = join(directory, name, 'pi'); const workspace = join(directory, name, 'workspace');
    await mkdir(home, {recursive: true}); await mkdir(workspace, {recursive: true});
    const logs: string[] = []; const events: RunObservation[] = []; const sends: ReplyToolRequest[] = [];
    const options: PiRunnerOptions = {home, workspace, timeoutMs: 15_000,
      logger: {info: text => logs.push(text), warn: text => logs.push(text), error: text => logs.push(text)},
      model: `synthetic-${name}`, baseUrl: `${model.url}/${name}/v1`, api: 'openai-completions', apiKey: 'synthetic-model-key',
      reasoning: 'off', contextWindow: 200_000, compactLimit: 160_000, maxOutputTokens: 8192,
      supportsImages: false, supportsReasoning: false, allowCommands: false, allowFileWrites: false,
      persona: 'An isolated fixture persona.', targetType: 'group', networkProxy, webSearch: {provider: 'none'}, ...extra};
    const agent = new PiRunner(options); let session: string | null = null;
    return {agent, options, home, workspace, logs, events, sends, get session() {return session;},
      run: (input = batch()) => agent.run(input, session, path => {session = path;}, new AbortController().signal,
        {send: async request => {sends.push(request); return {accepted: true};}}, event => events.push(event))};
  };
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    await rm(directory, {recursive: true, force: true}); assert.deepEqual(failures, []);
  });
  return {directory, model, received, proxyRequests, proxy, runner};
}

function proxied(url: string, overrides: Partial<NetworkProxyConfig> = {}): NetworkProxyConfig {
  return {...defaultNetworkProxy(), enabled: true, url, noProxy: '', ...overrides};
}

test('real Pi SDK routes the first and post-acceptance model requests through the instance proxy in both APIs', {timeout: 30_000}, async t => {
  for (const api of ['openai-responses', 'openai-completions'] as const) await t.test(api, async t => {
    const f = await fixture(t); const proxy = await f.proxy('selected');
    const r = await f.runner('ordinary', proxied(proxy, {username: 'synthetic-user', password: 'synthetic-password'}), {api});
    await r.run();
    assert.equal(r.sends.length, 1); assert.equal(f.received.length, 2); assert.equal(f.proxyRequests.length, 2);
    assert.ok(f.received.every(item => item.proxy === 'selected')); assertAccepted(f.received[1]!.call);
    assert.ok(f.proxyRequests.every(item => item.authorization === `Basic ${Buffer.from('synthetic-user:synthetic-password').toString('base64')}`));
    assert.doesNotMatch(r.logs.join('\n'), /synthetic-password|synthetic-user/);
  });
});

test('real Pi SDK threshold and manual compaction use the same instance proxy', {timeout: 30_000}, async t => {
  const f = await fixture(t, (call, response) => {
    if (!call.body.tools?.length) respond(call, response, '## Recent relevant topics\nSynthetic context.\n## People and references\nSynthetic participant.\n## Current facts and corrections\nNone.\n## Explicitly unfinished work\nNone.\n## Useful results and artifacts\nFixture reply accepted; do not repeat.');
    else if (!call.results.length) respond(call, response, [{name: 'send_message', arguments: {messages: [{type: 'text', text: 'Synthetic answer.'}]}}]);
    else replyWithUsage(call, response, 8500);
  });
  const proxy = await f.proxy('summary');
  const r = await f.runner('compact', proxied(proxy), {contextWindow: 12_000, compactLimit: 8000, maxOutputTokens: 1000});
  await r.run(batch('Earlier synthetic context '.repeat(3000), false));
  await r.run(batch('Additional synthetic context '.repeat(3000), false));
  await r.run();
  assert.ok(r.events.some(event => event.type === 'compact.started' && event.payload.reason === 'threshold'));
  assert.ok(r.events.some(event => event.type === 'compact.completed'));
  const beforeManual = f.received.length; assert.ok(r.session);
  await r.run(batch('Recent synthetic context '.repeat(3000), false));
  const events: RunObservation[] = [];
  await r.agent.compact(r.session!, new AbortController().signal, event => events.push(event));
  assert.ok(f.received.length > beforeManual); assert.ok(events.some(event => event.type === 'usage.recorded'));
  assert.ok(f.received.some(item => !item.call.body.tools?.length));
  assert.equal(f.proxyRequests.length, f.received.length); assert.ok(f.received.every(item => item.proxy === 'summary'));
  assert.match(await readFile(r.session!, 'utf8'), /"type":"compaction"/);
});

test('scheduled model invocations use the instance proxy and keep their own fresh sessions in both APIs', {timeout: 30_000}, async t => {
  for (const api of ['openai-responses', 'openai-completions'] as const) await t.test(api, async t => {
    const f = await fixture(t); const proxy = await f.proxy('scheduled'); const r = await f.runner('schedule', proxied(proxy), {api});
    let accepted = 0;
    const first = invocation(); const second = invocation();
    const tools = {send: async () => {accepted++; return {accepted: true as const};}, saveState: async () => {throw new Error('State was not requested.');}};
    await r.agent.runScheduled(first, tools, new AbortController().signal);
    await r.agent.runScheduled(second, tools, new AbortController().signal);
    assert.equal(accepted, 2); assert.equal(f.received.length, 4); assert.equal(f.proxyRequests.length, 4);
    assert.ok(f.received.every(item => item.proxy === 'scheduled'));
    assert.match(JSON.stringify(f.received[0]!.call.body), /scheduled_task/);
    assert.ok(JSON.stringify(f.received[0]!.call.body).includes(first.invocation.runId));
    assert.ok(JSON.stringify(f.received[2]!.call.body).includes(second.invocation.runId));
    assert.ok(!JSON.stringify(f.received[2]!.call.body).includes(first.invocation.runId), 'Each scheduled run starts with a fresh model session');
  });
});

test('two proxied Pi instances and one direct instance retain independent routes when run concurrently', {timeout: 20_000}, async t => {
  const f = await fixture(t); const oneProxy = await f.proxy('one'); const twoProxy = await f.proxy('two');
  const one = await f.runner('one', proxied(oneProxy)); const two = await f.runner('two', proxied(twoProxy)); const direct = await f.runner('direct', defaultNetworkProxy());
  await Promise.all([one.run(), two.run(), direct.run()]);
  for (const [name, route] of [['one', 'one'], ['two', 'two'], ['direct', null]] as const) {
    const calls = f.received.filter(item => item.call.path.startsWith(`/${name}/`));
    assert.equal(calls.length, 2); assert.ok(calls.every(item => item.proxy === route));
  }
  assert.equal(f.proxyRequests.filter(item => item.proxy === 'one').length, 2);
  assert.equal(f.proxyRequests.filter(item => item.proxy === 'two').length, 2);
});

test('a rejected proxy never causes Pi SDK to retry directly against a reachable model', {timeout: 20_000}, async t => {
  const f = await fixture(t); const rejected = await f.proxy('denied', true); const r = await f.runner('denied', proxied(rejected));
  await assert.rejects(r.run(), /PI_EXECUTION_FAILED/);
  assert.equal(f.received.length, 0); assert.equal(r.sends.length, 0); assert.equal(f.proxyRequests.length, 1);
});

function scriptTask(source: string): ScheduledTask {
  return {id: 'script-example', botId: 'bot-example', name: 'Script example', kind: 'script', enabled: true,
    schedule: {kind: 'cron', expression: '* * * * *', timezone: 'Asia/Shanghai'}, instructions: '', script: {runtime: 'node', source},
    context: {taskState: false}, maxDelaySeconds: 600, timeoutSeconds: 10, notifyOnFailure: false,
    revision: 1, creatorId: '10001', createdAt: 1, updatedAt: 1, deletedAt: null};
}

test('saved Node scripts perform real fetch through their instance proxy and omit proxy environment when inheritance is off', {timeout: 25_000}, async t => {
  const f = await fixture(t, (_call, response) => {response.end('synthetic-response');});
  const proxy = await f.proxy('script'); const sent: ReplyToolRequest[] = [];
  for (const forTools of [true, false]) {
    const source = `import {sendMessage} from './nekodock_tasks.mjs';
const expected = ${JSON.stringify(forTools)};
if(Boolean(process.env.HTTP_PROXY)!==expected || Boolean(process.env.NODE_USE_ENV_PROXY)!==expected)throw new Error('Proxy inheritance mismatch');
if(process.env.AGENT_API_KEY || process.env.WORKER_TOKEN)throw new Error('Service credential leaked');
await fetch(${JSON.stringify(`${f.model.url}/script/v1`)}, {method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(response=>response.text());
sendMessage({messages:[{type:'text',text:'Synthetic script complete.'}]});`;
    const before = f.proxyRequests.length;
    await runTaskScript({task: scriptTask(source), input: invocation(), workspace: f.directory, networkProxy: proxied(proxy, {forTools}),
      signal: new AbortController().signal, tools: {send: async request => {sent.push(request); return {accepted: true};}, saveState: async () => {throw new Error('Unexpected state');}}});
    assert.equal(f.proxyRequests.length > before, forTools);
  }
  assert.equal(sent.length, 2); assert.equal(f.received.length, 2);
});

test('Pi Bash tools inherit the selected proxy only when enabled for tools', {timeout: 30_000}, async t => {
  for (const forTools of [true, false]) await t.test(String(forTools), async t => {
    let source = '';
    const f = await fixture(t, (call, response, count) => {
      if (count === 1) respond(call, response, [{name: 'bash', arguments: {command: `node --input-type=module -e '${source.replaceAll("'", "'\\''")}'`}}]);
      else if (count === 2) respond(call, response, [{name: 'send_message', arguments: {messages: [{type: 'text', text: 'Synthetic tool complete.'}]}}]);
      else respond(call, response, 'Internal completion.');
    });
    const proxy = await f.proxy('tool');
    source = `import {writeFile} from "node:fs/promises";if(Boolean(process.env.HTTP_PROXY)!==${forTools}||Boolean(process.env.NODE_USE_ENV_PROXY)!==${forTools})throw new Error("Wrong tool proxy");const response=await fetch(${JSON.stringify(`${f.model.url}/tool-result/v1`)},{method:"POST",headers:{"content-type":"application/json"},body:"{}"});await response.text();await writeFile("proxy-tool-completed","ok");`;
    // The tool endpoint serves ordinary text; model endpoints use genuine OpenAI SSE.
    const original = f.model.server.listeners('request')[0]!;
    f.model.server.removeAllListeners('request');
    f.model.server.on('request', (request, response) => {if (request.url === '/tool-result/v1') {request.resume(); response.end('ok');} else original.call(f.model.server, request, response);});
    const r = await f.runner('tools', proxied(proxy, {forTools}), {allowCommands: true}); await r.run();
    assert.equal(await readFile(join(r.workspace, 'proxy-tool-completed'), 'utf8'), 'ok');
    assert.equal(r.sends.length, 1); assert.equal(f.received.length, 3);
    assert.equal(f.proxyRequests.length, forTools ? 4 : 3);
    assert.ok(r.events.some(event => event.type === 'tool.completed' && event.payload.tool === 'bash' && event.payload.status === 'completed'));
  });
});
