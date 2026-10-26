import { loadConfig } from '../config.js';
import { SECRET_FIELDS, type BotSettings } from './contracts.js';

const MiB = 1024 * 1024;

/** Values in the management API use percentages, seconds and MiB. */
export function defaultSettings(): BotSettings {
  return {
    wsUrl: 'ws://host.docker.internal:3002/', model: '', baseUrl: '', modelApi: 'openai-responses', reasoning: '',
    contextWindow: 200_000, compactLimit: 160_000, maxOutputTokens: 8192, supportsImages: true, supportsReasoning: true,
    allowCommands: false, allowFileWrites: true, persona: '', replyProbability: 5,
    searchProvider: 'none', searchBaseUrl: 'https://api.tavily.com', searchDepth: 'basic', searchResults: 8, searchTimeout: 30,
    voiceEnabled: false, voiceProbability: 20, ttsProvider: 'none',
    ttsBaseUrl: 'https://api.xiaomimimo.com/v1', ttsModel: 'mimo-v2.5-tts', ttsVoice: 'mimo_default', ttsStyle: '',
    edgeVoice: 'zh-CN-XiaoxiaoNeural', edgeRate: '+0%', edgePitch: '+0Hz', edgeVolume: '+0%',
    ttsTimeout: 30, ttsMaxChars: 300, ttsMaxMiB: 5, batchSize: 50, replyMaxChars: 1500,
    modelTimeout: 600, actionTimeout: 15, retrySeconds: 5, reconnectSeconds: 3, imageMaxMiB: 10, imageTimeout: 15,
  };
}

/** Read old stored settings without changing their revision or widening tool access. */
export function normalizeSettings(input: unknown): BotSettings {
  if (!record(input)) throw new Error('配置必须为对象');
  const config = defaultSettings();
  for (const key of [...Object.keys(config), ...SECRET_FIELDS]) {
    if (input[key] !== undefined) (config as unknown as Record<string, unknown>)[key] = input[key];
  }
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
  for (const key of ['contextWindow', 'compactLimit', 'maxOutputTokens'] as const) integer(config[key], key);
  if (config.compactLimit >= config.contextWindow) throw new Error('compactLimit 必须小于 contextWindow');
  if (config.maxOutputTokens > config.contextWindow - config.compactLimit) throw new Error('maxOutputTokens 不能大于上下文窗口与压缩阈值之间的预留量');
  if (config.persona.length > 200_000) throw new Error('人格正文不能超过 200000 字符');
  if (config.model.length > 1024 || /[\x00-\x1f\x7f]/u.test(config.model)) throw new Error('模型名称无效');
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
    TARGET_TYPE: target.type, TARGET_ID: target.id, NAPCAT_WS_URL: config.wsUrl, NAPCAT_TOKEN: config.napcatToken ?? '',
    DATA_DIR: '/data', AGENT_HOME: '/data/pi', AGENT_WORKSPACE: '/data/workspace',
    AGENT_API: config.modelApi, AGENT_MAX_OUTPUT_TOKENS: String(config.maxOutputTokens),
    AGENT_SUPPORTS_IMAGES: String(config.supportsImages), AGENT_SUPPORTS_REASONING: String(config.supportsReasoning),
    AGENT_ALLOW_COMMANDS: String(config.allowCommands), AGENT_ALLOW_FILE_WRITES: String(config.allowFileWrites),
    AGENT_PERSONA: config.persona,
    RANDOM_REPLY_PROBABILITY: String(config.replyProbability / 100), VOICE_REPLY_ENABLED: String(config.voiceEnabled),
    VOICE_REPLY_PROBABILITY: String(config.voiceProbability / 100), WEB_SEARCH_PROVIDER: config.searchProvider, TTS_PROVIDER: config.ttsProvider,
    BATCH_SIZE: String(config.batchSize), REPLY_MAX_CHARS: String(config.replyMaxChars),
    AGENT_TIMEOUT_MS: String(config.modelTimeout * 1000), ACTION_TIMEOUT_MS: String(config.actionTimeout * 1000),
    RETRY_MS: String(config.retrySeconds * 1000), RECONNECT_MS: String(config.reconnectSeconds * 1000),
    IMAGE_MAX_BYTES: String(config.imageMaxMiB * MiB), IMAGE_TIMEOUT_MS: String(config.imageTimeout * 1000),
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
    contextWindow: parsed.agentContextWindow, compactLimit: parsed.agentCompactLimit, maxOutputTokens: parsed.agentMaxOutputTokens,
    supportsImages: parsed.agentSupportsImages, supportsReasoning: parsed.agentSupportsReasoning,
    allowCommands: parsed.allowCommands, allowFileWrites: parsed.allowFileWrites, replyProbability: parsed.randomReplyProbability * 100,
    voiceEnabled: parsed.voiceReplyEnabled, voiceProbability: Number(env.VOICE_REPLY_PROBABILITY ?? 0.2) * 100,
    batchSize: parsed.batchSize, replyMaxChars: parsed.replyMaxChars, modelTimeout: parsed.agentTimeoutMs / 1000,
    actionTimeout: parsed.actionTimeoutMs / 1000, retrySeconds: parsed.retryMs / 1000, reconnectSeconds: parsed.reconnectMs / 1000,
    imageMaxMiB: parsed.imageMaxBytes / MiB, imageTimeout: parsed.imageTimeoutMs / 1000,
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
