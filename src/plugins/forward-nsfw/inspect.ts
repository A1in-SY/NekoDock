import { createHash, randomUUID } from 'node:crypto';
import { MODEL_IMAGE_OPTIONS, prepareJevModelImage } from '../../model-image.js';
import { NSFW_CRITERIA, NSFW_INSTRUCTIONS } from './prompts.js';
import type { ForwardNsfwConfig } from './config.js';

export type MaybePromise<T> = T | Promise<T>;
export type NsfwPreparedImage = Awaited<ReturnType<typeof prepareJevModelImage>>;
export type NsfwImageInput = ({sourceKey: string; bytes: Buffer; mimeType: string}
  | {sourceKey: string; read: () => Promise<{bytes: Buffer; mimeType: string}>}) & {
  /** Optional trusted descriptor hash; a cached score can avoid reading the source. */
  sha256?: string;
};
export interface NsfwCachedScore { score: number; model?: string; }
/** The caller supplies an instance-scoped store; only successful values are written. */
export interface NsfwClassificationCache {
  getPrepared(key: string): MaybePromise<NsfwPreparedImage | undefined>;
  setPrepared(key: string, image: NsfwPreparedImage): MaybePromise<void>;
  getScore(key: string): MaybePromise<NsfwCachedScore | undefined>;
  setScore(key: string, value: NsfwCachedScore): MaybePromise<void>;
}
export interface NsfwClassificationMetrics {
  requestBytes: number;
  requestCount: number;
  cacheHits: number;
  preparedCacheHits: number;
}
export interface NsfwImageFailure { sourceKey: string; code: string; httpStatus?: number; }
export interface NsfwClassification extends NsfwClassificationMetrics {
  scores: Array<{sourceKey: string; score: number}>;
  failures: NsfwImageFailure[];
  model?: string;
  usage?: {inputTokens?: number; outputTokens?: number};
}
export interface NsfwClassificationOptions {
  /** Acquired before the per-image HTTP timer, so other jobs do not consume it. */
  acquireRequest?: (signal: AbortSignal) => MaybePromise<() => void>;
}
export class ForwardNsfwError extends Error {
  readonly failures: NsfwImageFailure[];
  readonly metrics?: NsfwClassificationMetrics;
  constructor(readonly code: string, readonly httpStatus?: number,
    details?: {failures: NsfwImageFailure[]; metrics: NsfwClassificationMetrics}) {
    super(code); this.failures = details?.failures ?? []; this.metrics = details?.metrics;
  }
}
const object = (input: unknown): Record<string, unknown> | null => input !== null && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : null;
const digest = (input: string | Buffer) => createHash('sha256').update(input).digest('hex');
// Bump this version when the static normalization algorithm changes.
const IMAGE_PROFILE = {version: 'jev-static-v1', ...MODEL_IMAGE_OPTIONS, maxWidth: 1568, maxHeight: 1568, minimumEdge: 280};

function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void operation.catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, {once: true});
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function cached<T>(operation: (() => MaybePromise<T>) | undefined, signal: AbortSignal): Promise<T | undefined> {
  if (!operation) return undefined;
  signal.throwIfAborted();
  try { return await bounded(Promise.resolve().then(operation), signal); }
  catch { signal.throwIfAborted(); return undefined; }
}
function validPrepared(image: NsfwPreparedImage | undefined): image is NsfwPreparedImage {
  if (image?.type !== 'image' || !['image/png', 'image/jpeg'].includes(image.mimeType)
    || typeof image.data !== 'string' || !image.data.length || Buffer.byteLength(image.data) > MODEL_IMAGE_OPTIONS.maxBytes) return false;
  const bytes = Buffer.from(image.data, 'base64');
  return bytes.toString('base64') === image.data && (image.mimeType === 'image/png'
    ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff);
}
async function responseJson(response: Response): Promise<unknown> {
  if (!response.body) throw new ForwardNsfwError('NSFW_INVALID_RESPONSE');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > 64 * 1024) throw new ForwardNsfwError('NSFW_INVALID_RESPONSE');
      chunks.push(next.value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new ForwardNsfwError('NSFW_INVALID_RESPONSE'); }
  } finally { void reader.cancel().catch(() => {}); }
}

/** An independent classifier: each image has its own request and failure boundary. */
export async function classifyImages(config: ForwardNsfwConfig, images: NsfwImageInput[], fetcher: typeof globalThis.fetch,
  signal: AbortSignal, cache?: NsfwClassificationCache, options: NsfwClassificationOptions = {}): Promise<NsfwClassification> {
  if (!config.apiKey) throw new ForwardNsfwError('NSFW_NOT_CONFIGURED');
  if (!images.length || images.length > config.maxImages || images.length > 16) throw new ForwardNsfwError('NSFW_INVALID_IMAGES');
  const metrics: NsfwClassificationMetrics = {requestBytes: 0, requestCount: 0, cacheHits: 0, preparedCacheHits: 0};
  const scores: Array<{sourceKey: string; score: number} | undefined> = new Array(images.length);
  const failures: Array<NsfwImageFailure | undefined> = new Array(images.length);
  const models: Array<string | undefined> = new Array(images.length);
  const prepared: Array<{indices: number[]; image: NsfwPreparedImage; scoreKey: string}> = [];
  const unique = new Map<string, (typeof prepared)[number]>();
  const usage: NonNullable<NsfwClassification['usage']> = {};
  const question = {type: 'noul', instructions: `Evaluate images[0].image. ${NSFW_INSTRUCTIONS}${config.instructions ? ' Apply additional_criteria when supplied.' : ''}`, criteria: NSFW_CRITERIA};
  const policy = {profile: IMAGE_PROFILE, baseUrl: config.baseUrl.replace(/\/+$/u, ''), model: config.model,
    credential: digest(config.apiKey), question, additional: config.instructions};
  const cancelled = () => new ForwardNsfwError('NSFW_CANCELLED', undefined, {failures: failures.filter(item => !!item), metrics: {...metrics}});
  const scoreKeyFor = (sha256: string) => digest(JSON.stringify({kind: 'score', sha256, ...policy}));
  const reuseScore = async (index: number, scoreKey: string): Promise<boolean> => {
    const previous = await cached(cache && (() => cache.getScore(scoreKey)), signal);
    if (!previous || !Number.isFinite(previous.score) || previous.score < 0 || previous.score > 1) return false;
    scores[index] = {sourceKey: images[index]!.sourceKey, score: previous.score};
    models[index] = typeof previous.model === 'string' ? previous.model.slice(0, 200) : undefined;
    metrics.cacheHits++; return true;
  };
  const reusePending = (index: number, scoreKey: string): boolean => {
    const previous = unique.get(scoreKey);
    if (!previous) return false;
    previous.indices.push(index); metrics.preparedCacheHits++; return true;
  };
  try {
    // Preparation stays sequential to keep raw source buffers and decoder memory bounded.
    for (const [index, image] of images.entries()) {
      signal.throwIfAborted();
      try {
        let sha256 = 'bytes' in image ? digest(image.bytes) : image.sha256;
        if (sha256 !== undefined && !/^[a-f0-9]{64}$/u.test(sha256)) throw new Error('Invalid trusted image hash.');
        let scoreKey = sha256 ? scoreKeyFor(sha256) : undefined;
        if (scoreKey && (await reuseScore(index, scoreKey) || reusePending(index, scoreKey))) continue;
        let preparedKey = sha256 ? digest(JSON.stringify({kind: 'prepared', sha256, profile: IMAGE_PROFILE})) : undefined;
        let result = preparedKey ? await cached(cache && (() => cache.getPrepared(preparedKey!)), signal) : undefined;
        if (validPrepared(result)) metrics.preparedCacheHits++;
        else {
          const input = 'read' in image ? await bounded(image.read(), signal) : image;
          signal.throwIfAborted();
          const actualHash = digest(input.bytes);
          if (sha256 !== undefined && actualHash !== sha256) throw new Error('Image hash mismatch.');
          const hadHash = sha256 !== undefined;
          sha256 = actualHash;
          scoreKey = scoreKeyFor(sha256);
          if (!hadHash && (await reuseScore(index, scoreKey) || reusePending(index, scoreKey))) continue;
          preparedKey = digest(JSON.stringify({kind: 'prepared', sha256, profile: IMAGE_PROFILE}));
          // Lazy inputs without descriptor hashes can still share cached derived images.
          if (!hadHash) result = await cached(cache && (() => cache.getPrepared(preparedKey!)), signal);
          if (validPrepared(result)) metrics.preparedCacheHits++;
          else {
            result = await prepareJevModelImage(input.bytes, input.mimeType, signal);
            await cached(cache && (() => cache.setPrepared(preparedKey!, result!)), signal);
          }
        }
        const item = {indices: [index], image: result, scoreKey: scoreKey!};
        prepared.push(item); unique.set(item.scoreKey, item);
      } catch {
        signal.throwIfAborted(); failures[index] = {sourceKey: image.sourceKey, code: 'IMAGE_PREPARATION_FAILED'};
      }
    }
    let cursor = 0;
    const run = async () => {
      while (cursor < prepared.length && !signal.aborted) {
        const item = prepared[cursor++]!;
        let release: (() => void) | undefined;
        try {
          const reference = randomUUID();
          const body = JSON.stringify({model: config.model,
            state: {images: [{image: reference}], ...(config.instructions ? {additional_criteria: config.instructions} : {})},
            assets: {[reference]: {type: 'image', format: item.image.mimeType === 'image/jpeg' ? 'jpeg' : 'png', data_base64: item.image.data}},
            questions: {nsfw_0: question},
          });
          const bytes = Buffer.byteLength(body);
          if (bytes > 10 * 1024 * 1024) throw new ForwardNsfwError('NSFW_REQUEST_TOO_LARGE');
          signal.throwIfAborted();
          if (options.acquireRequest) {
            const acquiring = Promise.resolve().then(() => options.acquireRequest!(signal));
            try { release = await bounded(acquiring, signal); }
            catch (error) { void acquiring.then(lateRelease => lateRelease(), () => {}); throw error; }
          }
          signal.throwIfAborted();
          const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(config.timeoutSeconds * 1000)]);
          metrics.requestCount++; metrics.requestBytes += bytes;
          let value: unknown;
          try {
            value = await bounded((async () => {
              const response = await fetcher(`${policy.baseUrl}/systemone`, {
                method: 'POST', redirect: 'error',
                headers: {authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json', 'TypeSafe-Danger-Zone-Images': 'true'},
                body, signal: requestSignal,
              });
              if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new ForwardNsfwError('NSFW_HTTP_ERROR', response.status); }
              return await responseJson(response);
            })(), requestSignal);
          } catch (error) {
            if (requestSignal.aborted) throw new ForwardNsfwError(signal.aborted ? 'NSFW_CANCELLED' : 'NSFW_TIMEOUT');
            throw error instanceof ForwardNsfwError ? error : new ForwardNsfwError('NSFW_NETWORK_ERROR');
          }
          const response = object(value), answers = object(response?.answers), answer = object(answers?.nsfw_0), score = answer?.noul;
          if (answer?.type !== 'noul' || typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) throw new ForwardNsfwError('NSFW_INVALID_RESPONSE');
          const model = typeof response?.model === 'string' ? response.model.slice(0, 200) : undefined;
          for (const index of item.indices) {
            scores[index] = {sourceKey: images[index]!.sourceKey, score}; models[index] = model;
          }
          metrics.cacheHits += item.indices.length - 1;
          const receivedUsage = object(response?.usage);
          for (const [target, source] of [['inputTokens', 'input_tokens'], ['outputTokens', 'output_tokens']] as const) {
            const count = receivedUsage?.[source];
            if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) usage[target] = (usage[target] ?? 0) + count;
          }
          await cached(cache && (() => cache.setScore(item.scoreKey, {score, ...(model ? {model} : {})})), signal);
        } catch (error) {
          const failure = error instanceof ForwardNsfwError ? error : new ForwardNsfwError(signal.aborted ? 'NSFW_CANCELLED' : 'NSFW_NETWORK_ERROR');
          for (const index of item.indices) failures[index] = {sourceKey: images[index]!.sourceKey, code: failure.code, ...(failure.httpStatus ? {httpStatus: failure.httpStatus} : {})};
        } finally { release?.(); }
      }
    };
    await Promise.all(Array.from({length: Math.min(2, prepared.length)}, run));
    if (signal.aborted) throw cancelled();
  } catch (error) {
    if (signal.aborted) throw cancelled();
    throw error;
  }
  const validScores = scores.filter(item => !!item), failed = failures.filter(item => !!item);
  if (!validScores.length) {
    const networkFailure = failed.find(item => item.code !== 'IMAGE_PREPARATION_FAILED');
    throw new ForwardNsfwError(networkFailure?.code ?? 'NSFW_NO_VALID_IMAGES', networkFailure?.httpStatus, {failures: failed, metrics});
  }
  const model = models.find(item => item !== undefined);
  return {scores: validScores, failures: failed, ...metrics, ...(model ? {model} : {}), ...(Object.keys(usage).length ? {usage} : {})};
}
