import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { BridgeStore } from '../src/store.js';
import { ConversationRecorder, safeToolPayload } from '../src/conversation-recorder.js';
import type { IncomingMessage } from '../src/types.js';
const target={type:'group' as const,id:'1001'};
const message=(id:string):IncomingMessage=>({messageId:id,senderId:'2001',senderName:'Alice',time:1700000000,text:`hello ${id}`,replyTo:null,trigger:true,rawJson:'{}'});

test('durable ingress, logical reply and ACK are deduplicated and retained after batch completion/restart',t=>{
  const dir=mkdtempSync(join(tmpdir(),'console-events-')),path=join(dir,'bridge.sqlite3');
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  let store=new BridgeStore(path,target);
  store.insert(message('1'));store.insert(message('1'));
  const batch=store.openOrCreateBatch(10)!;
  store.setSessionId('session-1');store.setSessionId('session-1');
  const outputs=[{type:'text' as const,text:'reply'}];
  store.appendReplyRequest(batch.throughSeq,'r1',outputs,['reply']);store.appendReplyRequest(batch.throughSeq,'r1',outputs,['reply']);
  store.acknowledgeReply(batch.throughSeq,0,'qq-101');store.acknowledgeReply(batch.throughSeq,0,'qq-101');
  store.finishGeneration(batch.throughSeq);store.completeBatch(batch.throughSeq,{runId:'run1',durationMs:12,replyAllowed:true});
  const events=store.recorder.pending(100);
  for(const type of ['message.received','session.established','reply.accepted','delivery.acknowledged','batch.completed'])assert.equal(events.filter(event=>event.type===type).length,1,type);
  assert.equal(events.find(event=>event.type==='message.received')!.time,1700000000000);
  assert.equal(events.find(event=>event.type==='delivery.acknowledged')!.payload.messageId,'qq-101');
  store.close();store=new BridgeStore(path,target);
  assert.deepEqual(store.recorder.pending(100),events);
  store.recorder.acknowledge(events.at(-1)!.seq);assert.deepEqual(store.recorder.pending(),[]);
  store.close();
  const db=new DatabaseSync(path);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM console_events').get()!.n,events.length);db.close();
});

test('/new changes conversation and explicitly moves messages received after the command boundary',()=>{
  const store=new BridgeStore(':memory:',target);
  const old=store.recorder.conversationId;
  store.insert(message('1'));store.setSessionId('old-session');
  store.insert({...message('command'),command:'new',text:'/new'});store.insert(message('2'));
  store.resetSessionForCommand(store.getPendingCommand()!.id);
  const current=store.recorder.conversationId;assert.notEqual(current,old);assert.equal(store.getSessionId(),null);
  const moved=store.recorder.pending(100).find(event=>event.type==='conversation.messages_moved')!;
  assert.equal(moved.conversationId,current);assert.deepEqual(moved.payload.messageIds,['2']);
  assert.equal(store.recorder.pending(100).filter(event=>event.type==='message.received').length,2);
  store.insert({...message('compact'),command:'compact',text:'/compact'});
  assert.equal(store.recorder.conversationId,current);
  store.close();
});

test('existing ingress is imported once with real timestamps and current session but no fabricated outgoing history',t=>{
  const dir=mkdtempSync(join(tmpdir(),'console-legacy-')),path=join(dir,'bridge.sqlite3');t.after(()=>rmSync(dir,{recursive:true,force:true}));
  let store=new BridgeStore(path,target);store.insert(message('1'));store.setSessionId('session-existing');store.close();
  const db=new DatabaseSync(path);db.exec('DROP TABLE console_events;DROP TABLE console_state');db.close();
  store=new BridgeStore(path,target);const events=store.recorder.pending(100);
  assert.equal(events.find(event=>event.type==='message.received')!.payload.legacy,true);
  assert.equal(events.find(event=>event.type==='message.received')!.time,1700000000000);
  assert.equal(events.find(event=>event.type==='session.established')!.payload.sessionId,'session-existing');
  assert.equal(events.filter(event=>event.type.includes('reply')||event.type.includes('usage')).length,0);
  store.close();store=new BridgeStore(path,target);assert.equal(store.recorder.pending(100).length,events.length);store.close();
});

test('tool presentation strips configured credentials, structured secrets, reasoning and oversized output',()=>{
  const result=safeToolPayload({command:'curl -H "Bearer abc123" secretVALUE',arguments:{apiKey:'private',reasoning:'private'},result:'x'.repeat(40000)},['secretVALUE']) as Record<string,unknown>;
  assert.doesNotMatch(JSON.stringify(result),/secretVALUE|abc123|private/);assert.match(String(result.result),/truncated/);
});

test('image ACKs expose immutable local media snapshots without putting bytes in events',t=>{
  const dir=mkdtempSync(join(tmpdir(),'console-media-')),path=join(dir,'bridge.sqlite3');t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const store=new BridgeStore(path,target);t.after(()=>store.close());
  store.insert(message('1'));const batch=store.openOrCreateBatch(10)!;
  const png=Buffer.from([137,80,78,71,13,10,26,10,0]);
  store.saveReplies(batch.throughSeq,[{type:'image',file:'/tmp/source.png'}]);
  store.saveImage(batch.throughSeq,0,`base64://${png.toString('base64')}`);store.acknowledgeReply(batch.throughSeq,0,'qq-img');
  const event=store.recorder.pending(100).find(event=>event.type==='delivery.acknowledged')!;
  const mediaPath=String(event.payload.mediaPath);assert.match(mediaPath,/console-media\/[a-f0-9]{64}\.png$/);
  assert.deepEqual(readFileSync(mediaPath),png);assert.doesNotMatch(JSON.stringify(event),/base64/);
});

test('delivery mapping keeps each split text/voice part attached to its original logical message',()=>{
 const store=new BridgeStore(':memory:',target);
 store.insert(message('1'));const batch=store.openOrCreateBatch(10)!;
 const replies=[{type:'text' as const,text:'first message split'},{type:'text' as const,text:'second'}];
 store.appendReplyRequest(batch.throughSeq,'logical-replies',replies,['first','message split',{type:'voice',text:'second'}],[0,0,1]);
 store.acknowledgeReply(batch.throughSeq,0);store.acknowledgeReply(batch.throughSeq,1);
 const mp3=`base64://${Buffer.from([0xff,0xfb,0x90,0x64,0,0,0,0]).toString('base64')}`;
 store.saveVoice(batch.throughSeq,2,mp3);store.acknowledgeReply(batch.throughSeq,2);
 const events=store.recorder.pending(100).filter(event=>event.type==='delivery.acknowledged');
 assert.deepEqual(events.map(event=>event.payload.logicalMessageIndex),[0,0,1]);
 assert.deepEqual(events.map(event=>event.payload.requestId),['logical-replies','logical-replies','logical-replies']);
 assert.equal(events[2]!.payload.kind,'voice');store.close();
});

test('oversized presentation is bounded and never blocks subsequent heartbeat events',()=>{
 const store=new BridgeStore(':memory:',target);
 store.insert({...message('large'),text:'x'.repeat(2*1024*1024)});store.insert(message('small'));
 const events=store.recorder.pending(100);
 assert.ok(Buffer.byteLength(JSON.stringify(events))<512*1024);
 assert.equal(events.filter(event=>event.type==='message.received').length,2);
 assert.equal(events.find(event=>event.itemId==='large')!.payload.truncated,true);
 assert.equal(store.openOrCreateBatch(10)!.messages[0]!.text.length,2*1024*1024);
 store.close();
});

test('recorder subscribers schedule committed reads, ignore duplicate keys and cannot break persistence',async()=>{
 const db=new DatabaseSync(':memory:');
 db.exec('CREATE TABLE messages(seq INTEGER);CREATE TABLE instance_state(id INTEGER PRIMARY KEY,session_id TEXT)');
 const recorder=new ConversationRecorder(db);recorder.acknowledge(recorder.pending().at(-1)!.seq);
 const reads:string[][]=[];let notifications=0;
 const unsubscribe=recorder.subscribe(()=>{notifications++;setTimeout(()=>reads.push(recorder.pending().map(event=>event.type)),0);});
 recorder.subscribe(()=>{throw new Error('presentation listener failed');});
 db.exec('BEGIN');recorder.append('committed',{},'committed');db.exec('COMMIT');
 recorder.append('committed',{},'committed');
 db.exec('BEGIN');recorder.append('rolled.back',{},'rolled-back');db.exec('ROLLBACK');
 await new Promise(resolve=>setTimeout(resolve,20));assert.equal(notifications,2);assert.deepEqual(reads,[['committed'],['committed']]);
 unsubscribe();recorder.append('after.unsubscribe',{});assert.equal(notifications,2);db.close();
});
