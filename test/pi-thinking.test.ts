import assert from 'node:assert/strict';
import test from 'node:test';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { ThinkingObserver } from '../src/pi-thinking.js';
import type { RunObservation } from '../src/types.js';

const message=(content:AssistantMessage['content'])=>({role:'assistant',content} as AssistantMessage);

test('thinking snapshots merge visible blocks, throttle updates and use a distinct id for each assistant message',async()=>{
 const events:RunObservation[]=[];const observer=new ThinkingObserver(event=>events.push(event),30);
 observer.start();observer.update(message([{type:'thinking',thinking:'first'}]));
 observer.update(message([{type:'thinking',thinking:'first plus'},{type:'thinking',thinking:'second',thinkingSignature:'opaque-private-signature'}]));
 observer.update(message([{type:'thinking',thinking:'first plus more'},{type:'thinking',thinking:'second'}]));
 assert.equal(events.length,1);
 await new Promise(resolve=>setTimeout(resolve,45));assert.equal(events.length,2);
 observer.finish('completed',message([{type:'thinking',thinking:'first plus more'},{type:'thinking',thinking:'second final'}]));
 assert.equal(events.at(-1)!.payload.text,'first plus more\n\nsecond final');assert.equal(events.at(-1)!.payload.status,'completed');
 const id=events.at(-1)!.itemId;assert.ok(events.every(event=>event.itemId===id));
 observer.start();observer.finish('completed',message([{type:'thinking',thinking:'next response'}]));
 assert.notEqual(events.at(-1)!.itemId,id);assert.doesNotMatch(JSON.stringify(events),/opaque-private-signature|thinkingSignature/);
});

test('thinking snapshots cap visible text and omit encrypted/redacted and empty thoughts',()=>{
 const events:RunObservation[]=[];const observer=new ThinkingObserver(event=>events.push(event));
 observer.start();observer.finish('completed',message([{type:'thinking',thinking:'hidden-private-text',thinkingSignature:'encrypted-private',redacted:true}]));
 observer.start();observer.finish('completed',message([{type:'text',text:'plain answer'}]));assert.equal(events.length,0);
 observer.start();observer.finish('failed',message([{type:'thinking',thinking:'x'.repeat(40_000)}]));
 assert.equal(events.at(-1)!.payload.text!.toString().length,32_768);assert.equal(events.at(-1)!.payload.truncated,true);assert.equal(events.at(-1)!.payload.status,'failed');
 assert.doesNotMatch(JSON.stringify(events),/hidden-private-text|encrypted-private/);
});
