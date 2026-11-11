import { writeFile, readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { imageExtension } from '../../images.js';
import { renderLimited } from '../../plugin-render.js';
import type { PluginContent, PluginContentImage, PluginExecution, PluginOutput, PluginRunnerJob } from '../../plugin-system/contracts.js';
import { boundedBytes, imageUrl } from './api.js';
import { contentText, validatePluginContent } from './content.js';
import { BilibiliError } from './errors.js';
import type { BilibiliConfig, BilibiliResource } from './types.js';

export const BILIBILI_IMAGE_LIMITS = { sourceImages:4, assets:16, perImageBytes:10*1024*1024,totalBytes:32*1024*1024,maxPixels:24_000_000,pages:3 } as const;
export type BilibiliRun=(command:string,args:string[],options:{cwd:string;env:NodeJS.ProcessEnv;signal:AbortSignal;timeoutMs:number})=>Promise<string>;
interface Target {image:PluginContentImage;references:Array<Record<string,any>>;}
function allTargets(content:PluginContent,decorations:boolean):Target[] {
  const targets:Target[]=[];
  const visit=(c:PluginContent)=>{
    if(decorations&&c.authorAvatar)targets.push({image:c.authorAvatar,references:[c.authorAvatar]});
    for(const block of c.blocks??[]) {
      if(block.type==='image')targets.push({image:block.image,references:[block.image]});
      if(decorations&&block.type==='paragraph')for(const [i,span] of (block.spans??[]).entries())if(span.type==='emoji'&&span.url){const image:PluginContentImage={id:`${c.resourceId}:emoji:${targets.length}:${i}`,url:span.url,role:'emoji'};targets.push({image,references:[span]});}
    }
    if(c.live?.preview)targets.push({image:c.live.preview,references:[c.live.preview]});
    if(c.live?.cover)targets.push({image:c.live.cover,references:[c.live.cover]});
    if(c.original)visit(c.original);
  };visit(content);return targets;
}
function sourceTargets(content:PluginContent):PluginContentImage[] {
  if(content.type==='live')return [content.live?.preview?.status==='ready'?content.live.preview:content.live?.cover].filter((v):v is PluginContentImage=>!!v&&v.status==='ready');
  const images=(content.blocks??[]).flatMap(b=>b.type==='image'?[b.image]:[]);
  if(content.original)images.push(...sourceTargets(content.original));
  return images.filter(image=>image.status==='ready');
}
async function rendererPath():Promise<string>{
  const deployed=fileURLToPath(new URL('./render/card.py',import.meta.url));
  try{await stat(deployed);return deployed;}catch{return fileURLToPath(new URL('../../../../src/plugins/bilibili/render/card.py',import.meta.url));}
}

export async function preparePresentation(job:PluginRunnerJob&{config:BilibiliConfig;resource:BilibiliResource},directory:string,fetcher:typeof globalThis.fetch,execute:BilibiliRun,env:NodeJS.ProcessEnv,signal:AbortSignal):Promise<Omit<PluginExecution,'cleanup'>> {
  if(!job.content||!job.presentation)throw new BilibiliError('BILIBILI_PRESENTATION_INVALID');
  const content=validatePluginContent(structuredClone(job.content),job.resource),mode=job.presentation.mode;
  const files:NonNullable<PluginExecution['files']>=[],paths:Record<string,string>={};
  const priority={content:0,live_preview:0,cover:1,avatar:2,emoji:3};
  const script=await rendererPath(),targets=allTargets(content,mode==='card').sort((a,b)=>priority[a.image.role]-priority[b.image.role]);
  const seen=new Map<string,{key:string;image:PluginContentImage}>();let total=0,sourceCount=0,attempts=0,failed=false;
  for(const target of targets) {
    signal.throwIfAborted();const image=target.image;
    if(mode==='none'&&(image.role==='cover'||image.role==='avatar'||image.role==='emoji'))continue;
    const duplicate=seen.get(`${image.role}\n${image.url}`);
    if(duplicate){for(const ref of target.references)Object.assign(ref,{assetKey:duplicate.key,status:'ready',width:duplicate.image.width,height:duplicate.image.height,fetchedAt:duplicate.image.fetchedAt,...(duplicate.image.imageLastModified?{imageLastModified:duplicate.image.imageLastModified}:{})});continue;}
    const source=image.role==='content'||image.role==='live_preview';
    if(attempts>=BILIBILI_IMAGE_LIMITS.assets-(mode==='card'?BILIBILI_IMAGE_LIMITS.pages:0)||source&&sourceCount>=BILIBILI_IMAGE_LIMITS.sourceImages){for(const ref of target.references)if('role'in ref)Object.assign(ref,{status:'failed',error:'BILIBILI_IMAGE_LIMIT'});failed=true;continue;}
    attempts++;
    if(source)sourceCount++;
    try {
      const url=imageUrl(image.url);if(!url)throw new BilibiliError('BILIBILI_IMAGE_URL_REJECTED');
      const response=await fetcher(url,{signal,redirect:'error',headers:{'user-agent':'Mozilla/5.0',referer:content.type==='live'?'https://live.bilibili.com/':'https://www.bilibili.com/'}});
      const modified=response.headers.get('last-modified');
      const bytes=await boundedBytes(response,Math.min(BILIBILI_IMAGE_LIMITS.perImageBytes,job.config.maxMiB*1024*1024,job.imageMaxBytes??Infinity));
      total+=bytes.length;if(total>BILIBILI_IMAGE_LIMITS.totalBytes)throw new BilibiliError('BILIBILI_IMAGE_LIMIT');
      const extension=imageExtension(bytes),key=`source-${files.length}`,path=join(directory,`${key}.${extension}`);
      await writeFile(path,bytes,{mode:0o600});
      const inspected=JSON.parse(await execute('python3',[script,'inspect',path,String(BILIBILI_IMAGE_LIMITS.maxPixels)],{cwd:directory,env,signal,timeoutMs:15000})) as {width:number;height:number};
      const fetchedAt=Date.now()/1000;
      for(const ref of target.references)Object.assign(ref,{assetKey:key,...('role'in ref?{status:'ready',width:inspected.width,height:inspected.height,fetchedAt,...(modified&&Number.isFinite(Date.parse(modified))?{imageLastModified:modified}:{})}:{})});
      image.fetchedAt=fetchedAt;seen.set(`${image.role}\n${url}`,{key,image});paths[key]=path;files.push({key,path,type:'image',role:image.role});
    }catch(error){signal.throwIfAborted();failed=true;for(const ref of target.references)if('role'in ref)Object.assign(ref,{status:'failed',error:error instanceof BilibiliError?error.code:'BILIBILI_IMAGE_FAILED'});}
  }
  if(failed)content.retrieval={status:'partial',error:'BILIBILI_IMAGES_PARTIAL'};
  const fallbackContent=content.type==='video'&&content.description&&Array.from(content.description).length>600
    ?{...content,description:Array.from(content.description).slice(0,600).join('')+'…'}:content;
  const original=():PluginOutput[]=>[
    {kind:'reply',text:[contentText(fallbackContent),...(failed?['部分图片未能取得，已保留可用内容。']:[])].join('\n')},
    ...(content.type==='video'?[]:sourceTargets(content).slice(0,BILIBILI_IMAGE_LIMITS.sourceImages).map(image=>({kind:'image' as const,assetKey:image.assetKey,assetRole:image.role}))),
  ];
  if(mode==='none')return {content,files};
  if(mode==='original')return {content,files,outputs:original()};
  try {
    const maxPages=content.type==='video'?1:BILIBILI_IMAGE_LIMITS.pages;
    const request=join(directory,'render.json');await writeFile(request,JSON.stringify({content,paths,maxPages}),{mode:0o600});
    const raw=await renderLimited(()=>execute('python3',[script,'render',request],{cwd:directory,env,signal,timeoutMs:Math.min(job.config.timeoutSeconds*1000,30000)}),signal);
    const result=JSON.parse(raw) as {files:string[]};
    if(!Array.isArray(result.files)||!result.files.length||result.files.length>maxPages)throw new BilibiliError('BILIBILI_RENDER_LIMIT');
    const outputs:PluginOutput[]=[];
    for(const [index,name] of result.files.entries()) {
      if(!/^card-\d+\.png$/u.test(name))throw new BilibiliError('BILIBILI_RENDER_INVALID');
      const path=join(directory,name),info=await stat(path);
      if(info.size>Math.min(BILIBILI_IMAGE_LIMITS.perImageBytes,job.config.maxMiB*1024*1024,job.imageMaxBytes??Infinity)||info.size<16)throw new BilibiliError('BILIBILI_RENDER_LIMIT');
      const header=await readFile(path);if(imageExtension(header)!=='png')throw new BilibiliError('BILIBILI_RENDER_INVALID');
      const key=`card-${index}`;files.push({key,path,type:'image',role:'presentation'});outputs.push({kind:'image',assetKey:key,assetRole:'presentation'});
    }
    return {content,files,outputs};
  }catch{signal.throwIfAborted();content.retrieval={status:'partial',error:'BILIBILI_PRESENTATION_FALLBACK'};return {content,files,outputs:original()};}
}
