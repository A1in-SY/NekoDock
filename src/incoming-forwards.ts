import { setTimeout as delay } from 'node:timers/promises';
import { FORWARD_LIMITS, isForwardSnapshot, type ForwardContent, type ForwardSnapshot } from './forward-contract.js';
import type { IncomingImageDescriptor } from './incoming-image-contract.js';
import { fingerprint, logEvent } from './logging.js';
import { workerRequest, type ManagedIdentity } from './managed-worker.js';
import type { BridgeStore } from './store.js';
import type { Logger, PendingBatch, StoredMessage } from './types.js';

interface ForwardReply { snapshot: ForwardSnapshot | null; attachments?: IncomingImageDescriptor[] }
interface Options {
  store: BridgeStore;
  identity: ManagedIdentity;
  logger: Logger;
  registerImages(message: StoredMessage, attachments: IncomingImageDescriptor[]): void;
  request?: (messageId: string, signal: AbortSignal) => Promise<unknown>;
}

const pending=(contents:ForwardContent[]):boolean=>contents.some(content=>content.status==='pending'
  ||content.nodes.some(node=>pending(node.segments.filter((segment):segment is ForwardContent=>segment.type==='forward'))));
const hasForward=(message:StoredMessage)=>/"type"\s*:\s*"(?:forward|node)"/u.test(message.rawJson)
  ||/\[CQ:(?:forward|node)[,\]]/u.test(message.rawJson);

/** Content updates never notify the processor or acquire another chat turn. */
export class WorkerIncomingForwards {
  constructor(private readonly options:Options) {}

  receive(snapshot:ForwardSnapshot,attachments:IncomingImageDescriptor[]=[]):void {
    if(!isForwardSnapshot(snapshot))throw new Error('Invalid forwarded message update.');
    const original=this.options.store.getMessage(snapshot.messageId);
    if(!original)return;
    this.options.store.recordForwardContent(snapshot);
    this.options.registerImages(original,attachments.filter(item=>item.messageId===snapshot.messageId));
  }

  /** Resolve only this batch's material and exact references, under one ingress-wide budget. */
  async beforeContext(batch:PendingBatch,signal:AbortSignal):Promise<void> {
    signal.throwIfAborted();
    const ids=[...new Set(batch.messages.flatMap(message=>[message.messageId,...(message.replyTo?[message.replyTo]:[])]))]
      .filter(id=>{
        const original=this.options.store.getMessage(id);
        return original&&(this.options.store.forwardSnapshot(id)!==null||hasForward(original));
      });
    if(!ids.length)return;
    const unresolved=new Set(ids.filter(id=>{
      const snapshot=this.options.store.forwardSnapshot(id);return !snapshot||pending(snapshot.contents);
    }));
    const unknown=new Set(ids.filter(id=>!this.options.store.forwardSnapshot(id)));
    const started=Date.now(),maximum=started+FORWARD_LIMITS.timeoutMs;
    let nextFetch=0;
    while(unresolved.size) {
      signal.throwIfAborted();
      for(const id of unresolved) {
        const snapshot=this.options.store.forwardSnapshot(id);
        if(snapshot&&!pending(snapshot.contents))unresolved.delete(id);
      }
      if(!unresolved.size)return;
      const deadlines=[...unresolved].map(id=>this.options.store.forwardSnapshot(id)?.deadline??maximum);
      const deadline=Math.min(maximum,Math.max(...deadlines));
      // An expired ingress budget can still have a ready durable result at Console.
      // Read that result once before projecting a local timeout (including on restart).
      if(Date.now()>=deadline&&nextFetch>0)break;
      if(Date.now()>=nextFetch) {
        const fetchDeadline=Date.now()>=deadline?Math.min(maximum,Date.now()+1000):deadline;
        const remaining=fetchDeadline-Date.now();
        if(remaining<=0)break;
        const requestSignal=AbortSignal.any([signal,AbortSignal.timeout(Math.min(2000,remaining))]);
        const selected=[...unresolved];
        for(let index=0;index<selected.length;index+=FORWARD_LIMITS.concurrency) {
          await Promise.all(selected.slice(index,index+FORWARD_LIMITS.concurrency).map(async id=>{
            try {
              const response=await (this.options.request?this.options.request(id,requestSignal):workerRequest(this.options.identity,
                `napcat/forwards/${encodeURIComponent(id)}`,undefined,requestSignal)) as ForwardReply;
              if(!response||typeof response!=='object'||response.snapshot!==null&&!isForwardSnapshot(response.snapshot)
                ||response.attachments!==undefined&&!Array.isArray(response.attachments))throw new Error('Invalid forwarded message response.');
              if(response.snapshot===null) {
                // Historical messages without a stored resolver snapshot are not replayed or backfilled.
                if(unknown.has(id))unresolved.delete(id);
              } else {
                if(response.snapshot.messageId!==id)throw new Error('Forwarded message ownership mismatch.');
                this.receive(response.snapshot,response.attachments??[]);
              }
            } catch {
              signal.throwIfAborted();
              logEvent(this.options.logger,'warn','forward.sync.failed',{message_ref:fingerprint(id)});
            }
          }));
          if(Date.now()>=fetchDeadline)break;
        }
        nextFetch=Date.now()+500;
      }
      if(Date.now()>=deadline)break;
      await delay(Math.min(100,deadline-Date.now()),undefined,{signal});
    }
    for(const id of unresolved) {
      if(this.options.store.failPendingForwards(id))logEvent(this.options.logger,'warn','forward.context.timed_out',{message_ref:fingerprint(id)});
    }
  }
}
