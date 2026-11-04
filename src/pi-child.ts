import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createAgentSession, createExtensionRuntime, createSyntheticSourceInfo, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type AgentSessionEvent, type Extension, type ResourceLoader, type SessionBeforeCompactEvent } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore, InMemoryModelsStore, type AssistantMessage, type Usage } from '@earendil-works/pi-ai';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import { createPiTools } from './pi-tools.js';
import type { PiChildMessage, PiParentMessage, PiStart } from './pi-protocol.js';
import { ThinkingObserver } from './pi-thinking.js';
import { createNetworkClient } from './network.js';
import { createMemoryTools, injectRecalledMemory } from './pi-memory.js';
import { createChatCheckpoint } from './pi-compaction.js';
import type { MemoryProposal, MemoryHistorySearch, MemorySearch } from './memory-contract.js';
import { committedContext, prepareContextInput, modelContextMessages } from './pi-context.js';
import { MODEL_IMAGE_OPTIONS } from './model-image.js';

const send = (message: PiChildMessage) => {
  if(process.connected)try{process.send?.(message,()=>{});}catch{/* The parent can close between the connected check and send. */}
};
let session: AgentSession | undefined;
let started = false; let cancelled = false;
const thinking=new ThinkingObserver(event=>send({type:'event',event}));
const pending = new Map<string, { resolve(): void; reject(error: Error): void }>();
const pendingTasks=new Map<string,{resolve(value:unknown):void;reject(error:Error):void}>();
process.on('message', (raw: PiParentMessage) => {
  if (raw.type === 'abort') {
    cancelled = true;
    for (const request of pending.values()) request.reject(new Error('Reply request unavailable. Do not resend automatically.'));
    pending.clear(); void session?.abort();
    for(const request of pendingTasks.values())request.reject(new Error('Task operation interrupted.'));
    pendingTasks.clear();
  } else if (raw.type === 'send-result') {
    const request = pending.get(raw.id); pending.delete(raw.id);
    if (raw.accepted) request?.resolve(); else request?.reject(new Error('Reply request unavailable. Do not resend automatically.'));
  } else if(raw.type==='task-result'||raw.type==='memory-result') {
    const request=pendingTasks.get(raw.id);pendingTasks.delete(raw.id);
    if(raw.ok)request?.resolve(raw.result);else request?.reject(new Error(raw.error??'Task operation unavailable.'));
  } else if (raw.type === 'start' && !started) {
    started = true;
    void execute(raw).then(() => finish({ type: 'done' }), error => finish({ type: 'failure', code: cancelled ? 'PI_ABORTED'
      : (error as {code?:string})?.code === 'PI_CONTEXT_ALREADY_COMMITTED' ? 'PI_CONTEXT_ALREADY_COMMITTED'
      : (error as {code?:string})?.code === 'PI_MEMORY_STAGE_ATTEMPTS_EXHAUSTED' ? 'PI_MEMORY_STAGE_ATTEMPTS_EXHAUSTED' : 'PI_EXECUTION_FAILED',
      message: error instanceof Error ? error.message : 'Agent execution failed.',
      ...(!cancelled && (error as {modelFailure?:unknown})?.modelFailure === true ? {modelFailure:true as const} : {}) }));
  }
});
process.on('disconnect', () => { cancelled = true; void session?.abort(); setTimeout(() => process.exit(1), 50).unref(); });

function finish(message: PiChildMessage): void {
  thinking.finish(message.type==='done'?'completed':'failed');
  session?.dispose();
  if (!process.connected) { process.exit(message.type === 'done' ? 0 : 1); return; }
  process.send?.(message, () => { process.disconnect(); process.exit(message.type === 'done' ? 0 : 1); });
}

function loader(system: string, failed: () => boolean,
  compact: (event: SessionBeforeCompactEvent) => Promise<unknown>, context?: (event: unknown) => unknown): ResourceLoader {
  const handlers: Extension['handlers'] = new Map([['session_before_compact', [async (...args: unknown[]) => {
    const event = args[0] as SessionBeforeCompactEvent;
    return event.willRetry || event.reason === 'overflow' || failed() ? { cancel: true } : compact(event);
  }]]]);
  if (context) handlers.set('context', [async (...args: unknown[]) => context(args[0])]);
  const guard: Extension = { path: '<bridge:single-attempt>', resolvedPath: '<bridge:single-attempt>',
    sourceInfo: createSyntheticSourceInfo('<bridge:single-attempt>', { source: 'sdk' }),
    handlers,
    tools: new Map(), messageRenderers: new Map(), commands: new Map(), flags: new Map(), shortcuts: new Map() };
  const extensions = { extensions: [guard], errors: [], runtime: createExtensionRuntime() };
  return { getExtensions: () => extensions, getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }), getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }), getSystemPrompt: () => system, getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources: () => {}, reload: async () => {} };
}

/** Finish interrupted tool-call records without executing or querying the tools again. */
function terminateUnfinishedTools(manager: SessionManager): void {
  const calls = new Map<string, string>();
  for (const entry of manager.getBranch()) {
    if (entry.type !== 'message') continue;
    const message = entry.message;
    if (message.role === 'assistant') for (const part of message.content) if (part.type === 'toolCall') calls.set(part.id, part.name);
    if (message.role === 'toolResult') calls.delete(message.toolCallId);
  }
  for (const [id, name] of calls) manager.appendMessage({ role: 'toolResult', toolCallId: id, toolName: name,
    content: [{ type: 'text', text: 'This tool call was interrupted. It will not be executed again. Do not automatically resend prior chat replies.' }],
    isError: true, timestamp: Date.now() });
}

async function execute(start: PiStart): Promise<void> {
  if (cancelled) throw new Error('Agent cancelled.');
  const config = start.config;
  const sessions = resolve(config.home, 'sessions'); await mkdir(sessions, { recursive: true, mode: 0o700 });
  const manager = start.operation === 'memory' ? SessionManager.inMemory(config.workspace)
    : start.session ? SessionManager.open(start.session, sessions, config.workspace) : SessionManager.create(config.workspace, sessions);
  terminateUnfinishedTools(manager);
  let contextReported = false;
  const reportContext = (required = false) => {
    if (!start.context || contextReported) return;
    const receipt = committedContext(manager, start.context.submission.batchId);
    if (receipt) { contextReported = true; send({type:'context-committed',receipt}); }
    else if(required)throw new Error('Input context was not persisted before execution.');
  };
  if (start.context) {
    const existing = committedContext(manager, start.context.submission.batchId);
    if (existing) {
      send({type:'session',path:existing.session}); send({type:'context-committed',receipt:existing});
      if (start.operation === 'append') return;
      throw Object.assign(new Error('Generation is not replayed after its input was committed.'), {code:'PI_CONTEXT_ALREADY_COMMITTED'});
    }
    const input = JSON.parse(start.prompt) as {replyTargetMessageIds:string[]};
    const prepared = prepareContextInput(manager, start.context, input.replyTargetMessageIds ?? []);
    start.prompt = prepared.prompt; start.images = prepared.images;
  }
  if (start.operation === 'append') {
    manager.appendMessage({ role: 'user', content: [{ type: 'text', text: start.prompt }, ...start.images], timestamp: Date.now() });
    const path = manager.getSessionFile(); if (!path) throw new Error('Missing persisted session.');
    await access(path); send({ type: 'session', path }); reportContext(true); return;
  }
  // This process handles one instance and has no Console HTTP transport.
  // Installing its fetch here also covers the SDK's summarization requests.
  const networkLogger = {
    info: message => send({type:'network-log',level:'info',message}),
    warn: message => send({type:'network-log',level:'warn',message}),
    error: message => send({type:'network-log',level:'error',message}),
  } satisfies import('./types.js').Logger;
  const network = createNetworkClient(config.networkProxy, networkLogger,'model');
  const searchNetwork = createNetworkClient(config.networkProxy,networkLogger,'search');
  globalThis.fetch = network.fetch;
  const credentials = new InMemoryCredentialStore();
  await credentials.modify('bridge', async () => ({ type: 'api_key', key: config.apiKey || 'not-required' }));
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider('bridge', { name: 'Configured model provider', api: config.api, baseUrl: config.baseUrl,
    models: [{ id: config.model, name: config.model, api: config.api, baseUrl: config.baseUrl,
      reasoning: config.supportsReasoning, input: config.supportsImages ? ['text', 'image'] : ['text'],
      inputLimits: { images: { resize: MODEL_IMAGE_OPTIONS } },
      thinkingLevelMap: { off: 'none', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
      contextWindow: config.contextWindow, maxTokens: config.maxOutputTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  const model = runtime.getModel('bridge', config.model);
  if (!model) throw new Error('Configured model is unavailable.');
  const taskRpc=(message:{type:'task-manage';request:import('./scheduled-contract.js').TaskToolRequest;operationId:string}|{type:'task-state';data:Record<string,unknown>;expectedVersion:number})=>{
    if(cancelled)throw new Error('Task operation cancelled.');
    const id=randomUUID();return new Promise<unknown>((resolve,reject)=>{pendingTasks.set(id,{resolve,reject});send({...message,id});});
  };
  const memoryRpc = (message: {type:'memory-query';operation:'search';request:MemorySearch}|{type:'memory-query';operation:'history';request:MemoryHistorySearch}|{type:'memory-stage';changes:MemoryProposal[]}) => {
    if (cancelled) throw new Error('Memory operation cancelled.');
    const id = randomUUID(); return new Promise<unknown>((resolve, reject) => { pendingTasks.set(id, {resolve,reject}); send({...message,id}); });
  };
  const memoryReads = {
    search: (request:MemorySearch) => memoryRpc({type:'memory-query',operation:'search',request}),
    history: (request:MemoryHistorySearch) => memoryRpc({type:'memory-query',operation:'history',request}),
  };
  let memoryStageAccepted = false; let memoryStageAttempts = 0; let memoryStageFailure: string | undefined;
  const tools = start.operation === 'memory' ? createMemoryTools(memoryReads, async changes => {
    if (memoryStageAttempts > 3) throw new Error('MEMORY_STAGE_ATTEMPTS_EXCEEDED');
    try { await memoryRpc({type:'memory-stage',changes}); memoryStageAccepted = true; }
    catch (error) {
      if (memoryStageAttempts >= 3 && !memoryStageAccepted) memoryStageFailure = error instanceof Error ? error.message : 'MEMORY_STAGE_ATTEMPTS_EXCEEDED';
      throw error;
    }
  })
    : createPiTools(config, async (request, signal, toolCallId) => {
    if (cancelled || signal?.aborted) throw new Error('Reply request unavailable.');
    const id = randomUUID();
    await new Promise<void>((resolveSend, reject) => {
      pending.set(id, { resolve: resolveSend, reject });
      send({ type: 'send', id, request, ...(toolCallId ? {toolCallId} : {}) });
      // Acceptance may already be committing in the parent. Wait for its result;
      // process cancellation is bounded by the parent's process-group timeout.
    });
  }, { ...(start.taskManagement?{manage:(request,operationId)=>taskRpc({type:'task-manage',request,operationId})}:{}),
    ...(start.taskState?{saveState:(data,expectedVersion)=>taskRpc({type:'task-state',data,expectedVersion})}:{}) },{searchFetch:searchNetwork.fetch});
  if (start.operation === 'run' && start.memoryRead) tools.push(...createMemoryTools(memoryReads));
  let sessionReported = false; let settled = false; let failure: string | undefined; let memoryCalls = 0; let modelFailure = false;
  const settings = SettingsManager.inMemory({
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0, maxRetryDelayMs: 0 } },
    compaction: { enabled: start.operation !== 'memory', reserveTokens: config.contextWindow - config.compactLimit,
      keepRecentTokens: config.keepRecentTokens ?? Math.min(20_000, Math.max(100, Math.floor(config.compactLimit / 4))) },
    transport: 'sse', cacheWarming: 'off', enableAnalytics: false, enableInstallTelemetry: false,
    enableSkillCommands: false, images: { blockImages: !config.supportsImages },
  });
  const result = await createAgentSession({ cwd: config.workspace, agentDir: config.home, modelRuntime: runtime,
    model, thinkingLevel: (config.supportsReasoning && config.reasoning !== 'none' ? config.reasoning ?? 'off' : 'off') as ThinkingLevel,
    settingsManager: settings, sessionManager: manager, resourceLoader: loader(start.system, () => !!failure || cancelled || start.operation === 'memory', async event => {
      try { return { compaction: await createChatCheckpoint(event, config, model) }; }
      catch (error) {
        // Extension errors are swallowed by Pi; explicitly cancel so it cannot fall back and issue a second request.
        if (!cancelled && !failure && (error as {modelFailure?:unknown})?.modelFailure === true) modelFailure = true;
        failure ??= (error as {modelFailure?:unknown})?.modelFailure === true && error instanceof Error
          ? error.message : 'Chat checkpoint generation failed.';
        queueMicrotask(() => { void session?.abort(); });
        return { cancel: true };
      }
    }, start.operation === 'run' && (start.context || start.recalledMemory !== undefined) ? event => {
      try { reportContext(true); }
      catch { failure ??= 'Input context persistence failed.'; cancelled = true; void session?.abort(); return {messages:[]}; }
      const messages = (event as {messages:import('@earendil-works/pi-agent-core').AgentMessage[]}).messages;
      const recalled = start.recalledMemory === undefined ? messages : injectRecalledMemory(messages,
        start.prompt, start.recalledMemory, config, start.system, tools.map(tool => ({name:tool.name,description:tool.description,parameters:tool.parameters}))).messages;
      return { messages: modelContextMessages(recalled) };
    } : undefined),
    tools: start.operation === 'compact' ? [] : tools.map(tool => tool.name), customTools: tools, noTools: 'builtin' });
  session = result.session; session.setAutoRetryEnabled(false);
  const streamFunction = session.agent.streamFunction;
  // Only failures from the provider stream qualify; SDK lifecycle errors can
  // also appear as assistant errors after local persistence or context failures.
  session.agent.streamFunction = async (requestedModel, context, options) => {
    const markFailure = () => { if (!cancelled && !failure && !options?.signal?.aborted) modelFailure = true; };
    try {
      const stream = await streamFunction(requestedModel, context, options);
      const result = stream.result.bind(stream);
      stream.result = async () => {
        try {
          const message = await result();
          if (message.stopReason === 'error') markFailure();
          return message;
        } catch (error) { markFailure(); throw error; }
      };
      const iterate = stream[Symbol.asyncIterator].bind(stream);
      stream[Symbol.asyncIterator] = async function* () {
        try { yield* { [Symbol.asyncIterator]: iterate }; }
        catch (error) { markFailure(); throw error; }
      };
      return stream;
    } catch (error) { markFailure(); throw error; }
  };
  if (start.operation === 'memory') {
    const previousFinishTurn = session.agent.finishTurn;
    session.agent.finishTurn = async (turn, signal) => {
      const decision = await previousFinishTurn?.(turn, signal);
      // Finish after all tool results have been recorded, before another provider request.
      return memoryStageAccepted || memoryStageFailure ? { action: 'end' } : decision || undefined;
    };
  }
  if (cancelled) { await session.abort(); throw new Error('Agent cancelled.'); }
  const reportSession = () => {
    const path = manager.getSessionFile();
    if (path && existsSync(path) && !sessionReported) { sessionReported = true; send({ type: 'session', path }); }
  };
  const reportedCompactions = new Set<string>();
  const reportCompacted = (entryId: string) => {
    if (reportedCompactions.has(entryId) || (start.operation !== 'run' && start.operation !== 'compact')) return;
    const path = manager.getSessionFile();
    if (path && existsSync(path)) { reportedCompactions.add(entryId); send({type:'compacted',session:path,entryId}); }
  };
  const observe = (event: AgentSessionEvent) => {
    if(event.type==='message_start'&&event.message.role==='assistant')thinking.start();
    if(event.type==='message_update'&&event.message.role==='assistant')thinking.update(event.message as AssistantMessage);
    // Public message_end is emitted immediately before synchronous session
    // persistence. Report its file on the following microtask, never earlier.
    if (event.type === 'message_end') queueMicrotask(() => {
      reportSession();
      try { reportContext(); } catch { failure ??= 'Input context persistence failed.'; cancelled = true; void session?.abort(); }
    });
    if (event.type === 'entry_appended') {
      reportSession();
      const entry = event.entry;
      if ((entry.type === 'compaction' || entry.type === 'usage' || entry.type === 'branch_summary') && entry.usage) reportUsage(entry.usage, entry.id);
      if (entry.type === 'compaction') reportCompacted(entry.id);
    }
    if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
      const complete = event.type === 'tool_execution_end';
      if (start.operation === 'memory' && event.toolName === 'stage_memory_changes') {
        if (!complete) memoryStageAttempts++;
        if (complete && event.isError && memoryStageAttempts >= 3 && !memoryStageAccepted) memoryStageFailure ??= 'MEMORY_STAGE_ATTEMPTS_EXCEEDED';
      }
      if (!complete && start.operation === 'memory' && ++memoryCalls > 24) { failure ??= 'Memory job exceeded its tool-call budget.'; void session?.abort(); }
      send({ type: 'event', event: { type: complete ? 'tool.completed' : 'tool.started', itemId: event.toolCallId,
        payload: { tool: event.toolName, toolType: event.toolName === 'bash' ? 'command_execution' :
          ['web_search', 'web_fetch'].includes(event.toolName) ? 'web_search' : ['edit', 'write'].includes(event.toolName) ? 'file_change' : 'mcp_tool_call',
          status: complete ? event.isError ? 'failed' : 'completed' : 'in_progress',
          ...(complete ? { result: event.result, durationMs: event.durationMs } : { arguments: event.args,
            ...(event.toolName === 'bash' ? { command: event.args.command } : {}) }) } } });
    }
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      const message = event.message as AssistantMessage;
      thinking.finish(['error','aborted','length','deferred','pending'].includes(message.stopReason)?'failed':'completed',message);
      if (['error', 'aborted', 'length', 'deferred', 'pending'].includes(message.stopReason)) {
        failure ??= message.errorMessage || `Model stopped with ${message.stopReason}.`;
      }
      reportUsage(message.usage);
    }
    if (event.type === 'agent_settled') { settled = true; if (event.aborted) failure ??= 'Agent cancelled.'; }
    if (event.type === 'auto_retry_start' || (event.type === 'compaction_end' && event.willRetry)) {
      failure ??= 'Unexpected automatic retry prevented.'; cancelled = true; void session?.abort();
    }
    if (event.type === 'compaction_end' && event.errorMessage) {
      failure ??= event.errorMessage;
      // A threshold summary failure otherwise lets the SDK issue another
      // generation and attempt the same summary again at the end of the run.
      void session?.abort();
    }
    if (event.type === 'compaction_start' || event.type === 'compaction_end') send({ type: 'event', event: {
      type: event.type === 'compaction_start' ? 'compact.started' : event.errorMessage || event.aborted ? 'compact.failed' : 'compact.completed',
      payload: { reason: event.reason,
        ...(event.type === 'compaction_end' ? { aborted: event.aborted, status: event.errorMessage ? 'failed' : 'completed' } : {}) } } });
    if (event.type === 'compaction_end' && event.result?.usage) {
      const entry = manager.getBranch().findLast(entry => entry.type === 'compaction');
      reportUsage(event.result.usage, entry?.id);
    }
    if (event.type === 'compaction_end' && event.result && !event.aborted && !event.errorMessage) {
      const entry = manager.getBranch().findLast(entry => entry.type === 'compaction');
      if (entry) reportCompacted(entry.id);
    }
  };
  const usageRun = randomUUID(); let usageIndex = 0; const reportedUsage = new Set<string>();
  const reportUsage = (usage: Usage, entryId?: string) => {
    if (entryId && reportedUsage.has(entryId)) return;
    if (entryId) reportedUsage.add(entryId);
    const input = usage.input + usage.cacheRead + usage.cacheWrite;
    const known = input + usage.output > 0;
    send({ type: 'event', event: { type: 'usage.recorded', payload: { usageId: `${usageRun}:${++usageIndex}`, input_tokens: known ? input : null,
      cached_input_tokens: known ? usage.cacheRead : null, output_tokens: known ? usage.output : null,
      total_tokens: known ? input + usage.output : null } } });
  };
  session.subscribe(observe); reportSession();
  if (start.operation === 'compact') {
    await session.compact();
  } else {
    // Explicit in-memory extension permits normal threshold compaction and
    // cancels overflow/length recovery before any summarization or retry.
    await session.prompt(start.prompt, { images: start.images, expandPromptTemplates: false, source: 'rpc' });
    await session.waitForIdle();
    if (!settled) throw new Error('Agent did not settle.');
    if (failure || cancelled) throw Object.assign(new Error(failure || 'Agent cancelled.'), modelFailure && !cancelled ? {modelFailure:true} : {});
  }
  if (memoryStageFailure) throw Object.assign(new Error(memoryStageFailure), { code: 'PI_MEMORY_STAGE_ATTEMPTS_EXHAUSTED' });
  if (failure || cancelled) throw Object.assign(new Error(failure || 'Agent cancelled.'), modelFailure && !cancelled ? {modelFailure:true} : {});
  const usage = session.getContextUsage();
  send({ type: 'event', event: { type: 'context.updated', payload: { used: usage?.tokens ?? null,
    window: config.contextWindow, estimated: true, compactLimit: config.compactLimit } } });
  reportSession();
}
