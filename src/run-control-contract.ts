/** One ordinary chat turn, including preparation and delivery. */
export interface ActiveReplyRun {
  runId: string;
  conversationId: string;
  throughSeq: number;
  startedAt: number;
  phase: 'preparing' | 'generating' | 'sending' | 'cancelling';
}
export type RunCancelResult = 'cancelled' | 'already_finished';
export interface RunCancellation {
  id: string;
  runId: string;
  status: 'requested' | 'received' | 'cancelled' | 'already_finished';
  createdAt: number;
}
export interface RunControlView {
  supported: boolean;
  active: ActiveReplyRun | null;
  cancellation: RunCancellation | null;
}
export const runIdentity = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
