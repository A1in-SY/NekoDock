import { PluginExecutionError, type PluginContent, type PluginContentBlock, type PluginContentImage } from '../../plugin-system/contracts.js';
import { normalizeDouyinResource, type DouyinResource } from './recognize.js';

export const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
export function imageUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 8192) return;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port
      || !/(?:^|\.)(?:douyinpic\.com|byteimg\.com|ibytedtos\.com|pstatp\.com)$/u.test(url.hostname)) return;
    return url.toString();
  } catch { return; }
}
export function publicImageUrl(value: unknown): string | undefined {
  const safe = imageUrl(value); if (!safe) return;
  const url = new URL(safe); url.search = ''; url.hash = ''; return url.toString();
}
function contentImage(input: unknown, resourceId: string, role: 'cover' | 'avatar'): PluginContentImage | undefined {
  const image = object(input), url = publicImageUrl(image.url);
  if (image.role !== role || image.id !== `${resourceId}:${role}` || !url) return;
  const result: PluginContentImage = { id: image.id, role, url };
  if (['pending', 'ready', 'failed'].includes(image.status)) result.status = image.status;
  for (const field of ['assetId', 'assetKey'] as const) if (typeof image[field] === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/u.test(image[field])) result[field] = image[field];
  for (const field of ['width', 'height'] as const) if (Number.isSafeInteger(image[field]) && image[field] > 0 && image[field] <= 100000) result[field] = image[field];
  if (typeof image.fetchedAt === 'number' && Number.isFinite(image.fetchedAt) && image.fetchedAt > 0) result.fetchedAt = image.fetchedAt;
  if (typeof image.error === 'string' && /^DOUYIN_[A-Z_]{1,80}$/u.test(image.error)) result.error = image.error;
  return result;
}
export function validateDouyinContent(input: unknown, source: DouyinResource): PluginContent {
  const value = object(input), canonical = typeof value.url === 'string' ? normalizeDouyinResource(value.url) : null;
  if (value.type !== 'video' || value.platform !== 'douyin' || !canonical || canonical.kind !== 'video'
    || value.resourceId !== canonical.id || source.kind !== 'short' && source.id !== canonical.id || typeof value.title !== 'string') throw new Error('抖音资料无效');
  const content: PluginContent = { type: 'video', platform: 'douyin', resourceId: canonical.id, url: canonical.url,
    title: value.title.slice(0,500), subtitle: { status: 'absent' }, retrieval: { status: 'ready' } };
  for (const key of ['author', 'authorId', 'description'] as const) if (typeof value[key] === 'string') content[key] = value[key].slice(0,key === 'description' ? 12000 : 500);
  for (const key of ['publishedAt', 'durationSeconds', 'observedAt'] as const) if (typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] > 0) content[key] = value[key];
  const avatar = contentImage(value.authorAvatar,canonical.id,'avatar');
  if (avatar) content.authorAvatar = avatar;
  const retrieval = object(value.retrieval);
  if (['partial', 'failed'].includes(retrieval.status)) content.retrieval = { status: retrieval.status,
    ...(typeof retrieval.error === 'string' && /^[A-Z][A-Z0-9_]{0,100}$/u.test(retrieval.error) ? { error: retrieval.error } : {}) };
  const blocks: PluginContentBlock[] = [];
  if (content.description) blocks.push({ type: 'paragraph', text: content.description });
  for (const block of Array.isArray(value.blocks) ? value.blocks.slice(0,8) : []) {
    const item = object(block), cover = contentImage(item.image,canonical.id,'cover');
    if (item.type !== 'image' || !cover || blocks.some(b => b.type === 'image')) continue;
    blocks.push({ type: 'image', image: cover });
  }
  if (blocks.length) content.blocks = blocks;
  return content;
}
export function contentText(content: PluginContent): string {
  return [content.title, content.author ? `作者：${content.author}` : '',
    content.durationSeconds ? `时长：${Math.round(content.durationSeconds)} 秒` : '',
    content.description && content.description !== content.title ? content.description : '',
    '未取得可用字幕；发布文案不代表完整视频内容。', content.url].filter(Boolean).join('\n');
}
export function douyinError(error: unknown): PluginExecutionError {
  if (error instanceof PluginExecutionError) return error;
  const value = object(error);
  if (value.name === 'AbortError') return new PluginExecutionError('PLUGIN_CANCELLED');
  if (value.name === 'TimeoutError' || value.code === 'NETWORK_TIMEOUT') return new PluginExecutionError('DOUYIN_TIMEOUT', true);
  return new PluginExecutionError('DOUYIN_NETWORK_FAILED', true);
}
export function errorText(code: string): string {
  const messages: Record<string,string> = {
    DOUYIN_NOT_VIDEO: '此分享不是支持的视频作品。', DOUYIN_NOT_FOUND: '视频不存在或当前不可访问。',
    DOUYIN_VISITOR_REJECTED: '平台未返回可用视频资料，请稍后再试。', DOUYIN_RATE_LIMITED: '平台暂时限制了请求，请稍后再试。',
    DOUYIN_DURATION_LIMIT: '无法确认视频时长，或时长超过实例上限。', DOUYIN_MEDIA_TOO_LARGE: '视频超过实例大小上限。',
    DOUYIN_MEDIA_FORMAT_UNSUPPORTED: '没有符合清晰度和格式限制的视频流。', DOUYIN_TIMEOUT: '视频处理超时。',
  };
  return messages[code] ?? '抖音分享暂时无法处理，已保留原消息。';
}
