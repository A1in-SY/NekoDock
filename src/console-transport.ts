import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ManagedIdentity } from './managed-worker.js';
import { workerRequest } from './managed-worker.js';
import { logEvent } from './logging.js';
import type { Logger, MessageSegment, MessageSender, SendReceipt } from './types.js';
import { NAPCAT_SSE_MAX_BYTES } from './transport-protocol.js';
import { directFetch } from './network.js';
import type { IncomingImageDescriptor } from './incoming-image-contract.js';
import type { PluginDispatch } from './plugin-contract.js';
import { isForwardSnapshot, type ForwardSnapshot } from './forward-contract.js';

interface TransportOptions {
  identity: ManagedIdentity;
  logger: Logger;
  actionTimeoutMs: number;
  reconnectMs: number;
  onEvent(event: unknown, attachments?: IncomingImageDescriptor[], dispatch?: PluginDispatch, forwards?: ForwardSnapshot): void;
  onContentUpdate?(snapshot: ForwardSnapshot, attachments?: IncomingImageDescriptor[]): void;
}

/** Parses complete SSE records while bounding one unfinished event. */
export class TransportEventParser {
  private buffer = '';
  constructor(private readonly receive: (type: string, data: string) => Promise<void>, private readonly maxBytes = NAPCAT_SSE_MAX_BYTES) {}
  async push(text: string): Promise<void> {
    this.buffer += text;
    for (;;) {
      const match = /\r?\n\r?\n/u.exec(this.buffer);
      if (!match) break;
      const record = this.buffer.slice(0, match.index);
      if (Buffer.byteLength(record) > this.maxBytes) throw new Error('Transport event exceeds limit.');
      this.buffer = this.buffer.slice(match.index + match[0].length);
      let type = 'message'; const data: string[] = [];
      for (const line of record.split(/\r?\n/u)) {
        if (line.startsWith('event:')) type = line.slice(6).trim();
        if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /u, ''));
      }
      if (data.length) await this.receive(type, data.join('\n'));
    }
    if (Buffer.byteLength(this.buffer) > this.maxBytes) throw new Error('Transport event exceeds limit.');
  }
}

/** Managed workers never open a direct connection to NapCat. */
export class ConsoleTransport implements MessageSender {
  private running = false;
  private controller?: AbortController;
  private stream?: Promise<void>;
  private channel = false;
  private upstream = false;
  private online = false;
  private readonly sends = new Set<AbortController>();

  constructor(private readonly options: TransportOptions) {}
  get transportConnected(): boolean { return this.running && this.channel; }
  get upstreamConnected(): boolean { return this.upstream; }
  get qqOnline(): boolean { return this.online; }
  get connected(): boolean { return this.transportConnected && this.upstream && this.online; }

  start(): void {
    if (this.running) return;
    this.running = true; this.controller = new AbortController();
    this.stream = this.receiveLoop(this.controller.signal);
  }

  async stop(): Promise<void> {
    this.running = false; this.channel = false;
    this.controller?.abort();
    for (const request of this.sends) request.abort();
    await this.stream;
  }

  sendText(text: string, signal: AbortSignal, replyTo?: string): Promise<SendReceipt> {
    return this.send({kind:'text',text,...(replyTo !== undefined ? {replyTo} : {})}, signal);
  }
  sendImage(file: string, signal: AbortSignal): Promise<SendReceipt> { return this.send({kind:'image',file}, signal); }
  sendVideo(file: string, signal: AbortSignal): Promise<SendReceipt> { return this.send({kind:'video',file}, signal); }
  sendVoice(file: string, signal: AbortSignal): Promise<SendReceipt> { return this.send({kind:'voice',file}, signal); }
  sendMessage(segments: MessageSegment[], signal: AbortSignal): Promise<SendReceipt> { return this.send({kind:'message',segments}, signal); }

  private endpoint(path: string): string {
    const {identity}=this.options;
    return `${identity.url}/internal/workers/${encodeURIComponent(identity.botId)}/napcat/${path}`;
  }

  private async receiveLoop(signal: AbortSignal): Promise<void> {
    const {identity,logger}=this.options;
    while (!signal.aborted) {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const attempt = new AbortController();
      const headerTimeout=setTimeout(()=>attempt.abort(),15000);
      let idleTimer: NodeJS.Timeout | undefined;
      const touch=()=>{clearTimeout(idleTimer);idleTimer=setTimeout(()=>attempt.abort(),45000);};
      try {
        const response=await directFetch(this.endpoint('events'),{headers:{authorization:`Bearer ${identity.token}`,accept:'text/event-stream'},
          signal:AbortSignal.any([signal,attempt.signal]),redirect:'error'});
        clearTimeout(headerTimeout);
        if (!response.ok || !response.body || !response.headers.get('content-type')?.startsWith('text/event-stream')) throw new Error('Transport stream unavailable.');
        this.channel=true; touch();
        logEvent(logger,'info','managed.transport.connected');
        reader=response.body.getReader();
        const decoder=new TextDecoder();
        const parser=new TransportEventParser(async(type,data)=>{
          const value=JSON.parse(data) as Record<string,unknown>;
          if (type==='status') {
            if(typeof value.connected!=='boolean'||typeof value.online!=='boolean')throw new Error('Invalid transport status.');
            this.upstream=value.connected; this.online=value.online;
          } else if(type==='message') {
            if(!Number.isSafeInteger(value.seq)||(value.seq as number)<1||!value.event||typeof value.event!=='object')throw new Error('Invalid transport message.');
            if (value.attachments !== undefined && !Array.isArray(value.attachments)) throw new Error('Invalid transport attachments.');
            if (value.dispatch !== undefined && !validDispatch(value.dispatch, value.event)) throw new Error('Invalid plugin dispatch.');
            if(value.forwards!==undefined&&(!isForwardSnapshot(value.forwards)||value.forwards.messageId!==String((value.event as Record<string,unknown>).message_id)))throw new Error('Invalid transport forward content.');
            this.options.onEvent(value.event, value.attachments as IncomingImageDescriptor[] | undefined, value.dispatch as PluginDispatch | undefined,value.forwards as ForwardSnapshot|undefined);
            if(signal.aborted)throw new Error('Runtime closed before acknowledgement.');
            await workerRequest(identity,'napcat/ack',{seq:value.seq},signal);
          } else if(type==='content-update') {
            if(!Number.isSafeInteger(value.seq)||(value.seq as number)<1||!isForwardSnapshot(value.update)
              ||value.attachments!==undefined&&!Array.isArray(value.attachments)||!this.options.onContentUpdate)throw new Error('Invalid transport content update.');
            this.options.onContentUpdate(value.update,value.attachments as IncomingImageDescriptor[]|undefined);
            if(signal.aborted)throw new Error('Runtime closed before acknowledgement.');
            await workerRequest(identity,'napcat/ack',{seq:value.seq},signal);
          }
        });
        while(!signal.aborted) {
          const next=await reader.read();if(next.done)break;
          touch();await parser.push(decoder.decode(next.value,{stream:true}));
        }
      } catch {
        if(!signal.aborted)logEvent(logger,'warn','managed.transport.disconnected',{retry_ms:this.options.reconnectMs});
      } finally {
        clearTimeout(headerTimeout);clearTimeout(idleTimer);attempt.abort();this.channel=false;this.upstream=false;this.online=false;
        try{await reader?.cancel();}catch{/* A closed socket has no remaining body. */}
      }
      try{await delay(this.options.reconnectMs,undefined,{signal});}catch{break;}
    }
  }

  private async send(body: Record<string,unknown>, signal: AbortSignal): Promise<SendReceipt> {
    const deadline=Date.now()+this.options.actionTimeoutMs,deliveryId=randomUUID();
    while(!this.connected && this.running && !signal.aborted && Date.now()<deadline) {
      try{await delay(Math.min(50,Math.max(1,deadline-Date.now())),undefined,{signal});}catch{break;}
    }
    if(!this.connected||signal.aborted)throw this.failure('NAPCAT_CONNECTION_UNAVAILABLE','failed');
    const request=new AbortController();this.sends.add(request);
    let transmitted=false;
    try {
      transmitted=true;
      const response=await directFetch(this.endpoint('send'),{method:'POST',headers:{authorization:`Bearer ${this.options.identity.token}`,'content-type':'application/json'},
        body:JSON.stringify({...body,deliveryId,deadline}),redirect:'error',
        signal:AbortSignal.any([signal,request.signal,AbortSignal.timeout(Math.max(1,deadline-Date.now()))])});
      if(!response.ok)throw this.failure('NAPCAT_GATEWAY_REJECTED',response.status>=500?'unconfirmed':'failed');
      const text=await response.text();if(Buffer.byteLength(text)>16384)throw this.failure('NAPCAT_GATEWAY_INVALID_RESPONSE','unconfirmed');
      const result=JSON.parse(text) as Record<string,unknown>;
      if(result.ok===false) {
        const code=typeof result.code==='string'&&/^[A-Z][A-Z0-9_]{0,99}$/u.test(result.code)?result.code:'NAPCAT_GATEWAY_SEND_FAILED';
        throw this.failure(code,result.deliveryStatus==='failed'?'failed':'unconfirmed');
      }
      if(result.ok!==true)throw this.failure('NAPCAT_GATEWAY_INVALID_RESPONSE','unconfirmed');
      return typeof result.messageId==='string'?{messageId:result.messageId}:{};
    } catch(error) {
      if(error instanceof Error&&'deliveryStatus' in error)throw error;
      throw this.failure('NAPCAT_GATEWAY_UNAVAILABLE',transmitted?'unconfirmed':'failed');
    } finally {this.sends.delete(request);}
  }

  private failure(code: string, deliveryStatus:'failed'|'unconfirmed'): Error {
    return Object.assign(new Error('NapCat gateway delivery did not complete.'),{code,deliveryStatus});
  }
}

function validDispatch(value: unknown, event: object): value is PluginDispatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const dispatch = value as Record<string, unknown>;
  const source = (event as Record<string, unknown>).message_id;
  return typeof dispatch.sourceMessageId === 'string' && dispatch.sourceMessageId === String(source)
    && dispatch.sourceMessageId.length <= 200 && typeof dispatch.command === 'string' && dispatch.command.length <= 80
    && typeof dispatch.args === 'string' && dispatch.args.length <= 16384
    && (dispatch.jobId === undefined || typeof dispatch.jobId === 'string' && dispatch.jobId.length <= 200)
    && (dispatch.pluginId === 'core' && dispatch.executor === 'worker' && dispatch.contextPolicy === 'control'
      || dispatch.pluginId === 'bilibili' && dispatch.executor === 'console' && dispatch.contextPolicy === 'chat');
}
