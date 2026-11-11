import type { PluginContent, PluginContentBlock, PluginContentImage } from '../../plugin-system/contracts.js';
import { HeyboxError, heyboxImageUrl, identifier, object, text } from './api.js';
import { normalizeHeyboxPost } from './recognize.js';
import type { HeyboxPostResource } from './types.js';

export const POST_LIMITS = { images: 12, blocks: 128, text: 24000, pages: 4, totalBytes: 32 * 1024 * 1024, pixels: 24_000_000 } as const;
const timestamp = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 8.64e12 ? value : undefined;
export function postImageUrl(value: unknown): string | undefined {
  const safe = heyboxImageUrl(value); if (!safe) return;
  const url = new URL(safe);
  if (!/(?:^|\.)max-c\.com$/u.test(url.hostname)) return;
  url.search = ''; url.hash = ''; return url.toString();
}

export function parsePostDetail(input: unknown, source: HeyboxPostResource, observedAt = Date.now() / 1000): PluginContent {
  const post = object(input), id = identifier(post.linkid);
  if (!/^\d{1,24}$/u.test(id) || /^\d+$/u.test(source.postId) && source.postId !== id || !text(post.title)) throw new HeyboxError('HEYBOX_POST_MISMATCH');
  let raw: unknown;
  try { if (typeof post.text !== 'string' || post.text.length > 512 * 1024) throw new Error(); raw = JSON.parse(post.text); }
  catch { throw new HeyboxError('HEYBOX_POST_FORMAT_UNSUPPORTED'); }
  if (!Array.isArray(raw)) throw new HeyboxError('HEYBOX_POST_FORMAT_UNSUPPORTED');
  const resourceId = `post:${id}`, blocks: PluginContentBlock[] = [];
  let imageCount = 0, textLength = 0, partial = !!post.has_video;
  for (const value of raw.slice(0, POST_LIMITS.blocks)) {
    const block = object(value);
    if (block.type === 'text' && typeof block.text === 'string') {
      const full = block.text.replace(/\\n/gu, '\n').replace(/\[cube_鳄鱼\]/gu, '🐊');
      const body = full.slice(0, Math.max(0, POST_LIMITS.text - textLength)).trim();
      if (body) blocks.push({ type: 'paragraph', text: body });
      textLength += full.length; if (textLength > POST_LIMITS.text) partial = true;
    } else if (block.type === 'img') {
      imageCount++;
      if (imageCount > POST_LIMITS.images) { partial = true; continue; }
      const url = postImageUrl(block.url);
      if (url) blocks.push({ type: 'image', image: { id: `${resourceId}:image:${imageCount}`, url, role: 'content', status: 'pending' } });
      else { partial = true; blocks.push({ type: 'paragraph', text: `第 ${imageCount} 张配图未能取得，请查看原帖。` }); }
    } else partial = true;
  }
  if (raw.length > POST_LIMITS.blocks || imageCount > POST_LIMITS.images || textLength > POST_LIMITS.text) {
    partial = true; blocks.push({ type: 'paragraph', text: '部分内容超过处理上限，剩余内容请查看原帖。' });
  }
  const user = object(post.user), avatar = postImageUrl(user.avatar ?? user.avartar), publishedAt = timestamp(post.create_at), editedAt = timestamp(post.modify_at ?? post.update_at);
  return { type: 'post', platform: 'heybox', resourceId, url: `https://www.xiaoheihe.cn/app/bbs/link/${id}`, title: text(post.title, 500),
    ...(text(user.username, 500) ? { author: text(user.username, 500) } : {}), ...(identifier(user.userid) ? { authorId: identifier(user.userid) } : {}),
    ...(avatar ? { authorAvatar: { id: `${resourceId}:avatar`, url: avatar, role: 'avatar', status: 'pending' } } : {}),
    ...(publishedAt ? { publishedAt } : {}), ...(editedAt ? { editedAt } : {}), observedAt, blocks,
    retrieval: partial ? { status: 'partial', error: 'HEYBOX_POST_CONTENT_PARTIAL' } : { status: 'ready' } };
}

function validatedImage(input: unknown, resourceId: string, role: 'content' | 'avatar'): PluginContentImage {
  const v = object(input), url = postImageUrl(v.url);
  if (!url || v.role !== role || typeof v.id !== 'string' || (role === 'avatar' ? v.id !== `${resourceId}:avatar`
    : !new RegExp('^' + resourceId + ':image:(?:[1-9]|1[0-2])$').test(v.id))) throw new Error('帖子图片资料无效');
  const result: PluginContentImage = { id: v.id, url, role };
  if (['pending', 'ready', 'failed'].includes(v.status)) result.status = v.status;
  for (const key of ['assetKey', 'assetId'] as const) if (typeof v[key] === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/u.test(v[key])) result[key] = v[key];
  for (const key of ['width', 'height'] as const) if (Number.isSafeInteger(v[key]) && v[key] > 0 && v[key] <= 100000) result[key] = v[key];
  if (timestamp(v.fetchedAt)) result.fetchedAt = v.fetchedAt;
  if (typeof v.error === 'string' && /^HEYBOX_[A-Z_]{1,80}$/u.test(v.error)) result.error = v.error;
  return result;
}

export function validatePostContent(input: unknown, source: HeyboxPostResource): PluginContent {
  const v = object(input), canonical = normalizeHeyboxPost(text(v.url, 4096));
  if (v.type !== 'post' || v.platform !== 'heybox' || !canonical || !/^\d{1,24}$/u.test(canonical.postId) || v.resourceId !== canonical.id
    || /^\d+$/u.test(source.postId) && source.postId !== canonical.postId || typeof v.title !== 'string'
    || !Array.isArray(v.blocks) || v.blocks.length > POST_LIMITS.blocks + 1) throw new Error('帖子资料无效');
  const content: PluginContent = { type: 'post', platform: 'heybox', resourceId: canonical.id, url: canonical.url,
    title: v.title.slice(0, 500), blocks: [], retrieval: { status: 'ready' } };
  for (const key of ['author', 'authorId'] as const) if (typeof v[key] === 'string') content[key] = v[key].slice(0, 500);
  for (const key of ['publishedAt', 'editedAt', 'observedAt'] as const) if (timestamp(v[key])) content[key] = v[key];
  if (v.authorAvatar) content.authorAvatar = validatedImage(v.authorAvatar, canonical.id, 'avatar');
  let characters = 0; const images = new Set<string>();
  for (const value of v.blocks) {
    const b = object(value);
    if (b.type === 'paragraph' && typeof b.text === 'string') {
      characters += b.text.length; if (characters > POST_LIMITS.text + 1024) throw new Error('帖子正文超过上限');
      content.blocks!.push({ type: 'paragraph', text: b.text });
    } else if (b.type === 'image') {
      const image = validatedImage(b.image, canonical.id, 'content');
      if (images.has(image.id) || images.size >= POST_LIMITS.images) throw new Error('帖子图片数量无效');
      images.add(image.id); content.blocks!.push({ type: 'image', image });
    } else throw new Error('帖子内容格式无效');
  }
  const retrieval = object(v.retrieval);
  if (['partial', 'failed'].includes(retrieval.status)) content.retrieval = { status: retrieval.status,
    ...(typeof retrieval.error === 'string' && /^HEYBOX_[A-Z_]{1,80}$/u.test(retrieval.error) ? { error: retrieval.error } : {}) };
  return content;
}

export function postContentText(content: PluginContent): string {
  const paragraphs = (content.blocks ?? []).flatMap(b => b.type === 'paragraph' ? [b.text] : []), images = (content.blocks ?? []).filter(b => b.type === 'image');
  return [content.title, content.author ? `作者：${content.author}` : '', content.publishedAt ? `发布：${new Date(content.publishedAt * 1000).toISOString()}` : '',
    ...paragraphs, images.length ? `原帖配图 ${images.length} 张；图片内容以实际取得的附件为准。` : '',
    content.retrieval.status !== 'ready' ? '部分资料或图片未能取得，完整内容请查看原帖。' : '', content.url].filter(Boolean).join('\n').slice(0, 32000);
}
