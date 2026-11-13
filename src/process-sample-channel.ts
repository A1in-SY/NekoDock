import type { ProcessSample } from './activity-contract.js';

const listeners = new Set<(sample: ProcessSample) => void>();
export function publishProcessSample(sample: ProcessSample): void { for (const listener of listeners) try { listener(sample); } catch {} }
export function subscribeProcessSamples(listener: (sample: ProcessSample) => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
