import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { imageSources } from './napcat.js';
import type { Logger, StoredMessage } from './types.js';
import { fingerprint, logEvent } from './logging.js';

export interface ImageOptions { workspace: string; maxBytes: number; timeoutMs: number; logger?: Logger }
export type IncomingImage = { path: string } | { error: string };

class ImageError extends Error {}

function imageExtension(bytes: Buffer): string {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  throw new ImageError('图片格式不支持');
}

function failure(error: unknown): ImageError {
  return error instanceof ImageError ? error : new ImageError('图片读取失败');
}

function checkOptions(options: ImageOptions): void {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0
    || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new ImageError('图片配置无效');
  }
}

function decodeBase64(source: string, maxBytes: number): Buffer {
  const encoded = source.slice('base64://'.length);
  if (encoded.length > Math.ceil(maxBytes / 3) * 4) throw new ImageError('图片超过大小限制');
  if (!encoded || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new ImageError('图片编码无效');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) throw new ImageError('图片编码无效');
  if (bytes.length > maxBytes) throw new ImageError('图片超过大小限制');
  return bytes;
}

async function download(source: string, options: ImageOptions, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  let url: URL;
  try { url = new URL(source); } catch { throw new ImageError('图片来源不支持'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new ImageError('图片来源不支持');
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const requestSignal = AbortSignal.any([signal, timeout]);
  try {
    const response = await fetch(url, { signal: requestSignal });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new ImageError('图片下载失败');
    }
    const length = response.headers.get('content-length');
    if (length !== null && /^\d+$/.test(length) && Number(length) > options.maxBytes) {
      await response.body.cancel();
      throw new ImageError('图片超过大小限制');
    }
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > options.maxBytes) throw new ImageError('图片超过大小限制');
        chunks.push(Buffer.from(value));
      }
      requestSignal.throwIfAborted();
      return Buffer.concat(chunks, size);
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  } catch (error) {
    signal.throwIfAborted();
    if (timeout.aborted) throw new ImageError('图片下载超时');
    throw failure(error);
  }
}

function isWithin(workspace: string, path: string): boolean {
  const child = relative(workspace, path);
  return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

async function localImage(source: string, options: ImageOptions, signal: AbortSignal): Promise<Buffer> {
  const workspace = await realpath(options.workspace);
  const configuredWorkspace = resolve(options.workspace);
  const candidate = resolve(configuredWorkspace, source);
  if (!isWithin(configuredWorkspace, candidate) && !isWithin(workspace, candidate)) throw new ImageError('图片路径不允许');
  const path = await realpath(candidate);
  if (!isWithin(workspace, path)) throw new ImageError('图片路径不允许');
  signal.throwIfAborted();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new ImageError('图片必须为普通文件');
    if (stat.size > options.maxBytes) throw new ImageError('图片超过大小限制');
    const chunks: Buffer[] = [];
    let size = 0;
    while (true) {
      signal.throwIfAborted();
      const chunk = Buffer.alloc(Math.min(64 * 1024, options.maxBytes - size + 1));
      const { bytesRead } = await handle.read(chunk);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > options.maxBytes) throw new ImageError('图片超过大小限制');
      chunks.push(chunk.subarray(0, bytesRead));
    }
    signal.throwIfAborted();
    return Buffer.concat(chunks, size);
  } finally { await handle.close(); }
}

async function cacheImage(bytes: Buffer, options: ImageOptions, signal: AbortSignal): Promise<string> {
  const extension = imageExtension(bytes);
  const directory = resolve(options.workspace, '.qq-images');
  await mkdir(directory, { recursive: true });
  if ((await lstat(directory)).isSymbolicLink()) throw new ImageError('图片缓存路径不允许');
  const path = join(directory, `${createHash('sha256').update(bytes).digest('hex')}.${extension}`);
  const temporary = join(directory, `${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600, signal });
    signal.throwIfAborted();
    await rename(temporary, path);
    return path;
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}

/** Fetch portable ordinary images and leave readable files for the running CLI. */
export async function prepareIncomingImages(
  messages: StoredMessage[], options: ImageOptions, signal: AbortSignal,
): Promise<{ files: string[]; byMessageId: Map<string, IncomingImage[]> }> {
  checkOptions(options);
  signal.throwIfAborted();
  const byMessageId = new Map<string, IncomingImage[]>();
  const files = new Set<string>();
  for (const message of messages) {
    const images: IncomingImage[] = [];
    for (const source of imageSources(message.rawJson)) {
      signal.throwIfAborted();
      const started = Date.now();
      const metadata = { message_ref: fingerprint(message.messageId), image_index: images.length,
        direction: 'inbound', source_type: source.startsWith('base64://') ? 'base64' : 'http' };
      if (options.logger) logEvent(options.logger, 'info', 'image.prepare_started', metadata);
      try {
        const bytes = source.startsWith('base64://') ? decodeBase64(source, options.maxBytes)
          : await download(source, options, signal);
        const path = await cacheImage(bytes, options, signal);
        signal.throwIfAborted();
        files.add(path);
        images.push({ path });
        if (options.logger) logEvent(options.logger, 'info', 'image.prepared', {
          ...metadata, bytes: bytes.length, duration_ms: Date.now() - started,
        });
      } catch (error) {
        if (options.logger) logEvent(options.logger, signal.aborted ? 'info' : 'warn',
          signal.aborted ? 'image.cancelled' : 'image.failed', {
            ...metadata, duration_ms: Date.now() - started,
            reason: signal.aborted ? 'cancelled' : failure(error).message,
          });
        signal.throwIfAborted();
        images.push({ error: failure(error).message });
      }
    }
    if (images.length) byMessageId.set(message.messageId, images);
  }
  return { files: [...files], byMessageId };
}

/** Snapshot a generated or remote image so a persisted reply never depends on a mutable file. */
export async function prepareImageReply(
  source: string, options: ImageOptions, signal: AbortSignal,
): Promise<{ type: 'image'; file: string }> {
  checkOptions(options);
  signal.throwIfAborted();
  const started = Date.now();
  const metadata = { direction: 'outbound', source_type: /^https?:\/\//i.test(source) ? 'http' : 'local' };
  if (options.logger) logEvent(options.logger, 'info', 'image.prepare_started', metadata);
  try {
    let bytes: Buffer;
    if (/^https?:\/\//i.test(source)) bytes = await download(source, options, signal);
    else {
      if (!source || /^[a-z][a-z\d+.-]*:/i.test(source)) throw new ImageError('图片来源不支持');
      bytes = await localImage(source, options, signal);
    }
    signal.throwIfAborted();
    imageExtension(bytes);
    if (options.logger) logEvent(options.logger, 'info', 'image.prepared', {
      ...metadata, bytes: bytes.length, duration_ms: Date.now() - started,
    });
    return { type: 'image', file: `base64://${bytes.toString('base64')}` };
  } catch (error) {
    if (options.logger) logEvent(options.logger, signal.aborted ? 'info' : 'warn',
      signal.aborted ? 'image.cancelled' : 'image.failed', {
        ...metadata, duration_ms: Date.now() - started,
        reason: signal.aborted ? 'cancelled' : failure(error).message,
      });
    signal.throwIfAborted();
    throw failure(error);
  }
}
