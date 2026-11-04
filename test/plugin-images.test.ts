import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createPluginImageReader,pluginSourceImageIds} from '../src/plugin-images.js';
import {WorkerIncomingImages} from '../src/incoming-image-cache.js';
import {BridgeStore} from '../src/store.js';
import {PluginCoordinator} from '../src/plugin-coordinator.js';
import {contextMessage} from '../src/pi-context.js';
import type {PluginResult} from '../src/plugin-contract.js';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
const logger={info(){},warn(){},error(){}};
const signal=()=>new AbortController().signal;
const message=(id='source')=>({messageId:id,senderId:'2001',senderName:'Example',time:1,text:'share',replyTo:null,trigger:true,rawJson:'{}'});
const image=(assetId:string,role='content')=>({id:assetId,assetId,url:'https://i0.hdslb.com/bfs/example.png',role,status:'ready'});
async function until(check:()=>boolean){const end=Date.now()+3000;while(!check()){if(Date.now()>end)throw new Error('Expected plugin image cache update');await new Promise(resolve=>setTimeout(resolve,10));}}

test('vision source selection excludes presentation, avatar, cover and offline previews',()=>{
  assert.deepEqual(pluginSourceImageIds([
    {authorAvatar:image('avatar','avatar'),blocks:[{type:'image',image:image('one')},{type:'image',image:image('presentation','presentation')},{type:'image',image:{...image('pending'),status:'pending'}}],original:{blocks:[{type:'image',image:image('original')}]}},
    {live:{status:'live',preview:image('preview','live_preview'),cover:image('cover','cover')}},
    {live:{status:'offline',preview:image('old-preview','live_preview')}},
  ]),['one','original','preview']);
});

test('plugin image reader uses instance authentication, enforces limits and never follows redirects',async()=>{
  const identity={url:'http://console.invalid',botId:'example',token:'synthetic',dataDir:'/tmp/example'};
  let reads=0;
  const reader=createPluginImageReader(identity,1024,1000,async(url,init)=>{
    reads++;assert.equal(String(url),'http://console.invalid/internal/workers/example/plugins/assets/asset-one');
    assert.equal((init?.headers as Record<string,string>).authorization,'Bearer synthetic');assert.equal(init?.redirect,'error');
    return new Response(png);
  });
  assert.deepEqual(await reader('asset-one',signal()),png);
  await assert.rejects(reader('../escape',signal()));assert.equal(reads,1);
  const oversize=createPluginImageReader(identity,10,1000,async()=>new Response(png));
  await assert.rejects(oversize('asset-one',signal()),/超过大小限制/u);
  const invalid=createPluginImageReader(identity,1024,1000,async()=>new Response('not an image'));
  await assert.rejects(invalid('asset-one',signal()),/格式不支持/u);
});

test('plugin pictures survive original image updates, share durable cache limits and restore after restart',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'plugin-picture-cache-'));
  const store=new BridgeStore(join(dir,'bridge.sqlite3'),{type:'group',id:'1001'});store.insert(message());store.insert(message('second'));
  let reads=0;
  const options={dbPath:join(dir,'images.sqlite3'),workspace:dir,maxBytes:1024,timeoutMs:1000,cacheDays:30,cacheMaxBytes:4096,logger,
    onUpdated:(id:string,images:Parameters<BridgeStore['recordIncomingImages']>[1])=>store.recordIncomingImages(id,images),
    pluginContent:async()=>{reads++;return png;},fetch:async()=>{throw new Error('External URL must not be fetched');}};
  let cache=new WorkerIncomingImages(options);
  t.after(async()=>{await cache.close();store.close();rmSync(dir,{recursive:true,force:true});});
  cache.start();cache.registerPlugin('source','example',['asset-one']);
  await until(()=>cache.lookup('source')[0]?.status==='ready');
  const first=cache.lookup('source')[0]!;assert.equal(first.origin,'plugin');assert.equal(first.assetId,'asset-one');
  store.recordIncomingImages('source',[{attachmentId:'qq-original',status:'failed',error:'Unavailable'}]);
  assert.equal(store.chatMessageForQQ('source')?.assets?.filter(a=>a.origin==='plugin').length,1);
  cache.registerPlugin('source','example',['asset-one']);assert.equal(cache.lookup('source').length,1);
  cache.registerPlugin('second','example',['asset-one']);await until(()=>cache.lookup('second')[0]?.status==='ready');
  assert.notEqual(cache.lookup('second')[0]?.attachmentId,first.attachmentId);
  await cache.close();const before=reads;
  cache=new WorkerIncomingImages({...options,pluginContent:async()=>{throw new Error('Cached plugin image must not be downloaded again');}});cache.start();
  const prepared=await cache.prepare([store.getMessage('source')!],signal());assert.equal(prepared.files.length,1);assert.equal(reads,before);
  assert.equal(prepared.byMessageId.get('source')?.[0]?.origin,'plugin');
});

test('source enrichment registers semantic pictures and ACKed presentation records no duplicate vision',async()=>{
  const store=new BridgeStore(':memory:',{type:'group',id:'1001'});store.insert(message());
  const controller=new AbortController();const registered:string[][]=[];
  const content={type:'post' as const,platform:'example',resourceId:'post:1',url:'https://example.invalid/post/1',title:'A post',blocks:[{type:'image' as const,image:{...image('source-picture'),role:'content' as const,status:'ready' as const}}],retrieval:{status:'ready' as const}};
  const results:PluginResult[]=[{id:'enrichment',kind:'enrichment',pluginId:'example',sourceMessageId:'source',conversationId:store.recorder.conversationId,revision:1,content},
    {id:'card',kind:'image',pluginId:'example',sourceMessageId:'source',conversationId:store.recorder.conversationId,revision:2,assetId:'derived-card',assetRole:'presentation',delivery:{status:'acknowledged',messageId:'9001'}}];
  const coordinator=new PluginCoordinator({identity:{url:'http://console.invalid',botId:'example',token:'synthetic',dataDir:'/tmp/example'},store,logger,notify(){},
    registerImages:(_message,_plugin,ids)=>registered.push(ids),request:async path=>path==='plugins'?{results,commands:[]}:{}},controller.signal);
  try{
    await coordinator.synchronize();assert.deepEqual(registered,[['source-picture']]);
    const chat=store.chatMessageForQQ('9001')!;assert.equal(chat.text,'[图片]');assert.equal(chat.replyTo,null);assert.equal(chat.sourceMessageId,'source');
    assert.equal(chat.assets?.[0]?.modelInput,false);assert.deepEqual(contextMessage(chat).images,[]);
    await coordinator.synchronize();assert.equal(store.recorder.pending().filter(e=>e.type==='plugin.message.sent').length,1);
  }finally{await coordinator.close();controller.abort();store.close();}
});
