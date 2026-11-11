import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { managedIdentity, runManagedWorker, workerRequest, type WorkerRuntime, type ManagedIdentity } from './managed-worker.js';
import { loadConfig, type Config } from './config.js';
import { BridgeStore } from './store.js';
import { PiRunner, validatePiSession } from './pi.js';
import { NapCatClient, incomingMessageText } from './napcat.js';
import { ConsoleTransport } from './console-transport.js';
import { handleIncomingEvent } from './incoming.js';
import { Processor } from './processor.js';
import { createLogger, fingerprint, logEvent } from './logging.js';
import { createSpeechProvider } from './tts.js';
import { ScheduledStore, type TaskTicket } from './scheduled-store.js';
import { Scheduler } from './scheduler.js';
import { buildTaskHistory } from './task-history.js';
import { deliverTaskMessage } from './task-delivery.js';
import { safeToolPayload } from './conversation-recorder.js';
import type { ScheduledTask, TaskTools } from './scheduled-contract.js';
import { createNetworkClient, proxySecrets } from './network.js';
import { probeNetwork } from './network-probe.js';
import { MemoryStore } from './memory-store.js';
import { MemoryCoordinator, type MemoryReceipt } from './memory-coordinator.js';
import { MemoryEmbeddings } from './memory-embeddings.js';
import type { MemoryControl, MemoryItem, MemoryView } from './memory-contract.js';
import { recoverMemoryCompactions } from './memory-compaction-recovery.js';
import { WorkerIncomingImages } from './incoming-image-cache.js';
import { createIncomingImageRemote } from './incoming-image-remote.js';
import type { IncomingImageDescriptor } from './incoming-image-contract.js';
import { recoverIncomingImages } from './incoming-image-recovery.js';
import { PluginCoordinator } from './plugin-coordinator.js';
import type { PluginDispatch } from './plugin-contract.js';
import { createPluginImageReader } from './plugin-images.js';
import { WorkerIncomingForwards } from './incoming-forwards.js';
import type { ForwardSnapshot } from './forward-contract.js';
import { historySharedContents } from './history-content.js';
import { ReplyDecisionCoordinator } from './reply-decision.js';
import type { ChatRecallEvent } from './chat-context-contract.js';
import { incomingRecall } from './incoming-recall.js';

const logger = createLogger();

function createRuntime(config:Config, signal:AbortSignal, identity?:ManagedIdentity):WorkerRuntime {
  const secrets=[config.agentApiKey,config.replyDecision.apiKey,config.memory.apiKey,config.memory.embeddingApiKey,config.token,identity?.token,config.webSearch.provider==='tavily'?config.webSearch.apiKey:'',config.tts.provider==='mimo'?config.tts.apiKey:'',...proxySecrets(config.networkProxy)].filter((value):value is string=>!!value);
  const logger=createLogger({secrets});
  const imageNetwork=createNetworkClient(config.networkProxy,logger,'images');
  const speechNetwork=createNetworkClient(config.networkProxy,logger,'tts');
  const diagnostics=createNetworkClient(config.networkProxy,logger,'probe');
  const memoryNetwork=createNetworkClient(config.networkProxy,logger,'model');
  const decisionNetwork=createNetworkClient(config.networkProxy,logger,'reply-decision');
  for (const path of [config.dataDir, config.agentHome, config.workspace]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const store = new BridgeStore(join(config.dataDir, 'bridge.sqlite3'), config.target);
  store.initializeAgentRuntime();
  const memoryStore = new MemoryStore(join(config.dataDir, 'bridge.sqlite3'));
  memoryStore.enableChatProjection();
  const embeddings = config.memory.enabled && config.memory.embeddingProvider !== 'none'
    ? new MemoryEmbeddings(join(config.dataDir, 'bridge.sqlite3'), config.memory, memoryStore, memoryNetwork.fetch) : undefined;
  const controller = new AbortController();
  const parentAbort=()=>controller.abort();
  signal.addEventListener('abort',parentAbort,{once:true});
  if(signal.aborted)controller.abort();
  let processor: Processor;
  let memory: MemoryCoordinator;
  let plugins: PluginCoordinator | undefined;
  let replyDecision: ReplyDecisionCoordinator | undefined;
  const incomingImages = new WorkerIncomingImages({
    dbPath: join(config.dataDir, 'bridge.sqlite3'), workspace: config.workspace,
    maxBytes: config.imageMaxBytes, timeoutMs: config.imageTimeoutMs,
    cacheDays: config.imageCacheDays, cacheMaxBytes: config.imageCacheMaxBytes, logger, fetch: imageNetwork.fetch,
    ...(identity ? { remote: createIncomingImageRemote(identity, config.imageMaxBytes, config.imageTimeoutMs) } : {}),
    ...(identity ? { pluginContent: createPluginImageReader(identity,config.imageMaxBytes,config.imageTimeoutMs) } : {}),
    isProtected: messageId => store.getMessage(messageId) === null || store.isMessagePending(messageId),
    onUpdated: (messageId, images) => {
      if (!store.getMessage(messageId)) return false;
      store.recordIncomingImages(messageId, images); return true;
    },
  }, controller.signal);
  const incomingForwards=identity?new WorkerIncomingForwards({identity,store,logger,
    registerImages:(message,attachments)=>incomingImages.register(message,attachments),
  }):undefined;
  const previousImageSession = store.getSessionId();
  const imageRecovery = previousImageSession
    ? validatePiSession(config.agentHome, previousImageSession).then(path => recoverIncomingImages(path, controller.signal,
      (messageId, index, path, signal) => incomingImages.adoptLegacy(messageId, index, path, signal)))
      .then(count => { if (count) logEvent(logger, 'info', 'image.cache.recovered', { count }); })
      .catch(() => { if (!controller.signal.aborted) logEvent(logger, 'warn', 'image.cache.recovery_failed'); })
    : Promise.resolve();
  const historicalImageReleases: Array<() => void> = [];
  const onRecall=(event:ChatRecallEvent)=>{
    try {
      if(store.applyRecall(event)) {
        const source=store.chatMessageForQQ(event.messageId),pending=store.peekPendingBatch();
        const received=source?.origin==='human'?store.getMessage(event.messageId):null;
        if(source?.conversationId===store.recorder.conversationId
          &&(source.origin!=='human'||pending&&received&&received.seq<=pending.throughSeq))agent.notifyRecall(event);
        logEvent(logger,'info','message.recalled',{message_ref:fingerprint(event.messageId),event_ref:fingerprint(event.eventId)});
      }
    } catch {
      logEvent(logger,'error','message.recall.persistence_failed');
      process.exitCode=1;controller.abort();throw new Error('Message recall persistence failed.');
    }
  };
  const onEvent = (event:unknown, attachments?: IncomingImageDescriptor[], dispatch?: PluginDispatch, forwards?:ForwardSnapshot) => {
      try {
        if(!identity) {
          const recall=incomingRecall(event,config.target,id=>store.chatMessageForQQ(id)!==null);
          if(recall){onRecall(recall);return;}
        }
        handleIncomingEvent(event, {
          target: config.target, randomReplyProbability: config.randomReplyProbability,
          store, processor, sender: napcat, logger, signal: controller.signal,
          dispatch, replyDecision,
          onMessage: message => {
            if(forwards?.messageId===message.messageId)incomingForwards?.receive(forwards,attachments);
            incomingImages.register(message, identity ? attachments ?? [] : undefined);
            plugins?.register(message.messageId);
          },
        });
      } catch {
        logger.error('消息落库失败，停止实例；检查数据卷的可写权限和剩余空间');
        process.exitCode = 1;
        controller.abort();
        throw new Error('Incoming message persistence failed.');
      }
  };
  const napcat = identity ? new ConsoleTransport({identity,logger,reconnectMs:config.reconnectMs,actionTimeoutMs:config.actionTimeoutMs,onEvent,onRecall,
    onContentUpdate:(snapshot,attachments)=>incomingForwards!.receive(snapshot,attachments)})
    : new NapCatClient({url:config.wsUrl,token:config.token,target:config.target,logger,reconnectMs:config.reconnectMs,actionTimeoutMs:config.actionTimeoutMs,onEvent});
  const agent = new PiRunner({
    home: config.agentHome, workspace: config.workspace,
    timeoutMs: config.agentTimeoutMs, logger, model: config.agentModel ?? '',
    baseUrl: config.agentBaseUrl ?? '', apiKey: config.agentApiKey, api: config.agentApi,
    reasoning: config.agentReasoning === 'none' ? 'off' : config.agentReasoning,
    contextWindow: config.agentContextWindow, compactLimit: config.agentCompactLimit,
    maxOutputTokens: config.agentMaxOutputTokens, supportsImages: config.agentSupportsImages,
    supportsReasoning: config.agentSupportsReasoning, allowCommands: config.allowCommands,
    allowFileWrites: config.allowFileWrites, taskCreatorOnly: config.taskCreatorOnly, persona: config.persona,
    imageMaxBytes: config.imageMaxBytes, imageTimeoutMs: config.imageTimeoutMs,
    mediaRoot: join(config.dataDir, 'console-media'),
    imageFetch:imageNetwork.fetch,networkProxy:config.networkProxy,
    prepareImages: async (messages, signal) => { await imageRecovery; return incomingImages.prepare(messages, signal); },
    retainImages: messageIds => {
      const release = incomingImages.retain(messageIds);
      return () => { release(); for (const releaseHistory of historicalImageReleases.splice(0)) releaseHistory(); };
    },
    targetType: config.target.type,
    webSearch: config.webSearch,
    presentationSecrets:secrets,
    keepRecentTokens: config.agentKeepRecentTokens, summaryMaxTokens: config.agentSummaryMaxTokens,
    ...(config.memory.enabled ? {
      memoryRead: {
        search: async request => memoryStore.search({ ...request, includeInactive: false }),
        history: async request => {
          const result = memoryStore.history(request);
          historicalImageReleases.push(incomingImages.retain(result.messages.flatMap(source => source.kind!=='message_recalled'&&source.messageId ? [source.messageId] : [])));
          return { ...result, messages: result.messages.map(source => {
            if(source.kind==='message_recalled')return source;
            const chat = source.messageId ? store.chatMessageForQQ(source.messageId) : null;
            const original = source.messageId ? store.getMessage(source.messageId) : null;
            if (!original) return chat ? { ...source, assets: chat.assets, ...historySharedContents(chat.contents) } : source;
            // Older records acquire the same stable references on first retrieval.
            incomingImages.register(original);
            const images = incomingImages.lookup(original.messageId);
            const projected = source.id.startsWith('revision:') ? null : incomingMessageText(original.rawJson);
            return { ...source, ...(projected === null ? {} : { text: projected.slice(source.textOffset ?? 0, (source.textOffset ?? 0) + source.text.length) }),
              ...(images.length ? { images } : {}), ...(chat ? { assets: chat.assets, ...historySharedContents(chat.contents) } : {}) };
          }) };
        },
      },
      recall: async batch => {
        const targets = batch.messages.filter(message => message.trigger);
        const subjectIds = [...new Set(targets.map(message => message.senderId))];
        const query = targets.map(message => message.text).join('\n').slice(0, 4000);
        const candidates = memoryStore.recall(query, subjectIds, config.memory.recallTokens, 8);
        if (embeddings && query) {
          try { candidates.push(...await embeddings.search(query, subjectIds, 8, controller.signal)); }
          catch { if (!controller.signal.aborted) logEvent(logger,'warn','memory.recall.semantic_failed'); }
        }
        const selected: MemoryItem[] = []; const ids = new Set<string>(); let bytes = 0;
        for (const item of candidates) {
          if (ids.has(item.id)) continue;
          const size = Buffer.byteLength(JSON.stringify(item));
          if (bytes + size > config.memory.recallTokens || selected.length >= 8) continue;
          selected.push(item); ids.add(item.id); bytes += size;
        }
        logEvent(logger, 'info', 'memory.recall.completed', { items: selected.length, estimated_tokens: bytes });
        return { items: selected, historicalBackground: true };
      },
    } : {}),
    onCompacted: info => memory?.onCompacted(info),
  });
  const memoryHome = join(config.dataDir, 'memory-agent');
  const memoryWorkspace = join(config.dataDir, 'memory-workspace');
  for (const directory of [memoryHome, memoryWorkspace]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const memoryRunner = new PiRunner({
    home: memoryHome, workspace: memoryWorkspace, model: config.memory.model || config.agentModel || '',
    baseUrl: config.memory.baseUrl || config.agentBaseUrl || '', apiKey: config.memory.apiKey ?? config.agentApiKey,
    api: config.agentApi, supportsReasoning: config.agentSupportsReasoning, reasoning: 'off', supportsImages: false,
    contextWindow: config.agentContextWindow, compactLimit: config.agentCompactLimit,
    maxOutputTokens: Math.min(config.agentMaxOutputTokens, 8192), timeoutMs: Math.min(config.agentTimeoutMs, 180_000),
    allowCommands: false, allowFileWrites: false, persona: '', targetType: config.target.type,
    networkProxy: config.networkProxy, logger, presentationSecrets: secrets,
  });
  memory = new MemoryCoordinator({
    store: memoryStore, config: config.memory, runner: memoryRunner, logger, secrets,
    ...(identity ? {
      fetchControls: async signal => await workerRequest(identity, 'memory', undefined, signal) as { controls: MemoryControl[] },
      report: (view: MemoryView, receipts: MemoryReceipt[], signal: AbortSignal) => workerRequest(identity, 'memory', { view, receipts }, signal),
    } : {}),
    ...(embeddings ? { afterPublish: signal => embeddings.update(signal) } : {}),
  });
  const speech=createSpeechProvider(config.tts,logger,{fetch:speechNetwork.fetch,networkProxy:config.networkProxy});
  const scheduledStore=identity?new ScheduledStore(join(config.dataDir,'schedules.sqlite3')):undefined;
  const scheduler=identity&&scheduledStore?new Scheduler({
    store:scheduledStore,workspace:config.workspace,targetType:config.target.type,networkProxy:config.networkProxy,conversationId:()=>store.recorder.conversationId,
    fetchTasks:async()=>await workerRequest(identity,'tasks',undefined,controller.signal) as {tasks:ScheduledTask[];tickets:TaskTicket[]},
    authorize:async task=>(await workerRequest(identity,'tasks/authorize',{taskId:task.id,revision:task.revision},controller.signal) as {authorized:boolean}).authorized,
    applied:async value=>workerRequest(identity,'tasks/applied',value,controller.signal),
    executeModel:async(input,task,tools,signal,observer)=>agent.runScheduled(input,tools,signal,observer,task.timeoutSeconds*1000),
    send:async(request,context,signal)=>deliverTaskMessage({store:scheduledStore,chatStore:store,sender:napcat,logger,
      workspace:config.workspace,imageMaxBytes:config.imageMaxBytes,imageTimeoutMs:config.imageTimeoutMs,imageFetch:imageNetwork.fetch,
      replyMaxChars:config.replyMaxChars,speech,voiceReplyEnabled:config.voiceReplyEnabled,voiceReplyProbability:config.voiceReplyProbability,
      ttsMaxChars:config.tts.provider==='none'?undefined:config.tts.maxChars},request,context,signal),
    history:(task,scheduledAt)=>buildTaskHistory(store,task,scheduledAt,Math.max(0,config.agentContextWindow-config.agentMaxOutputTokens-48_000)),
    record:(type,payload,run,eventId,time)=>{
      const taskId=run?.taskId??(payload.taskId as string|undefined);
      const safe=safeToolPayload({...payload,...(taskId?{taskName:scheduledStore.task(taskId)?.name}:{})},secrets) as Record<string,unknown>;
      store.recorder.append(type,safe,eventId,{...(run?{runId:run.id,conversationId:run.conversationId}:{}),time});
    },logger,notify:()=>processor?.notify(),
  }):undefined;
  const taskTools:TaskTools|undefined=identity?{manage:async(request,operationId)=>{
    const actorId=store.senderForMessage(request.sourceMessageId);
    if(!actorId)throw new Error('任务请求来源无效');
    const result=await workerRequest(identity,'tasks/manage',{operationId,request,actorId},controller.signal);
    processor.notify();return result;
  }}:undefined;
  plugins = identity ? new PluginCoordinator({ identity, store, logger, notify: () => processor?.notify(),
    registerImages:(messageId,pluginId,assetIds)=>incomingImages.registerPlugin(messageId,pluginId,assetIds),
  }, controller.signal) : undefined;
  if(config.target.type==='group' && config.replyDecision.mode==='jev') {
    replyDecision=new ReplyDecisionCoordinator({store,config:config.replyDecision,
      configRevision:createHash('sha256').update(JSON.stringify(config.replyDecision)).digest('hex'),
      logger,signal:controller.signal,fetch:decisionNetwork.fetch,notify:()=>processor.notify()});
  }
  processor = new Processor({
    store, agent, sender: napcat, logger, batchSize: config.batchSize,
    replyMaxChars: config.replyMaxChars, retryMs: config.retryMs,
    workspace: config.workspace, imageMaxBytes: config.imageMaxBytes, imageTimeoutMs: config.imageTimeoutMs,imageFetch:imageNetwork.fetch,
    speech, voiceReplyEnabled: config.voiceReplyEnabled,
    voiceReplyProbability: config.voiceReplyProbability,
    ttsMaxChars: config.tts.provider === 'none' ? undefined : config.tts.maxChars,
    scheduler,taskTools,
    beforeContext:async(batch,signal)=>{
      await incomingForwards?.beforeContext(batch,signal);
      await plugins?.beforeContext(batch,signal);
    },
    ...(plugins ? { backgroundActions: plugins, helpText: () => plugins!.helpText } : {}),
  });
  logger.info(`启动 target=${config.target.type}:${config.target.id} random_reply_probability=${config.randomReplyProbability} web_search_provider=${config.webSearch.provider}`);
  logEvent(logger, 'info', 'app.state_loaded', {
    cursor: store.getCursor(), session_ref: store.getSessionId() ? fingerprint(store.getSessionId()!) : null,
    pending_command: store.getPendingCommand() !== null,
  });
  logEvent(logger, 'info', 'app.voice_configured', {
    provider: config.tts.provider, enabled: config.voiceReplyEnabled,
    probability: config.voiceReplyEnabled ? config.voiceReplyProbability : undefined,
  });
  logEvent(logger,'info','app.reply_strategy_configured',{mode:config.replyDecision.mode,
    enabled:config.target.type==='group'&&config.replyDecision.mode==='jev',
    ...(config.replyDecision.mode==='jev'?{model:config.replyDecision.model,threshold:config.replyDecision.threshold,timeout_ms:config.replyDecision.timeoutMs}:{probability:config.randomReplyProbability})});
  logEvent(logger,'info','network.configured',{enabled:config.networkProxy.enabled,revision:undefined,mode:config.networkProxy.enabled?'proxy':'direct',for_tools:config.networkProxy.forTools});
  void imageRecovery.then(() => incomingImages.start());
  napcat.start();
  plugins?.start();
  const done=processor.run(controller.signal);
  memory.start();
  const savedSession = store.getSessionId();
  const memoryRecovery = config.memory.enabled && config.memory.afterCompaction && savedSession
    ? validatePiSession(config.agentHome, savedSession).then(path => recoverMemoryCompactions(path, controller.signal, info => memory.onCompacted(info)))
      .catch(() => { if (!controller.signal.aborted) logEvent(logger, 'warn', 'memory.compaction.recovery_failed'); })
    : Promise.resolve();
  const embeddingTimer = embeddings ? setInterval(() => {
    void embeddings.update(controller.signal).catch(() => { if (!controller.signal.aborted) logEvent(logger,'warn','memory.embedding.failed'); });
  }, 30_000) : undefined;
  embeddingTimer?.unref();
  const scheduleTimer=scheduler?setInterval(()=>void scheduler.tick(),1000):undefined;
  scheduleTimer?.unref();void scheduler?.tick();
  let stopped:Promise<void>|undefined;
  return {
    store,get connected(){return napcat.connected;},get processing(){return processor.isProcessing;},get drained(){return processor.isDrained;},
    get transportConnected(){return napcat instanceof ConsoleTransport?napcat.transportConnected:napcat.connected;},
    get upstreamConnected(){return napcat instanceof ConsoleTransport?napcat.upstreamConnected:napcat.connected;},
    get qqOnline(){return napcat instanceof ConsoleTransport?napcat.qqOnline:napcat.connected;},
    requestDrain:()=>{processor.requestDrain();void memory.close();},done,
    probeNetwork:probeSignal=>probeNetwork(diagnostics,config.agentBaseUrl,AbortSignal.any([controller.signal,probeSignal])),
    stop:(beforeStoreClose)=>stopped??=(async()=>{
      clearInterval(scheduleTimer);clearInterval(embeddingTimer);controller.abort();await napcat.stop();
      try{await done;}finally{try{await replyDecision?.close();await plugins?.close();await imageRecovery;await incomingImages.close();await memory.close();await memoryRecovery;await embeddings?.update(controller.signal).catch(()=>{});await scheduler?.close();scheduler?.flushEvents();await beforeStoreClose?.();scheduledStore?.close();embeddings?.close();memoryStore.close();store.close();}finally{signal.removeEventListener('abort',parentAbort);await Promise.all([imageNetwork.close(),speechNetwork.close(),diagnostics.close(),memoryNetwork.close(),decisionNetwork.close()]);}}
    })(),
  };
}

async function main(): Promise<void> {
  const controller=new AbortController();
  const stop=(signal:NodeJS.Signals)=>{logEvent(logger,'info','app.stop_requested',{signal});controller.abort();};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try {
    const identity=managedIdentity(process.env);
    if(identity)await runManagedWorker(identity,process.env,logger,controller.signal,(config,signal)=>createRuntime(config,signal,identity));
    else {
      const runtime=createRuntime(loadConfig(),controller.signal);
      try{await runtime.done;}finally{await runtime.stop();}
    }
  }finally {
    process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
    logEvent(logger,'info','app.stopped');
  }
}

main().catch((error: unknown) => {
  // 配置及本地存储错误可用于诊断；网络/CLI 层只抛脱敏后的固定错误。
  logger.error(error instanceof Error ? error.message : '启动失败');
  process.exitCode = 1;
});
