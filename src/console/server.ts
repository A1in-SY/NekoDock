import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ServerResponse } from 'node:http';
import { ConsoleDatabase } from './database.js';
import { MetricsDatabase, resourceSample, type ResourceCounters } from './metrics.js';
import { ConsoleAuth } from './auth.js';
import { DockerClient } from './docker.js';
import { Lifecycle } from './lifecycle.js';
import { defaultSettings } from './settings.js';
import type { WorkerHeartbeat } from './contracts.js';
import { createLogger, logEvent } from '../logging.js';
import { LogStreams } from './logs.js';
import { ConversationStreams } from './conversation-streams.js';

export interface ConsoleOptions {
 dataDir:string; docker:DockerClient; staticDir?:string; timers?:boolean; logPollMs?:number; conversationHeartbeatMs?:number;
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
 const auth=new ConsoleAuth(db);const lifecycle=new Lifecycle(db,options.docker);const logger=createLogger();
 const logs=new LogStreams(db,auth,options.docker,options.logPollMs);
 const conversations=new ConversationStreams(db,auth,options.conversationHeartbeatMs);
 const app=Fastify({logger:false,bodyLimit:4*1024*1024,requestTimeout:30000});
 await app.register(cookie);
 const streams=new Set<{response:ServerResponse;token:unknown}>();const timers:NodeJS.Timeout[]=[];
 let lastCursor=db.getEventCursor();let sampling=false;
 const networkCounters=new Map<string,ResourceCounters>();
 const changes=()=>{
  const cursor=db.getEventCursor();if(cursor===lastCursor)return;
  const botIds=new Set<string>();
  while(lastCursor<cursor){const batch=db.listChanges(lastCursor,1000);if(!batch.length)break;
   for(const change of batch)if(change.type!=='conversation.event')botIds.add(change.botId);
   lastCursor=batch.at(-1)!.seq;
  }
  if(!botIds.size)return;
  const chunk=`id: ${cursor}\nevent: change\ndata: ${JSON.stringify({type:'change',botIds:[...botIds]})}\n\n`;
  for(const client of streams){const stream=client.response;if(!auth.valid(client.token)){stream.end();streams.delete(client);}else if(stream.destroyed||stream.writableLength>256*1024){stream.destroy();streams.delete(client);}else stream.write(chunk);}
 };
 app.setErrorHandler((error,_req,reply)=>{
  // Validation errors are deliberately written by our validators; never serialize request bodies or credentials.
  const message=error instanceof Error?error.message:'';
  const safe=/^(?:配置|实例|群聊|私聊|相同|同一|数据卷|管理员|密码|请求|会话|时间|分页|模型|自定义|人格|未知配置|运行|Worker|生效|控制台|[a-zA-Z]+(?:[A-Z][a-z]+)* (?:必须|类型|内容|无效))/u.test(message)&&message.length<300;
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
 app.get('/api/defaults',async()=>defaultSettings());
 app.get('/api/bots',async()=>db.listPublicBots());
 app.get('/api/logs/stream',async(req,reply)=>logs.open(req,reply));
 app.get<{Params:{id:string}}>('/api/bots/:id/logs/stream',async(req,reply)=>{
  if(!db.getBot(req.params.id))return reply.code(404).send({error:'实例不存在'});
  logs.open(req,reply,req.params.id);
 });
 app.post('/api/bots',async(req,reply)=>{
  const body=object(req.body);const base=body.copyFrom?db.getBot(String(body.copyFrom)):null;
  if(body.copyFrom&&!base)throw new Error('实例不存在');
  const bot=db.createBot({name:body.name as string,description:body.description as string|undefined,targetType:body.targetType as 'group'|'private',targetId:body.targetId as string,
   config:{...(base?.config??defaultSettings()),...object(body.config??{})}});
  changes();logEvent(logger,'info','console.bot_created',{botId:bot.id});return reply.code(201).send(db.getPublicBot(bot.id));
 });
 app.put<{Params:{id:string}}>('/api/bots/:id',async(req)=>{
  const body=object(req.body);if(!Number.isSafeInteger(body.expectedRevision))throw new Error('配置版本无效，请刷新后重试');
  const bot=db.updateBot(req.params.id,{name:body.name as string|undefined,description:body.description as string|undefined,config:body.config,
   expectedRevision:body.expectedRevision as number,targetType:body.targetType as string|undefined,targetId:body.targetId as string|undefined});
  changes();logEvent(logger,'info','console.bot_updated',{botId:bot.id,revision:bot.desiredRevision});return db.getPublicBot(bot.id);
 });
 for(const action of ['start','stop','restart'] as const)app.post<{Params:{id:string}}>(`/api/bots/:id/${action}`,async(req,reply)=>{
  lifecycle.request(req.params.id,action);changes();void lifecycle.reconcile().then(changes).catch(()=>{});
  logEvent(logger,'info','console.lifecycle_requested',{botId:req.params.id,action});return reply.code(202).send({accepted:true});
 });
 app.get<{Params:{id:string};Querystring:{before?:string;limit?:string}}>('/api/bots/:id/conversation',async(req)=>db.getConversation(req.params.id,req.query.before?numeric(req.query.before,0):undefined,numeric(req.query.limit,100)));
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
 app.get<{Querystring:{from?:string;to?:string}}>('/api/metrics',async(req)=>{
  const from=numeric(req.query.from,Date.now()-3600000),to=numeric(req.query.to,Date.now());
  if(to<=from||to-from>31*86400000)throw new Error('时间范围须在 31 天以内');return metrics.query(from,to);
 });
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
 app.get<{Params:{id:string}}>('/internal/workers/:id/config',async(req)=>{await worker(req);return db.getWorkerSnapshot(req.params.id);});
 app.post<{Params:{id:string}}>('/internal/workers/:id/heartbeat',async(req)=>{
  await worker(req);const acknowledgedSeq=db.ingestHeartbeat(req.params.id,req.body as WorkerHeartbeat);changes();
  if((req.body as WorkerHeartbeat).events.length)conversations.notify(req.params.id);
  const bot=db.getBot(req.params.id)!;return {desiredState:lifecycle.effectiveState(bot),desiredRevision:bot.desiredRevision,acknowledgedSeq};
 });
 app.post<{Params:{id:string}}>('/internal/workers/:id/events',async(req)=>{
  await worker(req);const body=object(req.body);const acknowledgedSeq=db.ingestEvents(req.params.id,body.events as WorkerHeartbeat['events']);
  changes();conversations.notify(req.params.id);return {acknowledgedSeq};
 });
 const staticDir=options.staticDir??resolve('dist/web');
 if(existsSync(resolve(staticDir,'index.html'))){
  await app.register(staticFiles,{root:resolve(staticDir),wildcard:false});
  app.setNotFoundHandler((req,reply)=>req.url.startsWith('/api/')||req.url.startsWith('/internal/')||req.url.startsWith('/assets/')?reply.code(404).send({error:'接口不存在'}):reply.sendFile('index.html'));
 }
 const sample=async()=>{
  if(sampling)return;sampling=true;
  try{await Promise.allSettled(db.listBots().map(async(bot)=>{
   const time=Date.now();try{
    const container=await options.docker.inspect(bot.id);
    if(!container?.State.Running)throw new Error('unavailable');
    const {sample,counters}=resourceSample(bot.id,await options.docker.stats(bot.id),networkCounters.get(bot.id),time);
    networkCounters.set(bot.id,counters);sample.latency=db.getLatencyP95(bot.id,time-5*60000);metrics.insert(sample);
   }catch{networkCounters.delete(bot.id);metrics.insert({botId:bot.id,time,cpu:null,memory:null,rx:null,tx:null,latency:null});}
  }));}finally{sampling=false;}
 };
 if(options.timers!==false){
  const every=(ms:number,fn:()=>void)=>{const timer=setInterval(fn,ms);timer.unref();timers.push(timer);};
  every(2000,()=>void lifecycle.reconcile().then(changes).catch(()=>logEvent(logger,'warn','console.reconcile_failed')));
  every(15000,()=>void sample());every(3600000,()=>{try{metrics.compact();}catch{logEvent(logger,'warn','console.metrics_compact_failed');}});
 }
 app.addHook('preClose',async()=>{logs.close();conversations.close();for(const stream of streams)stream.response.end();});
 app.addHook('onClose',async()=>{for(const timer of timers)clearInterval(timer);for(const stream of streams)stream.response.end();db.close();metrics.close();});
 return {app,db,metrics,auth,lifecycle,sample};
}
