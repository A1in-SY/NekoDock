import { randomUUID } from 'node:crypto';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { RunObservation } from './types.js';

/** Publishes only provider-visible thinking text, never opaque signatures. */
export class ThinkingObserver {
  private current?: {id:string;text:string;truncated:boolean;lastSent:number;sentText?:string;timer?:NodeJS.Timeout};
  constructor(private readonly send:(event:RunObservation)=>void,private readonly intervalMs=250) {}

  start():void {
    this.finish('failed');
    this.current={id:randomUUID(),text:'',truncated:false,lastSent:0};
  }

  update(message:AssistantMessage):void {
    if(!this.current)this.start();
    const current=this.current!;
    const visible=message.content.filter(part=>part.type==='thinking'&&!part.redacted)
      .map(part=>part.type==='thinking'?part.thinking:'').join('\n\n');
    current.text=visible.slice(0,32_768);current.truncated=visible.length>32_768;
    if(!current.text||current.sentText===current.text)return;
    const remaining=this.intervalMs-(Date.now()-current.lastSent);
    if(remaining<=0)this.publish('in_progress');
    else current.timer??=setTimeout(()=>{current.timer=undefined;this.publish('in_progress');},remaining);
  }

  finish(status:'completed'|'failed',message?:AssistantMessage):void {
    if(message)this.update(message);
    const current=this.current;if(!current)return;
    clearTimeout(current.timer);
    if(current.text)this.publish(status);
    this.current=undefined;
  }

  private publish(status:'in_progress'|'completed'|'failed'):void {
    const current=this.current;if(!current?.text)return;
    current.lastSent=Date.now();current.sentText=current.text;
    this.send({type:'thinking.updated',itemId:current.id,payload:{text:current.text,status,...(current.truncated?{truncated:true}:{})}});
  }
}
