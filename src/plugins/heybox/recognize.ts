import type { HeyboxGameType, HeyboxResource } from './types.js';

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const scalar = (value: unknown) => typeof value === 'string' ? value : '';
export function normalizeHeyboxResource(input: string, title?: string): HeyboxResource | null {
  if (input.length > 4096) return null;
  try {
    const url = new URL(input);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port || !['api.xiaoheihe.cn', 'www.xiaoheihe.cn', 'xiaoheihe.cn'].includes(url.hostname)) return null;
    let appId: string | undefined, gameType: HeyboxGameType | undefined;
    const web = /^\/app\/topic\/game\/(pc|console|mobile)\/([A-Za-z0-9_-]{1,80})\/?$/u.exec(url.pathname);
    const legacy = /^\/games\/detail\/([A-Za-z0-9_-]{1,80})\/?$/u.exec(url.pathname);
    if (web) { gameType = web[1] as HeyboxGameType; appId = web[2]!; }
    else if (legacy) { gameType = 'pc'; appId = legacy[1]!; }
    else if (/^\/game\/share_game_detail\/?$/u.test(url.pathname)) {
      const value = url.searchParams.get('appid'); if (!value || !/^[A-Za-z0-9_-]{1,80}$/u.test(value)) return null; appId = value;
      const type = url.searchParams.get('game_type');
      if (type && !['pc', 'console', 'mobile'].includes(type)) return null;
      if (type) gameType = type as HeyboxGameType;
    } else return null;
    const canonical = gameType ? `https://www.xiaoheihe.cn/app/topic/game/${gameType}/${appId}`
      : `https://api.xiaoheihe.cn/game/share_game_detail?appid=${encodeURIComponent(appId)}`;
    return { kind: 'game', id: `game:${gameType ?? 'unknown'}:${appId}`, appId, ...(gameType ? { gameType } : {}), url: canonical,
      ...(title ? { title: title.slice(0, 500) } : {}) };
  } catch { return null; }
}

export function heyboxResources(event: unknown): HeyboxResource[] {
  const e = object(event), parts: string[] = [];
  if (typeof e.message === 'string') parts.push(e.message.slice(0, 65536));
  else if (Array.isArray(e.message)) for (const raw of e.message.slice(0, 100)) {
    const segment = object(raw), data = object(segment.data);
    if (segment.type === 'text') parts.push(scalar(data.text).slice(0, 65536));
    if (segment.type !== 'json') continue;
    let card = object(data.data);
    try { if (typeof data.data === 'string' && data.data.length <= 65536) card = object(JSON.parse(data.data)); } catch { continue; }
    for (const item of Object.values(object(card.meta)).slice(0, 20)) {
      const value = object(item); for (const key of ['qqdocurl', 'url', 'jumpUrl']) if (typeof value[key] === 'string') parts.push(value[key].slice(0, 4096));
    }
  }
  const out = new Map<string, HeyboxResource>();
  const found = parts.join('\n').slice(0, 128 * 1024).match(/https?:\/\/(?:(?:api|www)\.)?xiaoheihe\.cn\/[^\s<>"'\]，。]+/gu) ?? [];
  for (const value of found.slice(0, 8)) { const resource = normalizeHeyboxResource(value); if (resource) out.set(resource.id, resource); }
  return [...out.values()];
}
