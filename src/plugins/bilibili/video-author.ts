import type { PluginContent } from '../../plugin-system/contracts.js';
import { apiJson, id, imageUrl, object, string } from './api.js';
import { contentImage } from './dynamic.js';
import type { BilibiliResource } from './types.js';

const AUTHOR_TIMEOUT_MS = 2000;

/** The author decoration is optional and cannot consume the full video-job timeout. */
export async function prepareVideoAuthor(content: PluginContent, resource: BilibiliResource,
  fetcher: typeof globalThis.fetch, signal: AbortSignal, cookie?: string): Promise<PluginContent> {
  signal.throwIfAborted();
  if (content.authorAvatar?.role === 'avatar' && imageUrl(content.authorAvatar.url)) return content;
  const videoId = resource.id.replace(/:p\d+$/u, '');
  const query = /^BV[0-9A-Za-z]{10}$/u.test(videoId) ? `bvid=${videoId}`
    : /^av\d+$/u.test(videoId) ? `aid=${videoId.slice(2)}` : undefined;
  if (!query) return content;
  try {
    const data = await apiJson(`https://api.bilibili.com/x/web-interface/view?${query}`, fetcher,
      AbortSignal.any([signal, AbortSignal.timeout(AUTHOR_TIMEOUT_MS)]), cookie);
    const owner = object(data.owner), authorId = id(owner.mid);
    if (!authorId || content.authorId && content.authorId !== authorId) return content;
    const author = string(owner.name, 500), avatar = contentImage(owner.face, `${content.resourceId}:avatar`, 'avatar');
    return { ...content, authorId, ...(author ? { author } : {}), ...(avatar ? { authorAvatar: avatar } : {}) };
  } catch {
    signal.throwIfAborted();
    return content;
  }
}
