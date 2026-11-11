import { fingerprint, logEvent } from './logging.js';
import { hasReplyContent, normalizeMessage } from './napcat.js';
import type { BridgeStore } from './store.js';
import type { IncomingMessage, Logger, MessageSender, Target } from './types.js';
import type { PluginDispatch } from './plugin-contract.js';

export const busyReply = '我正在想上面的消息怎么回，你等会哦';

interface IncomingOptions {
  target: Target;
  randomReplyProbability: number;
  store: Pick<BridgeStore, 'isBusy' | 'insert'>;
  processor: { notify(): void };
  sender: Pick<MessageSender, 'sendText'>;
  logger: Logger;
  signal: AbortSignal;
  random?: () => number;
  onMessage?: (message: IncomingMessage) => void;
  dispatch?: PluginDispatch;
  replyDecision?:{enqueue(message:IncomingMessage):void};
}

/** Persist synchronously so the next event observes queued work before any network wait. */
export function handleIncomingEvent(event: unknown, options: IncomingOptions): void {
  const { store, target, logger } = options;
  const busy = store.isBusy();
  const message = normalizeMessage(event, target, options.replyDecision?0:options.randomReplyProbability, options.random, busy);
  if (!message) return;
  const handledByPlugin = options.dispatch?.executor === 'console' && options.dispatch.contextPolicy === 'chat'
    && options.dispatch.sourceMessageId === message.messageId;
  // A content command remains a chat fact, but its executor already owns the reply.
  if (handledByPlugin) message.trigger = false;
  const inserted = store.insert(message);
  // Register attachments even on redelivery: a previous process may have committed
  // the message immediately before its separate durable attachment registration.
  if (!message.command) options.onMessage?.(message);
  logEvent(logger, 'info', inserted ? 'message.persisted' : 'message.duplicate', {
    message_ref: fingerprint(message.messageId), sender_ref: fingerprint(message.senderId),
    kind: message.command ?? 'message', trigger: message.trigger,
    text_chars: Array.from(message.text).length, has_reply: message.replyTo !== null,
  });
  if (!inserted) return;
  if(options.replyDecision&&!busy&&target.type==='group'&&!message.command&&!message.directlyMentioned&&!handledByPlugin&&hasReplyContent(message.rawJson))options.replyDecision.enqueue(message);
  options.processor.notify();
  if (busy && target.type === 'group' && message.directlyMentioned && !handledByPlugin) {
    // This transport-only acknowledgement never enters the conversation or TTS pipeline.
    void sendBusyReply(options, message.messageId);
  }
}

async function sendBusyReply({ sender, logger, signal }: IncomingOptions, messageId: string): Promise<void> {
  try {
    logEvent(logger, 'info', 'message.busy_reply.started');
    await sender.sendText(busyReply, signal, messageId);
    logEvent(logger, 'info', 'message.busy_reply.sent');
  } catch {
    logEvent(logger, 'warn', 'message.busy_reply.failed');
  }
}
