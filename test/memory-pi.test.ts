import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { PiRunner, type PiRunnerOptions } from '../src/pi.js';
import { boundMemoryToolResult, injectRecalledMemory } from '../src/pi-memory.js';
import { CHECKPOINT_HEADINGS, validateChatCheckpoint } from '../src/pi-compaction.js';
import type { MemoryBatch, MemoryProposal } from '../src/memory-contract.js';
import type { PendingBatch, RunObservation } from '../src/types.js';
import { decodeModelCall, respond, type ModelCall } from './fixtures/pi-e2e.js';

const incoming = (text = 'a current question', replyAllowed = true): PendingBatch => ({ throughSeq: 1,
  messages: [{ seq: 1, messageId: 'example-message', senderId: '101', senderName: 'Example user', time: 123,
    text, replyTo: null, trigger: replyAllowed, rawJson: '{}' }], replyAllowed, replies: null, nextReplyIndex: 0 });
const memoryBatch: MemoryBatch = { jobId: 'example-job', fromSeq: 0, throughSeq: 1, sources: [
  {seq:1,id:'incoming:example-message',messageId:'example-message',senderId:'101',senderName:'Example user',role:'user',time:123000,text:'I prefer tea.'},
], memories: [], now: 124000 };
const checkpoint = CHECKPOINT_HEADINGS.map(heading => `## ${heading}\nNone.`).join('\n\n');
const textOf = (message: any) => typeof message.content === 'string' ? message.content
  : (message.content ?? []).filter((part: any) => ['text','input_text'].includes(part.type)).map((part: any) => part.text).join('');

async function fixture(handler: (call: ModelCall, response: ServerResponse, count: number) => void | Promise<void>, overrides: Partial<PiRunnerOptions> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'memory-pi-')); const home = join(dir, 'pi'); const workspace = join(dir, 'workspace');
  await mkdir(home); await mkdir(workspace);
  const calls: ModelCall[] = [];
  const server = createServer((request, response) => { void (async () => {
    let raw = ''; for await (const chunk of request) raw += String(chunk);
    const call = decodeModelCall(request.url ?? '', request.headers.authorization, JSON.parse(raw)); calls.push(call);
    await handler(call, response, calls.length);
  })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end('{}'); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const options: PiRunnerOptions = { home, workspace, timeoutMs: 15000, logger: { info() {}, warn() {}, error() {} },
    model: 'example-model', baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'example-test-key', api: 'openai-completions',
    contextWindow: 200000, compactLimit: 160000, maxOutputTokens: 8192, supportsImages: false, supportsReasoning: false,
    allowCommands: true, allowFileWrites: true, persona: 'A synthetic persona that must not enter consolidation.', targetType: 'group', ...overrides };
  const runner = new PiRunner(options); let session: string | null = null;
  return { dir, home, workspace, calls, options, runner, get session() { return session; },
    run: (batch = incoming(), observer?: (event: RunObservation) => void) => runner.run(batch, session, id => {session=id;}, new AbortController().signal, {send:async()=>({accepted:true})}, observer),
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); } };
}

test('memory consolidation uses its own system, only dedicated tools, explicit staging and no persisted chat session', async () => {
  const f = await fixture((call,response,count) => respond(call,response,count===1
    ? [{name:'stage_memory_changes',arguments:{changes:[]}}] : 'Consolidation complete.'));
  try {
    let staged = 0; const events: RunObservation[] = [];
    await f.runner.runMemory(memoryBatch, { history:async()=>({messages:[]}),search:async()=>({items:[]}),stage:async changes=>{assert.deepEqual(changes,[]);staged++;} }, new AbortController().signal, event=>events.push(event));
    assert.equal(staged,1); assert.equal(f.calls.length,1);
    assert.deepEqual(f.calls[0]!.body.tools.map((tool:any)=>tool.function.name).sort(),['read_chat_history','search_memory','stage_memory_changes']);
    assert.match(JSON.stringify(f.calls[0]!.body.messages),/background consolidation job/);
    assert.doesNotMatch(JSON.stringify(f.calls[0]!.body.messages),/synthetic persona|a current question/);
    const input = JSON.parse(textOf(f.calls[0]!.body.messages.findLast((message:any)=>message.role==='user')));
    assert.equal(input.sources[0].sourceSeq,1);
    assert.ok(!('seq' in input.sources[0]));assert.ok(!('id' in input.sources[0]));assert.ok(!('messageId' in input.sources[0]));
    assert.ok(events.some(event=>event.type==='tool.completed'));
    assert.equal(f.session,null);
    assert.deepEqual(await readdir(join(f.home,'sessions')),[]);
  } finally { await f.close(); }
});

const proposal = (sourceSeq=1, quote='I prefer tea.'):MemoryProposal => ({operation:'upsert',scope:'person',subjectUserId:'101',kind:'preference',topic:'drink/preference',content:'Prefers tea.',sources:[{sourceSeq,quote}]});

test('rejected source references are corrected in the same run and a validated stage needs no extra provider response',async()=>{
  const accepted:MemoryProposal[][]=[];let attempts=0;
  const f=await fixture((call,response,count)=>{
    if(count===1)respond(call,response,[{name:'stage_memory_changes',arguments:{changes:[proposal(99)]}}]);
    else if(count===2){assert.match(JSON.stringify(call.results),/MEMORY_SOURCE_NOT_FOUND.*changeIndex=0.*sourceIndex=0.*sourceSeq=99/);respond(call,response,[{name:'stage_memory_changes',arguments:{changes:[proposal()]}}]);}
    else assert.fail('A validated memory batch must not need a final model request.');
  });
  try {
    await f.runner.runMemory(memoryBatch,{history:async()=>[],search:async()=>[],stage:async values=>{attempts++;if(values[0]!.sources[0]!.sourceSeq!==1)throw new Error('MEMORY_SOURCE_NOT_FOUND changeIndex=0 sourceIndex=0 sourceSeq=99');accepted.push(values);}},new AbortController().signal);
    assert.equal(attempts,2);assert.equal(f.calls.length,2);assert.deepEqual(accepted,[[proposal()]]);
  } finally {await f.close();}
});

test('memory history and existing evidence expose one source reference while main tools retain their archive format',async()=>{
  const existing={id:'existing-memory',scope:'person' as const,subjectUserId:'101',kind:'preference' as const,topic:'drink/preference',content:'Prefers tea.',occurredAt:null,validFrom:null,validTo:null,status:'active' as const,revision:1,sources:[{sourceId:'incoming:older-message',quote:'I prefer tea.'}],createdAt:1,updatedAt:1};
  const f=await fixture((call,response,count)=>respond(call,response,count===1
    ?[{name:'read_chat_history',arguments:{}}]:count===2?[{name:'search_memory',arguments:{query:'tea'}}]:[{name:'stage_memory_changes',arguments:{changes:[]}}]));
  try {
    await f.runner.runMemory({...memoryBatch,memories:[existing]},{history:async()=>({messages:memoryBatch.sources}),search:async()=>[existing],stage:async()=>{}},new AbortController().signal);
    assert.equal(f.calls.length,3);
    const initial=JSON.parse(textOf(f.calls[0]!.body.messages.findLast((message:any)=>message.role==='user')));
    assert.deepEqual(initial.memories[0].evidence,[{quote:'I prefer tea.'}]);assert.ok(!('sources' in initial.memories[0]));
    assert.match(JSON.stringify(f.calls[1]!.results),/sourceSeq/);assert.doesNotMatch(JSON.stringify(f.calls[1]!.results),/incoming:example-message|messageId|"seq"/);
    assert.doesNotMatch(JSON.stringify(f.calls[2]!.results),/incoming:older-message/);
  } finally {await f.close();}
});

test('mixed read and successful stage end at the same turn boundary without another provider call',async()=>{
  const f=await fixture((call,response,count)=>{
    assert.equal(count,1);respond(call,response,[{name:'search_memory',arguments:{query:'tea'}},{name:'stage_memory_changes',arguments:{changes:[proposal()]}}]);
  });
  try {let staged=0;await f.runner.runMemory(memoryBatch,{history:async()=>[],search:async()=>[],stage:async()=>{staged++;}},new AbortController().signal);assert.equal(staged,1);assert.equal(f.calls.length,1);}
  finally {await f.close();}
});

test('three rejected stages stop without a fourth generation or accepting a rejected batch',async()=>{
  const f=await fixture((call,response,count)=>{assert.ok(count<=3);respond(call,response,[{name:'stage_memory_changes',arguments:{changes:[proposal(99)]}}]);});
  try {let attempts=0;await assert.rejects(f.runner.runMemory(memoryBatch,{history:async()=>[],search:async()=>[],stage:async()=>{attempts++;throw new Error('MEMORY_SOURCE_NOT_FOUND changeIndex=0 sourceIndex=0 sourceSeq=99');}},new AbortController().signal),/PI_MEMORY_STAGE_ATTEMPTS_EXHAUSTED/);assert.equal(attempts,3);assert.equal(f.calls.length,3);}
  finally {await f.close();}
});

test('schema-invalid legacy source IDs count toward the three-stage limit before RPC',async()=>{
  const f=await fixture((call,response,count)=>{assert.ok(count<=3);respond(call,response,[{name:'stage_memory_changes',arguments:{changes:[{...proposal(),sources:[{sourceId:'in:1',quote:'I prefer tea.'}]}]}}]);});
  try {let attempts=0;await assert.rejects(f.runner.runMemory(memoryBatch,{history:async()=>[],search:async()=>[],stage:async()=>{attempts++;}},new AbortController().signal),/PI_MEMORY_STAGE_ATTEMPTS_EXHAUSTED/);assert.equal(attempts,0);assert.equal(f.calls.length,3);}
  finally {await f.close();}
});

test('external cancellation racing successful stage never turns into successful memory completion',async()=>{
  const abort=new AbortController();
  const f=await fixture((call,response)=>respond(call,response,[{name:'stage_memory_changes',arguments:{changes:[]}}]));
  try {await assert.rejects(f.runner.runMemory(memoryBatch,{history:async()=>[],search:async()=>[],stage:async()=>{abort.abort();}},abort.signal),/PI_ABORTED/);assert.equal(f.calls.length,1);}
  finally {await f.close();}
});

test('a normal final answer cannot silently count as successful memory consolidation', async () => {
  const f = await fixture((call,response)=>respond(call,response,'Nothing to retain.'));
  try {
    await assert.rejects(f.runner.runMemory(memoryBatch,{history:async()=>[],search:async()=>[],stage:async()=>{}},new AbortController().signal),/PI_MEMORY_NOT_STAGED/);
    assert.equal(f.calls.length,1);
  } finally { await f.close(); }
});

test('main chat reads memory and receives a stable transient recall without writing it to its session', async () => {
  const requests: unknown[] = [];
  const f = await fixture((call,response,count)=>respond(call,response,count===1
    ? [{name:'search_memory',arguments:{query:'tea'}}] : count===2
      ? [{name:'send_message',arguments:{messages:[{type:'text',text:'A current reply.'}]}}] : 'Done.'),{
    memoryRead:{search:async request=>{requests.push(request);return {items:[]};},history:async()=>[]},
    recall:async()=>({items:[{id:'example-memory',revision:1,content:'Synthetic durable fact for recall.'}]}),
  });
  try {
    await f.run(); assert.equal(f.calls.length,3); assert.equal(requests.length,1);
    const tools=f.calls[0]!.body.tools.map((tool:any)=>tool.function.name);
    assert.ok(tools.includes('search_memory')); assert.ok(tools.includes('search_chat_history'));
    assert.ok(!tools.includes('remember_memory')); assert.ok(!tools.includes('forget_memory')); assert.ok(!tools.includes('stage_memory_changes'));
    for(const call of f.calls) {
      const user=call.body.messages.findLast((message:any)=>message.role==='user');
      const text=textOf(user);const parsed=JSON.parse(text);
      assert.equal(parsed.recalledMemory.data.items[0].id,'example-memory');
      assert.equal(Object.keys(parsed).at(-1),'replyTargetMessageIds');
    }
    const persisted=await readFile(f.session!,'utf8');
    assert.doesNotMatch(persisted,/Synthetic durable fact|recalledMemory|example-memory/);
    assert.match(persisted,/a current question/);
  } finally { await f.close(); }
});

test('a blocked memory request and a normal chat run independently on the same instance home', async () => {
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
  const f=await fixture(async(call,response)=>{
    const names=(call.body.tools??[]).map((tool:any)=>tool.function.name);
    if(names.includes('stage_memory_changes')) {
      if(call.results.length)respond(call,response,'Done.');else {entered();await gate;respond(call,response,[{name:'stage_memory_changes',arguments:{changes:[]}}]);}
    } else respond(call,response,call.results.length?'Done.':[{name:'send_message',arguments:{messages:[{type:'text',text:'Chat continues.'}]}}]);
  });
  try {
    const memory=f.runner.runMemory(memoryBatch,{history:async()=>[],search:async()=>[],stage:async()=>{}},new AbortController().signal);
    await started;await f.run();assert.ok(f.session);release();await memory;
  } finally { release?.();await f.close(); }
});

test('manual chat compaction replaces the template, preserves the cut and reports the persisted entry once', async () => {
  const entries:Array<{session:string;entryId:string}>=[];
  const f=await fixture((call,response)=>respond(call,response,checkpoint),{onCompacted:info=>entries.push(info),keepRecentTokens:1000});
  try {
    await f.run(incoming('Older chat '.repeat(5000),false));
    await f.run(incoming('Recent chat '.repeat(5000),false));
    const old=await readFile(f.session!,'utf8');
    await f.runner.compact(f.session!,new AbortController().signal);
    assert.equal(f.calls.length,1); assert.equal(entries.length,1);
    assert.match(JSON.stringify(f.calls[0]!.body.messages),/Historical questions, old replyTargetMessageIds/);
    assert.doesNotMatch(JSON.stringify(f.calls[0]!.body.messages),/Use this EXACT format|synthetic persona/);
    const manager=SessionManager.open(f.session!);const entry=manager.getBranch().findLast(entry=>entry.type==='compaction');
    assert.ok(entry&&entry.type==='compaction');assert.equal(entry.id,entries[0]!.entryId);
    assert.equal((entry.details as any).kind,'chat_checkpoint');
    assert.ok(old.includes(entry.firstKeptEntryId));assert.equal(entry.summary,checkpoint);
  } finally { await f.close(); }
});

test('invalid custom compaction cancels without falling back, retrying or replacing the old history', async () => {
  const f=await fixture((call,response)=>respond(call,response,'An invalid partial checkpoint.'),{keepRecentTokens:1000});
  try {
    await f.run(incoming('Older chat '.repeat(5000),false));await f.run(incoming('Recent chat '.repeat(5000),false));
    const old=await readFile(f.session!,'utf8');
    await assert.rejects(f.runner.compact(f.session!,new AbortController().signal),/PI_EXECUTION_FAILED/);
    assert.equal(f.calls.length,1);
    const messageLines=(text:string)=>text.split('\n').filter(line=>{try{return JSON.parse(line).type==='message';}catch{return false;}});
    const after=await readFile(f.session!,'utf8');assert.deepEqual(messageLines(after),messageLines(old));
    assert.ok(!SessionManager.open(f.session!).getBranch().some(entry=>entry.type==='compaction'));
  } finally { await f.close(); }
});

test('transient recall drops under budget pressure, never mutates source arrays and preserves reply targets',()=>{
  const prompt=JSON.stringify({messages:[{text:'Current question'}],replyTargetMessageIds:['example-message']});
  const messages:AgentMessage[]=[{role:'user',content:[{type:'text',text:prompt}],timestamp:1}];
  const original=structuredClone(messages);const recalled={items:[{content:'A synthetic stored fact.'}]};
  const config={contextWindow:200000,maxOutputTokens:8192} as any;
  const result=injectRecalledMemory(messages,prompt,recalled,config,'system',[]);
  assert.ok(result.bytes>0);assert.deepEqual(messages,original);assert.equal(recalled.items.length,1);
  const text=((result.messages[0] as any).content[0].text as string);assert.equal(Object.keys(JSON.parse(text)).at(-1),'replyTargetMessageIds');
  assert.deepEqual(injectRecalledMemory(messages,prompt,recalled,{...config,contextWindow:9000},'large system',[]).messages,messages);
  assert.throws(()=>validateChatCheckpoint('## Recent relevant topics\nIncomplete.',4000));
});

test('oversized history tool results remain bounded, indicate pagination and preserve the stored source',()=>{
  const source={messages:Array.from({length:10},(_,index)=>({seq:index+1,text:'synthetic '.repeat(1000)})),availableCount:10,truncated:false,nextSeq:null};
  const result=boundMemoryToolResult(source) as typeof source;
  assert.ok(Buffer.byteLength(JSON.stringify(result))<=32000);assert.equal(result.truncated,true);
  assert.equal(result.nextSeq,result.messages.at(-1)!.seq);assert.equal(source.messages.length,10);assert.equal(source.truncated,false);
});

test('bounded organizer history keeps sourceSeq pagination after source projection',()=>{
  const source={messages:Array.from({length:10},(_,index)=>({sourceSeq:index+11,text:'synthetic '.repeat(1000)})),availableCount:10,truncated:false,nextSeq:null};
  const result=boundMemoryToolResult(source) as typeof source;
  assert.ok(Buffer.byteLength(JSON.stringify(result))<=32000);assert.equal(result.truncated,true);
  assert.equal(result.nextSeq,result.messages.at(-1)!.sourceSeq);assert.equal(source.messages.length,10);
});
