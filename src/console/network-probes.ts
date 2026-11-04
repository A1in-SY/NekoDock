import { randomUUID } from 'node:crypto';
import { NETWORK_PROBE_CODES, type NetworkProbeCommand, type NetworkProbeJob, type NetworkProbeResult } from '../network-probe.js';

interface Entry {botId:string;job:NetworkProbeJob;createdAt:number;claimed:boolean}
/** Short-lived diagnostics are kept outside conversations and configuration history. */
export class NetworkProbes {
  private readonly entries = new Map<string,Entry>();
  constructor(private readonly now:()=>number=Date.now) {}
  private expire():void {
    for(const [id,entry] of this.entries) {
      if(this.now()-entry.createdAt>10*60_000){this.entries.delete(id);continue;}
      if(entry.job.status==='pending'&&this.now()-entry.createdAt>30_000)
        entry.job={...entry.job,status:'failed',result:{ok:false,code:'TIMEOUT',durationMs:this.now()-entry.createdAt}};
    }
  }
  request(botId:string,revision:number):NetworkProbeJob {
    this.expire();
    const pending=[...this.entries.values()].find(entry=>entry.botId===botId&&entry.job.status==='pending');
    if(pending)return {...pending.job};
    if(this.entries.size>=1000)throw new Error('请求过于频繁，请稍后重试');
    const job:NetworkProbeJob={id:randomUUID(),revision,status:'pending'};
    this.entries.set(job.id,{botId,job,createdAt:this.now(),claimed:false});return {...job};
  }
  get(botId:string,id:string):NetworkProbeJob|null {
    this.expire();const entry=this.entries.get(id);return entry?.botId===botId?{...entry.job}:null;
  }
  claim(botId:string,revision:number):NetworkProbeCommand|null {
    this.expire();
    for(const entry of this.entries.values()) {
      if(entry.botId!==botId||entry.claimed||entry.job.status!=='pending')continue;
      if(entry.job.revision!==revision){entry.job={...entry.job,status:'failed',result:{ok:false,code:'REVISION_CHANGED',durationMs:0}};continue;}
      entry.claimed=true;return {id:entry.job.id,revision:entry.job.revision};
    }
    return null;
  }
  complete(botId:string,input:unknown):boolean {
    this.expire();
    if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('请求检测结果无效');
    const value=input as {id?:unknown;revision?:unknown;result?:unknown};
    if(typeof value.id!=='string'||!Number.isSafeInteger(value.revision))throw new Error('请求检测结果无效');
    const entry=this.entries.get(value.id);
    if(!entry||entry.botId!==botId)throw new Error('请求检测记录不存在');
    if(entry.job.revision!==value.revision)throw new Error('请求检测版本无效');
    if(!entry.claimed||entry.job.status!=='pending')return false;
    const result=value.result as NetworkProbeResult|undefined;
    if(!result||typeof result!=='object'||typeof result.ok!=='boolean'||!NETWORK_PROBE_CODES.has(result.code)
      ||!Number.isFinite(result.durationMs)||result.durationMs<0||result.durationMs>60_000
      ||(result.ok&&(!Number.isInteger(result.status)||result.status!<100||result.status!>599||result.code!=='OK'))
      ||(!result.ok&&result.code==='OK')||!['direct','proxy',undefined].includes(result.route))throw new Error('请求检测结果无效');
    entry.job={...entry.job,status:result.ok?'completed':'failed',result:{ok:result.ok,code:result.code,durationMs:result.durationMs,
      ...(result.ok?{status:result.status}:{}),...(result.route?{route:result.route}:{})}};
    return true;
  }
}
