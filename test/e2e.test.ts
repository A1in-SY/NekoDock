import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import test from 'node:test';
import { assertAccepted, bindHost, busyReply, deferred, delay, dockerImage, piFixture, pngBase64, requestHost, respond, sendReply } from './fixtures/pi-e2e.js';

test('Pi Worker 贯通共享 NapCat、独立群聊、图片收发、批次艾特回复与持久化重启', { timeout: dockerImage ? 80_000 : 45_000 }, async t => {
  const gate = deferred(); t.after(() => gate.resolve());
  const rounds = new Map<string, number>();
  const f = await piFixture(t, async (call, response) => {
    const target = String(call.body.model).replace('provider-model-', '');
    if (call.results.length) { assertAccepted(call); respond(call, response, 'Internal final must not be sent to QQ.'); return; }
    const round = (rounds.get(target) ?? 0) + 1; rounds.set(target, round);
    if (target === '1001' && round === 1) await gate.promise;
    const replies: unknown[] = target === '1001' && round === 2
      ? call.batch.map(message => ({ type: 'message', segments: [{ type: 'at', userId: message.senderId }, { type: 'text', text: `${target}-reply-${round}-${message.messageId}` }] }))
      : [{ type: 'text', text: `${target}-reply-${round}` }];
    if (target === '1001' && round === 1) replies.push({ type: 'image', path: 'generated.png' });
    sendReply(call, response, replies);
  });
  const imageServer = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'image/png' }); response.end(Buffer.from(pngBase64, 'base64')); });
  await new Promise<void>(resolve => imageServer.listen(0, bindHost, resolve));
  t.after(() => new Promise<void>(resolve => imageServer.close(() => resolve())));
  const imageUrl = `http://${requestHost}:${(imageServer.address() as AddressInfo).port}/photo.png`;
  const first = await f.start('1001'); await f.start('1002', { AGENT_API: 'openai-completions' });
  await f.waitFor(() => f.napcat.clients.size === 2, '两个 Worker 应连接同一个 NapCat');
  await writeFile(join(f.workspace(), 'generated.png'), Buffer.from(pngBase64, 'base64'));
  const context = f.event('g1-context', 'context-before-mention', false);
  f.broadcast({ ...context, message: [...context.message, { type: 'image', data: { url: imageUrl, sub_type: 0 } }] });
  await delay(100); assert.equal(f.calls.length, 0); assert.equal(f.outgoing.length, 0);
  f.send('g1-first', 'first-trigger');
  await f.waitFor(() => f.calls.length === 1, '首轮应收到未触发的背景消息与艾特');
  f.send('g1-busy', 'user-A-question-1-while-busy', false);
  f.send('g1-second', 'user-B-question-2-while-busy', true, '1001', '502');
  f.send('g2-first', 'other-group-trigger', true, '1002');
  f.send('own-g1', 'own message must be ignored', true, '1001', '999');
  f.send('own-g2', 'own message must be ignored', true, '1002', '999');
  f.send('wrong-target', 'unbound group must be ignored', true, '9999');
  f.broadcast({ ...f.event('wrong-type'), message_type: 'private' });
  await f.waitFor(() => f.outgoing.some(message => message.params.message[0]?.data.text === busyReply), '忙碌艾特应立即提示');
  gate.resolve();
  await f.waitFor(() => f.complete(4) && f.complete(1, '1002'), '两实例应完成各自批次');
  const starts = f.calls.filter(call => call.results.length === 0);
  const group1 = starts.filter(call => call.body.model === 'provider-model-1001');
  const group2 = starts.filter(call => call.body.model === 'provider-model-1002');
  assert.deepEqual(group1.map(call => call.batch.map(message => message.messageId)), [['g1-context', 'g1-first'], ['g1-busy', 'g1-second']]);
  assert.deepEqual(Object.keys(group1[0]!.batch[0]!).sort(), ['images', 'messageId', 'replyTo', 'senderId', 'senderName', 'text', 'time']);
  assert.equal(group1[0]!.images.length, 1); assert.equal(group1[0]!.images[0], `data:image/png;base64,${pngBase64}`, 'Pi 必须把真实图片字节传给供应商');
  assert.deepEqual(group1[1]!.batch.map(message => [message.senderId, message.text]), [['501', 'user-A-question-1-while-busy'], ['502', '[@999]user-B-question-2-while-busy']]);
  assert.deepEqual(group2[0]!.batch.map(message => message.messageId), ['g2-first']);
  assert.ok(!JSON.stringify(group2[0]!.body).includes('context-before-mention'), '实例历史不可串用');
  for (const call of f.calls) {
    const target = String(call.body.model).replace('provider-model-', '');
    assert.equal(call.authorization, `Bearer fake-provider-key-${target}`);
    assert.equal(JSON.stringify(call.body).includes('fake-provider-key-'), false);
    assert.doesNotMatch(JSON.stringify(call.batch), /"trigger"|"replyAllowed"|我正在想上面的消息怎么回/);
  }
  const textReplies = () => f.outgoing.flatMap(message => message.params.message.filter(segment => segment.type === 'text').map(segment => [String(message.params.group_id), segment.data.text]));
  assert.deepEqual(textReplies().filter(([, text]) => text !== busyReply).sort(), [['1001', '1001-reply-1'], ['1001', '1001-reply-2-g1-busy'], ['1001', '1001-reply-2-g1-second'], ['1002', '1002-reply-1']]);
  assert.deepEqual(f.outgoing.flatMap(message => message.params.message.filter(segment => segment.type === 'image').map(segment => segment.data.file)), [`base64://${pngBase64}`]);
  assert.deepEqual(f.outgoing.filter(message => message.params.message.some(segment => segment.type === 'at')).map(message => message.params.message), [
    [{ type: 'at', data: { qq: '501' } }, { type: 'text', data: { text: '1001-reply-2-g1-busy' } }],
    [{ type: 'at', data: { qq: '502' } }, { type: 'text', data: { text: '1001-reply-2-g1-second' } }],
  ]);
  const session = f.read('1001', db => String(db.prepare('SELECT session_id FROM instance_state WHERE id=1').get()?.session_id));
  const sessionOnHost = dockerImage ? join(f.dataPath(), session.replace(/^\/data\//, '')) : session;
  assert.match(await readFile(sessionOnHost, 'utf8'), /"toolName":"send_message"/);
  await f.stop(first); await f.waitFor(() => f.napcat.clients.size === 1, '停止实例后连接应释放');
  assert.ok(first.logs.some(line => line.endsWith(' INFO app.stopped')));
  await f.start(); await f.waitFor(() => f.napcat.clients.size === 2, '重启后应连接');
  f.send('g1-after-restart', 'trigger-after-restart');
  await f.waitFor(() => f.complete(5), '重启后应复用 Pi 会话并推进游标');
  const last = f.calls.filter(call => call.results.length === 0).at(-1)!;
  assert.deepEqual(last.batch.map(message => message.messageId), ['g1-after-restart']);
  assert.match(JSON.stringify(last.body), /1001-reply-1/);
  assert.equal(f.read('1001', db => db.prepare('SELECT session_id FROM instance_state WHERE id=1').get()?.session_id), session);
  assert.equal(rounds.get('1001'), 3); assert.equal(rounds.get('1002'), 1);
  assert.equal(f.outgoing.flatMap(message => message.params.message.filter(segment => segment.type === 'image')).length, 1);
  assert.ok(f.authorizations.every(value => value === 'Bearer pi-e2e-private-token'));
  assert.doesNotMatch(f.processes.flatMap(process => process.logs).join('\n'), /pi-e2e-private-token|fake-provider-key-|context-before-mention|user-A-question|iVBOR/);
});

test('首次升级 Pi 以切换水位开始新会话，旧待发与历史不导入，后续重启不再切断新会话', { timeout: dockerImage ? 65_000 : 35_000 }, async t => {
  const f = await piFixture(t, (call, response) => {
    if (call.results.length) { assertAccepted(call); respond(call, response, 'Internal final.'); return; }
    sendReply(call, response, [{ type: 'text', text: `fresh-${call.batch.at(-1)!.messageId}` }]);
  });
  await mkdir(f.workspace(), { recursive: true });
  const db = new DatabaseSync(join(f.dataPath(), 'bridge.sqlite3'));
  try {
    // Deliberately reproduce only the existing on-disk schema, without calling
    // the current BridgeStore constructor (which may register the new runtime).
    db.exec(`CREATE TABLE instance_state(id INTEGER PRIMARY KEY CHECK(id=1),target_type TEXT NOT NULL,target_id TEXT NOT NULL,session_id TEXT,cursor INTEGER NOT NULL DEFAULT 0);
      INSERT INTO instance_state VALUES(1,'group','1001','legacy-codex-session-private-fixture',1);
      CREATE TABLE messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,message_id TEXT NOT NULL UNIQUE,sender_id TEXT NOT NULL,sender_name TEXT NOT NULL,time INTEGER NOT NULL,text TEXT NOT NULL,reply_to TEXT,trigger INTEGER NOT NULL,raw_json TEXT NOT NULL);
      INSERT INTO messages VALUES(1,'legacy-complete','501','Legacy',123,'legacy-complete-private-fixture',NULL,1,'{}');
      INSERT INTO messages VALUES(2,'legacy-pending','501','Legacy',124,'legacy-pending-private-fixture',NULL,1,'{}');
      CREATE TABLE pending_batch(id INTEGER PRIMARY KEY CHECK(id=1),through_seq INTEGER NOT NULL,reply_allowed INTEGER NOT NULL,replies_json TEXT,next_reply_index INTEGER NOT NULL DEFAULT 0,generation_done INTEGER NOT NULL DEFAULT 0,model_started INTEGER NOT NULL DEFAULT 0);
      INSERT INTO pending_batch VALUES(1,2,1,'[{"type":"text","text":"legacy-reply-private-fixture"}]',0,1,1);`);
  } finally { db.close(); }
  if (dockerImage) await chmod(join(f.dataPath(), 'bridge.sqlite3'), 0o666);
  await writeFile(join(f.workspace(), 'preserved.txt'), 'workspace marker');
  const first = await f.start(); await f.waitFor(() => f.napcat.clients.size === 1 && f.complete(2), '升级时应结束旧待发并推进切换水位');
  await delay(100); assert.equal(f.calls.length, 0); assert.equal(f.outgoing.length, 0, '不能重放旧待发消息');
  f.send('pi-first'); await f.waitFor(() => f.complete(3), '新消息应开启全新 Pi 会话');
  assert.equal(f.outgoing.length, 1); assert.equal(f.outgoing[0]?.params.message[0]?.data.text, 'fresh-pi-first');
  assert.doesNotMatch(JSON.stringify(f.calls.map(call => call.body)), /legacy-complete-private-fixture|legacy-pending-private-fixture|legacy-reply-private-fixture|legacy-codex-session/);
  const session = f.read('1001', db => String(db.prepare('SELECT session_id FROM instance_state WHERE id=1').get()?.session_id));
  assert.match(session, /\/pi\/sessions\/.+\.jsonl$/); assert.equal(await readFile(join(f.workspace(), 'preserved.txt'), 'utf8'), 'workspace marker');
  assert.equal(f.read('1001', db => db.prepare('SELECT COUNT(*) AS n FROM messages').get()?.n), 3, '业务历史保留但不导入模型');
  await f.stop(first); await f.waitFor(() => f.napcat.clients.size === 0, '升级后首次停止');
  await f.start(); await f.waitFor(() => f.napcat.clients.size === 1, '再次启动');
  f.send('pi-next'); await f.waitFor(() => f.complete(4), '再次启动不能重复应用切换水位');
  assert.equal(f.read('1001', db => db.prepare('SELECT session_id FROM instance_state WHERE id=1').get()?.session_id), session);
  assert.match(JSON.stringify(f.calls.filter(call => !call.results.length).at(-1)!.body), /fresh-pi-first/);
  assert.equal(f.outgoing.length, 2);
});

test('Pi 自定义搜索工具直接调用 Tavily，搜索与抓取结果返回模型后再回复', { timeout: dockerImage ? 45_000 : 25_000 }, async t => {
  const f = await piFixture(t, (call, response) => {
    if (call.results.length === 0) {
      const names = call.body.tools.map((tool: any) => tool.name ?? tool.function?.name);
      assert.ok(names.includes('web_search')); assert.ok(names.includes('web_fetch'));
      respond(call, response, [{ name: 'web_search', arguments: { query: 'isolated-private-search-query', maxResults: 2 } }]);
    } else if (call.results.length === 1) {
      assert.match(JSON.stringify(call.results), /SEARCH_MARKER/);
      respond(call, response, [{ name: 'web_fetch', arguments: { urls: ['https://example.com/source'] } }]);
    } else if (call.results.length === 2) {
      assert.match(JSON.stringify(call.results), /EXTRACT_MARKER/); sendReply(call, response, [{ type: 'text', text: 'search-result-reply' }]);
    } else { assertAccepted(call); respond(call, response, 'Internal final.'); }
  });
  const requests: Array<{ path: string | undefined; authorization: string | undefined; body: Record<string, unknown> }> = [];
  const service = createServer((request, response) => { void (async () => {
    let raw = ''; for await (const chunk of request) raw += String(chunk);
    requests.push({ path: request.url, authorization: request.headers.authorization, body: JSON.parse(raw) });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(request.url?.endsWith('/search') ? { results: [{ url: 'https://example.com/source', title: 'Local source', content: 'SEARCH_MARKER' }] }
      : { results: [{ url: 'https://example.com/source', raw_content: 'EXTRACT_MARKER' }] }));
  })().catch(error => { f.failures.push(error); response.end('{}'); }); });
  await new Promise<void>(resolve => service.listen(0, bindHost, resolve));
  t.after(() => { service.closeAllConnections(); return new Promise<void>(resolve => service.close(() => resolve())); });
  const bridge = await f.start('1001', { WEB_SEARCH_PROVIDER: 'tavily', TAVILY_API_KEY: 'isolated-private-tavily-key',
    TAVILY_SEARCH_BASE_URL: `http://${requestHost}:${(service.address() as AddressInfo).port}/api/tavily`, WEB_SEARCH_TIMEOUT_MS: '2000' });
  await f.waitFor(() => f.napcat.clients.size === 1, 'Worker 应连接'); f.send('search');
  await f.waitFor(() => f.complete(1), '搜索、抓取、发送应形成一个完整真实 Pi 工具循环');
  assert.deepEqual(requests.map(request => request.path), ['/api/tavily/search', '/api/tavily/extract']);
  assert.ok(requests.every(request => request.authorization === 'Bearer isolated-private-tavily-key'));
  assert.equal(requests[0]!.body.query, 'isolated-private-search-query'); assert.equal(requests[0]!.body.max_results, 2);
  assert.deepEqual(requests[1]!.body.urls, ['https://example.com/source']);
  assert.equal(f.calls.length, 4); assert.equal(f.outgoing.length, 1); assert.equal(f.outgoing[0]?.params.message[0]?.data.text, 'search-result-reply');
  assert.doesNotMatch(JSON.stringify(f.calls.map(call => call.body)), /isolated-private-tavily-key/);
  assert.doesNotMatch(bridge.logs.join('\n'), /isolated-private-tavily-key|isolated-private-search-query|SEARCH_MARKER|EXTRACT_MARKER/);
});
