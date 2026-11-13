import type { TaskChatMessage, TaskTools } from './scheduled-contract.js';
import type { ChatRecallEvent, ContextCommit, ContextSubmission } from './chat-context-contract.js';
export type TargetType = 'group' | 'private';
export interface Target { type: TargetType; id: string }

export type BridgeCommand = 'new' | 'compact' | 'help';
export type CommandResult = 'new' | 'compacted' | 'empty' | 'failed' | 'help';
export interface PendingCommand {
  id: number;
  kind: BridgeCommand;
  throughSeq: number;
  result: CommandResult | null;
}

export interface IncomingMessage {
  messageId: string;
  senderId: string;
  senderName: string;
  time: number;
  text: string;
  replyTo: string | null;
  trigger: boolean;
  rawJson: string;
  command?: BridgeCommand;
  directlyMentioned?: true;
}

export interface StoredMessage extends IncomingMessage { seq: number }

export type MessageSegment = { type: 'text'; text: string } | { type: 'at'; userId: string };
export interface SegmentMessage { type: 'message'; segments: MessageSegment[]; replyTo?: string }
export type OutputMessage = { type: 'text'; text: string; replyTo?: string } | { type: 'image'; path: string } | SegmentMessage;
export interface VoiceReply { type: 'voice'; text: string; file?: string }
export type ReplyPart = string | { type: 'image'; file: string } | SegmentMessage | VoiceReply;

export interface PendingBatch {
  throughSeq: number;
  messages: StoredMessage[];
  replyAllowed: boolean;
  replies: ReplyPart[] | null;
  nextReplyIndex: number;
  generationDone?: boolean;
  modelStarted?: boolean;
  context?: ContextSubmission;
}

export interface ReplyToolRequest { messages: OutputMessage[] }
export type ReplyDeliveryStatus = 'sent' | 'pending' | 'failed' | 'unconfirmed' | 'partial' | 'cancelled';
export interface ReplyDeliveryCounts {
  total: number; sent: number; pending: number; failed: number; unconfirmed: number; cancelled: number;
}
export interface ReplyMessageReceipt {
  messageRef: string; status: ReplyDeliveryStatus; parts: ReplyDeliveryCounts;
  errors?: Array<{ partIndex: number; code: string; retcode?: number }>;
}
export interface ReplyToolReceipt { accepted: true; messages?: ReplyMessageReceipt[]; notice?: string }
export interface OutgoingDeliveryMetadata {
  messageRef: string; conversationId: string; origin: 'model'; logicalMessageIndex: number; partIndex: number;
  runId?: string;
}
export interface RecallPartResult {
  messageId: string; partIndex: number; status: 'recalled' | 'already_recalled' | 'failed' | 'unconfirmed'; code?: string;
}
export interface RecallResult {
  messageRef: string; status: 'recalled' | 'already_recalled' | 'partial' | 'failed' | 'unconfirmed';
  parts: RecallPartResult[]; events?: ChatRecallEvent[]; code?: string;
}
export interface RecallToolReceipt extends Omit<RecallResult, 'status'> {
  status: RecallResult['status'] | 'cancelled'; cancelledParts?: number;
}
export interface ReplyTools {
  send(request: ReplyToolRequest, metadata?: { toolCallId?: string }): Promise<ReplyToolReceipt>;
  recall?(request: { messageRef: string }, metadata?: { toolCallId?: string; operationId?: string }): Promise<RecallToolReceipt>;
}
export interface ReplyRequestRecord extends ReplyToolRequest {
  requestId: string;
  startIndex: number;
  endIndex: number;
  sendStarted: boolean;
  toolCallId?: string;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface RunObservation { type:string; payload:Record<string,unknown>; itemId?:string; }
export type RunObserver = (event:RunObservation)=>void;
export interface SendReceipt { messageId?:string; }
export interface AgentResult { messages: OutputMessage[] }
export interface AgentRunner {
  supportsContextCommits?: boolean;
  recoverContext?(sessionId: string | null, onCommit: (receipt: ContextCommit) => void, stagedBatchIds?: string[]): Promise<void>;
  run(batch: PendingBatch, sessionId: string | null, onSession: (id: string) => void, signal: AbortSignal, replies?: ReplyTools, observer?:RunObserver, tasks?:TaskTools, externalMessages?:TaskChatMessage[]): Promise<AgentResult>;
  compact?(sessionId: string, signal: AbortSignal, observer?: RunObserver): Promise<void>;
}

export interface MessageSender {
  sendText(text: string, signal: AbortSignal, replyTo?: string, metadata?: OutgoingDeliveryMetadata): Promise<void | SendReceipt>;
  sendImage(file: string, signal: AbortSignal, metadata?: OutgoingDeliveryMetadata): Promise<void | SendReceipt>;
  sendMessage(segments: MessageSegment[], signal: AbortSignal, replyTo?: string, metadata?: OutgoingDeliveryMetadata): Promise<void | SendReceipt>;
  sendVoice?(file: string, signal: AbortSignal, metadata?: OutgoingDeliveryMetadata): Promise<void | SendReceipt>;
  sendVideo?(file: string, signal: AbortSignal): Promise<void | SendReceipt>;
  validateReplyTargets?(ids: string[], signal: AbortSignal): Promise<void>;
  recallMessage?(messageRef: string, operationId: string, signal: AbortSignal): Promise<RecallResult>;
}
