import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BridgeStore } from '../src/store.js';
import { MemoryStore } from '../src/memory-store.js';
import { MemoryEmbeddings } from '../src/memory-embeddings.js';
import type { MemoryConfig } from '../src/memory-contract.js';

const config: MemoryConfig = { enabled:true,dailyEnabled:false,dailyTime:'04:00',timezone:'Asia/Shanghai',afterCompaction:true,recallTokens:3000,model:'',baseUrl:'',embeddingProvider:'openai-compatible',embeddingBaseUrl:'https://embedding.example/v1',embeddingModel:'multilingual-example',embeddingApiKey:'example-embedding-key' };
function fixture() {
  const directory=mkdtempSync(join(tmpdir(),'memory-embedding-'));const file=join(directory,'bridge.sqlite3');
  const bridge=new BridgeStore(file,{type:'group',id:'1001'});const store=new MemoryStore(file);store.initialize(true);
  for(const [id,user,text] of [['1','2001','我喜欢安静的地方'],['2','2002','我喜欢安静的地方']])bridge.insert({messageId:id!,senderId:user!,senderName:'Example',time:Math.floor(Date.now()/1000),text:text!,replyTo:null,trigger:false,rawJson:'{}'});
  const requested=store.request('manual','example')!;store.claim();const batch=store.batch(requested.id)!;
  store.publish(requested.id,batch.throughSeq,batch.sources.map(source=>({operation:'upsert',scope:'person',subjectUserId:source.senderId,kind:'preference',topic:'环境/安静偏好',content:'喜欢安静的地方',sources:[{sourceId:source.id,quote:source.text}]})));
  return {file,store,bridge,cleanup(){store.close();bridge.close();rmSync(directory,{recursive:true,force:true});}};
}
const embedFetch=(async (_url,init)=>{const input=JSON.parse(String(init?.body)) as {input:string[]};return new Response(JSON.stringify({data:input.input.map((_text,index)=>({index,embedding:[1,0,0]}))}),{headers:{'content-type':'application/json'}});}) as typeof fetch;

test('semantic recall keeps participant boundaries and rejects disabled or stale vector revisions',async()=>{
  const f=fixture();const embeddings=new MemoryEmbeddings(f.file,config,f.store,embedFetch);
  try {
    await embeddings.update(new AbortController().signal);
    const found=await embeddings.search('我怕吵，去哪儿比较合适',['2001'],8);assert.equal(found.length,1);assert.equal(found[0]!.subjectUserId,'2001');
    f.store.control({id:'disable-example',operation:'disable',memoryId:found[0]!.id,expectedRevision:found[0]!.revision});
    assert.deepEqual(await embeddings.search('我怕吵',['2001'],8),[]);
    const second=f.store.activeItems()[0]!;f.store.control({id:'edit-example',operation:'update',memoryId:second.id,expectedRevision:second.revision,content:'现在喜欢热闹'});
    assert.deepEqual(await embeddings.search('安静',['2002'],8),[]);
  }finally{embeddings.close();f.cleanup();}
});

test('a vector result received after memory was disabled is never installed',async()=>{
  const f=fixture();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let started=false;
  const embeddings=new MemoryEmbeddings(f.file,config,f.store,(async(url,init)=>{started=true;await gate;return embedFetch(url,init);}) as typeof fetch);
  try {const pending=embeddings.update(new AbortController().signal);while(!started)await new Promise<void>(resolve=>setImmediate(resolve));for(const item of f.store.activeItems())f.store.control({id:`disable-${item.id}`,operation:'disable',memoryId:item.id,expectedRevision:item.revision});release();await pending;assert.deepEqual(await embeddings.search('安静',['2001'],8),[]);}
  finally{release();embeddings.close();f.cleanup();}
});
