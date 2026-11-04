export function pluginAssetUrl(botId: string, assetId: unknown): string | undefined {
  if (typeof assetId !== 'string' || !/^[A-Za-z0-9:_-]{1,200}$/u.test(assetId)) return;
  return `/api/bots/${encodeURIComponent(botId)}/plugins/assets/${encodeURIComponent(assetId)}`;
}

export function pluginMediaAssetId(value: unknown): unknown {
  const asset = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return asset.assetId ?? asset.id;
}

export function sharedContentLink(value: unknown, platform?: unknown): string | undefined {
  if (typeof value !== 'string') return;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return;
    const hosts = platform === 'bilibili' ? ['bilibili.com', 'www.bilibili.com', 'm.bilibili.com', 't.bilibili.com', 'live.bilibili.com']
      : platform === 'heybox' ? ['xiaoheihe.cn', 'www.xiaoheihe.cn', 'api.xiaoheihe.cn', 'web.xiaoheihe.cn']
      : platform === 'douyin' ? ['douyin.com', 'www.douyin.com', 'v.douyin.com', 'jx.douyin.com', 'iesdouyin.com', 'www.iesdouyin.com'] : undefined;
    if (hosts && (!hosts.includes(url.hostname) || url.port)) return;
    return url.href;
  } catch { /* Unavailable links remain visible as resource metadata. */ }
}

export function sharedContentTime(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 100_000_000_000 ? value * 1000 : undefined;
}

export function sharedContentKind(value: unknown): string {
  return value === 'post' ? '动态' : value === 'live' ? '直播' : value === 'article' ? '文章' : value === 'game' ? '游戏' : '视频';
}

export function sharedContentPlatform(value: unknown): string | undefined {
  return value === 'bilibili' ? '哔哩哔哩' : value === 'heybox' ? '小黑盒' : value === 'douyin' ? '抖音' : undefined;
}

export function sharedImageCaption(contentType: unknown, role: unknown): string {
  if (role === 'presentation') return contentType === 'game' ? '游戏资料卡片' : '分享卡片';
  if (role === 'cover') return contentType === 'game' ? '游戏封面' : contentType === 'video' ? '视频封面' : '封面';
  return contentType === 'post' ? '动态配图' : contentType === 'game' ? '游戏图片' : '分享图片';
}

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const boundedText = (value: unknown) => typeof value === 'string' ? value.trim().slice(0, 500) : '';
const strings = (value: unknown) => Array.isArray(value) ? value.slice(0, 30).map(boundedText).filter(Boolean) : [];

export function gameFacts(value: unknown): Array<{ label: string; value: string }> {
  const game = record(value), platforms = Array.isArray(game.platforms) ? game.platforms.slice(0, 20).map(item => boundedText(record(item).name)).filter(Boolean) : [];
  return [
    { label: '当前平台', value: boundedText(game.platformName) || boundedText(game.platform) },
    { label: '发行日期', value: boundedText(game.releaseDate) },
    { label: '开发商', value: strings(game.developers).join('、') },
    { label: '发行商', value: strings(game.publishers).join('、') },
    { label: '游戏平台', value: [...new Set(platforms)].join(' / ') },
  ].filter(fact => fact.value);
}

export function gameScore(value: unknown): { label: string; value: string; count?: number } | undefined {
  const score = record(record(value).score);
  if (typeof score.value !== 'number' || !Number.isFinite(score.value) || typeof score.scale !== 'number' || !Number.isFinite(score.scale) || score.scale <= 0 || score.value < 0 || score.value > score.scale) return;
  const source = score.source === 'heybox' ? '小黑盒' : boundedText(score.source);
  return { label: source ? `${source}评分` : '评分', value: `${score.value} / ${score.scale}`,
    ...(typeof score.count === 'number' && Number.isSafeInteger(score.count) && score.count >= 0 ? { count: score.count } : {}) };
}

export interface GamePriceView {
  label: string; source: string; current: string; original?: string;
  discount?: string; region?: string; lowest?: string; condition?: string;
}

export function gamePrices(value: unknown): GamePriceView[] {
  const raw = record(value).prices;
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 10).flatMap(item => {
    const price = record(item), current = boundedText(price.current);
    if (!current || !['platform', 'heybox'].includes(String(price.source))) return [];
    const currency = boundedText(price.currency), money = (amount: string) => currency ? `${amount} ${currency}` : amount;
    const original = boundedText(price.original), lowest = boundedText(price.recordedLowest);
    const source = price.source === 'heybox' ? '小黑盒商城' : '平台商店';
    return [{ label: boundedText(price.label) || source, source, current: money(current),
      ...(original && original !== current ? { original: money(original) } : {}),
      ...(typeof price.discountPercent === 'number' && Number.isFinite(price.discountPercent) && price.discountPercent > 0 && price.discountPercent <= 100 ? { discount: `优惠 ${price.discountPercent}%` } : {}),
      ...(boundedText(price.region) ? { region: boundedText(price.region) } : {}),
      ...(lowest ? { lowest: `${price.source === 'heybox' ? '小黑盒商城记录史低' : '小黑盒记录史低（该平台）'} ${money(lowest)}` } : {}),
      ...(boundedText(price.condition) ? { condition: boundedText(price.condition) } : {}),
    }];
  });
}

export const liveStatusLabels: Record<string, string> = { live: '直播中', offline: '未开播', replay: '轮播中' };

export function forwardImageAssetIds(contents: unknown): Set<string> {
  const ids = new Set<string>();
  let nodes = 0;
  const visit = (value: unknown, depth: number) => {
    const content = record(value);
    if (content.type !== 'forward' || depth > 8 || !Array.isArray(content.nodes)) return;
    for (const value of content.nodes) {
      if (++nodes > 200) return;
      const node = record(value);
      if (!Array.isArray(node.segments)) continue;
      for (const value of node.segments) {
        const segment = record(value);
        if (segment.type === 'image' && typeof segment.assetId === 'string') ids.add(segment.assetId);
        else if (segment.type === 'forward') visit(segment, depth + 1);
      }
    }
  };
  if (Array.isArray(contents)) for (const content of contents) visit(content, 1);
  return ids;
}

export function forwardImageAttachment(assetId: unknown, images: unknown): unknown {
  return typeof assetId === 'string' && Array.isArray(images)
    ? images.find(image => record(image).attachmentId === assetId) : undefined;
}

export function incomingImageUrl(botId: string, image: unknown): string | undefined {
  const value = record(image);
  return value.status === 'ready' && typeof value.path === 'string' && value.path.startsWith('/')
    ? `/api/bots/${encodeURIComponent(botId)}/media?path=${encodeURIComponent(value.path)}` : undefined;
}

export function forwardStatusLabel(status: unknown): string {
  return status === 'pending' ? '正在读取聊天记录' : status === 'partial' ? '部分内容未读取'
    : status === 'failed' ? '聊天记录读取失败' : status === 'ready' ? '' : '聊天记录状态未知';
}

export function nativeIncomingImages(value: unknown, contents?: unknown): unknown[] {
  const forwarded = forwardImageAssetIds(contents);
  return Array.isArray(value) ? value.filter(image => {
    const asset = record(image);
    return asset.origin !== 'plugin' && !forwarded.has(String(asset.attachmentId));
  }) : [];
}
