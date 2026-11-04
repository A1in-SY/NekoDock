import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { createConsole } from '../src/console/server.js';
import { DockerClient } from '../src/console/docker.js';
import { assertAccepted, piFixture, pngBase64, respond, sendReply, requestHost, bindHost } from './fixtures/pi-e2e.js';

test('managed ingress snapshots untriggered images offline and Pi reads them after source expiry and Worker replacement', { timeout: 65_000 }, async t => {
  const f = await piFixture(t, (call, response) => {
    if (call.results.length) { assertAccepted(call); respond(call, response, 'Internal completion.'); return; }
    assert.deepEqual(call.batch.map(message => message.messageId), ['image-background', 'later-trigger']);
    assert.deepEqual(call.replyTargetMessageIds, ['later-trigger']);
    assert.deepEqual(call.images, [`data:image/png;base64,${pngBase64}`]);
    assert.match(call.batch[0]!.images![0]!.path, /\.qq-images\/[a-f0-9]{64}\.png$/);
    assert.doesNotMatch(JSON.stringify(call.body), /signed-image-token|images\.invalid/);
    sendReply(call, response, [{ type: 'text', text: 'Cached image received.' }]);
  });
  const directory = await mkdtemp(join(tmpdir(), 'managed-image-e2e-console-'));
  let expired = false, downloads = 0;
  const consoleApp = await createConsole({ dataDir: directory, timers: false, staticDir: '/nonexistent',
    docker: new DockerClient({ socketPath: 'unused', image: 'unused', network: 'unused', consoleUrl: 'unused' }),
    incomingImageFetch: async input => {
      assert.equal(String(input), 'https://images.invalid/photo?token=signed-image-token'); downloads++;
      return expired ? new Response('', { status: 403 }) : new Response(Buffer.from(pngBase64, 'base64'));
    } });
  t.after(async () => { await consoleApp.app.close(); await rm(directory, { recursive: true, force: true }); });
  await consoleApp.app.listen({ host: bindHost, port: 0 });
  const connection = consoleApp.db.createNapcatConnection({ name: 'Isolated', wsUrl: f.localWsUrl });
  const bot = consoleApp.db.createBot({ name: 'Example', targetType: 'group', targetId: '1001', connectionId: connection.id,
    config: { model: 'synthetic-model', baseUrl: f.modelUrl, modelApi: 'openai-responses', memoryEnabled: false,
      replyProbability: 0, imageTimeout: 2, voiceEnabled: false, allowCommands: false, allowFileWrites: false } });
  consoleApp.db.setDesiredState(bot.id, 'running'); consoleApp.db.setRuntime(bot.id, { state: 'starting' });
  await consoleApp.gateway.reconcile();
  await f.waitFor(() => consoleApp.gateway.getConnectionStatus(connection.id).online, 'mock QQ login');
  const background = f.event('image-background', '', false);
  f.broadcast({ ...background, message: [{ type: 'image', data: { url: 'https://images.invalid/photo?token=signed-image-token' } }] });
  await f.waitFor(() => consoleApp.db.images.list(bot.id)[0]?.status === 'ready', 'Console prefetch while Worker offline');
  assert.equal(f.calls.length, 0); assert.equal(f.outgoing.length, 0); expired = true;
  const environment = { CONSOLE_URL: `http://${requestHost}:${(consoleApp.app.server.address() as AddressInfo).port}`,
    BOT_INSTANCE_ID: bot.id, WORKER_TOKEN: bot.workerToken };
  const first = await f.start('1001', environment);
  await f.waitFor(() => consoleApp.db.images.list(bot.id).length === 0, 'Worker confirms durable image transfer');
  assert.equal(consoleApp.db.pendingNapcatEventCount(bot.id), 0); assert.equal(f.calls.length, 0);
  assert.ok(existsSync(join(f.dataPath(), 'bridge.sqlite3')));
  await f.stop(first);
  await f.start('1001', environment);
  await f.waitFor(() => consoleApp.gateway.getBotStatus(bot.id).channelConnected, 'replacement Worker connected');
  f.send('later-trigger', 'What was in that picture?');
  await f.waitFor(() => f.complete(2), 'Pi completes using persisted image');
  assert.equal(downloads, 1);
  assert.deepEqual(f.outgoing.flatMap(message => message.params.message.filter(segment => segment.type === 'text').map(segment => segment.data.text)), ['Cached image received.']);
  await f.waitFor(() => consoleApp.db.getConversation(bot.id)?.items.some(item => item.type === 'message.images.updated' &&
    (item.payload.images as Array<{ status: string }>).some(image => image.status === 'ready')) ?? false, 'attachment events uploaded');
});
