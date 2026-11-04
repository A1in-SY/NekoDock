import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import type WebSocket from 'ws';
import { createConsole } from '../src/console/server.js';
import { DockerClient } from '../src/console/docker.js';
import type { PluginContent, PluginRunnerJob } from '../src/plugin-contract.js';
import { assertAccepted, bindHost, dockerImage, piFixture, pngBase64, requestHost, respond, sendReply, type ModelCall, type Outgoing } from './fixtures/pi-e2e.js';

const sourcePng=Buffer.from(pngBase64,'base64');
const cardPng=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAFElEQVR4nGPUaLrEwMDAxAAGUAoAG94BgqFCKSEAAAAASUVORK5CYII=','base64');

function envelopes(call:ModelCall):Array<Record<string,unknown>> {
  const entries=call.body.input??call.body.messages??[];
  return entries.filter((entry:{role?:string})=>entry.role==='user').flatMap((entry:{content?:unknown})=>{
    const value=typeof entry.content==='string'?entry.content:Array.isArray(entry.content)?entry.content.filter((part:{type?:string})=>part.type==='text'||part.type==='input_text').map((part:{text?:string})=>part.text??'').join(''):'';
    try {const parsed=JSON.parse(value);return Array.isArray(parsed.messages)?[parsed]:[];}catch{return [];}
  });
}
function wireImages(call:ModelCall):string[] {
  const entries=call.body.input??call.body.messages??[];
  return entries.flatMap((entry:{content?:unknown})=>Array.isArray(entry.content)?entry.content:[])
    .map((part:{image_url?:string|{url?:string}})=>typeof part.image_url==='string'?part.image_url:part.image_url?.url)
    .filter((value:unknown):value is string=>typeof value==='string'&&value.startsWith('data:'));
}

for(const scenario of [
  {kind:'post',mode:'original',pluginMessages:2,sourceVision:true},
  {kind:'post',mode:'card',pluginMessages:1,sourceVision:true},
  {kind:'live',mode:'original',pluginMessages:2,sourceVision:false},
] as const) {
  test(`managed ${scenario.kind} ${scenario.mode} preserves source context and confirmed image delivery across Worker restart`,{timeout:dockerImage?100000:60000},async t=>{
    const shareId=`share-${scenario.kind}-${scenario.mode}`,questionId=`question-${scenario.kind}-${scenario.mode}`;
    const actualIds=scenario.pluginMessages===1?['93001']:['93001','93002'];
    const f=await piFixture(t,(call,response)=>{
      if(call.results.length){assertAccepted(call);respond(call,response,'Internal completion.');return;}
      assert.deepEqual(call.replyTargetMessageIds,[questionId]);
      const batches=envelopes(call),messages=batches.flatMap(batch=>batch.messages as Array<Record<string,unknown>>);
      const shares=messages.filter(message=>message.messageId===shareId);
      assert.equal(shares.length,1,'The original share occurs exactly once in actual Pi input');
      assert.equal(shares[0]?.origin,'human');assert.match(JSON.stringify(shares[0]?.contents),scenario.kind==='post'?/Synthetic post body/:/Synthetic offline room/);
      assert.doesNotMatch(JSON.stringify(call.body),/externalEvents|contextBatch|tracking-marker|com\.tencent\.miniapp/);
      for(const actualId of actualIds) {
        const replies=messages.filter(message=>message.messageId===actualId);
        assert.equal(replies.length,1,'Every ACKed plugin message is a single actual chat fact');
        assert.equal(replies[0]?.origin,'plugin');assert.equal(replies[0]?.sourceMessageId,shareId);
      }
      const imageReply=messages.find(message=>message.messageId===actualIds.at(-1))!;
      assert.equal(imageReply.replyTo,null,'Image delivery has a source association without claiming a QQ quote');
      assert.equal((imageReply.assets as Array<{modelInput?:boolean}>)[0]?.modelInput,false);
      const question=messages.find(message=>message.messageId===questionId)!;assert.equal(question.replyTo,actualIds.at(-1));
      const images=wireImages(call);
      assert.equal(images.length,scenario.sourceVision?1:0,'Only semantic source pictures, not presentation or offline cover, become vision input');
      if(scenario.sourceVision)assert.equal(images[0],'data:image/png;base64,'+sourcePng.toString('base64'));
      if(scenario.kind==='live') {
        const info=(shares[0]?.contents as PluginContent[])[0]!;assert.equal(info.live?.status,'offline');assert.equal(info.live?.preview,undefined);
      }
      sendReply(call,response,[{type:'text',text:'The source and its confirmed image are available.'}]);
    });
    const directory=await mkdtemp(join(tmpdir(),'managed-post-live-e2e-')),runnerToken='synthetic-post-live-runner';
    const app=await createConsole({dataDir:directory,timers:false,staticDir:'/nonexistent',pluginRunnerToken:runnerToken,
      docker:new DockerClient({socketPath:'unused',image:'unused',network:'unused',consoleUrl:'unused'})});
    t.after(async()=>{await app.app.close();await rm(directory,{recursive:true,force:true});});
    let assetRequests=0;
    app.app.addHook('onRequest',async request=>{if(request.url.includes('/plugins/assets/'))assetRequests++;});
    await app.app.listen({host:bindHost,port:0});const port=(app.app.server.address() as AddressInfo).port;
    const connection=app.db.createNapcatConnection({name:'Isolated',wsUrl:f.localWsUrl,mediaBaseUrl:`http://127.0.0.1:${port}`});
    const bot=app.db.createBot({name:'Example',targetType:'group',targetId:'1001',connectionId:connection.id,
      config:{model:'synthetic-model',baseUrl:f.modelUrl,modelApi:'openai-responses',memoryEnabled:false,replyProbability:0,supportsImages:true,supportsReasoning:false,
        voiceEnabled:false,allowCommands:false,allowFileWrites:false}});
    const config=app.db.plugins.view(bot.id,'bilibili');
    app.db.plugins.update(bot.id,'bilibili',{expectedRevision:config.revision,enabled:true,config:{dynamicEnhance:true,dynamicDisplay:scenario.mode,liveEnhance:true,liveDisplay:scenario.mode}});
    app.db.setDesiredState(bot.id,'running');app.db.setRuntime(bot.id,{state:'starting'});await app.gateway.reconcile();
    await f.waitFor(()=>app.gateway.getConnectionStatus(connection.id).online,'mock NapCat login');
    const overrides={CONSOLE_URL:`http://${requestHost}:${port}`,BOT_INSTANCE_ID:bot.id,WORKER_TOKEN:bot.workerToken};
    const worker=await f.start('1001',overrides);await f.waitFor(()=>app.gateway.getBotStatus(bot.id).channelConnected,'managed Worker transport');
    const postId='1000000000000000001',roomId='10001';
    const sourceUrl=scenario.kind==='post'?`https://www.bilibili.com/opus/${postId}`:`https://live.bilibili.com/${roomId}`;
    const event=f.event(shareId,'',false);
    f.broadcast({...event,message:[{type:'json',data:{data:JSON.stringify({app:'com.tencent.miniapp_01',config:{token:'tracking-marker'},meta:{detail_1:{title:'哔哩哔哩',desc:'Synthetic share',qqdocurl:sourceUrl}}})}}]});
    let resolveJob:PluginRunnerJob|null=null;
    await f.waitFor(()=>{resolveJob=app.db.plugins.claim();return resolveJob?.operation==='resolve';},'source resolve job');
    const image={id:'source-image',url:'https://i0.hdslb.com/bfs/new_dyn/synthetic-source.png',role:scenario.kind==='post'?'content' as const:'cover' as const,status:'pending' as const,width:1,height:1};
    const content:PluginContent=scenario.kind==='post'?{type:'post',platform:'bilibili',resourceId:`post:${postId}`,url:sourceUrl,title:'Synthetic post',author:'Synthetic creator',authorId:'2001',publishedAt:1792727200,observedAt:1792727300,
      blocks:[{type:'paragraph',text:'Synthetic post body'},{type:'image',image}],retrieval:{status:'ready'}}:
      {type:'live',platform:'bilibili',resourceId:`live:${roomId}`,url:sourceUrl,title:'Synthetic offline room',author:'Synthetic streamer',authorId:'2001',observedAt:1792727300,
        live:{roomId,status:'offline',area:'Synthetic category',cover:image},retrieval:{status:'ready'}};
    app.db.plugins.complete(resolveJob!.id,resolveJob!.lease,{content});let prepare:PluginRunnerJob|null=null;
    await f.waitFor(()=>{prepare=app.db.plugins.claim();return prepare?.operation==='prepare';},'source-bound prepare job');
    const upload=async(key:string,role:string,bytes:Buffer)=>{
      const result=await app.app.inject({method:'POST',url:`/internal/plugin-runner/jobs/${prepare!.id}/asset`,headers:{authorization:`Bearer ${runnerToken}`,'x-plugin-lease':prepare!.lease,'x-plugin-asset-key':key,'x-plugin-asset-type':'image','x-plugin-asset-role':role,'content-type':'application/octet-stream'},payload:bytes});
      assert.equal(result.statusCode,200,result.body);return result.json().assetId as string;
    };
    const sourceAsset=await upload('source',image.role,sourcePng);
    const prepared=structuredClone(content);
    if(prepared.type==='post') {
      const block=prepared.blocks!.find(block=>block.type==='image')!;assert.equal(block.type,'image');
      block.image={...block.image,status:'ready',assetId:sourceAsset,fetchedAt:1792727301};
    }else prepared.live!.cover={...image,status:'ready',assetId:sourceAsset,fetchedAt:1792727301};
    const displayAsset=scenario.mode==='card'?await upload('card','presentation',cardPng):sourceAsset;
    const role=scenario.mode==='card'?'presentation':image.role;
    let held:{message:Outgoing;socket:WebSocket}|undefined;const pluginSends:Outgoing[]=[];let questionSent=false;
    f.onSend=(message,socket)=>{
      if(questionSent)return;
      const index=pluginSends.length;pluginSends.push(message);
      if(index===0){held={message,socket};return false;}
      assert.ok(index<actualIds.length,'Only the planned plugin outputs are sent');
      assert.equal(app.db.plugins.getResult(bot.id,`output:${prepare!.id}:000`)?.delivery?.status,'acknowledged','The preceding text ACK is durable before the source image is sent');
      socket.send(JSON.stringify({echo:message.echo,status:'ok',retcode:0,data:{message_id:actualIds[index]}}));return false;
    };
    app.db.plugins.complete(prepare!.id,prepare!.lease,{content:prepared,outputs:[...(scenario.mode==='original'?[{kind:'reply' as const,text:scenario.kind==='post'?'Synthetic post body':'Synthetic offline room — 未开播'}]:[]),{kind:'image',assetId:displayAsset,assetRole:role}]});
    await f.waitFor(()=>held!==undefined,'first plugin send awaiting an actual platform ACK');
    assert.equal(pluginSends.length,1);assert.equal(app.db.plugins.snapshot(bot.id).results.filter(result=>result.kind==='image'&&!result.delivery).length,scenario.mode==='original'?0:1);
    assert.equal(f.read('1001',db=>Number(db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE origin='plugin'").get()?.n)),0,'An unacknowledged send is not a chat fact');
    held!.socket.send(JSON.stringify({echo:held!.message.echo,status:'ok',retcode:0,data:{message_id:actualIds[0]}}));
    await f.waitFor(()=>pluginSends.length===scenario.pluginMessages,'all ordered plugin sends');
    await f.waitFor(()=>f.read('1001',db=>Number(db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE origin='plugin' AND qq_message_id IS NOT NULL").get()?.n))===scenario.pluginMessages,'ACKed plugin chat facts');
    const imageSend=pluginSends.at(-1)!;assert.equal(imageSend.params.message.length,1);assert.equal(imageSend.params.message[0]?.type,'image');
    assert.equal(imageSend.params.message[0]?.data.file,'base64://'+(scenario.mode==='card'?cardPng:sourcePng).toString('base64'));
    if(scenario.mode==='original')assert.equal(pluginSends[0]?.params.message.find(segment=>segment.type==='reply')?.data.id,shareId);
    if(scenario.sourceVision) {
      await f.waitFor(()=>f.read('1001',db=>Number(db.prepare("SELECT COUNT(*) AS n FROM incoming_image_cache WHERE source_plugin='bilibili' AND plugin_asset_id=? AND status='ready'").get(sourceAsset)?.n))===1,'source image persists through authenticated Worker asset API');
      assert.equal(assetRequests,1);
      const sourcePath=f.read('1001',db=>String(db.prepare('SELECT path FROM incoming_image_cache WHERE plugin_asset_id=?').get(sourceAsset)?.path));
      const hostPath=dockerImage?join(f.dataPath(),sourcePath.replace(/^\/data\//u,'')):sourcePath;
      assert.deepEqual(await readFile(hostPath),sourcePng);
    } else {
      assert.equal(f.read('1001',db=>Number(db.prepare("SELECT COUNT(*) AS n FROM incoming_image_cache WHERE source_plugin='bilibili'").get()?.n)),0,'Offline cover is not imported as a live visual observation');
      assert.equal(assetRequests,0);
    }
    assert.equal(f.calls.length,0,'Enrichment and plugin output do not trigger a model turn');
    await f.stop(worker);await f.start('1001',overrides);await f.waitFor(()=>app.gateway.getBotStatus(bot.id).channelConnected,'replacement Worker transport');
    questionSent=true;const follow=f.event(questionId,'Discuss the shared content.');f.broadcast({...follow,message:[{type:'reply',data:{id:actualIds.at(-1)!}},...follow.message]});
    await f.waitFor(()=>f.complete(2),'model answers using persistent source context and source images after restart');
    assert.equal(f.calls.filter(call=>!call.results.length).length,1);assert.equal(assetRequests,scenario.sourceVision?1:0,'Restart reuses the persisted source image');
    assert.equal(pluginSends.length,scenario.pluginMessages,'Worker restart never replays completed plugin sends');
  });
}
