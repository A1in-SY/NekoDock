import { BilibiliError } from './errors.js';

export const object = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
export const string = (v: unknown, limit = 12000): string => typeof v === 'string' ? v.slice(0, limit) : '';
export const id = (v: unknown): string => typeof v === 'string' && /^\d{1,30}$/u.test(v) ? v : typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? String(v) : '';
export const timestamp = (v: unknown): number | undefined => {
  const n = typeof v === 'string' && /^\d{1,13}$/u.test(v) || typeof v === 'number' ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

export function imageUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 4096) return;
  try {
    const u = new URL(value.startsWith('//') ? 'https:' + value : value);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.port || !/(?:^|\.)hdslb\.com$/u.test(u.hostname)) return;
    u.protocol = 'https:'; return u.toString();
  } catch { return; }
}

export async function boundedBytes(response: Response, max: number): Promise<Buffer> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new BilibiliError(response.status === 412 ? 'BILIBILI_HTTP_412' : response.status === 401 || response.status === 403 ? 'BILIBILI_LOGIN_REQUIRED' : 'BILIBILI_NETWORK_FAILED', response.status === 429 || response.status >= 500);
  }
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > max) { await response.body?.cancel(); throw new BilibiliError('BILIBILI_RESPONSE_TOO_LARGE'); }
  const reader = response.body?.getReader(); if (!reader) throw new BilibiliError('BILIBILI_FETCH_FAILED');
  const chunks: Buffer[] = []; let size = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.length; if (size > max) throw new BilibiliError('BILIBILI_RESPONSE_TOO_LARGE');
      chunks.push(Buffer.from(chunk.value));
    }
    return Buffer.concat(chunks, size);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function apiJson(url: string, fetcher: typeof globalThis.fetch, signal: AbortSignal, cookie?: string): Promise<Record<string, any>> {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !['api.bilibili.com', 'api.live.bilibili.com'].includes(u.hostname)) throw new BilibiliError('BILIBILI_API_URL_REJECTED');
  const response = await fetcher(u, { signal, redirect: 'error', headers: { 'user-agent': 'Mozilla/5.0', referer: u.hostname === 'api.live.bilibili.com' ? 'https://live.bilibili.com/' : 'https://www.bilibili.com/', ...(cookie ? { cookie } : {}) } });
  let result: Record<string, any>;
  try { result = object(JSON.parse((await boundedBytes(response, 4 * 1024 * 1024)).toString('utf8'))); }
  catch (error) { if (error instanceof BilibiliError) throw error; throw new BilibiliError('BILIBILI_RESPONSE_INVALID'); }
  if (result.code !== 0) throw new BilibiliError(result.code === -101 || result.code === -403 ? 'BILIBILI_LOGIN_REQUIRED' : result.code === -352 || result.code === -412 ? 'BILIBILI_HTTP_412' : result.code === 1 || result.code === 4101105 || result.code === 4101131 ? 'BILIBILI_NOT_FOUND' : 'BILIBILI_API_FAILED');
  return object(result.data);
}
