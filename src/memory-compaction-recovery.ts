import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

/** Recover the gap between a persisted Pi checkpoint and delivery of its IPC event. */
export async function recoverMemoryCompactions(session: string, signal: AbortSignal, enqueue: (info: { session: string; entryId: string }) => void): Promise<void> {
  const source = createReadStream(session, { encoding: 'utf8', signal });
  const lines = createInterface({ input: source, crlfDelay: Infinity });
  let count = 0;
  try {
    for await (const line of lines) {
      signal.throwIfAborted();
      if (++count % 32 === 0) await new Promise<void>(resolve => setImmediate(resolve));
      if (!/"type"\s*:\s*"compaction"/u.test(line)) continue;
      let entry: unknown;
      try { entry = JSON.parse(line); } catch { continue; }
      if (!entry || typeof entry !== 'object') continue;
      const value = entry as { type?: unknown; id?: unknown; summary?: unknown };
      if (value.type === 'compaction' && typeof value.id === 'string' && value.id.length <= 200 && typeof value.summary === 'string') enqueue({ session, entryId: value.id });
    }
  } finally { lines.close(); source.destroy(); }
}
