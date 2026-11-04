import type { RunObserver } from './types.js';

export interface MemoryConfig {
  enabled: boolean;
  dailyEnabled: boolean;
  dailyTime: string;
  timezone: string;
  afterCompaction: boolean;
  recallTokens: number;
  model: string;
  baseUrl: string;
  apiKey?: string;
  embeddingProvider: 'none' | 'openai-compatible';
  embeddingBaseUrl: string;
  embeddingModel: string;
  embeddingApiKey?: string;
}

export interface MemorySource {
  seq: number;
  id: string;
  messageId: string | null;
  senderId: string;
  senderName: string;
  role: 'user' | 'assistant';
  time: number;
  text: string;
  textOffset?: number;
  truncated?: boolean;
}

export interface MemoryItem {
  id: string;
  scope: 'person' | 'conversation';
  subjectUserId: string | null;
  kind: 'fact' | 'preference' | 'event';
  topic: string;
  content: string;
  occurredAt: number | null;
  validFrom: number | null;
  validTo: number | null;
  status: 'active' | 'superseded' | 'disabled';
  revision: number;
  sources: Array<{ sourceId: string; quote: string }>;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryChange {
  operation: 'upsert' | 'disable';
  id?: string;
  expectedRevision?: number;
  restore?: boolean;
  scope?: 'person' | 'conversation';
  subjectUserId?: string | null;
  kind?: 'fact' | 'preference' | 'event';
  topic?: string;
  content?: string;
  occurredAt?: number | null;
  validFrom?: number | null;
  validTo?: number | null;
  sources: Array<{ sourceId: string; quote: string }>;
}

/** Model proposals use one unambiguous archive reference; canonical IDs stay server-side. */
export type MemoryProposal = Omit<MemoryChange, 'sources'> & {
  sources: Array<{ sourceSeq: number; quote: string }>;
};

export interface MemoryJob {
  id: string;
  reason: 'daily' | 'compaction' | 'manual' | 'backfill' | 'control';
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  fromSeq: number;
  throughSeq: number;
  processedSeq: number;
  attempts: number;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface MemorySearch {
  query?: string;
  subjectUserId?: string;
  kind?: 'fact' | 'preference' | 'event';
  limit?: number;
  includeInactive?: boolean;
}
export interface MemoryHistorySearch {
  query?: string;
  senderId?: string;
  from?: number;
  to?: number;
  aroundMessageId?: string;
  afterSeq?: number;
  limit?: number;
  textOffset?: number;
}
export interface MemoryReadTools {
  search(request: MemorySearch): Promise<unknown>;
  history(request: MemoryHistorySearch): Promise<unknown>;
}
export interface MemoryBatch {
  jobId: string;
  fromSeq: number;
  throughSeq: number;
  sources: MemorySource[];
  memories: MemoryItem[];
  now: number;
}
export interface MemoryBatchTools {
  history(request: MemoryHistorySearch): Promise<unknown>;
  search(request: MemorySearch): Promise<unknown>;
  stage(changes: MemoryProposal[]): Promise<void>;
}
export interface MemoryRunner {
  runMemory(input: MemoryBatch, tools: MemoryBatchTools, signal: AbortSignal, observer?: RunObserver): Promise<void>;
}
export interface MemoryControl {
  id: string;
  operation: 'run' | 'backfill' | 'cancel' | 'update' | 'disable' | 'retry';
  jobId?: string;
  memoryId?: string;
  expectedRevision?: number;
  restore?: boolean;
  content?: string;
  from?: number;
  to?: number;
}
export interface MemoryView {
  enabled: boolean;
  cursor: number;
  highWater: number;
  items: MemoryItem[];
  jobs: MemoryJob[];
  events: Array<{ seq: number; jobId: string; time: number; type: string; payload: Record<string, unknown> }>;
  version: number;
  truncated?: boolean;
  totalItems?: number;
}
