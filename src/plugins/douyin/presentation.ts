import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { imageExtension } from '../../images.js';
import { renderLimited } from '../../plugin-render.js';
import { PluginExecutionError, type PluginContent, type PluginContentImage, type PluginExecution, type PluginRunnerJob } from '../../plugin-system/contracts.js';
import { boundedBytes, mediaResponse, type DouyinInfo } from './api.js';
import type { DouyinConfig } from './config.js';
import { contentText, publicImageUrl, validateDouyinContent } from './content.js';
import type { DouyinResource } from './recognize.js';

export const DOUYIN_IMAGE_LIMITS = { perImageBytes: 8 * 1024 * 1024, totalBytes: 16 * 1024 * 1024, maxPixels: 24_000_000 } as const;
type DouyinRun = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal; timeoutMs: number }) => Promise<string>;

async function rendererPath(): Promise<string> {
  const deployed = fileURLToPath(new URL('./render/card.py', import.meta.url));
  try { await stat(deployed); return deployed; }
  catch { return fileURLToPath(new URL('../../../../src/plugins/douyin/render/card.py', import.meta.url)); }
}

export async function prepareDouyinCard(
  job: PluginRunnerJob & { config: DouyinConfig; resource: DouyinResource }, directory: string,
  info: DouyinInfo | undefined, fetcher: typeof globalThis.fetch, execute: DouyinRun, env: NodeJS.ProcessEnv, signal: AbortSignal,
): Promise<Omit<PluginExecution, 'cleanup'>> {
  if (!job.content || job.presentation?.mode !== 'card') throw new PluginExecutionError('DOUYIN_PRESENTATION_INVALID');
  const content = validateDouyinContent(structuredClone(job.content), job.resource);
  const files: NonNullable<PluginExecution['files']> = [], paths: Record<string, string> = {};
  const sameWork = info?.content.resourceId === content.resourceId ? info : undefined;
  if (!content.authorAvatar && sameWork?.content.authorAvatar) content.authorAvatar = structuredClone(sameWork.content.authorAvatar);
  const cover = content.blocks?.find(block => block.type === 'image' && block.image.role === 'cover');
  const targets: Array<{ image: PluginContentImage; urls: string[] }> = [
    ...(cover?.type === 'image' ? [{ image: cover.image, urls: sameWork?.covers ?? [] }] : []),
    ...(content.authorAvatar ? [{ image: content.authorAvatar, urls: sameWork?.avatars ?? [] }] : []),
  ];
  const script = await rendererPath();
  const maxBytes = Math.min(DOUYIN_IMAGE_LIMITS.perImageBytes, job.config.maxMiB * 1024 * 1024, job.imageMaxBytes ?? Infinity);
  let total = 0, failed = false;
  for (const { image, urls } of targets) {
    signal.throwIfAborted();
    delete image.assetId; delete image.assetKey;
    try {
      const url = urls.find(value => publicImageUrl(value) === image.url) ?? urls[0] ?? image.url;
      const publicUrl = publicImageUrl(url);
      if (!publicUrl) throw new PluginExecutionError('DOUYIN_IMAGE_URL_REJECTED');
      const bytes = await boundedBytes(await mediaResponse(url, fetcher, signal, true), maxBytes);
      total += bytes.length;
      if (total > DOUYIN_IMAGE_LIMITS.totalBytes) throw new PluginExecutionError('DOUYIN_IMAGE_LIMIT');
      const key = image.role, path = join(directory, `${key}.${imageExtension(bytes)}`);
      await writeFile(path, bytes, { mode: 0o600 });
      const inspected = JSON.parse(await execute('python3', [script, 'inspect', path, String(DOUYIN_IMAGE_LIMITS.maxPixels)],
        { cwd: directory, env, signal, timeoutMs: 15000 })) as { width?: number; height?: number };
      const width = inspected.width, height = inspected.height;
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width! <= 0 || height! <= 0 || width! * height! > DOUYIN_IMAGE_LIMITS.maxPixels) {
        throw new PluginExecutionError('DOUYIN_IMAGE_LIMIT');
      }
      Object.assign(image, { url: publicUrl, assetKey: key, status: 'ready', width, height, fetchedAt: Date.now() / 1000 });
      delete image.error;
      paths[key] = path; files.push({ key, path, type: 'image', role: image.role });
    } catch (error) {
      signal.throwIfAborted(); failed = true;
      image.status = 'failed'; image.error = error instanceof PluginExecutionError ? error.code : 'DOUYIN_IMAGE_FAILED';
    }
  }
  if (failed) content.retrieval = { status: 'partial', error: 'DOUYIN_IMAGES_PARTIAL' };
  try {
    const request = join(directory, 'render.json');
    await writeFile(request, JSON.stringify({ content, paths, maxPages: 1 }), { mode: 0o600 });
    const raw = await renderLimited(() => execute('python3', [script, 'render', request],
      { cwd: directory, env, signal, timeoutMs: Math.min(job.config.timeoutSeconds * 1000, 30000) }), signal);
    const result = JSON.parse(raw) as { files?: unknown };
    if (!Array.isArray(result.files) || result.files.length !== 1 || result.files[0] !== 'card-0.png') throw new PluginExecutionError('DOUYIN_RENDER_INVALID');
    const path = join(directory, 'card-0.png'), file = await stat(path);
    if (!file.isFile() || file.size < 16 || file.size > maxBytes) throw new PluginExecutionError('DOUYIN_RENDER_LIMIT');
    if (imageExtension(await readFile(path)) !== 'png') throw new PluginExecutionError('DOUYIN_RENDER_INVALID');
    files.push({ key: 'card-0', path, type: 'image', role: 'presentation' });
    return { content, files, outputs: [{ kind: 'image', assetKey: 'card-0', assetRole: 'presentation' }] };
  } catch {
    signal.throwIfAborted();
    content.retrieval = { status: 'partial', error: 'DOUYIN_PRESENTATION_FALLBACK' };
    const description = content.description ? Array.from(content.description).slice(0, 600).join('') : undefined;
    const bounded: PluginContent = { ...content, ...(description ? { description } : {}) };
    return { content, files, outputs: [{ kind: 'reply', text: contentText(bounded) }] };
  }
}
