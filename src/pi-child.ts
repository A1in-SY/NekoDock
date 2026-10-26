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

const send = (message: PiChildMessage) => { if (process.connected) process.send?.(message); };
let session: AgentSession | undefined;
let started = false; let cancelled = false;
const thinking=new ThinkingObserver(event=>send({type:'event',event}));
const pending = new Map<string, { resolve(): void; reject(error: Error): void }>();
process.on('message', (raw: PiParentMessage) => {
  if (raw.type === 'abort') {
    cancelled = true;
    for (const request of pending.values()) request.reject(new Error('Reply request unavailable. Do not resend automatically.'));
    pending.clear(); void session?.abort();
  } else if (raw.type === 'send-result') {
    const request = pending.get(raw.id); pending.delete(raw.id);
    if (raw.accepted) request?.resolve(); else request?.reject(new Error('Reply request unavailable. Do not resend automatically.'));
  } else if (raw.type === 'start' && !started) {
    started = true;
    void execute(raw).then(() => finish({ type: 'done' }), error => finish({ type: 'failure', code: cancelled ? 'PI_ABORTED' : 'PI_EXECUTION_FAILED',
      message: error instanceof Error ? error.message : 'Agent execution failed.' }));
  }
});
process.on('disconnect', () => { cancelled = true; void session?.abort(); setTimeout(() => process.exit(1), 50).unref(); });

function finish(message: PiChildMessage): void {
  thinking.finish(message.type==='done'?'completed':'failed');
  session?.dispose();
  if (!process.connected) { process.exit(message.type === 'done' ? 0 : 1); return; }
  process.send?.(message, () => { process.disconnect(); process.exit(message.type === 'done' ? 0 : 1); });
}

function loader(system: string, failed: () => boolean): ResourceLoader {
  const guard: Extension = { path: '<bridge:single-attempt>', resolvedPath: '<bridge:single-attempt>',
    sourceInfo: createSyntheticSourceInfo('<bridge:single-attempt>', { source: 'sdk' }),
    handlers: new Map([['session_before_compact', [async (...args: unknown[]) => {
      const event = args[0] as SessionBeforeCompactEvent;
      return event.willRetry || event.reason === 'overflow' || failed() ? { cancel: true } : undefined;
    }]]]),
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
  const manager = start.session ? SessionManager.open(start.session, sessions, config.workspace) : SessionManager.create(config.workspace, sessions);
  terminateUnfinishedTools(manager);
  if (start.operation === 'append') {
    manager.appendMessage({ role: 'user', content: [{ type: 'text', text: start.prompt }, ...start.images], timestamp: Date.now() });
    const path = manager.getSessionFile(); if (!path) throw new Error('Missing persisted session.');
    await access(path); send({ type: 'session', path }); return;
  }
  const credentials = new InMemoryCredentialStore();
  await credentials.modify('bridge', async () => ({ type: 'api_key', key: config.apiKey || 'not-required' }));
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider('bridge', { name: 'Configured model provider', api: config.api, baseUrl: config.baseUrl,
    models: [{ id: config.model, name: config.model, api: config.api, baseUrl: config.baseUrl,
      reasoning: config.supportsReasoning, input: config.supportsImages ? ['text', 'image'] : ['text'],
      thinkingLevelMap: { off: 'none', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
      contextWindow: config.contextWindow, maxTokens: config.maxOutputTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  const model = runtime.getModel('bridge', config.model);
  if (!model) throw new Error('Configured model is unavailable.');
  const tools = createPiTools(config, async (request, signal) => {
    if (cancelled || signal?.aborted) throw new Error('Reply request unavailable.');
    const id = randomUUID();
    await new Promise<void>((resolveSend, reject) => {
      pending.set(id, { resolve: resolveSend, reject });
      send({ type: 'send', id, request });
      // Acceptance may already be committing in the parent. Wait for its result;
      // process cancellation is bounded by the parent's process-group timeout.
    });
  });
  let sessionReported = false; let settled = false; let failure: string | undefined;
  const settings = SettingsManager.inMemory({
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0, maxRetryDelayMs: 0 } },
    compaction: { enabled: true, reserveTokens: config.contextWindow - config.compactLimit,
      keepRecentTokens: Math.min(20_000, Math.max(100, Math.floor(config.compactLimit / 4))) },
    transport: 'sse', cacheWarming: 'off', enableAnalytics: false, enableInstallTelemetry: false,
    enableSkillCommands: false, images: { blockImages: !config.supportsImages },
  });
  const result = await createAgentSession({ cwd: config.workspace, agentDir: config.home, modelRuntime: runtime,
    model, thinkingLevel: (config.supportsReasoning && config.reasoning !== 'none' ? config.reasoning ?? 'off' : 'off') as ThinkingLevel,
    settingsManager: settings, sessionManager: manager, resourceLoader: loader(start.system, () => !!failure || cancelled),
    tools: start.operation === 'compact' ? [] : tools.map(tool => tool.name), customTools: tools, noTools: 'builtin' });
  session = result.session; session.setAutoRetryEnabled(false);
  if (cancelled) { await session.abort(); throw new Error('Agent cancelled.'); }
  const reportSession = () => {
    const path = manager.getSessionFile();
    if (path && existsSync(path) && !sessionReported) { sessionReported = true; send({ type: 'session', path }); }
  };
  const observe = (event: AgentSessionEvent) => {
    if(event.type==='message_start'&&event.message.role==='assistant')thinking.start();
    if(event.type==='message_update'&&event.message.role==='assistant')thinking.update(event.message as AssistantMessage);
    // Public message_end is emitted immediately before synchronous session
    // persistence. Report its file on the following microtask, never earlier.
    if (event.type === 'message_end') queueMicrotask(reportSession);
    if (event.type === 'entry_appended') {
      reportSession();
      const entry = event.entry;
      if ((entry.type === 'compaction' || entry.type === 'usage' || entry.type === 'branch_summary') && entry.usage) reportUsage(entry.usage, entry.id);
    }
    if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
      const complete = event.type === 'tool_execution_end';
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
    if (failure || cancelled) throw new Error(failure || 'Agent cancelled.');
  }
  if (cancelled) throw new Error('Agent cancelled.');
  const usage = session.getContextUsage();
  send({ type: 'event', event: { type: 'context.updated', payload: { used: usage?.tokens ?? null,
    window: config.contextWindow, estimated: true, compactLimit: config.compactLimit } } });
  reportSession();
}
