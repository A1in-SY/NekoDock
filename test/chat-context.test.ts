import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { BridgeStore } from '../src/store.js';
import { Processor } from '../src/processor.js';
import type { ContextSubmission } from '../src/chat-context-contract.js';
import type { IncomingMessage, PendingBatch } from '../src/types.js';

const target={type:'group' as const,id:'1001'};
const logger={info(){},warn(){},error(){}};
const message=(id:string,extra:Partial<IncomingMessage>={}):IncomingMessage=>({messageId:id,senderId:'2001',senderName:'User',time:1,text:`text ${id}`,replyTo:null,trigger:true,rawJson:'{}',...extra});
function commit(store:BridgeStore,context:ContextSubmission,session='session-example',entryId='entry-example') {
  store.commitContext({batchId:context.batchId,conversationId:context.conversationId,session,entryId,versions:context.versions});
}
function batch(store:BridgeStore):PendingBatch {return store.openOrCreateBatch(50)!;}
function complete(store:BridgeStore,pending:PendingBatch) {store.saveReplies(pending.throughSeq,[]);store.completeBatch(pending.throughSeq);}

test('staging and compatibility reads never consume external chat facts; only confirmed versions commit',()=>{
  const store=new BridgeStore(':memory:',target);
  try {
    for(let index=1;index<=31;index++)store.recordTaskReply(`report-${index}`,`report ${index}`,'task',store.recorder.conversationId,String(5000+index));
    store.insert(message('question'));
    const pending=batch(store),first=store.prepareContext(pending);
    assert.equal(first.messages.filter(value=>value.origin==='scheduled').length,31);
    assert.equal(store.takeExternalMessages().length,30);
    assert.equal(store.takeExternalMessages().length,30);
    store.setSessionId('session-example');commit(store,first);
    assert.deepEqual(store.takeExternalMessages(),[]);
    complete(store,pending);store.insert(message('next'));
    const next=store.prepareContext(batch(store));
    assert.deepEqual(next.messages.map(value=>value.messageId),['next']);
  } finally {store.close();}
});

test('bounded context pages leave omitted facts pending rather than consuming the entire table',()=>{
  const store=new BridgeStore(':memory:',target);
  try {
    for(let index=0;index<130;index++)store.recordTaskReply(`report-${index}`,`report ${index}`,'task',store.recorder.conversationId);
    store.insert(message('question'));store.setSessionId('session-example');
    const pending=batch(store),first=store.prepareContext(pending);
    const firstReports=first.messages.filter(value=>value.origin==='scheduled');assert.equal(firstReports.length,100);
    commit(store,first);complete(store,pending);store.insert(message('next'));
    const second=store.prepareContext(batch(store));
    const secondReports=second.messages.filter(value=>value.origin==='scheduled');assert.equal(secondReports.length,30);
    assert.equal(new Set([...firstReports,...secondReports].map(value=>value.chatMessageId)).size,130);
  } finally {store.close();}
});

test('a version changed after staging remains dirty after the earlier version commits',()=>{
  const store=new BridgeStore(':memory:',target);
  try {
    store.insert(message('share'));store.setSessionId('session-example');
    const pending=batch(store),first=store.prepareContext(pending);
    assert.equal(first.messages[0]!.revision,1);
    store.applyEnrichment('share','example',[{type:'video',title:'Verified title'}]);
    commit(store,first);complete(store,pending);store.insert(message('next'));
    const next=store.prepareContext(batch(store));
    assert.equal(next.revisions.length,1);assert.equal(next.revisions[0]!.message.revision,2);
    assert.equal(next.revisions[0]!.entryId,'entry-example');
    assert.deepEqual(next.revisions[0]!.message.contents,[{type:'video',title:'Verified title'}]);
  } finally {store.close();}
});

test('late image revisions and an exact reference expose the ready local asset',()=>{
  const store=new BridgeStore(':memory:',target);
  try {
    store.insert(message('image',{text:'[图片]'}));
    store.recordIncomingImages('image',[{attachmentId:'image-asset',status:'pending'}]);
    store.setSessionId('session-example');const pending=batch(store),first=store.prepareContext(pending);
    commit(store,first);complete(store,pending);
    store.recordIncomingImages('image',[{attachmentId:'image-asset',status:'ready',path:'/data/workspace/.qq-images/example.png'}]);
    store.insert(message('follow-up',{replyTo:'image'}));
    const next=store.prepareContext(batch(store));
    assert.equal(next.revisions[0]!.message.assets?.[0]?.status,'ready');
    assert.equal(next.references[0]!.messageId,'image');
    assert.equal(next.references[0]!.assets?.[0]?.path,'/data/workspace/.qq-images/example.png');
  } finally {store.close();}
});

test('newer plugin enrichments are merged by plugin and older retries cannot replace them',()=>{
  const store=new BridgeStore(':memory:',target);
  try {
    store.insert(message('share'));
    assert.equal(store.applyEnrichment('share','one',[{title:'new'}],2),true);
    assert.equal(store.applyEnrichment('share','one',[{title:'stale'}],1),false);
    assert.equal(store.applyEnrichment('share','two',[{description:'independent'}],1),true);
    assert.deepEqual(store.chatMessageForQQ('share')!.contents,[{title:'new'},{description:'independent'}]);
  } finally {store.close();}
});

test('resource merges keep independent revisions and do not bump chat versions for identical retries',()=>{
  const store=new BridgeStore(':memory:',target);
  try {
    store.insert(message('share'));
    assert.equal(store.mergeEnrichment('share','example',{resourceId:'one',title:'new'},5),true);
    const revision=store.chatMessageForQQ('share')!.revision;
    assert.equal(store.mergeEnrichment('share','example',{resourceId:'one',title:'new'},6),false);
    assert.equal(store.chatMessageForQQ('share')!.revision,revision);
    assert.equal(store.mergeEnrichment('share','example',{resourceId:'one',title:'stale'},4),false);
    assert.equal(store.mergeEnrichment('share','example',{resourceId:'two',title:'independent'},1),true);
    assert.deepEqual(store.chatMessageForQQ('share')!.contents,[{resourceId:'one',title:'new'},{resourceId:'two',title:'independent'}]);
  } finally {store.close();}
});

test('a single Bilibili JSON card is simplified in the projection while original chat data is retained',()=>{
  const store=new BridgeStore(':memory:',target);
  try {
    const card={prompt:'Video title',meta:{detail_1:{qqdocurl:'https://www.bilibili.com/video/BVexample'}}};
    const raw=JSON.stringify({message:[{type:'json',data:{data:JSON.stringify(card)}}]});
    store.insert(message('share',{text:`[JSON ${JSON.stringify(card)}]`,rawJson:raw}));
    store.mergeEnrichment('share','bilibili',{type:'video',platform:'bilibili',resourceId:'video-example',title:'Video title'},1);
    assert.equal(store.chatMessageForQQ('share')!.text,'[哔哩哔哩视频分享]');
    assert.equal(store.getMessage('share')!.rawJson,raw);
    assert.ok(store.getMessage('share')!.text.includes('qqdocurl'));
    assert.equal(store.recorder.pending().findLast(event=>event.type==='message.content.updated')!.payload.text,'[哔哩哔哩视频分享]');
    store.insert(message('text-share',{text:'Please discuss this https://www.bilibili.com/video/BVexample'}));
    store.mergeEnrichment('text-share','bilibili',{type:'video',platform:'bilibili',resourceId:'video-example',title:'Video title'},1);
    assert.equal(store.chatMessageForQQ('text-share')!.text,'Please discuss this https://www.bilibili.com/video/BVexample');
  } finally {store.close();}
});

for(const [pluginId,type,label] of [['heybox','game','小黑盒游戏'],['douyin','video','抖音视频']] as const) {
  test(`${pluginId} cards keep one original share and update its context without retaining tracking payloads`,()=>{
    const store=new BridgeStore(':memory:',target);
    try {
      const card={prompt:'Synthetic share',meta:{detail_1:{qqdocurl:'https://example.invalid/share?tracking=synthetic-marker'}}};
      const raw=JSON.stringify({message:[{type:'json',data:{data:JSON.stringify(card)}}]});
      store.insert(message('share',{text:`[JSON ${JSON.stringify(card)}]`,rawJson:raw,trigger:false}));
      store.setSessionId('session-example');store.insert(message('first-question'));
      const firstBatch=batch(store),initial=store.prepareContext(firstBatch);commit(store,initial);complete(store,firstBatch);
      const content={type,platform:pluginId,resourceId:'synthetic-resource',title:'Verified share',description:'Verified details.'};
      assert.equal(store.applyEnrichment('share',pluginId,[content],1),true);
      assert.equal(store.chatMessageForQQ('share')!.text,`[${label}分享]`);
      assert.equal(store.getMessage('share')!.rawJson,raw);
      store.insert(message('follow-up',{replyTo:'share'}));
      const next=store.prepareContext(batch(store));
      assert.equal(next.messages.filter(item=>item.messageId==='share').length,0);
      assert.equal(next.revisions.filter(item=>item.message.messageId==='share').length,1);
      assert.deepEqual(next.revisions.find(item=>item.message.messageId==='share')!.message.contents,[content]);
      assert.doesNotMatch(JSON.stringify(next),/synthetic-marker/);
      assert.equal(next.references.find(item=>item.messageId==='share')!.text,`[${label}分享]`);
      store.insert(message('text-share',{text:'What do you think of this https://example.invalid/share?source=copy'}));
      store.applyEnrichment('text-share',pluginId,[content],1);
      assert.equal(store.chatMessageForQQ('text-share')!.text,'What do you think of this https://example.invalid/share?source=copy');
    }finally{store.close();}
  });
}

test('scheduled chat-history projection reads the same enhanced message version',()=>{
  const store=new BridgeStore(':memory:',target);
  try {
    store.insert(message('share',{time:10}));
    store.mergeEnrichment('share','example',{resourceId:'video-example',title:'Verified title'},1);
    const history=store.readTaskChat(0,20_000,false,20);
    assert.equal(history.messages[0]!.text,'text share');
    assert.deepEqual((history.messages[0] as unknown as {contents:unknown[]}).contents,[{resourceId:'video-example',title:'Verified title'}]);
  } finally {store.close();}
});

test('model output is not repeated as new chat and real QQ references identify the exact sent part',()=>{
  const store=new BridgeStore(':memory:',target);
  try {
    store.insert(message('question'));store.setSessionId('session-example');const pending=batch(store);
    commit(store,store.prepareContext(pending));
    store.appendReplyRequest(pending.throughSeq,'request-one',[{type:'text',text:'one'},{type:'text',text:'two'}],['one','two'],[0,1],'tool-one');
    store.acknowledgeReply(pending.throughSeq,0,'9001');store.acknowledgeReply(pending.throughSeq,1,'9002');
    store.finishGeneration(pending.throughSeq);store.completeBatch(pending.throughSeq);
    store.insert(message('follow-up',{replyTo:'9002'}));const next=store.prepareContext(batch(store));
    assert.ok(next.messages.every(value=>value.origin!=='model'));
    assert.deepEqual(next.receipts?.map(value=>[value.toolCallId,value.messageId,value.logicalMessageIndex]),[['tool-one','9001',0],['tool-one','9002',1]]);
    assert.equal(next.references[0]!.text,'two');assert.equal(next.references[0]!.messageId,'9002');
  } finally {store.close();}
});

test('a successful send without platform ID does not manufacture a QQ identity',()=>{
  const store=new BridgeStore(':memory:',target);
  try {
    store.recordTaskReply('task-reply','sent content','task',store.recorder.conversationId);
    store.insert(message('question',{replyTo:'task-reply'}));
    const context=store.prepareContext(batch(store));
    assert.equal(context.messages.find(value=>value.origin==='scheduled')!.messageId,null);
    assert.deepEqual(context.references,[]);assert.equal(store.chatMessageForQQ('task-reply'),null);
  } finally {store.close();}
});

test('plugin reply source ownership and /new keep late facts in their source conversation',()=>{
  const store=new BridgeStore(':memory:',target);
  try {
    store.insert(message('share'));const old=store.getMessageConversation('share')!;
    store.insert(message('reset',{command:'new'}));const command=store.getPendingCommand()!;
    store.resetSessionForCommand(command.id);store.acknowledgeCommand(command.id);
    const current=store.recorder.conversationId;assert.notEqual(old,current);
    assert.equal(store.recordPluginReply({id:'wrong',conversationId:current,pluginId:'example',sourceMessageId:'share',text:'wrong scope'}),false);
    assert.equal(store.recordPluginReply({id:'old-result',conversationId:old,pluginId:'example',sourceMessageId:'share',text:'completed earlier source',qqMessageId:'9001'}),true);
    assert.equal(store.recordPluginReply({id:'old-result',conversationId:old,pluginId:'example',sourceMessageId:'share',text:'completed earlier source',qqMessageId:'9001'}),false);
    store.insert(message('next'));assert.ok(store.prepareContext(batch(store)).messages.every(value=>value.conversationId===current));
  } finally {store.close();}
});

test('plugin video source association is independent of its actual platform quote',()=>{
  const store=new BridgeStore(':memory:',target);
  try {
    store.insert(message('share',{time:10}));const conversationId=store.recorder.conversationId;
    assert.equal(store.recordPluginReply({id:'video',conversationId,pluginId:'example',sourceMessageId:'share',replyTo:null,
      text:'[视频]',qqMessageId:'9001',time:11,assets:[{id:'video-asset',type:'video',status:'ready'}]}),true);
    const video=store.chatMessageForQQ('9001')!;
    assert.equal(video.sourceMessageId,'share');assert.equal(video.replyTo,null);
    assert.equal(store.readTaskChat(0,20_000,true,20).messages.find(value=>value.id==='9001')?.replyTo,null);
    const context=store.prepareContext(batch(store));
    assert.equal(context.messages.find(value=>value.messageId==='9001')?.replyTo,null);
    assert.equal(context.messages.find(value=>value.messageId==='9001')?.sourceMessageId,'share');
    store.recordPluginReply({id:'legacy',conversationId,pluginId:'example',sourceMessageId:'share',replyTo:'share',text:'[视频]',qqMessageId:'9002',time:12});
    assert.equal(store.recordPluginReply({id:'legacy',conversationId,pluginId:'example',sourceMessageId:'share',replyTo:null,text:'[视频]',qqMessageId:'9002',time:12}),false);
    assert.equal(store.chatMessageForQQ('9002')!.replyTo,'share');
  } finally {store.close();}
});

test('messages arriving after the selected batch are not prematurely added as background facts',()=>{
  const store=new BridgeStore(':memory:',target);
  try {
    store.insert(message('first'));const pending=batch(store);store.insert(message('later'));
    assert.deepEqual(store.prepareContext(pending).messages.map(value=>value.messageId),['first']);
  } finally {store.close();}
});

test('equal platform timestamps keep durable arrival order rather than sorting random QQ IDs',()=>{
  const store=new BridgeStore(':memory:',target);
  try {
    store.insert(message('9002'));store.insert(message('1001'));
    assert.deepEqual(store.prepareContext(batch(store)).messages.map(value=>value.messageId),['9002','1001']);
  } finally {store.close();}
});

test('a source received after a queued /new waits for the authoritative new conversation binding',()=>{
  const store=new BridgeStore(':memory:',target);
  try {
    store.insert(message('old'));const old=store.getMessageConversation('old');
    store.insert(message('reset',{command:'new'}));store.insert(message('new-share'));
    assert.equal(store.getMessageConversation('new-share'),null);
    const command=store.getPendingCommand()!;store.resetSessionForCommand(command.id);store.acknowledgeCommand(command.id);
    assert.equal(store.getMessageConversation('new-share'),store.recorder.conversationId);
    assert.notEqual(store.getMessageConversation('new-share'),old);
  } finally {store.close();}
});

test('incorrect batch versions cannot acknowledge unsubmitted content',()=>{
  const store=new BridgeStore(':memory:',target);
  try {
    store.insert(message('question'));const context=store.prepareContext(batch(store));
    assert.throws(()=>store.commitContext({batchId:context.batchId,conversationId:context.conversationId,session:'session',entryId:'entry',versions:[{chatMessageId:'in:question',revision:99}]}),/staged/);
    assert.equal(store.prepareContext(batch(store)).messages[0]!.messageId,'question');
  } finally {store.close();}
});

test('a failed input preparation retains scheduled chat facts for the next ordinary request',async()=>{
  const root=mkdtempSync(join(tmpdir(),'chat-context-failure-'));
  const store=new BridgeStore(join(root,'bridge.sqlite3'),target),abort=new AbortController();
  const received:ContextSubmission[]=[];
  const processor=new Processor({store,agent:{async run(pending){received.push(pending.context!);if(received.length===1)throw Error('Failed before persistence');return {messages:[]};}},
    sender:{async sendText(){},async sendImage(){},async sendMessage(){}},logger,batchSize:50,replyMaxChars:1500,retryMs:1,workspace:root,imageMaxBytes:1024,imageTimeoutMs:10});
  let running:Promise<void>|undefined;
  const wait=async(check:()=>boolean)=>{const end=Date.now()+3000;while(!check()){if(Date.now()>end)throw Error('Timed out');await new Promise(resolve=>setTimeout(resolve,5));}};
  try {
    store.recordTaskReply('report','scheduled report','task',store.recorder.conversationId,'9010');store.insert(message('first'));
    running=processor.run(abort.signal);await wait(()=>store.getCursor()===1);
    store.insert(message('second'));processor.notify();await wait(()=>store.getCursor()===2);
    assert.equal(received.length,2);
    assert.ok(received.every(context=>context.messages.some(value=>value.text==='scheduled report')));
    assert.deepEqual(store.takeExternalMessages(),[]);
    const db=new DatabaseSync(join(root,'bridge.sqlite3'),{readOnly:true});
    try {assert.equal(db.prepare('SELECT context_consumed FROM outgoing_history WHERE id=?').get('report')!.context_consumed,1);}finally{db.close();}
  } finally {abort.abort();await running;store.close();rmSync(root,{recursive:true,force:true});}
});

test('staged context IDs are scoped to the current conversation and unknown receipts cannot claim a session',()=>{
  const store=new BridgeStore(':memory:',target);
  try {
    store.insert(message('old'));const context=store.prepareContext(batch(store));
    assert.deepEqual(store.pendingContextBatchIds(),[context.batchId]);
    assert.equal(store.commitContext({batchId:'unknown',conversationId:context.conversationId,session:'wrong-session',entryId:'entry',versions:[]}),false);
    store.insert(message('reset',{command:'new'}));store.resetSessionForCommand(store.getPendingCommand()!.id);
    assert.deepEqual(store.pendingContextBatchIds(),[]);
  } finally {store.close();}
});

test('Processor recovers a newly persisted Pi session before session IPC without replaying the interrupted generation',async()=>{
  const root=mkdtempSync(join(tmpdir(),'chat-first-session-recovery-'));
  const store=new BridgeStore(join(root,'bridge.sqlite3'),target),abort=new AbortController();
  const received:Array<{context:ContextSubmission;session:string|null}>=[];
  const recoverCalls:Array<{session:string|null;ids:string[]}> = [];
  let persisted:ContextSubmission|undefined;
  const processor=new Processor({store,agent:{supportsContextCommits:true,
    async recoverContext(session,onCommit,ids=[]){
      recoverCalls.push({session,ids});
      onCommit({batchId:'unrelated-batch',conversationId:store.recorder.conversationId,session:'wrong-session',entryId:'wrong-entry',versions:[]});
      if(persisted&&ids.includes(persisted.batchId))onCommit({batchId:persisted.batchId,conversationId:persisted.conversationId,
        session:'recovered-session',entryId:'persisted-user-entry',versions:persisted.versions});
    },
    async run(pending,session,_save,_signal,_reply,observe){
      received.push({context:pending.context!,session});
      if(received.length===1){persisted=pending.context!;throw Error('Exited after fsync before session IPC');}
      observe?.({type:'context.committed',payload:{batchId:pending.context!.batchId,conversationId:pending.context!.conversationId,
        session:'recovered-session',entryId:'next-user-entry',versions:pending.context!.versions}});
      return {messages:[]};
    }},sender:{async sendText(){throw Error('Must not replay QQ send');},async sendImage(){},async sendMessage(){}},
    logger,batchSize:50,replyMaxChars:1500,retryMs:1,workspace:root,imageMaxBytes:1024,imageTimeoutMs:10});
  let running:Promise<void>|undefined;
  const wait=async(check:()=>boolean)=>{const end=Date.now()+3000;while(!check()){if(Date.now()>end)throw Error('Timed out');await new Promise(resolve=>setTimeout(resolve,5));}};
  try {
    store.recordTaskReply('report','scheduled report','task',store.recorder.conversationId,'9010');store.insert(message('first'));
    running=processor.run(abort.signal);await wait(()=>store.getCursor()===1);
    assert.equal(store.getSessionId(),null);assert.equal(store.pendingContextBatchIds().length,1);
    store.insert(message('second'));processor.notify();await wait(()=>store.getCursor()===2);
    assert.equal(received.length,2);assert.equal(received[1]!.session,'recovered-session');
    assert.deepEqual(received[1]!.context.messages.map(value=>value.messageId),['second']);
    assert.equal(store.getSessionId(),'recovered-session');assert.deepEqual(store.pendingContextBatchIds(),[]);
    assert.ok(recoverCalls.some(call=>call.session===null&&call.ids.includes(persisted!.batchId)));
  } finally {abort.abort();await running;store.close();rmSync(root,{recursive:true,force:true});}
});

test('restart recovery confirms the persisted first input before abandoning a started batch',async()=>{
  const root=mkdtempSync(join(tmpdir(),'chat-started-batch-recovery-'));
  const store=new BridgeStore(join(root,'bridge.sqlite3'),target),abort=new AbortController();
  store.insert(message('interrupted'));const pending=batch(store),context=store.prepareContext(pending);store.markGenerationStarted(pending.throughSeq);
  let runs=0;
  const processor=new Processor({store,agent:{supportsContextCommits:true,
    async recoverContext(session,onCommit,ids=[]){assert.equal(session,null);assert.ok(ids.includes(context.batchId));onCommit({batchId:context.batchId,conversationId:context.conversationId,
      session:'recovered-before-abandon',entryId:'first-entry',versions:context.versions});},
    async run(){runs++;throw Error('The interrupted round must not run again');}},
    sender:{async sendText(){throw Error('Must not resend');},async sendImage(){},async sendMessage(){}},logger,batchSize:50,
    replyMaxChars:1500,retryMs:1,workspace:root,imageMaxBytes:1024,imageTimeoutMs:10});
  let running:Promise<void>|undefined;
  try {
    running=processor.run(abort.signal);const end=Date.now()+3000;
    while(store.getCursor()!==1){if(Date.now()>end)throw Error('Timed out');await new Promise(resolve=>setTimeout(resolve,5));}
    assert.equal(runs,0);assert.equal(store.getSessionId(),'recovered-before-abandon');assert.deepEqual(store.pendingContextBatchIds(),[]);
  } finally {abort.abort();await running;store.close();rmSync(root,{recursive:true,force:true});}
});
