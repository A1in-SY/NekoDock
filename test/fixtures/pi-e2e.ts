import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';

export const dockerImage = process.env.BRIDGE_E2E_IMAGE;
export const bindHost = dockerImage ? '0.0.0.0' : '127.0.0.1';
export const requestHost = dockerImage ? 'host.docker.internal' : '127.0.0.1';
export const busyReply = '我正在想上面的消息怎么回，你等会哦';
export const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
export interface InputMessage { messageId: string; senderId: string; text: string; images?: Array<{ path: string }>; [key: string]: unknown }
export interface ModelCall {
  path: string; authorization?: string; body: Record<string, any>; batch: InputMessage[];
  /** All tool responses after the latest user input, in provider wire format. */
  results: Array<Record<string, any>>; images: string[];
}
export interface Segment { type: string; data: { text?: string; file?: string; qq?: string } }
export interface Outgoing { action: string; params: { group_id?: string; user_id?: string; message: Segment[] }; echo: string; connection: number }
export interface RunningBridge {
  child: ChildProcessWithoutNullStreams; closed: boolean; code: number | null;
  done: Promise<void>; name?: string; logs: string[];
}
export type ModelHandler = (call: ModelCall, response: ServerResponse, index: number) => void | Promise<void>;

function messageText(item: Record<string, any>): string {
  if (typeof item.content === 'string') return item.content;
  return (item.content ?? []).filter((part: any) => ['text', 'input_text', 'output_text'].includes(part.type)).map((part: any) => part.text ?? '').join('');
}
export function decodeModelCall(path: string, authorization: string | undefined, body: Record<string, any>): ModelCall {
  const items: Array<Record<string, any>> = body.input ?? body.messages ?? [];
  const userIndex = items.findLastIndex(item => item.role === 'user');
  const user = items[userIndex]; let batch: InputMessage[] = [];
  try { const parsed = JSON.parse(user ? messageText(user) : 'null'); if (Array.isArray(parsed)) batch = parsed; } catch {}
  const images = (user?.content && Array.isArray(user.content) ? user.content : [])
    .map((part: any) => part.image_url?.url ?? part.image_url ?? '').filter((url: unknown): url is string => typeof url === 'string' && url.startsWith('data:'));
  return { path, authorization, body, batch, images,
    results: items.slice(userIndex + 1).filter(item => item.type === 'function_call_output' || item.role === 'tool') };
}

/** Emit genuine OpenAI SSE, consumed by the actual Pi SDK inside the Worker. */
export function respond(call: ModelCall, response: ServerResponse, content: string | Array<{ name: string; arguments: unknown }>): void {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const id = randomUUID().replaceAll('-', '');
  if (call.path.endsWith('/responses')) {
    let sequence = 0;
    const emit = (type: string, value: Record<string, unknown>) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: ++sequence, ...value })}\n\n`);
    emit('response.created', { response: { id: `resp_${id}`, object: 'response', status: 'in_progress', output: [] } });
    const output: unknown[] = [];
    if (typeof content === 'string') {
      const item = { type: 'message', role: 'assistant', id: `msg_${id}`, status: 'completed', content: [{ type: 'output_text', text: content, annotations: [] }] };
      emit('response.output_item.added', { output_index: 0, item: { ...item, content: [] } });
      emit('response.content_part.added', { output_index: 0, item_id: item.id, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      emit('response.output_text.delta', { output_index: 0, item_id: item.id, content_index: 0, delta: content });
      emit('response.output_item.done', { output_index: 0, item }); output.push(item);
    } else for (const [index, tool] of content.entries()) {
      const item = { type: 'function_call', id: `fc_${id}_${index}`, call_id: `call_${id}_${index}`, name: tool.name, arguments: JSON.stringify(tool.arguments), status: 'completed' };
      emit('response.output_item.added', { output_index: index, item: { ...item, arguments: '' } });
      emit('response.function_call_arguments.delta', { output_index: index, item_id: item.id, delta: item.arguments });
      emit('response.function_call_arguments.done', { output_index: index, item_id: item.id, arguments: item.arguments });
      emit('response.output_item.done', { output_index: index, item }); output.push(item);
    }
    emit('response.completed', { response: { id: `resp_${id}`, object: 'response', status: 'completed', model: call.body.model, output,
      usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110, input_tokens_details: { cached_tokens: 40 } } } });
    response.end();
  } else {
    const emit = (choices: unknown[], usage?: unknown) => response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 123, model: call.body.model, choices, ...(usage ? { usage } : {}) })}\n\n`);
    emit([{ index: 0, delta: { role: 'assistant', ...(typeof content === 'string' ? { content } : { tool_calls: content.map((tool, index) => ({ index, id: `call_${id}_${index}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } })) }) }, finish_reason: null }]);
    emit([{ index: 0, delta: {}, finish_reason: typeof content === 'string' ? 'stop' : 'tool_calls' }], { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 40 } });
    response.end('data: [DONE]\n\n');
  }
}
export function sendReply(call: ModelCall, response: ServerResponse, messages: unknown[]): void {
  respond(call, response, [{ name: 'send_message', arguments: { messages } }]);
}
export function assertAccepted(call: ModelCall): void {
  const result = call.results.at(-1); assert.ok(result, 'Pi must report the actual custom-tool result');
  const text = String(result.output ?? result.content); assert.match(text, /"accepted":true/);
  assert.doesNotMatch(text, /messageId|requestId|sent|failed/);
}
export function deferred() {
  let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve };
}
export const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export async function piFixture(t: TestContext, handler: ModelHandler) {
  const directory = await mkdtemp(join(tmpdir(), 'napcat-pi-e2e-'));
  if (dockerImage) await chmod(directory, 0o755);
  const active = new Map<string, RunningBridge>();
  const processes: RunningBridge[] = []; const calls: ModelCall[] = []; const outgoing: Outgoing[] = [];
  const authorizations: Array<string | undefined> = []; const failures: unknown[] = []; let connections = 0;
  const model = createServer((request, response) => { void (async () => {
    let raw = ''; for await (const chunk of request) raw += String(chunk);
    const call = decodeModelCall(request.url ?? '', request.headers.authorization, JSON.parse(raw)); calls.push(call);
    await handler(call, response, calls.length);
  })().catch(error => { failures.push(error); if (!response.headersSent) response.writeHead(500); response.end('{}'); }); });
  const napcat = new WebSocketServer({ host: bindHost, port: 0 });
  let onSend: (message: Outgoing, socket: WebSocket) => boolean | void = () => {};
  napcat.on('connection', (socket, request) => {
    const connection = ++connections; authorizations.push(request.headers.authorization);
    socket.on('message', raw => {
      try {
        const message = { ...JSON.parse(raw.toString()), connection } as Outgoing; outgoing.push(message);
        if (onSend(message, socket) !== false) socket.send(JSON.stringify({ echo: message.echo, status: 'ok', retcode: 0, data: { message_id: outgoing.length } }));
      } catch (error) { failures.push(error); }
    });
  });
  await Promise.all([once(napcat, 'listening'), new Promise<void>(resolve => model.listen(0, bindHost, resolve))]);
  const modelUrl = `http://${requestHost}:${(model.address() as AddressInfo).port}/v1`;
  const wsUrl = `ws://${requestHost}:${(napcat.address() as AddressInfo).port}`;
  const dataPath = (target = '1001') => join(directory, `data-${target}`);
  const workspace = (target = '1001') => join(dataPath(target), 'workspace');
  const runtimeWorkspace = (target = '1001') => dockerImage ? '/data/workspace' : workspace(target);
  const diagnostic = () => processes.map(bridge => `closed=${bridge.closed} code=${bridge.code}; ${bridge.logs.slice(-30).join(' | ')}`).join('\n');
  const waitFor = async (condition: () => boolean | Promise<boolean>, description: string, timeout = dockerImage ? 15_000 : 10_000) => {
    const end = Date.now() + timeout;
    while (!await condition()) {
      assert.deepEqual(failures, [], `fixture failure: ${description}`);
      assert.ok(Date.now() < end, `${description}\n${diagnostic()}`); await delay(15);
    }
  };
  const docker = (args: string[]) => new Promise<void>(resolve => {
    const child = spawn('docker', args, { stdio: 'ignore', shell: false }); child.once('error', () => resolve()); child.once('close', () => resolve());
  });
  const stop = async (bridge: RunningBridge) => {
    if (!bridge.closed) { if (bridge.name) await docker(['stop', '--time', '4', bridge.name]); else bridge.child.kill('SIGTERM'); }
    let stopTimer: NodeJS.Timeout | undefined;
    try { await Promise.race([bridge.done, new Promise<void>(resolve => { stopTimer = setTimeout(resolve, 5_000); })]); }
    finally { clearTimeout(stopTimer); }
    if (!bridge.closed) {
      if (bridge.name) await docker(['rm', '--force', bridge.name]); bridge.child.kill('SIGKILL'); await bridge.done;
      assert.fail(`worker did not stop cleanly\n${diagnostic()}`);
    }
    assert.equal(bridge.code, 0, diagnostic());
  };
  const start = async (target = '1001', overrides: Record<string, string> = {}, mounts: Array<{ source: string; target: string }> = []) => {
    for (const path of [dataPath(target), workspace(target)]) { await mkdir(path, { recursive: true }); if (dockerImage) await chmod(path, 0o777); }
    const environment = {
      TARGET_TYPE: 'group', TARGET_ID: target, NAPCAT_WS_URL: wsUrl, NAPCAT_TOKEN: 'pi-e2e-private-token',
      CONSOLE_URL: '', BOT_INSTANCE_ID: '', WORKER_TOKEN: '', AGENT_PERSONA: 'An isolated local test persona.',
      DATA_DIR: dockerImage ? '/data' : dataPath(target), AGENT_HOME: dockerImage ? '/data/pi' : join(dataPath(target), 'pi'),
      AGENT_WORKSPACE: runtimeWorkspace(target), AGENT_BASE_URL: modelUrl, AGENT_API_KEY: `fake-provider-key-${target}`,
      AGENT_MODEL: `provider-model-${target}`, AGENT_API: 'openai-responses', AGENT_REASONING: 'none',
      AGENT_SUPPORTS_REASONING: 'false', AGENT_SUPPORTS_IMAGES: 'true', AGENT_ALLOW_COMMANDS: 'false', AGENT_ALLOW_FILE_WRITES: 'false',
      AGENT_CONTEXT_WINDOW: '200000', AGENT_AUTO_COMPACT_TOKEN_LIMIT: '160000', AGENT_MAX_OUTPUT_TOKENS: '8192',
      AGENT_TIMEOUT_MS: '15000', RANDOM_REPLY_PROBABILITY: '0', BATCH_SIZE: '50', REPLY_MAX_CHARS: '1500',
      RETRY_MS: '50', RECONNECT_MS: '50', ACTION_TIMEOUT_MS: '500', WEB_SEARCH_PROVIDER: 'none', TTS_PROVIDER: 'none', VOICE_REPLY_ENABLED: 'false',
      ...overrides,
    };
    const name = dockerImage ? `napcat-pi-e2e-${randomUUID()}` : undefined;
    const args = dockerImage ? ['run', '--rm', '--init', '--name', name!, '--add-host', 'host.docker.internal:host-gateway',
      '--mount', `type=bind,source=${dataPath(target)},target=/data`,
      ...mounts.flatMap(mount => ['--mount', `type=bind,source=${mount.source},target=${mount.target},readonly`]),
      ...Object.entries(environment).flatMap(([key, value]) => ['--env', `${key}=${value}`]), dockerImage]
      : [fileURLToPath(new URL('../../src/main.js', import.meta.url))];
    const child = spawn(dockerImage ? 'docker' : process.execPath, args, { env: dockerImage ? process.env : { ...process.env, ...environment }, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    const bridge: RunningBridge = { child, closed: false, code: null, done: Promise.resolve(), name, logs: [] };
    const capture = () => { let pending = ''; return (chunk: Buffer) => {
      pending += String(chunk); let newline: number;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        if (/^\d{4}-\d{2}-\d{2}T.*\+08:00 (?:INFO|WARN|ERROR) /.test(line)) bridge.logs.push(line);
      }
      if (bridge.logs.length > 400) bridge.logs.splice(0, bridge.logs.length - 400);
    }; };
    child.stdout.on('data', capture()); child.stderr.on('data', capture()); child.on('error', error => failures.push(error));
    bridge.done = new Promise(resolve => child.once('close', code => { bridge.closed = true; bridge.code = code; resolve(); }));
    processes.push(bridge); active.set(target, bridge); return bridge;
  };
  const read = <T>(target: string, fn: (db: DatabaseSync) => T): T => {
    let path = join(dataPath(target), 'bridge.sqlite3');
    if (dockerImage) {
      // macOS and Linux must not share a live SQLite WAL/SHM mapping. Read a
      // container-created snapshot instead of opening the Worker's live DB.
      const bridge = active.get(target); assert.ok(bridge?.name);
      execFileSync('docker', ['exec', bridge.name, 'node', '--input-type=module', '-e',
        "import{DatabaseSync,backup}from'node:sqlite';const db=new DatabaseSync('/data/bridge.sqlite3',{readOnly:true});await backup(db,'/data/e2e-read.sqlite3');db.close();"], { stdio: 'ignore', timeout: 5000 });
      path = join(dataPath(target), 'e2e-read.sqlite3');
    }
    const db = new DatabaseSync(path, { readOnly: true }); try { return fn(db); } finally { db.close(); }
  };
  const complete = (cursor: number, target = '1001') => read(target, db => db.prepare('SELECT cursor FROM instance_state WHERE id=1').get()?.cursor === cursor && db.prepare('SELECT COUNT(*) AS n FROM pending_batch').get()?.n === 0);
  const event = (id: string, text = id, mention = true, target = '1001', sender = '501') => ({ post_type: 'message', message_type: 'group', group_id: target, self_id: '999', user_id: sender,
    message_id: id, time: 1_792_727_200, sender: { nickname: '本地测试用户' }, message: [...(mention ? [{ type: 'at', data: { qq: '999' } }] : []), { type: 'text', data: { text } }] });
  const broadcast = (message: unknown) => { for (const socket of napcat.clients) if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); };
  t.after(async () => {
    const stopped = await Promise.allSettled(processes.map(stop));
    for (const socket of napcat.clients) socket.terminate(); model.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => napcat.close(() => resolve())), new Promise<void>(resolve => model.close(() => resolve()))]);
    await rm(directory, { recursive: true, force: true });
    for (const result of stopped) if (result.status === 'rejected') throw result.reason;
    assert.deepEqual(failures, []);
  });
  return { directory, modelUrl, wsUrl, napcat, calls, outgoing, authorizations, processes, failures, dataPath, workspace, runtimeWorkspace,
    start, stop, read, complete, event, broadcast, send: (id: string, text = id, mention = true, target = '1001', sender = '501') => broadcast(event(id, text, mention, target, sender)),
    waitFor, diagnostic, get connections() { return connections; }, set onSend(value: typeof onSend) { onSend = value; } };
}
