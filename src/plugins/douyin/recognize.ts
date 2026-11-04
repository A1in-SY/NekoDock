import type { PluginResource } from '../../plugin-system/contracts.js';

export interface DouyinResource extends PluginResource { kind: 'video' | 'short' | 'note'; }
const hosts = new Set(['douyin.com', 'www.douyin.com', 'm.douyin.com', 'iesdouyin.com', 'www.iesdouyin.com', 'jingxuan.douyin.com']);
export function normalizeDouyinResource(input: string): DouyinResource | null {
  if (input.length > 4096) return null;
  try {
    const url = new URL(input);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return null;
    const host = url.hostname.toLowerCase();
    if (host === 'v.douyin.com' || host === 'jx.douyin.com') {
      const token = /^\/([A-Za-z0-9_-]{1,120})\/?$/u.exec(url.pathname)?.[1];
      return token ? { kind: 'short', id: `short:${host}:${token}`, url: `https://${host}/${token}/` } : null;
    }
    if (!hosts.has(host)) return null;
    const path = /^\/(?:share\/|m\/)?(video|note|slides)\/(\d{10,24})\/?$/u.exec(url.pathname);
    const modal = url.searchParams.get('modal_id');
    const id = path?.[2] ?? (modal && /^\d{10,24}$/u.test(modal) ? modal : undefined);
    if (!id) return null;
    const kind = path && path[1] !== 'video' ? 'note' : 'video';
    return { kind, id: `${kind}:${id}`, url: `https://www.douyin.com/${kind}/${id}` };
  } catch { return null; }
}
export function douyinResources(event: unknown): DouyinResource[] {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return [];
  const source = event as Record<string, unknown>, texts: string[] = [];
  if (typeof source.message === 'string') texts.push(source.message);
  else if (Array.isArray(source.message)) for (const item of source.message.slice(0,256)) {
    if (!item || typeof item !== 'object') continue;
    const segment = item as Record<string, unknown>, data = segment.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
    const payload = data as Record<string, unknown>;
    if (segment.type === 'text' && typeof payload.text === 'string') texts.push(payload.text.slice(0,64000));
    if (segment.type === 'json') {
      let card: unknown = payload.data;
      try { if (typeof card === 'string' && card.length <= 128000) card = JSON.parse(card); } catch { continue; }
      if (!card || typeof card !== 'object' || Array.isArray(card)) continue;
      const meta = (card as Record<string, unknown>).meta;
      if (!meta || typeof meta !== 'object' || Array.isArray(meta)) continue;
      for (const entry of Object.values(meta).slice(0,32)) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const detail = entry as Record<string, unknown>;
        for (const key of ['qqdocurl', 'url', 'jumpUrl']) if (typeof detail[key] === 'string') texts.push(detail[key].slice(0,4096));
      }
    }
  }
  const matches = texts.join('\n').slice(0,128000).match(/https?:\/\/[^\s<>"'\]，。！；）)]+/gu) ?? [];
  const resources = new Map<string, DouyinResource>();
  for (const candidate of matches.slice(0,32)) {
    const resource = normalizeDouyinResource(candidate);
    if (resource) resources.set(resource.id, resource);
    if (resources.size >= 8) break;
  }
  return [...resources.values()];
}
