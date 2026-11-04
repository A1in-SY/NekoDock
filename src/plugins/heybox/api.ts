import { PluginExecutionError } from '../../plugin-system/contracts.js';
import { heyboxSignedUrl } from './signing.js';
import { normalizeHeyboxResource } from './recognize.js';
import type { HeyboxResource } from './types.js';

export class HeyboxError extends PluginExecutionError {}
export const object = (value: unknown): Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
export const text = (value: unknown, max = 12000): string => typeof value === 'string' ? value.slice(0, max).trim() : '';
export const identifier = (value: unknown): string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/u.test(value) ? value
  : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : '';
export function heyboxImageUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 4096) return;
  try {
    const url = new URL(value.startsWith('//') ? 'https:' + value : value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port
      || !/(?:^|\.)(?:max-c\.com|steamstatic\.com|steamcdn-a\.akamaihd\.net)$/u.test(url.hostname)) return;
    url.protocol = 'https:'; return url.toString();
  } catch { return; }
}
export async function boundedBytes(response: Response, max: number): Promise<Buffer> {
  if (!response.ok) { await response.body?.cancel(); throw new HeyboxError(response.status === 401 || response.status === 403 ? 'HEYBOX_ACCESS_RESTRICTED' : 'HEYBOX_NETWORK_FAILED', response.status === 429 || response.status >= 500); }
  if (Number(response.headers.get('content-length')) > max) { await response.body?.cancel(); throw new HeyboxError('HEYBOX_RESPONSE_TOO_LARGE'); }
  const reader = response.body?.getReader(); if (!reader) throw new HeyboxError('HEYBOX_RESPONSE_INVALID');
  const chunks: Buffer[] = []; let size = 0;
  try {
    while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > max) throw new HeyboxError('HEYBOX_RESPONSE_TOO_LARGE'); chunks.push(Buffer.from(part.value)); }
    return Buffer.concat(chunks, size);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export async function resolveGameType(source: HeyboxResource, fetcher: typeof fetch, signal: AbortSignal): Promise<HeyboxResource> {
  if (source.gameType) return source;
  let url = source.url;
  for (let hop = 0; hop < 4; hop++) {
    const current = normalizeHeyboxResource(url); if (!current) throw new HeyboxError('HEYBOX_REDIRECT_REJECTED');
    if (current.gameType) return current;
    const response = await fetcher(current.url, { redirect: 'manual', signal, headers: { 'user-agent': 'Mozilla/5.0' } });
    await response.body?.cancel();
    if (response.status < 300 || response.status >= 400) throw new HeyboxError('HEYBOX_GAME_TYPE_UNKNOWN');
    const location = response.headers.get('location'); if (!location) throw new HeyboxError('HEYBOX_GAME_TYPE_UNKNOWN');
    const target = normalizeHeyboxResource(new URL(location, current.url).toString()); if (!target) throw new HeyboxError('HEYBOX_REDIRECT_REJECTED');
    url = target.url;
  }
  throw new HeyboxError('HEYBOX_REDIRECT_LIMIT');
}
export async function fetchGameDetail(source: HeyboxResource, fetcher: typeof fetch, signal: AbortSignal, cookie?: string): Promise<Record<string, any>> {
  const resource = await resolveGameType(source, fetcher, signal);
  if (!resource.gameType) throw new HeyboxError('HEYBOX_GAME_TYPE_UNKNOWN');
  const path = resource.gameType === 'pc' ? '/game/get_game_detail/' : `/game/${resource.gameType}/get_game_detail/`;
  const url = heyboxSignedUrl(path, { [resource.gameType === 'pc' ? 'steam_appid' : 'appid']: resource.appId,
    os_type: 'web', app: 'heybox', client_type: 'web', web_version: '2.5', x_client_type: 'web', x_app: 'heybox_website', x_os_type: 'Android', device_info: 'Chrome', _notip: 'true' });
  const response = await fetcher(url, { redirect: 'error', signal, headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', referer: 'https://www.xiaoheihe.cn/', ...(cookie ? { cookie } : {}) } });
  let data: Record<string, any>;
  try { data = object(JSON.parse((await boundedBytes(response, 4 * 1024 * 1024)).toString('utf8'))); }
  catch (error) { if (error instanceof HeyboxError) throw error; throw new HeyboxError('HEYBOX_RESPONSE_INVALID'); }
  if (data.status !== 'ok') throw new HeyboxError('HEYBOX_API_FAILED');
  const result = object(data.result);
  if (!text(result.name) || !identifier(result.appid ?? result.steam_appid) || result.game_type !== resource.gameType) throw new HeyboxError('HEYBOX_RESPONSE_INVALID');
  if (/^\d+$/u.test(resource.appId) && identifier(result.appid ?? result.steam_appid) !== resource.appId) throw new HeyboxError('HEYBOX_GAME_MISMATCH');
  return result;
}
