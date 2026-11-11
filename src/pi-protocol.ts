import type { ReplyToolReceipt, RunObservation, TargetType } from './types.js';
import type { WebSearchConfig } from './web-search.js';
import type { TaskToolRequest } from './scheduled-contract.js';
import type { NetworkProxyConfig } from './network.js';
import type { MemoryProposal, MemoryHistorySearch, MemorySearch } from './memory-contract.js';
import type { ChatRecallEvent, ContextCommit } from './chat-context-contract.js';
import type { PiContextStart } from './pi-context.js';

export interface PiConfig {
  home: string; workspace: string; model: string; baseUrl: string; apiKey?: string;
  api: 'openai-responses' | 'openai-completions'; reasoning?: string;
  contextWindow: number; compactLimit: number; maxOutputTokens: number;
  supportsImages: boolean; supportsReasoning: boolean; allowCommands: boolean; allowFileWrites: boolean;
  persona: string; targetType: TargetType; webSearch?: WebSearchConfig;
  networkProxy?: NetworkProxyConfig;
  taskCreatorOnly?: boolean;
  keepRecentTokens?: number;
  summaryMaxTokens?: number;
}
export interface PiStart {
  type: 'start'; operation: 'run' | 'append' | 'compact' | 'scheduled' | 'memory'; config: PiConfig;
  taskManagement?: boolean; taskState?: boolean;
  recallEnabled?: boolean;
  memoryRead?: boolean; recalledMemory?: unknown;
  session: string | null; prompt: string; system: string;
  images: Array<{ type: 'image'; data: string; mimeType: string }>;
  context?: PiContextStart;
}
export type ReplyOperationError = { code:string; message:string; messageIndex?:number };
export type PiParentMessage = PiStart | { type: 'abort' }
  | { type: 'send-result'; id: string; accepted: boolean; receipt?:ReplyToolReceipt; error?:ReplyOperationError }
  | { type:'recall-result'; id:string; ok:boolean; result?:unknown; error?:ReplyOperationError }
  | { type:'recall-event'; event:ChatRecallEvent }
  | {type:'task-result'; id:string; ok:boolean; result?:unknown; error?:string}
  | {type:'memory-result'; id:string; ok:boolean; result?:unknown; error?:string};
export type PiChildMessage =
  | { type: 'network-log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'session'; path: string }
  | { type: 'event'; event: RunObservation }
  | { type: 'context-committed'; receipt: ContextCommit }
  | { type: 'send'; id: string; request: unknown; toolCallId?: string }
  | { type: 'recall'; id: string; request: unknown; toolCallId?: string }
  | { type: 'task-manage'; id: string; operationId: string; request: TaskToolRequest }
  | { type: 'task-state'; id: string; data: Record<string,unknown>; expectedVersion: number }
  | { type: 'memory-query'; id: string; operation: 'search'; request: MemorySearch }
  | { type: 'memory-query'; id: string; operation: 'history'; request: MemoryHistorySearch }
  | { type: 'memory-stage'; id: string; changes: MemoryProposal[] }
  | { type: 'compacted'; session: string; entryId: string }
  | { type: 'done' }
  | { type: 'failure'; code: string; message?: string; modelFailure?: true };
