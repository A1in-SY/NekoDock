import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConsoleEvent, ConversationView } from '../../src/console/contracts.ts';
import { conversationDisplay, mergeOlderConversation } from '../src/conversation-state.ts';

const event=(seq:number,type:string,payload:Record<string,unknown>):ConsoleEvent=>({seq,type,time:seq*1000,payload});
const view=(items:ConsoleEvent[]):ConversationView=>({id:'conversation',agentSessionId:null,startedAt:0,items,nextBefore:null,cursor:items.at(-1)?.seq??0,
  usage:{input:null,cached:null,output:null,total:null},context:{used:null,window:null,compactLimit:null}});

test('recall notices update the original message and its quote without adding a chat utterance',()=>{
  const source=event(1,'message.received',{messageId:'1001',senderName:'Example',text:'Original question'});
  const items=[source,event(2,'reply.accepted',{requestId:'reply-1',messages:[{type:'text',text:'Answer',replyTo:'1001'}],partCounts:[1]}),
    event(3,'delivery.acknowledged',{requestId:'reply-1',messageId:'2001',logicalMessageIndex:0,partIndex:0}),
    event(4,'message.recalled',{eventId:'recall-1',messageId:'1001',time:4})];
  const display=conversationDisplay(view(items));
  assert.equal(display.length,2);
  assert.equal(display[0]!.payload.recalled,true);
  assert.equal(display[0]!.payload.text,'Original question');
  const reply=(display[1]!.payload.messages as Record<string,unknown>[])[0]!;
  assert.deepEqual(reply.replyPreview,{messageId:'1001',senderName:'Example',text:'Original question',recalled:true});
  assert.equal(source.payload.recalled,undefined);
});

test('each logical reply tracks its own physical parts and target, including a recall before ACK',()=>{
  const items=[event(1,'message.received',{messageId:'1001',text:'A'}),event(2,'message.received',{messageId:'1002',text:'B'}),
    event(3,'reply.accepted',{requestId:'reply-1',partCounts:[2,1],messages:[{type:'text',text:'Long answer',replyTo:'1001'},{type:'text',text:'Other answer',replyTo:'1002'}]}),
    event(4,'message.recalled',{messageId:'2001',time:4}),
    event(5,'delivery.acknowledged',{requestId:'reply-1',messageId:'2001',logicalMessageIndex:0,partIndex:0}),
    event(6,'delivery.acknowledged',{requestId:'reply-1',messageId:'2002',logicalMessageIndex:0,partIndex:1}),
    event(7,'delivery.acknowledged',{requestId:'reply-1',messageId:'2003',logicalMessageIndex:1,partIndex:2})];
  const first=(conversationDisplay(view(items))[2]!.payload.messages as Record<string,unknown>[]);
  assert.equal(first[0]!.partiallyRecalled,true);assert.equal(first[0]!.recalled,false);assert.equal(first[1]!.recalled,undefined);
  assert.equal((first[1]!.replyPreview as Record<string,unknown>).messageId,'1002');
  items.push(event(8,'message.recalled',{messageId:'2002',time:8}));
  const next=(conversationDisplay(view(items))[2]!.payload.messages as Record<string,unknown>[]);
  assert.equal(next[0]!.recalled,true);assert.equal(next[0]!.partiallyRecalled,false);assert.equal(next[1]!.recalled,undefined);
});

test('older pages retain a live recall, while hydrated ACKs and quote previews work without source-page events',()=>{
  const source=event(1,'message.received',{messageId:'1001',text:'Keep original'});
  const current=view([event(10,'message.recalled',{messageId:'1001',time:10})]);
  const merged=mergeOlderConversation(current,view([source]));
  assert.equal(conversationDisplay(merged)[0]!.payload.recalled,true);
  const reply=event(11,'reply.accepted',{requestId:'r',partCounts:[1],messages:[{type:'text',text:'Answer',replyTo:'1001',replyPreview:{messageId:'1001',senderName:'Example',text:'Earlier',recalled:true}}],
    deliveries:[{messageId:'2001',logicalMessageIndex:0,partIndex:0,recalled:true}]});
  const message=(conversationDisplay(view([reply]))[0]!.payload.messages as Record<string,unknown>[])[0]!;
  assert.equal(message.recalled,true);assert.equal((message.replyPreview as Record<string,unknown>).recalled,true);
});

test('plugin source associations never become implicit quote targets',()=>{
  const display=conversationDisplay(view([event(1,'plugin.message.sent',{messageId:'2001',sourceMessageId:'1001',replyTo:null,text:'Card',recalled:true})]));
  assert.equal(display[0]!.payload.replyPreview,undefined);assert.equal(display[0]!.payload.recalled,true);
});

test('live logical recall totals update a paginated reply even when its ACKs are outside the loaded page',()=>{
  const accepted=event(1,'reply.accepted',{requestId:'r',messageRefs:['reply:r:0'],partCounts:[150],messages:[{type:'text',text:'A long response',deliverySummary:{totalParts:150,recalledParts:120}}]});
  const display=conversationDisplay(view([accepted,event(200,'message.recalled',{messageId:'last',messageRef:'reply:r:0',logicalPartCount:150,logicalRecallCount:150,logicalCancelledCount:0})]));
  const message=(display[0]!.payload.messages as Record<string,unknown>[])[0]!;
  assert.equal(message.recalled,true);assert.equal(message.recalledPartCount,150);
});

test('cancelled pending parts are distinct from recalled messages and never imply a platform send',()=>{
  const accepted=event(1,'reply.accepted',{requestId:'r',partCounts:[2],messages:[{type:'text',text:'Cancelled draft'}]});
  const display=conversationDisplay(view([accepted,event(2,'delivery.cancelled',{requestId:'r',logicalMessageIndex:0,partIndex:0}),event(3,'delivery.cancelled',{requestId:'r',logicalMessageIndex:0,partIndex:1})]));
  const message=(display[0]!.payload.messages as Record<string,unknown>[])[0]!;
  assert.equal(message.cancelled,true);assert.equal(message.recalled,undefined);
});

test('paginated recall summaries include cancelled pending parts when deciding whether the whole logical reply is withdrawn',()=>{
  const accepted=event(2,'reply.accepted',{requestId:'r',partCounts:[2],messages:[{type:'text',text:'Draft',deliverySummary:{totalParts:2,recalledParts:1,cancelledParts:1}}]});
  const message=(conversationDisplay(view([accepted]))[0]!.payload.messages as Record<string,unknown>[])[0]!;
  assert.equal(message.recalled,true);assert.equal(message.partiallyRecalled,false);assert.equal(message.cancelled,undefined);
});

test('hydrated ACKs and their raw page events describe the same physical delivery exactly once',()=>{
  const delivery={deliveryId:'1:0',requestId:'r',partIndex:0,logicalMessageIndex:0,messageId:'2001',recalled:true};
  const accepted=event(1,'reply.accepted',{requestId:'r',partCounts:[1],messages:[{type:'text',text:'Withdrawn answer'}],deliveries:[delivery]});
  const raw={...delivery,recalled:undefined};
  const display=conversationDisplay(view([accepted,event(2,'delivery.acknowledged',raw),event(3,'message.recalled',{messageId:'2001',time:3})]));
  assert.equal((display[0]!.payload.deliveries as unknown[]).length,1);
  const message=(display[0]!.payload.messages as Record<string,unknown>[])[0]!;
  assert.equal(message.recalled,true);assert.equal(message.recalledPartCount,1);
});
