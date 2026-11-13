import { setTimeout as delay } from 'node:timers/promises';
import { activity, recordRenderedCount } from './activity.js';

let rendering = false;

export async function renderLimited<T>(action: () => Promise<T>, signal: AbortSignal): Promise<T> {
  await activity('render_wait','render_wait',async()=>{while (rendering) await delay(25, undefined, { signal });signal.throwIfAborted();rendering=true;});
  try { return await activity('render','image_render',async()=>{const result=await action();recordRenderedCount(result);return result;},signal); }
  finally { rendering = false; }
}
