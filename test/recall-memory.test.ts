import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeStore } from '../src/store.js';
import { MemoryStore } from '../src/memory-store.js';

test('memory journals recalls once, keeps source text, and annotates every historical version',()=>{
  const directory=mkdtempSync(join(tmpdir(),'recall-memory-')),file=join(directory,'bridge.sqlite3');
  const chat=new BridgeStore(file,{type:'group',id:'1001'}),memory=new MemoryStore(file);
  try {
    memory.enableChatProjection();memory.initialize(true);
    chat.insert({messageId:'10001',senderId:'2001',senderName:'Example',time:1,text:'Original content',replyTo:null,trigger:true,rawJson:'{}'});
    chat.applyEnrichment('10001','example',[{title:'Additional content'}]);
    const before=memory.highWater();
    const notice={eventId:'recall-example',messageId:'10001',time:3,operatorId:'2001',authorId:'2001'};
    chat.applyRecall(notice);chat.applyRecall(notice);
    assert.equal(memory.highWater(),before+1);
    const history=memory.history({aroundMessageId:'10001',limit:20}).messages;
    const original=history.find(s=>s.id==='in:10001')!;
    assert.equal(original.text,'Original content');assert.equal(original.recalled,true);assert.equal(original.recalledAt,3000);
    const revision=history.find(s=>s.id.startsWith('revision:'))!;
    assert.equal(revision.recalled,true);assert.match(revision.text,/Additional content/);
    const event=history.find(s=>s.kind==='message_recalled')!;
    assert.equal(event.role,'system');assert.equal(JSON.parse(event.text).messageId,'10001');
    const job=memory.request('manual','example')!;memory.claim();
    assert.equal(memory.batch(job.id)!.sources.find(s=>s.id==='in:10001')!.recalled,true);
    assert.equal(memory.db.prepare("SELECT text FROM memory_ingest WHERE id='in:10001'").get()!.text,'Original content');
  } finally {memory.close();chat.close();rmSync(directory,{recursive:true,force:true});}
});

test('a recall received before the source survives projection startup and never fabricates a human source',()=>{
  const directory=mkdtempSync(join(tmpdir(),'recall-memory-order-')),file=join(directory,'bridge.sqlite3');
  const chat=new BridgeStore(file,{type:'private',id:'2001'});
  chat.applyRecall({eventId:'early',messageId:'10001',time:4});
  const memory=new MemoryStore(file);
  try {
    memory.enableChatProjection();
    chat.insert({messageId:'10001',senderId:'2001',senderName:'Example',time:1,text:'Late source',replyTo:null,trigger:true,rawJson:'{}'});
    const all=memory.history({limit:20}).messages;
    assert.equal(all.filter(s=>s.kind==='message_recalled').length,1);
    assert.equal(all.find(s=>s.role==='user')!.text,'Late source');assert.equal(all.find(s=>s.role==='user')!.recalled,true);
    memory.enableChatProjection();assert.equal(memory.history({limit:20}).messages.length,2);
  } finally {memory.close();chat.close();rmSync(directory,{recursive:true,force:true});}
});
