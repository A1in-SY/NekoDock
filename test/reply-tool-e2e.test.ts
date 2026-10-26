import assert from 'node:assert/strict';
import test from 'node:test';
import { assertAccepted, busyReply, deferred, dockerImage, piFixture, respond, sendReply } from './fixtures/pi-e2e.js';

test('Pi 长任务中途回复、多次工具调用、final 不重复发送，失败批次只尝试一次', { timeout: dockerImage ? 90_000 : 60_000 }, async t => {
  const result = deferred(); const finish = deferred(); t.after(() => { result.resolve(); finish.resolve(); });
  const f = await piFixture(t, async (call, response) => {
    const id = call.batch.at(-1)?.messageId;
    if (call.results.length) {
      assertAccepted(call);
      if (id === 'failure-model') { response.writeHead(503, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'fixture provider failed', type: 'server_error' } })); return; }
      if (id === 'task' && call.results.length === 1) {
        await result.promise; sendReply(call, response, [{ type: 'message', segments: [{ type: 'at', userId: '501' }, { type: 'text', text: ' 第一个方案更合适，比较结果已经确认。' }] }]); return;
      }
      if (id === 'task') await finish.promise;
      respond(call, response, 'Final text must never be sent to QQ.'); return;
    }
    const messages = id === 'task' ? [{ type: 'text', text: '找到关键限制：第二个方案不支持你的场景。' }]
      : id === 'follow-up' ? [{ type: 'text', text: '这是下一轮的新问题回复。' }]
      : id === 'failure-image' ? [{ type: 'image', path: 'missing-private-fixture.png' }, { type: 'text', text: 'after-missing-image' }]
      : [{ type: 'text', text: id === 'failure-model' ? 'before-model-exit' : id === 'failure-napcat' ? 'rejected-private-fixture' : id === 'failure-ack' ? 'unconfirmed-private-fixture' : id }];
    sendReply(call, response, messages);
  });
  f.onSend = (message, socket) => {
    const text = message.params.message.find(segment => segment.type === 'text')?.data.text;
    if (text === 'unconfirmed-private-fixture') return false;
    if (text === 'rejected-private-fixture') { socket.send(JSON.stringify({ echo: message.echo, status: 'failed', retcode: 1200, message: 'mock rejected' })); return false; }
  };
  const bridge = await f.start(); await f.waitFor(() => f.napcat.clients.size === 1, 'Worker 应连接 NapCat');
  f.send('task');
  await f.waitFor(() => f.outgoing.length === 1 && f.calls.length === 2, 'Pi 结束前应实际发出重要节点并收到 accepted');
  assert.equal(f.read('1001', db => db.prepare('SELECT cursor FROM instance_state WHERE id=1').get()?.cursor), 0);
  f.send('follow-up', 'follow-up', true, '1001', '502');
  await f.waitFor(() => f.outgoing.length === 2, '运行中应接收新消息并发出等待提示');
  assert.equal(f.outgoing[1]?.params.message[0]?.data.text, busyReply);
  assert.equal(f.calls.filter(call => !call.results.length).length, 1, '不能并发执行下一批');
  result.resolve();
  await f.waitFor(() => f.outgoing.length === 3 && f.calls.length === 3, '结束前应再次发出带艾特的结果');
  assert.deepEqual(f.outgoing[2]?.params.message, [{ type: 'at', data: { qq: '501' } }, { type: 'text', data: { text: ' 第一个方案更合适，比较结果已经确认。' } }]);
  assert.equal(f.read('1001', db => db.prepare('SELECT cursor FROM instance_state WHERE id=1').get()?.cursor), 0);
  finish.resolve();
  await f.waitFor(() => f.outgoing.length === 4 && f.complete(2), 'final 不产生重复消息，下一批应正常完成');
  assert.equal(f.outgoing[3]?.params.message[0]?.data.text, '这是下一轮的新问题回复。');
  assert.ok(f.calls.every(call => !JSON.stringify(call.body).includes(busyReply)));
  f.read('1001', db => {
    for (const [table, column] of [['messages', 'raw_json'], ['pending_batch', 'replies_json'], ['reply_requests', 'messages_json']])
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} LIKE ?`).get(`%${busyReply}%`)?.n, 0);
  });
  let cursor = 2;
  for (const failure of ['model', 'image', 'napcat', 'ack']) {
    const before = f.outgoing.length; const failureId = `failure-${failure}`;
    f.send(failureId);
    await f.waitFor(() => f.calls.some(call => call.batch.at(-1)?.messageId === failureId && call.results.length > 0), '真实 Pi 应收到 accepted=true，而不是投递状态');
    cursor++; await f.waitFor(() => f.complete(cursor), '失败批次应结束并推进游标');
    assert.equal(f.outgoing.length, before + 1, '发送及媒体准备失败都不补发；下一有效分段仍应发送');
    assert.equal(f.outgoing.at(-1)?.params.message[0]?.data.text, failure === 'model' ? 'before-model-exit' : failure === 'image' ? 'after-missing-image' : failure === 'napcat' ? 'rejected-private-fixture' : 'unconfirmed-private-fixture');
    if (failure === 'ack') await f.waitFor(() => f.connections === 2 && f.napcat.clients.size === 1, '回执超时后应重新连接');
    const healthy = `healthy-${failure}`; f.send(healthy); cursor++;
    await f.waitFor(() => f.complete(cursor), '下一批应继续处理且不重放前一批');
    assert.equal(f.outgoing.length, before + 2); assert.equal(f.outgoing.at(-1)?.params.message[0]?.data.text, healthy);
  }
  const initial = f.calls.filter(call => call.results.length === 0).map(call => call.batch.at(-1)?.messageId);
  assert.deepEqual(initial, ['task', 'follow-up', ...['model', 'image', 'napcat', 'ack'].flatMap(kind => [`failure-${kind}`, `healthy-${kind}`])]);
  assert.equal(f.calls.filter(call => call.batch.at(-1)?.messageId === 'failure-model').length, 2, '供应商失败不能自动 HTTP 重试或重新生成');
  const logs = bridge.logs.join('\n');
  assert.match(logs, /processor\.batch\.failed .*replayed=false/);
  assert.match(logs, /processor\.reply\.failed .*stage="image_prepare"/);
  assert.match(logs, /processor\.reply\.failed .*status="unconfirmed"/);
  assert.doesNotMatch(logs, /pi-e2e-private-token|fake-provider-key-|找到关键限制|比较结果已经确认|unconfirmed-private-fixture|rejected-private-fixture|missing-private-fixture/);
});
