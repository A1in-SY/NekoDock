import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Config } from './config.js';
import { loadConfig } from './config.js';
import type { BridgeStore } from './store.js';
import type { ConversationRecorder } from './conversation-recorder.js';
import type { Logger } from './types.js';
import type { WorkerControl, WorkerHeartbeat, WorkerSnapshot } from './console/contracts.js';
import { logEvent } from './logging.js';

export interface ManagedIdentity {url:string;botId:string;token:string;dataDir:string;}
export interface WorkerRuntime {
  store:BridgeStore;
  readonly connected:boolean;
  readonly processing:boolean;
  readonly drained:boolean;
  requestDrain():void;
  stop(beforeStoreClose?:()=>Promise<void>):Promise<void>;
  done:Promise<void>;
}
export type RuntimeFactory=(config:Config,signal:AbortSignal)=>WorkerRuntime;

export function managedIdentity(env:NodeJS.ProcessEnv):ManagedIdentity|null {
  if(!env.CONSOLE_URL&&!env.BOT_INSTANCE_ID&&!env.WORKER_TOKEN)return null;
  if(!env.CONSOLE_URL||!env.BOT_INSTANCE_ID||!env.WORKER_TOKEN)throw new Error('Managed worker requires CONSOLE_URL, BOT_INSTANCE_ID and WORKER_TOKEN.');
  const url=new URL(env.CONSOLE_URL);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error('Invalid management endpoint.');
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(env.BOT_INSTANCE_ID))throw new Error('Invalid managed instance identity.');
  return {url:url.toString().replace(/\/+$/,''),botId:env.BOT_INSTANCE_ID,token:env.WORKER_TOKEN,dataDir:resolve(env.DATA_DIR??'/data')};
}

function snapshot(value:unknown,identity:ManagedIdentity):WorkerSnapshot {
  if(!value||typeof value!=='object')throw new Error('Invalid worker snapshot.');
  const s=value as WorkerSnapshot;
  if(s.botId!==identity.botId||!Number.isSafeInteger(s.revision)||s.revision<1||!s.target||
    !['group','private'].includes(s.target.type)||!(/^[1-9]\d*$/.test(s.target.id))||typeof s.persona!=='string'||
    !s.env||typeof s.env!=='object'||Object.values(s.env).some(value=>typeof value!=='string'))throw new Error('Invalid worker snapshot.');
  if(s.env.TARGET_TYPE!==s.target.type||s.env.TARGET_ID!==s.target.id)throw new Error('Worker snapshot target mismatch.');
  return s;
}

export async function saveSnapshot(identity:ManagedIdentity,value:WorkerSnapshot):Promise<void> {
  const nonce=randomBytes(12),key=createHash('sha256').update(identity.token).digest();
  const cipher=createCipheriv('aes-256-gcm',key,nonce);
  const encrypted=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
  const envelope=Buffer.concat([nonce,cipher.getAuthTag(),encrypted]);
  await mkdir(identity.dataDir,{recursive:true,mode:0o700});
  const path=join(identity.dataDir,'managed-config.enc'),temporary=`${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary,envelope,{mode:0o600,flag:'wx'});await rename(temporary,path);await chmod(path,0o600);
}
export async function cachedSnapshot(identity:ManagedIdentity):Promise<WorkerSnapshot> {
  const bytes=await readFile(join(identity.dataDir,'managed-config.enc'));
  if(bytes.length<29)throw new Error('Invalid managed configuration cache.');
  const decipher=createDecipheriv('aes-256-gcm',createHash('sha256').update(identity.token).digest(),bytes.subarray(0,12));
  decipher.setAuthTag(bytes.subarray(12,28));
  return snapshot(JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8')),identity);
}

export async function workerRequest(identity:ManagedIdentity,path:string,body?:unknown,signal?:AbortSignal):Promise<unknown> {
  const response=await fetch(`${identity.url}/internal/workers/${encodeURIComponent(identity.botId)}/${path}`,{
    method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${identity.token}`,...(body===undefined?{}:{'content-type':'application/json'})},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(5000)]):AbortSignal.timeout(5000),
  });
  if(!response.ok)throw new Error(`Management request failed (${response.status}).`);
  return response.json();
}
export async function loadManagedSnapshot(identity:ManagedIdentity,signal?:AbortSignal,allowCache=true):Promise<WorkerSnapshot> {
  try {const value=snapshot(await workerRequest(identity,'config',undefined,signal),identity);await saveSnapshot(identity,value);return value;}
  catch(error){if(!allowCache||signal?.aborted)throw error;return cachedSnapshot(identity);}
}

export async function materializeSnapshot(identity:ManagedIdentity,s:WorkerSnapshot,env:NodeJS.ProcessEnv):Promise<Config> {
  const config=loadConfig({...env,...s.env,DATA_DIR:identity.dataDir,AGENT_HOME:join(identity.dataDir,'pi'),
    AGENT_WORKSPACE:join(identity.dataDir,'workspace'),AGENT_PERSONA:s.persona});
  await mkdir(config.agentHome,{recursive:true,mode:0o700});
  return config;
}

/** Durable event transport runs independently of liveness/config heartbeats. */
export function uploadWorkerEvents(identity:ManagedIdentity,recorder:ConversationRecorder,logger:Logger):{close():Promise<void>} {
  let timer:NodeJS.Timeout|undefined;let flight:Promise<void>|undefined;let request:AbortController|undefined;
  let closed=false;let closing=false;let failures=0;let closingPromise:Promise<void>|undefined;
  const schedule=(ms=100)=>{
    if(closed||closing||timer||flight)return;
    timer=setTimeout(()=>{timer=undefined;void flush();},ms);
  };
  const flush=():Promise<void>=>{
    if(flight)return flight;
    if(closed)return Promise.resolve();
    flight=(async()=>{
      while(!closed) {
        const events=recorder.pending(80);if(!events.length)return;
        request=new AbortController();
        try {
          const value=await workerRequest(identity,'events',{events},request.signal) as {acknowledgedSeq:number};
          if(!value||!Number.isSafeInteger(value.acknowledgedSeq)||value.acknowledgedSeq<events.at(-1)!.seq)
            throw new Error('Invalid event acknowledgement.');
          recorder.acknowledge(value.acknowledgedSeq);failures=0;
        }catch {
          failures=Math.min(failures+1,6);
          if(!closed)logEvent(logger,'warn','managed.events.failed',{event_count:events.length,retry_ms:Math.min(1000*2**(failures-1),30_000)});
          return;
        }finally{request=undefined;}
      }
    })().catch(()=>{/* Closed/read-failed stores must not affect QQ delivery. */}).finally(()=>{
      flight=undefined;
      if(!closed&&!closing) {
        try {if(recorder.pending(1).length)schedule(failures?Math.min(1000*2**(failures-1),30_000):100);}catch{/* Runtime is closing. */}
      }
    });
    return flight;
  };
  const unsubscribe=recorder.subscribe(()=>schedule());
  schedule(); // Includes the durable backlog from a previous worker process.
  return {close:()=>closingPromise??=(async()=>{
    closing=true;unsubscribe();clearTimeout(timer);timer=undefined;
    // Bound shutdown even while the console is unavailable. Pending events
    // remain on disk and are resumed by the next worker/runtime.
    let deadline:NodeJS.Timeout|undefined;
    try {
      await Promise.race([(async()=>{await flight;await flush();})(),new Promise<void>(resolve=>{
        deadline=setTimeout(()=>{closed=true;request?.abort();resolve();},5500);
      })]);
    }finally{clearTimeout(deadline);closed=true;request?.abort();await flight;}
  })()};
}

export async function runManagedWorker(identity:ManagedIdentity,env:NodeJS.ProcessEnv,logger:Logger,signal:AbortSignal,factory:RuntimeFactory):Promise<void> {
  let current=await loadManagedSnapshot(identity,signal);
  let runtime=factory(await materializeSnapshot(identity,current,env),signal);
  let eventUpload=uploadWorkerEvents(identity,runtime.store.recorder,logger);
  let operation:WorkerControl|null=null;
  let runtimeError=false;
  let configError:string|undefined;
  let runtimeClosed=false;
  const watch=()=>{runtimeError=false;void runtime.done.catch(()=>{runtimeError=true;});};watch();
  try {
    while(!signal.aborted) {
      try {
        const heartbeat:WorkerHeartbeat={revision:current.revision,connected:runtime.connected,processing:runtime.processing,
          drained:runtime.drained,conversationId:runtime.store.recorder.conversationId,events:[],...(runtimeError?{error:'Worker runtime failed.'}:configError?{error:configError}:{})};
        const value=await workerRequest(identity,'heartbeat',heartbeat,signal) as WorkerControl;
        if(!value||!['running','stopped'].includes(value.desiredState)||!Number.isSafeInteger(value.desiredRevision)||
          !Number.isSafeInteger(value.acknowledgedSeq))throw new Error('Invalid management control response.');
        operation=value;
        if(value.desiredState==='stopped'||value.desiredRevision!==current.revision)runtime.requestDrain();
        // Resume after a cancelled stop also rebuilds the drained runtime, retaining DB and queued messages.
        if(runtime.drained&&value.desiredState==='running') {
          configError='Configuration could not be applied.';
          const next=value.desiredRevision!==current.revision?snapshot(await workerRequest(identity,'config',undefined,signal),identity):current;
          if(next.target.type!==current.target.type||next.target.id!==current.target.id)throw new Error('Managed target is immutable.');
          const prepared=await materializeSnapshot(identity,next,env);
          await saveSnapshot(identity,next);
          await runtime.stop(()=>eventUpload.close());runtimeClosed=true;
          current=next;runtime=factory(prepared,signal);runtimeClosed=false;configError=undefined;watch();
          eventUpload=uploadWorkerEvents(identity,runtime.store.recorder,logger);
          logEvent(logger,'info','managed.config.applied',{revision:current.revision});
        }
      }catch(error) {
        if(runtimeClosed)throw error;
        if(!signal.aborted)logEvent(logger,'warn','managed.sync.failed',{revision:current.revision,draining:operation?.desiredState==='stopped'});
      }
      try {await delay(5000,undefined,{signal});}catch{break;}
    }
  }finally{try{await runtime.stop(()=>eventUpload.close());}finally{await eventUpload.close();}}
}
