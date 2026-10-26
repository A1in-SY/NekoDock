import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { BridgeStore } from '../src/store.js';
import { Processor } from '../src/processor.js';
import type { IncomingMessage } from '../src/types.js';
const message=(id:string):IncomingMessage=>({messageId:id,senderId:'2',senderName:'A',time:Math.floor(Date.now()/1000),text:id,replyTo:null,trigger:true,rawJson:'{}'});
async function until(check:()=>boolean){const deadline=Date.now()+2000;while(!check()){if(Date.now()>deadline)throw new Error('condition timeout');await delay(5);}}

test('drain waits through generation and all ACKs then leaves newer triggered messages queued',async()=>{
  const store=new BridgeStore(':memory:',{type:'group',id:'1'}),abort=new AbortController();
  let releaseGeneration!:()=>void,releaseAck!:()=>void;
  const generation=new Promise<void>(resolve=>releaseGeneration=resolve),ack=new Promise<void>(resolve=>releaseAck=resolve);
  let calls=0,sending=false;
  const processor=new Processor({store,agent:{async run(){calls++;await generation;return{messages:[{type:'text',text:'one'}]};}},sender:{async sendText(){sending=true;await ack;return{messageId:'qq1'};},async sendImage(){},async sendMessage(){}},logger:{info(){},warn(){},error(){}},batchSize:1,replyMaxChars:100,retryMs:5,workspace:'/tmp',imageMaxBytes:100,imageTimeoutMs:100});
  store.insert(message('1'));const running=processor.run(abort.signal);
  await until(()=>calls===1);processor.requestDrain();store.insert(message('2'));processor.notify();
  assert.equal(processor.isDrained,false);releaseGeneration();await until(()=>sending);assert.equal(processor.isDrained,false);
  releaseAck();await until(()=>processor.isDrained);assert.equal(calls,1);assert.equal(store.getCursor(),1);assert.equal(store.isBusy(),true);
  abort.abort();await running;store.close();
});

test('drain ends a failed delivery after one attempt and leaves newer work queued', async () => {
  const store = new BridgeStore(':memory:', { type: 'group', id: '1' }), abort = new AbortController();
  let attempts = 0; let release!: () => void;
  const gate = new Promise<void>(resolve => release = resolve);
  const processor = new Processor({ store, agent: { async run() { return { messages: [{ type: 'text', text: 'one' }] }; } },
    sender: { async sendText() { attempts++; await gate; throw new Error('offline'); }, async sendImage() {}, async sendMessage() {} },
    logger: { info() {}, warn() {}, error() {} }, batchSize: 1, replyMaxChars: 100, retryMs: 5, workspace: '/tmp', imageMaxBytes: 100, imageTimeoutMs: 100 });
  store.insert(message('1')); const running = processor.run(abort.signal);
  await until(() => attempts === 1); processor.requestDrain(); store.insert(message('2')); processor.notify();
  assert.equal(processor.isDrained, false); release(); await until(() => processor.isDrained);
  assert.equal(attempts, 1); assert.equal(store.getCursor(), 1); assert.equal(store.isBusy(), true);
  abort.abort(); await running; store.close();
});

test('repeated drain requests wait for the already-started command confirmation to ACK',async()=>{
 const store=new BridgeStore(':memory:',{type:'group',id:'1'}),abort=new AbortController();let attempts=0,allow=false;
 const processor=new Processor({store,agent:{async run(){throw new Error('command must not invoke model');}},sender:{async sendText(){attempts++;if(!allow)throw new Error('offline');},async sendImage(){},async sendMessage(){}},logger:{info(){},warn(){},error(){}},batchSize:1,replyMaxChars:100,retryMs:5,workspace:'/tmp',imageMaxBytes:100,imageTimeoutMs:100});
 store.insert({...message('help-command'),command:'help',text:'/help'});
 const running=processor.run(abort.signal);await until(()=>attempts>0);processor.requestDrain();
 await until(()=>attempts>1);processor.requestDrain();assert.equal(processor.isDrained,false);assert.equal(store.getPendingCommand()!.result,'help');
 allow=true;await until(()=>processor.isDrained);assert.equal(store.getPendingCommand(),null);
 abort.abort();await running;store.close();
});
