import type { MemoryConfig } from './memory-contract.js';
import { resolve } from 'node:path';
import type { Target } from './types.js';
import { loadWebSearchConfig, type WebSearchConfig } from './web-search.js';
import { loadTtsConfig, type TtsConfig } from './tts.js';
import { loadNetworkProxyConfig, type NetworkProxyConfig } from './network.js';

export interface Config {
  target: Target;
  wsUrl: string;
  token: string;
  dataDir: string;
  agentHome: string;
  workspace: string;
  agentModel?: string;
  agentBaseUrl?: string;
  agentApiKey?: string;
  agentApi: 'openai-responses' | 'openai-completions';
  agentReasoning?: string;
  agentContextWindow: number;
  agentCompactLimit: number;
  agentMaxOutputTokens: number;
  agentKeepRecentTokens: number;
  agentSummaryMaxTokens: number;
  memory: MemoryConfig;
  agentSupportsImages: boolean;
  agentSupportsReasoning: boolean;
  allowCommands: boolean;
  allowFileWrites: boolean;
  taskCreatorOnly: boolean;
  persona: string;
  networkProxy: NetworkProxyConfig;
  webSearch: WebSearchConfig;
  tts: TtsConfig;
  voiceReplyEnabled: boolean;
  voiceReplyProbability: number;
  agentTimeoutMs: number;
  randomReplyProbability: number;
  batchSize: number;
  replyMaxChars: number;
  retryMs: number;
  reconnectMs: number;
  actionTimeoutMs: number;
  imageMaxBytes: number;
  imageTimeoutMs: number;
  /** Persistent inbound images in this Worker's volume; unrelated to model context lifetime. */
  imageCacheDays: number;
  imageCacheMaxBytes: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const type = env.TARGET_TYPE;
  if (type !== 'group' && type !== 'private') throw new Error('TARGET_TYPE 必须为 group 或 private');
  const id = env.TARGET_ID ?? '';
  if (!/^[1-9]\d*$/.test(id)) throw new Error('TARGET_ID 必须为正整数形式的 QQ 号或群号');
  let url: URL;
  try { url = new URL(env.NAPCAT_WS_URL ?? ''); }
  catch { throw new Error('NAPCAT_WS_URL 必须为有效的 ws:// 或 wss:// 地址'); }
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('NAPCAT_WS_URL 必须使用 ws/wss，凭据通过 NAPCAT_TOKEN 提供');
  }
  const number = (name: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number => {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isSafeInteger(value) || value <= 0 || value > max) throw new Error(`${name} 必须为 1 至 ${max} 的整数`);
    return value;
  };
  // Legacy names are accepted only as input. Agent state always starts in its own directory.
  const agentValue = (name: string, legacy?: string): string | undefined => env[name] ?? (legacy ? env[legacy] : undefined);
  const tokenLimit = (name: string, fallback: number, legacy?: string): number => {
    const input = agentValue(name, legacy)?.trim();
    if (!input) return fallback;
    const value = Number(input);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} 必须为正的安全整数`);
    return value;
  };
  const boolean = (name: string, fallback: boolean): boolean => {
    const input = env[name]?.trim();
    if (input === undefined) return fallback;
    if (input !== 'true' && input !== 'false') throw new Error(`${name} 必须为 true 或 false`);
    return input === 'true';
  };
  const probability = env.RANDOM_REPLY_PROBABILITY === undefined ? 0.05 : Number(env.RANDOM_REPLY_PROBABILITY);
  if (env.RANDOM_REPLY_PROBABILITY === '' || !Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new Error('RANDOM_REPLY_PROBABILITY 必须为 0 至 1 的数字');
  }
  const legacySandbox = env.CODEX_SANDBOX;
  if (legacySandbox !== undefined && !['read-only', 'workspace-write', 'danger-full-access'].includes(legacySandbox)) {
    throw new Error('CODEX_SANDBOX 必须为 read-only、workspace-write 或 danger-full-access');
  }
  const agentModel = agentValue('AGENT_MODEL', 'CODEX_MODEL')?.trim() || undefined;
  if (agentModel && (agentModel.length > 1024 || /[\x00-\x1f\x7f]/u.test(agentModel))) throw new Error('AGENT_MODEL 模型名称无效');
  const baseUrl = agentValue('AGENT_BASE_URL', 'CODEX_BASE_URL')?.trim() || undefined;
  let agentBaseUrl: string | undefined;
  if (baseUrl) {
    let providerUrl: URL;
    try { providerUrl = new URL(baseUrl); }
    catch { throw new Error('AGENT_BASE_URL 必须为有效的 http:// 或 https:// 地址'); }
    if (!['http:', 'https:'].includes(providerUrl.protocol) || !providerUrl.hostname
      || providerUrl.username || providerUrl.password || baseUrl.includes('?') || baseUrl.includes('#')) {
      throw new Error('AGENT_BASE_URL 必须使用 http/https，且不含凭据、查询参数或片段；凭据通过 AGENT_API_KEY 提供');
    }
    agentBaseUrl = providerUrl.toString().replace(/\/+$/, '');
    if (!agentModel) throw new Error('设置 AGENT_BASE_URL 时必须同时设置 AGENT_MODEL');
  }
  const apiKey = agentValue('AGENT_API_KEY', 'CODEX_API_KEY');
  const agentApiKey = apiKey?.trim() ? apiKey : undefined;
  const agentReasoning = agentValue('AGENT_REASONING', 'CODEX_REASONING_EFFORT')?.trim() || undefined;
  if (agentReasoning && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(agentReasoning)) {
    throw new Error('AGENT_REASONING 必须为 none、minimal、low、medium、high、xhigh 或 max');
  }
  const agentApi = env.AGENT_API?.trim() || 'openai-responses';
  if (agentApi !== 'openai-responses' && agentApi !== 'openai-completions') throw new Error('AGENT_API 必须为 openai-responses 或 openai-completions');
  const agentContextWindow = tokenLimit('AGENT_CONTEXT_WINDOW', 200_000, 'CODEX_CONTEXT_WINDOW');
  const agentCompactLimit = tokenLimit('AGENT_AUTO_COMPACT_TOKEN_LIMIT', 160_000, 'CODEX_AUTO_COMPACT_TOKEN_LIMIT');
  const agentMaxOutputTokens = tokenLimit('AGENT_MAX_OUTPUT_TOKENS', 8192);
  if (agentCompactLimit >= agentContextWindow) throw new Error('AGENT_AUTO_COMPACT_TOKEN_LIMIT 必须小于 AGENT_CONTEXT_WINDOW');
  if (agentMaxOutputTokens > agentContextWindow - agentCompactLimit) throw new Error('AGENT_MAX_OUTPUT_TOKENS 不能大于上下文窗口与自动压缩阈值之间的预留量');
  const agentKeepRecentTokens = tokenLimit('AGENT_KEEP_RECENT_TOKENS', Math.min(20_000, Math.max(1, Math.floor(agentCompactLimit / 4))));
  const agentSummaryMaxTokens = tokenLimit('AGENT_SUMMARY_MAX_TOKENS', Math.min(4000, agentMaxOutputTokens));
  if (agentKeepRecentTokens >= agentCompactLimit) throw new Error('AGENT_KEEP_RECENT_TOKENS 必须小于自动压缩阈值');
  if (agentSummaryMaxTokens > agentMaxOutputTokens) throw new Error('AGENT_SUMMARY_MAX_TOKENS 不能大于最大输出量');
  const memoryUrl = (name: string): string => {
    const input = env[name]?.trim() ?? ''; if (!input) return '';
    let value: URL; try { value = new URL(input); } catch { throw new Error(`${name} 必须为有效的 HTTP 地址`); }
    if (!['http:', 'https:'].includes(value.protocol) || value.username || value.password || value.search || value.hash) throw new Error(`${name} 必须为不含凭据的 HTTP 地址`);
    return value.toString().replace(/\/+$/, '');
  };
  const memoryTime = env.MEMORY_DAILY_TIME ?? '04:00';
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(memoryTime)) throw new Error('MEMORY_DAILY_TIME 必须为 HH:mm');
  const memoryZone = env.MEMORY_TIMEZONE ?? 'Asia/Shanghai';
  try { new Intl.DateTimeFormat('en', { timeZone: memoryZone }).format(); } catch { throw new Error('MEMORY_TIMEZONE 必须为有效 IANA 时区'); }
  const embeddingProvider = env.MEMORY_EMBEDDING_PROVIDER ?? 'none';
  if (!['none', 'openai-compatible'].includes(embeddingProvider)) throw new Error('MEMORY_EMBEDDING_PROVIDER 选项无效');
  const memory: MemoryConfig = { enabled: boolean('MEMORY_ENABLED', false), dailyEnabled: boolean('MEMORY_DAILY_ENABLED', true), dailyTime: memoryTime, timezone: memoryZone,
    afterCompaction: boolean('MEMORY_AFTER_COMPACTION', true), recallTokens: number('MEMORY_RECALL_TOKENS', 3000, 16000),
    model: env.MEMORY_MODEL?.trim() ?? '', baseUrl: memoryUrl('MEMORY_BASE_URL'), apiKey: env.MEMORY_API_KEY || undefined,
    embeddingProvider: embeddingProvider as MemoryConfig['embeddingProvider'], embeddingBaseUrl: memoryUrl('MEMORY_EMBEDDING_BASE_URL'),
    embeddingModel: env.MEMORY_EMBEDDING_MODEL?.trim() ?? '', embeddingApiKey: env.MEMORY_EMBEDDING_API_KEY || undefined };
  for (const value of [memory.model, memory.embeddingModel]) if (value.length > 1024 || /[\x00-\x1f\x7f]/u.test(value)) throw new Error('MEMORY_MODEL 模型名称无效');
  if (memory.embeddingProvider !== 'none' && (!memory.embeddingBaseUrl || !memory.embeddingModel)) throw new Error('MEMORY_EMBEDDING_PROVIDER 启用时必须填写服务地址与模型');
  const agentTimeoutMs = Number(agentValue('AGENT_TIMEOUT_MS', 'CODEX_TIMEOUT_MS') ?? 600_000);
  if (!Number.isSafeInteger(agentTimeoutMs) || agentTimeoutMs <= 0) throw new Error('AGENT_TIMEOUT_MS 必须为正的安全整数');
  const dataDir = resolve(env.DATA_DIR ?? './data');
  const tts = loadTtsConfig(env);
  const voiceSwitch = env.VOICE_REPLY_ENABLED?.trim() ?? 'false';
  if (voiceSwitch !== 'true' && voiceSwitch !== 'false') {
    throw new Error('VOICE_REPLY_ENABLED 必须为 true 或 false');
  }
  const voiceReplyEnabled = voiceSwitch === 'true';
  let voiceReplyProbability = 0.2;
  if (voiceReplyEnabled) {
    if (tts.provider === 'none') throw new Error('开启语音回复时必须设置 TTS_PROVIDER');
    const input = env.VOICE_REPLY_PROBABILITY?.trim();
    voiceReplyProbability = input === undefined ? 0.2 : Number(input);
    if (input === '' || !Number.isFinite(voiceReplyProbability) || voiceReplyProbability < 0 || voiceReplyProbability > 1) {
      throw new Error('VOICE_REPLY_PROBABILITY 必须为 0 至 1 的数字');
    }
  }
  return {
    target: { type, id }, wsUrl: url.toString(), token: env.NAPCAT_TOKEN ?? '', dataDir,
    agentHome: resolve(env.AGENT_HOME ?? `${dataDir}/pi`),
    workspace: resolve(agentValue('AGENT_WORKSPACE', 'CODEX_WORKSPACE') ?? `${dataDir}/workspace`),
    agentModel, agentBaseUrl, agentApiKey, agentApi, agentReasoning,
    agentContextWindow, agentCompactLimit, agentMaxOutputTokens, agentKeepRecentTokens, agentSummaryMaxTokens, memory,
    agentSupportsImages: boolean('AGENT_SUPPORTS_IMAGES', true),
    agentSupportsReasoning: boolean('AGENT_SUPPORTS_REASONING', true),
    allowCommands: boolean('AGENT_ALLOW_COMMANDS', legacySandbox === 'danger-full-access'),
    allowFileWrites: boolean('AGENT_ALLOW_FILE_WRITES', legacySandbox !== 'read-only'),
    taskCreatorOnly: boolean('TASK_CREATOR_ONLY', true),
    persona: env.AGENT_PERSONA ?? '',
    networkProxy: loadNetworkProxyConfig(env),
    webSearch: loadWebSearchConfig(env),
    tts, voiceReplyEnabled, voiceReplyProbability,
    agentTimeoutMs,
    randomReplyProbability: probability,
    batchSize: number('BATCH_SIZE', 50, 1000),
    replyMaxChars: number('REPLY_MAX_CHARS', 1500, 10_000),
    retryMs: number('RETRY_MS', 5000), reconnectMs: number('RECONNECT_MS', 3000),
    actionTimeoutMs: number('ACTION_TIMEOUT_MS', 15_000),
    imageMaxBytes: number('IMAGE_MAX_BYTES', 10 * 1024 * 1024),
    imageTimeoutMs: number('IMAGE_TIMEOUT_MS', 15_000),
    imageCacheDays: number('IMAGE_CACHE_DAYS', 30, Math.floor(Number.MAX_SAFE_INTEGER / 86_400_000)),
    imageCacheMaxBytes: number('IMAGE_CACHE_MAX_BYTES', 2048 * 1024 * 1024),
  };
}
