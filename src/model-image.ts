import { Worker } from 'node:worker_threads';
import { resizeImage } from '@earendil-works/pi-coding-agent';
import type { ContextImage } from './pi-context.js';

// maxBytes bounds the Base64 payload, rather than the decoded file size.
export const MODEL_IMAGE_OPTIONS = { maxWidth: 1600, maxHeight: 1600, maxBytes: 512 * 1024, jpegQuality: 80 };

export async function prepareModelImage(bytes: Buffer, mimeType: string): Promise<ContextImage> {
  const prepared = await resizeImage(bytes, mimeType, MODEL_IMAGE_OPTIONS);
  if (!prepared) throw new Error('Image cannot be prepared for inline context.');
  return { type: 'image', data: prepared.data, mimeType: prepared.mimeType };
}


/** Jev has a narrower static-image contract than the chat model. */
export async function prepareJevModelImage(bytes: Buffer, mimeType: string, signal?: AbortSignal): Promise<ContextImage> {
  if (!bytes.length || bytes.length > 16 * 1024 * 1024 || !/^image\/(?:png|jpeg|jpg|gif|webp)$/u.test(mimeType)) throw new Error('IMAGE_PREPARATION_FAILED');
  const normalize = async (input: Buffer): Promise<Buffer> => {
    signal?.throwIfAborted();
    const worker = new Worker(new URL('./model-image-jev-worker.js', import.meta.url));
    try {
      return await new Promise<Buffer>((resolve, reject) => {
        const stop = () => reject(signal?.reason ?? new Error('IMAGE_PREPARATION_CANCELLED'));
        signal?.addEventListener('abort', stop, {once: true});
        const finish = (error?: unknown, result?: Buffer) => {
          signal?.removeEventListener('abort', stop);
          if (error) reject(error); else resolve(result!);
        };
        worker.once('message', (message: {bytes?: Uint8Array; error?: string}) => message.bytes ? finish(undefined, Buffer.from(message.bytes)) : finish(new Error('IMAGE_PREPARATION_FAILED')));
        worker.once('error', () => finish(new Error('IMAGE_PREPARATION_FAILED')));
        worker.once('exit', code => { if (code !== 0) finish(new Error('IMAGE_PREPARATION_FAILED')); });
        worker.postMessage({bytes: new Uint8Array(input)});
      });
    } finally { await worker.terminate(); }
  };
  let source = await normalize(bytes);
  for (let attempt = 0; attempt < 2; attempt++) {
    signal?.throwIfAborted();
    const prepared = await resizeImage(source, 'image/png', {...MODEL_IMAGE_OPTIONS, maxWidth: 1568, maxHeight: 1568});
    signal?.throwIfAborted();
    if (!prepared) throw new Error('IMAGE_PREPARATION_FAILED');
    if (prepared.width >= 280 && prepared.height >= 280) return {type: 'image', data: prepared.data, mimeType: prepared.mimeType};
    source = await normalize(Buffer.from(prepared.data, 'base64'));
  }
  throw new Error('IMAGE_PREPARATION_FAILED');
}
