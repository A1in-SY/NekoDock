import type { ReplyPartState } from './reply-ledger.js';
import type { ReplyMessageReceipt, ReplyToolReceipt } from './types.js';

export const REPLY_RECEIPT_WAIT_MS = 5_000;
export const REPLY_ACCEPTED_NOTICE = 'The sending system has accepted responsibility for these messages. Acceptance alone does not confirm delivery. Do not submit them again. If this was your final answer, finish this turn.';

export function replyMessageReceipt(messageRef: string, states: readonly ReplyPartState[], errors: ReplyMessageReceipt['errors'] = []): ReplyMessageReceipt {
  if (!states.length) throw new Error('Reply receipt has no registered parts.');
  const parts = { total: states.length, sent: 0, pending: 0, failed: 0, unconfirmed: 0, cancelled: 0 };
  for (const state of states) {
    if (state === 'acknowledged' || state === 'recalled') parts.sent++;
    else if (state === 'queued' || state === 'started') parts.pending++;
    else parts[state]++;
  }
  const status = parts.pending ? 'pending' : parts.sent === parts.total ? 'sent' : parts.sent ? 'partial'
    : parts.unconfirmed ? 'unconfirmed' : parts.cancelled === parts.total ? 'cancelled' : 'failed';
  return { messageRef, status, parts, ...(errors.length ? { errors } : {}) };
}

export function replyToolReceipt(messages: ReplyMessageReceipt[]): ReplyToolReceipt {
  let notice: string;
  if (messages.every(message => message.status === 'sent')) {
    notice = 'NapCat acknowledged all submitted messages. This confirms sending, not that anyone has read them. Do not send them again. If this was your final answer, finish this turn.';
  } else if (messages.some(message => message.status === 'pending')) {
    notice = 'The sending system has accepted responsibility and is still processing these messages. Pending does not mean delivery failed. Do not resend or recall because delivery is pending. If this was your final answer, finish this turn.';
  } else {
    notice = 'Delivery processing has ended. Read each message status and part counts; accepted means persisted, not that every part was delivered. Do not automatically resend or recall these messages, especially partial or unconfirmed results. Report only confirmed outcomes.';
  }
  return { accepted: true, messages, notice };
}

/** Observe committed state; the deadline releases this waiter without aborting delivery. */
export function waitForReplyReceipt(options: {
  read(): ReplyToolReceipt;
  subscribe(changed: () => void): () => void;
  settled: Promise<void>;
  signal: AbortSignal;
  timeoutMs?: number;
}): Promise<ReplyToolReceipt> {
  return new Promise((resolve, reject) => {
    let done = false;
    let unsubscribe = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (receipt?: ReplyToolReceipt, error?: unknown) => {
      if (done) return;
      done = true; clearTimeout(timer); unsubscribe(); options.signal.removeEventListener('abort', abort);
      if (receipt) resolve(receipt); else reject(error);
    };
    const abort = () => finish(undefined, options.signal.reason ?? new Error('Reply receipt wait cancelled.'));
    const check = (expired = false) => {
      if (done) return;
      try {
        const receipt = options.read();
        if (expired || receipt.messages?.every(message => message.status !== 'pending')) finish(receipt);
      } catch (error) { finish(undefined, error); }
    };
    if (options.signal.aborted) { abort(); return; }
    try {
      // Recorder callbacks may run inside the delivery transaction. Re-read on
      // the next microtask, after commit, and register before the initial read.
      unsubscribe = options.subscribe(() => queueMicrotask(() => check()));
      options.signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => check(true), options.timeoutMs ?? REPLY_RECEIPT_WAIT_MS);
      void options.settled.then(() => check(), error => finish(undefined, error));
      check();
    } catch (error) { finish(undefined, error); }
  });
}
