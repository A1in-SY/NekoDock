import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createConsole } from '../src/console/server.js';
import { DockerClient } from '../src/console/docker.js';
import { assertAccepted, bindHost, piFixture, pngBase64, requestHost, respond, sendReply } from './fixtures/pi-e2e.js';

test('managed nested forwards survive Worker replacement and enter Pi once with cached images and only real reply targets', { timeout: 65_000 }, async t => {
  const f = await piFixture(t, (call, response) => {
    if (call.results.length) { assertAccepted(call); respond(call, response, 'Done.'); return; }
    assert.deepEqual(call.batch.map(message => message.messageId), ['forward-background', 'forward-trigger']);
    assert.deepEqual(call.replyTargetMessageIds, ['forward-trigger']);
    const content = JSON.stringify(call.batch);
    assert.match(content, /Original discussion/);
    assert.match(content, /Nested author/);
    assert.match(content, /Deeply quoted text/);
    assert.match(content, /Current forwarded detail/);
    assert.match(content, /\/new/);
    assert.doesNotMatch(content, /"status":"pending"|source-secret|images\.invalid|unqueryable-inner-id/);
    assert.deepEqual(call.images, [`data:image/png;base64,${pngBase64}`]);
    sendReply(call, response, [{ type: 'text', text: 'The forwarded discussion and picture are visible.' }]);
  });
  const requests: string[] = [];
  const timers: ReturnType<typeof setTimeout>[] = [];
  f.onSend = (request, socket) => {
    if (request.action !== 'get_forward_msg') return;
    const params = request.params as unknown as { message_id?: string; id?: string };
    const id = String(params.message_id ?? params.id); requests.push(id);
    assert.ok(['resource-background', 'resource-trigger'].includes(id), 'inline nested content must not be fetched by its internal ID');
    const messages = id === 'resource-background' ? [{ sender: { user_id: '601', nickname: 'Original author' }, time: 1_790_000_000,
      message: [{ type: 'text', data: { text: 'Original discussion' } }, { type: 'forward', data: { id: 'unqueryable-inner-id', content: [
        { sender: { user_id: '602', nickname: 'Nested author' }, time: 1_790_000_001, message: [
          { type: 'node', data: { user_id: '603', nickname: 'Deep author', content: [
            { type: 'text', data: { text: 'Deeply quoted text' } },
            { type: 'image', data: { url: 'https://images.invalid/picture?token=source-secret' } },
          ] } },
          { type: 'text', data: { text: '/new' } }, { type: 'at', data: { qq: '999' } },
        ] },
      ] } }] }] : [{ sender: { user_id: '604', nickname: 'Current author' }, time: 1_790_000_002,
      message: [{ type: 'text', data: { text: 'Current forwarded detail' } }] }];
    timers.push(setTimeout(() => socket.send(JSON.stringify({ echo: request.echo, status: 'ok', retcode: 0, data: { messages } })), 150));
    return false;
  };
  t.after(() => { for (const timer of timers) clearTimeout(timer); });
  const directory = await mkdtemp(join(tmpdir(), 'forward-e2e-console-'));
  let expired = false, downloads = 0;
  const consoleApp = await createConsole({ dataDir: directory, timers: false, staticDir: '/nonexistent',
    docker: new DockerClient({ socketPath: 'unused', image: 'unused', network: 'unused', consoleUrl: 'unused' }),
    incomingImageFetch: async () => { downloads++; return expired ? new Response('', { status: 403 }) : new Response(Buffer.from(pngBase64, 'base64')); } });
  t.after(async () => { await consoleApp.app.close(); await rm(directory, { recursive: true, force: true }); });
  await consoleApp.app.listen({ host: bindHost, port: 0 });
  const connection = consoleApp.db.createNapcatConnection({ name: 'Isolated', wsUrl: f.localWsUrl });
  const bot = consoleApp.db.createBot({ name: 'Example', targetType: 'group', targetId: '1001', connectionId: connection.id,
    config: { model: 'synthetic-model', baseUrl: f.modelUrl, modelApi: 'openai-responses', memoryEnabled: false,
      replyProbability: 0, imageTimeout: 2, voiceEnabled: false, allowCommands: false, allowFileWrites: false } });
  consoleApp.db.setDesiredState(bot.id, 'running'); consoleApp.db.setRuntime(bot.id, { state: 'starting' });
  await consoleApp.gateway.reconcile();
  await f.waitFor(() => consoleApp.gateway.getConnectionStatus(connection.id).online, 'mock NapCat login');
  f.broadcast({ ...f.event('forward-background', '', false), message: [{ type: 'forward', data: { id: 'resource-background' } }] });
  await f.waitFor(() => consoleApp.db.images.list(bot.id)[0]?.status === 'ready', 'nested image cached while Worker offline');
  expired = true;
  const environment = { CONSOLE_URL: `http://${requestHost}:${(consoleApp.app.server.address() as AddressInfo).port}`,
    BOT_INSTANCE_ID: bot.id, WORKER_TOKEN: bot.workerToken };
  const first = await f.start('1001', environment);
  await f.waitFor(() => consoleApp.db.images.list(bot.id).length === 0, 'Worker durably receives nested image');
  assert.equal(f.calls.length, 0, 'quoted mentions and commands cannot trigger a turn');
  assert.equal(f.read('1001', db => db.prepare('SELECT COUNT(*) n FROM control_commands').get()!.n), 0);
  await f.stop(first);
  await f.start('1001', environment);
  await f.waitFor(() => consoleApp.gateway.getBotStatus(bot.id).channelConnected, 'replacement Worker connected');
  f.broadcast({ ...f.event('forward-trigger', '', true), message: [
    { type: 'at', data: { qq: '999' } }, { type: 'forward', data: { id: 'resource-trigger' } },
  ] });
  await f.waitFor(() => f.complete(2), 'Pi completes after waiting for the current forward');
  assert.equal(downloads, 1); assert.equal(f.connections, 1);
  assert.deepEqual(requests, ['resource-background', 'resource-trigger']);
  assert.equal(f.read('1001', db => db.prepare("SELECT COUNT(*) n FROM chat_messages WHERE origin='human'").get()!.n), 2);
  assert.deepEqual(f.outgoing.filter(message => message.action === 'send_group_msg').flatMap(message => message.params.message
    .filter(segment => segment.type === 'text').map(segment => segment.data.text)), ['The forwarded discussion and picture are visible.']);
});
