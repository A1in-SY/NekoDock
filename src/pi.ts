import { fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, stat, opendir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareIncomingImages } from './images.js';
import { incomingMessageText } from './napcat.js';
import { fingerprint, logEvent } from './logging.js';
import { safeToolPayload } from './conversation-recorder.js';
import { publishProcessSample } from './process-sample-channel.js';
import { beginActivity, withActivityReporter } from './activity.js';
import { ReplyToolError, validateRecallRequest, validateReplyRequest } from './reply-contract.js';
import type { AgentResult, AgentRunner, Logger, PendingBatch, ReplyTools, RunObserver } from './types.js';
import type { PiChildMessage, PiConfig, PiStart, PiParentMessage } from './pi-protocol.js';
import type { ScheduledExecutionTools, ScheduledInput, TaskTools, TaskChatMessage } from './scheduled-contract.js';
import { proxySecrets } from './network.js';
import type { MemoryBatch, MemoryBatchTools, MemoryReadTools } from './memory-contract.js';
import { memoryOrganizerInput, memoryOrganizerResult } from './pi-memory.js';
import { recoverContextReceipts, type PiContextStart, type ContextImage } from './pi-context.js';
import { workspacePath } from './pi-tools.js';
import type { ContextCommit, ChatContextMessage, ChatRecallEvent } from './chat-context-contract.js';
import { prepareModelImage } from './model-image.js';
import { abortable } from './abortable.js';

export interface PiRunnerOptions extends PiConfig {
  timeoutMs: number; logger: Logger; imageMaxBytes?: number; imageTimeoutMs?: number;
  presentationSecrets?:string[];
  imageFetch?: typeof globalThis.fetch;
  prepareImages?: (messages: import('./types.js').StoredMessage[], signal: AbortSignal) => Promise<{
    files: string[]; byMessageId: Map<string, import('./images.js').IncomingImage[] | import('./incoming-image-contract.js').CachedIncomingImage[]>;
  }>;
  retainImages?: (messageIds: string[]) => () => void;
  memoryRead?: MemoryReadTools;
  recall?: (batch: PendingBatch) => Promise<unknown>;
  onCompacted?: (info: { session: string; entryId: string }) => void;
  /** Host-controlled snapshots for confirmed outgoing media. */
  mediaRoot?: string;
  onActivity?: RunObserver;
}
const CHILD = fileURLToPath(new URL('./pi-child.js', import.meta.url));
export const BASE_INSTRUCTIONS_PATH = fileURLToPath(new URL('../../prompts/base-instructions.md', import.meta.url));
const GRACE_MS = 1_000;

export function piFailure(code: string, message: string, secrets: string[]): Error & { code: string; providerStatus?: number } {
  const safeCode = /^PI_[A-Z0-9_]{1,60}$/.test(code) ? code : 'PI_EXECUTION_FAILED';
  const status = /^(?:HTTP\s+)?([45]\d\d)(?:\b|:)/.exec(message.trim());
  const detail = (safeToolPayload(message, secrets) as string)
    .replace(/https?:\/\/[^\s<>"']+/gi, '[url]')
    .replace(/\b(?:localhost|host\.docker\.internal)(?::\d+)?(?:\/[^\s<>"']*)?/gi, '[host]')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, 500);
  return Object.assign(new Error(`${safeCode}${detail ? `: ${detail}` : ''}`), { code: safeCode,
    ...(status ? { providerStatus: Number(status[1]) } : {}) });
}

/** Keep model and service credentials out of subprocess and shell environments. */
export function piEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'TEMP', 'TMP', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'PLAYWRIGHT_BROWSERS_PATH', 'PYTHONPATH', 'VIRTUAL_ENV']) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  result.PI_SKIP_VERSION_CHECK = '1';
  return result;
}

function within(root: string, path: string): boolean {
  const child = relative(root, path);
  return !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`);
}

async function contextImage(workspace: string, path: string, maxBytes: number, mediaRoot?: string): Promise<ContextImage> {
  let actual: string;
  let snapshotHash: string | undefined;
  try { actual = await workspacePath(workspace, path); }
  catch {
    // Scheduled snapshots are a controlled sibling of the workspace, not arbitrary files.
    const media = mediaRoot ? resolve(mediaRoot) : resolve(workspace, '..', 'console-media');
    const name = /^([a-f0-9]{64})\.(?:png|jpg|gif|webp)$/u.exec(basename(path));
    if (!name || resolve(dirname(path)) !== media) throw new Error('Image asset is outside managed storage.');
    const root = await realpath(media); actual = await realpath(path);
    if (dirname(actual) !== root || basename(actual) !== basename(path)) throw new Error('Image asset resolves outside managed storage.');
    snapshotHash = name[1];
  }
  const file = await stat(actual);
  if (!file.isFile() || file.size > maxBytes) throw new Error('Image exceeds context limit.');
  const bytes = await readFile(actual);
  if (bytes.length > maxBytes || snapshotHash && createHash('sha256').update(bytes).digest('hex') !== snapshotHash) throw new Error('Image asset hash mismatch.');
  const mimeType = actual.endsWith('.png') ? 'image/png' : actual.endsWith('.gif') ? 'image/gif' : actual.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
  return prepareModelImage(bytes, mimeType);
}

export async function validatePiSession(home: string, session: string): Promise<string> {
  const root = await realpath(resolve(home, 'sessions'));
  if (!isAbsolute(session) || !session.endsWith('.jsonl')) throw new Error('PI_INVALID_SESSION');
  const actual = await realpath(session);
  if (!within(root, actual) || !(await stat(actual)).isFile()) throw new Error('PI_INVALID_SESSION');
  return actual;
}

export class PiRunner implements AgentRunner {
  readonly supportsContextCommits = true;
  private readonly recallListeners=new Set<(event:ChatRecallEvent)=>void>();
  constructor(readonly options: PiRunnerOptions) {}

  /** Persistent delivery belongs to the Worker; this only updates an already active run. */
  notifyRecall(event:ChatRecallEvent):void {
    for(const listener of this.recallListeners)listener(event);
  }

  async recoverContext(session: string | null, onCommit: (receipt: ContextCommit) => void, stagedBatchIds: string[] = []): Promise<void> {
    if (session !== null) {
      const path = await validatePiSession(this.options.home, session);
      for (const receipt of await recoverContextReceipts(path)) onCommit(receipt);
      return;
    }
    const wanted = new Set(stagedBatchIds.filter(id => typeof id === 'string' && id.length > 0 && id.length <= 200));
    if (!wanted.size) return;
    const root = resolve(this.options.home,'sessions');
    const files = async function* (directory:string):AsyncGenerator<string> {
      let entries;try {entries=await opendir(directory);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
      for await (const entry of entries) {
        const path=resolve(directory,entry.name);
        if(entry.isDirectory())yield* files(path);
        else if(entry.isFile()&&entry.name.endsWith('.jsonl'))yield path;
      }
    };
    let match: {path:string;receipts:ContextCommit[]}|undefined;
    for await (const file of files(root)) {
      const path = await validatePiSession(this.options.home,file);
      const receipts=(await recoverContextReceipts(path)).filter(receipt=>wanted.has(receipt.batchId));
      if(!receipts.length)continue;
      if(match&&match.path!==path)throw piFailure('PI_CONTEXT_RECOVERY_AMBIGUOUS','Staged inputs match more than one Pi session.',[]);
      match={path,receipts};
    }
    if(match)for(const receipt of match.receipts)onCommit(receipt);
  }

  async run(batch: PendingBatch, session: string | null, onSession: (id: string) => void, signal: AbortSignal, replies?: ReplyTools, observer?: RunObserver, tasks?:TaskTools, externalMessages?:TaskChatMessage[]): Promise<AgentResult> {
    return withActivityReporter(event=>observer?.({type:'activity.updated',payload:{...event}}),publishProcessSample,()=>this.prepareAndRun(batch,session,onSession,signal,replies,observer,tasks,externalMessages));
  }
  private async prepareAndRun(batch: PendingBatch, session: string | null, onSession: (id: string) => void, signal: AbortSignal, replies?: ReplyTools, observer?: RunObserver, tasks?:TaskTools, externalMessages?:TaskChatMessage[]): Promise<AgentResult> {
    signal.throwIfAborted();
    const preparation=beginActivity('prepare','prepare');
    const contextual = batch.context;
    const contextMessages = contextual ? [...contextual.messages, ...contextual.references, ...contextual.revisions.map(item => item.message)] : [];
    const releaseImages = this.options.retainImages?.([...new Set([...batch.messages.map(message => message.messageId),
      ...contextMessages.flatMap(message => message.messageId ? [message.messageId] : [])])]);
    try {
    const images = this.options.prepareImages ? await this.options.prepareImages(batch.messages, signal) : await prepareIncomingImages(batch.messages, { workspace: this.options.workspace,
      maxBytes: this.options.imageMaxBytes ?? 10 * 1024 * 1024, timeoutMs: this.options.imageTimeoutMs ?? 30_000,
      logger: this.options.logger, fetch:this.options.imageFetch }, signal);
    let context: PiContextStart | undefined;
    if (contextual) {
      const updated = structuredClone(contextual);
      const withPreparedImages = (message: ChatContextMessage) => {
        const ready = message.messageId ? images.byMessageId.get(message.messageId) : undefined;
        if (ready) {
          const preparedIds=new Set(ready.map((image,index)=>'attachmentId' in image?image.attachmentId:`${message.chatMessageId}:image:${index}`));
          message.assets = [...(message.assets ?? []).filter(asset => asset.type !== 'image'||asset.origin==='plugin'&&!preparedIds.has(asset.id)), ...ready.map((image, index) => ({
          id: 'attachmentId' in image ? image.attachmentId : `${message.chatMessageId}:image:${index}`,
          type: 'image' as const, ...('status' in image ? {status:image.status} : {status:'ready' as const}),
          ...('path' in image && image.path ? {path:image.path} : {}), ...('error' in image && image.error ? {error:image.error} : {}),
          ...('origin' in image&&image.origin==='plugin'?{origin:'plugin' as const,pluginId:image.pluginId,pluginAssetId:image.assetId}:{}),
        }))];}
      };
      for (const message of [...updated.messages, ...updated.references, ...updated.revisions.map(item => item.message)]) withPreparedImages(message);
      const imageData: Record<string, ContextImage> = {};
      if (this.options.supportsImages) for (const message of [...updated.messages, ...updated.references, ...updated.revisions.map(item => item.message)]) {
        for (const asset of message.assets ?? []) {
          if (asset.type !== 'image' || asset.modelInput===false || !asset.path || asset.status && asset.status !== 'ready' || imageData[asset.path]) continue;
          try {
            imageData[asset.path] = await contextImage(this.options.workspace, asset.path, this.options.imageMaxBytes ?? 10 * 1024 * 1024,this.options.mediaRoot);
          } catch { asset.status = 'failed'; asset.error = 'Image content is unavailable for this input.'; }
        }
      }
      context = {submission:updated,imageData};
    }
    const attachments: PiStart['images'] = [];
    const failedImagePaths = new Set<string>();
    if (!contextual && this.options.supportsImages) for (const path of images.files) {
      const bytes = await readFile(path);
      const mimeType = path.endsWith('.png') ? 'image/png' : path.endsWith('.gif') ? 'image/gif' : path.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
      try { attachments.push(await prepareModelImage(bytes, mimeType)); }
      catch { failedImagePaths.add(path); }
    }
    const prompt = JSON.stringify({
      messages: batch.messages.map(message => ({ messageId: message.messageId,
        senderId: message.senderId, senderName: message.senderName, time: message.time, text: incomingMessageText(message.rawJson) ?? message.text,
        replyTo: message.replyTo, ...(images.byMessageId.has(message.messageId) ? { images: images.byMessageId.get(message.messageId)!.map(image =>
          'path' in image && image.path && failedImagePaths.has(image.path)
            ? { ...image, status: 'failed', error: 'Image content is unavailable for this input.' } : image) } : {}),
      })),
      replyTargetMessageIds: batch.replyAllowed ? batch.messages.filter(message => message.trigger).map(message => message.messageId) : [],
    });
    const sources=new Set(batch.messages.filter(message=>batch.replyAllowed&&message.trigger).map(message=>message.messageId));
    const scoped=tasks&&batch.replyAllowed?{manage:async(request:import('./scheduled-contract.js').TaskToolRequest,id:string)=>{
      if(!request||!sources.has(request.sourceMessageId))throw new Error('Task operation requires a current reply-target message.');
      return tasks.manage(request,id);
    }}:undefined;
    let recalled: unknown;
    if (batch.replyAllowed && this.options.recall) {
      try { recalled = await this.options.recall(batch); }
      catch { logEvent(this.options.logger, 'warn', 'memory.recall.failed'); }
    }
    const legacy = externalMessages?.length && !contextual ? JSON.parse(prompt) as {messages: unknown[]} : undefined;
    if (legacy) legacy.messages.push(...externalMessages!);
    preparation.end();
    await this.execute(batch.replyAllowed ? 'run' : 'append', session, legacy ? JSON.stringify(legacy) : prompt, attachments, onSession, signal,
      batch.replyAllowed ? replies : undefined, observer,scoped,undefined,undefined,undefined,recalled,context);
    return { messages: [] };
    } catch(error) {preparation.end(signal.aborted?'cancelled':'failed',error);throw error;}
    finally { releaseImages?.(); }
  }

  async compact(session: string, signal: AbortSignal, observer?: RunObserver): Promise<void> {
    await this.execute('compact', session, '', [], () => {}, signal, undefined, observer);
  }

  async runScheduled(input:ScheduledInput, tools:ScheduledExecutionTools, signal:AbortSignal, observer?:RunObserver, timeoutMs?:number):Promise<void> {
    await this.execute('scheduled',null,JSON.stringify(input),[],()=>{},signal,tools,observer,undefined,input.context.taskState?tools:undefined,timeoutMs);
  }

  async runMemory(input: MemoryBatch, tools: MemoryBatchTools, signal: AbortSignal, observer?: RunObserver): Promise<void> {
    await this.execute('memory', null, JSON.stringify(memoryOrganizerInput(input)), [], () => {}, signal, undefined, observer, undefined, undefined, undefined, tools);
  }

  private async execute(operation: PiStart['operation'], session: string | null, prompt: string, images: PiStart['images'], onSession: (id: string) => void,
    signal: AbortSignal, replies?: ReplyTools, observer?: RunObserver,tasks?:TaskTools,state?:ScheduledExecutionTools,timeoutMs?:number,memoryTools?:MemoryBatchTools,recalled?:unknown,context?:PiContextStart): Promise<void> {
    signal.throwIfAborted();
    if (operation !== 'append' && (!this.options.model.trim() || !this.options.baseUrl.trim())) {
      throw piFailure('PI_CONFIGURATION_REQUIRED', 'Configure both the model and provider base URL before generating or compacting.', []);
    }
    await mkdir(resolve(this.options.home, 'sessions'), { recursive: true, mode: 0o700 });
    if (session !== null) session = await validatePiSession(this.options.home, session);
    const runId = randomUUID(); const started = Date.now();
    const log = (level: 'info' | 'warn' | 'error', event: string, fields = {}) => logEvent(this.options.logger, level, event,
      { run_id: runId, operation, ...fields });
    const { logger: _logger, timeoutMs: _timeout, imageMaxBytes: _bytes, imageTimeoutMs: _imageTimeout, imageFetch: _imageFetch, prepareImages: _prepareImages, retainImages: _retainImages,
      memoryRead, recall: _recall, onCompacted, onActivity, mediaRoot: _mediaRoot, presentationSecrets=[], ...configured } = this.options;
    const config = operation === 'memory' ? { ...configured, persona: '', supportsImages: false, allowCommands: false, allowFileWrites: false, webSearch: undefined } : configured;
    const reads = operation === 'memory' ? memoryTools : operation === 'run' ? memoryRead : undefined;
    const system = operation === 'memory' ? await readFile(new URL('../../prompts/memory-consolidation.md', import.meta.url), 'utf8')
      : `${await readFile(BASE_INSTRUCTIONS_PATH, 'utf8')}\n\n${config.persona}`;
    log('info', 'agent.run.started', { resumed: session !== null, model: config.model, api: config.api });
    await new Promise<void>((resolveRun, rejectRun) => {
      const child = fork(CHILD, [], { cwd: config.workspace, env: piEnvironment(), execArgv: [],
        detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      let failure: Error | undefined; let done = false; let accepted = 0; let ended = false; let staged = 0; let memoryCalls = 0;
      let queue: Promise<void> = Promise.resolve(); let killTimer: NodeJS.Timeout | undefined;
      const operations=new AbortController();
      let stderrBytes = 0;
      const activeThinking=new Map<string,Record<string,unknown>>();
      child.stderr?.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; });
      const kill = () => {
        if (!child.pid) return;
        try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {}
      };
      const post=(message:PiParentMessage)=>{
        if(ended||!child.connected)return;
        try {child.send(message,error=>{
          if(error&&!ended){failure??=new Error('PI_CHANNEL_CLOSED');kill();}
        });}catch {if(!ended){failure??=new Error('PI_CHANNEL_CLOSED');kill();}}
      };
      const recallListener=(event:ChatRecallEvent)=>post({type:'recall-event',event});
      const operationError=(error:ReplyToolError)=>({code:/^[A-Z][A-Z0-9_]{0,99}$/u.test(error.code)?error.code:'REPLY_INVALID_REQUEST',
        message:(safeToolPayload(error.message,[...presentationSecrets,config.apiKey??'']) as string).slice(0,300),
        ...(error.messageIndex===undefined?{}:{messageIndex:error.messageIndex})});
      const stop = (error: Error) => {
        failure ??= error;
        operations.abort(error);
        if (ended) return;
        post({ type: 'abort' });
        killTimer ??= setTimeout(kill, GRACE_MS);
      };
      const abort = () => stop(new Error('PI_ABORTED'));
      const timeout = setTimeout(() => stop(Object.assign(new Error('PI_TIMEOUT'), {modelFailure:true})), timeoutMs??this.options.timeoutMs);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      child.on('message', (raw: unknown) => {
        const message = raw as PiChildMessage;
        queue = queue.then(async () => {
          if (!message || typeof message !== 'object') throw new Error('PI_INVALID_EVENT');
          if (message.type === 'network-log') {
            if (['info','warn','error'].includes(message.level) && typeof message.message === 'string'
              && /^network\.[a-z_.]+(?: |$)/u.test(message.message) && message.message.length <= 2048) {
              const safe = safeToolPayload(message.message, proxySecrets(config.networkProxy)) as string;
              this.options.logger[message.level](safe);
            }
          } else if (message.type === 'send') {
            let allowed = false;
            if (!failure && !signal.aborted && replies && (operation === 'run'||operation==='scheduled')) {
              try {
                const receipt=await abortable(()=>replies.send(validateReplyRequest(message.request, config.targetType), message.toolCallId ? {toolCallId:message.toolCallId} : undefined),operations.signal);
                accepted++; allowed = true;post({type:'send-result',id:message.id,accepted:true,receipt});return;
              } catch(error) {
                if(error instanceof ReplyToolError){post({type:'send-result',id:message.id,accepted:false,error:operationError(error)});return;}
                stop(new Error('PI_REPLY_ACCEPT_FAILED'));
              }
            }
            post({ type: 'send-result', id: message.id, accepted: allowed });
          } else if(message.type==='recall') {
            if(failure||signal.aborted||!replies?.recall||operation!=='run') {
              post({type:'recall-result',id:message.id,ok:false,error:{code:'RECALL_UNAVAILABLE',message:'Recall is unavailable for this execution.'}});return;
            }
            try {
              const result=await abortable(()=>replies.recall!(validateRecallRequest(message.request),{toolCallId:message.toolCallId,operationId:`${runId}:${message.toolCallId??message.id}`}),operations.signal);
              accepted++;post({type:'recall-result',id:message.id,ok:true,result});
            }catch(error){
              if(error instanceof ReplyToolError)post({type:'recall-result',id:message.id,ok:false,error:operationError(error)});
              else {post({type:'recall-result',id:message.id,ok:false});stop(new Error('PI_RECALL_FAILED'));}
            }
          } else if(message.type==='task-manage'||message.type==='task-state') {
            try {
              if(failure||signal.aborted)throw new Error('Task operation cancelled.');
              const result=message.type==='task-manage'&&tasks&&operation==='run'
                ?await abortable(()=>tasks.manage(message.request,`${runId}:${message.operationId}`,signal),operations.signal)
                :message.type==='task-state'&&state&&operation==='scheduled'
                  ?await abortable(()=>state.saveState(message.data,message.expectedVersion),operations.signal):await Promise.reject(new Error('Task operation unavailable.'));
              post({type:'task-result',id:message.id,ok:true,result});
            }catch(error){
              const detail=safeToolPayload(error instanceof Error?error.message:'Task operation unavailable.',[config.apiKey??'']) as string;
              post({type:'task-result',id:message.id,ok:false,error:detail.slice(0,300)});
            }
          } else if (message.type === 'memory-query' || message.type === 'memory-stage') {
            try {
              if (failure || signal.aborted || ++memoryCalls > 32 || !reads) throw new Error('Memory operation unavailable.');
              if (operation === 'memory' && staged > 0) throw new Error('Memory batch is already validated and staged.');
              let result: unknown;
              if (message.type === 'memory-stage') {
                if (operation !== 'memory' || !memoryTools || Buffer.byteLength(JSON.stringify(message.changes)) > 512 * 1024) throw new Error('Memory staging unavailable.');
                await abortable(()=>memoryTools.stage(message.changes),operations.signal); staged++; result = { staged: true };
              } else {
                result = await abortable(()=>message.operation === 'search' ? reads.search(message.request) : reads.history(message.request),operations.signal);
                if (operation === 'memory') result = memoryOrganizerResult(message.operation, result);
              }
              post({ type: 'memory-result', id: message.id, ok: true, result });
            } catch (error) {
              const detail = safeToolPayload(error instanceof Error ? error.message : 'Memory operation unavailable.', [config.apiKey ?? '']) as string;
              post({ type: 'memory-result', id: message.id, ok: false, error: detail.slice(0, 300) });
            }
          } else if (message.type === 'compacted') {
            if (operation === 'run' || operation === 'compact') {
              const path = await validatePiSession(config.home, message.session);
              if (typeof message.entryId !== 'string' || message.entryId.length > 200) throw new Error('PI_INVALID_EVENT');
              try { onCompacted?.({ session: path, entryId: message.entryId }); }
              catch { logEvent(this.options.logger, 'warn', 'memory.compaction.enqueue_failed'); }
            }
          } else if (message.type === 'context-committed') {
            const path = await validatePiSession(config.home, message.receipt.session);
            onSession(path);
            observer?.({type:'context.committed',payload:{...message.receipt,session:path}});
          } else if (message.type === 'session') {
            const path = await validatePiSession(config.home, message.path);
            onSession(path); log('info', 'agent.session.established', { session_ref: fingerprint(path) });
          } else if(message.type==='process-sample') {
            publishProcessSample(message.sample);
          } else if (message.type === 'event') {
            const secrets = [...presentationSecrets,...proxySecrets(config.networkProxy),config.apiKey, config.webSearch && config.webSearch.provider !== 'none' ? config.webSearch.apiKey : undefined].filter((value): value is string => !!value);
            const payload=message.event.type.startsWith('tool.')||message.event.type==='thinking.updated'
              ? safeToolPayload(message.event.payload,secrets) as Record<string,unknown>:message.event.payload;
            if(message.event.type==='thinking.updated'&&message.event.itemId) {
              if(payload.status==='in_progress')activeThinking.set(message.event.itemId,payload);else activeThinking.delete(message.event.itemId);
            }
            if(message.event.type==='activity.updated'&&onActivity)try{onActivity(message.event);}catch{}
            else observer?.({ ...message.event,payload });
            if (message.event.type.startsWith('tool.')) log('info', `agent.${message.event.type}`, {
              tool: String(message.event.payload.tool ?? 'unknown'), item_ref: fingerprint(message.event.itemId ?? ''), status: String(message.event.payload.status ?? '') });
          } else if (message.type === 'failure') {
            // Provider messages may contain URLs or echoed input. Persist only bounded, redacted diagnostics.
            const error = piFailure(message.code, message.message ?? '', [...proxySecrets(config.networkProxy),config.apiKey ?? '', config.webSearch && config.webSearch.provider !== 'none' ? config.webSearch.apiKey : '']);
            if (message.modelFailure === true) Object.assign(error, {modelFailure:true});
            stop(error);
          } else if (message.type === 'done') { done = true; }
          else throw new Error('PI_INVALID_EVENT');
        }).catch(error => stop(error instanceof Error ? error : new Error('PI_EVENT_FAILED')));
      });
      child.on('error', error => stop(error));
      child.once('close', (code, childSignal) => {
        ended = true;
        this.recallListeners.delete(recallListener);
        kill(); // Reap terminal children that kept the Agent process group alive.
        clearTimeout(timeout); clearTimeout(killTimer); signal.removeEventListener('abort', abort);
        void queue.then(() => {
          if (!failure && (!done || code !== 0)) failure = new Error('PI_PROCESS_FAILED');
          if (!failure && (operation === 'run'||operation==='scheduled') && accepted === 0) failure = new Error('PI_NO_REPLY');
          if (!failure && operation === 'memory' && staged === 0) failure = new Error('PI_MEMORY_NOT_STAGED');
          for(const [itemId,payload] of activeThinking)observer?.({type:'thinking.updated',itemId,payload:{...payload,status:'failed'}});
          log(failure ? 'warn' : 'info', failure ? 'agent.run.failed' : 'agent.run.completed',
            { duration_ms: Date.now() - started, exit_code: code, signal: childSignal, stderr_bytes: stderrBytes,
              accepted_requests: accepted, reason: failure ? /^PI_[A-Z0-9_]+/.exec(failure.message)?.[0] ?? 'PI_PROCESS_FAILED' : undefined });
          failure ? rejectRun(failure) : resolveRun();
        });
      });
      post({ type: 'start', operation, config, session, prompt, system, images,taskManagement:!!tasks,taskState:!!state,
        recallEnabled:operation==='run'&&!!replies?.recall,
        memoryRead: !!reads, ...(recalled === undefined ? {} : { recalledMemory: recalled }), ...(context ? {context} : {}) } satisfies PiStart);
      if(operation==='run')this.recallListeners.add(recallListener);
    });
  }
}
