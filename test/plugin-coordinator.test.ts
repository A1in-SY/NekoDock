import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeStore } from '../src/store.js';
import { PluginCoordinator } from '../src/plugin-coordinator.js';
import { handleIncomingEvent } from '../src/incoming.js';
import type { PluginResult } from '../src/plugin-contract.js';

const logger = { info() {}, warn() {}, error() {} };
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'plugin-worker-'));
  const store = new BridgeStore(join(directory, 'bridge.sqlite3'), { type: 'group', id: '1001' });
  const signal = new AbortController();
  return { directory, store, signal, identity: { url: 'http://console.invalid', botId: 'example', token: 'synthetic', dataDir: directory },
    close() { signal.abort(); store.close(); rmSync(directory, { recursive: true, force: true }); } };
}
function incoming(id: string, text = 'share', trigger = false) { return { messageId: id, senderId: '2001', senderName: 'Example', time: 1, text, replyTo: null, trigger, rawJson: '{}' }; }

test('content plugin commands are chat facts without a second model trigger or busy acknowledgement', () => {
  const f = fixture(); let sent = 0;
  try {
    f.store.insert(incoming('busy', 'current work', true));
    handleIncomingEvent({ post_type: 'message', message_type: 'group', group_id: 1001, message_id: 'request', user_id: 2001, self_id: 3001, time: 1,
      message: [{ type: 'at', data: { qq: '3001' } }, { type: 'text', data: { text: '/bili info BV1234567890' } }] }, {
      target: { type: 'group', id: '1001' }, randomReplyProbability: 1, store: f.store, processor: { notify() {} },
      sender: { async sendText() { sent++; } }, logger, signal: f.signal.signal,
      dispatch: { pluginId: 'bilibili', command: 'info', args: 'BV1234567890', sourceMessageId: 'request', contextPolicy: 'chat', executor: 'console' },
    });
    assert.equal(f.store.getMessage('request')?.trigger, false);
    assert.equal(f.store.chatMessageForQQ('request')?.origin, 'human');
    assert.equal(sent, 0);
  } finally { f.close(); }
});

test('plugin results bind to the source conversation and merge all shared resources idempotently', async () => {
  const f = fixture(); const requests: Array<{ path: string; body: any }> = [];
  f.store.insert(incoming('source'));
  const conversationId = f.store.recorder.conversationId;
  const content = (resourceId: string) => ({ type: 'video' as const, platform: 'bilibili' as const, resourceId, url: 'https://www.bilibili.com/video/BV1234567890', title: resourceId, part: 1, retrieval: { status: 'ready' as const } });
  const results: PluginResult[] = ['one', 'two'].map((id, index) => ({ id, kind: 'enrichment', pluginId: 'bilibili', sourceMessageId: 'source', conversationId, revision: index + 1, content: content(id) }));
  const coordinator = new PluginCoordinator({ identity: f.identity, store: f.store, logger, notify() {}, request: async (path, body) => {
    requests.push({ path, body }); return path === 'plugins' ? { results, commands: [], pendingBindings: ['source'], pendingSources: [] } : {};
  } }, f.signal.signal);
  try {
    coordinator.register('source'); await coordinator.synchronize();
    const version = f.store.chatMessageForQQ('source')!.revision;
    await coordinator.synchronize();
    assert.equal(f.store.chatMessageForQQ('source')!.contents?.length, 2);
    assert.equal(f.store.chatMessageForQQ('source')!.revision, version);
    const bind = requests.find(r => r.path === 'plugins/sync')!.body;
    assert.deepEqual(bind.bindings, [{ messageId: 'source', conversationId }]);
    assert.ok(requests.some(r => r.path === 'plugins/sync' && r.body.acknowledgements.includes('two')));
  } finally { await coordinator.close(); f.close(); }
});

test('confirmed plugin output survives acknowledgement loss without another send or duplicate chat message', async () => {
  const f = fixture(); f.store.insert(incoming('source'));
  const conversationId = f.store.recorder.conversationId;
  let result: PluginResult = { id: 'output', kind: 'reply', pluginId: 'bilibili', sourceMessageId: 'source', conversationId, revision: 1, text: 'Video information.', deliveryId: 'plugin-output' };
  let sends = 0;
  const coordinator = new PluginCoordinator({ identity: f.identity, store: f.store, logger, notify() {},
    request: async path => path === 'plugins' ? { results: [result], commands: [] } : {},
    send: async () => { sends++; result = { ...result, delivery: { status: 'acknowledged', messageId: '901001' } }; return { ok: true, messageId: '901001' }; },
  }, f.signal.signal);
  try {
    await coordinator.synchronize(); assert.equal(coordinator.hasPending, true);
    await coordinator.runNext(f.signal.signal); await coordinator.synchronize();
    assert.equal(sends, 1); assert.equal(coordinator.hasPending, false);
    assert.equal(f.store.chatMessageForQQ('901001')?.text, 'Video information.');
    assert.equal(f.store.chatMessageForQQ('901001')?.replyTo, 'source');
    assert.equal(f.store.recorder.pending().filter(event => event.type === 'plugin.message.sent').length, 1);
  } finally { await coordinator.close(); f.close(); }
});

for (const recovered of [false, true]) test(`standalone plugin video retains its source without a quote after ${recovered ? 'delivery recovery' : 'sending'}`, async () => {
  const f = fixture(); f.store.insert(incoming('source'));
  const result: PluginResult = { id: 'video-output', kind: 'video', pluginId: 'bilibili', sourceMessageId: 'source', replyTo: null,
    conversationId: f.store.recorder.conversationId, revision: 1, assetId: 'video-asset',
    ...(recovered ? { delivery: { status: 'acknowledged' as const, messageId: '901002' } } : {}) };
  let sends = 0;
  const coordinator = new PluginCoordinator({ identity: f.identity, store: f.store, logger, notify() {},
    request: async path => path === 'plugins' ? { results: [result], commands: [] } : {},
    send: async () => { sends++; return { ok: true, messageId: '901002', asset: { id: 'video-asset', type: 'video', status: 'ready' } }; },
  }, f.signal.signal);
  try {
    await coordinator.synchronize();
    if (!recovered) await coordinator.runNext(f.signal.signal);
    const chat = f.store.chatMessageForQQ('901002')!;
    assert.equal(chat.replyTo, null); assert.equal(chat.sourceMessageId, 'source');
    assert.equal(chat.assets?.[0]?.type, 'video');
    const event = f.store.recorder.pending().find(event => event.type === 'plugin.message.sent')!;
    assert.equal(event.payload.replyTo, null); assert.equal(event.payload.sourceMessageId, 'source');
    assert.equal(sends, recovered ? 0 : 1);
  } finally { await coordinator.close(); f.close(); }
});

test('an acknowledged legacy video keeps its actual quote when recovered', async () => {
  const f = fixture(); f.store.insert(incoming('source'));
  const result: PluginResult = { id: 'legacy-video', kind: 'video', pluginId: 'bilibili', sourceMessageId: 'source', replyTo: 'source',
    conversationId: f.store.recorder.conversationId, revision: 1, assetId: 'video-asset', delivery: { status: 'acknowledged', messageId: '901003' } };
  const coordinator = new PluginCoordinator({ identity: f.identity, store: f.store, logger, notify() {},
    request: async path => path === 'plugins' ? { results: [result], commands: [] } : {},
  }, f.signal.signal);
  try {
    await coordinator.synchronize();
    assert.equal(f.store.chatMessageForQQ('901003')?.replyTo, 'source');
  } finally { await coordinator.close(); f.close(); }
});

for (const recovered of [false, true]) test(`an unsent legacy video uses the host-confirmed quote after ${recovered ? 'ACK recovery' : 'direct sending'}`, async () => {
  const f = fixture(); f.store.insert(incoming('source'));
  const result: PluginResult = { id: 'previously-queued-video', kind: 'video', pluginId: 'bilibili', sourceMessageId: 'source',
    replyTo: recovered ? null : 'source', conversationId: f.store.recorder.conversationId, revision: 1, assetId: 'video-asset',
    ...(recovered ? { delivery: { status: 'acknowledged' as const, messageId: '901004' } } : {}) };
  let sends=0;
  const coordinator = new PluginCoordinator({ identity: f.identity, store: f.store, logger, notify() {},
    request: async path => path === 'plugins' ? { results: [result], commands: [] } : {},
    send: async queued => {
      sends++; assert.equal(queued.replyTo,'source');
      return { ok:true,messageId:'901004',replyTo:null,asset:{id:'video-asset',type:'video',status:'ready'} };
    },
  }, f.signal.signal);
  try {
    await coordinator.synchronize();if(!recovered)await coordinator.runNext(f.signal.signal);
    const chat=f.store.chatMessageForQQ('901004')!;
    assert.equal(chat.replyTo,null);assert.equal(chat.sourceMessageId,'source');
    const event=f.store.recorder.pending().find(event=>event.type==='plugin.message.sent')!;
    assert.equal(event.payload.replyTo,null);assert.equal(event.payload.sourceMessageId,'source');
    assert.equal(sends,recovered?0:1);
  } finally {await coordinator.close();f.close();}
});

test('new conversation cancels an old queued plugin send without changing its source identity', async () => {
  const f = fixture(); f.store.insert(incoming('source'));
  const conversationId = f.store.recorder.conversationId;
  let sent = 0;
  const coordinator = new PluginCoordinator({ identity: f.identity, store: f.store, logger, notify() {},
    request: async path => path === 'plugins' ? { results: [{ id: 'output', kind: 'video', pluginId: 'bilibili', sourceMessageId: 'source', conversationId, revision: 1, assetId: 'asset' }], commands: [] } : {},
    send: async () => { sent++; return { ok: true }; },
  }, f.signal.signal);
  try {
    await coordinator.synchronize();
    f.store.insert({ ...incoming('reset'), command: 'new' });
    f.store.resetSessionForCommand(f.store.getPendingCommand()!.id);
    assert.notEqual(f.store.recorder.conversationId, conversationId);
    await coordinator.runNext(f.signal.signal);
    assert.equal(sent, 0); assert.equal(f.store.chatMessageForQQ('source')?.conversationId, conversationId);
  } finally { await coordinator.close(); f.close(); }
});

test('a cached result for a moved queued source waits for host migration without cancelling or sending', async () => {
  const f = fixture();
  f.store.insert({ ...incoming('reset'), command: 'new' });f.store.insert(incoming('source'));
  let result: PluginResult = { id: 'moving-output', kind: 'reply', pluginId: 'bilibili', sourceMessageId: 'source',
    conversationId: f.store.recorder.conversationId, revision: 1, text: 'Synthetic reply' };
  const requests: string[] = [];let sent = 0,delayedSync=false;
  const coordinator = new PluginCoordinator({ identity: f.identity, store: f.store, logger, notify() {},
    request: async (path,body) => {
      requests.push(path);assert.deepEqual((body as {acknowledgements?:string[]}|undefined)?.acknowledgements??[],[]);
      if(delayedSync&&path==='plugins/sync')throw new Error('插件消息所属会话已确定');
      return path === 'plugins' ? { results: [result], commands: [] } : {};
    },
    send: async () => {sent++;return {ok:true};},
  }, f.signal.signal);
  try {
    await coordinator.synchronize();assert.equal(coordinator.hasPending,true);
    f.store.resetSessionForCommand(f.store.getPendingCommand()!.id);delayedSync=true;
    await coordinator.runNext(f.signal.signal);
    assert.equal(sent,0);assert.ok(requests.every(path=>!path.endsWith('/cancel')));
    assert.equal(coordinator.hasPending,false);
    delayedSync=false;result={...result,conversationId:f.store.recorder.conversationId};
    await coordinator.synchronize();assert.equal(coordinator.hasPending,true);
    await coordinator.runNext(f.signal.signal);assert.equal(sent,1);
    assert.equal(f.store.chatMessageForQQ('source')!.conversationId,result.conversationId);
  } finally {await coordinator.close();f.close();}
});

test('transport uncertainty polls the stable host delivery instead of sending again', async () => {
  const f = fixture(); f.store.insert(incoming('source'));
  const conversationId = f.store.recorder.conversationId; let sends = 0;
  const result: PluginResult = { id: 'output', kind: 'reply', pluginId: 'bilibili', sourceMessageId: 'source', conversationId, revision: 1, text: 'reply' };
  const coordinator = new PluginCoordinator({ identity: f.identity, store: f.store, logger, notify() {},
    request: async path => path === 'plugins' ? { results: [result], commands: [] } : {},
    send: async () => { sends++; throw new Error('Channel closed after transmit'); },
  }, f.signal.signal);
  try { await coordinator.synchronize(); await coordinator.runNext(f.signal.signal); await coordinator.synchronize(); assert.equal(coordinator.hasPending, false); assert.equal(sends, 1); }
  finally { await coordinator.close(); f.close(); }
});

test('unresolved old sources cannot starve a later known source binding', async () => {
  const f = fixture(); f.store.insert(incoming('known'));
  const bindings: any[] = [];
  const coordinator = new PluginCoordinator({ identity: f.identity, store: f.store, logger, notify() {},
    request: async (path, body) => { if (path === 'plugins/sync') bindings.push(...(body as any).bindings); return path === 'plugins' ? { results: [], commands: [] } : {}; },
  }, f.signal.signal);
  try {
    for (let i = 0; i < 201; i++) coordinator.register(`missing-${i}`);
    coordinator.register('known'); await coordinator.synchronize();
    assert.ok(bindings.some(binding => binding.messageId === 'known'));
  } finally { await coordinator.close(); f.close(); }
});

test('expired plugin outputs are cancelled at the host before their results are acknowledged', async () => {
  const f = fixture(); f.store.insert(incoming('source'));
  const paths: string[] = []; let terminal = false;
  const result: PluginResult = { id: 'expired', kind: 'video', pluginId: 'bilibili', sourceMessageId: 'source', conversationId: f.store.recorder.conversationId,
    revision: 1, assetId: 'asset', expiresAt: Date.now() - 1000 };
  const coordinator = new PluginCoordinator({ identity: f.identity, store: f.store, logger, notify() {}, request: async (path, body) => {
    paths.push(path);
    if (path.endsWith('/cancel')) { terminal = true; return { cancelled: true }; }
    if (path === 'plugins/sync' && (body as any).acknowledgements.includes('expired')) assert.equal(terminal, true);
    return path === 'plugins' ? { results: [terminal ? { ...result, delivery: { status: 'failed', code: 'PLUGIN_SEND_EXPIRED' } } : result], commands: [] } : {};
  } }, f.signal.signal);
  try { await coordinator.synchronize(); await coordinator.runNext(f.signal.signal); await coordinator.synchronize(); assert.ok(paths.includes('plugins/expired/cancel')); }
  finally { await coordinator.close(); f.close(); }
});
