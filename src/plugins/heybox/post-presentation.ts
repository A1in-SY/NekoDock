import { readFile, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { imageExtension } from '../../images.js';
import { renderLimited } from '../../plugin-render.js';
import type { PluginContentImage, PluginExecution, PluginOutput, PluginRunnerJob } from '../../plugin-system/contracts.js';
import { boundedBytes, HeyboxError } from './api.js';
import { POST_LIMITS, postContentText, postImageUrl, validatePostContent } from './post-content.js';
import type { HeyboxConfig, HeyboxPostResource } from './types.js';
import type { HeyboxRun } from './runner.js';

async function scriptPath(): Promise<string> {
  const deployed = fileURLToPath(new URL('./render/post.py', import.meta.url));
  try { await stat(deployed); return deployed; } catch { return fileURLToPath(new URL('../../../../src/plugins/heybox/render/post.py', import.meta.url)); }
}

export async function preparePost(input: PluginRunnerJob, source: HeyboxPostResource, config: HeyboxConfig, directory: string,
  fetcher: typeof fetch, execute: HeyboxRun, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<Omit<PluginExecution, 'cleanup'>> {
  if (!input.content || !['none', 'card'].includes(input.presentation?.mode ?? '')) throw new HeyboxError('HEYBOX_OPERATION_INVALID');
  const content = validatePostContent(structuredClone(input.content), source), files: NonNullable<PluginExecution['files']> = [], paths: Record<string, string> = {};
  const images = (content.blocks ?? []).flatMap(block => block.type === 'image' ? [block.image] : []);
  const targets = [...images, ...(input.presentation?.mode === 'card' && content.authorAvatar ? [content.authorAvatar] : [])];
  const script = await scriptPath(), limit = Math.min(config.maxMiB * 1024 * 1024, input.imageMaxBytes ?? Infinity, 10 * 1024 * 1024);
  let total = 0;
  const cache = new Map<string, PluginContentImage>();
  for (const image of targets) {
    signal.throwIfAborted(); delete image.assetId; delete image.assetKey;
    try {
      const initial = postImageUrl(image.url); if (!initial) throw new HeyboxError('HEYBOX_IMAGE_URL_REJECTED');
      let target: string = initial;
      const previous = cache.get(`${image.role}\n${target}`);
      if (previous) { Object.assign(image, { assetKey: previous.assetKey, status: 'ready', width: previous.width, height: previous.height, fetchedAt: previous.fetchedAt }); continue; }
      let response: Response | undefined;
      for (let hop = 0; hop < 4; hop++) {
        response = await fetcher(target, { signal, redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://www.xiaoheihe.cn/' } });
        if (response.status < 300 || response.status >= 400) break;
        const location = response.headers.get('location'); await response.body?.cancel();
        const next = location && postImageUrl(new URL(location, target).toString()); if (!next) throw new HeyboxError('HEYBOX_IMAGE_URL_REJECTED');
        target = next; if (hop === 3) throw new HeyboxError('HEYBOX_REDIRECT_LIMIT');
      }
      const bytes = await boundedBytes(response!, Math.min(limit, Math.max(0, POST_LIMITS.totalBytes - total))); total += bytes.length;
      const key = `source-${files.length}`, path = join(directory, `${key}.${imageExtension(bytes)}`);
      await writeFile(path, bytes, { mode: 0o600 });
      const info = JSON.parse(await execute('python3', [script, 'inspect', path, String(POST_LIMITS.pixels)], { cwd: directory, env, signal, timeoutMs: 10000 })) as { width: number; height: number };
      if (!Number.isSafeInteger(info.width) || !Number.isSafeInteger(info.height) || info.width <= 0 || info.height <= 0 || info.width * info.height > POST_LIMITS.pixels) throw new HeyboxError('HEYBOX_IMAGE_LIMIT');
      Object.assign(image, { assetKey: key, status: 'ready', width: info.width, height: info.height, fetchedAt: Date.now() / 1000 });
      delete image.error; cache.set(`${image.role}\n${image.url}`, image); paths[key] = path; files.push({ key, path, type: 'image', role: image.role });
    } catch {
      signal.throwIfAborted(); image.status = 'failed'; image.error = 'HEYBOX_IMAGE_UNAVAILABLE';
      if (image.role === 'content') content.retrieval = { status: 'partial', error: 'HEYBOX_POST_IMAGES_PARTIAL' };
    }
  }
  if (input.presentation?.mode === 'none') return { content, files, outputs: [] };
  const fallback = (): PluginOutput[] => [{ kind: 'reply', text: postContentText(content) },
    ...images.filter(image => image.status === 'ready').map(image => ({ kind: 'image' as const, assetKey: image.assetKey, assetRole: image.role }))];
  try {
    const request = join(directory, 'render.json'); await writeFile(request, JSON.stringify({ content, paths, maxPages: POST_LIMITS.pages }), { mode: 0o600 });
    const result = JSON.parse(await renderLimited(() => execute('python3', [script, 'render', request], { cwd: directory, env, signal, timeoutMs: 30000 }), signal)) as { files: string[]; truncated?: boolean };
    if (!Array.isArray(result.files) || !result.files.length || result.files.length > POST_LIMITS.pages || new Set(result.files).size !== result.files.length) throw new HeyboxError('HEYBOX_RENDER_INVALID');
    const cards: NonNullable<PluginExecution['files']> = [];
    for (const [index, name] of result.files.entries()) {
      if (name !== `card-${index}.png`) throw new HeyboxError('HEYBOX_RENDER_INVALID');
      const path = join(directory, name), info = await stat(path);
      if (!info.isFile() || info.size > limit || info.size < 16 || imageExtension(await readFile(path)) !== 'png') throw new HeyboxError('HEYBOX_IMAGE_LIMIT');
      cards.push({ key: `card-${index}`, path, type: 'image', role: 'presentation' });
    }
    if (result.truncated) content.retrieval = { status: 'partial', error: 'HEYBOX_POST_PAGE_LIMIT' };
    return { content, files: [...files, ...cards], outputs: cards.map(card => ({ kind: 'image', assetKey: card.key, assetRole: 'presentation' })) };
  } catch {
    signal.throwIfAborted(); content.retrieval = { status: 'partial', error: 'HEYBOX_PRESENTATION_FALLBACK' };
    return { content, files, outputs: fallback() };
  }
}
