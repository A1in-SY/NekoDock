import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {mkdtemp,writeFile,readdir,utimes,mkdir,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Readable,PassThrough} from 'node:stream';
import {DatabaseSync} from 'node:sqlite';
import {ConsoleDatabase} from '../src/console/database.js';
import {BridgeStore} from '../src/store.js';
import {PLUGIN_QUEUE_LIMITS} from '../src/console/plugins.js';
import type {PluginManifest,PluginId} from '../src/plugin-contract.js';
import { PLUGIN_MANIFESTS, contentPlugins as sharePlugins, controlCommand } from '../src/plugin-system/registry.js';
import type {ContentPluginDefinition as SharePluginDefinition} from '../src/plugin-system/contracts.js';
import {bilibiliResources,matchBilibiliCommand,normalizeBilibiliResource} from '../src/plugins/bilibili/recognize.js';
import {executeBilibiliJob,resolveBilibiliUrl,monitorDownloadBudget,parseSubtitle} from '../src/plugins/bilibili/runner.js';
import {runPluginRunner} from '../src/plugin-runner.js';
import {createConsole} from '../src/console/server.js';
import {DockerClient} from '../src/console/docker.js';
import type {PluginContent,PluginRunnerJob} from '../src/plugin-contract.js';

const matchPluginCommand=(event:unknown,enabled:boolean)=>controlCommand(event)??(enabled?matchBilibiliCommand(event):undefined);

const url='https://www.bilibili.com/video/BV1234567890';
const resource={kind:'video' as const,id:'BV1234567890:p1',url,part:1};
const content:PluginContent={type:'video',platform:'bilibili',resourceId:resource.id,url,title:'Synthetic video',author:'Synthetic author',durationSeconds:60,part:1,description:'A synthetic description.',subtitle:{status:'ready',language:'zh',text:'Synthetic subtitle.'},retrieval:{status:'ready'}};
const mp4=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.alloc(24)]);
function message(id:string,text=url){return {post_type:'message',message_type:'group',message_id:id,user_id:'2001',self_id:'9999',group_id:'1001',time:1,message:[{type:'text',data:{text}}]};}
function fixture(t:TestContext){const root=mkdtempSync(join(tmpdir(),'nekodock-plugin-test-')),path=join(root,'console.sqlite3'),key=join(root,'master.key');const db=new ConsoleDatabase(path,key);const bot=db.createBot({name:'Synthetic bot',targetType:'group',targetId:'1001',config:{}});db.setDesiredState(bot.id,'running');t.after(()=>{db.close();rmSync(root,{recursive:true,force:true});});return {root,path,db,bot};}
function enable(f:ReturnType<typeof fixture>,settings:Record<string,unknown>={}){return f.db.plugins.update(f.bot.id,'bilibili',{expectedRevision:0,enabled:true,settings});}
function enqueue(f:ReturnType<typeof fixture>,id:string,text=url){f.db.enqueueNapcatEvent(f.bot.id,message(id,text),'synthetic:'+id);}
function bind(f:ReturnType<typeof fixture>,id:string,conversationId='conversation-one'){f.db.plugins.sync(f.bot.id,{bindings:[{messageId:id,conversationId}],conversationId});}

test('plugin registry recognizes cards, copy text and bare BV identifiers without treating card bodies as commands',()=>{
 for(const data of [JSON.stringify({meta:{detail_1:{desc:'Synthetic title',qqdocurl:url+'?share_source=copy_web'}}}),{meta:{detail_1:{desc:'Synthetic title',qqdocurl:url}}}]) {
   const event={...message('m1'),message:[{type:'json',data:{data}}]};
   const list=bilibiliResources(event);assert.equal(list.length,1);assert.equal(list[0]!.url,url);assert.equal(list[0]!.title,'Synthetic title');assert.equal(matchPluginCommand(event,true),undefined);
 }
 assert.equal(bilibiliResources(message('m2','Copy BV1234567890'))[0]?.id,resource.id);
 assert.equal(normalizeBilibiliResource('https://www.bilibili.com/video/av123?p=2')?.part,2);
 assert.equal(normalizeBilibiliResource('https://bilibili.com.evil.example/video/BV1234567890'),null);
 assert.equal(normalizeBilibiliResource('https://user:password@b23.tv/AbCd'),null);
 assert.equal(matchPluginCommand(message('m3','/new'),false)?.pluginId,'core');
 assert.equal(matchPluginCommand(message('m4','/bili info '+url),false),undefined);
 assert.equal(matchPluginCommand(message('m4','/bili info '+url),true)?.contextPolicy,'chat');
 const huge={meta:{detail_1:{desc:'x'.repeat(1024*1024),qqdocurl:url}}};assert.equal(bilibiliResources({...message('large'),message:[{type:'json',data:{data:huge}}]})[0]?.title?.length,500);
});

test('a bundled platform definition gets independent configuration, jobs and results without host schema changes',t=>{
 const base=sharePlugins[0]!,id='synthetic-platform' as PluginId;const manifest={...base.manifest,id,name:'Synthetic platform',commands:[]} as PluginManifest;
 const definition={...base,manifest,command:()=>undefined} satisfies SharePluginDefinition;
 (PLUGIN_MANIFESTS as PluginManifest[]).push(manifest);(sharePlugins as SharePluginDefinition[]).push(definition);
 t.after(()=>{(PLUGIN_MANIFESTS as PluginManifest[]).pop();(sharePlugins as SharePluginDefinition[]).pop();});
 const f=fixture(t);f.db.plugins.update(f.bot.id,id,{expectedRevision:0,enabled:true});assert.equal(f.db.plugins.view(f.bot.id,'bilibili').enabled,false);
 enqueue(f,'m1');bind(f,'m1');const job=f.db.plugins.claim()!;assert.equal(job.pluginId,id);f.db.plugins.complete(job.id,job.lease,{content});
 const result=f.db.plugins.snapshot(f.bot.id).results[0]!;assert.equal(result.pluginId,id);assert.equal(result.content?.title,content.title);
 const db=new DatabaseSync(f.path,{readOnly:true});assert.equal(db.prepare('SELECT plugin_id FROM plugin_jobs').get()?.plugin_id,id);db.close();
});

test('plugin record lists filter by plugin and instance before applying their recent-record limit',t=>{
 const base=sharePlugins[0]!,id='synthetic-platform' as PluginId;
 const manifest={...base.manifest,id,name:'Synthetic platform',commands:[]} as PluginManifest;
 (PLUGIN_MANIFESTS as PluginManifest[]).push(manifest);(sharePlugins as SharePluginDefinition[]).push({...base,manifest,command:()=>undefined});
 t.after(()=>{(PLUGIN_MANIFESTS as PluginManifest[]).pop();(sharePlugins as SharePluginDefinition[]).pop();});
 const f=fixture(t);f.db.plugins.update(f.bot.id,id,{expectedRevision:0,enabled:true});enqueue(f,'older-share');
 const other=f.db.createBot({name:'Other instance',targetType:'group',targetId:'1002',connectionId:f.bot.connectionId,config:{}});
 const inspector=new DatabaseSync(f.path);
 inspector.prepare(`WITH RECURSIVE numbers(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM numbers WHERE n<75)
 INSERT INTO plugin_jobs(id,bot_id,plugin_id,source_message_id,operation,resource_key,resource_cipher,config_revision,command_kind,automatic,state,created_at,expires_at)
 SELECT 'newer-bili-'||n,bot_id,'bilibili','newer-source-'||n,operation,resource_key,resource_cipher,config_revision,command_kind,automatic,state,created_at+n,expires_at
 FROM plugin_jobs,numbers WHERE source_message_id='older-share'`).run();
 inspector.prepare(`INSERT INTO plugin_jobs(id,bot_id,plugin_id,source_message_id,operation,resource_key,resource_cipher,config_revision,command_kind,automatic,state,created_at,expires_at)
 SELECT 'other-instance',?,'bilibili','other-source',operation,resource_key,resource_cipher,config_revision,command_kind,automatic,state,created_at+1000,expires_at
 FROM plugin_jobs WHERE source_message_id='older-share'`).run(other.id);inspector.close();
 assert.deepEqual(f.db.plugins.view(f.bot.id,'core').jobs,[]);
 assert.equal(f.db.plugins.view(f.bot.id,id).jobs.length,1);
 assert.equal(f.db.plugins.view(f.bot.id,id).jobs[0]?.sourceMessageId,'older-share');
 const records=f.db.plugins.view(f.bot.id,'bilibili').jobs;
 assert.equal(records.length,50);assert.equal(records[0]?.sourceMessageId,'newer-source-75');
 assert.ok(records.every(record=>record.pluginId==='bilibili'&&record.sourceMessageId!=='other-source'));
 assert.equal(f.db.plugins.jobs(f.bot.id,100).length,76);
 assert.equal(f.db.plugins.jobs(other.id,100).length,1);
});

test('plugin records distinguish resource identity, processing completion and actual video delivery',async t=>{
 const f=fixture(t);enable(f,{autoVideo:true,cookie:'SESSDATA=synthetic-private-cookie'});
 const now=Date.now(),source={...message('card-source'),message:[{type:'json',data:{data:{meta:{detail_1:{desc:'Card title',qqdocurl:url+'?share_source=copy&token=synthetic-private-query'}}}}}]};
 f.db.plugins.register(f.bot.id,source,now-5000);bind(f,'card-source');
 let records=f.db.plugins.view(f.bot.id,'bilibili').jobs;
 assert.equal(records[0]?.resource?.title,'Card title');assert.equal(records[0]?.resource?.url,url);assert.equal(records[0]?.automatic,true);
 assert.equal(records[0]?.conversationId,'conversation-one');assert.equal(records[0]?.attempts,0);assert.equal(records[0]?.finishedAt,undefined);
 const resolve=f.db.plugins.claim(now-4000)!;f.db.plugins.complete(resolve.id,resolve.lease,{content},now-3000);
 records=f.db.plugins.view(f.bot.id,'bilibili').jobs;
 const parsed=records.find(record=>record.id===resolve.id)!;
 assert.deepEqual(parsed.resource,{id:resource.id,url,title:content.title,author:content.author,part:1});
 assert.equal(parsed.finishedAt,now-3000);assert.equal(parsed.durationMs,2000);assert.equal(parsed.attempts,1);assert.deepEqual(parsed.deliveries,[]);
 const download=f.db.plugins.claim(now-2000)!;assert.equal(download.operation,'download');
 const asset=await f.db.pluginAssets.upload(join(f.root,'assets'),f.bot.id,Readable.from([mp4]),{maxBytes:1024,cacheMaxBytes:1024,cacheHours:1});
 f.db.plugins.attachAsset(download.id,download.lease,asset);f.db.plugins.complete(download.id,download.lease,{assetId:asset},now-1000);
 const video=f.db.plugins.snapshot(f.bot.id).results.find(result=>result.kind==='video')!;
 let downloaded=f.db.plugins.jobs(f.bot.id).find(record=>record.id===download.id)!;
 assert.equal(downloaded.state,'completed');assert.equal(downloaded.finishedAt,now-1000);assert.equal(downloaded.durationMs,2000);
 assert.deepEqual(downloaded.deliveries,[{kind:'video',status:'pending'}]);
 f.db.beginNapcatDelivery(f.bot.id,video.deliveryId!,'a'.repeat(64));
 assert.deepEqual(f.db.plugins.jobs(f.bot.id).find(record=>record.id===download.id)!.deliveries,[{kind:'video',status:'sending'}]);
 f.db.finishNapcatDelivery(f.bot.id,video.deliveryId!,'unconfirmed',{ok:false,code:'NAPCAT_RESPONSE_TIMEOUT',deliveryStatus:'unconfirmed'});
 downloaded=f.db.plugins.jobs(f.bot.id).find(record=>record.id===download.id)!;
 assert.deepEqual(downloaded.deliveries,[{kind:'video',status:'unconfirmed',code:'NAPCAT_RESPONSE_TIMEOUT'}]);
 assert.deepEqual(f.db.plugins.jobs(f.bot.id).find(record=>record.id===resolve.id)!.deliveries,[]);
 const serialized=JSON.stringify(f.db.plugins.list(f.bot.id));
 for(const privateValue of ['synthetic-private-cookie','synthetic-private-query',download.lease,'resource_cipher','payload_cipher','signature='])assert.ok(!serialized.includes(privateValue));
});

test('plugin record failures retain their own reply receipt without borrowing another resource result',t=>{
 const f=fixture(t);enable(f);const now=Date.now();f.db.plugins.register(f.bot.id,message('failed-source','/bili info '+url),now-1000);bind(f,'failed-source');
 const failed=f.db.plugins.claim(now-900)!;f.db.plugins.complete(failed.id,failed.lease,{error:'BILIBILI_HTTP_412'},now-800);
 let record=f.db.plugins.jobs(f.bot.id)[0]!;
 assert.equal(record.state,'failed');assert.equal(record.error,'BILIBILI_HTTP_412');assert.equal(record.automatic,false);assert.equal(record.command,'info');assert.equal(record.durationMs,200);
 assert.deepEqual(record.deliveries,[{kind:'reply',status:'pending'}]);
 const reply=f.db.plugins.snapshot(f.bot.id).results.find(result=>result.kind==='reply')!;
 f.db.plugins.finishSend(f.bot.id,reply.id,{ok:true,messageId:'actual-reply-id'});
 assert.deepEqual(f.db.plugins.jobs(f.bot.id)[0]!.deliveries,[{kind:'reply',status:'acknowledged',messageId:'actual-reply-id'}]);
 const secondUrl='https://www.bilibili.com/video/BVabcdefghij';
 f.db.plugins.register(f.bot.id,message('shared-source',url+' '+secondUrl),now);bind(f,'shared-source');
 const first=f.db.plugins.claim(now+1)!;f.db.plugins.complete(first.id,first.lease,{content:{...content,url:first.resource.url,resourceId:first.resource.id}},now+2);
 const secondRecord=f.db.plugins.jobs(f.bot.id).find(value=>value.sourceMessageId==='shared-source'&&value.id!==first.id)!;
 assert.equal(secondRecord.resource?.url,first.resource.url===url?secondUrl:url);assert.equal(secondRecord.resource?.title,undefined);assert.equal(secondRecord.finishedAt,undefined);assert.deepEqual(secondRecord.deliveries,[]);
});

test('plugin records retain an interrupted delivery as unconfirmed without a stored receipt',t=>{
 const f=fixture(t);enable(f);enqueue(f,'interrupted-source','/bili info '+url);bind(f,'interrupted-source');
 const job=f.db.plugins.claim()!;f.db.plugins.complete(job.id,job.lease,{content});
 const reply=f.db.plugins.snapshot(f.bot.id).results.find(result=>result.kind==='reply')!;
 f.db.beginNapcatDelivery(f.bot.id,reply.deliveryId!,'a'.repeat(64));
 assert.deepEqual(f.db.plugins.jobs(f.bot.id)[0]!.deliveries,[{kind:'reply',status:'sending'}]);
 assert.equal(f.db.recoverNapcatDeliveries(),1);
 assert.equal(f.db.getNapcatDelivery(f.bot.id,reply.deliveryId!)!.result,undefined);
 assert.deepEqual(f.db.plugins.view(f.bot.id,'bilibili').jobs[0]!.deliveries,[{kind:'reply',status:'unconfirmed'}]);
 assert.equal(f.db.plugins.getResult(f.bot.id,reply.id)!.delivery,undefined);
 assert.equal(f.db.getNapcatDelivery(f.bot.id,reply.deliveryId!)!.state,'unconfirmed');
});

test('pending plugin queues stay bounded and an explicit command gets a durable capacity reply',t=>{
 const f=fixture(t);enable(f);enqueue(f,'seed');
 const db=new DatabaseSync(f.path);db.prepare(`WITH RECURSIVE numbers(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM numbers WHERE n<?)
 INSERT INTO plugin_jobs(id,bot_id,plugin_id,source_message_id,operation,resource_key,resource_cipher,config_revision,command_kind,automatic,state,created_at,expires_at)
 SELECT 'quota-'||n,bot_id,plugin_id,'quota-source-'||n,operation,resource_key,resource_cipher,config_revision,command_kind,automatic,state,created_at,expires_at FROM plugin_jobs,numbers WHERE plugin_jobs.source_message_id='seed'`).run(PLUGIN_QUEUE_LIMITS.jobs-1);db.close();
 enqueue(f,'automatic-overflow');assert.equal(f.db.plugins.jobs(f.bot.id,100).length,100);
 enqueue(f,'command-overflow','/bili info '+url);bind(f,'command-overflow');
 assert.match(f.db.plugins.snapshot(f.bot.id).results.find(r=>r.sourceMessageId==='command-overflow')?.text??'',/队列已满/u);
 const inspector=new DatabaseSync(f.path,{readOnly:true});assert.equal(inspector.prepare('SELECT COUNT(*) AS count FROM plugin_jobs').get()?.count,PLUGIN_QUEUE_LIMITS.jobs);inspector.close();
});

test('core cannot be disabled; per-instance plugin credentials are encrypted and do not change Worker revision',t=>{
 const f=fixture(t);assert.equal(f.db.plugins.view(f.bot.id,'core').enabled,true);assert.throws(()=>f.db.plugins.update(f.bot.id,'core',{enabled:false}),/不可关闭/u);
 const updated=enable(f,{cookie:'SESSDATA=synthetic-private-cookie'});assert.equal(updated.cookieConfigured,true);assert.equal('cookie' in updated.settings,false);assert.equal(f.db.getBot(f.bot.id)!.desiredRevision,1);
 const inspector=new DatabaseSync(f.path,{readOnly:true});const stored=JSON.stringify(inspector.prepare('SELECT * FROM plugin_configs').all());inspector.close();assert.ok(!stored.includes('synthetic-private-cookie'));
 assert.throws(()=>f.db.plugins.update(f.bot.id,'bilibili',{expectedRevision:0,enabled:true}),/版本冲突/u);
 assert.throws(()=>f.db.plugins.update(f.bot.id,'bilibili',{expectedRevision:1,settings:{maxMiB:NaN}}),/超出/u);
 const other=f.db.createBot({name:'Another bot',targetType:'group',targetId:'1002',connectionId:f.bot.connectionId,config:{}});assert.equal(f.db.plugins.view(other.id,'bilibili').enabled,false);
});

test('incoming registration is durable and idempotent, resolving before Worker binding cannot publish or send chat results',t=>{
 const f=fixture(t);enable(f);enqueue(f,'m1');enqueue(f,'m1');assert.equal(f.db.plugins.jobs(f.bot.id).length,1);
 const job=f.db.plugins.claim()!;assert.equal(job.operation,'resolve');assert.equal(f.db.plugins.complete(job.id,job.lease,{content}).accepted,true);
 assert.equal(f.db.plugins.snapshot(f.bot.id).results.length,0);assert.deepEqual(f.db.plugins.snapshot(f.bot.id).pendingBindings,['m1']);
 bind(f,'m1');const snapshot=f.db.plugins.snapshot(f.bot.id);assert.equal(snapshot.results[0]?.content?.title,content.title);assert.equal(snapshot.results[0]?.conversationId,'conversation-one');
 f.db.plugins.sync(f.bot.id,{acknowledgements:[snapshot.results[0]!.id]});assert.equal(f.db.plugins.snapshot(f.bot.id).results.length,0);
});

test('multiple resources in one share have independent jobs and monotonic aggregate enrichment versions',t=>{
 const f=fixture(t);enable(f);enqueue(f,'m1',url+' https://www.bilibili.com/video/BV0987654321');bind(f,'m1');assert.equal(f.db.plugins.jobs(f.bot.id).length,2);
 const first=f.db.plugins.claim()!;f.db.plugins.complete(first.id,first.lease,{content:{...content,resourceId:first.resource.id,url:first.resource.url}});
 const second=f.db.plugins.claim()!;assert.notEqual(first.resource.id,second.resource.id);f.db.plugins.complete(second.id,second.lease,{content:{...content,title:'Second synthetic video',resourceId:second.resource.id,url:second.resource.url}});
 const results=f.db.plugins.snapshot(f.bot.id).results.filter(r=>r.kind==='enrichment').sort((a,b)=>a.revision-b.revision);assert.deepEqual(results.map(r=>r.revision),[1,2]);assert.equal(results[1]!.contents?.length,2);
 enqueue(f,'m1',url+' '+second.resource.url);assert.equal(f.db.plugins.jobs(f.bot.id).length,2);
});

test('plugin content commands own execution but remain chat, and referenced share commands resolve stored resource',t=>{
 const f=fixture(t);enable(f);enqueue(f,'share');bind(f,'share');const job=f.db.plugins.claim()!;f.db.plugins.complete(job.id,job.lease,{content});
 const event={...message('request','/bili info'),message:[{type:'reply',data:{id:'share'}},{type:'text',data:{text:'/bili info'}}]};
 f.db.enqueueNapcatEvent(f.bot.id,event,'synthetic:request');const queued=f.db.pendingNapcatEvents(f.bot.id).find(e=>(e.event as any).message_id==='request');assert.equal(queued?.dispatch?.pluginId,'bilibili');assert.equal(queued?.dispatch?.contextPolicy,'chat');
 bind(f,'request');const info=f.db.plugins.claim()!;assert.equal(info.resource.url,url);f.db.plugins.complete(info.id,info.lease,{content});
 const reply=f.db.plugins.snapshot(f.bot.id).results.find(r=>r.kind==='reply')!;assert.match(reply.text!,/Synthetic video/u);assert.equal(reply.replyTo,'request');assert.throws(()=>f.db.plugins.sync(f.bot.id,{acknowledgements:[reply.id]}),/尚未完成/u);
});

test('explicit commands can resolve a quoted share saved before the optional plugin was enabled',t=>{
 const f=fixture(t);const card={meta:{detail_1:{desc:'Synthetic historical title',qqdocurl:url}}};
 f.db.ingestEvents(f.bot.id,[{seq:1,type:'message.received',conversationId:'conversation-one',time:Date.now(),payload:{messageId:'old-share',text:'[JSON '+JSON.stringify(card)+']'}}]);
 enable(f);
 const event={...message('request','/bili info'),message:[{type:'reply',data:{id:'old-share'}},{type:'text',data:{text:'/bili info'}}]};f.db.enqueueNapcatEvent(f.bot.id,event,'synthetic:request');
 assert.equal(f.db.plugins.claim()?.resource.url,url);
});

test('historical incoming pages merge the latest content revision across page and new-conversation boundaries',t=>{
 const f=fixture(t);const ev=(seq:number,type:string,payload:Record<string,unknown>,conversationId='first')=>({seq,type,payload,conversationId,time:Date.now()});
 f.db.ingestEvents(f.bot.id,[ev(1,'conversation.started',{}),ev(2,'message.received',{messageId:'share',text:'[JSON card]'}),ev(3,'message.received',{messageId:'other',text:'other'}),ev(4,'message.content.updated',{messageId:'share',text:'[哔哩哔哩视频分享]',contents:[content]})]);
 const first=f.db.getConversation(f.bot.id,3,1)!.items[0]!;assert.deepEqual(first.payload.contents,[content]);assert.equal(first.payload.contentUpdatedSeq,4);assert.equal(first.payload.text,'[哔哩哔哩视频分享]');
 f.db.ingestEvents(f.bot.id,[ev(5,'conversation.started',{},'second'),ev(6,'conversation.messages_moved',{messageIds:['share']},'second')]);
 assert.deepEqual(f.db.getConversation(f.bot.id,3,1)!.items[0]!.payload.contents,[content]);
});

test('a durable conversation boundary cancels truly old running work and unsent results',t=>{
 const f=fixture(t);enable(f);enqueue(f,'old-reply','/bili info '+url);bind(f,'old-reply');
 const completed=f.db.plugins.claim()!;f.db.plugins.complete(completed.id,completed.lease,{content});
 const reply=f.db.plugins.snapshot(f.bot.id).results.find(value=>value.kind==='reply')!;
 enqueue(f,'old-running');bind(f,'old-running');const running=f.db.plugins.claim()!;
 // The boundary remains compatible with the payload emitted by existing Workers.
 f.db.ingestEvents(f.bot.id,[{seq:1,type:'conversation.started',conversationId:'new-conversation',time:Date.now(),payload:{legacy:false}}]);
 assert.equal(f.db.plugins.jobs(f.bot.id).find(value=>value.id===running.id)!.state,'cancelled');
 assert.deepEqual(f.db.plugins.complete(running.id,running.lease,{content}),{accepted:false});
 assert.equal(f.db.plugins.getResult(f.bot.id,reply.id)!.delivery?.code,'PLUGIN_CONVERSATION_CHANGED');
});

for(const movingState of ['queued','running','reply'] as const) test(`/new preserves ${movingState} plugin work across paged migration and out-of-order sync`,t=>{
 const f=fixture(t);enable(f);
 const store=new BridgeStore(join(f.root,'worker.sqlite3'),{type:'group',id:'1001'});t.after(()=>store.close());
 const incoming=(id:string,text=url)=>({messageId:id,senderId:'2001',senderName:'Synthetic sender',time:1700000000,text,replyTo:null,trigger:true,rawJson:'{}'});
 const receive=(id:string,text=url)=>{enqueue(f,id,text);store.insert(incoming(id,text));};
 const flush=()=>{const events=store.recorder.pending(1000);f.db.ingestEvents(f.bot.id,events);store.recorder.acknowledge(events.at(-1)!.seq);};
 receive('old-reply','/bili info '+url);flush();
 const oldReplyJob=f.db.plugins.claim()!;f.db.plugins.complete(oldReplyJob.id,oldReplyJob.lease,{content});
 const oldReply=f.db.plugins.snapshot(f.bot.id).results.find(value=>value.kind==='reply')!;
 const previous=store.recorder.conversationId;
 store.insert(incoming('old-task'));flush();
 store.insert({...incoming('new-command','/new'),command:'new'});
 receive('moving','/bili info '+url);
 // Force more than one ownership event, including a source in the second chunk.
 for(let i=0;i<500;i++)store.insert(incoming('filler-'+i,'Synthetic queued message'));
 receive('moving-last');flush();
 assert.equal(store.getMessageConversation('moving'),null);
 assert.equal(f.db.plugins.jobs(f.bot.id).find(value=>value.sourceMessageId==='moving')!.conversationId,previous);
 let movingLease:PluginRunnerJob|undefined,movingReply:string|undefined;
 if(movingState!=='queued') {
   movingLease=f.db.plugins.claim()!;assert.equal(movingLease.id,f.db.plugins.jobs(f.bot.id).find(value=>value.sourceMessageId==='moving')!.id);
   if(movingState==='reply') {f.db.plugins.complete(movingLease.id,movingLease.lease,{content});movingReply=f.db.plugins.snapshot(f.bot.id).results.find(value=>value.kind==='reply'&&value.sourceMessageId==='moving')!.id;}
 }
 // This source predates /new even though its job is registered later.
 enqueue(f,'old-task');bind(f,'old-task',previous);
 const oldTask=f.db.plugins.jobs(f.bot.id).find(value=>value.sourceMessageId==='old-task')!;
 store.resetSessionForCommand(store.getPendingCommand()!.id);
 const current=store.recorder.conversationId,events=store.recorder.pending(1000);
 assert.deepEqual(events.map(event=>event.type),['conversation.messages_moved','conversation.messages_moved','conversation.started']);
 const sync=()=>f.db.plugins.sync(f.bot.id,{conversationId:current});
 sync();assert.equal(f.db.plugins.getResult(f.bot.id,oldReply.id)!.delivery,undefined);
 assert.throws(()=>f.db.plugins.sync(f.bot.id,{bindings:[{messageId:'moving',conversationId:current}],conversationId:current}),/所属会话/u);
 let cursor=f.db.getConversationCursor(f.bot.id);
 for(const event of events) {
   f.db.ingestEvents(f.bot.id,[event]);sync();
   f.db.plugins.sync(f.bot.id,{bindings:[{messageId:'moving',conversationId:current}],conversationId:current});
   f.db.plugins.sync(f.bot.id,{conversationId:previous});
   const update=f.db.getConversationUpdate(f.bot.id,cursor);assert.equal(update.reset,true);
   assert.equal(update.view!.id,event.type==='conversation.started'?current:previous);cursor=update.cursor;
   if(event.type!=='conversation.started')assert.notEqual(f.db.plugins.jobs(f.bot.id).find(value=>value.id===oldTask.id)!.state,'cancelled');
 }
 const moving=f.db.plugins.jobs(f.bot.id).find(value=>value.sourceMessageId==='moving')!;
 assert.equal(moving.conversationId,current);assert.equal(moving.state,movingState==='reply'?'completed':movingState);assert.equal(moving.error,undefined);
 assert.equal(f.db.plugins.jobs(f.bot.id).find(value=>value.sourceMessageId==='moving-last')!.state,'queued');
 assert.equal(f.db.plugins.jobs(f.bot.id).find(value=>value.id===oldTask.id)!.state,'cancelled');
 assert.equal(f.db.plugins.getResult(f.bot.id,oldReply.id)!.delivery?.code,'PLUGIN_CONVERSATION_CHANGED');
 if(movingState==='running')f.db.plugins.complete(movingLease!.id,movingLease!.lease,{content});
 if(movingReply) {const result=f.db.plugins.authorizeSend(f.bot.id,movingReply);assert.equal(result.conversationId,current);assert.equal(result.delivery,undefined);}
 if(movingState==='queued')assert.equal(f.db.plugins.claim()!.id,moving.id);
 assert.equal(f.db.getConversation(f.bot.id)!.id,current);
 assert.ok(f.db.getConversation(f.bot.id)!.items.some(value=>value.payload.messageId==='moving-last'));
});

test('automatic downloads require an eligible duration and explicit setting, and new or disabled plugins cancel unsent outputs',async t=>{
 const f=fixture(t);enable(f,{autoVideo:true});enqueue(f,'m1');bind(f,'m1');const first=f.db.plugins.claim()!;f.db.plugins.complete(first.id,first.lease,{content});
 const download=f.db.plugins.claim()!;assert.equal(download.operation,'download');const assetId=await f.db.pluginAssets.upload(join(f.root,'assets'),f.bot.id,Readable.from([mp4]),{maxBytes:1024,cacheMaxBytes:1024,cacheHours:1});f.db.plugins.attachAsset(download.id,download.lease,assetId);f.db.plugins.complete(download.id,download.lease,{assetId});
 const video=f.db.plugins.snapshot(f.bot.id).results.find(r=>r.kind==='video')!;assert.equal(video.automatic,true);assert.equal(video.replyTo,null);assert.equal(video.sourceMessageId,'m1');
 f.db.ingestEvents(f.bot.id,[{seq:1,type:'conversation.started',conversationId:'conversation-two',time:Date.now(),payload:{}}]);assert.equal(f.db.plugins.getResult(f.bot.id,video.id)?.delivery?.code,'PLUGIN_CONVERSATION_CHANGED');
 f.db.plugins.update(f.bot.id,'bilibili',{expectedRevision:1,enabled:false});assert.ok(f.db.plugins.snapshot(f.bot.id).results.every(r=>r.kind==='enrichment'||r.delivery!==undefined));
});

test('first video send persists its actual quote while existing delivery intents retain their history',async t=>{
 const f=fixture(t);enable(f,{autoVideo:true});
 for(const state of ['new','started','acknowledged'] as const) {
   const messageId='source-'+state;enqueue(f,messageId);bind(f,messageId);const resolve=f.db.plugins.claim()!;f.db.plugins.complete(resolve.id,resolve.lease,{content});
   const download=f.db.plugins.claim()!;
   const assetId=await f.db.pluginAssets.upload(join(f.root,'assets'),f.bot.id,Readable.from([mp4]),{maxBytes:1024,cacheMaxBytes:1024,cacheHours:1});
   f.db.plugins.attachAsset(download.id,download.lease,assetId);f.db.plugins.complete(download.id,download.lease,{assetId});
   const video=f.db.plugins.snapshot(f.bot.id).results.find(r=>r.kind==='video'&&r.sourceMessageId===messageId)!;
   const raw=new DatabaseSync(f.path);
   const encrypted=(f.db as unknown as {encrypt(value:unknown):string}).encrypt({...video,replyTo:messageId});
   raw.prepare('UPDATE plugin_results SET payload_cipher=? WHERE bot_id=? AND id=?').run(encrypted,f.bot.id,video.id);raw.close();
   if(state!=='new')f.db.beginNapcatDelivery(f.bot.id,video.deliveryId!,'a'.repeat(64));
   if(state==='acknowledged'){f.db.finishNapcatDelivery(f.bot.id,video.deliveryId!,'acknowledged',{ok:true,messageId:'historical-video'});f.db.plugins.finishSend(f.bot.id,video.id,{ok:true,messageId:'historical-video'});}
   const authorized=f.db.plugins.authorizeSend(f.bot.id,video.id);
   assert.equal(authorized.replyTo,state==='new'?null:messageId);
   assert.equal(f.db.plugins.getResult(f.bot.id,video.id)!.replyTo,state==='new'?null:messageId);
   assert.equal(authorized.sourceMessageId,messageId);
   if(state==='new'){f.db.plugins.finishSend(f.bot.id,video.id,{ok:true,messageId:'standalone-video'});assert.equal(f.db.plugins.snapshot(f.bot.id).results.find(r=>r.id===video.id)!.replyTo,null);}
 }
});

test('disabling a plugin does not hide acknowledged chat facts after a lost Worker response',t=>{
 const f=fixture(t);enable(f);enqueue(f,'m1','/bili info '+url);bind(f,'m1');const job=f.db.plugins.claim()!;f.db.plugins.complete(job.id,job.lease,{content});
 const reply=f.db.plugins.snapshot(f.bot.id).results.find(r=>r.kind==='reply')!;
 f.db.beginNapcatDelivery(f.bot.id,reply.deliveryId!,'b'.repeat(64));f.db.finishNapcatDelivery(f.bot.id,reply.deliveryId!,'acknowledged',{ok:true,messageId:'actual-qq-id'});
 // Host reply persistence and Worker response can both be interrupted after the gateway ACK.
 f.db.plugins.update(f.bot.id,'bilibili',{expectedRevision:1,enabled:false});
 const recovered=f.db.plugins.snapshot(f.bot.id).results.find(r=>r.id===reply.id)!;assert.equal(recovered.delivery?.status,'acknowledged');assert.equal(recovered.delivery?.messageId,'actual-qq-id');
 assert.equal(f.db.plugins.snapshot(f.bot.id).results.filter(r=>r.kind==='enrichment').length,1);
 f.db.plugins.sync(f.bot.id,{acknowledgements:[reply.id]});assert.ok(!f.db.plugins.snapshot(f.bot.id).results.some(r=>r.id===reply.id));
 assert.equal(f.db.plugins.claim(),null);
});

test('412 becomes partial content and a truthful command reply without retrying permanent errors',t=>{
 const f=fixture(t);enable(f);enqueue(f,'m1','/bili info '+url);bind(f,'m1');const job=f.db.plugins.claim()!;
 f.db.plugins.complete(job.id,job.lease,{error:'BILIBILI_HTTP_412'});const result=f.db.plugins.snapshot(f.bot.id).results;assert.equal(result.find(r=>r.kind==='enrichment')?.content?.retrieval.error,'BILIBILI_HTTP_412');assert.match(result.find(r=>r.kind==='reply')?.text??'',/412/u);assert.equal(f.db.plugins.claim(),null);
});

test('expired outputs become terminal before ACK, while cancellation cannot rewrite an in-flight send',t=>{
 const f=fixture(t);enable(f);enqueue(f,'m1','/bili info '+url);bind(f,'m1');const first=f.db.plugins.claim()!;f.db.plugins.complete(first.id,first.lease,{content});const reply=f.db.plugins.snapshot(f.bot.id).results.find(r=>r.kind==='reply')!;
 f.db.beginNapcatDelivery(f.bot.id,reply.deliveryId!,'a'.repeat(64));assert.equal(f.db.plugins.cancel(f.bot.id,reply.id,'PLUGIN_SEND_EXPIRED').cancelled,false);assert.equal(f.db.plugins.getResult(f.bot.id,reply.id)?.delivery,undefined);
 f.db.finishNapcatDelivery(f.bot.id,reply.deliveryId!,'acknowledged',{ok:true,messageId:'actual-qq-id'});f.db.plugins.cancel(f.bot.id,reply.id,'PLUGIN_SEND_EXPIRED');assert.equal(f.db.plugins.getResult(f.bot.id,reply.id)?.delivery?.status,'acknowledged');
 enqueue(f,'m2','/bili info '+url);bind(f,'m2');const job=f.db.plugins.claim()!;f.db.plugins.complete(job.id,job.lease,{content},Date.now()-700000);
 const expired=f.db.plugins.snapshot(f.bot.id).results.find(r=>r.sourceMessageId==='m2'&&r.kind==='reply')!;assert.equal(expired.delivery?.code,'PLUGIN_SEND_EXPIRED');f.db.plugins.sync(f.bot.id,{acknowledgements:[expired.id]});
});

test('interrupted runner work is bounded, leases reject late results and media origins do not change Worker config',t=>{
 const f=fixture(t);enable(f);enqueue(f,'m1');let now=Date.now();const one=f.db.plugins.claim(now)!;
 const two=f.db.plugins.claim(one.expiresAt+1)!;assert.notEqual(one.lease,two.lease);assert.equal(f.db.plugins.complete(one.id,one.lease,{content}).accepted,false);
 const three=f.db.plugins.claim(two.expiresAt+1)!;assert.ok(three);f.db.plugins.claim(three.expiresAt+1);assert.equal(f.db.plugins.jobs(f.bot.id)[0]?.state,'failed');
 const c=f.db.updateNapcatConnection(f.bot.connectionId,{mediaBaseUrl:'http://console.example:4180'});assert.equal(c.mediaBaseUrl,'http://console.example:4180');assert.equal(f.db.getBot(f.bot.id)!.desiredRevision,1);
 assert.throws(()=>f.db.updateNapcatConnection(c.id,{mediaBaseUrl:'http://user:pass@console.example/'}),/回源/u);
});

test('plugin assets enforce scope, signatures, ranges, MP4 format and capacity',async t=>{
 const f=fixture(t);const root=join(f.root,'assets');const asset=await f.db.pluginAssets.upload(root,f.bot.id,Readable.from([mp4]),{maxBytes:1024,cacheMaxBytes:1024,cacheHours:1});
 const signed=f.db.pluginAssets.signedUrl(f.bot.id,asset,'http://console.example');const u=new URL(signed);assert.equal(f.db.pluginAssets.verifiesUrl(f.bot.id,signed,'http://console.example'),true);
 assert.equal(f.db.pluginAssets.verify('other',asset,u.searchParams.get('expires'),u.searchParams.get('signature')),false);
 const range=await f.db.pluginAssets.read(f.bot.id,asset,'bytes=4-7');assert.equal(range.partial,true);const chunks=[];for await(const part of range.stream())chunks.push(part);assert.equal(Buffer.concat(chunks).toString(),'ftyp');
 await assert.rejects(f.db.pluginAssets.read(f.bot.id,asset,'bytes=999-1000'),/范围/u);
 await assert.rejects(f.db.pluginAssets.upload(root,f.bot.id,Readable.from([Buffer.from('not a video')]),{maxBytes:1024,cacheMaxBytes:1024,cacheHours:1}),/MP4/u);
 await assert.rejects(f.db.pluginAssets.upload(root,f.bot.id,Readable.from([mp4]),{maxBytes:8,cacheMaxBytes:1024,cacheHours:1}),/限额/u);
});

test('concurrent uploads preserve per-instance capacity and identical content has one durable asset',async t=>{
 const f=fixture(t),root=join(f.root,'assets');const first=new PassThrough(),second=new PassThrough();
 const a=Buffer.concat([mp4,Buffer.alloc(24,1)]),b=Buffer.concat([mp4,Buffer.alloc(24,2)]);assert.equal(a.length,60);
 const options={maxBytes:100,cacheMaxBytes:100,cacheHours:1};
 const pending=[f.db.pluginAssets.upload(root,f.bot.id,first,options),f.db.pluginAssets.upload(root,f.bot.id,second,options)];
 first.end(a);second.end(b);const results=await Promise.allSettled(pending);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);
 const db=new DatabaseSync(f.path,{readOnly:true});assert.equal(db.prepare('SELECT SUM(size) AS size FROM plugin_media_assets').get()?.size,60);db.close();
 const duplicates=await Promise.all([f.db.pluginAssets.upload(root,f.bot.id,Readable.from([a]),options),f.db.pluginAssets.upload(root,f.bot.id,Readable.from([a]),options)]);assert.equal(duplicates[0],duplicates[1]);assert.equal((await readdir(join(root,f.bot.id))).filter(name=>name.endsWith('.mp4')).length,1);
});

test('asset recovery removes old unindexed files and temporary uploads without deleting fresh or indexed content',async t=>{
 const f=fixture(t),root=join(f.root,'assets'),directory=join(root,f.bot.id);await mkdir(directory,{recursive:true});
 const indexed=await f.db.pluginAssets.upload(root,f.bot.id,Readable.from([mp4]),{maxBytes:100,cacheMaxBytes:100,cacheHours:1});
 const oldTemp=join(directory,'.upload-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),oldOrphan=join(directory,'b'.repeat(64)+'.mp4'),fresh=join(directory,'.upload-11111111-2222-3333-4444-555555555555');
 for(const path of [oldTemp,oldOrphan,fresh])await writeFile(path,mp4);
 const old=new Date(Date.now()-7200_000);await utimes(oldTemp,old,old);await utimes(oldOrphan,old,old);
 await f.db.pluginAssets.cleanup(root);await assert.rejects(stat(oldTemp),/ENOENT/u);await assert.rejects(stat(oldOrphan),/ENOENT/u);assert.ok((await stat(fresh)).isFile());assert.ok(f.db.pluginAssets.info(f.bot.id,indexed));
});

test('Bilibili executor uses locked argument arrays, strips child credentials and obtains bounded subtitle content',async t=>{
 const root=await mkdtemp(join(tmpdir(),'nekodock-bili-runner-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const job:PluginRunnerJob={id:'job',lease:'lease',botId:'bot',pluginId:'bilibili',operation:'resolve',resource,config:{enhance:true,subtitles:true,autoVideo:false,maxDurationSeconds:300,maxMiB:50,maxHeight:720,timeoutSeconds:120,waitSeconds:2,cacheHours:24,cacheMaxMiB:1024,cookie:'SESSDATA=synthetic-cookie'},networkProxy:{enabled:false,url:'',noProxy:'localhost',forTools:true},expiresAt:Date.now()+120000};
 let args:string[]=[];let cookie='';
 const result=await executeBilibiliJob(job,root,new AbortController().signal,{run:async(_command,a,options)=>{args=a;assert.equal(options.env.CONSOLE_PLUGIN_RUNNER_TOKEN,undefined);const index=a.indexOf('--cookies');cookie=readFileSync(a[index+1]!,'utf8');return JSON.stringify({title:'Synthetic video',uploader:'Synthetic author',webpage_url:url,duration:60,subtitles:{zh:[{url:'https://i0.hdslb.com/subtitle/synthetic.json',ext:'json'}]}});},fetch:async()=>new Response(JSON.stringify({body:[{from:0,to:1,content:'Synthetic speech'}]}))});
 assert.equal(result.content?.subtitle?.text,'Synthetic speech');assert.ok(args.includes('--ignore-config'));assert.equal(args.at(-1),url);assert.match(cookie,/synthetic-cookie/u);await result.cleanup();
 assert.deepEqual(result.content?.subtitle?.segments,[{start:0,end:1,text:'Synthetic speech'}]);assert.equal(result.content?.subtitle?.automatic,false);
});

test('platform subprocess proxy stays enabled when the separate Bash proxy option is disabled',async t=>{
 const root=await mkdtemp(join(tmpdir(),'nekodock-bili-proxy-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const job:PluginRunnerJob={id:'job',lease:'lease',botId:'bot',pluginId:'bilibili',operation:'resolve',resource,config:{enhance:true,subtitles:false,autoVideo:false,maxDurationSeconds:300,maxMiB:50,maxHeight:720,timeoutSeconds:120,waitSeconds:2,cacheHours:24,cacheMaxMiB:1024},networkProxy:{enabled:true,url:'http://proxy.example:8080',username:'synthetic-user',password:'synthetic-password',noProxy:'localhost',forTools:false},expiresAt:Date.now()+120000};
 const execution=await executeBilibiliJob(job,root,new AbortController().signal,{run:async(_command,_args,options)=>{assert.equal(options.env.HTTPS_PROXY,'http://synthetic-user:synthetic-password@proxy.example:8080/');assert.ok(options.env.NO_PROXY?.includes('localhost'));return JSON.stringify({title:'Synthetic video',webpage_url:url,duration:60});}});await execution.cleanup();
});

test('download budget stops unknown-length media while avoiding double-counting a remux copy',async t=>{
 const root=await mkdtemp(join(tmpdir(),'nekodock-bili-budget-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 await writeFile(join(root,'video.f1.mp4'),Buffer.alloc(600));await writeFile(join(root,'video.f2.m4a'),Buffer.alloc(300));await writeFile(join(root,'video.temp.mp4'),Buffer.alloc(900));
 const controller=new AbortController(),monitor=monitorDownloadBudget(root,1000,controller,5);await monitor.check();assert.equal(controller.signal.aborted,false);
 await writeFile(join(root,'video.f2.m4a'),Buffer.alloc(500));await monitor.check();assert.equal(controller.signal.aborted,true);assert.equal(monitor.exceeded(),true);await monitor.stop();
 const job:PluginRunnerJob={id:'job',lease:'lease',botId:'bot',pluginId:'bilibili',operation:'download',resource,content,config:{enhance:true,subtitles:true,autoVideo:false,maxDurationSeconds:300,maxMiB:1,maxHeight:720,timeoutSeconds:120,waitSeconds:2,cacheHours:24,cacheMaxMiB:1024},networkProxy:{enabled:false,url:'',noProxy:'localhost',forTools:true},expiresAt:Date.now()+120000};
 let probed=false;
 await assert.rejects(executeBilibiliJob(job,root,new AbortController().signal,{run:async(command,_args,options)=>{
   if(command==='ffprobe'){probed=true;return '{}';}
   await writeFile(join(options.cwd,'video.mp4.part'),Buffer.alloc(1024*1024+1));
   await new Promise<void>((_resolve,reject)=>{options.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});});return '';
 }}),/BILIBILI_MEDIA_TOO_LARGE/u);assert.equal(probed,false);
});

test('Bilibili short redirects reject arbitrary destinations and public errors retain a safe code',async()=>{
 await assert.rejects(resolveBilibiliUrl('https://b23.tv/AbCd',async()=>new Response(null,{status:302,headers:{location:'http://127.0.0.1/private'}}),new AbortController().signal),/BILIBILI_REDIRECT_REJECTED/u);
 await assert.rejects(resolveBilibiliUrl('https://b23.tv/AbCd',async()=>new Response(null,{status:412}),new AbortController().signal),/BILIBILI_HTTP_412/u);
});

test('actual extractor inline SRT subtitles retain timestamps and danmaku is not interpreted as speech',async t=>{
 const root=await mkdtemp(join(tmpdir(),'nekodock-bili-srt-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const srt='1\n00:00:01,200 --> 00:00:02,500\nSynthetic subtitle.\n\n2\n00:01:00,000 --> 00:01:01,000\nSecond line.\n';
 assert.deepEqual(parseSubtitle(srt,'srt'),[{start:1.2,end:2.5,text:'Synthetic subtitle.'},{start:60,end:61,text:'Second line.'}]);
 const job:PluginRunnerJob={id:'job',lease:'lease',botId:'bot',pluginId:'bilibili',operation:'resolve',resource,config:{enhance:true,subtitles:true,autoVideo:false,maxDurationSeconds:300,maxMiB:50,maxHeight:720,timeoutSeconds:120,waitSeconds:2,cacheHours:24,cacheMaxMiB:1024},networkProxy:{enabled:false,url:'',noProxy:'localhost',forTools:true},expiresAt:Date.now()+120000};
 for(const state of ['inline','absent','login'] as const) {
   const execution=await executeBilibiliJob(job,root,new AbortController().signal,{run:async(_command,args)=>{assert.ok(args.includes('--write-subs'));return JSON.stringify({title:'Synthetic video',webpage_url:url,duration:60,...(state==='login'?{_nekodock_subtitle_login_required:true}:{}),subtitles:{danmaku:[{ext:'xml',url:'https://comment.bilibili.com/test.xml'}],...(state==='inline'?{'ai-zh':[{ext:'srt',data:srt}]}:{})}});},fetch:async()=>assert.fail('Inline or absent subtitles must not fetch danmaku')});
   assert.equal(execution.content?.subtitle?.status,state==='inline'?'ready':state==='login'?'login_required':'absent');if(state==='inline'){assert.equal(execution.content?.subtitle?.automatic,true);assert.equal(execution.content?.subtitle?.segments?.[0]?.start,1.2);}await execution.cleanup();
 }
});

test('shared plugin runner claims, uploads bounded media and reports durable results over authenticated HTTP',async t=>{
 const root=mkdtempSync(join(tmpdir(),'nekodock-plugin-runner-http-'));const instance=await createConsole({dataDir:root,docker:{} as DockerClient,timers:false,staticDir:join(root,'absent'),pluginRunnerToken:'synthetic-runner-token'});const controller=new AbortController();let running:Promise<void>|undefined;
 t.after(async()=>{controller.abort();await running;await instance.app.close();rmSync(root,{recursive:true,force:true});});
 const bot=instance.db.createBot({name:'Synthetic bot',targetType:'group',targetId:'1001',config:{}});instance.db.setDesiredState(bot.id,'running');instance.db.plugins.update(bot.id,'bilibili',{expectedRevision:0,enabled:true,settings:{autoVideo:true}});
 instance.db.enqueueNapcatEvent(bot.id,message('m1'),'synthetic:m1');instance.db.plugins.sync(bot.id,{bindings:[{messageId:'m1',conversationId:'conversation-one'}]});
 await instance.app.listen({host:'127.0.0.1',port:0});const address=instance.app.server.address();assert.ok(address&&typeof address!=='string');const videoPath=join(root,'synthetic.mp4');await writeFile(videoPath,mp4);
 const operations:string[]=[];running=runPluginRunner({url:`http://127.0.0.1:${address.port}`,token:'synthetic-runner-token',workspace:join(root,'runner'),signal:controller.signal,execute:async job=>{operations.push(job.operation);return job.operation==='resolve'?{content,cleanup:async()=>{}}:{file:videoPath,cleanup:async()=>{}};}});
 const deadline=Date.now()+5000;while(!instance.db.plugins.snapshot(bot.id).results.some(r=>r.kind==='video')){assert.ok(Date.now()<deadline,'Runner HTTP pipeline timed out');await new Promise(resolve=>setTimeout(resolve,10));}
 const video=instance.db.plugins.snapshot(bot.id).results.find(r=>r.kind==='video')!;assert.deepEqual(operations,['resolve','download']);assert.ok(video.assetId);assert.equal(video.content?.title,content.title);assert.ok(instance.db.pluginAssets.info(bot.id,video.assetId!));
 instance.db.updateNapcatConnection(bot.connectionId,{mediaBaseUrl:'http://console.example'});
 const sent:unknown[]=[];instance.gateway.send=async(_botId,request)=>{sent.push(request);return {ok:true,messageId:'standalone-video'};};
 const endpoint=`/internal/workers/${bot.id}/plugins/${encodeURIComponent(video.id)}/send`,headers={authorization:`Bearer ${bot.workerToken}`};
 const first=await instance.app.inject({method:'POST',url:endpoint,headers,payload:{}});
 assert.equal(first.statusCode,200,first.body);assert.equal(first.json().replyTo,null);assert.equal(first.json().messageId,'standalone-video');
 assert.equal(sent.length,1);assert.equal((sent[0] as {kind:string}).kind,'video');assert.equal('replyTo' in (sent[0] as object),false);
 const recovered=await instance.app.inject({method:'POST',url:endpoint,headers,payload:{}});assert.equal(recovered.json().replyTo,null);assert.equal(sent.length,1);
});

test('plugin HTTP routes authenticate workers and runner, stream signed media with ranges and preserve unknown sends',async t=>{
 const root=mkdtempSync(join(tmpdir(),'nekodock-plugin-api-'));const console=await createConsole({dataDir:root,docker:{} as DockerClient,timers:false,staticDir:join(root,'absent'),pluginRunnerToken:'synthetic-runner-token'});
 t.after(async()=>{await console.app.close();rmSync(root,{recursive:true,force:true});});
 const bot=console.db.createBot({name:'Synthetic bot',targetType:'group',targetId:'1001',config:{}});console.db.setDesiredState(bot.id,'running');console.db.setRuntime(bot.id,{state:'running'});
 assert.equal((await console.app.inject({method:'POST',url:'/internal/plugin-runner/claim',payload:{}})).statusCode,401);
 assert.equal((await console.app.inject({url:`/internal/workers/${bot.id}/plugins`})).statusCode,401);
 console.db.plugins.update(bot.id,'bilibili',{expectedRevision:0,enabled:true});console.db.enqueueNapcatEvent(bot.id,message('m1','/bili info '+url),'synthetic:m1');console.db.plugins.sync(bot.id,{bindings:[{messageId:'m1',conversationId:'c1'}]});
 const job=console.db.plugins.claim()!;console.db.plugins.complete(job.id,job.lease,{content});const result=console.db.plugins.snapshot(bot.id).results.find(r=>r.kind==='reply')!;
 let sends=0;console.gateway.send=async()=>{sends++;return {ok:false,code:'NAPCAT_SEND_UNCONFIRMED',deliveryStatus:'unconfirmed'};};
 const headers={authorization:`Bearer ${bot.workerToken}`};const endpoint=`/internal/workers/${bot.id}/plugins/${encodeURIComponent(result.id)}/send`;
 const first=await console.app.inject({method:'POST',url:endpoint,headers,payload:{conversationId:'c1'}});assert.equal(first.json().deliveryStatus,'unconfirmed');
 const second=await console.app.inject({method:'POST',url:endpoint,headers,payload:{conversationId:'c1'}});assert.equal(second.json().deliveryStatus,'unconfirmed');assert.equal(sends,1);
 const asset=await console.db.pluginAssets.upload(join(root,'plugin-assets'),bot.id,Readable.from([mp4]),{maxBytes:1024,cacheMaxBytes:1024,cacheHours:1});const signed=new URL(console.db.pluginAssets.signedUrl(bot.id,asset,'http://console.example'));
 const range=await console.app.inject({url:signed.pathname+signed.search,headers:{range:'bytes=4-7'}});assert.equal(range.statusCode,206);assert.equal(range.body,'ftyp');
 const head=await console.app.inject({method:'HEAD',url:signed.pathname+signed.search});assert.equal(head.statusCode,200);assert.equal(head.body,'');
});
