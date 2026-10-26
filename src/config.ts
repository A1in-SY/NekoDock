import { resolve } from 'node:path';
import type { Target } from './types.js';
import { loadWebSearchConfig, type WebSearchConfig } from './web-search.js';
import { loadTtsConfig, type TtsConfig } from './tts.js';

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
  agentSupportsImages: boolean;
  agentSupportsReasoning: boolean;
  allowCommands: boolean;
  allowFileWrites: boolean;
  persona: string;
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
    agentContextWindow, agentCompactLimit, agentMaxOutputTokens,
    agentSupportsImages: boolean('AGENT_SUPPORTS_IMAGES', true),
    agentSupportsReasoning: boolean('AGENT_SUPPORTS_REASONING', true),
    allowCommands: boolean('AGENT_ALLOW_COMMANDS', legacySandbox === 'danger-full-access'),
    allowFileWrites: boolean('AGENT_ALLOW_FILE_WRITES', legacySandbox !== 'read-only'),
    persona: env.AGENT_PERSONA ?? '',
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
  };
}
