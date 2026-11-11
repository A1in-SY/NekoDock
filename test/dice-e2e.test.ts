import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import type { ServerResponse } from 'node:http';
import type WebSocket from 'ws';
import { createConsole } from '../src/console/server.js';
import { DockerClient } from '../src/console/docker.js';
import { DICE_USAGE } from '../src/plugins/dice/dice.js';
import { assertAccepted, bindHost, busyReply, delay, piFixture, requestHost, respond, sendReply,
  type ModelCall, type Outgoing } from './fixtures/pi-e2e.js';

for (const targetType of ['group', 'private'] as const) {
  test(`managed ${targetType} dice commands retain valid and invalid chat facts without Jev or extra model turns`, { timeout: 50_000 }, async t => {
    let heldTurn: { call: ModelCall; response: ServerResponse } | undefined;
    let normalTurns = 0;
    const f = await piFixture(t, (call, response) => {
      if (call.results.length) { assertAccepted(call); respond(call, response, 'Done.'); return; }
      normalTurns++;
      if (normalTurns === 1) {
        assert.deepEqual(call.replyTargetMessageIds, ['question']);
        for (const id of ['dice-closed', 'dice-invalid', 'dice-default']) {
          assert.ok(call.batch.some(message => message.messageId === id && message.origin === 'human'), id);
        }
        const replies = call.batch.filter(message => message.origin === 'plugin');
        assert.equal(replies.length, 3);
        assert.ok(replies.every(message => message.role === 'assistant' && message.pluginId === 'dice'));
        assert.ok(replies.some(message => message.text === DICE_USAGE && message.replyTo === 'dice-invalid'));
        assert.ok(replies.some(message => message.text === '🎲 骰子结果：8（范围 8～8）' && message.replyTo === 'dice-closed'));
        assert.doesNotMatch(JSON.stringify(call.body), /externalEvents|"reply_0"|"noul"/);
        heldTurn = { call, response };
      } else {
        assert.deepEqual(call.replyTargetMessageIds, ['follow-up']);
        assert.ok(call.batch.some(message => message.messageId === 'dice-busy' && message.text.endsWith('/dice 4 4')));
        assert.ok(call.batch.some(message => message.origin === 'plugin' && message.text === '🎲 骰子结果：4（范围 4～4）'));
        sendReply(call, response, [{ type: 'text', text: 'Your last dice result was 4.' }]);
      }
    });
    const directory = await mkdtemp(join(tmpdir(), 'nekodock-dice-e2e-'));
    const consoleApp = await createConsole({ dataDir: directory, timers: false, staticDir: '/nonexistent',
      docker: new DockerClient({ socketPath: 'unused', image: 'unused', network: 'unused', consoleUrl: 'unused' }) });
    t.after(async () => { await consoleApp.app.close(); await rm(directory, { recursive: true, force: true }); });
    await consoleApp.app.listen({ host: bindHost, port: 0 });
    const port = (consoleApp.app.server.address() as AddressInfo).port;
    const connection = consoleApp.db.createNapcatConnection({ name: 'Isolated dice fixture', wsUrl: f.localWsUrl });
    const bot = consoleApp.db.createBot({ name: 'Synthetic dice bot', targetType, targetId: '1001', connectionId: connection.id,
      config: { model: 'synthetic-chat', baseUrl: f.modelUrl, modelApi: 'openai-responses', memoryEnabled: false,
        replyMode: 'jev', replyProbability: 100, replyJudgeBaseUrl: f.modelUrl, replyJudgeModel: 'synthetic-judge',
        replyJudgeApiKey: 'isolated-judge-key', voiceEnabled: false, allowCommands: false, allowFileWrites: false } });
    assert.equal(consoleApp.db.plugins.view(bot.id, 'dice').enabled, false);
    consoleApp.db.plugins.update(bot.id, 'dice', { expectedRevision: 0, enabled: true });
    consoleApp.db.setDesiredState(bot.id, 'running'); consoleApp.db.setRuntime(bot.id, { state: 'starting' });
    await consoleApp.gateway.reconcile();
    await f.waitFor(() => consoleApp.gateway.getConnectionStatus(connection.id).online, 'mock QQ login');
    const worker = await f.start('1001', { CONSOLE_URL: `http://${requestHost}:${port}`, BOT_INSTANCE_ID: bot.id, WORKER_TOKEN: bot.workerToken });
    await f.waitFor(() => consoleApp.gateway.getBotStatus(bot.id).channelConnected, 'managed Worker transport');
    const send = (id: string, text: string, mention = false) => {
      const event = f.event(id, text, mention);
      f.broadcast(targetType === 'private' ? { ...event, message_type: 'private', group_id: undefined, user_id: '1001' } : event);
    };
    const text = (message: Outgoing) => message.params.message.filter(segment => segment.type === 'text').map(segment => segment.data.text).join('');
    const diceMessages = () => f.outgoing.filter(message => text(message).startsWith('🎲') || text(message) === DICE_USAGE);
    let heldDelivery: { message: Outgoing; socket: WebSocket } | undefined;
    f.onSend = (message, socket) => {
      if (text(message).includes('范围 8～8')) { heldDelivery = { message, socket }; return false; }
    };
    send('dice-closed', '/dice 8 8');
    await f.waitFor(() => !!heldDelivery, 'first dice reply reaches mock QQ');
    assert.equal(f.read('1001', db => db.prepare("SELECT COUNT(*) n FROM chat_messages WHERE origin='plugin'").get()!.n), 0,
      'unacknowledged dice text is not an actual chat fact');
    send('dice-invalid', '/dice 1,6', true);
    send('dice-default', '/dice');
    heldDelivery!.socket.send(JSON.stringify({ echo: heldDelivery!.message.echo, status: 'ok', retcode: 0, data: { message_id: 1 } }));
    await f.waitFor(() => f.read('1001', db => db.prepare("SELECT COUNT(*) n FROM chat_messages WHERE origin='plugin'").get()!.n) === 3,
      'valid and invalid dice replies become durable chat facts');
    assert.equal(f.calls.length, 0, 'neither the chat model nor Jev is called for dice commands');
    assert.ok(diceMessages().every(message => message.params.message.some(segment => segment.type === 'reply')),
      'all dice replies quote real source messages');
    if (targetType === 'private') assert.ok(diceMessages().every(message => message.action === 'send_private_msg'));
    send('dice-default', '/dice');
    await delay(150);
    assert.equal(diceMessages().length, 3, 'duplicate QQ delivery never rolls or sends twice');
    assert.equal(consoleApp.db.plugins.claim(), null, 'local commands never create Runner work');
    send('question', 'What did I roll?', true);
    await f.waitFor(() => !!heldTurn, 'normal chat includes the command and confirmed reply facts');
    send('dice-busy', '/dice 4 4', true);
    await f.waitFor(() => f.read('1001', db => db.prepare("SELECT COUNT(*) n FROM chat_messages WHERE qq_message_id='dice-busy'").get()!.n) === 1,
      'busy command is saved immediately');
    assert.equal(diceMessages().length, 3, 'busy dice delivery waits for the active model turn');
    assert.ok(f.outgoing.every(message => text(message) !== busyReply), 'a plugin command never emits the model busy notice');
    sendReply(heldTurn!.call, heldTurn!.response, [{ type: 'text', text: 'The dice results are in the chat.' }]);
    await f.waitFor(() => diceMessages().length === 4, 'queued dice reply is sent after the model turn');
    await f.waitFor(() => f.read('1001', db => db.prepare("SELECT COUNT(*) n FROM chat_messages WHERE origin='plugin'").get()!.n) === 4,
      'busy dice reply is recorded after ACK');
    send('follow-up', 'And the last roll?', true);
    await f.waitFor(() => f.complete(6), 'next model turn includes the busy command and result');
    assert.equal(normalTurns, 2);
    assert.equal(diceMessages().length, 4);
    assert.equal(consoleApp.db.plugins.view(bot.id, 'dice').jobs.length, 4);
    send('help', '/help');
    await f.waitFor(() => f.outgoing.some(message => text(message).includes('/dice —')), 'enabled dice appears in Worker help');
    await f.stop(worker);
    const restarted = await f.start('1001', { CONSOLE_URL: `http://${requestHost}:${port}`, BOT_INSTANCE_ID: bot.id, WORKER_TOKEN: bot.workerToken });
    await f.waitFor(() => consoleApp.gateway.getBotStatus(bot.id).channelConnected, 'restarted Worker transport');
    send('dice-default', '/dice');
    await delay(150);
    assert.equal(diceMessages().length, 4, 'Worker restart preserves the original command result and delivery');
    assert.equal(normalTurns, 2);
    await f.stop(restarted);
  });
}
