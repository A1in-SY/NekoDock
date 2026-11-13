import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import { existsSync, mkdirSync,writeFileSync,renameSync } from 'node:fs';
import { resolve,dirname } from 'node:path';
import {timingSafeEqual} from 'node:crypto';
import type {Readable} from 'node:stream';
import type { ServerResponse } from 'node:http';
import { ConsoleDatabase } from './database.js';
import { MetricsDatabase, resourceSample, type ResourceCounters } from './metrics.js';
import { ConsoleAuth } from './auth.js';
import { DockerClient } from './docker.js';
import { Lifecycle } from './lifecycle.js';
import { defaultSettings } from './settings.js';
import type { WorkerHeartbeat, NapcatConnectionInput, PublicBot } from './contracts.js';
import { createLogger, logEvent } from '../logging.js';
import { LogStreams } from './logs.js';
import { ConversationStreams } from './conversation-streams.js';
import { NapcatGateway } from './napcat-gateway.js';
import { NetworkProbes } from './network-probes.js';
import { ConsoleImagePrefetch } from './incoming-images.js';
import { ForwardInspectionCoordinator } from './inspection-coordinator.js';
import { RunControlStreams } from './run-controls.js';
import {isNapcatSendResult,NAPCAT_MEDIA_MAX_BYTES,type NapcatSendResult} from '../transport-protocol.js';
import type {PluginRunnerResult} from '../plugin-contract.js';
import { contentPlugin } from '../plugin-system/registry.js';
import type { MonitorResource } from '../activity-contract.js';
import type { ActivityOwner } from './activities.js';
import { beginActivity, withActivityReporter } from '../activity.js';

export interface ConsoleOptions {
 dataDir:string; docker:DockerClient; staticDir?:string; timers?:boolean; logPollMs?:number; conversationHeartbeatMs?:number;
 incomingImageFetch?:typeof globalThis.fetch;
 inspectionFetch?:typeof globalThis.fetch;
 pluginRunnerToken?:string;
}
const object=(value:unknown):Record<string,unknown>=>{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('请求内容必须为对象');
 return value as Record<string,unknown>;
};
function numeric(value:unknown,fallback:number):number {const n=Number(value??fallback);if(!Number.isSafeInteger(n)||n<0)throw new Error('时间或分页参数无效');return n;}

export async function createConsole(options:ConsoleOptions){
 mkdirSync(options.dataDir,{recursive:true,mode:0o700});
 const db=new ConsoleDatabase(resolve(options.dataDir,'console.sqlite3'),resolve(options.dataDir,'master.key'));
 const metrics=new MetricsDatabase(resolve(options.dataDir,'metrics.sqlite3'));
 const auth=new ConsoleAuth(db);const logger=createLogger();
 const lifecycle:Lifecycle=new Lifecycle(db,options.docker,(id):number=>gateway.pendingSends(id)+gateway.pendingInbound(id));
 const gateway:NapcatGateway=new NapcatGateway({db,logger,canDeliver:(id):boolean=>{
  const bot=db.getBot(id);return !!bot&&lifecycle.effectiveState(bot)==='running'&&db.getRuntime(id).state!=='stopped';
 }});
 const logs=new LogStreams(db,auth,options.docker,options.logPollMs);
 const conversations=new ConversationStreams(db,auth,options.conversationHeartbeatMs);
 const runControls=new RunControlStreams(db.runControls);
 const networkProbes=new NetworkProbes();
 const incomingImages=new ConsoleImagePrefetch({store:db.images,root:resolve(options.dataDir,'incoming-images'),bot:id=>db.getBot(id),logger,fetch:options.incomingImageFetch});
 incomingImages.start(options.timers!==false);
 const inspections=new ForwardInspectionCoordinator({db,images:incomingImages,gateway,logger,fetch:options.inspectionFetch,
  observe:(job,event)=>{const record=db.monitorPluginJob(job.botId,job.id);metrics.activities.ingest({resourceId:'service:console',botId:job.botId,jobId:job.id,traceId:`job:${record?.rootJobId??job.id}`,pluginId:'forward-nsfw',sourceMessageId:job.sourceMessageId,...(record?.conversationId?{conversationId:record.conversationId}:{})},event);}});
 inspections.start(options.timers!==false);
 const pluginAssetsRoot=resolve(options.dataDir,'plugin-assets');
 const pluginRunnerToken=options.pluginRunnerToken??process.env.CONSOLE_PLUGIN_RUNNER_TOKEN??db.pluginRunnerToken();
 if(process.env.CONSOLE_PLUGIN_RUNNER_TOKEN_FILE){const file=resolve(process.env.CONSOLE_PLUGIN_RUNNER_TOKEN_FILE);mkdirSync(dirname(file),{recursive:true,mode:0o755});writeFileSync(file+'.tmp',pluginRunnerToken+'\n',{mode:0o444});renameSync(file+'.tmp',file);}
 const app=Fastify({logger:false,bodyLimit:4*1024*1024,requestTimeout:30000});
 await app.register(cookie);
 app.addContentTypeParser('application/octet-stream',(_req,payload,done)=>done(null,payload));
 const streams=new Set<{response:ServerResponse;token:unknown}>();const timers:NodeJS.Timeout[]=[];
 let lastCursor=db.getEventCursor();let sampling=false;let lastGatewayState='';
 const networkCounters=new Map<string,ResourceCounters>();
 const generations=new Map<string,string>();
 const monitorResources=():MonitorResource[]=>[...db.listBots().map(bot=>({id:bot.id,name:bot.name+' · Worker',kind:'worker' as const,botId:bot.id})),
  {id:'service:console',name:'Console · 共享',kind:'console'},{id:'service:plugin-runner',name:'plugin-runner · 共享',kind:'plugin-runner'}];
 const projectActivities=()=>{
  try{for(const bot of db.listBots())for(let batch=0;batch<4;batch++){
    const events=db.monitorEvents(bot.id,metrics.activities.cursor(bot.id));if(!events.length)break;
    metrics.activities.project(bot.id,events);if(events.length<500)break;
  }metrics.activities.syncPlugins(db.monitorPluginJobs());}catch{logEvent(logger,'warn','console.activities_projection_failed');}
 };
 const observeSend=(owner:ActivityOwner,action:()=>Promise<NapcatSendResult>)=>withActivityReporter(event=>metrics.activities.ingest(owner,event),undefined,async()=>{
  const span=beginActivity('send','send');try{const result=await span.run(action);span.end(result.ok?'completed':result.code==='RUN_CANCELLED'?'cancelled':'failed');return result;}
  catch(error){span.end('failed',error);throw error;}
 });
 const changes=(force=false)=>{
  const cursor=db.getEventCursor();if(cursor===lastCursor&&!force)return;
  const botIds=new Set<string>();
  while(lastCursor<cursor){const batch=db.listChanges(lastCursor,1000);if(!batch.length)break;
   for(const change of batch)if(change.type!=='conversation.event')botIds.add(change.botId);
   lastCursor=batch.at(-1)!.seq;
  }
  if(force)for(const bot of db.listBots())botIds.add(bot.id);
  if(!botIds.size&&!force)return;
  const chunk=`id: ${cursor}\nevent: change\ndata: ${JSON.stringify({type:'change',botIds:[...botIds]})}\n\n`;
  for(const client of streams){const stream=client.response;if(!auth.valid(client.token)){stream.end();streams.delete(client);}else if(stream.destroyed||stream.writableLength>256*1024){stream.destroy();streams.delete(client);}else stream.write(chunk);}
 };
 const publicBot=(id:string):PublicBot|null=>{
  const bot=db.getPublicBot(id);if(!bot)return null;const status=gateway.getBotStatus(id);
  return {...bot,transportConnected:status.channelConnected,upstreamConnected:status.connected,qqOnline:status.online,
   connected:!!bot.lastHeartbeat&&Date.now()-bot.lastHeartbeat<20000&&bot.connected&&status.channelConnected&&status.connected&&status.online};
 };
 const publicConnection=(id:string)=>{const connection=db.getPublicNapcatConnection(id);return connection?{...connection,...gateway.getConnectionStatus(id)}:null;};
 const refreshGateway=async()=>{
  await gateway.reconcile();
  const state=JSON.stringify(db.listNapcatConnections().map(c=>{
   const s=gateway.getConnectionStatus(c.id);return [c.id,s.connected,s.online,s.accountId,s.error,db.listBots().filter(b=>b.connectionId===c.id).map(b=>gateway.getBotStatus(b.id).channelConnected)];
  }));
  if(state!==lastGatewayState){lastGatewayState=state;changes(true);}else changes();
 };
 app.setErrorHandler((error,_req,reply)=>{
  // Validation errors are deliberately written by our validators; never serialize request bodies or credentials.
  const message=error instanceof Error?error.message:'';
  const safe=/^(?:停止|该轮|更新实例|插件|内置插件|记忆|配置|实例|群聊|私聊|相同|同一|数据卷|管理员|密码|请求|会话|任务|时间|分页|模型|自定义|人格|未知配置|运行|Worker|生效|控制台|NapCat|连接|[a-zA-Z]+(?:[A-Z][a-z]+)* (?:必须|类型|内容|无效))/u.test(message)&&message.length<300;
  const status=message.includes('版本冲突')?409:(error as {statusCode?:number}).statusCode??400;
  reply.code(status>=400&&status<500?status:500).send({error:safe?message:'请求未完成，请检查配置或服务日志'});
 });
 app.addHook('onRequest',async(req,reply)=>{
  reply.header('Cache-Control','no-store').header('X-Content-Type-Options','nosniff').header('X-Frame-Options','DENY').header('Referrer-Policy','same-origin');
  const path=req.url.split('?')[0]!;
  if(path.startsWith('/internal/'))return;
  if(!path.startsWith('/api/'))return;
  if(!['GET','HEAD'].includes(req.method)){
   const origin=req.headers.origin;
   if(req.headers['x-console-request']!=='1'||(origin&&origin!==`${req.protocol}://${req.headers.host}`))return reply.code(403).send({error:'请求来源无效，请刷新页面'});
  }
  if(['/api/setup','/api/login'].includes(path))return;
  if(!auth.valid(req.cookies.console_session))return reply.code(401).send({error:'请先登录'});
 });
 const establish=(token:string,reply:FastifyReply)=>{
  reply.setCookie('console_session',token,{path:'/',httpOnly:true,sameSite:'strict',maxAge:12*3600});return {authenticated:true};
 };
 app.get('/healthz',async()=>({ok:true}));
 app.get('/api/setup',async()=>({needsSetup:auth.needsSetup()}));
 app.post('/api/setup',async(req,reply)=>establish(await auth.setup(object(req.body).password,req.ip),reply));
 app.post('/api/login',async(req,reply)=>{
  try{return establish(await auth.login(object(req.body).password,req.ip),reply);}catch(error){reply.code(401);throw error;}
 });
 app.get('/api/session',async()=>({authenticated:true}));
 app.post('/api/logout',async(req,reply)=>{const token=req.cookies.console_session;auth.logout(token);logs.closeSession(token);conversations.closeSession(token);for(const client of streams)if(client.token===token){client.response.end();streams.delete(client);}reply.clearCookie('console_session',{path:'/'});return {ok:true};});
 app.get('/api/defaults',async()=>{const {wsUrl:_url,napcatToken:_token,reconnectSeconds:_reconnect,actionTimeout:_timeout,...settings}=defaultSettings();return settings;});
 app.get('/api/bots',async()=>db.listBots().map(bot=>publicBot(bot.id)));
 app.get('/api/model-presets',async()=>db.modelPresets.list());
 app.post('/api/model-presets',async(req,reply)=>reply.code(201).send(db.modelPresets.create(req.body)));
 app.put<{Params:{id:string}}>('/api/model-presets/:id',async(req)=>db.modelPresets.update(req.params.id,req.body));
 app.delete<{Params:{id:string}}>('/api/model-presets/:id',async(req)=>{db.modelPresets.delete(req.params.id,object(req.body).expectedRevision);return {ok:true};});
 app.post<{Params:{id:string}}>('/api/bots/:id/model-presets',async(req,reply)=>reply.code(201).send(db.modelPresets.fromBot(req.params.id,req.body)));
 app.get('/api/plugins',async()=>db.plugins.catalog());
 app.get<{Params:{id:string}}>('/api/bots/:id/plugins',async(req)=>db.plugins.list(req.params.id));
 app.get<{Params:{id:string};Querystring:{limit?:string}}>('/api/bots/:id/plugins/jobs',async(req)=>db.plugins.jobs(req.params.id,numeric(req.query.limit,50)));
 app.get<{Params:{id:string;pluginId:string}}>('/api/bots/:id/plugins/:pluginId',async(req)=>db.plugins.view(req.params.id,req.params.pluginId));
 app.put<{Params:{id:string;pluginId:string}}>('/api/bots/:id/plugins/:pluginId',async(req)=>{const result=db.plugins.update(req.params.id,req.params.pluginId,req.body);changes();return result;});
 app.get('/api/napcat-connections',async()=>db.listNapcatConnections().map(c=>publicConnection(c.id)));
 app.post('/api/napcat-connections',async(req,reply)=>{
  const connection=db.createNapcatConnection(object(req.body) as unknown as NapcatConnectionInput);
  await refreshGateway();logEvent(logger,'info','console.napcat.connection_created',{connection_id:connection.id});
  return reply.code(201).send(publicConnection(connection.id));
 });
 app.put<{Params:{id:string}}>('/api/napcat-connections/:id',async(req)=>{
  const input=object(req.body);if(!Number.isSafeInteger(input.expectedRevision))throw new Error('配置版本无效，请刷新后重试');
  const connection=db.updateNapcatConnection(req.params.id,input as Partial<NapcatConnectionInput>&{expectedRevision:number});
  await refreshGateway();logEvent(logger,'info','console.napcat.connection_updated',{connection_id:connection.id,revision:connection.revision});return publicConnection(connection.id);
 });
 app.delete<{Params:{id:string}}>('/api/napcat-connections/:id',async(req)=>{
  db.deleteNapcatConnection(req.params.id);await refreshGateway();logEvent(logger,'info','console.napcat.connection_deleted',{connection_id:req.params.id});return {ok:true};
 });
 app.post<{Params:{id:string}}>('/api/napcat-connections/:id/media-probe',async(req)=>{
   const connection=db.getNapcatConnection(req.params.id);if(!connection)throw new Error('NapCat 连接不存在');
   const url=db.pluginAssets.probeUrl(connection.id,connection.mediaBaseUrl??'');
   return gateway.probeMedia(connection.id,url);
 });
 app.get('/api/logs/stream',async(req,reply)=>logs.open(req,reply));
 app.get<{Params:{id:string}}>('/api/bots/:id/logs/stream',async(req,reply)=>{
  if(!db.getBot(req.params.id))return reply.code(404).send({error:'实例不存在'});
  logs.open(req,reply,req.params.id);
 });
 app.post<{Params:{id:string}}>('/api/bots/:id/network-probe',async(req,reply)=>{
  const bot=db.getBot(req.params.id);if(!bot)return reply.code(404).send({error:'实例不存在'});
  const runtime=db.getRuntime(bot.id);
  if(bot.desiredState!=='running'||runtime.state!=='running'||!runtime.lastHeartbeat||Date.now()-runtime.lastHeartbeat>20_000||bot.appliedRevision<1)
   throw new Error('实例运行后才能检测当前生效配置');
  const job=networkProbes.request(bot.id,bot.appliedRevision);
  logEvent(logger,'info','console.network.probe_requested',{botId:bot.id,revision:job.revision});
  return reply.code(202).send(job);
 });
 app.get<{Params:{id:string};Querystring:{probeId?:string}}>('/api/bots/:id/network-probe',async(req,reply)=>{
  if(!db.getBot(req.params.id))return reply.code(404).send({error:'实例不存在'});
  const job=networkProbes.get(req.params.id,req.query.probeId??'');
  return job??reply.code(404).send({error:'请求检测记录不存在或已过期'});
 });
 app.post('/api/bots',async(req,reply)=>{
  const body=object(req.body);const base=body.copyFrom?db.getBot(String(body.copyFrom)):null;
  if(body.copyFrom&&!base)throw new Error('实例不存在');
  const bot=db.createBot({name:body.name as string,description:body.description as string|undefined,targetType:body.targetType as 'group'|'private',targetId:body.targetId as string,
   connectionId:(body.connectionId??base?.connectionId) as string|undefined,
   config:{...(base?.config??defaultSettings()),...object(body.config??{})}});
  changes();logEvent(logger,'info','console.bot_created',{botId:bot.id});return reply.code(201).send(publicBot(bot.id));
 });
 app.put<{Params:{id:string}}>('/api/bots/:id',async(req)=>{
  const body=object(req.body);if(!Number.isSafeInteger(body.expectedRevision))throw new Error('配置版本无效，请刷新后重试');
  const bot=db.updateBot(req.params.id,{name:body.name as string|undefined,description:body.description as string|undefined,config:body.config,
   modelPreset:body.modelPreset,
   connectionId:body.connectionId as string|undefined,
   expectedRevision:body.expectedRevision as number,targetType:body.targetType as string|undefined,targetId:body.targetId as string|undefined});
  changes();logEvent(logger,'info','console.bot_updated',{botId:bot.id,revision:bot.desiredRevision});return publicBot(bot.id);
 });
 for(const action of ['start','stop','restart'] as const)app.post<{Params:{id:string}}>(`/api/bots/:id/${action}`,async(req,reply)=>{
  lifecycle.request(req.params.id,action);changes();void lifecycle.reconcile().then(()=>refreshGateway()).catch(()=>{});
  logEvent(logger,'info','console.lifecycle_requested',{botId:req.params.id,action});return reply.code(202).send({accepted:true});
 });
 app.get<{Params:{id:string};Querystring:{before?:string;limit?:string}}>('/api/bots/:id/conversation',async(req)=>db.getConversation(req.params.id,req.query.before?numeric(req.query.before,0):undefined,numeric(req.query.limit,100)));
 app.post<{Params:{id:string;runId:string}}>('/api/bots/:id/runs/:runId/cancel',async(req,reply)=>{
  const result=db.runControls.request(req.params.id,req.params.runId,object(req.body).requestId);
  changes();runControls.notify(req.params.id);return reply.code(202).send(result);
 });
 app.get<{Params:{id:string};Querystring:{after?:string;limit?:string}}>('/api/bots/:id/conversation/events',async(req)=>db.getConversationUpdate(req.params.id,numeric(req.query.after,0),numeric(req.query.limit,100)));
 app.get<{Params:{id:string};Querystring:{after?:string}}>('/api/bots/:id/conversation/stream',async(req,reply)=>{
  if(!db.getBot(req.params.id))return reply.code(404).send({error:'实例不存在'});
  const after=numeric(req.headers['last-event-id']??req.query.after,0);
  conversations.open(req,reply,req.params.id,after);
 });
 app.get<{Params:{id:string};Querystring:{path?:string}}>('/api/bots/:id/media',async(req,reply)=>{
  if(!db.getBot(req.params.id))return reply.code(404).send({error:'实例不存在'});
  const file=await options.docker.media(req.params.id,req.query.path??'');
  return reply.header('Content-Type',file.mime).header('Content-Disposition','inline').send(file.bytes);
 });
 app.get<{Params:{id:string;assetId:string}}>('/api/bots/:id/plugins/assets/:assetId',async(req,reply)=>{
   if(!db.getBot(req.params.id))return reply.code(404).send({error:'实例不存在'});
   const media=await db.pluginAssets.read(req.params.id,req.params.assetId,req.headers.range);
   reply.header('Content-Type',media.mimeType).header('Accept-Ranges','bytes').header('Content-Length',String(media.length));
   if(media.partial)reply.code(206).header('Content-Range',`bytes ${media.start}-${media.end}/${media.size}`);
   return req.method==='HEAD'?reply.send():reply.send(media.stream());
 });
 app.get<{Params:{id:string}}>('/api/bots/:id/tasks',async(req)=>db.tasks.list(req.params.id,true));
 app.post<{Params:{id:string}}>('/api/bots/:id/tasks/preview',async(req)=>db.tasks.preview(req.params.id,req.body));
 app.post<{Params:{id:string}}>('/api/bots/:id/tasks',async(req,reply)=>{
  const task=db.tasks.create(req.params.id,req.body);changes();
  logEvent(logger,'info','console.schedule.created',{botId:req.params.id,task_id:task.id,revision:task.revision});return reply.code(201).send(task);
 });
 app.put<{Params:{id:string;taskId:string}}>('/api/bots/:id/tasks/:taskId',async(req)=>{
  const {expectedRevision,...patch}=object(req.body);const task=db.tasks.update(req.params.id,req.params.taskId,expectedRevision,patch);changes();
  logEvent(logger,'info','console.schedule.updated',{botId:req.params.id,task_id:task.id,revision:task.revision});return task;
 });
 app.delete<{Params:{id:string;taskId:string}}>('/api/bots/:id/tasks/:taskId',async(req)=>{
  const task=db.tasks.delete(req.params.id,req.params.taskId,object(req.body).expectedRevision);changes();
  logEvent(logger,'info','console.schedule.deleted',{botId:req.params.id,task_id:task.id,revision:task.revision});return task;
 });
 app.get<{Params:{id:string;taskId:string}}>('/api/bots/:id/tasks/:taskId/runs',async(req)=>db.tasks.runs(req.params.id,req.params.taskId));
 app.get<{Params:{id:string;runId:string};Querystring:{after?:string}}>('/api/bots/:id/tasks/runs/:runId',async(req,reply)=>{
  const detail=db.tasks.detail(req.params.id,req.params.runId,req.query.after===undefined?undefined:numeric(req.query.after,0));return detail??reply.code(404).send({error:'任务执行记录不存在'});
 });
 for(const operation of ['run','reset-state'] as const)app.post<{Params:{id:string;taskId:string}}>(`/api/bots/:id/tasks/:taskId/${operation}`,async(req,reply)=>{
  const result=db.tasks.request(req.params.id,req.params.taskId,operation);changes();
  logEvent(logger,'info','console.schedule.control_requested',{botId:req.params.id,task_id:req.params.taskId,operation});return reply.code(202).send(result);
 });
 app.get<{Querystring:{from?:string;to?:string}}>('/api/metrics',async(req)=>{
  const from=numeric(req.query.from,Date.now()-3600000),to=numeric(req.query.to,Date.now());
  if(to<=from||to-from>31*86400000)throw new Error('时间范围须在 31 天以内');return {...metrics.query(from,to),resources:monitorResources()};
 });
 app.get<{Querystring:{from?:string;to?:string;at?:string;window?:string;botId?:string;resourceId?:string;traceId?:string}}>('/api/monitor/timeline',async(req)=>{
  const from=numeric(req.query.from,Date.now()-3600000),to=numeric(req.query.to,Date.now());
  if(to<=from||to-from>31*86400000)throw new Error('时间范围须在 31 天以内');
  for(const value of [req.query.botId,req.query.resourceId,req.query.traceId])if(value!==undefined&&!/^[a-zA-Z0-9_.:-]{1,240}$/u.test(value))throw new Error('请求监控标识无效');
  const windowMs=numeric(req.query.window,5000);if(windowMs<1000||windowMs>31*86400000)throw new Error('时间范围须在 31 天以内');
  projectActivities();return metrics.activities.query(from,to,{...req.query,windowMs,at:req.query.at===undefined?undefined:numeric(req.query.at,to)});
 });
 app.get<{Params:{id:string}}>('/api/bots/:id/memory',async(req)=>db.memory.view(req.params.id));
 app.post<{Params:{id:string}}>('/api/bots/:id/memory/controls',async(req,reply)=>{const result=db.memory.request(req.params.id,req.body);changes();return reply.code(202).send(result);});
 app.get('/api/stream',async(req,reply)=>{
  reply.hijack();const response=reply.raw;
  response.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no','X-Content-Type-Options':'nosniff'});
  const client={response,token:req.cookies.console_session};
  const initial=db.getEventCursor();response.write(`id: ${initial}\nevent: change\ndata: {"type":"connected","botIds":[]}\n\n`);streams.add(client);
  // A reconnect always invalidates the current view, which recovers missed changes without replaying sensitive data.
  const heartbeat=setInterval(()=>{if(!auth.valid(req.cookies.console_session)){response.end();return;}response.write(': heartbeat\n\n');},15000);heartbeat.unref();
  response.on('close',()=>{clearInterval(heartbeat);streams.delete(client);});
 });
 async function worker(req:FastifyRequest<{Params:{id:string}}>){
  const value=req.headers.authorization;if(!value?.startsWith('Bearer ')||!db.verifyWorkerToken(req.params.id,value.slice(7)))throw Object.assign(new Error('Worker 身份验证失败'),{statusCode:401});
 }
 const runner=(req:FastifyRequest)=>{const given=req.headers.authorization?.replace(/^Bearer /u,'')??'';if(given.length!==pluginRunnerToken.length||!timingSafeEqual(Buffer.from(given),Buffer.from(pluginRunnerToken)))throw Object.assign(new Error('插件运行器身份验证失败'),{statusCode:401});};
 const runnerObservations=(jobId:string,lease:string,input:unknown)=>{
  const {row}=db.plugins.leased(jobId,lease),body=object(input);
  if(!Array.isArray(body.events)||body.events.length>1000)throw new Error('请求监控事件无效');
  const owner={resourceId:'service:plugin-runner',botId:row.bot_id,traceId:`job:${row.root_job_id??row.id}`,jobId:row.id,pluginId:row.plugin_id,sourceMessageId:row.source_message_id,...(row.conversation_id?{conversationId:row.conversation_id}:{})};
  for(const event of body.events)metrics.activities.ingest(owner,event);
  metrics.activities.processSamples(owner,body.samples,body.dropped??0,body.source??'legacy');
 };
 app.post<{Params:{jobId:string}}>('/internal/plugin-runner/jobs/:jobId/observations',async(req)=>{
  runner(req);const body=object(req.body);runnerObservations(req.params.jobId,String(body.lease??''),body);return {ok:true};
 });
 app.post('/internal/plugin-runner/claim',async(req)=>{runner(req);const job=db.plugins.claim();projectActivities();return {job};});
 app.get<{Params:{jobId:string};Querystring:{lease?:string}}>('/internal/plugin-runner/jobs/:jobId/status',async(req)=>{runner(req);try{db.plugins.leased(req.params.jobId,req.query.lease??'');return {active:true};}catch{return {active:false};}});
 app.post<{Params:{jobId:string}}>('/internal/plugin-runner/jobs/:jobId/result',async(req)=>{
   runner(req);const body=object(req.body);
   if(body.observations)try{runnerObservations(req.params.jobId,String(body.lease??''),body.observations);}catch{logEvent(logger,'warn','console.plugin_observations_incomplete');}
   const result=db.plugins.complete(req.params.jobId,String(body.lease??''),object(body.result) as PluginRunnerResult);projectActivities();changes();return result;
 });
 app.post<{Params:{jobId:string}}>('/internal/plugin-runner/jobs/:jobId/asset',{bodyLimit:256*1024*1024,config:{rawBody:true}},async(req)=>{
   runner(req);const lease=String(req.headers['x-plugin-lease']??'');const {job}=db.plugins.leased(req.params.jobId,lease);
   if(job.operation!=='download'&&job.operation!=='prepare')throw new Error('插件作业不接受媒体上传');
   if(!req.body||typeof (req.body as Readable)[Symbol.asyncIterator]!=='function')throw new Error('插件媒体请求格式无效');
   const policy=contentPlugin(job.pluginId).policy(job.config);
   const key=req.headers['x-plugin-asset-key'],type=req.headers['x-plugin-asset-type']??'video',role=req.headers['x-plugin-asset-role']??(type==='image'?'content':'video');
   if(type!=='video'&&type!=='image'||typeof role!=='string'||!['video','content','live_preview','cover','avatar','emoji','presentation'].includes(role)||key!==undefined&&(typeof key!=='string'||!/^[A-Za-z0-9_-]{1,100}$/u.test(key))||job.operation==='prepare'&&(type!=='image'||key===undefined))throw new Error('插件媒体上传类型无效');
   const bot=db.getBot(job.botId)!;
   const maxBytes=type==='image'?Math.min(bot.config.imageMaxMiB*1024*1024,NAPCAT_MEDIA_MAX_BYTES):policy.maxAssetBytes;
   const assetId=await db.pluginAssets.upload(pluginAssetsRoot,job.botId,req.body as Readable,{maxBytes,cacheMaxBytes:policy.cacheMaxBytes,cacheHours:policy.cacheHours,type});
   db.plugins.attachAsset(req.params.jobId,lease,assetId,typeof key==='string'?key:'video',type,role);return {assetId};
 });
 app.get<{Params:{connectionId:string};Querystring:{expires?:string;signature?:string}}>('/internal/plugin-media-probe/:connectionId',async(req,reply)=>{
   if(!db.pluginAssets.verifyProbe(req.params.connectionId,req.query.expires,req.query.signature))return reply.code(403).send({error:'请求签名无效'});
   return reply.header('Content-Type','application/octet-stream').send(Buffer.from('NekoDock media origin probe\n'));
 });
 app.get<{Params:{botId:string;assetId:string};Querystring:{expires?:string;signature?:string}}>('/internal/plugin-media/:botId/:assetId',async(req,reply)=>{
   if(!db.pluginAssets.verify(req.params.botId,req.params.assetId,req.query.expires,req.query.signature))return reply.code(403).send({error:'请求签名无效'});
   const media=await db.pluginAssets.read(req.params.botId,req.params.assetId,req.headers.range);
   reply.header('Content-Type',media.mimeType).header('Accept-Ranges','bytes').header('Content-Length',String(media.length));
   if(media.partial)reply.code(206).header('Content-Range',`bytes ${media.start}-${media.end}/${media.size}`);
   return req.method==='HEAD'?reply.send():reply.send(media.stream());
 });
 app.get<{Params:{id:string}}>('/internal/workers/:id/plugins',async(req)=>{await worker(req);return db.plugins.snapshot(req.params.id);});
 app.get<{Params:{id:string;assetId:string}}>('/internal/workers/:id/plugins/assets/:assetId',async(req,reply)=>{
   await worker(req);const info=db.pluginAssets.info(req.params.id,req.params.assetId);
   if(!info||info.type!=='image')return reply.code(404).send({error:'插件图片不存在'});
   const bot=db.getBot(req.params.id)!;if(info.size>Math.min(bot.config.imageMaxMiB*1024*1024,NAPCAT_MEDIA_MAX_BYTES))return reply.code(413).send({error:'插件图片超过实例上限'});
   const media=await db.pluginAssets.read(req.params.id,req.params.assetId);
   return reply.header('Content-Type',media.mimeType).header('Content-Length',String(media.length)).header('X-Content-SHA256',info.sha256).send(media.stream());
 });
 app.post<{Params:{id:string}}>('/internal/workers/:id/plugins/sync',async(req)=>{await worker(req);const result=db.plugins.sync(req.params.id,req.body);changes();return result;});
 app.post<{Params:{id:string;resultId:string}}>('/internal/workers/:id/plugins/:resultId/cancel',async(req)=>{
   await worker(req);const reason=object(req.body).reason;if(reason!=='expired'&&reason!=='conversation_changed')throw new Error('插件取消原因无效');
   const result=db.plugins.cancel(req.params.id,req.params.resultId,reason==='expired'?'PLUGIN_SEND_EXPIRED':'PLUGIN_CONVERSATION_CHANGED');changes();return result;
 });
 app.post<{Params:{id:string;resultId:string}}>('/internal/workers/:id/plugins/:resultId/send',async(req)=>{
   await worker(req);const botId=req.params.id;let result=db.plugins.getResult(botId,req.params.resultId);if(!result)throw new Error('插件回复不存在');
   const previous=result.deliveryId?db.getNapcatDelivery(botId,result.deliveryId):null;
   if(previous&&isNapcatSendResult(previous.result)){db.plugins.finishSend(botId,result.id,previous.result);result=db.plugins.getResult(botId,result.id)!;}
   let delivery:NapcatSendResult;
   if(result.delivery)delivery=result.delivery.status==='acknowledged'?{ok:true,...(result.delivery.messageId?{messageId:result.delivery.messageId}:{})}:{ok:false,code:result.delivery.code??'PLUGIN_SEND_FAILED',deliveryStatus:result.delivery.status};
   else {
     result=db.plugins.authorizeSend(botId,result.id);const body=req.body===undefined?{}:object(req.body);
     if(body.conversationId!==undefined&&body.conversationId!==result.conversationId)throw new Error('插件回复所属会话不匹配');
     const bot=db.getBot(botId)!;
     try {
       const message=result.kind==='video'?{kind:'video' as const,file:db.pluginAssets.signedUrl(botId,result.assetId!,db.getNapcatConnection(bot.connectionId)?.mediaBaseUrl??'',(result.expiresAt??Date.now())+600_000)}
         :result.kind==='image'?{kind:'image' as const,file:await db.pluginAssets.imageSnapshot(botId,result.assetId!,Math.min(bot.config.imageMaxMiB*1024*1024,NAPCAT_MEDIA_MAX_BYTES))}
         :{kind:'text' as const,text:result.text??'',replyTo:result.sourceMessageId};
       const jobId=result.groupId??/^plugin:([a-f0-9-]{36}):/u.exec(result.deliveryId??'')?.[1],job=jobId?db.monitorPluginJob(botId,jobId):undefined;
       const deliveryId=result.deliveryId,kind=result.kind;
       delivery=await observeSend({resourceId:'service:console',botId,conversationId:result.conversationId,pluginId:result.pluginId,sourceMessageId:result.sourceMessageId,...(job?{jobId:job.id,traceId:`job:${job.rootJobId??job.id}`}:{})},()=>gateway.send(botId,{...message,deliveryId,deadline:Date.now()+(kind==='video'?120_000:bot.config.actionTimeout*1000)}));
     }catch{delivery={ok:false,code:'PLUGIN_MEDIA_OR_SEND_UNAVAILABLE',deliveryStatus:'failed'};}
     db.plugins.finishSend(botId,result.id,delivery);changes();
   }
   return {...delivery,...(result.replyTo===undefined?{}:{replyTo:result.replyTo}),...(result.text?{text:result.text}:{}),...(result.assetRole?{assetRole:result.assetRole}:{}),...(result.assetId?{asset:{...db.pluginAssets.info(botId,result.assetId),...(result.assetRole?{role:result.assetRole}:{})}}:{}),...(result.content?{content:result.content}:{})};
 });
 app.get<{Params:{id:string}}>('/internal/workers/:id/memory',async(req)=>{await worker(req);return db.memory.snapshot(req.params.id);});
 app.post<{Params:{id:string}}>('/internal/workers/:id/memory',async(req)=>{await worker(req);const result=db.memory.sync(req.params.id,req.body);changes();return result;});
 app.get<{Params:{id:string}}>('/internal/workers/:id/config',async(req)=>{await worker(req);return db.getWorkerSnapshot(req.params.id);});
 app.get<{Params:{id:string}}>('/internal/workers/:id/run-controls/stream',async(req,reply)=>{
  await worker(req);runControls.open(req.params.id,reply);
 });
 app.post<{Params:{id:string}}>('/internal/workers/:id/run-controls/ack',async(req)=>{
  await worker(req);db.runControls.acknowledge(req.params.id,req.body);changes();return {ok:true};
 });
 app.get<{Params:{id:string};Querystring:{after?:string}}>('/internal/workers/:id/incoming-images',async(req)=>{
  await worker(req);db.images.expire();const images=db.images.list(req.params.id,req.query.after);
  return {images,nextCursor:images.length===100?images.at(-1)!.id:null};
 });
 app.get<{Params:{id:string;attachmentId:string}}>('/internal/workers/:id/incoming-images/:attachmentId',async(req)=>{
  await worker(req);db.images.expire();return db.images.get(req.params.id,req.params.attachmentId);
 });
 app.get<{Params:{id:string;attachmentId:string}}>('/internal/workers/:id/incoming-images/:attachmentId/content',async(req,reply)=>{
  await worker(req);const image=await incomingImages.content(req.params.id,req.params.attachmentId);
  return reply.header('Content-Type',image.mimeType).header('Content-Disposition','inline').send(image.bytes);
 });
 app.post<{Params:{id:string;attachmentId:string}}>('/internal/workers/:id/incoming-images/:attachmentId/ack',async(req)=>{
  await worker(req);await incomingImages.acknowledge(req.params.id,req.params.attachmentId,object(req.body).sha256);return {ok:true};
 });
 app.get<{Params:{id:string};Querystring:{revision?:string}}>('/internal/workers/:id/network-probe',async(req)=>{
  await worker(req);const bot=db.getBot(req.params.id)!;
  if(lifecycle.effectiveState(bot)!=='running')return {probe:null};
  return {probe:networkProbes.claim(bot.id,numeric(req.query.revision,0))};
 });
 app.post<{Params:{id:string}}>('/internal/workers/:id/network-probe',async(req)=>{
  await worker(req);const accepted=networkProbes.complete(req.params.id,req.body);
  if(accepted)logEvent(logger,'info','console.network.probe_completed',{botId:req.params.id});
  return {accepted};
 });
 app.get<{Params:{id:string}}>('/internal/workers/:id/tasks',async(req)=>{await worker(req);return db.tasks.snapshot(req.params.id);});
 app.post<{Params:{id:string}}>('/internal/workers/:id/tasks/manage',async(req)=>{
  await worker(req);const body=object(req.body);const result=db.tasks.manage(req.params.id,body.operationId,body.request,body.actorId);changes();
  logEvent(logger,'info','console.schedule.managed',{botId:req.params.id,operation:String(object(body.request).operation)});return result;
 });
 app.post<{Params:{id:string}}>('/internal/workers/:id/tasks/authorize',async(req)=>{
  await worker(req);const body=object(req.body);const result=db.tasks.authorize(req.params.id,body.taskId,body.revision);
  return {authorized:result.authorized&&lifecycle.effectiveState(db.getBot(req.params.id)!)==='running'};
 });
 app.post<{Params:{id:string}}>('/internal/workers/:id/tasks/applied',async(req)=>{
  await worker(req);const result=db.tasks.applied(req.params.id,req.body);changes();return result;
 });
 app.get<{Params:{id:string}}>('/internal/workers/:id/napcat/events',async(req,reply)=>{await worker(req);gateway.openStream(req.params.id,req,reply);});
 app.get<{Params:{id:string;messageId:string}}>('/internal/workers/:id/napcat/forwards/:messageId',async(req)=>{
  await worker(req);const snapshot=db.forwards.get(req.params.id,req.params.messageId);
  return {snapshot,attachments:snapshot?db.images.forMessage(req.params.id,req.params.messageId):[]};
 });
 app.post<{Params:{id:string}}>('/internal/workers/:id/napcat/ack',async(req)=>{await worker(req);const seq=object(req.body).seq;
  if(!Number.isSafeInteger(seq))throw new Error('请求投递确认序号无效');gateway.acknowledge(req.params.id,seq as number);return {ok:true};
 });
 app.post<{Params:{id:string}}>('/internal/workers/:id/napcat/send',{bodyLimit:32*1024*1024},async(req)=>{await worker(req);return gateway.send(req.params.id,req.body);});
 app.post<{Params:{id:string}}>('/internal/workers/:id/napcat/validate-quotes',async(req)=>{await worker(req);return gateway.validateQuotes(req.params.id,req.body);});
 app.post<{Params:{id:string}}>('/internal/workers/:id/napcat/recall',async(req)=>{await worker(req);return gateway.recall(req.params.id,req.body);});
 app.post<{Params:{id:string}}>('/internal/workers/:id/heartbeat',async(req)=>{
  await worker(req);const acknowledgedSeq=db.ingestHeartbeat(req.params.id,req.body as WorkerHeartbeat);changes();
  if((req.body as WorkerHeartbeat).events.length)conversations.notify(req.params.id);
  const bot=db.getBot(req.params.id)!;return {desiredState:lifecycle.effectiveState(bot),desiredRevision:bot.desiredRevision,acknowledgedSeq};
 });
 app.post<{Params:{id:string}}>('/internal/workers/:id/events',async(req)=>{
  await worker(req);const body=object(req.body);const acknowledgedSeq=db.ingestEvents(req.params.id,body.events as WorkerHeartbeat['events']);
  changes();conversations.notify(req.params.id);return {acknowledgedSeq};
 });
 app.post<{Params:{id:string}}>('/internal/workers/:id/process-samples',async(req)=>{
  await worker(req);const body=object(req.body);metrics.activities.processSamples({botId:req.params.id,resourceId:req.params.id},body.samples,body.dropped??0,body.source??'legacy');return {ok:true};
 });
 const staticDir=options.staticDir??resolve('dist/web');
 if(existsSync(resolve(staticDir,'index.html'))){
  await app.register(staticFiles,{root:resolve(staticDir),wildcard:false});
  app.setNotFoundHandler((req,reply)=>req.url.startsWith('/api/')||req.url.startsWith('/internal/')||req.url.startsWith('/assets/')?reply.code(404).send({error:'接口不存在'}):reply.sendFile('index.html'));
 }
 const sample=async()=>{
  if(sampling)return;sampling=true;
  try{await Promise.allSettled(monitorResources().map(async(resource)=>{
   try{
    const shared=resource.kind==='worker'?null:await options.docker.serviceStats(resource.kind);
    const container=shared?.container??(resource.kind==='worker'?await options.docker.inspect(resource.id):null);
    if(!container?.State.Running){metrics.activities.interrupt(resource.id);throw new Error('unavailable');}
    const stats=shared?.stats??await options.docker.stats(resource.id),time=Date.now();
    if(generations.get(resource.id)!==container.Id){networkCounters.delete(resource.id);generations.set(resource.id,container.Id);}
    metrics.activities.resource(resource.id,container.Id,Date.parse(container.State.StartedAt??'')||time);
    const previous=networkCounters.get(resource.id)??{time,rx:null,tx:null,cpuNs:null};
    const {sample,counters}=resourceSample(resource.id,stats,previous,time);
    networkCounters.set(resource.id,counters);sample.latency=resource.botId?db.getLatencyP95(resource.botId,time-5*60000):null;metrics.insert(sample);
   }catch{networkCounters.delete(resource.id);metrics.insert({botId:resource.id,time:Date.now(),cpu:null,memory:null,rx:null,tx:null,latency:null});}
  }));projectActivities();}finally{sampling=false;}
 };
 if(options.timers!==false){
  const every=(ms:number,fn:()=>void)=>{const timer=setInterval(fn,ms);timer.unref();timers.push(timer);};
  every(2000,()=>void lifecycle.reconcile().then(()=>refreshGateway()).catch(()=>logEvent(logger,'warn','console.reconcile_failed')));
  every(5000,()=>void sample());every(1000,projectActivities);every(3600000,()=>{try{metrics.compact();}catch{logEvent(logger,'warn','console.metrics_compact_failed');}});
  every(60000,()=>{void db.pluginAssets.cleanup(pluginAssetsRoot).catch(()=>logEvent(logger,'warn','plugin.assets.cleanup_failed'));});
 }
 app.addHook('preClose',async()=>{for(const timer of timers)clearInterval(timer);logs.close();conversations.close();runControls.close();for(const stream of streams)stream.response.end();await inspections.close();await gateway.close();await incomingImages.close();});
 app.addHook('onClose',async()=>{for(const timer of timers)clearInterval(timer);for(const stream of streams)stream.response.end();db.close();metrics.close();});
 return {app,db,metrics,auth,lifecycle,gateway,sample,incomingImages,inspections};
}
