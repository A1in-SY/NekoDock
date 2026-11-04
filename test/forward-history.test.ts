import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { BridgeStore } from '../src/store.js';
import { MemoryStore } from '../src/memory-store.js';
import { boundMemoryToolResult } from '../src/pi-memory.js';
import { historySharedContents } from '../src/history-content.js';
import type { ForwardContent } from '../src/forward-contract.js';
import type { MemorySource } from '../src/memory-contract.js';

test('large forwarded archive revisions remain completely readable through existing text pagination',()=>{
  const directory=mkdtempSync(join(tmpdir(),'forward-history-')),path=join(directory,'bridge.sqlite3');
  const store=new BridgeStore(path,{type:'group',id:'1001'}),memory=new MemoryStore(path);
  try {
    memory.enableChatProjection();
    store.insert({messageId:'outer',senderId:'2001',senderName:'Forwarder',time:1,text:'[聊天记录]',replyTo:null,trigger:false,rawJson:'{}'});
    const initial=String(memory.db.prepare("SELECT text FROM memory_ingest WHERE id='in:outer'").get()!.text);
    const content:ForwardContent={type:'forward',path:'s0',status:'ready',nodes:Array.from({length:100},(_,index)=>({
      path:`s0/n${index}`,senderName:'Quoted author',segments:[{type:'text',text:`Page material ${index}: ${'x'.repeat(500)}`}],
    }))};
    store.recordForwardContent({messageId:'outer',revision:1,deadline:Date.now(),contents:[content]});
    const row=memory.db.prepare("SELECT seq,text FROM memory_ingest WHERE id LIKE 'revision:in:outer:%' ORDER BY seq DESC LIMIT 1").get()!;
    const full=String(row.text);assert.ok(Buffer.byteLength(full)>32_000);
    let offset=0,joined='';
    while(offset<full.length) {
      const page=memory.history({afterSeq:Number(row.seq)-1,limit:1,textOffset:offset});
      const expanded={...page,messages:page.messages.map(source=>({...source,assets:[{id:'existing-image',type:'image',status:'ready',path:'/data/example.png'}],
        ...historySharedContents(store.chatMessageForQQ('outer')!.contents)}))};
      const bounded=boundMemoryToolResult(expanded) as {messages:Array<MemorySource&{forwardContentOmitted?:boolean;assets?:unknown[]}>};
      assert.equal(bounded.messages.length,1);assert.equal(bounded.messages[0]!.forwardContentOmitted,true);
      assert.equal(bounded.messages[0]!.assets?.length,1);
      const text=bounded.messages[0]!.text;assert.ok(text.length>0);
      joined+=text;offset+=text.length;
    }
    assert.equal(joined,full);assert.match(joined,/Page material 99/);
    assert.equal(memory.db.prepare("SELECT text FROM memory_ingest WHERE id='in:outer'").get()!.text,initial);
  }finally{memory.close();store.close();rmSync(directory,{recursive:true,force:true});}
});

test('history projection retains small forwarded trees and independent plugin contents',()=>{
  const small={type:'forward',path:'s0',status:'ready',nodes:[]};
  const plugin={type:'video',platform:'bilibili',title:'Example'};
  assert.deepEqual(historySharedContents([small,plugin]),{contents:[small,plugin]});
  const large={...small,nodes:[{path:'s0/n0',segments:[{type:'text',text:'x'.repeat(5000)}]}]};
  assert.deepEqual(historySharedContents([large,plugin]).contents,[plugin]);
  assert.equal(historySharedContents([large,plugin]).forwardContentOmitted,true);
});
