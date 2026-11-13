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
import { assertModelImage, largeModelImage } from './fixtures/model-image.js';

const batch = (text = 'hello', replyAllowed = true): PendingBatch => ({ throughSeq: 1, messages: [{ seq: 1, messageId: 'm1', senderId: '123', senderName: 'A', time: 123, text, replyTo: null, trigger: replyAllowed, rawJson: '{}' }], replyAllowed, replies: null, nextReplyIndex: 0 });

test('Pi task management validates the current requesting message and returns a persisted receipt',async()=>{
 const changes:unknown[]=[];
 const f=await fixture((_input,response,count)=>completion(response,count===1?[{name:'create_scheduled_task',arguments:{sourceMessageId:'m1',task:{name:'Morning',kind:'model',instructions:'Say good morning.',schedule:{kind:'cron',expression:'0 8 * * *'}}}}]:count===2?[{name:'send_message',arguments:{messages:[{type:'text',text:'Saved task example.'}]}}]:'done'));
 try {
  await f.runner.run(batch(),null,()=>{},new AbortController().signal,{send:async()=>({accepted:true})},undefined,{manage:async(request,id)=>{assert.ok(id);changes.push(request);return {id:'task-example',revision:1};}});
  assert.equal(changes.length,1);assert.match(JSON.stringify(f.requests[1]),/task-example/);
  assert.ok(f.requests[0]!.tools.some((tool:any)=>tool.function.name==='create_scheduled_task'));
 }finally{await f.close();}
});

test('Pi rejects task management attributed to historical or background messages',async()=>{
 let changes=0;
 const f=await fixture((_input,response,count)=>completion(response,count===1?[{name:'delete_scheduled_task',arguments:{sourceMessageId:'old-message',taskId:'task-example',expectedRevision:1}}]:count===2?[{name:'send_message',arguments:{messages:[{type:'text',text:'Unable to delete.'}]}}]:'done'));
 try {
  await f.runner.run(batch(),null,()=>{},new AbortController().signal,{send:async()=>({accepted:true})},undefined,{manage:async()=>{changes++;return {};}});
  assert.equal(changes,0);assert.match(JSON.stringify(f.requests[1]),/current reply-target/);
 }finally{await f.close();}
});

test('resumed Pi sessions receive the current instance task creator policy in tool descriptions', async () => {
 const f=await fixture((_input,response,count)=>completion(response,count%2===1?[{name:'send_message',arguments:{messages:[{type:'text',text:'Policy fixture reply.'}]}}]:'done'));
 let session:string|null=null;
 try {
  for(const [index,taskCreatorOnly] of [true,false,true].entries()) {
   const runner=new PiRunner({...f.options,taskCreatorOnly});
   await runner.run(batch(),session,id=>{session=id;},new AbortController().signal,{send:async()=>({accepted:true})},undefined,{manage:async()=>({})});
   const definitions=f.requests[index*2]!.tools.filter((tool:any)=>tool.function.name.endsWith('scheduled_task')||tool.function.name==='list_scheduled_tasks');
   assert.equal(definitions.length,4);
   for(const tool of definitions) {
    if(taskCreatorOnly)assert.match(tool.function.description,/Only the creator/);
    else assert.doesNotMatch(tool.function.description,/Only the creator|creator may|creator-only/);
   }
  }
 }finally{await f.close();}
});

test('Pi scheduled execution uses a fresh session and preserves state/send effects before a later provider failure',async()=>{
 const f=await fixture((_input,response,count)=>{
  if(count===1||count===6)completion(response,[{name:'send_message',arguments:{messages:[{type:'text',text:'ordinary chat'}]}}]);
  else if(count===3)completion(response,[{name:'save_task_state',arguments:{expectedVersion:0,data:{observation:'verified checkpoint'}}}]);
  else if(count===4)completion(response,[{name:'send_message',arguments:{messages:[{type:'text',text:'scheduled result'}]}}]);
  else if(count===5){response.writeHead(524,{'content-type':'application/json'});response.end(JSON.stringify({error:{message:'origin_response_timeout',type:'provider_error'}}));}
  else completion(response,'done');
 });
 let saved:unknown;let sent=0;
 try {
  await f.run();const mainSession=f.session;
  const input:import('../src/scheduled-contract.js').ScheduledInput={kind:'scheduled_task',task:{id:'task-example',name:'Report',instructions:'scheduled-only-instruction'},context:{taskState:{version:0,data:{},updatedAt:null,sourceRunId:null}},invocation:{runId:'scheduled-run',scheduledAt:new Date().toISOString(),startedAt:new Date().toISOString(),timezone:'Asia/Shanghai'}};
  await assert.rejects(f.runner.runScheduled(input,{send:async()=>{sent++;return {accepted:true};},saveState:async(data)=>{saved=data;return {version:1,data,updatedAt:Date.now(),sourceRunId:'scheduled-run'};}},new AbortController().signal),/PI_EXECUTION_FAILED/);
  assert.deepEqual(saved,{observation:'verified checkpoint'});assert.equal(sent,1);assert.equal(f.session,mainSession);
  assert.doesNotMatch(JSON.stringify(f.requests[2]!.messages.filter((message:any)=>message.role!=='system')),/ordinary chat/);
  const names=f.requests[2]!.tools.map((tool:any)=>tool.function.name);assert.ok(names.includes('save_task_state'));assert.ok(!names.includes('create_scheduled_task'));
  await f.run(batch('follow-up'));assert.doesNotMatch(await readFile(mainSession!,'utf8'),/scheduled-only-instruction|verified checkpoint/);
 }finally{await f.close();}
});
type Request = Record<string, any>;
function userTexts(request: Request): string[] {
  return (request.input ?? request.messages).filter((message: any) => message.role === 'user').map((message: any) =>
    typeof message.content === 'string' ? message.content : message.content.filter((part: any) => ['text', 'input_text'].includes(part.type)).map((part: any) => part.text).join(''));
}
function storedUsers(text: string): Array<{ id: string; message: { content: Array<{ type: string; text?: string }> } }> {
  return text.trim().split('\n').map(line => JSON.parse(line)).filter(entry => entry.type === 'message' && entry.message.role === 'user');
}
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
    const originalInput = userTexts(f.requests[0]!)[0]!;
    const second = batch('second'); second.messages[0]!.messageId = 'm2';
    await f.run(second); assert.equal(f.calls.length, 2); assert.equal(f.requests.length, 4);
    assert.match(JSON.stringify(f.requests[2]!.messages), /hello A/);
    const resumedInputs = userTexts(f.requests[2]!);
    assert.equal(resumedInputs[0], originalInput, 'Resuming must retain the exact prior user text for prefix reuse');
    assert.deepEqual(resumedInputs.map(text => JSON.parse(text).replyTargetMessageIds), [['m1'], ['m2']]);
    assert.ok(!f.logs.join('\n').includes('test-secret-key'));
    const stored = await readFile(f.session!, 'utf8'); assert.match(stored, /"role":"user"/); assert.match(stored, /"toolName":"send_message"/);
  } finally { await f.close(); }
});

test('Pi append-only batches persist context without model requests or tools', async () => {
  const f = await fixture((_input, response) => completion(response, 'should not happen'));
  try {
    await f.run(batch('background', false)); assert.equal(f.requests.length, 0); assert.equal(f.calls.length, 0); assert.ok(f.session);
    const stored = await readFile(f.session!, 'utf8'); assert.match(stored, /background/); assert.ok(!stored.includes('"role":"assistant"'));
    const input = JSON.parse(storedUsers(stored)[0]!.message.content[0]!.text!);
    assert.deepEqual(Object.keys(input), ['messages', 'replyTargetMessageIds']);
    assert.deepEqual(input.messages.map((message: { messageId: string }) => message.messageId), ['m1']);
    assert.deepEqual(input.replyTargetMessageIds, [], 'Background-only input must not carry a pending reply target');
  } finally { await f.close(); }
});

test('Pi keeps mixed background and multiple current targets ordered in both provider APIs', async t => {
  for (const api of ['openai-responses', 'openai-completions'] as const) await t.test(api, async () => {
    const path = api === 'openai-responses' ? '/v1/responses' : '/v1/chat/completions';
    const f = await fixture((body, response, count) => respond(decodeModelCall(path, undefined, body), response,
      count % 2 ? [{ name: 'send_message', arguments: { messages: [{ type: 'text', text: 'answer current targets' }] } }] : 'done'), { api });
    try {
      const input = batch(); input.throughSeq = 4;
      input.messages = [
        { ...input.messages[0]!, seq: 1, messageId: 'older-image', senderId: '101', senderName: 'Earlier speaker', time: 100, text: 'earlier topic', trigger: false },
        { ...input.messages[0]!, seq: 2, messageId: 'question-a', senderId: '201', senderName: 'Speaker A', time: 3700, text: 'current question A', trigger: true },
        { ...input.messages[0]!, seq: 3, messageId: 'context-between', senderId: '101', senderName: 'Earlier speaker', time: 3701, text: 'relevant clarification', replyTo: 'question-a', trigger: false },
        { ...input.messages[0]!, seq: 4, messageId: 'question-b', senderId: '202', senderName: 'Speaker B', time: 3702, text: 'current question B', trigger: true },
      ];
      await f.run(input);
      const serialized = userTexts(f.requests[0]!)[0]!; const prompt = JSON.parse(serialized);
      assert.deepEqual(Object.keys(prompt), ['messages', 'replyTargetMessageIds']);
      assert.deepEqual(prompt.messages, input.messages.map(({ messageId, senderId, senderName, time, text, replyTo }) => ({ messageId, senderId, senderName, time, text, replyTo })));
      assert.deepEqual(prompt.replyTargetMessageIds, ['question-a', 'question-b']);
      assert.ok(serialized.indexOf('"replyTargetMessageIds"') > serialized.indexOf('current question B'), 'Variable target IDs must follow all message content');
      assert.doesNotMatch(serialized, /"trigger"|"replyAllowed"|"rawJson"/);
      assert.deepEqual(decodeModelCall(path, undefined, f.requests[0]!).replyTargetMessageIds, ['question-a', 'question-b']);
      const wire = f.requests[0]!;
      const system = [wire.instructions ?? '', ...(wire.input ?? wire.messages).filter((message: any) => ['system', 'developer'].includes(message.role))
        .map((message: any) => typeof message.content === 'string' ? message.content : JSON.stringify(message.content))].join('\n');
      assert.match(system, /replyTargetMessageIds.*latest target list identifies the messages to answer now/s);
      assert.match(system, /Do not treat older target lists as a backlog/);
      assert.doesNotMatch(system, /question-a|question-b|older-image|context-between/, 'Per-turn target IDs must not rewrite the stable system prompt');
    } finally { await f.close(); }
  });
});

test('Pi resume preserves background envelopes and legacy user arrays without rewriting history', async () => {
  const f = await fixture((_input, response, count) => completion(response, count % 2
    ? [{ name: 'send_message', arguments: { messages: [{ type: 'text', text: 'current reply' }] } }] : 'done'));
  try {
    await f.run(batch('background context', false));
    const first = storedUsers(await readFile(f.session!, 'utf8'))[0]!;
    const legacyText = JSON.stringify([{ messageId: 'legacy-input', senderId: '301', senderName: 'Earlier speaker', time: 50, text: 'legacy background', replyTo: null }]);
    const manager = SessionManager.open(f.session!, join(f.home, 'sessions'), f.workspace);
    manager.appendMessage({ role: 'user', content: [{ type: 'text', text: legacyText }], timestamp: 50_000 });
    const before = storedUsers(await readFile(f.session!, 'utf8'));
    const current = batch('a current question'); current.messages[0]!.messageId = 'current-input';
    await f.run(current);
    const received = userTexts(f.requests[0]!);
    assert.equal(received[0], first.message.content[0]!.text);
    assert.equal(received[1], legacyText);
    assert.deepEqual(JSON.parse(received[0]!).replyTargetMessageIds, []);
    assert.deepEqual(JSON.parse(received[2]!).replyTargetMessageIds, ['current-input']);
    const after = storedUsers(await readFile(f.session!, 'utf8'));
    assert.deepEqual(after.slice(0, before.length), before, 'Persisted user entries must remain unchanged after resume');
  } finally { await f.close(); }
});

test('Pi final text alone never sends QQ and fails the required-reply turn', async () => {
  const f = await fixture((_input, response) => completion(response, 'This is final text.'));
  try { await assert.rejects(f.run(), error => {
    assert.match((error as Error).message, /PI_NO_REPLY/);
    assert.notEqual((error as {modelFailure?:boolean}).modelFailure, true); return true;
  }); assert.equal(f.calls.length, 0); assert.equal(f.requests.length, 1); }
  finally { await f.close(); }
});

test('Pi does not retry HTTP errors or output length stops', async t => {
  for (const failure of ['http', 'length', 'overflow']) await t.test(failure, async () => {
    const f = await fixture((_input, response) => {
      if (failure === 'length') completion(response, 'too long', { finish: 'length' });
      else { response.writeHead(failure === 'overflow' ? 400 : 503, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: failure === 'overflow' ? 'maximum context length exceeded' : 'temporarily unavailable', type: 'server_error' } })); }
    });
    try { await assert.rejects(f.run(), error => {
      assert.match((error as Error).message, /PI_EXECUTION_FAILED/);
      assert.equal((error as {modelFailure?:boolean}).modelFailure === true, failure !== 'length'); return true;
    }); assert.equal(f.requests.length, 1); assert.equal(f.calls.length, 0); }
    finally { await f.close(); }
  });
});

test('Pi timeout and external cancellation end the child without leaving a model retry', async t => {
  for (const reason of ['timeout', 'cancel']) await t.test(reason, async () => {
    const f = await fixture((_input, response) => { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(': waiting\n\n'); }, { timeoutMs: reason === 'timeout' ? 800 : 15_000 });
    const abort = new AbortController(); const timer = reason === 'cancel' ? setTimeout(() => abort.abort(), 800) : undefined;
    try { await assert.rejects(f.run(batch(), abort.signal), error => {
      assert.match((error as Error).message, reason === 'timeout' ? /PI_TIMEOUT/ : /PI_ABORTED/);
      assert.equal((error as {modelFailure?:boolean}).modelFailure === true, reason === 'timeout'); return true;
    }); assert.ok(f.requests.length <= 1); }
    finally { clearTimeout(timer); await f.close(); }
  });
});

test('Pi identifies provider connection, stream and content-filter failures in both APIs', async t => {
  for (const api of ['openai-completions', 'openai-responses'] as const) {
    for (const failure of ['connection', 'stream', 'content_filter']) await t.test(`${api}: ${failure}`, async () => {
      const f = await fixture((_input, response) => {
        if (failure === 'connection') { response.destroy(); return; }
        if (failure === 'stream') {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.write(api === 'openai-responses'
            ? 'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_failed_stream","status":"in_progress","output":[]}}\n\n'
            : 'data: {"id":"failed-stream","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"partial"},"finish_reason":null}]}\n\n');
          setTimeout(() => response.destroy(), 30); return;
        }
        if (api === 'openai-completions') { completion(response, '', {finish:'content_filter'}); return; }
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end('event: response.incomplete\ndata: {"type":"response.incomplete","response":{"id":"resp_filtered","status":"incomplete","output":[],"incomplete_details":{"reason":"content_filter"}}}\n\n');
      }, {api});
      try {
        await assert.rejects(f.run(), error => {
          assert.match((error as Error).message, /PI_EXECUTION_FAILED/);
          assert.equal((error as {modelFailure?:boolean}).modelFailure, true); return true;
        });
        assert.equal(f.requests.length, 1); assert.equal(f.calls.length, 0);
      } finally { await f.close(); }
    });
  }
});

test('Pi does not identify local session callbacks or invalid sessions as provider failures', async () => {
  const f = await fixture((_input, response) => completion(response, 'unused'));
  const localFailure = (error: unknown) => { assert.notEqual((error as {modelFailure?:boolean}).modelFailure, true); return true; };
  try {
    await assert.rejects(f.runner.run(batch(), null, () => { throw new Error('Session persistence fixture failed.'); }, new AbortController().signal), localFailure);
    await assert.rejects(f.runner.run(batch(), join(f.dir, 'missing-session.jsonl'), () => {}, new AbortController().signal), localFailure);
  } finally { await f.close(); }
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
    if (!input.tools?.length) completion(response, '## Recent relevant topics\nEarlier chat.\n## People and references\nA (123).\n## Current facts and corrections\nNone.\n## Explicitly unfinished work\nNone.\n## Useful results and artifacts\nReply accepted; do not repeat.');
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
      if (supportsImages) assert.equal(user.content.find((part: any) => part.type === 'image_url').image_url.url,
        `data:image/png;base64,${image}`, 'Small images retain their original bytes.');
      const prompt = JSON.parse(userTexts(f.requests[0]!)[0]!);
      assert.deepEqual(prompt.replyTargetMessageIds, ['m1']);
      assert.match(prompt.messages[0].images[0].path, /\.qq-images\/[a-f\d]{64}\.png$/);
    } finally { await f.close(); }
  });
});

test('Pi compresses incoming image bytes before the legacy input is persisted', async () => {
  const original = largeModelImage();
  const f = await fixture((_input, response, count) => completion(response, count % 2 ? [
    { name: 'send_message', arguments: { messages: [{ type: 'text', text: 'Image received.' }] } },
  ] : 'done'), { imageFetch: async () => new Response(new Uint8Array(original)) });
  try {
    const input = batch();
    input.messages[0]!.rawJson = JSON.stringify({ message: [
      { type: 'image', data: { url: 'https://example.invalid/image.png' } },
    ] });
    await f.run(input);
    const user = f.requests[0]!.messages.find((message: any) => message.role === 'user');
    const images = user.content.filter((part: any) => part.type === 'image_url');
    assert.equal(images.length, 1);
    await assertModelImage(images[0].image_url.url);
    assert.ok(images[0].image_url.url.length < original.toString('base64').length);
    const envelope = JSON.parse(userTexts(f.requests[0]!)[0]!);
    assert.deepEqual(await readFile(envelope.messages[0].images[0].path), original,
      'Compression preserves the cached original image.');
    const session = (await readFile(f.session!, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const saved = session.find(entry => entry.type === 'message' && entry.message.role === 'user')
      .message.content.find((part: any) => part.type === 'image');
    assert.equal(`data:${saved.mimeType};base64,${saved.data}`, images[0].image_url.url);
  } finally { await f.close(); }
});

test('Pi omits an undecodable legacy image while preserving the user text and cached original', async () => {
  const original = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const f = await fixture((_input, response, count) => completion(response, count % 2 ? [
    { name: 'send_message', arguments: { messages: [{ type: 'text', text: 'The image is unavailable, but the message was received.' }] } },
  ] : 'done'), { imageFetch: async () => new Response(new Uint8Array(original)) });
  try {
    const text = 'Please answer this text even if the attached image is unavailable.';
    const input = batch(text);
    input.messages[0]!.rawJson = JSON.stringify({ message: [
      { type: 'text', data: { text } },
      { type: 'image', data: { url: 'https://example.invalid/corrupt-image.png' } },
    ] });
    await f.run(input);
    assert.equal(f.calls.length, 1, 'An undecodable image must not prevent a normal reply.');
    assert.equal(f.requests.length, 2);
    for (const request of f.requests) {
      assert.doesNotMatch(JSON.stringify(request.messages), /data:image\//);
      const envelope = JSON.parse(userTexts(request)[0]!);
      assert.ok(envelope.messages[0].text.startsWith(text), 'The full user text must survive alongside attachment markers.');
      const image = envelope.messages[0].images[0];
      assert.equal(image.status, 'failed');
      assert.equal(image.error, 'Image content is unavailable for this input.');
      assert.deepEqual(await readFile(image.path), original, 'Failed preparation must preserve the cached original bytes.');
    }
    const stored = storedUsers(await readFile(f.session!, 'utf8'))[0]!.message.content;
    assert.equal(stored.filter((part: any) => part.type === 'image').length, 0);
    const saved = JSON.parse(stored.find((part: any) => part.type === 'text')!.text!);
    assert.ok(saved.messages[0].text.startsWith(text));
    assert.equal(saved.messages[0].images[0].status, 'failed');
  } finally { await f.close(); }
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
    await assert.rejects(f.run(), error => {
      assert.match((error as Error).message, /PI_EXECUTION_FAILED/);
      assert.match((error as Error).message, /503/);
      assert.match((error as Error).message, /summary unavailable/);
      assert.equal((error as {modelFailure?:boolean}).modelFailure, true); return true;
    });
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
        assert.equal((error as { code?: string }).code, 'PI_CONFIGURATION_REQUIRED');
        assert.notEqual((error as {modelFailure?:boolean}).modelFailure, true); return true;
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

test('Pi cancellation releases a stuck host task callback and resumes the same session without replay',async()=>{
 let entered!:()=>void;const managing=new Promise<void>(resolve=>{entered=resolve;});
 const f=await fixture((_input,response,count)=>completion(response,count===1
   ?[{name:'list_scheduled_tasks',arguments:{sourceMessageId:'m1'}}]
   :count===2?[{name:'send_message',arguments:{messages:[{type:'text',text:'new turn reply'}]}}]:'done'));
 const abort=new AbortController();let session:string|null=null;
 try {
   const run=f.runner.run(batch(),null,id=>{session=id;},abort.signal,{send:async()=>({accepted:true})},undefined,
     {manage:async()=>{entered();return new Promise(()=>{});}});
   const rejected=assert.rejects(run,/PI_ABORTED/);await managing;assert.ok(session);
   const started=Date.now();abort.abort();await rejected;assert.ok(Date.now()-started<3000);
   const old=session;const next=batch('new input');next.messages[0]!.messageId='m2';let accepted=0;
   await f.runner.run(next,session,id=>{session=id;},new AbortController().signal,{send:async()=>{accepted++;return {accepted:true};}},undefined,{manage:async()=>{throw new Error('must not replay');}});
   assert.equal(session,old);assert.equal(accepted,1);assert.equal(f.requests.length,3);
   const stored=(await readFile(session!,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
   const result=stored.find(entry=>entry.type==='message'&&entry.message.role==='toolResult'&&entry.message.toolName==='list_scheduled_tasks');
   assert.ok(result);assert.equal(result.message.isError,true);
 }finally{abort.abort();await f.close();}
});
