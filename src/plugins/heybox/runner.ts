import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createNetworkClient } from '../../network.js';
import { imageExtension } from '../../images.js';
import type { PluginContent, PluginContentImage, PluginExecution, PluginRunnerDefinition, PluginRunnerJob } from '../../plugin-system/contracts.js';
import { boundedBytes, fetchGameDetail, fetchPostDetail, HeyboxError, heyboxImageUrl } from './api.js';
import { contentText, parseGameDetail, validateHeyboxContent } from './content.js';
import { normalizeHeyboxLink } from './recognize.js';
import { validateHeyboxConfig } from './config.js';
import { parsePostDetail } from './post-content.js';
import { preparePost } from './post-presentation.js';

export type HeyboxRun = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal; timeoutMs: number }) => Promise<string>;
export interface HeyboxTools { fetch?: typeof fetch; run?: HeyboxRun; }
let rendering = false;
async function renderLimited<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  while (rendering) await delay(25, undefined, { signal }); signal.throwIfAborted(); rendering = true;
  try { return await operation(); } finally { rendering = false; }
}
const run: HeyboxRun = async (command, args, options) => new Promise((resolve, reject) => {
  options.signal.throwIfAborted();
  const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  let done = false, size = 0; const chunks: Buffer[] = [];
  const kill = () => { if (child.pid) try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL'); } catch {} };
  const timeout = setTimeout(kill, options.timeoutMs), abort = () => kill(); options.signal.addEventListener('abort', abort, { once: true });
  const finish = (error?: Error) => { if (done) return; done = true; clearTimeout(timeout); options.signal.removeEventListener('abort', abort); if (error) reject(error); else resolve(Buffer.concat(chunks).toString('utf8')); };
  child.stdout.on('data', (data: Buffer) => { size += data.length; if (size > 64 * 1024) kill(); else chunks.push(data); });
  child.stderr.resume(); child.once('error', () => finish(new HeyboxError('HEYBOX_RENDER_FAILED')));
  child.once('close', code => finish(options.signal.aborted ? new HeyboxError('PLUGIN_CANCELLED') : code === 0 && size <= 64 * 1024 ? undefined : new HeyboxError('HEYBOX_RENDER_FAILED')));
});

async function scriptPath(): Promise<string> {
  const deployed = fileURLToPath(new URL('./render/card.py', import.meta.url));
  try { await stat(deployed); return deployed; } catch { return fileURLToPath(new URL('../../../../src/plugins/heybox/render/card.py', import.meta.url)); }
}

export async function executeHeyboxJob(input: PluginRunnerJob, root: string, signal: AbortSignal, tools: HeyboxTools = {}): Promise<PluginExecution> {
  const source = normalizeHeyboxLink(input.resource.url);
  if (!source || input.resource.kind !== source.kind) throw new HeyboxError('HEYBOX_INVALID_URL');
  const config = validateHeyboxConfig(input.config), requestSignal = AbortSignal.any([signal, AbortSignal.timeout(config.timeoutSeconds * 1000)]);
  requestSignal.throwIfAborted();
  await mkdir(root, { recursive: true, mode: 0o700 }); const directory = await mkdtemp(join(root, 'job-heybox-'));
  const network = tools.fetch ? undefined : createNetworkClient(input.networkProxy), fetcher = tools.fetch ?? network!.fetch;
  const execute = tools.run ?? run;
  const env: NodeJS.ProcessEnv = { HOME: directory, TMPDIR: directory };
  for (const key of ['PATH', 'LANG', 'LC_ALL']) if (process.env[key] !== undefined) env[key] = process.env[key];
  let handedOff = false;
  const cleanup = async () => { await network?.close(); await rm(directory, { recursive: true, force: true }); };
  try {
    if (input.operation === 'resolve') {
      const content = source.kind === 'post' ? parsePostDetail(await fetchPostDetail(source, fetcher, requestSignal, config.cookie), source)
        : parseGameDetail(await fetchGameDetail(source, fetcher, requestSignal, config.cookie), source);
      handedOff = true; return { content, cleanup };
    }
    if (input.operation === 'prepare' && source.kind === 'post') {
      const prepared = await preparePost(input, source, config, directory, fetcher, execute, env, requestSignal);
      handedOff = true; return { ...prepared, cleanup };
    }
    if (source.kind !== 'game') throw new HeyboxError('HEYBOX_OPERATION_INVALID');
    if (input.operation !== 'prepare' || !input.content || input.presentation?.mode !== 'card') throw new HeyboxError('HEYBOX_OPERATION_INVALID');
    const content = validateHeyboxContent(structuredClone(input.content), source);
    const files: NonNullable<PluginExecution['files']> = []; let cover: string | undefined;
    const script = await scriptPath(), limit = Math.min(config.maxMiB * 1024 * 1024, input.imageMaxBytes ?? Infinity);
    const url = heyboxImageUrl(content.coverUrl);
    if (url) {
      try {
        let target = url, response: Response | undefined;
        for (let hop = 0; hop < 4; hop++) {
          response = await fetcher(target, { signal: requestSignal, redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://www.xiaoheihe.cn/' } });
          if (response.status < 300 || response.status >= 400) break;
          const location = response.headers.get('location'); await response.body?.cancel();
          const next = location && heyboxImageUrl(new URL(location, target).toString()); if (!next) throw new HeyboxError('HEYBOX_IMAGE_URL_REJECTED'); target = next;
          if (hop === 3) throw new HeyboxError('HEYBOX_REDIRECT_LIMIT');
        }
        const bytes = await boundedBytes(response!, Math.min(limit, 10 * 1024 * 1024));
        const extension = imageExtension(bytes); cover = join(directory, `cover.${extension}`); await writeFile(cover, bytes, { mode: 0o600 });
        const inspected = JSON.parse(await execute('python3', [script, 'inspect', cover], { cwd: directory, env, signal: requestSignal, timeoutMs: 10000 })) as { width: number; height: number };
        if (!Number.isSafeInteger(inspected.width) || !Number.isSafeInteger(inspected.height) || inspected.width <= 0 || inspected.height <= 0 || inspected.width * inspected.height > 24_000_000) throw new HeyboxError('HEYBOX_IMAGE_LIMIT');
        const image: PluginContentImage = { id: `${content.resourceId}:cover`, url, role: 'cover', assetKey: 'cover', status: 'ready', width: inspected.width, height: inspected.height, fetchedAt: Date.now() / 1000 };
        content.blocks = [{ type: 'image', image }]; files.push({ key: 'cover', path: cover, type: 'image', role: 'cover' });
      } catch { requestSignal.throwIfAborted(); cover = undefined; content.retrieval = { status: 'partial', error: 'HEYBOX_COVER_UNAVAILABLE' }; }
    }
    try {
      const request = join(directory, 'render.json');
      await writeFile(request, JSON.stringify({ content, ...(cover ? { cover: 'cover' + '.' + imageExtension(await readFile(cover)) } : {}), showPrices: config.showPrices }), { mode: 0o600 });
      const output = JSON.parse(await renderLimited(() => execute('python3', [script, 'render', request], { cwd: directory, env, signal: requestSignal, timeoutMs: Math.min(config.timeoutSeconds * 1000, 30000) }), requestSignal)) as { file: string };
      if (output.file !== 'card.png') throw new HeyboxError('HEYBOX_RENDER_INVALID');
      const path = join(directory, 'card.png'), info = await stat(path); if (!info.isFile() || info.size > limit || info.size < 16) throw new HeyboxError('HEYBOX_IMAGE_LIMIT');
      if (imageExtension(await readFile(path)) !== 'png') throw new HeyboxError('HEYBOX_RENDER_INVALID');
      files.push({ key: 'card', path, type: 'image', role: 'presentation' });
      handedOff = true; return { content, files, outputs: [{ kind: 'image', assetKey: 'card', assetRole: 'presentation' }], cleanup };
    } catch { requestSignal.throwIfAborted(); content.retrieval = { status: 'partial', error: 'HEYBOX_PRESENTATION_FALLBACK' };
      handedOff = true; return { content, files, outputs: [{ kind: 'reply', text: contentText(content) }], cleanup }; }
  } catch (error) {
    signal.throwIfAborted(); if (requestSignal.aborted) throw new HeyboxError('HEYBOX_TIMEOUT', true);
    throw error instanceof HeyboxError ? error : new HeyboxError('HEYBOX_OPERATION_FAILED');
  } finally { if (!handedOff) await cleanup(); }
}
export const runnerDefinition: PluginRunnerDefinition = { execute: executeHeyboxJob };
