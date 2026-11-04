/** Durable chat facts are separate from their provider-specific context projection. */
export interface ChatAsset {
  id: string;
  type: 'image' | 'voice' | 'video' | 'file';
  path?: string;
  status?: 'pending' | 'ready' | 'failed' | 'expired';
  mimeType?: string;
  title?: string;
  error?: string;
  origin?: 'plugin';
  pluginId?: string;
  pluginAssetId?: string;
  /** Derived presentation media stays visible in history without duplicate model vision input. */
  modelInput?: boolean;
}

export interface ChatContextMessage {
  chatMessageId: string;
  conversationId: string;
  revision: number;
  /** Instance-local durable arrival order, independent of platform clock precision. */
  sequence?: number;
  /** Only a real platform identifier; internal identities never substitute for it. */
  messageId: string | null;
  senderId: string;
  senderName: string;
  /** Unix seconds, matching ordinary incoming chat messages. */
  time: number;
  text: string;
  replyTo: string | null;
  role: 'user' | 'assistant';
  origin: 'human' | 'model' | 'scheduled' | 'plugin';
  assets?: ChatAsset[];
  contents?: unknown[];
  sourceMessageId?: string;
  pluginId?: string;
  toolCallId?: string;
  logicalMessageIndex?: number;
  partIndex?: number;
}

export interface ContextVersion {
  chatMessageId: string;
  revision: number;
}

export interface ContextRevision {
  message: ChatContextMessage;
  entryId: string;
}

export interface ContextSubmission {
  batchId: string;
  conversationId: string;
  /** New facts, including current incoming messages and confirmed external replies. */
  messages: ChatContextMessage[];
  /** Updated facts previously projected into this Pi session. */
  revisions: ContextRevision[];
  /** Exact referenced messages; historical material, never new reply targets. */
  references: ChatContextMessage[];
  /** Model replies already exist as tool calls; only their real delivery associations are new. */
  receipts?: ChatContextMessage[];
  versions: ContextVersion[];
}

export interface ContextCommit {
  batchId: string;
  conversationId: string;
  session: string;
  entryId: string;
  versions: ContextVersion[];
  /** A revision can target an earlier entry rather than the new input entry. */
  entries?: Array<ContextVersion & { entryId: string }>;
  hash?: string;
}

export interface PluginChatReply {
  id: string;
  conversationId: string;
  pluginId: string;
  sourceMessageId: string;
  /** Actual platform quote, independently of the share that produced this reply. */
  replyTo?: string | null;
  text: string;
  qqMessageId?: string;
  time?: number;
  assets?: ChatAsset[];
}
