import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { activityName, type ActivityEvent, type ActivityKind, type ActivityName, type ProcessSample } from './activity-contract.js';
import { watchProcessTree } from './process-observer.js';

interface Scope { traceId: string; parentId?: string; event: (event: ActivityEvent) => void; process?: (sample: ProcessSample) => void; progress?:(patch:{count:number})=>void; }
const scopes = new AsyncLocalStorage<Scope>();
const safely = (action: () => void) => { try { action(); } catch { /* Observability cannot change business outcomes. */ } };

export function withActivityReporter<T>(event: Scope['event'], process: Scope['process'], action: () => Promise<T>): Promise<T> {
  return scopes.run({ traceId: randomUUID(), event, process }, action);
}
export function beginActivity(kind: ActivityKind, name: ActivityName, metadata: { requestIndex?: number; count?: number } = {}) {
  const scope = scopes.getStore(), id = randomUUID(), startedAt = Date.now(), start = performance.now(); let ended = false;
  const updates:{firstEventMs?:number;count?:number}={};
  const base = { id, traceId: scope?.traceId ?? id, ...(scope?.parentId ? { parentId: scope.parentId } : {}), kind, name, startedAt, ...metadata };
  const emit = (patch: Partial<ActivityEvent>) => { if (scope) safely(() => scope.event({ ...base, ...updates,time: Date.now(), status: 'running', ...patch })); };
  const progress=(patch:{firstEventMs?:number;count?:number})=>{if(!ended){Object.assign(updates,patch);emit({});}};
  emit({});
  return {
    id,
    run<T>(action: () => T): T { return scope ? scopes.run({ ...scope, parentId: id,progress }, action) : action(); },
    progress,
    end(status: ActivityEvent['status'] = 'completed', error?: unknown) {
      if (ended) return; ended = true;
      const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
      emit({ status, durationMs: Math.max(0, performance.now() - start), ...(typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/u.test(code) ? { errorCode: code } : {}) });
    },
  };
}
export function recordRenderedCount(value:unknown):void {
  try{const output=typeof value==='string'?JSON.parse(value):value;const count=Array.isArray(output?.files)?output.files.length:typeof output?.file==='string'?1:undefined;
    if(Number.isSafeInteger(count)&&count>=0&&count<=1000)scopes.getStore()?.progress?.({count});}catch{}
}
export async function activity<T>(kind: ActivityKind, name: ActivityName, action: () => Promise<T>,signal?:Pick<AbortSignal,'aborted'>): Promise<T> {
  const span = beginActivity(kind, name);
  try { const result = await span.run(action); span.end(); return result; }
  catch (error) { span.end(signal?.aborted||error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'failed', error); throw error; }
}
export function observeTool<T extends { name: string; execute: (...args: any[]) => any }>(tool: T): T {
  const original = tool.execute;
  return { ...tool, execute: (...args: any[]) => activity(tool.name === 'bash' ? 'command' : 'tool', activityName(tool.name), () => original(...args),args[2]) };
}
export function observeCurrentProcess():()=>Promise<void> {
  const scope=scopes.getStore();if(!scope?.parentId||!scope.process)return async()=>{};
  return watchProcessTree(process.pid,scope.parentId,sample=>safely(()=>scope.process!(sample)),{descendants:false});
}
/** Register at spawn, before the child can exit; the observer only reads this container's /proc. */
export function observeChild(child: ChildProcess): void {
  const scope = scopes.getStore(); if (!scope?.parentId || !scope.process) return;
  const attach = () => {
    if (!child.pid) return;
    const close = watchProcessTree(child.pid, scope.parentId!, sample => safely(() => scope.process!(sample)));
    child.once('close', () => void close()); child.once('error', () => void close());
  };
  if (child.pid) attach(); else child.once('spawn', attach);
}
export function observePluginRun<T extends (command: string, args: string[], options: any) => Promise<string>>(run: T): T {
  return ((command:string,args:string[],options:any)=>args[1]==='render'?run(command,args,options):activity(/yt-dlp|youtube-dl/u.test(command)?'download':'prepare',args[1]==='inspect'?'image_inspect':'media_process',()=>run(command,args,options))) as T;
}
