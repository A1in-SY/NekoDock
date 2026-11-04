import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { BridgeStore } from '../src/store.js';
import { MemoryStore } from '../src/memory-store.js';
import { MemoryCoordinator } from '../src/memory-coordinator.js';
import { Processor } from '../src/processor.js';
import { handleIncomingEvent, busyReply } from '../src/incoming.js';
import type { MemoryConfig, MemoryRunner } from '../src/memory-contract.js';

const logger = { info() {}, warn() {}, error() {} };
const config: MemoryConfig = { enabled: true, dailyEnabled: false, dailyTime: '04:00', timezone: 'Asia/Shanghai', afterCompaction: true, recallTokens: 3000, model: '', baseUrl: '', embeddingProvider: 'none', embeddingBaseUrl: '', embeddingModel: '' };
async function until(check: () => boolean) { const end = Date.now() + 3000; while (!check()) { assert.ok(Date.now() < end, 'condition timeout'); await delay(5); } }
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'memory-coordinator-'));
  const bridge = new BridgeStore(join(directory, 'bridge.sqlite3'), { type: 'group', id: '1001' });
  const store = new MemoryStore(join(directory, 'bridge.sqlite3'));
  return { directory, bridge, store, cleanup() { store.close(); bridge.close(); rmSync(directory, { recursive: true, force: true }); } };
}
function source(bridge: BridgeStore, id = '1') {
  bridge.insert({ messageId: id, senderId: '2001', senderName: 'Example', time: Math.floor(Date.now()/1000), text: '我不吃香菜', replyTo: null, trigger: false, rawJson: '{}' });
}

test('blocked memory generation does not mark chat busy, suppress probability replies, or produce busy mentions', async () => {
  const f = fixture(); const abort = new AbortController(); const sent: string[] = [];
  let started = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const runner: MemoryRunner = { async runMemory(_batch, tools, signal) {
    started = true;
    await Promise.race([gate, new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))]);
    signal.throwIfAborted(); await tools.stage([]);
  } };
  const coordinator = new MemoryCoordinator({ store: f.store, config, runner, logger });
  const processor = new Processor({ store: f.bridge, agent: { async run() { return { messages: [{ type: 'text', text: 'normal reply' }] }; } },
    sender: { async sendText(text) { sent.push(text); return { messageId: 'ack' }; }, async sendImage() {}, async sendMessage() {} },
    logger, batchSize: 50, replyMaxChars: 1500, retryMs: 5, workspace: f.directory, imageMaxBytes: 1000, imageTimeoutMs: 1000 });
  const running = processor.run(abort.signal);
  try {
    source(f.bridge); coordinator.onCompacted({ session: '/synthetic-session', entryId: 'entry-1' });
    await until(() => started);
    assert.equal(coordinator.processing, true); assert.equal(f.bridge.isBusy(), false); assert.equal(processor.isProcessing, false);
    const input = { target: { type: 'group' as const, id: '1001' }, store: f.bridge, processor,
      sender: { async sendText(text: string) { sent.push(text); }, async sendImage() {}, async sendMessage() {} }, logger,
      signal: abort.signal, randomReplyProbability: 1, random: () => 0 };
    handleIncomingEvent({ post_type: 'message', message_type: 'group', group_id: 1001, self_id: 999, message_id: 2, user_id: 2001, time: Math.floor(Date.now()/1000), message: [{type:'text',data:{text:'ordinary question'}}] }, input);
    await until(() => sent.length === 1); await until(() => !f.bridge.isBusy());
    handleIncomingEvent({ post_type: 'message', message_type: 'group', group_id: 1001, self_id: 999, message_id: 3, user_id: 2001, time: Math.floor(Date.now()/1000), message: [{type:'at',data:{qq:'999'}},{type:'text',data:{text:'another question'}}] }, input);
    await until(() => sent.length === 2);
    assert.deepEqual(sent, ['normal reply','normal reply']); assert.ok(!sent.includes(busyReply));
    assert.equal(coordinator.processing, true);
    assert.ok(f.bridge.recorder.pending().every(event => !event.type.startsWith('memory.')));
    release(); await until(() => !coordinator.processing);
  } finally { release(); abort.abort(); await running; await coordinator.close(); f.cleanup(); }
});

test('daily and compaction triggers coalesce; publication advances the cursor only after the isolated agent stages successfully', async () => {
  const f = fixture(); let calls = 0;
  const now = Date.parse('2026-04-10T04:01:00+08:00');
  const coordinator = new MemoryCoordinator({ store: f.store, config: { ...config, dailyEnabled: true }, now: () => now, logger,
    runner: { async runMemory(batch, tools, _signal, observer) { calls++; assert.equal(f.store.cursor(), 0); observer?.({type:'usage.recorded',payload:{usageId:'example-usage',input_tokens:100,cached_input_tokens:20,output_tokens:5,total_tokens:105}}); await tools.stage([{ operation:'upsert',scope:'person',subjectUserId:'2001',kind:'preference',topic:'饮食',content:'不吃香菜',sources:[{sourceSeq:batch.sources[0]!.seq,quote:'我不吃香菜'}] }]); } } });
  try {
    source(f.bridge); coordinator.onCompacted({session:'/synthetic',entryId:'entry-2'}); await coordinator.tick();
    await until(() => f.store.cursor() === f.store.highWater());
    await coordinator.tick(); assert.equal(calls, 1); assert.equal(f.store.search({query:'香菜'}).length, 1);
    assert.equal(f.store.view().jobs.filter(job => job.status === 'completed').length, 1);
    assert.equal(f.store.view().events.find(event=>event.type==='usage.recorded')?.payload.input_tokens,100);
    assert.ok(f.bridge.recorder.pending().every(event=>event.type!=='usage.recorded'));
  } finally { await coordinator.close(); f.cleanup(); }
});

test('shutdown cancels only the memory child, preserving the uncommitted range for recovery', async () => {
  const f = fixture(); let started = false;
  const coordinator = new MemoryCoordinator({ store:f.store,config,logger,runner:{async runMemory(_batch,_tools,signal){started=true;await new Promise<never>((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));}} });
  try {
    source(f.bridge); coordinator.onCompacted({session:'/synthetic',entryId:'entry-3'}); await until(()=>started);
    await coordinator.close(); assert.equal(f.store.cursor(), 0); assert.equal(f.store.view().jobs[0]!.status,'pending'); assert.equal(f.bridge.isBusy(),false);
  } finally { await coordinator.close(); f.cleanup(); }
});

test('memory service failures do not reject tick or publish partial changes', async () => {
  const f=fixture(); const coordinator=new MemoryCoordinator({store:f.store,config,logger,runner:{async runMemory(_input,tools){await tools.stage([]);throw new Error('provider private body');}},fetchControls:async()=>{throw new Error('offline');},report:async()=>{throw new Error('offline');}});
  try {source(f.bridge);coordinator.onCompacted({session:'/synthetic',entryId:'entry-4'});await coordinator.tick();await until(()=>f.store.view().jobs[0]?.error!==null);assert.equal(f.store.cursor(),0);assert.equal(f.store.search({}).length,0);assert.ok(!JSON.stringify(f.store.view()).includes('provider private body'));}
  finally {await coordinator.close();f.cleanup();}
});

test('invalid evidence is rejected during staging and a corrected full batch publishes only once',async()=>{
  const f=fixture();let rejectionSeen=false;
  const coordinator=new MemoryCoordinator({store:f.store,config,logger,runner:{async runMemory(batch,tools){
    const proposal={operation:'upsert' as const,scope:'person' as const,subjectUserId:'2001',kind:'preference' as const,topic:'饮食/香菜',content:'不吃香菜',sources:[{sourceSeq:batch.sources[0]!.seq,quote:'我不吃香菜'}]};
    await assert.rejects(tools.stage([{...proposal,sources:[{sourceSeq:proposal.sources[0]!.sourceSeq,quote:'不存在的原话'}]}]),error=>{assert.match((error as Error).message,/MEMORY_QUOTE_MISMATCH/);assert.match((error as Error).message,/changeIndex=0/);return true;});
    rejectionSeen=true;assert.equal(f.store.cursor(),0);assert.equal(f.store.search().length,0);
    await tools.stage([proposal]);assert.equal(f.store.search().length,0,'validation must not publish');
  }}});
  try{source(f.bridge);coordinator.onCompacted({session:'/synthetic',entryId:'correction'});await until(()=>f.store.cursor()===f.store.highWater());assert.ok(rejectionSeen);assert.equal(f.store.search().length,1);const event=f.store.view().events.find(e=>e.type==='memory.validation.failed');assert.equal(event?.payload.changeIndex,0);assert.equal(event?.payload.code,'MEMORY_QUOTE_MISMATCH');assert.ok(!JSON.stringify(event).includes('不存在的原话'));}
  finally{await coordinator.close();f.cleanup();}
});

test('a new staged batch replaces the previous candidate set and failed staging never leaves an accepted batch',async()=>{
  const f=fixture();const coordinator=new MemoryCoordinator({store:f.store,config,logger,runner:{async runMemory(batch,tools){
    const item={operation:'upsert' as const,scope:'person' as const,subjectUserId:'2001',kind:'preference' as const,topic:'饮食/香菜',content:'不吃香菜',sources:[{sourceSeq:batch.sources[0]!.seq,quote:'我不吃香菜'}]};
    await tools.stage([item]);await tools.stage([]);
  }}});
  try{source(f.bridge);coordinator.onCompacted({session:'/synthetic',entryId:'replace'});await until(()=>f.store.cursor()===f.store.highWater());assert.equal(f.store.search().length,0);}
  finally{await coordinator.close();f.cleanup();}
});
