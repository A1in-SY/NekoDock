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
export interface SegmentMessage { type: 'message'; segments: MessageSegment[] }
export type OutputMessage = { type: 'text'; text: string } | { type: 'image'; path: string } | SegmentMessage;
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
}

export interface ReplyToolRequest { messages: OutputMessage[] }
export interface ReplyToolReceipt { accepted: true }
export interface ReplyTools {
  send(request: ReplyToolRequest): Promise<ReplyToolReceipt>;
}
export interface ReplyRequestRecord extends ReplyToolRequest {
  requestId: string;
  startIndex: number;
  endIndex: number;
  sendStarted: boolean;
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
  run(batch: PendingBatch, sessionId: string | null, onSession: (id: string) => void, signal: AbortSignal, replies?: ReplyTools, observer?:RunObserver): Promise<AgentResult>;
  compact?(sessionId: string, signal: AbortSignal, observer?: RunObserver): Promise<void>;
}

export interface MessageSender {
  sendText(text: string, signal: AbortSignal): Promise<void | SendReceipt>;
  sendImage(file: string, signal: AbortSignal): Promise<void | SendReceipt>;
  sendMessage(segments: MessageSegment[], signal: AbortSignal): Promise<void | SendReceipt>;
  sendVoice?(file: string, signal: AbortSignal): Promise<void | SendReceipt>;
}
