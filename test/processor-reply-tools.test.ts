import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { BridgeStore } from '../src/store.js';
import { Processor } from '../src/processor.js';
import type { AgentRunner, IncomingMessage, MessageSender, ReplyToolReceipt, ReplyToolRequest } from '../src/types.js';

const incoming = (id: number, trigger = true): IncomingMessage => ({
  messageId: String(id), senderId: '2001', senderName: 'Alice', time: id,
  text: `question-${id}`, replyTo: null, trigger, rawJson: '{}',
});
const request = (text: string): ReplyToolRequest => ({ messages: [{ type: 'text', text }] });
function accepted(receipt: ReplyToolReceipt, status = 'sent') {
  assert.equal(receipt.accepted,true);assert.equal(receipt.messages?.length,1);
  assert.match(receipt.messages![0]!.messageRef,/^reply:.+:0$/);assert.equal(receipt.messages![0]!.status,status);
  assert.ok(receipt.notice);
}
const mp3 = `base64://${Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0]).toString('base64')}`;
async function until(check: () => boolean) {
  const end = Date.now() + 3000;
  while (!check()) { assert.ok(Date.now() < end, 'processor did not reach expected state'); await delay(5); }
}
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'reply-tool-processor-'));
  const path = join(directory, 'bridge.sqlite3');
  const store = new BridgeStore(path, { type: 'group', id: '1001' });
  const controller = new AbortController();
  const logs: string[] = [];
  const releases: Array<() => void> = [];
  let assertionFailure: unknown;
  let running: Promise<void> | undefined;
  t.after(async () => { controller.abort(); releases.forEach(release => release()); await running; store.close(); rmSync(directory, { recursive: true, force: true }); assert.equal(assertionFailure, undefined); });
  return {
    store, path, controller, logs,
    gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); releases.push(release); return { promise, release }; },
    start(agent: AgentRunner, sender: Partial<MessageSender> = {}, options: Partial<ConstructorParameters<typeof Processor>[0]> = {}) {
      const unexpected = async () => { throw new Error('Unexpected sender'); };
      const processor = new Processor({
        store, agent: {...agent, async run(...args) {
          try { return await agent.run(...args); }
          catch (error) { if (error instanceof assert.AssertionError) assertionFailure = error; throw error; }
        }}, sender: { sendText: unexpected, sendImage: unexpected, sendMessage: unexpected, ...sender },
        logger: { info: line => logs.push(line), warn: line => logs.push(line), error: line => logs.push(line) },
        batchSize: 50, replyMaxChars: 1500, retryMs: 1, workspace: directory,
        imageMaxBytes: 1024, imageTimeoutMs: 1000, ...options,
      });
      running = processor.run(controller.signal); return processor;
    },
  };
}

test('operator cancellation ends only the selected turn, preserves the session and accepts the next input',async t=>{
  const f=fixture(t);f.store.insert(incoming(1));let calls=0;const sent:string[]=[];
  const processor=f.start({async run(_batch,session,onSession,signal){
    calls++;
    if(calls===1){onSession('same-session');await delay(60_000,undefined,{signal});}
    assert.equal(session,'same-session');return {messages:[{type:'text',text:'next answer'}]};
  }},{async sendText(text){sent.push(text);}});
  await until(()=>calls===1);const id=processor.activeRun!.runId;
  assert.equal(await processor.cancelRun('different-run'),'already_finished');
  assert.equal(processor.activeRun!.phase,'generating');
  const first=processor.cancelRun(id),second=processor.cancelRun(id);
  assert.strictEqual(first,second);assert.equal(await first,'cancelled');
  assert.equal(f.controller.signal.aborted,false);assert.equal(f.store.getCursor(),1);
  assert.equal(f.store.recorder.pending(100).filter(event=>event.type==='run.cancelled').length,1);
  assert.equal(f.store.recorder.pending(100).filter(event=>event.type==='run.failed').length,0);
  assert.deepEqual(sent,[]);
  f.store.insert(incoming(2));processor.notify();await until(()=>f.store.getCursor()===2);
  assert.equal(calls,2);assert.deepEqual(sent,['next answer']);
  assert.equal(await processor.cancelRun(id),'already_finished');
});

test('operator cancellation cancels queued parts, retains the in-flight ACK and drains before newer work',async t=>{
  const f=fixture(t);f.store.insert(incoming(1));const ack=f.gate();const sent:string[]=[];let ref='';
  const processor=f.start({async run(_batch,_session,_onSession,signal,tools){
    await tools!.send(request('abcdefghi'));
    await delay(60_000,undefined,{signal});return {messages:[]};
  }},{async sendText(text,signal){sent.push(text);await ack.promise;assert.equal(signal.aborted,false);return {messageId:'confirmed-id'};}},{replyMaxChars:3});
  await until(()=>sent.length===1);
  ref=f.store.replyLedger.references(f.store.listReplyRequests(1)[0]!.requestId)[0]!;
  processor.requestDrain();f.store.insert(incoming(2));processor.notify();
  const stopped=processor.cancelRun(processor.activeRun!.runId);let finished=false;void stopped.then(()=>{finished=true;});
  await delay(10);assert.equal(finished,false);assert.equal(processor.isDrained,false);
  ack.release();assert.equal(await stopped,'cancelled');await until(()=>processor.isDrained);
  assert.deepEqual(sent,['abc']);assert.equal(f.store.getCursor(),1);
  assert.deepEqual(f.store.replyLedger.parts(ref).map(part=>part.state),['acknowledged','cancelled','cancelled']);
  const events=f.store.recorder.pending(100);
  assert.equal(events.filter(event=>event.type==='delivery.acknowledged').length,1);
  assert.equal(events.filter(event=>event.type==='delivery.cancelled').length,2);
  assert.ok(events.findIndex(event=>event.type==='delivery.acknowledged')<events.findIndex(event=>event.type==='run.cancelled'));
});

test('cancelling preparation finishes the batch and never invokes the model',async t=>{
  const f=fixture(t);f.store.insert(incoming(1));let preparing=false,calls=0;
  const processor=f.start({async run(){calls++;return {messages:[]};}},{},{beforeContext:async(_batch,signal)=>{
    preparing=true;await delay(60_000,undefined,{signal});
  }});
  await until(()=>preparing);assert.equal(processor.activeRun!.phase,'preparing');
  assert.equal(await processor.cancelRun(processor.activeRun!.runId),'cancelled');
  assert.equal(calls,0);assert.equal(f.store.getCursor(),1);assert.equal(f.store.peekPendingBatch(),null);
});

test('cancelling voice preparation neither falls back to text nor leaves an uncertain delivery',async t=>{
  const f=fixture(t);f.store.insert(incoming(1));let preparing=false;let ref='';const sent:string[]=[];
  const processor=f.start({async run(_batch,_session,_onSession,signal,tools){
    await tools!.send(request('voice content'));
    await delay(60_000,undefined,{signal});return {messages:[]};
  }},{async sendText(text){sent.push(text);},async sendVoice(file){sent.push(file);}},{
    voiceReplyEnabled:true,voiceReplyProbability:1,
    speech:{name:'mock',async synthesize(_text,signal){preparing=true;await delay(60_000,undefined,{signal});return {file:mp3};}},
  });
  await until(()=>preparing);ref=f.store.replyLedger.references(f.store.listReplyRequests(1)[0]!.requestId)[0]!;
  await processor.cancelRun(processor.activeRun!.runId);
  assert.deepEqual(sent,[]);assert.equal(f.store.replyLedger.parts(ref)[0]!.state,'cancelled');
  assert.equal(f.store.recorder.pending(100).filter(event=>event.type==='delivery.cancelled').length,1);
});

test('receipt waits for QQ ACK while messages send in order during generation', async t => {
  const f = fixture(t); const generation = f.gate(); const ack = f.gate(); const sent: string[] = []; let calls = 0;
  let receipt: ReplyToolReceipt | undefined;
  f.store.insert(incoming(1));
  const processor = f.start({ async run(batch, _session, onSession, _signal, tools) {
    assert.ok(tools); onSession('session'); calls++;
    if (batch.throughSeq === 1) {
      receipt=await tools.send(request('important result'));accepted(receipt);
      assert.equal(f.store.getCursor(), 0);
      assert.equal(f.store.getBatch(1).generationDone, false);
      await generation.promise;
      await tools.send(request('final answer'));
    } else await tools.send(request('next question answer'));
    return { messages: [] };
  } }, { async sendText(text) { sent.push(text); if (text === 'important result') await ack.promise; } });
  await until(() => sent.length === 1);
  assert.equal(receipt,undefined);
  f.store.insert(incoming(2)); processor.notify();
  generation.release(); await delay(10);
  assert.equal(calls, 1); assert.equal(f.store.getCursor(), 0);
  ack.release();
  await until(() => f.store.getCursor() === 2);
  assert.deepEqual(sent, ['important result', 'final answer', 'next question answer']);
  assert.equal(calls, 2);
});

test('generation failure after accepting a reply does not rerun CLI or redraw TTS', async t => {
  const f = fixture(t); f.store.insert(incoming(1));
  let calls = 0; let synthesis = 0; let draws = 0; const sent: string[] = [];
  f.start({ async run(_batch, _session, _onSession, _signal, tools) {
    assert.ok(tools); calls++;
    accepted(await tools.send(request('private-outgoing-body')));
    throw new Error('private-provider-error');
  } }, { async sendVoice(file) { sent.push(file); } }, {
    voiceReplyEnabled: true, voiceReplyProbability: 0.5, random: () => { draws++; return 0; },
    speech: { name: 'mock', async synthesize() { synthesis++; return { file: mp3 }; } },
  });
  await until(() => f.store.getCursor() === 1); await delay(10);
  assert.deepEqual(sent, [mp3]); assert.equal(synthesis, 1); assert.equal(draws, 1); assert.equal(calls, 1);
  assert.doesNotMatch(f.logs.join('\n'), /private-outgoing-body|private-provider-error|base64:/);
});

test('concurrent tool requests are accepted independently and delivered serially', async t => {
  const f = fixture(t); f.store.insert(incoming(1)); const sent: string[] = []; let active = 0;
  f.start({ async run(_batch, _session, _onSession, _signal, tools) {
    assert.ok(tools);
    const receipts = await Promise.all([tools.send(request('A')), tools.send(request('B')), tools.send(request('C'))]);
    receipts.forEach(receipt=>accepted(receipt));assert.equal(new Set(receipts.map(receipt=>receipt.messages![0]!.messageRef)).size,3);
    return { messages: [] };
  } }, { async sendText(text) { assert.equal(++active, 1); await delay(2); sent.push(text); active--; } });
  await until(() => f.store.getCursor() === 1); assert.deepEqual(sent, ['A', 'B', 'C']);
});

test('an ACK completes only its own receipt without waiting for an unrelated queued request', async t => {
  const f=fixture(t), second=f.gate(); f.store.insert(incoming(1));
  let firstReceipt:ReplyToolReceipt|undefined, secondReceipt:ReplyToolReceipt|undefined;
  const sent:string[]=[];
  f.start({async run(_batch,_session,_onSession,_signal,tools){
    await Promise.all([
      tools!.send(request('first')).then(receipt=>{firstReceipt=receipt;}),
      tools!.send(request('second')).then(receipt=>{secondReceipt=receipt;}),
    ]);return {messages:[]};
  }},{async sendText(text){sent.push(text);if(text==='second')await second.promise;return {messageId:`qq-${text}`};}});
  await until(()=>firstReceipt!==undefined&&sent.length===2);
  accepted(firstReceipt!);assert.equal(secondReceipt,undefined);
  second.release();await until(()=>f.store.getCursor()===1);accepted(secondReceipt!);
  assert.deepEqual(sent,['first','second']);
});

test('a pending receipt neither aborts delivery nor causes another model call when its ACK arrives', async t => {
  const f=fixture(t), ack=f.gate(), generation=f.gate(); f.store.insert(incoming(1));
  let receipt:ReplyToolReceipt|undefined,calls=0,sends=0;
  f.start({async run(_batch,_session,_onSession,_signal,tools){
    calls++;receipt=await tools!.send(request('slow reply'));await generation.promise;return {messages:[]};
  }},{async sendText(_text,signal){sends++;await ack.promise;assert.equal(signal.aborted,false);return {messageId:'qq-slow'};}},{replyReceiptWaitMs:20});
  await until(()=>receipt!==undefined);accepted(receipt!,'pending');
  assert.deepEqual(receipt!.messages![0]!.parts,{total:1,sent:0,pending:1,failed:0,unconfirmed:0,cancelled:0});
  ack.release();await until(()=>f.store.recorder.pending(100).some(event=>event.type==='delivery.acknowledged'));
  assert.equal(calls,1);assert.equal(sends,1);assert.equal(receipt!.messages![0]!.status,'pending','the saved tool receipt remains immutable');
  generation.release();await until(()=>f.store.getCursor()===1);assert.equal(calls,1);assert.equal(sends,1);
});

test('unconfirmed part is attempted once and later parts continue without model notification', async t => {
  const f = fixture(t); f.store.insert(incoming(1)); const attempted: string[] = []; let calls = 0;
  let receipt: ReplyToolReceipt | undefined;
  f.start({ async run(_batch, _session, _onSession, _signal, tools) {
    assert.ok(tools); calls++;
    receipt = await tools.send(request('abcdefghi'));
    assert.equal('status' in tools, false);
    return { messages: [] };
  } }, { async sendText(text) { attempted.push(text); if (text === 'def') throw new Error('response lost'); } }, { replyMaxChars: 3 });
  await until(() => f.store.getCursor() === 1);
  accepted(receipt!,'partial');
  assert.deepEqual(receipt!.messages![0]!.parts,{total:3,sent:2,pending:0,failed:0,unconfirmed:1,cancelled:0});
  assert.deepEqual(attempted, ['abc', 'def', 'ghi']); assert.equal(calls, 1);
  assert.match(f.logs.join('\n'), /processor\.reply\.failed .*reply_index=1.*status="unconfirmed"/);
});

test('missing image preparation terminates the item and releases later messages', async t => {
  const f = fixture(t); f.store.insert(incoming(1)); const sent: string[] = []; let calls = 0;
  const processor = f.start({ async run(batch, _session, _onSession, _signal, tools) {
    assert.ok(tools); calls++;
    if (batch.throughSeq === 1) {
      accepted(await tools.send({ messages: [{ type: 'image', path: 'missing.png' }] }),'failed');
      await tools.send(request('still useful'));
    } else await tools.send(request('new answer'));
    return { messages: [] };
  } }, { async sendText(text) { sent.push(text); } });
  await until(() => f.store.getCursor() === 1);
  f.store.insert(incoming(2)); processor.notify();
  await until(() => f.store.getCursor() === 2);
  const event = f.store.recorder.pending().find(event => event.type === 'delivery.failed');
  assert.equal(event?.payload.status, 'failed');
  assert.deepEqual(sent, ['still useful', 'new answer']); assert.equal(calls, 2);
});

test('restart abandons an interrupted generation and its old pending sends', async t => {
  const f = fixture(t); f.store.insert(incoming(1)); f.store.openOrCreateBatch(50); f.store.markGenerationStarted(1);
  f.store.appendReplyRequest(1, 'internal-request', [{ type: 'text', text: 'old answer' }], ['old answer']);
  f.store.close();
  const reopened = new BridgeStore(f.path, { type: 'group', id: '1001' }); t.after(() => reopened.close());
  const sent: string[] = []; let calls = 0;
  const processor = f.start({ async run(batch, _session, _onSession, _signal, tools) {
    calls++; assert.equal(batch.throughSeq, 2); assert.ok(tools);
    await tools.send(request('fresh answer')); return { messages: [] };
  } }, { async sendText(text) { sent.push(text); } }, { store: reopened });
  await until(() => reopened.getCursor() === 1);
  assert.equal(calls, 0); assert.deepEqual(sent, []);
  reopened.insert(incoming(2)); processor.notify();
  await until(() => reopened.getCursor() === 2);
  assert.equal(calls, 1); assert.deepEqual(sent, ['fresh answer']);
});

test('a batch opened but not started remains eligible after restart', async t => {
  const f = fixture(t); f.store.insert(incoming(1)); f.store.openOrCreateBatch(50); f.store.close();
  const reopened = new BridgeStore(f.path, { type: 'group', id: '1001' }); t.after(() => reopened.close());
  let calls = 0;
  f.start({ async run(_batch, _session, _onSession, _signal, tools) {
    calls++; assert.ok(tools); await tools.send(request('fresh answer')); return { messages: [] };
  } }, { async sendText() {} }, { store: reopened });
  await until(() => reopened.getCursor() === 1); assert.equal(calls, 1);
});

test('context-only batches cannot acquire send permission through reply tools', async t => {
  const f = fixture(t); f.store.insert(incoming(1, false)); f.store.insert(incoming(2)); const sent: string[] = [];
  f.start({ async run(batch, _session, _onSession, _signal, tools) {
    assert.ok(tools);
    if (!batch.replyAllowed) await assert.rejects(tools.send(request('should not send')));
    else await tools.send(request('allowed'));
    return { messages: [] };
  } }, { async sendText(text) { sent.push(text); } }, { batchSize: 1 });
  await until(() => f.store.getCursor() === 2); assert.deepEqual(sent, ['allowed']);
});

test('an ACK persistence error never retries an already successful physical send', async t => {
  const f = fixture(t); f.store.insert(incoming(1)); let calls = 0; let sends = 0;
  f.store.acknowledgeReply = () => { throw new Error('simulated acknowledgement storage failure'); };
  f.start({ async run(_batch, _session, _onSession, _signal, tools) {
    calls++; assert.ok(tools); await tools.send(request('answer')); return { messages: [] };
  } }, { async sendText() { sends++; return { messageId: 'qq-success' }; } });
  await until(() => f.store.getCursor() === 1); await delay(10);
  assert.equal(calls, 1); assert.equal(sends, 1); assert.equal(f.store.peekPendingBatch(), null);
  assert.match(f.logs.join('\n'), /processor\.reply\.failed .*stage="reply_ack".*status="acknowledged"/);
});

test('console media write failure does not revoke a successful voice ACK or resend', async t => {
  const f = fixture(t); f.store.insert(incoming(1)); let sends = 0;
  f.store.recorder.mediaSnapshot = () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
  f.start({ async run(_batch, _session, _onSession, _signal, tools) {
    assert.ok(tools); await tools.send(request('voice answer')); return { messages: [] };
  } }, { async sendVoice() { sends++; return { messageId: 'qq-voice' }; } }, {
    voiceReplyEnabled: true, voiceReplyProbability: 1,
    speech: { name: 'mock', async synthesize() { return { file: mp3 }; } },
  });
  await until(() => f.store.getCursor() === 1); await delay(10);
  assert.equal(sends, 1);
  const ack = f.store.recorder.pending().find(event => event.type === 'delivery.acknowledged');
  assert.equal(ack?.payload.messageId, 'qq-voice');
  assert.match(f.logs.join('\n'), /processor\.reply\.media_snapshot_failed/);
});

test('typed NapCat rejection logs its bounded code and retcode without exposing raw failure details', async t => {
  const f = fixture(t); f.store.insert(incoming(1));
  let receipt:ReplyToolReceipt|undefined;
  f.start({ async run(_batch, _session, _onSession, _signal, tools) {
    assert.ok(tools); receipt=await tools.send(request('answer')); return { messages: [] };
  } }, { async sendText() {
    throw Object.assign(new Error('private-body token=private-token'), { code: 'NAPCAT_API_REJECTED', retcode: 1403, deliveryStatus: 'failed' });
  } });
  await until(() => f.store.getCursor() === 1);
  assert.match(f.logs.join('\n'), /status="failed" error_code="NAPCAT_API_REJECTED" retcode=1403/);
  assert.doesNotMatch(f.logs.join('\n'), /private-body|private-token/);
  const event = f.store.recorder.pending().find(event => event.type === 'delivery.failed');
  assert.equal(event?.payload.status, 'failed'); assert.equal(event?.payload.retcode, 1403);
  accepted(receipt!,'failed');
  assert.deepEqual(receipt!.messages![0]!.errors,[{partIndex:0,code:'NAPCAT_API_REJECTED',retcode:1403}]);
  assert.doesNotMatch(JSON.stringify(receipt),/private-body|private-token/);
});

test('one agent run preserves every usage and context observation and sanitized failure metadata', async t => {
  const f = fixture(t); f.store.insert(incoming(1));
  f.start({ async run(_batch, _session, _onSession, _signal, tools, observe) {
    assert.ok(tools); assert.ok(observe);
    observe({ type: 'usage.recorded', payload: { usageId: 'call-1', input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 } });
    observe({ type: 'context.updated', payload: { used: 10, window: 200000, compactLimit: 160000, estimated: true } });
    observe({ type: 'usage.recorded', payload: { usageId: 'call-2', input_tokens: 20, cached_input_tokens: 4, output_tokens: 5 } });
    observe({ type: 'context.updated', payload: { used: 30, window: 200000, compactLimit: 160000, estimated: true } });
    throw Object.assign(new Error('PI_EXECUTION_FAILED: safe diagnostic'), { code: 'PI_EXECUTION_FAILED', providerStatus: 503 });
  } });
  await until(() => f.store.getCursor() === 1);
  const events = f.store.recorder.pending(100);
  assert.deepEqual(events.filter(e => e.type === 'usage.recorded').map(e => e.payload.usageId), ['call-1', 'call-2']);
  assert.deepEqual(events.filter(e => e.type === 'context.updated').map(e => e.payload.used), [10, 30]);
  const failure = events.find(e => e.type === 'run.failed')!;
  assert.equal(failure.payload.errorCode, 'PI_EXECUTION_FAILED'); assert.equal(failure.payload.httpStatus, 503);
  assert.equal(failure.payload.error, 'PI_EXECUTION_FAILED: safe diagnostic');
  assert.match(f.logs.join('\n'), /error_code="PI_EXECUTION_FAILED" http_status=503/);
  assert.doesNotMatch(f.logs.join('\n'), /safe diagnostic/);
});
