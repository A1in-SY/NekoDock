import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readFile,readdir,rm,stat,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createNetworkClient,proxyEnvironment} from '../../network.js';
import {normalizeBilibiliResource} from './recognize.js';
import { BilibiliError, bilibiliError as errorCode } from './errors.js';
import { resolveDynamic } from './dynamic.js';
import { resolveLive } from './live.js';
import { preparePresentation } from './presentation.js';
import { prepareVideoAuthor } from './video-author.js';
import { id, imageUrl } from './api.js';
export { BilibiliError } from './errors.js';
import type { PluginContent, PluginExecution, PluginRunnerJob, PluginRunnerDefinition } from '../../plugin-system/contracts.js';
import { validateBilibiliConfig } from './config.js';
import type { BilibiliConfig, BilibiliResource } from './types.js';
type BilibiliJob = Omit<PluginRunnerJob,'config'|'resource'> & {config:BilibiliConfig;resource:BilibiliResource};

export type BilibiliExecution = PluginExecution;
export interface BilibiliTools {fetch?:typeof globalThis.fetch;run?:(command:string,args:string[],options:{cwd:string;env:NodeJS.ProcessEnv;signal:AbortSignal;timeoutMs:number})=>Promise<string>;}
const silent={info(){},warn(){},error(){}};
const object=(v:unknown):Record<string,any>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:{};
async function boundedText(response:Response,max=4*1024*1024):Promise<string> {
  if(!response.ok)throw new BilibiliError(response.status===412?'BILIBILI_HTTP_412':response.status===401||response.status===403?'BILIBILI_LOGIN_REQUIRED':'BILIBILI_NETWORK_FAILED',response.status===429||response.status>=500);
  const reader=response.body?.getReader();if(!reader)throw new BilibiliError('BILIBILI_FETCH_FAILED');let size=0;const chunks:Buffer[]=[];
  try {while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>max)throw new BilibiliError('BILIBILI_RESPONSE_TOO_LARGE');chunks.push(Buffer.from(chunk.value));}return Buffer.concat(chunks).toString('utf8');}
  finally {await reader.cancel().catch(()=>{});}
}
export function parseSubtitle(value:string,extension:string):Array<{start:number;end:number;text:string}> {
  if(extension==='json'||extension==='json3') {
    const body=JSON.parse(value);
    return Array.isArray(body.body)?body.body.map((line:any)=>({start:Number(line.from),end:Number(line.to),text:typeof line.content==='string'?line.content:''})):Array.isArray(body.events)?body.events.map((line:any)=>({start:Number(line.tStartMs)/1000,end:(Number(line.tStartMs)+Number(line.dDurationMs))/1000,text:Array.isArray(line.segs)?line.segs.map((s:any)=>s.utf8??'').join(''):''})):[];
  }
  if(extension!=='srt'&&extension!=='vtt')return [];
  const time=(text:string)=>{const parts=text.replace(',','.').split(':').map(Number);return parts.reduce((total,p)=>total*60+p,0);};
  return value.replaceAll('\r','').split(/\n\s*\n/u).flatMap(block=>{
    const lines=block.split('\n'),index=lines.findIndex(line=>line.includes('-->'));if(index<0)return [];
    const m=/((?:\d{1,3}:)?\d{2}:\d{2}[.,]\d{3})\s*-->\s*((?:\d{1,3}:)?\d{2}:\d{2}[.,]\d{3})/u.exec(lines[index]!);if(!m)return [];
    return [{start:time(m[1]!),end:time(m[2]!),text:lines.slice(index+1).join('\n').replace(/<[^>]*>/gu,'').trim()}];
  });
}
export async function resolveBilibiliUrl(input:string,fetcher:typeof globalThis.fetch,signal:AbortSignal):Promise<string> {
  let resource=normalizeBilibiliResource(input);if(!resource)throw new BilibiliError('BILIBILI_INVALID_URL');
  for(let i=0;i<5;i++) {
    if(!resource.id.startsWith('short:'))return resource.url;
    const response=await fetcher(resource.url,{method:'GET',redirect:'manual',signal,headers:{'user-agent':'Mozilla/5.0'}});
    await response.body?.cancel();
    if(response.status===412)throw new BilibiliError('BILIBILI_HTTP_412');
    if(response.status<300||response.status>=400)throw new BilibiliError('BILIBILI_SHORT_LINK_FAILED');
    const location=response.headers.get('location');if(!location)throw new BilibiliError('BILIBILI_SHORT_LINK_FAILED');
    const next=normalizeBilibiliResource(new URL(location,resource.url).toString());if(!next)throw new BilibiliError('BILIBILI_REDIRECT_REJECTED');resource=next;
  }
  throw new BilibiliError('BILIBILI_REDIRECT_LIMIT');
}
function childEnvironment(job:BilibiliJob,directory:string):NodeJS.ProcessEnv {
  const env:NodeJS.ProcessEnv={HOME:directory,TMPDIR:directory};
  for(const key of ['PATH','LANG','LC_ALL','SSL_CERT_FILE','SSL_CERT_DIR','NODE_EXTRA_CA_CERTS'])if(process.env[key]!==undefined)env[key]=process.env[key];
  return proxyEnvironment(job.networkProxy,env);
}
export function monitorDownloadBudget(directory:string,maxBytes:number,controller:AbortController,intervalMs=50) {
  let checking:Promise<void>|undefined,exceeded=false,stopped=false;
  const check=()=>{
    if(checking)return checking;
    checking=(async()=>{
      let sourceBytes=0,finalBytes=0,physicalBytes=0;
      for(const entry of await readdir(directory,{withFileTypes:true})) {
        if(!entry.isFile()||!entry.name.startsWith('video'))continue;
        let size:number;try{size=(await stat(join(directory,entry.name))).size;}catch{continue;}
        physicalBytes+=size;
        if(entry.name==='video.mp4'||entry.name.includes('.temp.'))finalBytes+=size;
        else sourceBytes+=size;
      }
      // During remux, source tracks and their output coexist; count each logical
      // copy separately rather than charging the same content twice.
      if(sourceBytes>maxBytes||finalBytes>maxBytes||physicalBytes>maxBytes*2+1024*1024){exceeded=true;controller.abort();}
    })().catch(()=>{if(!stopped)controller.abort();}).finally(()=>{checking=undefined;});return checking;
  };
  const timer=setInterval(()=>void check(),intervalMs);timer.unref();
  return {check,exceeded:()=>exceeded,stop:async()=>{stopped=true;clearInterval(timer);await checking;}};
}
async function run(command:string,args:string[],options:{cwd:string;env:NodeJS.ProcessEnv;signal:AbortSignal;timeoutMs:number}):Promise<string> {
  options.signal.throwIfAborted();
  return await new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd:options.cwd,env:options.env,stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32'});
    const output:Buffer[]=[],errors:Buffer[]=[];let bytes=0,errorBytes=0,ended=false,timedOut=false;
    const kill=()=>{if(child.pid)try{process.platform==='win32'?child.kill('SIGKILL'):process.kill(-child.pid,'SIGKILL');}catch{}};
    const timer=setTimeout(()=>{timedOut=true;kill();},options.timeoutMs);
    const abort=()=>kill();options.signal.addEventListener('abort',abort,{once:true});
    child.stdout.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>8*1024*1024)kill();else output.push(chunk);});
    child.stderr.on('data',(chunk:Buffer)=>{errorBytes+=chunk.length;if(errorBytes<65536)errors.push(chunk);});
    const finish=()=>{if(ended)return;ended=true;clearTimeout(timer);options.signal.removeEventListener('abort',abort);};
    child.once('error',error=>{finish();reject(error);});
    child.once('close',code=>{finish();const stderr=Buffer.concat(errors).toString('utf8');if(options.signal.aborted)reject(new BilibiliError('PLUGIN_CANCELLED'));else if(timedOut)reject(new BilibiliError('BILIBILI_TIMEOUT',true));else if(bytes>8*1024*1024)reject(new BilibiliError('BILIBILI_RESPONSE_TOO_LARGE'));else if(code!==0)reject(errorCode(stderr));else {let text=Buffer.concat(output).toString('utf8');if(command==='yt-dlp'&&args.includes('--dump-single-json')&&/Subtitles are only available when logged in/iu.test(stderr))try{text=JSON.stringify({...JSON.parse(text),_nekodock_subtitle_login_required:true});}catch{}resolve(text);}});
  });
}
export async function executeBilibiliJob(input:PluginRunnerJob,root:string,signal:AbortSignal,tools:BilibiliTools={}):Promise<BilibiliExecution> {
  const safe=normalizeBilibiliResource(input.resource.url);if(!safe||safe.kind!==input.resource.kind)throw new BilibiliError('BILIBILI_INVALID_URL');
  const job:BilibiliJob={...input,config:validateBilibiliConfig(input.config),resource:{...safe,...(safe.kind==='video'?{part:input.resource.part??safe.part??1}:{})}};
  await mkdir(root,{recursive:true,mode:0o700});const directory=await mkdtemp(join(root,'job-'));
  const cleanup=()=>rm(directory,{recursive:true,force:true});
  const network=createNetworkClient(job.networkProxy,silent,'plugins');const fetcher=tools.fetch??network.fetch,execute=tools.run??run;
  const timeout=AbortSignal.timeout(job.config.timeoutSeconds*1000),combined=AbortSignal.any([signal,timeout]);
  const env=childEnvironment(job,directory);
  const args=['--ignore-config','--no-cache-dir','--no-playlist','--no-progress','--socket-timeout','15','--retries','0','--fragment-retries','0'];
  if(job.config.cookie) {
    const path=join(directory,'cookies.txt');
    const cookies=job.config.cookie.split(';').map(value=>value.trim()).filter(Boolean).map(pair=>{const n=pair.indexOf('=');if(n<1)return '';return `.bilibili.com\tTRUE\t/\tTRUE\t0\t${pair.slice(0,n)}\t${pair.slice(n+1)}`;}).filter(Boolean);
    await writeFile(path,'# Netscape HTTP Cookie File\n'+cookies.join('\n')+'\n',{mode:0o600});args.push('--cookies',path);
  }
  try {
    const url=await resolveBilibiliUrl(safe.url,fetcher,combined);
    const resource=normalizeBilibiliResource(url)!;
    if(job.command==='share'&&job.operation==='resolve'&&(
      resource.kind==='video'&&!job.config.enhance&&!job.config.autoVideo&&job.config.videoDisplay==='off'||
      resource.kind==='post'&&!job.config.dynamicEnhance&&job.config.dynamicDisplay==='off'||
      resource.kind==='live'&&!job.config.liveEnhance&&job.config.liveDisplay==='off')) {
      const content:PluginContent={type:resource.kind as 'video'|'post'|'live',platform:'bilibili',resourceId:resource.id,url:resource.url,
        title:resource.title??'哔哩哔哩分享',...(resource.part?{part:resource.part}:{}),retrieval:{status:'ready'}};
      await network.close();return {content,cleanup};
    }
    if(job.operation==='prepare') {
      const content=resource.kind==='video'&&job.presentation?.mode==='card'&&job.content
        ?await prepareVideoAuthor(job.content,resource,fetcher,combined,job.config.cookie):job.content;
      const prepared=await preparePresentation({...job,resource,content},directory,fetcher,execute,env,combined);await network.close();return {...prepared,cleanup};
    }
    if(resource.kind!=='video') {
      if(job.operation!=='resolve'||resource.kind==='short')throw new BilibiliError('BILIBILI_OPERATION_UNSUPPORTED');
      const content=resource.kind==='post'?await resolveDynamic(resource,fetcher,combined,job.config.cookie):await resolveLive(resource,fetcher,combined,job.config.cookie);
      await network.close();return {content,cleanup};
    }
    if(job.operation==='resolve') {
      const raw=await execute('yt-dlp',[...args,'--skip-download',...(job.config.subtitles?['--write-subs','--sub-langs','zh.*,ai-zh.*,en.*','--sub-format','srt']:[]),'--dump-single-json','--',url],{cwd:directory,env,signal:combined,timeoutMs:job.config.timeoutSeconds*1000});
      const info=object(JSON.parse(raw));const extracted=normalizeBilibiliResource(typeof info.webpage_url==='string'?info.webpage_url:url)??resource;
      const videoUrl=new URL(extracted.url);videoUrl.searchParams.set('p',String(resource.part??1));
      const normalized=normalizeBilibiliResource(videoUrl.toString())!;
      const content:PluginContent={type:'video',platform:'bilibili',resourceId:normalized.id,url:normalized.url,title:typeof info.title==='string'?info.title:job.resource.title??'哔哩哔哩视频',part:resource.part,retrieval:{status:'ready'}};
      if(typeof info.uploader==='string')content.author=info.uploader;
      const authorId=id(info.uploader_id);if(authorId)content.authorId=authorId;
      if(typeof info.description==='string')content.description=info.description.slice(0,12000);
      if(typeof info.duration==='number'&&Number.isFinite(info.duration))content.durationSeconds=info.duration;
      if(typeof info.timestamp==='number')content.publishedAt=info.timestamp;
      const cover=imageUrl(info.thumbnail);
      if(cover){content.coverUrl=cover;content.blocks=[{type:'image',image:{id:`${content.resourceId}:cover`,url:cover,role:'cover',status:'pending'}}];}
      if(job.config.subtitles) {
        const subtitles=object(info.subtitles);const languages=Object.keys(subtitles).filter(key=>key!=='danmaku');const language=languages.find(key=>/^zh|^ai-zh/u.test(key))??languages[0];
        const variants=language&&Array.isArray(subtitles[language])?subtitles[language] as Array<Record<string,unknown>>:[];
        const sub=variants.find(s=>s.ext==='json'||s.ext==='json3')??variants[0];
        if(sub&&(typeof sub.url==='string'||typeof sub.data==='string')) {
          try {
            let data=typeof sub.data==='string'?sub.data:undefined;
            if(data===undefined) {
              const subtitleUrl=new URL(String(sub.url));if(subtitleUrl.protocol!=='https:'||!/(?:^|\.)(?:bilibili\.com|hdslb\.com)$/u.test(subtitleUrl.hostname))throw new BilibiliError('BILIBILI_SUBTITLE_URL_REJECTED');
              data=await boundedText(await fetcher(subtitleUrl,{signal:combined,redirect:'error'}));
            }
            const rows=parseSubtitle(data,String(sub.ext??'json'));
            const segments:Array<{start:number;end:number;text:string}>=[];let chars=0;
            for(const row of rows){if(!Number.isFinite(row.start)||!Number.isFinite(row.end)||row.start<0||row.end<row.start||!row.text)continue;if(chars+row.text.length>12000||segments.length>=1000)break;segments.push(row);chars+=row.text.length;}
            const text=segments.map(s=>s.text).join('\n').trim();content.subtitle=text?{status:'ready',language,text,segments,automatic:language?.startsWith('ai-')??false,...(segments.length<rows.length?{truncated:true}:{})}:{status:'absent'};
          }catch(error){const code=errorCode(error);content.subtitle={status:code.code==='BILIBILI_LOGIN_REQUIRED'?'login_required':'failed'};}
        } else content.subtitle={status:info._nekodock_subtitle_login_required===true?'login_required':'absent'};
      }
      await network.close();return {content,cleanup};
    }
    if(job.content?.durationSeconds===undefined||job.content.durationSeconds>job.config.maxDurationSeconds)throw new BilibiliError('BILIBILI_DURATION_LIMIT');
    const path=join(directory,'video.mp4');
    const maxBytes=job.config.maxMiB*1024*1024;
    const format=`bestvideo[height<=${job.config.maxHeight}][vcodec^=avc1][ext=mp4]+bestaudio[acodec^=mp4a][ext=m4a]/best[height<=${job.config.maxHeight}][ext=mp4][vcodec^=avc1]`;
    const sizeController=new AbortController(),downloadSignal=AbortSignal.any([combined,sizeController.signal]);
    const budget=monitorDownloadBudget(directory,maxBytes,sizeController);
    try {
      await execute('yt-dlp',[...args,'--max-filesize',String(maxBytes),'--format',format,'--merge-output-format','mp4','--output',path,'--',url],{cwd:directory,env,signal:downloadSignal,timeoutMs:job.config.timeoutSeconds*1000});
      await budget.check();if(budget.exceeded())throw new BilibiliError('BILIBILI_MEDIA_TOO_LARGE');downloadSignal.throwIfAborted();
    }catch(error){if(budget.exceeded())throw new BilibiliError('BILIBILI_MEDIA_TOO_LARGE');throw error;}
    finally {await budget.stop();}
    const file=await stat(path);if(!file.isFile()||file.size>maxBytes||file.size<12)throw new BilibiliError('BILIBILI_MEDIA_TOO_LARGE');
    const probe=object(JSON.parse(await execute('ffprobe',['-v','error','-show_format','-show_streams','-of','json',path],{cwd:directory,env,signal:combined,timeoutMs:15000})));
    const duration=Number(probe.format?.duration);if(!Number.isFinite(duration)||duration<=0||duration>job.config.maxDurationSeconds)throw new BilibiliError('BILIBILI_DURATION_LIMIT');
    const streams=Array.isArray(probe.streams)?probe.streams:[];const video=streams.find(s=>s.codec_type==='video');
    if(!video||video.codec_name!=='h264'||Number(video.height)>job.config.maxHeight||streams.some(s=>s.codec_type==='audio'&&s.codec_name!=='aac'))throw new BilibiliError('BILIBILI_MEDIA_FORMAT_UNSUPPORTED');
    await network.close();return {file:path,cleanup};
  }catch(error){await network.close();await cleanup();throw errorCode(error);}
}

export const runnerDefinition: PluginRunnerDefinition = { execute: executeBilibiliJob };
