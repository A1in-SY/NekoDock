import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { managedIdentity, runManagedWorker, type WorkerRuntime } from './managed-worker.js';
import { loadConfig, type Config } from './config.js';
import { BridgeStore } from './store.js';
import { PiRunner } from './pi.js';
import { NapCatClient } from './napcat.js';
import { handleIncomingEvent } from './incoming.js';
import { Processor } from './processor.js';
import { createLogger, fingerprint, logEvent } from './logging.js';
import { createSpeechProvider } from './tts.js';

const logger = createLogger();

function createRuntime(config:Config, signal:AbortSignal):WorkerRuntime {
  for (const path of [config.dataDir, config.agentHome, config.workspace]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const store = new BridgeStore(join(config.dataDir, 'bridge.sqlite3'), config.target);
  store.initializeAgentRuntime();
  const controller = new AbortController();
  const parentAbort=()=>controller.abort();
  signal.addEventListener('abort',parentAbort,{once:true});
  if(signal.aborted)controller.abort();
  let processor: Processor;
  const napcat = new NapCatClient({
    url: config.wsUrl, token: config.token, target: config.target, logger,
    reconnectMs: config.reconnectMs, actionTimeoutMs: config.actionTimeoutMs,
    onEvent: (event) => {
      try {
        handleIncomingEvent(event, {
          target: config.target, randomReplyProbability: config.randomReplyProbability,
          store, processor, sender: napcat, logger, signal: controller.signal,
        });
      } catch {
        logger.error('消息落库失败，停止实例；检查数据卷的可写权限和剩余空间');
        process.exitCode = 1;
        controller.abort();
      }
    },
  });
  const agent = new PiRunner({
    home: config.agentHome, workspace: config.workspace,
    timeoutMs: config.agentTimeoutMs, logger, model: config.agentModel ?? '',
    baseUrl: config.agentBaseUrl ?? '', apiKey: config.agentApiKey, api: config.agentApi,
    reasoning: config.agentReasoning === 'none' ? 'off' : config.agentReasoning,
    contextWindow: config.agentContextWindow, compactLimit: config.agentCompactLimit,
    maxOutputTokens: config.agentMaxOutputTokens, supportsImages: config.agentSupportsImages,
    supportsReasoning: config.agentSupportsReasoning, allowCommands: config.allowCommands,
    allowFileWrites: config.allowFileWrites, persona: config.persona,
    imageMaxBytes: config.imageMaxBytes, imageTimeoutMs: config.imageTimeoutMs,
    targetType: config.target.type,
    webSearch: config.webSearch,
    presentationSecrets:[config.token,config.tts.provider==='mimo'?config.tts.apiKey:'',process.env.WORKER_TOKEN??''],
  });
  processor = new Processor({
    store, agent, sender: napcat, logger, batchSize: config.batchSize,
    replyMaxChars: config.replyMaxChars, retryMs: config.retryMs,
    workspace: config.workspace, imageMaxBytes: config.imageMaxBytes, imageTimeoutMs: config.imageTimeoutMs,
    speech: createSpeechProvider(config.tts, logger), voiceReplyEnabled: config.voiceReplyEnabled,
    voiceReplyProbability: config.voiceReplyProbability,
    ttsMaxChars: config.tts.provider === 'none' ? undefined : config.tts.maxChars,
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
  napcat.start();
  const done=processor.run(controller.signal);
  let stopped:Promise<void>|undefined;
  return {
    store,get connected(){return napcat.connected;},get processing(){return processor.isProcessing;},get drained(){return processor.isDrained;},
    requestDrain:()=>processor.requestDrain(),done,
    stop:(beforeStoreClose)=>stopped??=(async()=>{
      controller.abort();await napcat.stop();
      try{await done;}finally{await beforeStoreClose?.();store.close();signal.removeEventListener('abort',parentAbort);}
    })(),
  };
}

async function main(): Promise<void> {
  const controller=new AbortController();
  const stop=(signal:NodeJS.Signals)=>{logEvent(logger,'info','app.stop_requested',{signal});controller.abort();};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try {
    const identity=managedIdentity(process.env);
    if(identity)await runManagedWorker(identity,process.env,logger,controller.signal,createRuntime);
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
