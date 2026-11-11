import { setTimeout as delay } from 'node:timers/promises';

let rendering = false;

export async function renderLimited<T>(action: () => Promise<T>, signal: AbortSignal): Promise<T> {
  while (rendering) await delay(25, undefined, { signal });
  signal.throwIfAborted();
  rendering = true;
  try { return await action(); }
  finally { rendering = false; }
}
