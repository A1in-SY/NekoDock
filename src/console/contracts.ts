export type DesiredState = 'running' | 'stopped';
export type RuntimeState = 'running' | 'stopped' | 'starting' | 'stopping' | 'error' | 'unknown';
export interface BotSettings {
  wsUrl: string; napcatToken?: string; model: string; baseUrl: string; modelApiKey?: string;
  modelApi: 'openai-responses' | 'openai-completions'; maxOutputTokens: number; supportsImages: boolean; supportsReasoning: boolean;
  allowCommands: boolean; allowFileWrites: boolean;
  reasoning: '' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  contextWindow: number; compactLimit: number; persona: string;
  replyProbability: number; searchProvider: 'none' | 'tavily'; tavilyApiKey?: string; searchBaseUrl: string; searchDepth: 'basic' | 'advanced'; searchResults: number; searchTimeout: number;
  voiceEnabled: boolean; voiceProbability: number; ttsProvider: 'none' | 'edge-tts' | 'mimo'; mimoApiKey?: string; ttsBaseUrl: string; ttsModel: string; ttsVoice: string; ttsStyle: string;
  edgeVoice: string; edgeRate: string; edgePitch: string; edgeVolume: string; ttsTimeout: number; ttsMaxChars: number; ttsMaxMiB: number;
  batchSize: number; replyMaxChars: number; modelTimeout: number; actionTimeout: number; retrySeconds: number; reconnectSeconds: number; imageMaxMiB: number; imageTimeout: number;
}
export const SECRET_FIELDS = ['napcatToken','modelApiKey','tavilyApiKey','mimoApiKey'] as const;
export type SecretField = typeof SECRET_FIELDS[number];
export interface BotRecord {
  id: string; name: string; description: string; targetType: 'group' | 'private'; targetId: string;
  config: BotSettings; desiredRevision: number; appliedRevision: number; desiredState: DesiredState;
  volume: string; workerToken: string; createdAt: number; updatedAt: number; imported: boolean;
}
export interface WorkerSnapshot {
  botId: string; revision: number; target: {type: 'group' | 'private'; id: string}; env: Record<string,string>; persona: string;
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
  config: Omit<BotSettings,SecretField>; configuredSecrets: Record<SecretField,boolean>; statistics: Statistics;
  state: RuntimeState; connected: boolean; lastHeartbeat: number | null; processing: boolean; error?: string;
}
