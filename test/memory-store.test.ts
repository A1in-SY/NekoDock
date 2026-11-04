import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeStore } from '../src/store.js';
import { MemoryStore, MemoryValidationError } from '../src/memory-store.js';
import type { MemoryChange, MemoryProposal } from '../src/memory-contract.js';

function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'memory-store-')),path=join(dir,'bridge.sqlite3');
  const chat=new BridgeStore(path,{type:'group',id:'10001'});let store=new MemoryStore(path);
  const incoming=(id:string,text:string,sender='2001',time=1700000000)=>chat.insert({messageId:id,senderId:sender,senderName:'Example',time,text,replyTo:null,trigger:true,rawJson:'{}'});
  return {chat,get store(){return store;},incoming,path,reopen(){store.close();store=new MemoryStore(path);return store;},close(){store.close();chat.close();rmSync(dir,{recursive:true,force:true});}};
}
function preference(sourceId:string,quote:string,extra:Partial<MemoryChange>={}):MemoryChange{return {operation:'upsert',scope:'person',subjectUserId:'2001',kind:'preference',topic:'饮食',content:quote,sources:[{sourceId,quote}],...extra};}
function proposal(sourceSeq:number,quote:string,extra:Partial<MemoryProposal>={}):MemoryProposal{return {operation:'upsert',scope:'person',subjectUserId:'2001',kind:'preference',topic:'diet/coffee',content:quote,sources:[{sourceSeq,quote}],...extra};}
function validationSnapshot(store:MemoryStore):string {
  return JSON.stringify(Object.fromEntries(['memory_state','memory_jobs','memory_items','memory_sources','memory_revisions','memory_exclusions','memory_events','memory_item_fts','sqlite_sequence']
    .map(table=>[table,store.db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all()])));
}

test('archive triggers capture new ingress and ACK replies, including same-transaction rollback',()=>{
  const f=fixture();try{
    f.incoming('one','我喜欢无糖咖啡');f.store.initialize(true);assert.equal(f.store.cursor(),1);
    f.incoming('two','我的生日在三月');
    f.store.db.prepare('INSERT INTO outgoing_history(id,time,text,conversation_id)VALUES(?,?,?,?)').run('reply',Date.now(),'已收到','chat');
    assert.equal(f.store.highWater(),3);assert.equal(f.store.history({query:'生日'}).messages[0]!.id,'in:two');
    assert.ok(f.store.view().version>=3);
    assert.equal(f.store.history({query:'咖啡'}).messages[0]!.senderId,'2001');
    assert.equal(f.store.history({query:'已收到'}).messages[0]!.role,'assistant');
    f.store.db.exec('BEGIN');f.store.db.prepare("INSERT INTO outgoing_history(id,time,text,conversation_id)VALUES('rollback',1,'discard','chat')").run();f.store.db.exec('ROLLBACK');
    assert.equal(f.store.highWater(),3);
  }finally{f.close();}
});

test('daily and compaction triggers coalesce with frozen running ranges and incremental follow-up',()=>{
  const f=fixture();try{
    f.store.initialize(true);f.incoming('one','第一条');const first=f.store.request('daily','day:1')!;
    f.incoming('two','第二条');assert.equal(f.store.request('compaction','compact:1')!.id,first.id);
    assert.equal(f.store.job(first.id)!.throughSeq,2);const running=f.store.claim()!;
    f.incoming('three','第三条');const next=f.store.request('compaction','compact:2')!;assert.notEqual(next.id,running.id);
    assert.equal(f.store.job(running.id)!.throughSeq,2);assert.equal(f.store.claim(),null);
    const batch=f.store.batch(running.id)!;assert.equal(batch.throughSeq,2);f.store.publish(running.id,batch.throughSeq,[]);
    const following=f.store.claim()!;assert.equal(following.processedSeq,2);assert.equal(f.store.batch(following.id)!.sources[0]!.id,'in:three');
    f.store.publish(following.id,3,[]);assert.equal(f.store.cursor(),3);
    assert.equal(f.store.request('daily','day:1')!.id,first.id);assert.equal(f.store.request('daily','day:2'),null);
  }finally{f.close();}
});

test('validated memory publication is atomic and does not advance on forged evidence',()=>{
  const f=fixture();try{
    f.store.initialize(true);f.incoming('one','我不吃香菜');f.store.request('daily','day:1');const job=f.store.claim()!,batch=f.store.batch(job.id)!;
    const good=preference('in:one','我不吃香菜');
    assert.throws(()=>f.store.publish(job.id,batch.throughSeq,[good,preference('in:one','不存在的引文')]),/SOURCE_INVALID/);
    assert.equal(f.store.search().length,0);assert.equal(f.store.cursor(),0);
    assert.throws(()=>f.store.publish(job.id,batch.throughSeq,[preference('in:one','我不吃香菜',{subjectUserId:'2002'})]),/SELF_EVIDENCE/);
    assert.equal(f.store.publish(job.id,batch.throughSeq,[good]).status,'completed');
    const item=f.store.search({query:'香菜'})[0]!;assert.equal(item.subjectUserId,'2001');assert.equal(item.sources[0]!.sourceId,'in:one');
    assert.equal(f.store.recall('香菜',['2002'],3000).length,0);assert.equal(f.store.recall('香菜',['2001'],3000).length,1);
  }finally{f.close();}
});

test('assistant text alone cannot become a user fact and job history stays bounded',()=>{
  const f=fixture();try{
    f.store.initialize(true);f.store.db.prepare('INSERT INTO outgoing_history(id,time,text,conversation_id)VALUES(?,?,?,?)').run('reply',Date.now(),'我喜欢咖啡','chat');
    f.store.request('manual','manual:1');const job=f.store.claim()!,batch=f.store.batch(job.id)!;
    assert.throws(()=>f.store.publish(job.id,batch.throughSeq,[preference('out:reply','我喜欢咖啡')]),/SELF_EVIDENCE/);
    const history=f.store.history({},{fromSeq:job.fromSeq,throughSeq:job.throughSeq});assert.equal(history.messages.length,1);
    f.incoming('later','后来的消息');assert.equal(f.store.history({},{fromSeq:job.fromSeq,throughSeq:job.throughSeq}).messages.length,1);
  }finally{f.close();}
});

test('correction requires a revision and stale backfill cannot undo newer memory',()=>{
  const f=fixture();try{
    f.store.initialize(true);f.incoming('one','我喜欢咖啡');f.store.request('daily','day:1');let job=f.store.claim()!;f.store.publish(job.id,1,[preference('in:one','我喜欢咖啡')]);
    const item=f.store.search()[0]!;
    f.incoming('two','我不喝咖啡了，改喝茶');f.store.request('daily','day:2');job=f.store.claim()!;
    assert.throws(()=>f.store.publish(job.id,2,[preference('in:two','我不喝咖啡了，改喝茶',{id:item.id,expectedRevision:99})]),/VERSION_CONFLICT/);
    f.store.publish(job.id,2,[preference('in:two','我不喝咖啡了，改喝茶',{id:item.id,expectedRevision:item.revision})]);
    assert.equal(f.store.get(item.id)!.revision,2);assert.match(f.store.get(item.id)!.content,/改喝茶/);
    f.store.request('backfill','backfill:1',1,0);job=f.store.claim()!;f.store.publish(job.id,1,[preference('in:one','我喜欢咖啡',{id:item.id,expectedRevision:2})]);
    assert.equal(f.store.get(item.id)!.revision,2);assert.equal(f.store.cursor(),2);
  }finally{f.close();}
});

test('disabled facts do not revive during new learning or backfill while unrelated facts still publish',()=>{
  const f=fixture();try{
    f.store.initialize(true);f.incoming('one','我喜欢咖啡');f.store.request('daily','day:1');let job=f.store.claim()!;f.store.publish(job.id,1,[preference('in:one','我喜欢咖啡')]);
    const item=f.store.search()[0]!;const control={id:'disable:1',operation:'disable' as const,memoryId:item.id,expectedRevision:item.revision};
    f.store.control(control);f.store.control(control);assert.equal(f.store.get(item.id)!.revision,2);assert.equal(f.store.search().length,0);
    assert.equal(f.store.history({query:'咖啡'}).messages.length,0);
    f.incoming('two','我还是喜欢咖啡');f.incoming('three','我的生日在三月');f.store.request('daily','day:2');job=f.store.claim()!;
    f.store.publish(job.id,3,[preference('in:two','我还是喜欢咖啡'),preference('in:three','我的生日在三月',{kind:'fact',topic:'生日'})]);
    assert.equal(f.store.search().length,1);assert.equal(f.store.search()[0]!.topic,'生日');
    f.store.request('backfill','backfill:1',1,0);job=f.store.claim()!;f.store.publish(job.id,1,[preference('in:one','我喜欢咖啡')]);
    assert.equal(f.store.search().length,1);
  }finally{f.close();}
});

test('manual edits are idempotent and protected against older background evidence',()=>{
  const f=fixture();try{
    f.store.initialize(true);f.incoming('one','我喜欢咖啡');f.store.request('daily','day:1');let job=f.store.claim()!;f.store.publish(job.id,1,[preference('in:one','我喜欢咖啡')]);
    const item=f.store.search()[0]!,control={id:'edit:1',operation:'update' as const,memoryId:item.id,expectedRevision:item.revision,content:'喜欢无糖咖啡'};
    f.store.control(control);f.store.control(control);assert.equal(f.store.get(item.id)!.revision,2);
    assert.throws(()=>f.store.control({...control,content:'other'}),/CONTROL_CONFLICT/);
    f.store.request('backfill','backfill:1',1,0);job=f.store.claim()!;f.store.publish(job.id,1,[preference('in:one','我喜欢咖啡',{id:item.id,expectedRevision:2})]);
    assert.equal(f.store.get(item.id)!.content,'喜欢无糖咖啡');assert.equal(f.store.activeItems()[0]!.id,item.id);
  }finally{f.close();}
});

test('restart recovers in-flight work and release does not consume the retry budget',()=>{
  const f=fixture();try{
    f.store.initialize(true);f.incoming('one','我喜欢咖啡');f.store.request('daily','day:1');const job=f.store.claim()!;assert.equal(job.attempts,1);
    f.store.release(job.id);assert.equal(f.store.job(job.id)!.attempts,0);f.store.claim();f.reopen();
    assert.equal(f.store.job(job.id)!.status,'pending');assert.equal(f.store.cursor(),0);
    const recovered=f.store.claim()!;assert.equal(f.store.batch(recovered.id)!.sources[0]!.id,'in:one');
    f.store.fail(job.id,'provider URL with private detail',false);assert.equal(f.store.job(job.id)!.error,'MEMORY_EXECUTION_FAILED');
    f.store.request('manual','manual:retry');const retry=f.store.claim()!;assert.equal(retry.fromSeq,0);f.store.cancel(retry.id);
    assert.throws(()=>f.store.publish(retry.id,1,[]),/UNAVAILABLE/);
  }finally{f.close();}
});

test('history supports Chinese two-character queries, sender/time filters, paging and references',()=>{
  const f=fixture();try{
    f.store.initialize(true);f.incoming('one','我喜欢咖啡','2001',100);f.incoming('two','我的生日','2002',200);f.incoming('three','咖啡不错','2002',300);
    assert.equal(f.store.history({query:'咖啡'}).availableCount,2);
    assert.equal(f.store.history({query:'生日'}).messages[0]!.id,'in:two');
    assert.equal(f.store.history({query:'咖啡',senderId:'2002'}).messages[0]!.id,'in:three');
    assert.equal(f.store.history({from:200000,to:300000}).messages[0]!.id,'in:two');
    const page=f.store.history({limit:1});assert.equal(page.truncated,true);assert.equal(page.nextSeq,1);
    assert.equal(f.store.history({afterSeq:page.nextSeq!,limit:1}).messages[0]!.id,'in:two');
    assert.ok(f.store.history({aroundMessageId:'two',limit:3}).messages.some(source=>source.messageId==='two'));
    assert.equal(f.store.history({query:'" OR *'}).messages.length,0);
  }finally{f.close();}
});

test('backfill uses message time inside a frozen source range and keeps normal cursor unchanged',()=>{
  const f=fixture();try{
    f.incoming('one','旧历史','2001',100);f.incoming('two','范围外','2001',500);f.incoming('three','旧历史补充','2001',200);f.store.initialize(true);
    assert.equal(f.store.cursor(),3);
    f.store.control({id:'backfill:1',operation:'backfill',from:100000,to:300000});const job=f.store.claim()!,batch=f.store.batch(job.id)!;
    assert.deepEqual(batch.sources.map(source=>source.id),['in:one','in:three']);
    assert.deepEqual(f.store.history({},{fromSeq:batch.fromSeq,throughSeq:batch.throughSeq,jobId:job.id}).messages.map(source=>source.id),['in:one','in:three']);
    assert.throws(()=>f.store.publish(job.id,batch.throughSeq,[preference('in:two','范围外')]),/SOURCE_INVALID/);
    f.store.publish(job.id,batch.throughSeq,[]);assert.equal(f.store.cursor(),3);
  }finally{f.close();}
});

test('validity boundaries and corrected null expiry are respected by recall',()=>{
  const f=fixture();try{
    f.store.initialize(true);f.incoming('one','我喜欢咖啡');f.store.request('daily','day:1');let job=f.store.claim()!;
    f.store.publish(job.id,1,[preference('in:one','我喜欢咖啡',{validTo:Date.now()-1000})]);assert.equal(f.store.search().length,0);
    const item=f.store.search({includeInactive:true})[0]!;f.incoming('two','咖啡是长期爱好');f.store.request('daily','day:2');job=f.store.claim()!;
    f.store.publish(job.id,2,[preference('in:two','咖啡是长期爱好',{id:item.id,expectedRevision:item.revision,validTo:null})]);
    assert.equal(f.store.search().length,1);assert.equal(f.store.get(item.id)!.validTo,null);
  }finally{f.close();}
});

test('oversized sources continue from durable text offsets instead of losing their tails',()=>{
  const f=fixture();try{
    f.store.initialize(true);const body='前半段'.repeat(5000)+'我的生日在三月';f.incoming('long',body);f.store.request('daily','day:1');let job=f.store.claim()!;
    let combined='',chunks=0;
    while(job.status==='running'){
      const batch=f.store.batch(job.id,100,2000)!;assert.equal(batch.sources.length,1);
      const source=batch.sources[0]!;assert.equal(source.textOffset??0,combined.length);combined+=source.text;chunks++;
      job=f.store.publish(job.id,batch.throughSeq,[]);
      if(source.truncated){assert.equal(job.status,'running');assert.equal(f.store.cursor(),0);}
      if(chunks===2){f.reopen();job=f.store.claim()!;}
    }
    assert.equal(combined,body);assert.ok(chunks>2);assert.equal(f.store.cursor(),1);
    const tail=f.store.history({aroundMessageId:'long',textOffset:body.length-8});assert.match(tail.messages[0]!.text,/生日/);
  }finally{f.close();}
});

test('published snapshots remain bounded and explicitly report partial records',()=>{
  const f=fixture();try{
    f.store.initialize(true);
    for(let i=0;i<12;i++)f.store.event('example','thinking.updated',{text:'x'.repeat(100000)});
    const view=f.store.view();assert.equal(view.truncated,true);assert.ok(Buffer.byteLength(JSON.stringify(view))<800000);assert.equal(view.totalItems,0);
  }finally{f.close();}
});

test('explicit restoration needs newer self evidence and does not reopen old source history',()=>{
  const f=fixture();try{
    f.store.initialize(true);f.incoming('one','我喜欢咖啡');f.store.request('daily','day:1');let job=f.store.claim()!;f.store.publish(job.id,1,[preference('in:one','我喜欢咖啡')]);
    const item=f.store.search()[0]!;f.store.control({id:'disable',operation:'disable',memoryId:item.id,expectedRevision:1});
    f.store.request('backfill','old:restore',1,0);job=f.store.claim()!;assert.throws(()=>f.store.publish(job.id,1,[preference('in:one','我喜欢咖啡',{id:item.id,expectedRevision:2,restore:true})]),/RESTORE_SOURCE_REQUIRED/);f.store.cancel(job.id);
    f.incoming('two','重新记住，我喜欢无糖咖啡');f.store.request('daily','day:2');job=f.store.claim()!;f.store.publish(job.id,2,[preference('in:two','重新记住，我喜欢无糖咖啡',{id:item.id,expectedRevision:2,restore:true})]);
    assert.equal(f.store.get(item.id)!.status,'active');assert.equal(f.store.get(item.id)!.revision,3);assert.equal(f.store.search().length,1);
    assert.equal(f.store.history({aroundMessageId:'one'}).messages.some(source=>source.id==='in:one'),false);
    f.store.request('backfill','old:again',1,0);job=f.store.claim()!;f.store.publish(job.id,1,[preference('in:one','我喜欢咖啡')]);assert.equal(f.store.search().length,1);
  }finally{f.close();}
});

test('long historical results stay inside the tool budget and retain tail lookup',()=>{
  const f=fixture();try{
    f.store.initialize(true);for(let i=0;i<100;i++)f.incoming('long:'+i,'历史内容'.repeat(10000)+'生日在三月');
    const history=f.store.history({limit:100});assert.ok(Buffer.byteLength(JSON.stringify(history))<25*1024);assert.equal(history.truncated,true);assert.equal(history.availableCount,100);assert.ok(history.nextSeq);
    const tail=f.store.history({query:'生日',aroundMessageId:'long:99',textOffset:40000});assert.match(tail.messages[0]!.text,/生日/);
  }finally{f.close();}
});

test('proposal validation maps only the archive sequence and always rolls successful dry-run writes back',()=>{
  const f=fixture();try{
    f.store.initialize(true);f.incoming('902345678','我喜欢咖啡');f.store.request('manual','validate:1');const job=f.store.claim()!,batch=f.store.batch(job.id)!;
    const before=validationSnapshot(f.store);
    const changes=f.store.validateProposals(job.id,batch.throughSeq,[proposal(1,'我喜欢咖啡')]);
    assert.deepEqual(changes[0]!.sources,[{sourceId:'in:902345678',quote:'我喜欢咖啡'}]);
    assert.equal(validationSnapshot(f.store),before);assert.equal(f.store.search({query:'咖啡'}).length,0);
    f.store.publish(job.id,batch.throughSeq,changes);
    assert.equal(f.store.search({query:'咖啡'})[0]!.sources[0]!.sourceId,'in:902345678');assert.equal(f.store.cursor(),1);
  }finally{f.close();}
});

test('proposal errors identify the candidate and source without guessing IDs or echoing private text',()=>{
  const f=fixture();try{
    f.store.initialize(true);f.incoming('one','我喜欢咖啡');f.incoming('two','我喜欢清茶');f.store.request('manual','validate:2');const job=f.store.claim()!,batch=f.store.batch(job.id)!;
    const assertFailure=(input:MemoryProposal[],code:string,changeIndex:number,sourceIndex:number,sourceSeq?:number)=>{
      const before=validationSnapshot(f.store);
      assert.throws(()=>f.store.validateProposals(job.id,batch.throughSeq,input),(error:unknown)=>{
        assert.ok(error instanceof MemoryValidationError);assert.equal(error.code,code);assert.equal(error.changeIndex,changeIndex);assert.equal(error.sourceIndex,sourceIndex);assert.equal(error.sourceSeq,sourceSeq);
        assert.doesNotMatch(error.message,/我喜欢|one|two|in:/u);return true;
      });
      assert.equal(validationSnapshot(f.store),before);
    };
    assertFailure([proposal(1,'我喜欢咖啡'),proposal(2,'我喜欢咖啡')],'MEMORY_QUOTE_MISMATCH',1,0,2);
    assertFailure([proposal(999,'我喜欢咖啡')],'MEMORY_SOURCE_NOT_FOUND',0,0,999);
    assertFailure([{...proposal(1,'我喜欢咖啡'),sources:[{sourceId:'in:one',quote:'我喜欢咖啡'}]} as unknown as MemoryProposal],'MEMORY_SOURCE_INVALID',0,0);
    assertFailure([{...proposal(1,'我喜欢咖啡'),sources:[{sourceSeq:1,sourceId:'in:one',quote:'我喜欢咖啡'}]} as unknown as MemoryProposal],'MEMORY_SOURCE_INVALID',0,0,1);
    assertFailure([proposal(1.5,'我喜欢咖啡')],'MEMORY_SOURCE_INVALID',0,0);
    assertFailure([proposal(1,'我喜欢\n咖啡')],'MEMORY_QUOTE_MISMATCH',0,0,1);
    f.incoming('later','未来消息');assertFailure([proposal(3,'未来消息')],'MEMORY_SOURCE_OUT_OF_RANGE',0,0,3);
  }finally{f.close();}
});

test('dry-run applies sequential version rules then rolls back indexes, revisions, events and counters on a later conflict',()=>{
  const f=fixture();try{
    f.store.initialize(true);f.incoming('one','我喜欢咖啡');f.store.request('daily','validate:initial');let job=f.store.claim()!;f.store.publish(job.id,1,[preference('in:one','我喜欢咖啡')]);
    const item=f.store.search()[0]!;f.incoming('two','我现在喜欢清茶');f.store.request('daily','validate:update');job=f.store.claim()!;const batch=f.store.batch(job.id)!;
    const edit=proposal(2,'我现在喜欢清茶',{id:item.id,expectedRevision:1,topic:item.topic});const before=validationSnapshot(f.store);
    assert.throws(()=>f.store.validateProposals(job.id,batch.throughSeq,[edit,edit]),(error:unknown)=>error instanceof MemoryValidationError&&error.code==='MEMORY_VERSION_CONFLICT'&&error.changeIndex===1);
    assert.equal(validationSnapshot(f.store),before);assert.equal(f.store.get(item.id)!.revision,1);assert.equal(f.store.search({query:'清茶'}).length,0);
    assert.throws(()=>f.store.validateProposals(job.id,batch.throughSeq,[proposal(2,'我现在喜欢清茶',{subjectUserId:'2002'})]),(error:unknown)=>error instanceof MemoryValidationError&&error.code==='MEMORY_SELF_EVIDENCE_REQUIRED'&&error.changeIndex===0);
    assert.equal(validationSnapshot(f.store),before);
    const canonical=f.store.validateProposals(job.id,batch.throughSeq,[edit]);
    f.store.control({id:'admin:update',operation:'update',memoryId:item.id,expectedRevision:1,content:'管理员明确更正'});
    assert.throws(()=>f.store.publish(job.id,batch.throughSeq,canonical),/MEMORY_VERSION_CONFLICT/);
    assert.equal(f.store.get(item.id)!.content,'管理员明确更正');assert.equal(f.store.cursor(),1);
  }finally{f.close();}
});

test('proposal validation enforces the current frozen batch and backfill time selector',()=>{
  const f=fixture();try{
    f.incoming('one','范围内原文','2001',100);f.incoming('two','范围外原文','2001',500);f.incoming('three','范围内补充','2001',200);f.store.initialize(true);
    f.store.control({id:'backfill:validate',operation:'backfill',from:100000,to:300000});const job=f.store.claim()!,batch=f.store.batch(job.id)!;const before=validationSnapshot(f.store);
    assert.throws(()=>f.store.validateProposals(job.id,batch.throughSeq,[proposal(2,'范围外原文')]),(error:unknown)=>error instanceof MemoryValidationError&&error.code==='MEMORY_SOURCE_OUT_OF_RANGE'&&error.sourceSeq===2);
    assert.equal(validationSnapshot(f.store),before);
    assert.throws(()=>f.store.validateProposals(job.id,batch.throughSeq-1,[proposal(1,'范围内原文')]),(error:unknown)=>error instanceof MemoryValidationError&&error.code==='MEMORY_BATCH_CONFLICT');
  }finally{f.close();}
});

test('manual resume retains committed backfill work and does not reset the normal learning cursor',()=>{
  const f=fixture();try{
    f.incoming('one','我喜欢咖啡','2001',100);f.incoming('two','我的生日在三月','2001',200);f.store.initialize(true);
    f.store.control({id:'backfill:resume',operation:'backfill',from:100000,to:300000});let job=f.store.claim()!;const first=f.store.batch(job.id,1)!;
    f.store.publish(job.id,first.throughSeq,f.store.validateProposals(job.id,first.throughSeq,[proposal(1,'我喜欢咖啡')]));
    f.store.batch(job.id);f.store.fail(job.id,'MEMORY_SOURCE_INVALID',false);const failed=f.store.job(job.id)!;
    const resumed=f.store.resume(job.id);assert.equal(resumed.status,'pending');assert.equal(resumed.processedSeq,1);assert.equal(resumed.fromSeq,failed.fromSeq);assert.equal(resumed.throughSeq,failed.throughSeq);assert.equal(resumed.attempts,0);assert.equal(resumed.error,null);
    const range=f.store.db.prepare('SELECT from_time,to_time,batch_through FROM memory_jobs WHERE id=?').get(job.id)!;assert.equal(range.from_time,100000);assert.equal(range.to_time,300000);assert.equal(range.batch_through,null);
    assert.equal(f.store.cursor(),2);assert.equal(f.store.search().length,1);assert.throws(()=>f.store.resume(job.id),/MEMORY_JOB_NOT_FAILED/);
    job=f.store.claim()!;const remaining=f.store.batch(job.id)!;assert.deepEqual(remaining.sources.map(source=>source.seq),[2]);
    f.store.publish(job.id,remaining.throughSeq,f.store.validateProposals(job.id,remaining.throughSeq,[proposal(2,'我的生日在三月',{kind:'fact',topic:'birthday'})]));
    assert.equal(f.store.search().length,2);assert.equal(f.store.cursor(),2);assert.equal(f.store.job(job.id)!.status,'completed');
  }finally{f.close();}
});

test('resume preserves a partially processed long source and dry-run never advances its text offset',()=>{
  const f=fixture();try{
    f.store.initialize(true);f.incoming('long','我喜欢咖啡。'.repeat(3000));f.store.request('daily','resume:long');let job=f.store.claim()!;
    const first=f.store.batch(job.id,1,2000)!;f.store.publish(job.id,first.throughSeq,[]);
    const second=f.store.batch(job.id,1,2000)!;const before=validationSnapshot(f.store);
    const proposed=proposal(second.sources[0]!.seq,'我喜欢咖啡');f.store.validateProposals(job.id,second.throughSeq,[proposed]);assert.equal(validationSnapshot(f.store),before);
    f.store.fail(job.id,'MEMORY_SOURCE_INVALID',false);f.store.resume(job.id);job=f.store.claim()!;const retried=f.store.batch(job.id,1,2000)!;
    assert.equal(retried.sources[0]!.textOffset,second.sources[0]!.textOffset);assert.equal(retried.sources[0]!.text,second.sources[0]!.text);assert.equal(f.store.cursor(),0);assert.equal(f.store.search().length,0);
    f.store.fail(job.id,'MEMORY_SOURCE_INVALID',false);f.store.initialize(false);assert.throws(()=>f.store.resume(job.id),/MEMORY_DISABLED/);
  }finally{f.close();}
});

test('queued retry is idempotent and cannot reset a pending or running job under a second command',()=>{
  const f=fixture();try{
    f.store.initialize(true);f.incoming('one','我喜欢咖啡');f.store.request('manual','retry:initial');const job=f.store.claim()!;f.store.batch(job.id);f.store.fail(job.id,'PI_EXECUTION_FAILED',false);
    assert.equal(f.store.job(job.id)!.error,'PI_EXECUTION_FAILED');
    const request={id:'retry:control',operation:'retry' as const,jobId:job.id};
    const result=f.store.control(request);const after=validationSnapshot(f.store);assert.deepEqual(result,{accepted:true,jobId:job.id});
    assert.deepEqual(f.store.control(request),result);assert.equal(validationSnapshot(f.store),after);
    assert.throws(()=>f.store.control({...request,id:'retry:second'}),/MEMORY_JOB_NOT_FAILED/);assert.equal(validationSnapshot(f.store),after);
    f.store.claim();assert.equal(f.store.job(job.id)!.attempts,1);assert.deepEqual(f.store.control(request),result);assert.equal(f.store.job(job.id)!.attempts,1);
    f.store.fail(job.id,'PI_EXECUTION_FAILED: private provider body',false);assert.equal(f.store.job(job.id)!.error,'MEMORY_EXECUTION_FAILED');
    assert.ok(!JSON.stringify(f.store.view()).includes('private provider body'));
  }finally{f.close();}
});

test('validating disable and restore does not change exclusions or readable facts before publication',()=>{
  const f=fixture();try{
    f.store.initialize(true);f.incoming('one','我喜欢咖啡');f.store.request('daily','exclude:initial');let job=f.store.claim()!;f.store.publish(job.id,1,[preference('in:one','我喜欢咖啡')]);
    const item=f.store.search()[0]!;f.incoming('two','忘记我的咖啡偏好');f.store.request('daily','exclude:disable');job=f.store.claim()!;let batch=f.store.batch(job.id)!;
    let before=validationSnapshot(f.store);
    const disable=f.store.validateProposals(job.id,batch.throughSeq,[{operation:'disable',id:item.id,expectedRevision:1,sources:[{sourceSeq:2,quote:'忘记我的咖啡偏好'}]}]);
    assert.equal(validationSnapshot(f.store),before);assert.equal(f.store.search({query:'咖啡'}).length,1);
    f.incoming('three','重新记住，我喜欢无糖咖啡');
    f.store.publish(job.id,batch.throughSeq,disable);
    assert.deepEqual(f.store.db.prepare('SELECT DISTINCT through_seq FROM memory_exclusions').all().map(row=>row.through_seq),[2]);
    f.store.request('daily','exclude:restore');job=f.store.claim()!;batch=f.store.batch(job.id)!;before=validationSnapshot(f.store);
    const restore=f.store.validateProposals(job.id,batch.throughSeq,[proposal(3,'重新记住，我喜欢无糖咖啡',{id:item.id,expectedRevision:2,restore:true,topic:item.topic})]);
    assert.equal(validationSnapshot(f.store),before);assert.equal(f.store.search().length,0);f.store.publish(job.id,batch.throughSeq,restore);
    assert.equal(f.store.get(item.id)!.status,'active');assert.equal(f.store.get(item.id)!.revision,3);assert.ok(!f.store.history({query:'咖啡'}).messages.some(source=>source.seq<3));
  }finally{f.close();}
});

test('agent exclusion cutoff follows its evidence even when later sources are in the frozen batch',()=>{
  const f=fixture();try{
    f.store.initialize(true);f.incoming('one','我喜欢咖啡');f.store.request('daily','cutoff:initial');let job=f.store.claim()!;f.store.publish(job.id,1,[preference('in:one','我喜欢咖啡')]);
    const item=f.store.search()[0]!;f.incoming('two','忘记我的咖啡偏好');f.incoming('three','重新记住，我喜欢无糖咖啡');
    f.store.request('daily','cutoff:disable');job=f.store.claim()!;const batch=f.store.batch(job.id)!;assert.equal(batch.throughSeq,3);
    const changes=f.store.validateProposals(job.id,batch.throughSeq,[
      {operation:'disable',id:item.id,expectedRevision:1,sources:[{sourceSeq:2,quote:'忘记我的咖啡偏好'}]},
      proposal(3,'重新记住，我喜欢无糖咖啡',{id:item.id,expectedRevision:2,restore:true,topic:item.topic}),
    ]);
    f.store.publish(job.id,batch.throughSeq,changes);
    assert.equal(f.store.get(item.id)!.status,'active');assert.equal(f.store.get(item.id)!.revision,3);
    assert.deepEqual(f.store.history().messages.map(source=>source.seq),[3]);
  }finally{f.close();}
});

test('console disable excludes restoration evidence already present at the time of the control',()=>{
  const f=fixture();try{
    f.store.initialize(true);f.incoming('one','我喜欢咖啡');f.store.request('daily','manual-cutoff:initial');let job=f.store.claim()!;f.store.publish(job.id,1,[preference('in:one','我喜欢咖啡')]);
    const item=f.store.search()[0]!;f.incoming('two','重新记住，我喜欢无糖咖啡');
    f.store.control({id:'manual-cutoff:disable',operation:'disable',memoryId:item.id,expectedRevision:1});
    assert.deepEqual(f.store.db.prepare('SELECT DISTINCT through_seq FROM memory_exclusions').all().map(row=>row.through_seq),[2]);
    f.store.request('daily','manual-cutoff:old');job=f.store.claim()!;let batch=f.store.batch(job.id)!;
    assert.throws(()=>f.store.validateProposals(job.id,batch.throughSeq,[proposal(2,'重新记住，我喜欢无糖咖啡',{id:item.id,expectedRevision:2,restore:true,topic:item.topic})]),(error:unknown)=>error instanceof MemoryValidationError&&error.code==='MEMORY_RESTORE_SOURCE_REQUIRED');
    f.store.publish(job.id,batch.throughSeq,[]);
    f.incoming('three','现在重新记住，我喜欢清茶');f.store.request('daily','manual-cutoff:new');job=f.store.claim()!;batch=f.store.batch(job.id)!;
    const restore=f.store.validateProposals(job.id,batch.throughSeq,[proposal(3,'现在重新记住，我喜欢清茶',{id:item.id,expectedRevision:2,restore:true,topic:item.topic})]);
    f.store.publish(job.id,batch.throughSeq,restore);assert.equal(f.store.get(item.id)!.status,'active');
    assert.ok(!f.store.history().messages.some(source=>source.seq===1));
  }finally{f.close();}
});
