import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { createConsole } from '../src/console/server.js';
import { DockerClient } from '../src/console/docker.js';
import type { PluginContent, PluginRunnerJob } from '../src/plugin-contract.js';
import { assertAccepted, bindHost, piFixture, pngBase64, requestHost, respond, sendReply } from './fixtures/pi-e2e.js';

const png=Buffer.from(pngBase64,'base64');
const card=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAFElEQVR4nGPUaLrEwMDAxAAGUAoAG94BgqFCKSEAAAAASUVORK5CYII=','base64');
const gameUrl='https://www.xiaoheihe.cn/app/topic/game/pc/123456';
const videoUrl='https://www.douyin.com/video/1234567890123456789';

test('game cards and Douyin videos retain original shares, cached covers and real receipts across managed Worker restart', {timeout:100000}, async t=>{
  const f=await piFixture(t,(call,response)=>{
    if(call.results.length){assertAccepted(call);respond(call,response,'Internal completion.');return;}
    assert.deepEqual(call.replyTargetMessageIds,['question']);
    for(const [source,platform,type] of [['game-share','heybox','game'],['video-share','douyin','video']]){
      const messages=call.batch.filter(item=>item.messageId===source);
      assert.equal(messages.length,1,'Each share is still one original human message');
      assert.equal(messages[0]!.origin,'human');
      const contents=messages[0]!.contents as PluginContent[];
      assert.equal(contents.length,1);assert.equal(contents[0]!.platform,platform);assert.equal(contents[0]!.type,type);
      assert.ok(contents[0]!.blocks?.some(block=>block.type==='image'&&block.image.status==='ready'&&block.image.assetId));
    }
    const game=(call.batch.find(item=>item.messageId==='game-share')!.contents as PluginContent[])[0]!;
    assert.equal(game.game?.platform,'epic');assert.equal(game.game?.score?.value,8.5);
    assert.equal(game.game?.prices?.[0]?.label,'Epic 商店价');
    for(const [actualId,source] of [['88001','game-share'],['88002','video-share']]){
      const replies=call.batch.filter(item=>item.messageId===actualId);
      assert.equal(replies.length,1,'Each real ACK is recorded once');
      assert.equal(replies[0]!.origin,'plugin');assert.equal(replies[0]!.sourceMessageId,source);
      assert.equal(replies[0]!.replyTo,null);
    }
    assert.equal(call.batch.find(item=>item.messageId==='question')!.replyTo,'88002');
    assert.doesNotMatch(JSON.stringify(call.body),/synthetic-tracking-marker|miniapp|externalEvents|x-signature|ttwid=/);
    assert.equal(call.images.length,0,'Covers and rendered presentation cards are not duplicate vision input');
    sendReply(call,response,[{type:'text',text:'The game details and video caption are available.'}]);
  });
  const directory=await mkdtemp(join(tmpdir(),'managed-share-platforms-'));
  const app=await createConsole({dataDir:directory,timers:false,staticDir:'/nonexistent',pluginRunnerToken:'synthetic-share-runner',
    docker:new DockerClient({socketPath:'unused',image:'unused',network:'unused',consoleUrl:'unused'})});
  t.after(async()=>{await app.app.close();await rm(directory,{recursive:true,force:true});});
  await app.app.listen({host:bindHost,port:0});const port=(app.app.server.address() as AddressInfo).port;
  const connection=app.db.createNapcatConnection({name:'Synthetic transport',wsUrl:f.localWsUrl,mediaBaseUrl:`http://127.0.0.1:${port}`});
  const bot=app.db.createBot({name:'Synthetic bot',targetType:'group',targetId:'1001',connectionId:connection.id,
    config:{model:'synthetic-model',baseUrl:f.modelUrl,modelApi:'openai-responses',memoryEnabled:false,replyProbability:0,voiceEnabled:false,allowCommands:false,allowFileWrites:false}});
  for(const pluginId of ['heybox','douyin'])app.db.plugins.update(bot.id,pluginId,{expectedRevision:0,enabled:true});
  app.db.setDesiredState(bot.id,'running');app.db.setRuntime(bot.id,{state:'starting'});
  await app.gateway.reconcile();await f.waitFor(()=>app.gateway.getConnectionStatus(connection.id).online,'mock QQ connected');
  const environment={CONSOLE_URL:`http://${requestHost}:${port}`,BOT_INSTANCE_ID:bot.id,WORKER_TOKEN:bot.workerToken};
  const worker=await f.start('1001',environment);
  await f.waitFor(()=>app.gateway.getBotStatus(bot.id).channelConnected,'Worker transport');
  const gameEvent=f.event('game-share','',false);
  f.broadcast({...gameEvent,message:[{type:'json',data:{data:JSON.stringify({app:'synthetic.miniapp',config:{token:'synthetic-tracking-marker'},
    meta:{detail_1:{qqdocurl:gameUrl,desc:'Synthetic game'}}})}}]});
  f.send('video-share',`Synthetic video caption ${videoUrl}`,false);
  const gameContent:PluginContent={type:'game',platform:'heybox',resourceId:'game:pc:123456',url:gameUrl,title:'Synthetic game',description:'Verified game description',
    game:{gameType:'pc',appId:'123456',platform:'epic',platformName:'Epic',score:{value:8.5,scale:10,source:'小黑盒'},prices:[{source:'platform',label:'Epic 商店价',current:'25',region:'中国'}]},
    observedAt:1700000000,coverUrl:'https://cdn.max-c.com/cover.png',retrieval:{status:'ready'}};
  const videoContent:PluginContent={type:'video',platform:'douyin',resourceId:'video:1234567890123456789',url:videoUrl,title:'Synthetic video caption',description:'Verified video caption',
    author:'Synthetic author',durationSeconds:20,subtitle:{status:'absent'},retrieval:{status:'ready'},
    blocks:[{type:'image',image:{id:'video:1234567890123456789:cover',role:'cover',url:'https://p3.douyinpic.com/synthetic-cover.jpg',status:'pending'}}]};
  const completed=new Set<string>();let videoFetched=false;
  const media=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.alloc(24)]);
  f.onSend=(message,socket)=>{
    const image=message.params.message.find(segment=>segment.type==='image');
    if(image){assert.equal(message.params.message.length,1);assert.equal(image.data.file,'base64://'+card.toString('base64'));
      socket.send(JSON.stringify({echo:message.echo,status:'ok',retcode:0,data:{message_id:88001}}));return false;}
    const video=message.params.message.find(segment=>segment.type==='video');if(!video)return;
    assert.equal(message.params.message.length,1);
    void(async()=>{
      const response=await fetch(video.data.file!,{headers:{range:'bytes=0-15'}});assert.equal(response.status,206);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()),media.subarray(0,16));videoFetched=true;
      socket.send(JSON.stringify({echo:message.echo,status:'ok',retcode:0,data:{message_id:88002}}));
    })().catch(error=>f.failures.push(error));return false;
  };
  const upload=async(job:PluginRunnerJob,key:string,type:'image'|'video',role:string,bytes:Buffer)=>{
    const assetId=await app.db.pluginAssets.upload(join(directory,'assets'),bot.id,Readable.from([bytes]),{type,maxBytes:1024,cacheMaxBytes:10240,cacheHours:1});
    app.db.plugins.attachAsset(job.id,job.lease,assetId,key,type,role);return assetId;
  };
  while(completed.size<5){
    let job:PluginRunnerJob|null=null;
    await f.waitFor(()=>{job=app.db.plugins.claim();return !!job;},'source-bound platform work');
    const current=job as unknown as PluginRunnerJob;
    if(current.operation==='resolve')app.db.plugins.complete(current.id,current.lease,{content:current.pluginId==='heybox'?gameContent:videoContent});
    else if(current.operation==='download'){
      const assetId=await upload(current,'video','video','video',media);app.db.plugins.complete(current.id,current.lease,{assetId});
    }else{
      const content=structuredClone(current.content!);
      const assetId=await upload(current,'cover','image','cover',png);
      content.blocks=[{type:'image',image:{id:`${content.resourceId}:cover`,url:current.pluginId==='heybox'?'https://cdn.max-c.com/cover.png':'https://p3.douyinpic.com/synthetic-cover.jpg',
        role:'cover',assetId,status:'ready',width:1,height:1}}];
      if(current.pluginId==='heybox'){
        const cardId=await upload(current,'card','image','presentation',card);
        app.db.plugins.complete(current.id,current.lease,{content,outputs:[{kind:'image',assetId:cardId,assetRole:'presentation'}]});
      }else app.db.plugins.complete(current.id,current.lease,{content,outputs:[]});
    }
    completed.add(current.id);
  }
  await f.waitFor(()=>videoFetched&&f.read('1001',db=>Number(db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE origin='plugin'").get()?.n)===2),'confirmed card and video');
  await f.waitFor(()=>f.read('1001',db=>Number(db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE origin='human' AND contents_json LIKE '%assetId%'").get()?.n)===2),'both cached covers reach source messages');
  assert.equal(f.calls.length,0,'Automatic share enhancement and presentation do not invoke the main model');
  await f.stop(worker);await f.start('1001',environment);
  await f.waitFor(()=>app.gateway.getBotStatus(bot.id).channelConnected,'Worker reconnect');
  const follow=f.event('question','What were the game and video shares?');
  f.broadcast({...follow,message:[{type:'reply',data:{id:'88002'}},...follow.message]});
  await f.waitFor(()=>f.complete(3),'model gets source data and confirmed media');
  assert.equal(f.outgoing.filter(item=>item.params.message.some(segment=>segment.type==='image'||segment.type==='video')).length,2);
  assert.equal(app.db.plugins.view(bot.id,'core').jobs.length,0);
  assert.ok(app.db.plugins.jobs(bot.id).every(job=>['heybox','douyin'].includes(job.pluginId)));
});
