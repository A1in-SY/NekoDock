import type { OutputMessage, ReplyToolReceipt, RunObservation } from './types.js';

export type TaskSchedule = { kind: 'once'; at: string; timezone: string } | { kind: 'cron'; expression: string; timezone: string };
export interface TaskContext {
  taskState: boolean;
  chatHistory?: { range: 'scheduled_day' | 'previous_day' | 'rolling'; hours?: number; includeBotReplies: boolean; maxMessages: number; maxInputTokens: number };
}
export interface ScheduledTaskInput {
  name: string; kind: 'script' | 'model'; enabled: boolean; schedule: TaskSchedule;
  instructions: string; script: { runtime: 'python' | 'node'; source: string } | null;
  context: TaskContext; maxDelaySeconds: number; timeoutSeconds: number; notifyOnFailure: boolean;
}
export interface ScheduledTask extends ScheduledTaskInput {
  id: string; botId: string; revision: number; creatorId: string | null; createdAt: number; updatedAt: number; deletedAt: number | null;
  appliedRevision?: number; nextRunAt?: number | null;
}
export interface TaskState { version: number; data: Record<string, unknown>; updatedAt: number | null; sourceRunId: string | null }
export type TaskRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'interrupted' | 'missed';
export type TaskDeliveryStatus = 'none' | 'pending' | 'acknowledged' | 'failed' | 'unconfirmed' | 'partial';
export interface ScheduledRun {
  id: string; taskId: string; taskRevision: number; scheduledAt: number; startedAt: number | null; finishedAt: number | null;
  status: TaskRunStatus; deliveryStatus: TaskDeliveryStatus; acceptedMessages: number; acknowledgedMessages: number;
  error?: string; manual: boolean; conversationId: string;
}
export interface TaskChatMessage { id: string; senderId: string; senderName: string; time: number; text: string; replyTo: string | null; role: 'user' | 'assistant'; assets?: import('./chat-context-contract.js').ChatAsset[]; contents?: unknown[]; recalled?:boolean; recalledAt?:number; }
export interface TaskChatCoverage { from: number; to: number; availableCount: number; includedCount: number; truncated: boolean; coverage: 'complete' | 'latest_messages_in_range' }
export interface ScheduledInput {
  kind: 'scheduled_task'; task: { id: string; name: string; instructions: string };
  context: { taskState?: TaskState; chatMessages?: TaskChatMessage[]; chatCoverage?: TaskChatCoverage };
  invocation: { runId: string; scheduledAt: string; startedAt: string; timezone: string };
}
export interface TaskRunDetail { run: ScheduledRun; events: Array<{type: string; time: number; payload: Record<string, unknown>; seq?:number}>; taskState?: TaskState; cursor?:number; hasMore?:boolean }
export interface TaskToolRequest { operation: 'create' | 'list' | 'update' | 'delete'; sourceMessageId: string; taskId?: string; expectedRevision?: number; task?: unknown }
export interface TaskTools { manage(request: TaskToolRequest, operationId: string, signal?:AbortSignal): Promise<unknown> }
export interface ScheduledExecutionTools {
  send(request: { messages: OutputMessage[] }): Promise<ReplyToolReceipt>;
  saveState(data: Record<string, unknown>, expectedVersion: number): Promise<TaskState>;
}
export interface ScheduledAgent {
  runScheduled(input: ScheduledInput, tools: ScheduledExecutionTools, signal: AbortSignal, observer?: (event: RunObservation) => void): Promise<void>;
}
