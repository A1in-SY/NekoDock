import { loadConfig } from '../config.js';
import { NAPCAT_MEDIA_MAX_BYTES } from '../transport-protocol.js';
import { DEFAULT_NO_PROXY, normalizeNetworkProxy } from '../network.js';
import { SECRET_FIELDS, type BotSettings, type NapcatConnectionInput, type NapcatConnectionRecord } from './contracts.js';
import { normalizeMediaBaseUrl } from './plugin-assets.js';

const MiB = 1024 * 1024;

/** Credentials belong in the connection token field, never in its URL. */
export function normalizeNapcatUrl(value: string): string {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('NapCat WebSocket 地址无效');
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('NapCat WebSocket 地址无效'); }
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('NapCat 地址必须为不含凭据、查询参数或片段的 ws/wss 地址');
  return url.toString();
}

export function validateNapcatConnection(input: Partial<NapcatConnectionInput>, existing?: NapcatConnectionRecord): Omit<NapcatConnectionRecord, 'id' | 'revision' | 'accountId' | 'createdAt' | 'updatedAt'> {
  if (!record(input)) throw new Error('NapCat 连接配置必须为对象');
  const known = new Set(['name', 'wsUrl', 'token', 'reconnectSeconds', 'actionTimeout', 'enabled', 'expectedRevision','mediaBaseUrl']);
  for (const key of Object.keys(input)) if (!known.has(key)) throw new Error(`未知连接配置项：${key}`);
  const config = { name: existing?.name ?? '', wsUrl: existing?.wsUrl ?? '', token: existing?.token, reconnectSeconds: existing?.reconnectSeconds ?? 3, actionTimeout: existing?.actionTimeout ?? 15, enabled: existing?.enabled ?? true };
  if (input.name !== undefined) config.name = input.name;
  if (typeof config.name !== 'string' || !config.name.trim() || config.name.length > 80) throw new Error('连接名称必须为 1 至 80 字符');
  config.name = config.name.trim();
  config.wsUrl = normalizeNapcatUrl(input.wsUrl ?? config.wsUrl);
  if (input.token !== undefined) {
    if (input.token === null || input.token === '') config.token = undefined;
    else if (typeof input.token === 'string' && input.token.length <= 8192 && !/[\x00-\x1f\x7f]/u.test(input.token)) config.token = input.token;
    else throw new Error('NapCat Token 必须为有效密钥字符串或 null');
  }
  for (const field of ['reconnectSeconds', 'actionTimeout'] as const) {
    if (input[field] !== undefined) config[field] = input[field];
    positiveUnit(config[field], field, 1000);
  }
  if (input.enabled !== undefined) config.enabled = input.enabled;
  if (typeof config.enabled !== 'boolean') throw new Error('enabled 类型无效');
  const mediaBaseUrl=normalizeMediaBaseUrl(input.mediaBaseUrl??existing?.mediaBaseUrl??'');
  return {...config,...(mediaBaseUrl?{mediaBaseUrl}:{})};
}

/** Values in the management API use percentages, seconds and MiB. */
export function defaultSettings(): BotSettings {
  return {
    wsUrl: 'ws://host.docker.internal:3002/', model: '', baseUrl: '', modelApi: 'openai-responses', reasoning: '',
    contextWindow: 200_000, compactLimit: 160_000, compactKeepRecentTokens: 20_000, compactSummaryMaxTokens: 4000, maxOutputTokens: 8192,
    memoryEnabled: true, memoryDailyEnabled: true, memoryDailyTime: '04:00', memoryTimezone: 'Asia/Shanghai', memoryAfterCompaction: true, memoryRecallTokens: 3000,
    memoryModel: '', memoryBaseUrl: '', memoryEmbeddingProvider: 'none', memoryEmbeddingBaseUrl: '', memoryEmbeddingModel: '', supportsImages: true, supportsReasoning: true,
    allowCommands: false, allowFileWrites: true, taskCreatorOnly: true, persona: '', replyProbability: 5,
    proxyEnabled: false, proxyUrl: '', proxyNoProxy: DEFAULT_NO_PROXY, proxyForTools: true,
    searchProvider: 'none', searchBaseUrl: 'https://api.tavily.com', searchDepth: 'basic', searchResults: 8, searchTimeout: 30,
    voiceEnabled: false, voiceProbability: 20, ttsProvider: 'none',
    ttsBaseUrl: 'https://api.xiaomimimo.com/v1', ttsModel: 'mimo-v2.5-tts', ttsVoice: 'mimo_default', ttsStyle: '',
    edgeVoice: 'zh-CN-XiaoxiaoNeural', edgeRate: '+0%', edgePitch: '+0Hz', edgeVolume: '+0%',
    ttsTimeout: 30, ttsMaxChars: 300, ttsMaxMiB: 5, batchSize: 50, replyMaxChars: 1500,
    modelTimeout: 600, actionTimeout: 15, retrySeconds: 5, reconnectSeconds: 3, imageMaxMiB: 10, imageTimeout: 15,
    imageCacheDays: 30, imageCacheMaxMiB: 2048, imageTransitHours: 24, imageTransitMaxMiB: 1024,
  };
}

/** Read old stored settings without changing their revision or widening tool access. */
export function normalizeSettings(input: unknown): BotSettings {
  if (!record(input)) throw new Error('配置必须为对象');
  const config = defaultSettings();
  for (const key of [...Object.keys(config), ...SECRET_FIELDS]) {
    if (input[key] !== undefined) (config as unknown as Record<string, unknown>)[key] = input[key];
  }
  if (input.memoryEnabled === undefined) config.memoryEnabled = false;
  if (input.compactKeepRecentTokens === undefined) config.compactKeepRecentTokens = Math.min(20_000, Math.max(1, Math.floor(config.compactLimit / 4)));
  if (input.compactSummaryMaxTokens === undefined) config.compactSummaryMaxTokens = Math.min(4000, config.maxOutputTokens);
  const legacySandbox = input.sandbox;
  if (input.allowCommands === undefined) config.allowCommands = legacySandbox === 'danger-full-access';
  if (input.allowFileWrites === undefined) config.allowFileWrites = legacySandbox !== 'read-only';
  return config;
}

export function validateSettings(input: unknown, existing?: BotSettings): BotSettings {
  if (!record(input)) throw new Error('配置必须为对象');
  const config = existing ? normalizeSettings(existing) : defaultSettings();
  const known = new Set([...Object.keys(defaultSettings()), ...SECRET_FIELDS]);
  for (const [key, value] of Object.entries(input)) {
    if (!known.has(key)) throw new Error(`未知配置项：${key}`);
    if (value === undefined) continue;
    if (SECRET_FIELDS.includes(key as typeof SECRET_FIELDS[number])) {
      if (value === null) delete (config as unknown as Record<string, unknown>)[key];
      else if (typeof value === 'string' && value.length <= 8192 && !/[\x00-\x1f\x7f]/u.test(value)) {
        (config as unknown as Record<string, unknown>)[key] = value;
      } else throw new Error(`${key} 必须为有效密钥字符串或 null`);
      continue;
    }
    if ((key === 'contextWindow' || key === 'compactLimit') && (value === null || value === '')) {
      config[key] = defaultSettings()[key]; continue;
    }
    const expected = key === 'contextWindow' || key === 'compactLimit' ? 'number' : typeof config[key as keyof BotSettings];
    if (typeof value !== expected) throw new Error(`${key} 类型无效`);
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`${key} 必须为有效数字`);
    if (typeof value === 'string' && value.length > (key === 'persona' ? 200_000 : 16_000)) throw new Error(`${key} 内容过长`);
    (config as unknown as Record<string, unknown>)[key] = value;
  }
  for (const key of ['wsUrl', 'model', 'baseUrl', 'searchBaseUrl', 'ttsBaseUrl', 'ttsModel', 'ttsVoice', 'edgeVoice'] as const) config[key] = config[key].trim();
  oneOf(config.modelApi, ['openai-responses', 'openai-completions'], 'modelApi');
  oneOf(config.reasoning, ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], 'reasoning');
  oneOf(config.searchProvider, ['none', 'tavily'], 'searchProvider');
  oneOf(config.ttsProvider, ['none', 'edge-tts', 'mimo'], 'ttsProvider');
  probability(config.replyProbability, 'replyProbability');
  probability(config.voiceProbability, 'voiceProbability');
  for (const key of ['modelTimeout', 'actionTimeout', 'retrySeconds', 'reconnectSeconds', 'imageTimeout', 'imageMaxMiB'] as const) positiveUnit(config[key], key, key.endsWith('MiB') ? MiB : 1000);
  for (const key of ['imageCacheDays', 'imageCacheMaxMiB', 'imageTransitHours', 'imageTransitMaxMiB'] as const) integer(config[key], key);
  positiveUnit(config.imageCacheDays, 'imageCacheDays', 86_400_000);
  positiveUnit(config.imageTransitHours, 'imageTransitHours', 3_600_000);
  for (const key of ['imageCacheMaxMiB', 'imageTransitMaxMiB'] as const) positiveUnit(config[key], key, MiB);
  if (input.compactKeepRecentTokens === undefined && config.compactKeepRecentTokens >= config.compactLimit) config.compactKeepRecentTokens = Math.min(20_000, Math.max(1, Math.floor(config.compactLimit / 4)));
  if (input.compactSummaryMaxTokens === undefined && config.compactSummaryMaxTokens > config.maxOutputTokens) config.compactSummaryMaxTokens = Math.min(4000, config.maxOutputTokens);
  for (const key of ['contextWindow', 'compactLimit', 'compactKeepRecentTokens', 'compactSummaryMaxTokens', 'memoryRecallTokens', 'maxOutputTokens'] as const) integer(config[key], key);
  if (config.compactLimit >= config.contextWindow) throw new Error('compactLimit 必须小于 contextWindow');
  if (config.maxOutputTokens > config.contextWindow - config.compactLimit) throw new Error('maxOutputTokens 不能大于上下文窗口与压缩阈值之间的预留量');
  if (config.persona.length > 200_000) throw new Error('人格正文不能超过 200000 字符');
  if(config.imageMaxMiB*MiB>NAPCAT_MEDIA_MAX_BYTES||config.ttsMaxMiB*MiB>NAPCAT_MEDIA_MAX_BYTES)throw new Error('配置中的单张图片或单条语音不能超过 16 MiB');
  if (config.model.length > 1024 || /[\x00-\x1f\x7f]/u.test(config.model)) throw new Error('模型名称无效');
  let proxy;
  try {
    proxy = normalizeNetworkProxy({ enabled: config.proxyEnabled, url: config.proxyUrl,
      username: config.proxyUsername, password: config.proxyPassword, noProxy: config.proxyNoProxy, forTools: config.proxyForTools });
  } catch {
    throw new Error('网络代理配置无效：请检查 HTTP(S) 地址、绕过规则和凭据；填写密码时须同时配置用户名');
  }
  config.proxyUrl = proxy.url; config.proxyNoProxy = proxy.noProxy;
  if (proxy.username === undefined) delete config.proxyUsername; else config.proxyUsername = proxy.username;
  if (proxy.password === undefined) delete config.proxyPassword; else config.proxyPassword = proxy.password;
  // The existing worker parsers remain the authority for active provider rules.
  // Inactive provider fields are retained without requiring their credentials.
  const parsed = loadConfig(settingsToEnv(config, { type: 'group', id: '1' }));
  config.wsUrl = parsed.wsUrl;
  if (parsed.agentBaseUrl) config.baseUrl = parsed.agentBaseUrl;
  if (parsed.webSearch.provider === 'tavily') config.searchBaseUrl = parsed.webSearch.baseUrl;
  if (parsed.tts.provider === 'mimo') config.ttsBaseUrl = parsed.tts.baseUrl;
  return config;
}

export function settingsToEnv(config: BotSettings, target: { type: 'group' | 'private'; id: string }): Record<string, string> {
  const env: Record<string, string> = {
    MEMORY_ENABLED: String(config.memoryEnabled), MEMORY_DAILY_ENABLED: String(config.memoryDailyEnabled), MEMORY_DAILY_TIME: config.memoryDailyTime, MEMORY_TIMEZONE: config.memoryTimezone,
    MEMORY_AFTER_COMPACTION: String(config.memoryAfterCompaction), MEMORY_RECALL_TOKENS: String(config.memoryRecallTokens), MEMORY_MODEL: config.memoryModel, MEMORY_BASE_URL: config.memoryBaseUrl, MEMORY_API_KEY: config.memoryApiKey ?? '',
    MEMORY_EMBEDDING_PROVIDER: config.memoryEmbeddingProvider, MEMORY_EMBEDDING_BASE_URL: config.memoryEmbeddingBaseUrl, MEMORY_EMBEDDING_MODEL: config.memoryEmbeddingModel, MEMORY_EMBEDDING_API_KEY: config.memoryEmbeddingApiKey ?? '',
    AGENT_KEEP_RECENT_TOKENS: String(config.compactKeepRecentTokens), AGENT_SUMMARY_MAX_TOKENS: String(config.compactSummaryMaxTokens),
    TARGET_TYPE: target.type, TARGET_ID: target.id, NAPCAT_WS_URL: config.wsUrl, NAPCAT_TOKEN: config.napcatToken ?? '',
    DATA_DIR: '/data', AGENT_HOME: '/data/pi', AGENT_WORKSPACE: '/data/workspace',
    AGENT_API: config.modelApi, AGENT_MAX_OUTPUT_TOKENS: String(config.maxOutputTokens),
    AGENT_SUPPORTS_IMAGES: String(config.supportsImages), AGENT_SUPPORTS_REASONING: String(config.supportsReasoning),
    AGENT_ALLOW_COMMANDS: String(config.allowCommands), AGENT_ALLOW_FILE_WRITES: String(config.allowFileWrites),
    TASK_CREATOR_ONLY: String(config.taskCreatorOnly),
    AGENT_PERSONA: config.persona,
    NETWORK_PROXY_ENABLED: String(config.proxyEnabled), NETWORK_PROXY_URL: config.proxyUrl,
    NETWORK_PROXY_USERNAME: config.proxyUsername ?? '', NETWORK_PROXY_PASSWORD: config.proxyPassword ?? '',
    NETWORK_PROXY_NO_PROXY: config.proxyNoProxy, NETWORK_PROXY_FOR_TOOLS: String(config.proxyForTools),
    RANDOM_REPLY_PROBABILITY: String(config.replyProbability / 100), VOICE_REPLY_ENABLED: String(config.voiceEnabled),
    VOICE_REPLY_PROBABILITY: String(config.voiceProbability / 100), WEB_SEARCH_PROVIDER: config.searchProvider, TTS_PROVIDER: config.ttsProvider,
    BATCH_SIZE: String(config.batchSize), REPLY_MAX_CHARS: String(config.replyMaxChars),
    AGENT_TIMEOUT_MS: String(config.modelTimeout * 1000), ACTION_TIMEOUT_MS: String(config.actionTimeout * 1000),
    RETRY_MS: String(config.retrySeconds * 1000), RECONNECT_MS: String(config.reconnectSeconds * 1000),
    IMAGE_MAX_BYTES: String(config.imageMaxMiB * MiB), IMAGE_TIMEOUT_MS: String(config.imageTimeout * 1000),
    // Only Worker retention is projected here; Console transfer limits stay in its database.
    IMAGE_CACHE_DAYS: String(config.imageCacheDays), IMAGE_CACHE_MAX_BYTES: String(config.imageCacheMaxMiB * MiB),
  };
  if (config.model) env.AGENT_MODEL = config.model;
  if (config.supportsReasoning && config.reasoning) env.AGENT_REASONING = config.reasoning;
  env.AGENT_CONTEXT_WINDOW = String(config.contextWindow);
  env.AGENT_AUTO_COMPACT_TOKEN_LIMIT = String(config.compactLimit);
  if (config.baseUrl) env.AGENT_BASE_URL = config.baseUrl;
  if (config.modelApiKey) env.AGENT_API_KEY = config.modelApiKey;
  if (config.searchProvider === 'tavily') Object.assign(env, {
    TAVILY_API_KEY: config.tavilyApiKey ?? '', TAVILY_SEARCH_BASE_URL: config.searchBaseUrl,
    TAVILY_SEARCH_DEPTH: config.searchDepth, TAVILY_MAX_RESULTS: String(config.searchResults), WEB_SEARCH_TIMEOUT_MS: String(config.searchTimeout * 1000),
  });
  if (config.ttsProvider !== 'none') Object.assign(env, {
    TTS_TIMEOUT_MS: String(config.ttsTimeout * 1000), TTS_MAX_CHARS: String(config.ttsMaxChars), TTS_MAX_BYTES: String(config.ttsMaxMiB * MiB),
  });
  if (config.ttsProvider === 'mimo') Object.assign(env, {
    MIMO_TTS_API_KEY: config.mimoApiKey ?? '', MIMO_TTS_BASE_URL: config.ttsBaseUrl,
    MIMO_TTS_MODEL: config.ttsModel, MIMO_TTS_VOICE: config.ttsVoice, MIMO_TTS_STYLE: config.ttsStyle,
  });
  if (config.ttsProvider === 'edge-tts') Object.assign(env, {
    EDGE_TTS_VOICE: config.edgeVoice, EDGE_TTS_RATE: config.edgeRate, EDGE_TTS_PITCH: config.edgePitch, EDGE_TTS_VOLUME: config.edgeVolume,
  });
  return env;
}

/** Import is explicit; it never reads process.env or logs the source. */
export function settingsFromEnv(env: Record<string, string | undefined>, persona?: string): BotSettings {
  const parsed = loadConfig(env);
  const config: BotSettings = {
    ...defaultSettings(), persona: persona ?? parsed.persona, wsUrl: parsed.wsUrl, napcatToken: parsed.token,
    modelApi: parsed.agentApi, model: parsed.agentModel ?? '', baseUrl: parsed.agentBaseUrl ?? '',
    ...(parsed.agentApiKey ? { modelApiKey: parsed.agentApiKey } : {}), reasoning: (parsed.agentReasoning ?? '') as BotSettings['reasoning'],
    contextWindow: parsed.agentContextWindow, compactLimit: parsed.agentCompactLimit, compactKeepRecentTokens: parsed.agentKeepRecentTokens, compactSummaryMaxTokens: parsed.agentSummaryMaxTokens, maxOutputTokens: parsed.agentMaxOutputTokens,
    memoryEnabled: parsed.memory.enabled, memoryDailyEnabled: parsed.memory.dailyEnabled, memoryDailyTime: parsed.memory.dailyTime, memoryTimezone: parsed.memory.timezone, memoryAfterCompaction: parsed.memory.afterCompaction, memoryRecallTokens: parsed.memory.recallTokens,
    memoryModel: parsed.memory.model, memoryBaseUrl: parsed.memory.baseUrl, memoryApiKey: parsed.memory.apiKey, memoryEmbeddingProvider: parsed.memory.embeddingProvider, memoryEmbeddingBaseUrl: parsed.memory.embeddingBaseUrl, memoryEmbeddingModel: parsed.memory.embeddingModel, memoryEmbeddingApiKey: parsed.memory.embeddingApiKey,
    supportsImages: parsed.agentSupportsImages, supportsReasoning: parsed.agentSupportsReasoning,
    allowCommands: parsed.allowCommands, allowFileWrites: parsed.allowFileWrites, taskCreatorOnly: parsed.taskCreatorOnly, replyProbability: parsed.randomReplyProbability * 100,
    voiceEnabled: parsed.voiceReplyEnabled, voiceProbability: Number(env.VOICE_REPLY_PROBABILITY ?? 0.2) * 100,
    batchSize: parsed.batchSize, replyMaxChars: parsed.replyMaxChars, modelTimeout: parsed.agentTimeoutMs / 1000,
    actionTimeout: parsed.actionTimeoutMs / 1000, retrySeconds: parsed.retryMs / 1000, reconnectSeconds: parsed.reconnectMs / 1000,
    imageMaxMiB: parsed.imageMaxBytes / MiB, imageTimeout: parsed.imageTimeoutMs / 1000,
    imageCacheDays: parsed.imageCacheDays, imageCacheMaxMiB: parsed.imageCacheMaxBytes / MiB,
    proxyEnabled: parsed.networkProxy.enabled, proxyUrl: parsed.networkProxy.url,
    proxyUsername: parsed.networkProxy.username, proxyPassword: parsed.networkProxy.password,
    proxyNoProxy: parsed.networkProxy.noProxy, proxyForTools: parsed.networkProxy.forTools,
  };
  const search = parsed.webSearch;
  config.searchProvider = search.provider;
  if (search.provider === 'tavily') Object.assign(config, {
    tavilyApiKey: search.apiKey, searchBaseUrl: search.baseUrl, searchDepth: search.searchDepth, searchResults: search.maxResults, searchTimeout: search.timeoutMs / 1000,
  });
  const tts = parsed.tts;
  config.ttsProvider = tts.provider;
  if (tts.provider !== 'none') Object.assign(config, { ttsTimeout: tts.timeoutMs / 1000, ttsMaxChars: tts.maxChars, ttsMaxMiB: tts.maxBytes / MiB });
  if (tts.provider === 'mimo') Object.assign(config, { mimoApiKey: tts.apiKey, ttsBaseUrl: tts.baseUrl, ttsModel: tts.model, ttsVoice: tts.voice, ttsStyle: tts.style });
  if (tts.provider === 'edge-tts') Object.assign(config, { edgeVoice: tts.voice, edgeRate: tts.rate, edgePitch: tts.pitch, edgeVolume: tts.volume });
  return validateSettings(config);
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function oneOf(value: string, allowed: string[], key: string): void { if (!allowed.includes(value)) throw new Error(`${key} 选项无效`); }
function probability(value: number, key: string): void { if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error(`${key} 必须为 0 至 100`); }
function positiveUnit(value: number, key: string, multiplier: number): void { if (!Number.isFinite(value) || value <= 0 || !Number.isSafeInteger(value * multiplier)) throw new Error(`${key} 必须为有效正数`); }
function integer(value: number, key: string): void { if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${key} 必须为正整数`); }
