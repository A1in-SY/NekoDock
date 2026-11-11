import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createNetworkClient, proxyEnvironment } from '../../network.js';
import { imageExtension } from '../../images.js';
import { PluginExecutionError, type PluginExecution, type PluginRunnerDefinition, type PluginRunnerJob } from '../../plugin-system/contracts.js';
import { DouyinClient, boundedBytes, createDouyinState, mediaResponse, videoCandidates, type DouyinState } from './api.js';
import { validateDouyinConfig } from './config.js';
import { douyinError, object, validateDouyinContent } from './content.js';
import { normalizeDouyinResource } from './recognize.js';
import { prepareDouyinCard } from './presentation.js';

export { createDouyinState } from './api.js';
export interface DouyinTools {
  fetch?: typeof globalThis.fetch;
  run?: (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal; timeoutMs: number }) => Promise<string>;
  state?: DouyinState;
}
const fail = (code: string): never => { throw new PluginExecutionError(code); };
const silent = { info() {}, warn() {}, error() {} };
function environment(job: PluginRunnerJob, directory: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { HOME: directory, TMPDIR: directory };
  for (const key of ['PATH','LANG','LC_ALL','SSL_CERT_FILE','SSL_CERT_DIR','NODE_EXTRA_CA_CERTS']) if (process.env[key] !== undefined) env[key] = process.env[key];
  return proxyEnvironment(job.networkProxy,env);
}
async function run(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal; timeoutMs: number }): Promise<string> {
  options.signal.throwIfAborted();
  return new Promise((resolve,reject) => {
    const child = spawn(command,args,{ cwd: options.cwd, env: options.env, stdio: ['ignore','pipe','ignore'], detached: process.platform !== 'win32' });
    let size = 0, timedOut = false; const chunks: Buffer[] = [];
    const kill = () => { if (child.pid) try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid,'SIGKILL'); } catch {} };
    const timer = setTimeout(() => { timedOut = true; kill(); },options.timeoutMs);
    const abort = () => kill(); options.signal.addEventListener('abort',abort,{ once: true });
    const close = () => { clearTimeout(timer); options.signal.removeEventListener('abort',abort); };
    child.stdout.on('data',(bytes: Buffer) => { size += bytes.length; if (size > 1024 * 1024) kill(); else chunks.push(bytes); });
    child.once('error',() => { close(); reject(new PluginExecutionError('DOUYIN_MEDIA_INSPECTION_FAILED')); });
    child.once('close',code => {
      close();
      if (options.signal.aborted) reject(options.signal.reason);
      else if (timedOut) reject(new PluginExecutionError('DOUYIN_TIMEOUT',true));
      else if (code !== 0 || size > 1024 * 1024) reject(new PluginExecutionError('DOUYIN_MEDIA_INSPECTION_FAILED'));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}
async function download(response: Response, path: string, maxBytes: number, signal: AbortSignal): Promise<void> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) { await response.body?.cancel(); return fail('DOUYIN_MEDIA_TOO_LARGE'); }
  if (response.status !== 200 || response.headers.has('content-range') || !/^video\/(?:mp4|quicktime)(?:;|$)/iu.test(response.headers.get('content-type') ?? '')) {
    await response.body?.cancel(); return fail('DOUYIN_MEDIA_FORMAT_UNSUPPORTED');
  }
  const reader = response.body?.getReader(); if (!reader) return fail('DOUYIN_MEDIA_UNAVAILABLE');
  const file = await open(path,'w',0o600); let size = 0, prefix = Buffer.alloc(0);
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort',onAbort,{ once: true });
  try {
    while (true) {
      signal.throwIfAborted(); const next = await reader.read(); if (next.done) break;
      const bytes = Buffer.from(next.value); size += bytes.length;
      if (size > maxBytes) return fail('DOUYIN_MEDIA_TOO_LARGE');
      if (prefix.length < 16) prefix = Buffer.concat([prefix,bytes.subarray(0,16 - prefix.length)]);
      let position = 0;
      while (position < bytes.length) { const written = await file.write(bytes,position,bytes.length - position); if (!written.bytesWritten) return fail('DOUYIN_MEDIA_UNAVAILABLE'); position += written.bytesWritten; }
    }
    signal.throwIfAborted();
    if (size < 12 || prefix.toString('ascii',4,8) !== 'ftyp' || Number.isFinite(length) && length > 0 && length !== size) return fail('DOUYIN_MEDIA_FORMAT_UNSUPPORTED');
    await file.sync();
  } finally { signal.removeEventListener('abort',onAbort); await file.close(); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export async function executeDouyinJob(job: PluginRunnerJob, root: string, signal: AbortSignal, tools: DouyinTools = {}): Promise<PluginExecution> {
  const resource = normalizeDouyinResource(job.resource.url);
  if (!resource || resource.kind !== job.resource.kind || resource.id !== job.resource.id) return fail('DOUYIN_INVALID_URL');
  const config = validateDouyinConfig(job.config);
  if (!Number.isFinite(job.expiresAt) || job.expiresAt <= Date.now()) return fail('DOUYIN_TIMEOUT');
  if (!['resolve','download','prepare'].includes(job.operation)) return fail('DOUYIN_OPERATION_UNSUPPORTED');
  await mkdir(root,{ recursive: true, mode: 0o700 }); const directory = await mkdtemp(join(root,'job-'));
  const cleanup = () => rm(directory,{ recursive: true, force: true });
  const network = createNetworkClient(job.networkProxy,silent,'plugins'); const fetcher = tools.fetch ?? network.fetch, execute = tools.run ?? run;
  const timeout = Math.min(config.timeoutSeconds * 1000,Math.max(1,job.expiresAt - Date.now()));
  const combined = AbortSignal.any([signal,AbortSignal.timeout(timeout)]), env = environment(job,directory);
  // Shared visitor registration owns its pool so cancelling this job cannot close
  // a connection still used by another waiter for the same instance and route.
  const client = new DouyinClient(fetcher,job.botId,job.networkProxy,tools.state,
    tools.fetch ? () => ({ fetch: fetcher, close: async () => {} }) : () => createNetworkClient(job.networkProxy,silent,'plugins'));
  try {
    if (job.operation === 'prepare' && job.presentation?.mode === 'card') {
      let info;
      try { info = await client.info(resource,combined); }
      catch { combined.throwIfAborted(); }
      const prepared = await prepareDouyinCard({ ...job, resource, config },directory,info,fetcher,execute,env,combined);
      await network.close(); return { ...prepared, cleanup };
    }
    const info = await client.info(resource,combined);
    if (job.operation === 'resolve') { await network.close(); return { content: structuredClone(info.content), cleanup }; }
    if (job.operation === 'prepare') {
      if (!job.content || job.presentation?.mode !== 'none') return fail('DOUYIN_PRESENTATION_INVALID');
      const content = validateDouyinContent(structuredClone(job.content),resource), cover = content.blocks?.find(block => block.type === 'image' && block.image.role === 'cover');
      const files: NonNullable<PluginExecution['files']> = [];
      if (cover?.type === 'image') {
        try {
          const url = info.covers[0]; if (!url) return fail('DOUYIN_COVER_UNAVAILABLE');
          const bytes = await boundedBytes(await mediaResponse(url,fetcher,combined,true),Math.min(8 * 1024 * 1024,job.imageMaxBytes ?? Infinity));
          const extension = imageExtension(bytes), path = join(directory,`cover.${extension}`); await writeFile(path,bytes,{ mode: 0o600 });
          const probe = object(JSON.parse(await execute('ffprobe',['-v','error','-show_streams','-of','json',path],{ cwd: directory, env, signal: combined, timeoutMs: 15000 })));
          const stream = (Array.isArray(probe.streams) ? probe.streams : []).find((stream: any) => stream.codec_type === 'video');
          const width = Number(stream?.width), height = Number(stream?.height);
          if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width * height > 24_000_000) return fail('DOUYIN_IMAGE_LIMIT');
          Object.assign(cover.image,{ assetKey: 'cover', status: 'ready', width, height, fetchedAt: Date.now() / 1000 });
          files.push({ key: 'cover', path, type: 'image', role: 'cover' });
        } catch {
          combined.throwIfAborted(); cover.image.status = 'failed'; cover.image.error = 'DOUYIN_COVER_UNAVAILABLE';
          content.retrieval = { status: 'partial', error: 'DOUYIN_COVER_UNAVAILABLE' };
        }
      }
      await network.close(); return { content, files, cleanup };
    }
    if (!job.content || job.content.resourceId !== info.content.resourceId || job.content.durationSeconds === undefined || job.content.durationSeconds <= 0
      || job.content.durationSeconds > config.maxDurationSeconds || info.content.durationSeconds === undefined || info.content.durationSeconds <= 0 || info.content.durationSeconds > config.maxDurationSeconds) return fail('DOUYIN_DURATION_LIMIT');
    const path = join(directory,'video.mp4'), maxBytes = config.maxMiB * 1024 * 1024;
    const candidates = videoCandidates(info,config.maxResolution,maxBytes); let last: unknown = new PluginExecutionError('DOUYIN_MEDIA_FORMAT_UNSUPPORTED');
    for (const url of candidates) {
      combined.throwIfAborted();
      try {
        await download(await mediaResponse(url,fetcher,combined),path,maxBytes,combined);
        const file = await stat(path); if (!file.isFile() || file.size < 12 || file.size > maxBytes) return fail('DOUYIN_MEDIA_TOO_LARGE');
        const probe = object(JSON.parse(await execute('ffprobe',['-v','error','-show_format','-show_streams','-of','json',path],{ cwd: directory, env, signal: combined, timeoutMs: 15000 })));
        const duration = Number(object(probe.format).duration), streams = Array.isArray(probe.streams) ? probe.streams : [];
        const video = streams.find((stream: any) => stream.codec_type === 'video');
        if (!Number.isFinite(duration) || duration <= 0 || duration > config.maxDurationSeconds) return fail('DOUYIN_DURATION_LIMIT');
        const width = Number(video?.width), height = Number(video?.height);
        if (!video || video.codec_name !== 'h264' || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0
          || Math.min(width,height) > config.maxResolution || Math.max(width,height) > config.maxResolution * 4
          || streams.some((stream: any) => stream.codec_type === 'audio' && stream.codec_name !== 'aac')) return fail('DOUYIN_MEDIA_FORMAT_UNSUPPORTED');
        await network.close(); return { file: path, cleanup };
      } catch (error) {
        combined.throwIfAborted(); last = error; await rm(path,{ force: true });
        if (error instanceof PluginExecutionError && !['DOUYIN_MEDIA_FORMAT_UNSUPPORTED','DOUYIN_MEDIA_UNAVAILABLE','DOUYIN_NOT_FOUND','DOUYIN_MEDIA_INSPECTION_FAILED','DOUYIN_MEDIA_TOO_LARGE'].includes(error.code)) throw error;
      }
    }
    throw last;
  } catch (error) { await network.close(); await cleanup(); throw douyinError(error); }
}
export const runnerDefinition: PluginRunnerDefinition = { execute: executeDouyinJob };
