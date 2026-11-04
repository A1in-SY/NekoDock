import type { MemoryConfig, MemoryControl, MemoryChange, MemoryJob, MemoryRunner, MemoryView } from './memory-contract.js';
import { MemoryStore, MemoryValidationError } from './memory-store.js';
import { previousTaskTime } from './schedule.js';
import { fingerprint, logEvent } from './logging.js';
import type { Logger } from './types.js';
import { safeToolPayload } from './conversation-recorder.js';

export interface MemoryReceipt { id: string; ok: boolean; error?: string }
export interface MemoryCoordinatorOptions {
  store: MemoryStore;
  config: MemoryConfig;
  runner: MemoryRunner;
  logger: Logger;
  secrets?: string[];
  now?: () => number;
  fetchControls?: (signal: AbortSignal) => Promise<{ controls: MemoryControl[] }>;
  report?: (view: MemoryView, receipts: MemoryReceipt[], signal: AbortSignal) => Promise<unknown>;
  afterPublish?: (signal: AbortSignal) => Promise<void>;
}

/** A separate execution lane: it never owns the chat processor's busy or drain state. */
export class MemoryCoordinator {
  private readonly controller = new AbortController();
  private timer?: NodeJS.Timeout;
  private flight?: Promise<void>;
  private syncFlight?: Promise<void>;
  private closed = false;
  private active?: string;
  private runAbort?: AbortController;
  private readonly receipts = new Map<string, MemoryReceipt>();
  private lastVersion = -1;
  private lastSync = 0;
  private lastDailyCheck = 0;
  private closePromise?: Promise<void>;

  constructor(readonly options: MemoryCoordinatorOptions) {
    options.store.initialize(options.config.enabled);
  }
  get processing(): boolean { return this.active !== undefined; }
  get view(): MemoryView { return this.options.store.view(); }
  private now(): number { return this.options.now?.() ?? Date.now(); }

  start(): void {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => { void this.tick(); }, 1_000);
    this.timer.unref();
    void this.tick();
  }

  onCompacted(info: { session: string; entryId: string }): void {
    if (this.closed || !this.options.config.enabled || !this.options.config.afterCompaction) return;
    // A small durable enqueue is all the main run does; model work is detached.
    try {
      this.options.store.request('compaction', `compact:${fingerprint(info.session)}:${info.entryId}`);
      queueMicrotask(() => { void this.tick(); });
    } catch { logEvent(this.options.logger, 'warn', 'memory.enqueue.failed', { reason: 'compaction' }); }
  }

  async tick(): Promise<void> {
    if (this.closed) return;
    const now = this.now();
    if (now - this.lastSync >= 2_000 && !this.syncFlight) {
      this.lastSync = now;
      this.syncFlight = this.sync().finally(() => { this.syncFlight = undefined; });
    }
    if (this.options.config.enabled && this.options.config.dailyEnabled && now - this.lastDailyCheck >= 30_000) {
      this.lastDailyCheck = now;
      try {
        const [hour, minute] = this.options.config.dailyTime.split(':').map(Number);
        const at = previousTaskTime({ schedule: { kind: 'cron', expression: `${minute} ${hour} * * *`, timezone: this.options.config.timezone } }, now);
        if (at !== null) this.options.store.request('daily', `daily:${this.options.config.timezone}:${this.options.config.dailyTime}:${at}`);
      } catch { logEvent(this.options.logger, 'warn', 'memory.enqueue.failed', { reason: 'daily' }); }
    }
    if (this.options.config.enabled && !this.flight) {
      this.flight = this.execute().catch(() => {
        logEvent(this.options.logger, 'warn', 'memory.coordinator.failed');
      }).finally(() => { this.flight = undefined; });
    }
    await this.syncFlight;
  }

  private async sync(): Promise<void> {
    const { fetchControls, report, store } = this.options;
    if (!fetchControls || !report || this.closed) return;
    try {
      const response = await fetchControls(this.controller.signal);
      if (!response || !Array.isArray(response.controls) || response.controls.length > 100) throw new Error('MEMORY_CONTROL_INVALID');
      for (const control of response.controls) {
        if (this.closed) return;
        if (this.receipts.has(control.id)) continue;
        try {
          if ((control.operation === 'run' || control.operation === 'backfill' || control.operation === 'retry') && !this.options.config.enabled) throw new Error('MEMORY_DISABLED');
          if (control.operation === 'cancel') this.runAbort?.abort();
          store.control(control);
          this.receipts.set(control.id, { id: control.id, ok: true });
        } catch (error) {
          const code = error instanceof Error && /^MEMORY_[A-Z_]+$/.test(error.message) ? error.message : 'MEMORY_CONTROL_FAILED';
          this.receipts.set(control.id, { id: control.id, ok: false, error: code });
        }
      }
      const view = store.view();
      if (view.version !== this.lastVersion || this.receipts.size) {
        const receipts = [...this.receipts.values()];
        await report(view, receipts, this.controller.signal);
        this.lastVersion = view.version;
        for (const receipt of receipts) this.receipts.delete(receipt.id);
      }
    } catch {
      if (!this.closed) logEvent(this.options.logger, 'warn', 'memory.sync.failed');
    }
  }

  private async execute(): Promise<void> {
    const { store, runner, logger } = this.options;
    const job = store.claim(this.now());
    if (!job) return;
    this.active = job.id;
    this.runAbort = new AbortController();
    const signal = AbortSignal.any([this.controller.signal, this.runAbort.signal]);
    const started = this.now();
    let lastValidationError: MemoryValidationError | undefined;
    logEvent(logger, 'info', 'memory.job.started', { job_id: job.id, reason: job.reason, from_seq: job.fromSeq, through_seq: job.throughSeq });
    try {
      // Batches are independently atomic, so a cancelled long job retains completed work.
      for (let i = 0; i < 100; i++) {
        signal.throwIfAborted();
        const current = store.job(job.id);
        if (!current || current.status !== 'running') break;
        const batch = store.batch(job.id, 100, 24_000);
        if (!batch) {
          store.publish(job.id, current.throughSeq, []);
          break;
        }
        let changes: MemoryChange[] = [];
        let staged = false;
        let stageAttempts = 0;
        await runner.runMemory(batch, {
          history: async request => store.history(request, { fromSeq: batch.fromSeq, throughSeq: batch.throughSeq, jobId: job.id }),
          search: async request => store.search({ ...request, includeInactive: true, limit: Math.min(request.limit ?? 20, 100) }),
          stage: async values => {
            signal.throwIfAborted();
            staged = false; changes = [];
            if (++stageAttempts > 3) throw new Error('MEMORY_STAGE_ATTEMPTS_EXHAUSTED');
            if (!Array.isArray(values) || values.length > 50 || Buffer.byteLength(JSON.stringify(values)) > 64_000) throw new Error('MEMORY_STAGE_LIMIT');
            try {
              changes = store.validateProposals(job.id, batch.throughSeq, values);
              staged = true;
              lastValidationError = undefined;
            } catch (error) {
              lastValidationError = error instanceof MemoryValidationError ? error : undefined;
              const fields = { code: this.errorCode(error), attempt: stageAttempts,
                ...(error instanceof MemoryValidationError ? { changeIndex: error.changeIndex, sourceIndex: error.sourceIndex, sourceSeq: error.sourceSeq } : {}) };
              store.event(job.id, 'memory.validation.failed', fields);
              logEvent(logger, 'warn', 'memory.validation.failed', { job_id: job.id, ...fields });
              throw error;
            }
          },
        }, signal, event => {
          const payload = safeToolPayload(event.payload, this.options.secrets ?? []) as Record<string, unknown>;
          // Credential redaction also matches "tokens"; restore only trusted numeric usage counters.
          if (event.type === 'usage.recorded') for (const key of ['input_tokens','cached_input_tokens','output_tokens','total_tokens']) {
            const value = event.payload[key];
            payload[key] = typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
          }
          store.event(job.id, event.type, { ...payload, ...(event.itemId ? { itemId: event.itemId } : {}) });
        });
        signal.throwIfAborted();
        if (!staged) throw new Error('MEMORY_NOT_STAGED');
        const result = store.publish(job.id, batch.throughSeq, changes);
        logEvent(logger, 'info', 'memory.batch.published', { job_id: job.id, through_seq: batch.throughSeq, changes: changes.length });
        if (this.options.afterPublish) {
          try { await this.options.afterPublish(signal); }
          catch { if (!signal.aborted) logEvent(logger, 'warn', 'memory.embedding.failed', { job_id: job.id }); }
        }
        if (result.status === 'completed') break;
        // Yield between batches so ingress, delivery ACKs and liveness remain responsive.
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      const current = store.job(job.id);
      if (current?.status === 'running') store.release(job.id);
      logEvent(logger, 'info', 'memory.job.finished', { job_id: job.id, status: store.job(job.id)?.status, duration_ms: this.now() - started });
    } catch (error) {
      const current = store.job(job.id);
      if (current?.status === 'running') {
        if (this.closed || signal.aborted) store.release(job.id);
        else {
          const code = this.errorCode(lastValidationError ?? error);
          const exhausted = !!lastValidationError || /STAGE_ATTEMPTS|VALIDATION/.test(code);
          store.fail(job.id, code, !exhausted);
        }
      }
      logEvent(logger, 'warn', 'memory.job.failed', { job_id: job.id, reason: signal.aborted ? 'cancelled' : this.errorCode(lastValidationError ?? error),
        ...(lastValidationError ? { execution_reason: this.errorCode(error) } : {}), duration_ms: this.now() - started });
    } finally {
      this.active = undefined; this.runAbort = undefined;
      if (!this.closed) this.lastSync = 0;
    }
  }

  private errorCode(error: unknown): string {
    const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code
      : error instanceof Error ? /^(?:MEMORY|PI)_[A-Z_]+/.exec(error.message)?.[0] : undefined;
    return code && /^(?:MEMORY|PI)_[A-Z_]+$/.test(code) ? code : 'MEMORY_EXECUTION_FAILED';
  }

  close(): Promise<void> {
    return this.closePromise ??= (async () => {
      this.closed = true;
      clearInterval(this.timer);
      this.controller.abort();
      this.runAbort?.abort();
      await Promise.allSettled([this.flight, this.syncFlight]);
    })();
  }
}
