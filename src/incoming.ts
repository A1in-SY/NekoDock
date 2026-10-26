import { fingerprint, logEvent } from './logging.js';
import { normalizeMessage } from './napcat.js';
import type { BridgeStore } from './store.js';
import type { Logger, MessageSender, Target } from './types.js';

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
}

/** Persist synchronously so the next event observes queued work before any network wait. */
export function handleIncomingEvent(event: unknown, options: IncomingOptions): void {
  const { store, target, logger } = options;
  const busy = store.isBusy();
  const message = normalizeMessage(event, target, options.randomReplyProbability, options.random, busy);
  if (!message) return;
  const inserted = store.insert(message);
  logEvent(logger, 'info', inserted ? 'message.persisted' : 'message.duplicate', {
    message_ref: fingerprint(message.messageId), sender_ref: fingerprint(message.senderId),
    kind: message.command ?? 'message', trigger: message.trigger,
    text_chars: Array.from(message.text).length, has_reply: message.replyTo !== null,
  });
  if (!inserted) return;
  options.processor.notify();
  if (busy && target.type === 'group' && message.directlyMentioned) {
    // This transport-only acknowledgement never enters the conversation or TTS pipeline.
    void sendBusyReply(options);
  }
}

async function sendBusyReply({ sender, logger, signal }: IncomingOptions): Promise<void> {
  try {
    logEvent(logger, 'info', 'message.busy_reply.started');
    await sender.sendText(busyReply, signal);
    logEvent(logger, 'info', 'message.busy_reply.sent');
  } catch {
    logEvent(logger, 'warn', 'message.busy_reply.failed');
  }
}
