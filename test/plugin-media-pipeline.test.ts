import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { ConsoleDatabase } from '../src/console/database.js';
import { createConsole } from '../src/console/server.js';
import type { DockerClient } from '../src/console/docker.js';
import type { ContentPluginDefinition, PluginContent, PluginManifest, PluginRunnerJob, PluginRunnerResult } from '../src/plugin-system/contracts.js';
import { PLUGIN_MANIFESTS, contentPlugins } from '../src/plugin-system/registry.js';
import { resolvePluginAssetKeys, runPluginRunner } from '../src/plugin-runner.js';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAFElEQVR4nGPUaLrEwMDAxAAGUAoAG94BgqFCKSEAAAAASUVORK5CYII=','base64');
const gif=Buffer.from('R0lGODdhAgADAIEAACiC0gAAAAAAAAAAACwAAAAAAgADAAAIBgABCBwYEAA7','base64');
const webp=Buffer.from('UklGRjoAAABXRUJQVlA4IC4AAAAQAgCdASoCAAMAAUAmJaACdLoB+AH4AAPIAP7oOL/6gsFZl+9h/9GC4Dge8IAA','base64');
const jpeg=Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAADAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDPooor7E+RP//Z','base64');
const pluginId='synthetic-media';
const resource={kind:'post',id:'post:12345',url:'https://example.org/posts/12345'};
const content:PluginContent={type:'post',platform:'synthetic',resourceId:resource.id,url:resource.url,title:'Synthetic post',description:'Synthetic text',retrieval:{status:'ready'}};

function definition(mode:'none'|'original'|'card'='original',provideContext=true):ContentPluginDefinition {
  return {kind:'content',manifest:{id:pluginId,name:'Synthetic media',version:'1.0.0',apiVersion:1,required:false,resourceTypes:['post'],commands:[]},defaults:{},validateConfig:value=>value as Record<string,unknown>,
    match:()=>[resource],command:()=>undefined,validateContent:value=>value as PluginContent,contentText:()=>content.description!,failureContent:()=>({...content,retrieval:{status:'failed'}}),errorText:()=> 'Synthetic failure',
    shouldProcess:()=>true,policy:()=>({timeoutSeconds:30,waitSeconds:0,maxAssetBytes:10*1024*1024,cacheMaxBytes:20*1024*1024,cacheHours:1}),summarize:source=>source?{id:source.id,url:source.url}:undefined,missingResourceText:'Missing link',
    afterResolve:()=>({provideContext,prepare:{mode,provideContext}})};
}
function registerDefinition(t:TestContext,mode:'none'|'original'|'card'='original',provideContext=true) {
  const plugin=definition(mode,provideContext);(PLUGIN_MANIFESTS as PluginManifest[]).push(plugin.manifest);(contentPlugins as ContentPluginDefinition[]).push(plugin);
  t.after(()=>{(PLUGIN_MANIFESTS as PluginManifest[]).splice(PLUGIN_MANIFESTS.indexOf(plugin.manifest),1);(contentPlugins as ContentPluginDefinition[]).splice(contentPlugins.indexOf(plugin),1);});
}
function fixture(t:TestContext,mode:'none'|'original'|'card'='original',provideContext=true) {
  registerDefinition(t,mode,provideContext);const root=mkdtempSync(join(tmpdir(),'plugin-media-')),path=join(root,'console.sqlite3'),db=new ConsoleDatabase(path,join(root,'key'));
  const bot=db.createBot({name:'Synthetic bot',targetType:'group',targetId:'1001',config:{}});db.setDesiredState(bot.id,'running');db.plugins.update(bot.id,pluginId,{expectedRevision:0,enabled:true});
  t.after(()=>{db.close();rmSync(root,{recursive:true,force:true});});return {root,path,db,bot};
}
function resolve(f:ReturnType<typeof fixture>,source='share') {
  f.db.plugins.register(f.bot.id,{message_id:source,message:[{type:'text',data:{text:resource.url}}]});
  f.db.plugins.sync(f.bot.id,{bindings:[{messageId:source,conversationId:'conversation'}],conversationId:'conversation'});
  const job=f.db.plugins.claim()!;assert.equal(job.operation,'resolve');f.db.plugins.complete(job.id,job.lease,{content});
  const prepare=f.db.plugins.claim()!;assert.equal(prepare.operation,'prepare');return prepare;
}

for(const provideContext of [true,false])test(`terminal prepare failure settles pending source pictures with context=${provideContext}`,t=>{
  const f=fixture(t,'card',provideContext);
  f.db.plugins.register(f.bot.id,{message_id:'share',message:[{type:'text',data:{text:resource.url}}]});
  f.db.plugins.sync(f.bot.id,{bindings:[{messageId:'share',conversationId:'conversation'}],conversationId:'conversation'});
  const first=f.db.plugins.claim()!;
  const pending:PluginContent={...content,blocks:[{type:'image',image:{id:'picture',url:'https://example.org/picture.png',role:'content',status:'pending'}}]};
  f.db.plugins.complete(first.id,first.lease,{content:pending});
  const prepare=f.db.plugins.claim()!;assert.equal(prepare.operation,'prepare');
  f.db.plugins.complete(prepare.id,prepare.lease,{error:'PLUGIN_ASSET_UPLOAD_FAILED',retryable:false});
  const results=f.db.plugins.snapshot(f.bot.id).results;
  const enrichments=results.filter(value=>value.kind==='enrichment');
  assert.equal(enrichments.length,provideContext?2:0);
  if(provideContext){const latest=enrichments.at(-1)!.content!;assert.equal(latest.retrieval.status,'partial');
    assert.equal(latest.blocks?.[0]?.type,'image');if(latest.blocks?.[0]?.type==='image')assert.equal(latest.blocks[0].image.status,'failed');}
  assert.equal(results.filter(value=>value.kind!=='enrichment').length,0);
});
async function asset(f:ReturnType<typeof fixture>,job:PluginRunnerJob,key='source',role='content') {
  const id=await f.db.pluginAssets.upload(join(f.root,'assets'),f.bot.id,Readable.from([png]),{type:'image',maxBytes:1024,cacheMaxBytes:10240,cacheHours:1});
  f.db.plugins.attachAsset(job.id,job.lease,id,key,'image',role);return id;
}

test('plugin image assets validate supported byte formats, dimensions, snapshots and instance isolation',async t=>{
  const f=fixture(t);for(const [bytes,mime] of [[png,'image/png'],[gif,'image/gif'],[jpeg,'image/jpeg'],[webp,'image/webp']] as const) {
    const id=await f.db.pluginAssets.upload(join(f.root,'assets'),f.bot.id,Readable.from([bytes]),{type:'image',maxBytes:1024,cacheMaxBytes:4096,cacheHours:1});
    const info=f.db.pluginAssets.info(f.bot.id,id)!;assert.equal(info.type,'image');assert.equal(info.mimeType,mime);assert.equal(info.width,2);assert.equal(info.height,3);
    assert.equal(await f.db.pluginAssets.imageSnapshot(f.bot.id,id,1024),'base64://'+bytes.toString('base64'));assert.equal(f.db.pluginAssets.info('other-bot',id),null);
    await assert.rejects(f.db.pluginAssets.imageSnapshot(f.bot.id,id,1),/上限/u);
  }
  await assert.rejects(f.db.pluginAssets.upload(join(f.root,'assets'),f.bot.id,Readable.from([png.subarray(0,30)]),{type:'image',maxBytes:1024,cacheMaxBytes:4096,cacheHours:1}),/格式/u);
  const bomb=Buffer.from(png);bomb.writeUInt32BE(100000,16);bomb.writeUInt32BE(100000,20);
  await assert.rejects(f.db.pluginAssets.upload(join(f.root,'assets'),f.bot.id,Readable.from([bomb]),{type:'image',maxBytes:1024,cacheMaxBytes:4096,cacheHours:1}),/像素/u);
});

test('prepare results publish source revision immediately and reveal output parts only after the preceding ACK',async t=>{
  const f=fixture(t),job=resolve(f),id=await asset(f,job);
  assert.equal(job.presentation?.mode,'original');assert.equal(job.command,'share');assert.equal(f.db.plugins.snapshot(f.bot.id).results.filter(value=>value.kind==='enrichment').length,1);
  const prepared={...content,blocks:[{type:'image' as const,image:{id:'image-one',url:'https://cdn.example.org/image.png',role:'content' as const,assetId:id,status:'ready' as const}}]};
  f.db.plugins.complete(job.id,job.lease,{content:prepared,outputs:[{kind:'reply',text:'Synthetic text'},{kind:'image',assetId:id,assetRole:'presentation'}]});
  let values=f.db.plugins.snapshot(f.bot.id).results;
  assert.equal(values.filter(value=>value.kind==='enrichment').length,2);const first=values.find(value=>value.kind==='reply')!;assert.ok(first);assert.equal(first.partIndex,0);assert.equal(values.some(value=>value.kind==='image'),false);
  const imageId=`output:${job.id}:001`;assert.throws(()=>f.db.plugins.authorizeSend(f.bot.id,imageId),/前序/u);
  f.db.plugins.finishSend(f.bot.id,first.id,{ok:true,messageId:'actual-text-id'});
  values=f.db.plugins.snapshot(f.bot.id).results;const image=values.find(value=>value.kind==='image')!;assert.equal(image.assetRole,'content');assert.equal(image.replyTo,null);assert.equal(image.assetId,id);
  f.db.plugins.finishSend(f.bot.id,image.id,{ok:true,messageId:'actual-image-id'});
  f.db.plugins.finishSend(f.bot.id,image.id,{ok:false,code:'SHOULD_NOT_REPLACE',deliveryStatus:'failed'});
  assert.equal(f.db.plugins.getResult(f.bot.id,image.id)?.delivery?.messageId,'actual-image-id');
  const record=f.db.plugins.jobs(f.bot.id).find(value=>value.id===job.id)!;assert.equal(record.state,'completed');assert.ok(record.finishedAt);assert.deepEqual(record.deliveries.map(value=>value.status),['acknowledged','acknowledged']);
});

test('unknown send outcomes stop later output parts while retaining completed earlier parts',async t=>{
  const f=fixture(t),job=resolve(f),id=await asset(f,job);
  f.db.plugins.complete(job.id,job.lease,{content,outputs:[{kind:'reply',text:'First'},{kind:'image',assetId:id},{kind:'reply',text:'Third'}]});
  const first=`output:${job.id}:000`,second=`output:${job.id}:001`,third=`output:${job.id}:002`;
  f.db.plugins.finishSend(f.bot.id,first,{ok:true,messageId:'actual-first'});
  f.db.plugins.finishSend(f.bot.id,second,{ok:false,code:'NAPCAT_RESPONSE_TIMEOUT',deliveryStatus:'unconfirmed'});
  assert.equal(f.db.plugins.getResult(f.bot.id,first)?.delivery?.status,'acknowledged');assert.equal(f.db.plugins.getResult(f.bot.id,second)?.delivery?.status,'unconfirmed');
  assert.deepEqual(f.db.plugins.getResult(f.bot.id,third)?.delivery,{status:'failed',code:'PLUGIN_PREVIOUS_OUTPUT_FAILED'});
  f.db.plugins.sync(f.bot.id,{acknowledgements:[first,second,third]});assert.equal(f.db.plugins.snapshot(f.bot.id).results.some(value=>value.kind!=='enrichment'),false);
});

test('prepare rejects cross-source asset references and publishes no partial outputs on invalid completion',async t=>{
  const f=fixture(t),firstJob=resolve(f,'one'),id=await asset(f,firstJob);
  f.db.plugins.complete(firstJob.id,firstJob.lease,{content,outputs:[]});
  const second=resolve(f,'two');
  const foreign={...content,blocks:[{type:'image' as const,image:{id:'other',url:'https://cdn.example.org/photo.png',role:'content' as const,assetId:id}}]};
  assert.throws(()=>f.db.plugins.complete(second.id,second.lease,{content:foreign,outputs:[{kind:'reply',text:'Must not publish'}]}),/不属于/u);
  assert.throws(()=>f.db.plugins.complete(second.id,second.lease,{content,outputs:[{kind:'reply',text:'Must not publish'},{kind:'image',assetId:id}]}),/不属于/u);
  assert.equal(f.db.plugins.getResult(f.bot.id,`output:${second.id}:000`),null);
});

test('presentation assets cannot be inserted as original content and context-only jobs cannot send',async t=>{
  const f=fixture(t,'none'),job=resolve(f),id=await asset(f,job,'card','presentation');
  const wrong={...content,blocks:[{type:'image' as const,image:{id:'card',url:'https://cdn.example.org/card.png',role:'content' as const,assetId:id}}]};
  assert.throws(()=>f.db.plugins.complete(job.id,job.lease,{content:wrong}),/不属于/u);
  assert.throws(()=>f.db.plugins.complete(job.id,job.lease,{content,outputs:[{kind:'image',assetId:id}]}),/不能发送/u);
  f.db.plugins.complete(job.id,job.lease,{content,outputs:[]});assert.equal(f.db.plugins.jobs(f.bot.id).find(value=>value.id===job.id)?.state,'completed');
});

test('presentation can run without adding enhanced content and a conversation change cancels remaining outputs',async t=>{
  const f=fixture(t,'card',false),job=resolve(f),id=await asset(f,job,'card','presentation');
  assert.equal(f.db.plugins.snapshot(f.bot.id).results.length,0);
  f.db.plugins.complete(job.id,job.lease,{content,outputs:[{kind:'image',assetId:id},{kind:'reply',text:'Later'}]});
  const values=f.db.plugins.snapshot(f.bot.id).results;assert.equal(values.length,1);assert.equal(values[0]?.kind,'image');
  f.db.ingestEvents(f.bot.id,[{seq:1,type:'conversation.started',conversationId:'next-conversation',time:Date.now(),payload:{}}]);
  assert.ok(f.db.plugins.snapshot(f.bot.id).results.every(value=>value.kind!=='enrichment'&&value.delivery?.status==='failed'));
});

test('disabled resource enhancement never leaks through another resource aggregate in the same message',t=>{
  const f=fixture(t),plugin=contentPlugins.find(value=>value.manifest.id===pluginId)!;
  const hidden={...resource,id:'post:hidden',url:'https://example.org/posts/hidden'};
  plugin.match=()=>[hidden,resource];plugin.afterResolve=(_command,source)=>({provideContext:source.id!==hidden.id});
  f.db.plugins.register(f.bot.id,{message_id:'mixed',message:[]});f.db.plugins.sync(f.bot.id,{bindings:[{messageId:'mixed',conversationId:'conversation'}]});
  for(let index=0;index<2;index++) {
    const job=f.db.plugins.claim()!;f.db.plugins.complete(job.id,job.lease,{content:{...content,resourceId:job.resource.id,url:job.resource.url}});
  }
  const results=f.db.plugins.snapshot(f.bot.id).results.filter(value=>value.kind==='enrichment');
  assert.equal(results.length,1);assert.deepEqual(results[0]?.contents?.map(value=>value.resourceId),[resource.id]);
});

test('configuration cancellation revokes prepare upload leases and old attempt mappings cannot finish a replacement lease',async t=>{
  const f=fixture(t),job=resolve(f),id=await asset(f,job);
  const later=f.db.plugins.claim(job.expiresAt+1)!;assert.equal(later.id,job.id);assert.notEqual(later.lease,job.lease);
  assert.throws(()=>f.db.plugins.complete(later.id,later.lease,{content,outputs:[{kind:'image',assetId:id}]}),/不属于/u);
  f.db.plugins.update(f.bot.id,pluginId,{expectedRevision:1,enabled:false});
  assert.throws(()=>f.db.plugins.attachAsset(job.id,later.lease,'unknown','source','image','content'),/取消|失效/u);
});

test('asset-key resolution handles nested content without retaining local keys or accepting missing references',()=>{
  const value={content:{authorAvatar:{assetKey:'avatar'},original:{blocks:[{type:'paragraph',spans:[{assetKey:'emoji'}]}]},live:{preview:{assetKey:'preview'}}},outputs:[{kind:'image',assetKey:'card'}]};
  const result=resolvePluginAssetKeys(value,new Map([['avatar','a'],['emoji','b'],['preview','c'],['card','d']])) as {content:{live:{preview:{assetId:string}}}};
  assert.equal(result.content.live.preview.assetId,'c');assert.doesNotMatch(JSON.stringify(result),/assetKey/u);
  assert.throws(()=>resolvePluginAssetKeys({assetKey:'missing'},new Map()),/REFERENCE/u);
  assert.throws(()=>resolvePluginAssetKeys({assetKey:'a',assetId:'foreign'},new Map([['a','uploaded']])),/REFERENCE/u);
});

test('runner uploads all local image files and substitutes only confirmed asset identifiers before completing',async t=>{
  const root=mkdtempSync(join(tmpdir(),'plugin-multi-upload-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const path=join(root,'image.png');await writeFile(path,png);
  const controller=new AbortController(),uploaded:string[]=[];let completed:PluginRunnerResult|undefined,cleaned=false;
  const job:PluginRunnerJob={id:'synthetic-job',lease:'synthetic-lease',botId:'synthetic-bot',pluginId,operation:'prepare',resource,config:{},networkProxy:{enabled:false,url:'',noProxy:'',forTools:true},content,presentation:{mode:'card',provideContext:true},expiresAt:Date.now()+10000};
  const fetcher:typeof fetch=async(input,init)=>{
    const url=String(input);if(url.endsWith('/claim'))return Response.json({job});
    if(url.endsWith('/asset')) {const headers=new Headers(init?.headers);uploaded.push(headers.get('x-plugin-asset-key')!);assert.equal(headers.get('x-plugin-asset-type'),'image');assert.equal(headers.get('x-plugin-asset-role'),'presentation');for await(const _chunk of init?.body as unknown as AsyncIterable<Uint8Array>){};return Response.json({assetId:'confirmed-image'});}
    if(url.endsWith('/result')){completed=JSON.parse(String(init?.body)).result;controller.abort();return Response.json({accepted:true});}
    throw new Error('Unexpected request');
  };
  await runPluginRunner({url:'http://console.example',token:'synthetic-token',workspace:root,signal:controller.signal,fetch:fetcher,execute:async()=>({content,files:[{key:'card',path,type:'image',role:'presentation'}],outputs:[{kind:'image',assetKey:'card'}],cleanup:async()=>{cleaned=true;}})});
  assert.deepEqual(uploaded,['card']);assert.deepEqual(completed?.outputs,[{kind:'image',assetId:'confirmed-image',assetRole:'presentation'}]);assert.equal(cleaned,true);
});

test('worker asset HTTP access enforces instance ownership and image send uses a persisted base64 snapshot',async t=>{
  registerDefinition(t,'card');const root=mkdtempSync(join(tmpdir(),'plugin-media-http-'));
  const app=await createConsole({dataDir:root,docker:{} as DockerClient,timers:false,staticDir:join(root,'absent'),pluginRunnerToken:'synthetic-runner-token'});
  t.after(async()=>{await app.app.close();rmSync(root,{recursive:true,force:true});});
  const bot=app.db.createBot({name:'Synthetic bot',targetType:'group',targetId:'1001',config:{}});app.db.setDesiredState(bot.id,'running');app.db.plugins.update(bot.id,pluginId,{expectedRevision:0,enabled:true});
  app.db.plugins.register(bot.id,{message_id:'share',message:[{type:'text',data:{text:resource.url}}]});app.db.plugins.sync(bot.id,{bindings:[{messageId:'share',conversationId:'conversation'}]});
  const resolver=app.db.plugins.claim()!;app.db.plugins.complete(resolver.id,resolver.lease,{content});const job=app.db.plugins.claim()!;
  const uploaded=await app.app.inject({method:'POST',url:`/internal/plugin-runner/jobs/${job.id}/asset`,headers:{authorization:'Bearer synthetic-runner-token','content-type':'application/octet-stream','x-plugin-lease':job.lease,'x-plugin-asset-key':'card','x-plugin-asset-type':'image','x-plugin-asset-role':'presentation'},payload:png});
  assert.equal(uploaded.statusCode,200,uploaded.body);const id=uploaded.json().assetId as string;app.db.plugins.complete(job.id,job.lease,{content,outputs:[{kind:'image',assetId:id}]});
  const endpoint=`/internal/workers/${bot.id}/plugins/assets/${id}`,headers={authorization:`Bearer ${bot.workerToken}`};
  assert.equal((await app.app.inject({url:endpoint})).statusCode,401);const fetched=await app.app.inject({url:endpoint,headers});assert.equal(fetched.statusCode,200);assert.equal(fetched.headers['content-type'],'image/png');assert.deepEqual(fetched.rawPayload,png);
  const other=app.db.createBot({name:'Other',targetType:'private',targetId:'2002',config:{}});assert.equal((await app.app.inject({url:`/internal/workers/${other.id}/plugins/assets/${id}`,headers:{authorization:`Bearer ${other.workerToken}`}})).statusCode,404);
  const sends:unknown[]=[];app.gateway.send=async(_id,message)=>{sends.push(message);return {ok:true,messageId:'actual-platform-image'};};
  const result=app.db.plugins.snapshot(bot.id).results.find(value=>value.kind==='image')!;
  const sent=await app.app.inject({method:'POST',url:`/internal/workers/${bot.id}/plugins/${encodeURIComponent(result.id)}/send`,headers,payload:{}});
  assert.equal(sent.statusCode,200,sent.body);assert.equal(sent.json().replyTo,null);assert.equal(sent.json().asset.role,'presentation');
  assert.equal((sends[0] as {kind:string}).kind,'image');assert.equal((sends[0] as {file:string}).file,'base64://'+png.toString('base64'));
  await app.app.inject({method:'POST',url:`/internal/workers/${bot.id}/plugins/${encodeURIComponent(result.id)}/send`,headers,payload:{}});assert.equal(sends.length,1);
});
