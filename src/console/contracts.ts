import type { IncomingImageDescriptor } from '../incoming-image-contract.js';

export type DesiredState = 'running' | 'stopped';
export type RuntimeState = 'running' | 'stopped' | 'starting' | 'stopping' | 'error' | 'unknown';
export interface BotSettings {
  wsUrl: string; napcatToken?: string; model: string; baseUrl: string; modelApiKey?: string;
  modelApi: 'openai-responses' | 'openai-completions'; maxOutputTokens: number; supportsImages: boolean; supportsReasoning: boolean;
  allowCommands: boolean; allowFileWrites: boolean; taskCreatorOnly: boolean;
  proxyEnabled: boolean; proxyUrl: string; proxyUsername?: string; proxyPassword?: string; proxyNoProxy: string; proxyForTools: boolean;
  reasoning: '' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  contextWindow: number; compactLimit: number; compactKeepRecentTokens: number; compactSummaryMaxTokens: number; persona: string;
  memoryEnabled: boolean; memoryDailyEnabled: boolean; memoryDailyTime: string; memoryTimezone: string; memoryAfterCompaction: boolean; memoryRecallTokens: number;
  memoryModel: string; memoryBaseUrl: string; memoryApiKey?: string; memoryEmbeddingProvider: 'none' | 'openai-compatible'; memoryEmbeddingBaseUrl: string; memoryEmbeddingModel: string; memoryEmbeddingApiKey?: string;
  replyMode: 'random' | 'jev'; replyProbability: number;
  replyJudgeBaseUrl: string; replyJudgeModel: string; replyJudgeApiKey?: string; replyJudgeThreshold: number; replyJudgeTimeout: number; replyJudgeInstructions: string;
  searchProvider: 'none' | 'tavily'; tavilyApiKey?: string; searchBaseUrl: string; searchDepth: 'basic' | 'advanced'; searchResults: number; searchTimeout: number;
  voiceEnabled: boolean; voiceProbability: number; ttsProvider: 'none' | 'edge-tts' | 'mimo'; mimoApiKey?: string; ttsBaseUrl: string; ttsModel: string; ttsVoice: string; ttsStyle: string;
  edgeVoice: string; edgeRate: string; edgePitch: string; edgeVolume: string; ttsTimeout: number; ttsMaxChars: number; ttsMaxMiB: number;
  batchSize: number; replyMaxChars: number; modelTimeout: number; actionTimeout: number; retrySeconds: number; reconnectSeconds: number; imageMaxMiB: number; imageTimeout: number;
  /** Worker retention and Console transfer limits apply independently, per instance. */
  imageCacheDays: number; imageCacheMaxMiB: number; imageTransitHours: number; imageTransitMaxMiB: number;
}
export const SECRET_FIELDS = ['napcatToken','modelApiKey','tavilyApiKey','mimoApiKey','proxyUsername','proxyPassword','memoryApiKey','memoryEmbeddingApiKey','replyJudgeApiKey'] as const;
export type SecretField = typeof SECRET_FIELDS[number];
export type NapcatConnectionField = 'wsUrl' | 'napcatToken' | 'reconnectSeconds' | 'actionTimeout';
export interface NapcatConnectionRecord {
  id: string; name: string; wsUrl: string; token?: string; reconnectSeconds: number; actionTimeout: number;
  enabled: boolean; revision: number; accountId: string | null; createdAt: number; updatedAt: number;
  mediaBaseUrl?: string;
}
export interface PublicNapcatConnection extends Omit<NapcatConnectionRecord, 'token'> {
  tokenConfigured: boolean; botIds: string[];
}
export interface NapcatConnectionInput {
  name: string; wsUrl: string; token?: string | null; reconnectSeconds?: number; actionTimeout?: number; enabled?: boolean;
  mediaBaseUrl?: string;
}
export interface NapcatQueuedEvent { seq: number; event: unknown; attachments?: IncomingImageDescriptor[]; dispatch?: import('../plugin-contract.js').PluginDispatch;
  forwards?: import('../forward-contract.js').ForwardSnapshot; update?: import('../forward-contract.js').ForwardSnapshot; recall?:import('../chat-context-contract.js').ChatRecallEvent; }
export type NapcatDeliveryState = 'started' | 'acknowledged' | 'failed' | 'unconfirmed';
export interface NapcatDeliveryRecord {
  botId: string; deliveryId: string; payloadHash: string; state: NapcatDeliveryState; result?: unknown; createdAt: number; updatedAt: number;
}
export interface BotRecord {
  id: string; name: string; description: string; targetType: 'group' | 'private'; targetId: string; connectionId: string;
  config: BotSettings; desiredRevision: number; appliedRevision: number; desiredState: DesiredState;
  volume: string; workerToken: string; createdAt: number; updatedAt: number; imported: boolean;
}
export interface WorkerSnapshot {
  botId: string; revision: number; connectionId: string; transport: 'console'; target: {type: 'group' | 'private'; id: string}; env: Record<string,string>; persona: string;
}
export interface ConsoleEvent {
  seq: number; type: string; time: number; conversationId?: string; runId?: string; itemId?: string; payload: Record<string,unknown>;
}
export interface WorkerHeartbeat {
  revision: number; connected: boolean; processing: boolean; drained: boolean; error?: string;
  conversationId?: string; events: ConsoleEvent[];
}
export interface WorkerControl { desiredState: DesiredState; desiredRevision: number; acknowledgedSeq: number; }
export interface MetricSample { botId: string; time: number; cpu: number | null; memory: number | null; rx: number | null; tx: number | null; latency: number | null; }
export interface Statistics { todayMessages: number; totalMessages: number; todayReplies: number; totalReplies: number; replyCountSince: number; }
export interface ConversationView {
  id: string; agentSessionId: string | null; startedAt: number; items: ConsoleEvent[]; nextBefore: number | null; cursor: number;
  usage: {input: number | null; cached: number | null; output: number | null; total: number | null};
  context: {used: number | null; window: number | null; compactLimit: number | null; estimated?: boolean};
}
/** A durable per-instance event cursor; reset carries a complete latest page. */
export interface ConversationUpdate { cursor: number; reset: boolean; view: ConversationView | null; }
export interface PublicBot extends Omit<BotRecord,'config'|'workerToken'> {
  config: Omit<BotSettings,SecretField | NapcatConnectionField>; configuredSecrets: Record<SecretField,boolean>; statistics: Statistics;
  state: RuntimeState; connected: boolean; lastHeartbeat: number | null; processing: boolean; error?: string;
  transportConnected?: boolean; upstreamConnected?: boolean; qqOnline?: boolean;
}
