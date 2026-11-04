import type { ManagedIdentity } from './managed-worker.js';
import type { IncomingImageDescriptor, IncomingImageRemote } from './incoming-image-contract.js';
import { directFetch } from './network.js';
import { NAPCAT_MEDIA_MAX_BYTES } from './transport-protocol.js';

function descriptor(value: unknown): IncomingImageDescriptor {
  const item = value as IncomingImageDescriptor | null;
  if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(item.id)
    || typeof item.messageId !== 'string' || !item.messageId || item.messageId.length > 200
    || !Number.isSafeInteger(item.index) || item.index < 0 || item.index > 100_000
    || item.sourceKey !== undefined && (typeof item.sourceKey !== 'string' || item.sourceKey.length > 500)
    || !['pending', 'ready', 'failed', 'expired', 'transferred'].includes(item.status)
    || item.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(item.sha256)
    || item.size !== undefined && (!Number.isSafeInteger(item.size) || item.size < 1 || item.size > NAPCAT_MEDIA_MAX_BYTES)
    || item.mimeType !== undefined && !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(item.mimeType)
    || item.status === 'ready' && (!item.sha256 || !item.size || !item.mimeType)) throw new Error('IMAGE_TRANSFER_INVALID');
  return { id: item.id, messageId: item.messageId, index: item.index, status: item.status,
    ...(item.sourceKey !== undefined ? { sourceKey: item.sourceKey } : {}),
    ...(item.sha256 ? { sha256: item.sha256 } : {}), ...(item.size ? { size: item.size } : {}),
    ...(item.mimeType ? { mimeType: item.mimeType } : {}),
    ...(item.error ? { error: /^[A-Z][A-Z_]{0,99}$/.test(item.error) ? item.error : 'IMAGE_UNAVAILABLE' } : {}) };
}

/** Management downloads always use the private direct transport, independently of image egress. */
export function createIncomingImageRemote(identity: ManagedIdentity, maxBytes: number, timeoutMs: number,
  request: typeof globalThis.fetch = directFetch): IncomingImageRemote {
  let cursor: string | undefined;
  const endpoint = `${identity.url}/internal/workers/${encodeURIComponent(identity.botId)}/incoming-images`;
  const path = (id: string) => {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('IMAGE_TRANSFER_INVALID');
    return `${endpoint}/${encodeURIComponent(id)}`;
  };
  const call = async (url: string, signal: AbortSignal, body?: unknown, binary = false) => {
    const combined = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    const response = await request(url, { method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${identity.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: combined, redirect: 'error' });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw Object.assign(new Error('IMAGE_TRANSFER_UNAVAILABLE'), { status: response.status });
    }
    const limit = binary ? maxBytes : 256 * 1024;
    const length = response.headers.get('content-length');
    if (length !== null && /^\d+$/.test(length) && Number(length) > limit) {
      await response.body.cancel(); throw new Error('IMAGE_TRANSFER_TOO_LARGE');
    }
    const reader = response.body.getReader(); const chunks: Buffer[] = []; let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength; if (size > limit) throw new Error('IMAGE_TRANSFER_TOO_LARGE');
        chunks.push(Buffer.from(value));
      }
      combined.throwIfAborted();
      return Buffer.concat(chunks, size);
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  };
  const json = async (url: string, signal: AbortSignal, body?: unknown): Promise<unknown> => {
    const bytes = await call(url, signal, body);
    try { return JSON.parse(bytes.toString('utf8')); } catch { throw new Error('IMAGE_TRANSFER_INVALID'); }
  };
  return {
    list: async signal => {
      const value = await json(cursor ? `${endpoint}?after=${encodeURIComponent(cursor)}` : endpoint, signal) as { images?: unknown; nextCursor?: unknown };
      if (!value || !Array.isArray(value.images) || value.images.length > 100) throw new Error('IMAGE_TRANSFER_INVALID');
      if (value.nextCursor !== undefined && value.nextCursor !== null && (typeof value.nextCursor !== 'string'
        || !/^[A-Za-z0-9_-]{1,128}$/.test(value.nextCursor))) throw new Error('IMAGE_TRANSFER_INVALID');
      const images = value.images.map(descriptor);
      cursor = typeof value.nextCursor === 'string' ? value.nextCursor : undefined;
      return images;
    },
    get: async (id, signal) => {
      const item = descriptor(await json(path(id), signal));
      if (item.id !== id) throw new Error('IMAGE_TRANSFER_INVALID'); return item;
    },
    content: async (id, signal) => call(`${path(id)}/content`, signal, undefined, true),
    acknowledge: async (id, sha256, signal) => { await json(`${path(id)}/ack`, signal, sha256 ? { sha256 } : {}); },
  };
}
