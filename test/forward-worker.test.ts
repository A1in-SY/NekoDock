import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BridgeStore } from '../src/store.js';
import { WorkerIncomingForwards } from '../src/incoming-forwards.js';
import type { ForwardSnapshot } from '../src/forward-contract.js';
import type { IncomingMessage } from '../src/types.js';

const logger={info(){},warn(){},error(){}};
const identity={url:'http://console.invalid',botId:'synthetic-bot',token:'synthetic-token',dataDir:'/unused'};
const signal=()=>new AbortController().signal;
const message=(messageId='outer',extra:Partial<IncomingMessage>={}):IncomingMessage=>({messageId,senderId:'2001',senderName:'Forwarder',time:1,
  text:'[聊天记录]',replyTo:null,trigger:false,rawJson:JSON.stringify({message:[{type:'forward',data:{id:'resource-example'}}]}),...extra});
const snapshot=(extra:Partial<ForwardSnapshot>={}):ForwardSnapshot=>({messageId:'outer',revision:1,deadline:Date.now()+15_000,
  contents:[{type:'forward',path:'0',status:'pending',nodes:[]}],...extra});
const resolved=(revision=2):ForwardSnapshot=>snapshot({revision,contents:[{type:'forward',path:'0',status:'ready',nodes:[
  {path:'0/0',senderId:'3001',senderName:'Quoted sender',time:0,segments:[{type:'text',text:'/new @机器人'},
    {type:'forward',path:'0/0/1',status:'ready',nodes:[{path:'0/0/1/0',segments:[{type:'image',assetId:'forward-image'},
      {type:'text',text:'Nested quoted material'}]}]}]},
]}]});
const fixture=()=>{
  const store=new BridgeStore(':memory:',{type:'group',id:'1001'});store.insert(message());
  return store;
};

test('forward snapshots revise one outer chat fact and preserve independent plugin content',()=>{
  const store=fixture();
  try {
    store.recordForwardContent(snapshot());
    store.applyEnrichment('outer','example',[{type:'video',title:'Independent share'}]);
    store.recordForwardContent(resolved());
    const fact=store.chatMessageForQQ('outer')!;
    assert.equal(fact.chatMessageId,'in:outer');assert.equal(fact.senderId,'2001');
    assert.equal(fact.messageId,'outer');assert.equal(fact.replyTo,null);
    assert.equal(fact.contents?.length,2);assert.deepEqual(fact.contents?.[0],resolved().contents[0]);
    assert.deepEqual(fact.contents?.[1],{type:'video',title:'Independent share'});
    store.applyEnrichment('outer','example',[{type:'video',title:'Updated share'}],2);
    assert.deepEqual(store.chatMessageForQQ('outer')!.contents?.[0],resolved().contents[0]);
    assert.equal(store.getPendingCommand(),null);assert.equal(store.isBusy(),false);
    assert.equal(store.recorder.pending().filter(event=>event.type==='message.received').length,1);
    assert.equal(store.recorder.pending().filter(event=>event.type==='message.content.updated').length,4);
    assert.equal(store.getMessage('0/0'),null);
  }finally{store.close();}
});

test('snapshot replay and stale versions neither overwrite a final tree nor append content events',()=>{
  const store=fixture();
  try {
    store.recordForwardContent(resolved());
    const revision=store.chatMessageForQQ('outer')!.revision;
    const events=store.recorder.pending().length;
    assert.equal(store.recordForwardContent(snapshot()),false);
    assert.equal(store.recordForwardContent(resolved()),false);
    assert.equal(store.recordForwardContent(resolved(3)),false);
    assert.equal(store.chatMessageForQQ('outer')!.revision,revision);
    assert.equal(store.forwardSnapshot('outer')!.revision,3);
    assert.equal(store.recorder.pending().length,events);
    assert.equal(store.recordForwardContent({...resolved(),messageId:'unreceived'}),false);
  }finally{store.close();}
});

test('late forward content updates the old session entry without becoming a new reply target',()=>{
  const store=fixture();
  try {
    store.setSessionId('session-example');store.recordForwardContent(snapshot());
    store.insert(message('first-question',{trigger:true,rawJson:'{}'}));
    const firstBatch=store.openOrCreateBatch(10)!;
    const first=store.prepareContext(firstBatch);
    store.commitContext({batchId:first.batchId,conversationId:first.conversationId,session:'session-example',entryId:'first-entry',versions:first.versions});
    store.saveReplies(firstBatch.throughSeq,[]);store.completeBatch(firstBatch.throughSeq);
    store.recordForwardContent(resolved());
    assert.equal((first.messages[0]!.contents?.[0] as {status:string}).status,'pending');
    store.insert(message('follow-up',{trigger:true,text:'Please explain that record',replyTo:'outer',rawJson:'{}'}));
    const context=store.prepareContext(store.openOrCreateBatch(10)!);
    assert.deepEqual(context.messages.map(item=>item.messageId),['follow-up']);
    assert.equal(context.revisions.length,1);assert.equal(context.revisions[0]!.entryId,'first-entry');
    assert.deepEqual(context.revisions[0]!.message.contents,resolved().contents);
    assert.deepEqual(context.references.map(item=>item.messageId),['outer']);
    assert.equal(store.getMessage('outer')!.trigger,false);
  }finally{store.close();}
});

test('a new session isolates late updates for a message already owned by the old conversation',()=>{
  const store=fixture();
  try {
    const oldConversation=store.recorder.conversationId;
    store.recordForwardContent(snapshot());
    store.insert(message('new-command',{command:'new',trigger:true,rawJson:'{}'}));
    store.resetSessionForCommand(store.getPendingCommand()!.id);
    store.acknowledgeCommand(store.getPendingCommand()!.id);
    store.recordForwardContent(resolved());
    assert.equal(store.chatMessageForQQ('outer')!.conversationId,oldConversation);
    assert.equal(store.recorder.pending().findLast(event=>event.type==='message.content.updated')!.conversationId,oldConversation);
    store.insert(message('new-question',{trigger:true,rawJson:'{}'}));
    const context=store.prepareContext(store.openOrCreateBatch(10)!);
    assert.deepEqual(context.messages.map(item=>item.messageId),['new-question']);assert.deepEqual(context.revisions,[]);
  }finally{store.close();}
});

test('context preparation waits for pending forwarded text and registers its images before returning',async()=>{
  const store=fixture();
  try {
    store.recordForwardContent(snapshot());
    store.insert(message('question',{trigger:true,rawJson:'{}'}));
    const registrations:unknown[]=[];
    const coordinator=new WorkerIncomingForwards({store,identity,logger,
      registerImages:(original,images)=>registrations.push([original.messageId,images]),
      request:async id=>{
        assert.equal(id,'outer');
        await new Promise(resolve=>setTimeout(resolve,5));
        return {snapshot:resolved(),attachments:[{id:'forward-image',messageId:'outer',index:0,status:'pending',sourceKey:'0/0/1/0/0'}]};
      },
    });
    await coordinator.beforeContext(store.openOrCreateBatch(10)!,signal());
    assert.deepEqual(store.chatMessageForQQ('outer')!.contents,resolved().contents);
    assert.equal((registrations[0] as unknown[])[0],'outer');
    assert.equal(store.getPendingCommand(),null);assert.equal(store.isBusy(),true); // Only the caller's open batch owns busy state.
  }finally{store.close();}
});

test('a bounded read timeout exposes a failed view and a later upstream version replaces it',async()=>{
  const store=fixture();
  try {
    store.recordForwardContent(snapshot({deadline:Date.now()+30}));
    store.insert(message('question',{trigger:true,rawJson:'{}'}));
    const coordinator=new WorkerIncomingForwards({store,identity,logger,registerImages(){},request:async()=>({snapshot:store.forwardSnapshot('outer'),attachments:[]})});
    await coordinator.beforeContext(store.openOrCreateBatch(10)!,signal());
    assert.equal((store.chatMessageForQQ('outer')!.contents![0] as {status:string}).status,'failed');
    assert.match((store.chatMessageForQQ('outer')!.contents![0] as {error:string}).error,/超时/);
    assert.equal(store.forwardSnapshot('outer')!.contents[0]!.status,'pending');
    assert.equal(store.forwardSnapshot('outer')!.revision,1);
    coordinator.receive(resolved());
    assert.equal(store.forwardSnapshot('outer')!.contents[0]!.status,'ready');
    assert.equal(store.forwardSnapshot('outer')!.revision,2);
  }finally{store.close();}
});

test('quoted forwarded messages share the wait budget while unavailable historical snapshots are left untouched',async()=>{
  const store=fixture();
  try {
    store.insert(message('question',{replyTo:'outer',trigger:true,rawJson:'{}'}));
    const requested:string[]=[];
    const coordinator=new WorkerIncomingForwards({store,identity,logger,registerImages(){},request:async id=>{
      requested.push(id);return {snapshot:null,attachments:[]};
    }});
    await coordinator.beforeContext(store.openOrCreateBatch(10)!,signal());
    assert.deepEqual(requested,['outer']);assert.equal(store.forwardSnapshot('outer'),null);
    assert.equal(store.recorder.pending().filter(event=>event.type==='message.content.updated').length,0);
  }finally{store.close();}
});

test('an expired pending snapshot still pulls the durable final content after reconnect',async()=>{
  const store=fixture();
  try {
    store.recordForwardContent(snapshot({deadline:Date.now()-1000}));
    store.insert(message('question',{trigger:true,rawJson:'{}'}));
    let reads=0;
    const coordinator=new WorkerIncomingForwards({store,identity,logger,registerImages(){},request:async()=>{
      reads++;return {snapshot:resolved(),attachments:[]};
    }});
    await coordinator.beforeContext(store.openOrCreateBatch(10)!,signal());
    assert.equal(reads,1);assert.deepEqual(store.chatMessageForQQ('outer')!.contents,resolved().contents);
  }finally{store.close();}
});

test('one bounded recovery deadline covers all expired snapshots in the batch with at most two reads in flight',async()=>{
  const store=new BridgeStore(':memory:',{type:'group',id:'1001'});
  try {
    for(const id of ['one','two','three']) {
      store.insert(message(id));
      store.recordForwardContent(snapshot({messageId:id,deadline:Date.now()-1000}));
    }
    store.insert(message('question',{trigger:true,rawJson:'{}'}));
    const reads:string[]=[];let active=0,maximumActive=0;
    const coordinator=new WorkerIncomingForwards({store,identity,logger,registerImages(){},request:async id=>{
      reads.push(id);active++;maximumActive=Math.max(maximumActive,active);
      await new Promise(resolve=>setTimeout(resolve,5));
      active--;return {snapshot:{...resolved(),messageId:id},attachments:[]};
    }});
    await coordinator.beforeContext(store.openOrCreateBatch(10)!,signal());
    assert.deepEqual(reads,['one','two','three']);assert.equal(maximumActive,2);
    for(const id of reads)assert.equal((store.chatMessageForQQ(id)!.contents![0] as {status:string}).status,'ready');
  }finally{store.close();}
});

test('a local timeout remains recoverable on a later round and plugin updates retain the failed view',async()=>{
  const store=fixture();
  try {
    store.recordForwardContent(snapshot({deadline:Date.now()-1000}));
    store.failPendingForwards('outer');
    store.applyEnrichment('outer','example',[{type:'video',title:'Independent material'}]);
    assert.equal((store.chatMessageForQQ('outer')!.contents![0] as {status:string}).status,'failed');
    assert.equal(store.forwardSnapshot('outer')!.contents[0]!.status,'pending');
    store.insert(message('question',{trigger:true,rawJson:'{}'}));
    const coordinator=new WorkerIncomingForwards({store,identity,logger,registerImages(){},request:async()=>({snapshot:resolved(),attachments:[]})});
    await coordinator.beforeContext(store.openOrCreateBatch(10)!,signal());
    assert.equal((store.chatMessageForQQ('outer')!.contents![0] as {status:string}).status,'ready');
    assert.deepEqual(store.chatMessageForQQ('outer')!.contents![1],{type:'video',title:'Independent material'});
  }finally{store.close();}
});
