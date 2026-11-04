import type { PluginContent, PluginContentImage, PluginGameInfo, PluginGamePrice } from '../../plugin-system/contracts.js';
import { HeyboxError, heyboxImageUrl, identifier, object, text } from './api.js';
import { normalizeHeyboxResource } from './recognize.js';
import type { HeyboxResource } from './types.js';

const types = ['pc', 'console', 'mobile'];
const platformNames: Record<string, string> = { steam: 'Steam', epic: 'Epic', ps4: 'PSN', ps5: 'PSN', psn: 'PSN', xbox: 'Xbox', switch: 'Nintendo Switch', ns: 'Nintendo Switch', android: 'Android', ios: 'iOS' };
const number = (value: unknown, max = 1e12): number | undefined => (typeof value === 'number' || typeof value === 'string' && /^\d+(?:\.\d+)?$/u.test(value)) && Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= max ? Number(value) : undefined;
const amount = (value: unknown): string | undefined => { const n = number(value, 1e9); return n === undefined ? undefined : String(n); };
const strings = (value: unknown, max = 12): string[] => Array.isArray(value) ? [...new Set(value.slice(0, max).map(item => text(typeof item === 'string' ? item : object(item).value ?? object(item).name, 160)).filter(Boolean))] : [];
const clean = (value: unknown, max: number) => text(value, max * 4).replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, '').replace(/<[^>]*>/gu, ' ').replace(/&(?:nbsp|amp|lt|gt|quot|#39);/gu, entity => ({ '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[entity] ?? '').replace(/[\t ]+/gu, ' ').trim().slice(0, max);

export function parseGameDetail(value: unknown, source: HeyboxResource, observedAt = Date.now() / 1000): PluginContent {
  const raw = object(value), appId = identifier(raw.appid ?? raw.steam_appid), gameType = raw.game_type;
  if (!text(raw.name) || !appId || !types.includes(gameType) || source.gameType && source.gameType !== gameType
    || /^\d+$/u.test(source.appId) && source.appId !== appId) throw new HeyboxError('HEYBOX_GAME_MISMATCH');
  const platforms: NonNullable<PluginGameInfo['platforms']> = Array.isArray(raw.platforms_list) ? raw.platforms_list.slice(0, 16).flatMap((item: unknown) => {
    const p = object(item), id = identifier(p.appid), platform = text(p.platf, 60); return id && platform && types.includes(p.game_type) ? [{ id: platform, name: text(p.name, 100) || platformNames[platform] || platform, gameType: p.game_type, appId: id }] : [];
  }) : [];
  // The upstream PC field is named steam_appid even for Epic games; match identity explicitly.
  const selected = platforms.find(p => p.gameType === gameType && p.appId === appId);
  const platform = selected?.id || text(raw.platf, 60), platformName = selected?.name || platformNames[platform] || (platform === 'console' ? '主机' : platform || undefined);
  const score = number(raw.score, 10), count = number(object(raw.comment_stats).score_comment);
  const tags = [...new Set((Array.isArray(raw.common_tags) ? raw.common_tags : []).slice(0, 30).flatMap((item: unknown) => {
    const tag = object(item);
    if (Array.isArray(tag.detail_list)) return tag.detail_list.slice(0, 12).map((detail: unknown) => { const d = object(detail); return [text(d.name, 60), text(d.desc, 60)].filter(Boolean).join('：'); });
    return [text(tag.desc, 120)].filter(Boolean);
  }))].slice(0, 16);
  const prices: PluginGamePrice[] = [], price = object(raw.price), current = amount(price.current);
  if (current !== undefined) {
    const original = amount(price.initial), lowest = amount(price.lowest_price), discount = number(price.discount, 100), region = text(price.region_name, 100);
    prices.push({ source: 'platform', label: `${platformName ?? '平台'}商店价`, current, ...(original === undefined ? {} : { original }),
      ...(text(price.currency, 8) ? { currency: text(price.currency, 8) } : {}), ...(region ? { region } : {}),
      ...(discount === undefined ? {} : { discountPercent: discount }), ...(lowest === undefined ? {} : { recordedLowest: lowest }) });
  }
  const mall = object(raw.heybox_price), coin = number(mall.cost_coin, 1e12), originalCoin = number(mall.original_coin, 1e12), coupon = object(mall.coupon_info), couponPrice = amount(coupon.final_price);
  if (coin !== undefined) prices.push({ source: 'heybox', label: '小黑盒商城价', current: String(coin / 1000), ...(originalCoin === undefined ? {} : { original: String(originalCoin / 1000) }),
    ...(couponPrice === undefined ? {} : { condition: [text(coupon.coupon_desc, 120) || '需满足领券条件', `券后 ${couponPrice}`, text(coupon.sub_title, 160)].filter(Boolean).join('；') }) });
  const game: PluginGameInfo = { gameType, appId, ...(platform ? { platform } : {}), ...(platformName ? { platformName } : {}),
    ...(text(raw.name_en, 500) ? { nameEnglish: text(raw.name_en, 500) } : {}), ...(platforms.length ? { platforms } : {}), ...(tags.length ? { tags } : {}),
    ...(text(raw.release_date, 160) ? { releaseDate: text(raw.release_date, 160) } : {}),
    ...(strings(raw.developers).length ? { developers: strings(raw.developers) } : {}), ...(strings(raw.publishers).length ? { publishers: strings(raw.publishers) } : {}),
    ...(typeof raw.is_free === 'boolean' ? { isFree: raw.is_free } : {}),
    ...(score === undefined ? {} : { score: { value: score, scale: 10, ...(count === undefined ? {} : { count }), source: '小黑盒' } }), ...(prices.length ? { prices } : {}) };
  const coverUrl = heyboxImageUrl(raw.image), description = clean(raw.about_the_game || raw.desc, 6000);
  return { type: 'game', platform: 'heybox', resourceId: `game:${gameType}:${appId}`, url: `https://www.xiaoheihe.cn/app/topic/game/${gameType}/${appId}`,
    title: text(raw.name, 500), game, ...(description ? { description } : {}), ...(coverUrl ? { coverUrl } : {}), observedAt, retrieval: { status: 'ready' } };
}

export function validateHeyboxContent(value: unknown, source: HeyboxResource): PluginContent {
  const v = object(value), canonical = normalizeHeyboxResource(text(v.url, 4096)), g = object(v.game);
  if (v.type !== 'game' || v.platform !== 'heybox' || !canonical?.gameType || v.resourceId !== canonical.id || typeof v.title !== 'string'
    || g.gameType !== canonical.gameType || g.appId !== canonical.appId || source.gameType && source.gameType !== canonical.gameType
    || /^\d+$/u.test(source.appId) && source.appId !== canonical.appId) throw new Error('插件游戏资料无效');
  const game: PluginGameInfo = { gameType: canonical.gameType, appId: canonical.appId };
  for (const key of ['platform', 'platformName', 'nameEnglish', 'releaseDate'] as const) if (typeof g[key] === 'string') game[key] = g[key].slice(0, key === 'nameEnglish' ? 500 : 160);
  for (const key of ['tags', 'developers', 'publishers'] as const) if (Array.isArray(g[key])) game[key] = strings(g[key], key === 'tags' ? 16 : 12);
  if (typeof g.isFree === 'boolean') game.isFree = g.isFree;
  if (Array.isArray(g.platforms)) game.platforms = g.platforms.slice(0, 16).flatMap((item: unknown) => {
    const p = object(item); return identifier(p.appId) && types.includes(p.gameType) && text(p.id, 60) ? [{ id: text(p.id, 60), name: text(p.name, 100), gameType: p.gameType, appId: identifier(p.appId) }] : [];
  });
  const score = object(g.score), scale = number(score.scale, 100), scoreValue = number(score.value, scale);
  if (scale !== undefined && scale > 0 && scoreValue !== undefined) game.score = { value: scoreValue, scale, source: text(score.source, 100), ...(number(score.count) === undefined ? {} : { count: number(score.count) }) };
  if (Array.isArray(g.prices)) game.prices = g.prices.slice(0, 4).flatMap((item: unknown) => {
    const p = object(item), current = amount(p.current); if (!['platform', 'heybox'].includes(p.source) || current === undefined) return [];
    const result: PluginGamePrice = { source: p.source, label: text(p.label, 100), current };
    for (const key of ['original', 'recordedLowest'] as const) if (amount(p[key]) !== undefined) result[key] = amount(p[key]);
    for (const key of ['currency', 'region', 'condition'] as const) if (typeof p[key] === 'string') result[key] = text(p[key], key === 'condition' ? 400 : 100);
    if (number(p.discountPercent, 100) !== undefined) result.discountPercent = number(p.discountPercent, 100);
    return [result];
  });
  const content: PluginContent = { type: 'game', platform: 'heybox', resourceId: canonical.id, url: canonical.url, title: v.title.slice(0, 500), game, retrieval: { status: 'ready' } };
  if (typeof v.description === 'string') content.description = v.description.slice(0, 6000);
  const coverUrl = heyboxImageUrl(v.coverUrl); if (coverUrl) content.coverUrl = coverUrl;
  if (typeof v.observedAt === 'number' && Number.isFinite(v.observedAt) && v.observedAt > 0) content.observedAt = v.observedAt;
  const r = object(v.retrieval); if (['ready', 'partial', 'failed'].includes(r.status)) content.retrieval = { status: r.status, ...(typeof r.error === 'string' && /^[A-Z][A-Z0-9_]{0,100}$/u.test(r.error) ? { error: r.error } : {}) };
  if (Array.isArray(v.blocks)) content.blocks = v.blocks.slice(0, 1).flatMap((block: unknown) => {
    const b = object(block), i = object(b.image), url = heyboxImageUrl(i.url);
    if (b.type !== 'image' || i.role !== 'cover' || !url || typeof i.id !== 'string') return [];
    const image: PluginContentImage = { id: i.id.slice(0, 200), url, role: 'cover' };
    for (const key of ['assetKey', 'assetId'] as const) if (typeof i[key] === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/u.test(i[key])) image[key] = i[key];
    for (const key of ['width', 'height'] as const) if (Number.isSafeInteger(i[key]) && i[key] > 0 && i[key] <= 100000) image[key] = i[key];
    if (['pending', 'ready', 'failed'].includes(i.status)) image.status = i.status;
    if (typeof i.fetchedAt === 'number' && Number.isFinite(i.fetchedAt) && i.fetchedAt > 0) image.fetchedAt = i.fetchedAt;
    return [{ type: 'image' as const, image }];
  });
  return content;
}

export function contentText(content: PluginContent): string {
  const g = content.game;
  return [content.title, g?.nameEnglish, g?.platformName ? `平台：${g.platformName}` : undefined,
    g?.score ? `${g.score.source}评分：${g.score.value}/${g.score.scale}${g.score.count === undefined ? '' : `（${g.score.count} 人评价）`}` : undefined,
    g?.releaseDate ? `发行时间：${g.releaseDate}` : undefined, g?.developers?.length ? `开发商：${g.developers.join('、')}` : undefined,
    g?.publishers?.length ? `发行商：${g.publishers.join('、')}` : undefined, g?.isFree ? '免费游玩' : undefined,
    ...(g?.prices ?? []).map(p => `${p.label}：${p.currency ? p.currency + ' ' : ''}${p.current}${p.region ? `（${p.region}）` : ''}${p.discountPercent ? `，优惠 ${p.discountPercent}%` : ''}${p.recordedLowest !== undefined ? `；小黑盒记录史低 ${p.recordedLowest}` : ''}${p.condition ? `；${p.condition}` : ''}`),
    g?.tags?.join(' · '), content.description, content.observedAt ? `资料获取：${new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short', hourCycle: 'h23' }).format(content.observedAt * 1000)} UTC+8` : undefined,
    content.url].filter(Boolean).join('\n').slice(0, 12000);
}
