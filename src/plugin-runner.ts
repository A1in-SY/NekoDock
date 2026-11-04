import {readFile,readdir,lstat,rm,mkdir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {directFetch} from './network.js';
import {createLogger,logEvent} from './logging.js';
import { PluginExecutionError, type PluginExecution, type PluginRunnerDefinition } from './plugin-system/contracts.js';
import { pluginRunner } from './plugin-system/runner-registry.js';
import type {PluginRunnerJob,PluginRunnerResult} from './plugin-contract.js';

export function resolvePluginAssetKeys(value:unknown,assets:ReadonlyMap<string,string>,depth=0):unknown {
  if(depth>20)throw new PluginExecutionError('PLUGIN_ASSET_REFERENCE_INVALID');
  if(Array.isArray(value))return value.map(item=>resolvePluginAssetKeys(item,assets,depth+1));
  if(value===null||typeof value!=='object')return value;
  const source=value as Record<string,unknown>,result:Record<string,unknown>={};
  for(const [key,item] of Object.entries(source))if(key!=='assetKey')result[key]=resolvePluginAssetKeys(item,assets,depth+1);
  if(source.assetKey!==undefined) {
    if(typeof source.assetKey!=='string'||!assets.has(source.assetKey)||source.assetId!==undefined)throw new PluginExecutionError('PLUGIN_ASSET_REFERENCE_INVALID');
    result.assetId=assets.get(source.assetKey)!;
  }
  return result;
}

export async function runPluginRunner(options:{url:string;token:string;workspace:string;signal:AbortSignal;fetch?:typeof globalThis.fetch;execute?:PluginRunnerDefinition['execute']}) {
  const fetcher=options.fetch??directFetch;const origin=new URL(options.url);if(!['http:','https:'].includes(origin.protocol)||origin.username||origin.password)throw new Error('Plugin runner Console URL is invalid.');
  const url=origin.toString().replace(/\/$/u,'');const logger=createLogger({secrets:[options.token]});
  const request=async(path:string,body?:unknown,signal=options.signal)=>{
    const r=await fetcher(url+path,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${options.token}`,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.any([signal,AbortSignal.timeout(15000)]),redirect:'error'});
    if(!r.ok)throw new Error('Plugin runner control request failed.');return await r.json() as any;
  };
  while(!options.signal.aborted) {
    let job:PluginRunnerJob|undefined;
    try {job=(await request('/internal/plugin-runner/claim',{})).job??undefined;}catch {if(!options.signal.aborted)logEvent(logger,'warn','plugin.runner.channel_failed');}
    if(!job){try{await delay(1000,undefined,{signal:options.signal});}catch{};continue;}
    const controller=new AbortController();const signal=AbortSignal.any([options.signal,controller.signal]);
    const monitor=setInterval(()=>{void request(`/internal/plugin-runner/jobs/${encodeURIComponent(job!.id)}/status?lease=${encodeURIComponent(job!.lease)}`,undefined,signal).then(r=>{if(!r.active)controller.abort();}).catch(()=>controller.abort());},1000);monitor.unref();
    let execution:PluginExecution|undefined,result:PluginRunnerResult;
    try {
      execution=await (options.execute??pluginRunner(job.pluginId).execute)(job,options.workspace,signal);
      const uploaded=new Map<string,string>();
      const upload=async(path:string,key?:string,type:'image'|'video'='video',role?:string)=>{
        const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink())throw new PluginExecutionError('PLUGIN_ASSET_FILE_INVALID');
        const size=info.size;
        const response=await fetcher(`${url}/internal/plugin-runner/jobs/${encodeURIComponent(job.id)}/asset`,{method:'POST',headers:{authorization:`Bearer ${options.token}`,'x-plugin-lease':job.lease,'content-type':'application/octet-stream','content-length':String(size),...(key?{'x-plugin-asset-key':key,'x-plugin-asset-type':type,...(role?{'x-plugin-asset-role':role}:{})}:{})},body:createReadStream(path) as unknown as BodyInit,duplex:'half',signal,redirect:'error'} as RequestInit);
        if(!response.ok)throw new PluginExecutionError('PLUGIN_ASSET_UPLOAD_FAILED',true);
        const data=await response.json() as {assetId:string};if(typeof data.assetId!=='string'||!data.assetId)throw new PluginExecutionError('PLUGIN_ASSET_UPLOAD_FAILED');return data.assetId;
      };
      if(execution.file) {
        if(execution.files?.length||execution.outputs?.length)throw new PluginExecutionError('PLUGIN_ASSET_REFERENCE_INVALID');
        result={assetId:await upload(execution.file)};
      } else {
        if(execution.files&&(!Array.isArray(execution.files)||execution.files.length>32))throw new PluginExecutionError('PLUGIN_ASSET_LIMIT_EXCEEDED');
        for(const file of execution.files??[]) {
          if(!/^[A-Za-z0-9_-]{1,100}$/u.test(file.key)||uploaded.has(file.key)||!['image','video'].includes(file.type)||file.role!==undefined&&!/^[a-z_]{1,40}$/u.test(file.role))throw new PluginExecutionError('PLUGIN_ASSET_REFERENCE_INVALID');
          uploaded.set(file.key,await upload(file.path,file.key,file.type,file.role));
        }
        const files=execution.files??[];
        const outputs=execution.outputs?.map(output=>{
          const file=output.assetKey?files.find(file=>file.key===output.assetKey):undefined;
          return file?{...output,assetRole:file.role??(file.type==='image'?'content':'video')}:output;
        });
        result=resolvePluginAssetKeys({...(execution.content?{content:execution.content}:{}),...(outputs?{outputs}:{})},uploaded) as PluginRunnerResult;
      }
    }catch(error){result={error:error instanceof PluginExecutionError?error.code:'PLUGIN_OPERATION_FAILED',retryable:error instanceof PluginExecutionError&&error.retryable};}
    finally {clearInterval(monitor);await execution?.cleanup();}
    try {await request(`/internal/plugin-runner/jobs/${encodeURIComponent(job.id)}/result`,{lease:job.lease,result});logEvent(logger,'info','plugin.runner.job_finished',{job_id:job.id,status:result.error?'failed':'completed',code:result.error});}
    catch {if(!options.signal.aborted)logEvent(logger,'warn','plugin.runner.result_unconfirmed',{job_id:job.id});}
  }
}
async function main() {
  const controller=new AbortController();for(const event of ['SIGINT','SIGTERM'] as const)process.once(event,()=>controller.abort());
  let token=process.env.PLUGIN_RUNNER_TOKEN??'';
  while(!token&&!controller.signal.aborted) {
    try {token=(await readFile(process.env.PLUGIN_RUNNER_TOKEN_FILE??'/plugin-bootstrap/runner.token','utf8')).trim();}catch{}
    if(!token)try{await delay(1000,undefined,{signal:controller.signal});}catch{}
  }
  if(!token)return;
  const options={url:process.env.CONSOLE_URL??'http://console:4180',token,workspace:process.env.PLUGIN_RUNNER_WORKDIR??'/tmp/plugin-jobs',signal:controller.signal};
  await mkdir(options.workspace,{recursive:true,mode:0o700});
  for(const entry of await readdir(options.workspace,{withFileTypes:true})) {
    if(!entry.name.startsWith('job-'))continue;const path=join(options.workspace,entry.name);
    const info=await lstat(path);if(info.mtimeMs<Date.now()-3600_000)await rm(path,{recursive:true,force:true});
  }
  await Promise.all([runPluginRunner(options),runPluginRunner(options)]);
}
if(process.argv[1]===fileURLToPath(import.meta.url))void main().catch(()=>{process.stderr.write('Plugin runner stopped.\n');process.exitCode=1;});
