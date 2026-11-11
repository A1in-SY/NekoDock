interface Waiter { signal: AbortSignal; resolve(release: () => void): void; reject(reason: unknown): void; abort(): void; }

/** Waiting for another job's request does not consume an image's HTTP timeout. */
export class InspectionRequestLimiter {
  private active = 0;
  private readonly waiting: Waiter[] = [];
  constructor(private readonly limit = 2) {}
  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.active < this.limit) { this.active++; return this.release(); }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {signal, resolve, reject, abort: () => {
        const index = this.waiting.indexOf(waiter);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(signal.reason);
      }};
      this.waiting.push(waiter);
      signal.addEventListener('abort', waiter.abort, {once: true});
    });
  }
  private release(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      while (this.active < this.limit && this.waiting.length) {
        const waiter = this.waiting.shift()!;
        waiter.signal.removeEventListener('abort', waiter.abort);
        if (waiter.signal.aborted) { waiter.reject(waiter.signal.reason); continue; }
        this.active++;
        waiter.resolve(this.release());
      }
    };
  }
}
