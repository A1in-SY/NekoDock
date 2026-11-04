import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConsoleDatabase } from '../src/console/database.js';
import { defaultSettings, normalizeSettings, settingsToEnv, validateSettings } from '../src/console/settings.js';
import { loadConfig } from '../src/config.js';
import type { MemoryView } from '../src/memory-contract.js';
import { createConsole } from '../src/console/server.js';
import { DockerClient } from '../src/console/docker.js';
function fixture(t: test.TestContext) {
  const path=mkdtempSync(join(tmpdir(),'memory-console-')); const file=join(path,'console.sqlite3'),key=join(path,'master.key');
  const db=new ConsoleDatabase(file,key);t.after(()=>{db.close();rmSync(path,{recursive:true,force:true});});
  const bot=db.createBot({name:'Example',targetType:'group',targetId:'12345',config:{memoryEnabled:true}});
  const other=db.createBot({name:'Other',targetType:'private',targetId:'45678',config:{memoryEnabled:false}});
  return {db,bot,other,path,file,key};
}
function view(): MemoryView {return {enabled:true,cursor:1,highWater:2,version:1,items:[{id:'memory-one',scope:'person',subjectUserId:'1001',kind:'preference',topic:'Food',content:'synthetic-private-memory-content',occurredAt:null,validFrom:null,validTo:null,status:'active',revision:1,sources:[{sourceId:'incoming:one',quote:'synthetic-private-source-quote'}],createdAt:1,updatedAt:1}],jobs:[],events:[]};}

test('memory projection is encrypted, scoped and independent of conversation state',t=>{
  const {db,bot,other,file}=fixture(t);const before=db.getPublicBot(bot.id)!;
  db.memory.sync(bot.id,{view:view(),receipts:[]});
  assert.equal(db.memory.view(bot.id).view!.items[0]!.content,'synthetic-private-memory-content');
  assert.equal(db.memory.view(other.id).view,null);
  assert.equal(db.getPublicBot(bot.id)!.processing,before.processing);
  assert.equal(db.getPublicBot(bot.id)!.statistics.totalReplies,before.statistics.totalReplies);
  const disk=Buffer.concat([readFileSync(file),readFileSync(file+'-wal')]);
  assert.equal(disk.includes(Buffer.from('synthetic-private-memory-content')),false);
  assert.equal(disk.includes(Buffer.from('synthetic-private-source-quote')),false);
  assert.throws(()=>db.memory.view('missing'),/实例不存在/);
});

test('memory controls remain pending until Worker receipts, enforce revisions and bot boundaries',t=>{
  const {db,bot,other}=fixture(t);db.memory.sync(bot.id,{view:view(),receipts:[]});
  const control=db.memory.request(bot.id,{operation:'update',memoryId:'memory-one',expectedRevision:1,content:'new synthetic content'});
  assert.equal(control.status,'pending');assert.equal(db.memory.view(bot.id).view!.items[0]!.content,'synthetic-private-memory-content');
  assert.equal(db.memory.snapshot(other.id).controls.length,0);
  assert.throws(()=>db.memory.request(bot.id,{operation:'disable',memoryId:'memory-one',expectedRevision:2}),/版本冲突/);
  assert.throws(()=>db.memory.request(other.id,{operation:'disable',memoryId:'memory-one',expectedRevision:1}),/记忆不存在/);
  assert.throws(()=>db.memory.sync(other.id,{view:{...view(),items:[]},receipts:[{id:control.id,ok:true}]}),/不属于本实例/);
  assert.equal(db.memory.view(other.id).view,null,'invalid receipts roll back the whole update');
  const next=view();next.version=2;next.items[0]!.revision=2;next.items[0]!.content='new synthetic content';
  db.memory.sync(bot.id,{view:next,receipts:[{id:control.id,ok:true}]});
  assert.equal(db.memory.view(bot.id).controls[0]!.status,'completed');assert.equal(db.memory.snapshot(bot.id).controls.length,0);
  db.memory.sync(bot.id,{view:view(),receipts:[{id:control.id,ok:true}]});
  assert.equal(db.memory.view(bot.id).view!.version,2,'stale snapshots cannot overwrite new views');
  const restore=db.memory.request(bot.id,{operation:'update',memoryId:'memory-one',expectedRevision:2,content:'restored synthetic content',restore:true});
  assert.equal(db.memory.snapshot(bot.id).controls.find(control=>control.id===restore.id)!.restore,true);
});

test('invalid or excessive controls do not become successful operations and errors are sanitized',t=>{
  const {db,bot}=fixture(t);
  for(const request of [{operation:'backfill',from:10,to:5},{operation:'run',botId:'other'},{operation:'delete'},{operation:'update',memoryId:'one',expectedRevision:1,content:''}])assert.throws(()=>db.memory.request(bot.id,request));
  const command=db.memory.request(bot.id,{operation:'run'});
  db.memory.sync(bot.id,{view:{...view(),items:[]},receipts:[{id:command.id,ok:false,error:'secret request body'}]});
  assert.equal(db.memory.view(bot.id).controls[0]!.error,'MEMORY_CONTROL_FAILED');
  assert.throws(()=>db.memory.sync(bot.id,{view:{...view(),cursor:10},receipts:[]}));
});

test('retry controls require a failed job from the same instance and stay asynchronous',t=>{
  const {db,bot,other}=fixture(t);const snapshot=view();
  snapshot.jobs=[{id:'failed-example',reason:'backfill',status:'failed',fromSeq:0,throughSeq:200,processedSeq:75,attempts:3,error:'MEMORY_QUOTE_MISMATCH',createdAt:1,startedAt:2,finishedAt:3}];
  db.memory.sync(bot.id,{view:snapshot,receipts:[]});
  const command=db.memory.request(bot.id,{operation:'retry',jobId:'failed-example'});
  assert.equal(command.status,'pending');assert.equal(command.jobId,'failed-example');
  assert.equal(db.memory.view(bot.id).view!.jobs[0]!.processedSeq,75);
  assert.equal(db.memory.snapshot(bot.id).controls[0]!.jobId,'failed-example');
  assert.throws(()=>db.memory.request(other.id,{operation:'retry',jobId:'failed-example'}),/记忆作业不存在/);
  assert.throws(()=>db.memory.request(bot.id,{operation:'retry',jobId:'missing'}),/记忆作业不存在/);
  assert.throws(()=>db.memory.request(bot.id,{operation:'retry'}),/记忆作业无效/);
});

test('legacy instances preserve disabled memory while new defaults and secret fields round trip',()=>{
  assert.equal(defaultSettings().memoryEnabled,true);assert.equal(normalizeSettings({}).memoryEnabled,false);
  const settings=validateSettings({...defaultSettings(),memoryModel:'example-model',memoryBaseUrl:'http://127.0.0.1:9999/v1',memoryApiKey:'synthetic-key',memoryEmbeddingProvider:'openai-compatible',memoryEmbeddingBaseUrl:'http://127.0.0.1:9998/v1',memoryEmbeddingModel:'example-embedding',memoryEmbeddingApiKey:'synthetic-embedding-key'});
  const parsed=loadConfig(settingsToEnv(settings,{type:'group',id:'12345'}));
  assert.equal(parsed.memory.model,'example-model');assert.equal(parsed.memory.dailyTime,'04:00');assert.equal(parsed.memory.apiKey,'synthetic-key');assert.equal(parsed.memory.embeddingApiKey,'synthetic-embedding-key');
  assert.equal(parsed.agentKeepRecentTokens,20_000);assert.equal(parsed.agentSummaryMaxTokens,4000);
  assert.equal(validateSettings({maxOutputTokens:512}).compactSummaryMaxTokens,512);
  assert.equal(validateSettings({compactLimit:16_000,maxOutputTokens:512}).compactKeepRecentTokens,4000);
  assert.throws(()=>validateSettings({compactLimit:16_000,compactKeepRecentTokens:20_000}),/AGENT_KEEP_RECENT_TOKENS/);
  assert.throws(()=>validateSettings({...settings,memoryDailyTime:'25:00'}),/MEMORY_DAILY_TIME/);
  assert.throws(()=>validateSettings({...settings,memoryTimezone:'invalid-zone'}),/MEMORY_TIMEZONE/);
  assert.throws(()=>validateSettings({...settings,memoryEmbeddingModel:''}),/MEMORY_EMBEDDING_PROVIDER/);
  assert.throws(()=>validateSettings({...settings,memoryBaseUrl:'http://user:password@example.test/v1'}),/MEMORY_BASE_URL/);
});

class FakeDocker extends DockerClient {constructor(){super({socketPath:'unused',image:'unused',network:'unused',consoleUrl:'unused'});}override async inspect(){return null;}override async create(){}override async start(){}}
test('memory HTTP endpoints require console auth, CSRF and scoped Worker tokens',async()=>{
  const path=mkdtempSync(join(tmpdir(),'memory-console-http-'));const {app,db}=await createConsole({dataDir:path,docker:new FakeDocker(),timers:false,staticDir:'/nonexistent'});
  try {
    const setup=await app.inject({method:'POST',url:'/api/setup',headers:{'x-console-request':'1'},payload:{password:'long-synthetic-password'}});
    const cookie=String(setup.headers['set-cookie']).split(';')[0]!;
    const bot=db.createBot({name:'Example',targetType:'group',targetId:'12345',config:{memoryApiKey:'synthetic-secret',memoryEmbeddingApiKey:'synthetic-embed-secret'}});
    const other=db.createBot({name:'Other',targetType:'group',targetId:'67890',config:{}});
    assert.equal((await app.inject(`/api/bots/${bot.id}/memory`)).statusCode,401);
    assert.equal((await app.inject({method:'POST',url:`/api/bots/${bot.id}/memory/controls`,headers:{cookie},payload:{operation:'run'}})).statusCode,403);
    const queued=await app.inject({method:'POST',url:`/api/bots/${bot.id}/memory/controls`,headers:{cookie,'x-console-request':'1'},payload:{operation:'run'}});
    assert.equal(queued.statusCode,202,queued.body);
    const wrong=await app.inject({url:`/internal/workers/${bot.id}/memory`,headers:{authorization:`Bearer ${other.workerToken}`}});assert.equal(wrong.statusCode,401);
    const claimed=await app.inject({url:`/internal/workers/${bot.id}/memory`,headers:{authorization:`Bearer ${bot.workerToken}`}});assert.equal(claimed.json().controls.length,1);
    const synced=await app.inject({method:'POST',url:`/internal/workers/${bot.id}/memory`,headers:{authorization:`Bearer ${bot.workerToken}`},payload:{view:view(),receipts:[{id:queued.json().id,ok:true}]}});assert.equal(synced.statusCode,200,synced.body);
    const shown=await app.inject({url:`/api/bots/${bot.id}/memory`,headers:{cookie}});assert.equal(shown.json().controls[0].status,'completed');
    const publicBot=db.getPublicBot(bot.id)!;assert.equal(publicBot.configuredSecrets.memoryApiKey,true);assert.equal('memoryApiKey' in publicBot.config,false);assert.equal('memoryEmbeddingApiKey' in publicBot.config,false);
  }finally{await app.close();rmSync(path,{recursive:true,force:true});}
});
