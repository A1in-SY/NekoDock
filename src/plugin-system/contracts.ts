import type { NetworkProxyConfig } from '../network.js';

export type PluginId = string;
export type PlatformPluginId = string;
export type PluginSettings = Record<string, unknown>;
export interface PluginDispatch {
  pluginId: PluginId; command: string; args: string; sourceMessageId: string;
  contextPolicy: 'control' | 'chat'; executor: 'worker' | 'console'; jobId?: string;
}
export interface PluginCommand { name: string; description: string; pluginId: PluginId; contextPolicy: 'control' | 'chat'; executor: 'worker' | 'console'; }
export interface PluginManifest {
  id: PluginId; name: string; version: string; apiVersion: 1; required: boolean;
  capabilities?: Array<'commands' | 'content-enrichment' | 'video-download' | 'forward-inspection'>;
  resourceTypes: Array<'video' | 'article' | 'post' | 'live' | 'game'>; commands: PluginCommand[]; description?: string;
  configSchema?: { type:'object'; properties:Record<string,{type:'boolean'|'integer'|'string';title:string;description?:string;minimum?:number;maximum?:number;default?:unknown;secret?:boolean;enum?:string[];enumLabels?:string[];group?:string;parent?:string}> };
  fields?: Array<{key:string;label:string;type:'boolean'|'number'|'string'|'secret'|'select';description?:string;min?:number;max?:number;default?:unknown;options?:Array<{value:string;label:string}>;group?:string;parent?:string;visibleWhen?:{key:string;value:unknown}}>;
}
export type PublicPluginDefinition = PluginManifest;
export interface PluginResource { kind: string; id: string; url: string; title?: string; part?: number; }
export interface PluginContentImage {
  id: string; url: string; role: 'content' | 'live_preview' | 'cover' | 'avatar' | 'emoji';
  width?: number; height?: number; assetKey?: string; assetId?: string;
  status?: 'pending' | 'ready' | 'failed'; error?: string; fetchedAt?: number; imageLastModified?: string;
}
export type PluginContentBlock =
  | { type: 'paragraph'; text: string; spans?: Array<{ type: 'text' | 'emoji'; text: string; url?: string; assetKey?: string; assetId?: string }> }
  | { type: 'image'; image: PluginContentImage }
  | { type: 'resource'; resource: PluginResource; title?: string };
export interface PluginLiveInfo {
  roomId: string; shortId?: string; status: 'live' | 'offline' | 'replay';
  area?: string; parentArea?: string; startedAt?: number; preview?: PluginContentImage; cover?: PluginContentImage;
}
export interface PluginGamePrice {
  source: 'platform' | 'heybox'; label: string; current: string;
  original?: string; currency?: string; region?: string; discountPercent?: number;
  recordedLowest?: string; condition?: string;
}
export interface PluginGameInfo {
  gameType: 'pc' | 'console' | 'mobile'; appId: string;
  platform?: string; platformName?: string; nameEnglish?: string;
  platforms?: Array<{ id: string; name: string; gameType: 'pc' | 'console' | 'mobile'; appId: string }>;
  tags?: string[]; releaseDate?: string; developers?: string[]; publishers?: string[]; isFree?: boolean;
  score?: { value: number; scale: number; count?: number; source: string };
  prices?: PluginGamePrice[];
}
export interface PluginPresentation { mode: 'none' | 'original' | 'card'; provideContext: boolean; }
export interface PluginOutput { kind: 'reply' | 'image'; text?: string; assetKey?: string; assetId?: string; assetRole?: string; }
export interface PluginContent {
  type: 'video' | 'article' | 'post' | 'live' | 'game'; platform: string; resourceId: string; url: string; title: string;
  author?: string; publishedAt?: number; durationSeconds?: number; description?: string; coverUrl?: string; part?: number;
  authorId?: string; authorAvatar?: PluginContentImage; editedAt?: number; observedAt?: number;
  blocks?: PluginContentBlock[]; original?: PluginContent; live?: PluginLiveInfo; game?: PluginGameInfo;
  subtitle?: { status: 'ready' | 'absent' | 'login_required' | 'failed'; language?: string; text?: string; automatic?:boolean; segments?:Array<{start:number;end:number;text:string}>; truncated?:boolean };
  retrieval: { status: 'ready' | 'partial' | 'failed'; error?: string };
}
export interface PluginJobView {
  id: string; pluginId: PluginId; sourceMessageId: string; conversationId?: string;
  operation: string; state: string; createdAt: number; attempts: number; automatic: boolean; command: string; commandName?: string;
  resource?: { id: string; url: string; title?: string; author?: string; part?: number };
  commandExecution?: PluginCommandExecution & { input: string };
  inspection?: ForwardInspectionView;
  finishedAt?: number; durationMs?: number; error?: string;
  deliveries: Array<{ kind: 'reply' | 'video' | 'image' | 'notification'; status: 'pending' | 'sending' | 'acknowledged' | 'failed' | 'unconfirmed'; messageId?: string; code?: string }>;
}
export interface ForwardInspectionView {
  messageCount: number; imageMessageCount: number; imageCount: number; ratioPercent: number;
  sampledCount: number; checkedCount: number; structuralComplete: boolean;
  outcome: 'pending' | 'detected' | 'not_detected' | 'unknown' | 'skipped';
  scores?: Array<{sourceKey: string; score: number}>; reason?: string;
  failures?: Array<{sourceKey: string; code: string; httpStatus?: number}>;
  requestCount?: number; cacheHits?: number; preparedCacheHits?: number;
}
export interface PluginInstanceView {
  id: PluginId; pluginId: PluginId; enabled: boolean; revision: number;
  config: PluginSettings; configuredSecrets: Record<string,boolean>; manifest: PluginManifest;
  settings: PluginSettings; cookieConfigured:boolean; jobs: PluginJobView[];
}
export interface PluginConfiguration { pluginId: PluginId; enabled: boolean; revision: number; settings: PluginSettings; cookieConfigured?: boolean; manifest: PluginManifest; }
export interface PluginResult {
  id: string; pluginId: PluginId; sourceMessageId: string; conversationId: string; revision: number; sourceRevision?: number;
  kind: 'enrichment' | 'reply' | 'video' | 'image'; content?: PluginContent; contents?:PluginContent[]; text?: string; assetId?: string;
  groupId?: string; partIndex?: number; assetRole?: string;
  deliveryId?: string; automatic?: boolean; expiresAt?: number; replyTo?: string | null;
  delivery?: { status: 'acknowledged' | 'failed' | 'unconfirmed'; messageId?: string; code?: string };
}
export interface PluginSync { bindings?: Array<{ messageId: string; conversationId: string }>; acknowledgements?: string[]; conversationId?: string; }
export interface PluginRunnerJob {
  id: string; lease: string; botId: string; pluginId: PluginId; operation: 'resolve' | 'download' | 'prepare';
  resource: PluginResource; config: PluginSettings; networkProxy: NetworkProxyConfig; content?: PluginContent; expiresAt: number;
  command?: string; presentation?: PluginPresentation;
  imageMaxBytes?: number;
}
export interface PluginRunnerResult { content?: PluginContent; assetId?: string; outputs?: PluginOutput[]; error?: string; retryable?: boolean; }
export interface PluginExecution {
  content?: PluginContent; file?: string; files?: Array<{ key: string; path: string; type: 'image' | 'video'; role?: string }>;
  outputs?: PluginOutput[]; cleanup(): Promise<void>;
}
export interface PluginRunnerDefinition { execute(job: PluginRunnerJob, workspace: string, signal: AbortSignal): Promise<PluginExecution>; }
export class PluginExecutionError extends Error { constructor(readonly code: string, readonly retryable = false) { super(code); } }
export interface PluginJobPolicy { timeoutSeconds: number; waitSeconds: number; maxAssetBytes: number; cacheMaxBytes: number; cacheHours: number; }
export interface ControlPluginDefinition { kind: 'control'; manifest: PluginManifest; command(event: unknown): PluginDispatch | undefined; }
export interface PluginCommandExecution {
  text: string; summary: string; details: Array<{ label: string; value: string }>;
}
export interface CommandPluginDefinition {
  kind: 'command'; manifest: PluginManifest; defaults: PluginSettings;
  validateConfig(input: unknown, current?: PluginSettings): PluginSettings;
  command(event: unknown): PluginDispatch | undefined;
  execute(dispatch: PluginDispatch, config: PluginSettings): PluginCommandExecution;
}
export interface ContentPluginDefinition {
  kind: 'content'; manifest: PluginManifest; defaults: PluginSettings;
  validateConfig(input: unknown, current?: PluginSettings): PluginSettings;
  match(event: unknown): PluginResource[];
  command(event: unknown): PluginDispatch | undefined;
  commandName?(command: string): string;
  validateContent(value: unknown, resource: PluginResource): PluginContent;
  contentText(content: PluginContent): string;
  failureContent(resource: PluginResource, error: string): PluginContent;
  errorText(error: string): string;
  shouldProcess(config: PluginSettings, resource?: PluginResource): boolean;
  policy(config: PluginSettings): PluginJobPolicy;
  summarize(resource: PluginResource | null, content?: PluginContent): PluginJobView['resource'];
  missingResourceText: string;
  afterResolve(command: string, resource: PluginResource, config: PluginSettings, content: PluginContent): { provideContext: boolean; replyText?: string; download?: PluginResource; prepare?: PluginPresentation };
}
export interface ObserverPluginDefinition {
  kind: 'observer'; manifest: PluginManifest; defaults: PluginSettings;
  validateConfig(input: unknown, current?: PluginSettings): PluginSettings;
  validateEnabled?(settings: PluginSettings): void;
}
export type PluginDefinition = ControlPluginDefinition | CommandPluginDefinition | ContentPluginDefinition | ObserverPluginDefinition;
