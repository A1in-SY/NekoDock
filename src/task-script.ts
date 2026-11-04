import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { validateReplyRequest } from './reply-contract.js';
import { shellEnvironment } from './pi-tools.js';
import type { ScheduledExecutionTools, ScheduledInput, ScheduledTask } from './scheduled-contract.js';
import type { TargetType } from './types.js';
import type { NetworkProxyConfig } from './network.js';

const PYTHON_SDK = `import json, os, re
from pathlib import Path
_request_id = 0
_reader = os.fdopen(4, 'r', encoding='utf-8')
def _request(operation, arguments):
    global _request_id
    _request_id += 1
    encoded = (json.dumps({'id': _request_id, 'operation': operation, 'arguments': arguments}, ensure_ascii=False) + '\\n').encode('utf-8')
    view = memoryview(encoded)
    while len(view):
        count = os.write(3, view)
        view = view[count:]
    line = _reader.readline()
    if not line: raise RuntimeError('Task interface unavailable. Do not resend automatically.')
    result = json.loads(line)
    if not result.get('ok'): raise RuntimeError(result.get('error', 'Task operation failed.'))
    return result['value']
def send_message(request):
    if isinstance(request, dict) and isinstance(request.get('messages'), list):
        request = {**request, 'messages': [({**message, 'path': str(Path(message['path']).resolve())} if isinstance(message, dict) and message.get('type') == 'image' and isinstance(message.get('path'), str) and not re.match(r'^[a-zA-Z][a-zA-Z0-9+.-]*:', message['path']) else message) for message in request['messages']]}
    return _request('send', request)
def read_task_state():
    return _request('read_state', {})
def read_task_context():
    return _request('read_context', {})
def save_task_state(data, expected_version):
    return _request('save_state', {'data': data, 'expectedVersion': expected_version})
`;
const NODE_SDK = `import {writeSync, readSync} from 'node:fs';
import {resolve} from 'node:path';
let id=0;
function request(operation,args){
 const bytes=Buffer.from(JSON.stringify({id:++id,operation,arguments:args})+'\\n');
 let written=0;while(written<bytes.length)written+=writeSync(3,bytes,written,bytes.length-written);
 const parts=[];const byte=Buffer.alloc(1);
 while(true){if(!readSync(4,byte,0,1,null))throw new Error('Task interface unavailable. Do not resend automatically.');if(byte[0]===10)break;parts.push(byte[0]);if(parts.length>1024*1024)throw new Error('Task response exceeded limit.');}
 const result=JSON.parse(Buffer.from(parts).toString('utf8'));
 if(!result.ok)throw new Error(result.error||'Task operation failed.');return result.value;
}
export function sendMessage(input){
 if(input&&typeof input==='object'&&Array.isArray(input.messages))input={...input,messages:input.messages.map(message=>message&&message.type==='image'&&typeof message.path==='string'&&!/^[a-z][a-z0-9+.-]*:/i.test(message.path)?{...message,path:resolve(message.path)}:message)};
 return request('send',input);
}
export function readTaskState(){return request('read_state',{});}
export function readTaskContext(){return request('read_context',{});}
export function saveTaskState(data,expectedVersion){return request('save_state',{data,expectedVersion});}
`;

export interface TaskScriptOptions {
 task:ScheduledTask;input:ScheduledInput;workspace:string;tools:ScheduledExecutionTools;signal:AbortSignal;targetType?:TargetType;
 onOutput?:(stream:'stdout'|'stderr',text:string)=>void;pythonCommand?:string;nodeCommand?:string;
 networkProxy?:NetworkProxyConfig;
}
/** Saved source is materialized into an immutable per-run directory with a narrow private IPC helper. */
export async function runTaskScript(options:TaskScriptOptions):Promise<void> {
 const {task,input,signal}=options;signal.throwIfAborted();
 if(task.kind!=='script'||!task.script)throw new Error('TASK_SCRIPT_REQUIRED');
 if(!/^[A-Za-z0-9_-]{1,128}$/.test(input.invocation.runId))throw new Error('TASK_RUN_ID_INVALID');
 const directory=join(options.workspace,'scheduled-runs',input.invocation.runId);
 await mkdir(directory,{recursive:true,mode:0o700});
 const filename=task.script.runtime==='python'?'task.py':'task.mjs';
 await writeFile(join(directory,'nekodock_tasks.py'),PYTHON_SDK,{mode:0o600,flag:'wx'});
 await writeFile(join(directory,'nekodock_tasks.mjs'),NODE_SDK,{mode:0o600,flag:'wx'});
 await writeFile(join(directory,'task_context.json'),JSON.stringify(input),{mode:0o600,flag:'wx'});
 await writeFile(join(directory,filename),task.script.source,{mode:0o600,flag:'wx'});
 const command=task.script.runtime==='python'?options.pythonCommand??'python3':options.nodeCommand??process.execPath;
 await new Promise<void>((resolve,reject)=>{
  const child=spawn(command,[join(directory,filename)],{cwd:directory,env:{...shellEnvironment(process.env,options.networkProxy),PYTHONUNBUFFERED:'1'},detached:process.platform!=='win32',stdio:['ignore','pipe','pipe','pipe','pipe']});
  let settled=false;let failure:Error|undefined;let outputBytes=0;let rpcBytes=0;let state=input.context.taskState;let tail=Promise.resolve();
  const output=(stream:'stdout'|'stderr',bytes:Buffer)=>{
   outputBytes+=bytes.length;
   if(outputBytes>256*1024){fail(new Error('TASK_SCRIPT_OUTPUT_LIMIT'));return;}
   options.onOutput?.(stream,bytes.toString('utf8'));
  };
  const kill=()=>{if(!child.pid)return;try{if(process.platform!=='win32')process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{}};
  const fail=(error:Error)=>{failure??=error;kill();};
  const abort=()=>fail(new Error('TASK_CANCELLED'));
  const timeout=setTimeout(()=>fail(new Error('TASK_TIMEOUT')),task.timeoutSeconds*1000);
  signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  child.stdout!.on('data',(bytes:Buffer)=>output('stdout',bytes));child.stderr!.on('data',(bytes:Buffer)=>output('stderr',bytes));
  const requests=child.stdio[3] as Readable;const responses=child.stdio[4] as Writable;
  requests.on('data',(bytes:Buffer)=>{rpcBytes+=bytes.length;if(rpcBytes>2*1024*1024)fail(new Error('TASK_SCRIPT_REQUEST_LIMIT'));});
  const lines=createInterface({input:requests,crlfDelay:Infinity});
  let requestsCount=0;
  lines.on('line',line=>{tail=tail.then(async()=>{
   if(failure||settled)return;
   if(++requestsCount>100||Buffer.byteLength(line)>300*1024){fail(new Error('TASK_SCRIPT_REQUEST_LIMIT'));return;}
   let id:unknown;let value:unknown;
   try {
    const request=JSON.parse(line) as {id:unknown;operation:unknown;arguments:Record<string,unknown>};id=request.id;
    if(!Number.isSafeInteger(id))throw new Error('TASK_SCRIPT_INVALID_REQUEST');
    if(request.operation==='send')value=await options.tools.send(validateReplyRequest(request.arguments,options.targetType));
    else if(request.operation==='read_context')value=input;
    else if(request.operation==='read_state') {if(!task.context.taskState)throw new Error('TASK_STATE_DISABLED');value=state;}
    else if(request.operation==='save_state') {
     if(!task.context.taskState)throw new Error('TASK_STATE_DISABLED');
     state=await options.tools.saveState(request.arguments.data as Record<string,unknown>,request.arguments.expectedVersion as number);value=state;
    } else throw new Error('TASK_SCRIPT_INVALID_OPERATION');
    if(!responses.destroyed)responses.write(JSON.stringify({id,ok:true,value})+'\n');
   } catch(error) {
    const safe=error instanceof Error&&/^TASK_[A-Z_]+$/.test(error.message)?error.message:'Task operation failed. Do not resend automatically.';
    if(!responses.destroyed)responses.write(JSON.stringify({id,ok:false,error:safe})+'\n');
   }
  }).catch(()=>fail(new Error('TASK_SCRIPT_INTERFACE_FAILED')));});
  responses.on('error',()=>{/* Child can exit after committing a tool request; accepted requests remain durable. */});
  const finish=(error?:Error)=>{
   if(settled)return;settled=true;clearTimeout(timeout);signal.removeEventListener('abort',abort);lines.close();kill();
   if(error)reject(error);else resolve();
  };
  child.once('error',()=>finish(new Error('TASK_SCRIPT_START_FAILED')));
  child.once('close',code=>{void tail.then(()=>finish(failure??(code===0?undefined:new Error(`TASK_SCRIPT_EXIT_${code??'SIGNAL'}`))));});
 });
}

/** Preview collects sends without contacting the chat transport. Other script operations still execute normally. */
export async function previewTaskScript(options:Omit<TaskScriptOptions,'tools'> & {tools?:Pick<ScheduledExecutionTools,'saveState'>}):Promise<unknown[]> {
 const messages:unknown[]=[];
 await runTaskScript({...options,tools:{send:async request=>{messages.push(...request.messages);return {accepted:true};},saveState:async()=>{throw new Error('TASK_PREVIEW_STATE_READONLY');}}});
 return messages;
}
