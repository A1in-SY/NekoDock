import { createHash } from 'node:crypto';
import type { NetworkProxyConfig } from '../../network.js';
import { PluginExecutionError, type PluginContent } from '../../plugin-system/contracts.js';
import { imageUrl, object, publicImageUrl } from './content.js';
import { normalizeDouyinResource, type DouyinResource } from './recognize.js';

export const DOUYIN_MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) EdgiOS/121.0.2277.107 Version/17.0 Mobile/15E148 Safari/604.1';
const REGISTER_URL = 'https://ttwid.bytedance.com/ttwid/union/register/';
const MAX_HTML_BYTES = 4 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 64;
const VISITOR_TTL = 15 * 60_000;
const METADATA_TTL = 2 * 60_000;
const sourceHosts = new Set(['douyin.com','www.douyin.com','m.douyin.com','iesdouyin.com','www.iesdouyin.com','v.douyin.com','jx.douyin.com','jingxuan.douyin.com']);
interface Visitor { cookie: string; expiresAt: number; }
interface SessionEntry { visitor?: Visitor; pending?: Promise<Visitor>; controller?: AbortController; waiters: number; usedAt: number; }
export interface DouyinVisitorTransport { fetch: typeof fetch; close(): Promise<void>; }
export interface DouyinInfo { content: PluginContent; item: Record<string,any>; covers: string[]; avatars: string[]; }
export interface DouyinState {
  sessions: Map<string,SessionEntry>;
  metadata: Map<string,{ info: DouyinInfo; expiresAt: number }>;
}
export const createDouyinState = (): DouyinState => ({ sessions: new Map(), metadata: new Map() });
const sharedState = createDouyinState();
const fail = (code: string, retryable = false): never => { throw new PluginExecutionError(code,retryable); };

function officialUrl(value: string, callback = false): string {
  try {
    const url = new URL(value);
    const validHost = callback ? ['www.iesdouyin.com','iesdouyin.com'].includes(url.hostname) : sourceHosts.has(url.hostname);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !validHost
      || callback && !url.pathname.startsWith('/ttwid/union/register/callback/')) return fail('DOUYIN_REDIRECT_REJECTED');
    return url.toString();
  } catch (error) { if (error instanceof PluginExecutionError) throw error; return fail('DOUYIN_REDIRECT_REJECTED'); }
}
export function mediaUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 8192) return;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return;
    const api = ['aweme.snssdk.com','aweme-hl.snssdk.com'].includes(url.hostname) && /^\/aweme\/v1\/play(?:wm)?\/$/u.test(url.pathname);
    if (!api && !/(?:^|\.)(?:douyinvod\.com|douyinvod\.com\.cn|zjcdn\.com|bytecdn\.cn|bytecdn\.com|pstatp\.com)$/u.test(url.hostname)) return;
    return url.toString();
  } catch { return; }
}
function statusError(response: Response, media = false): PluginExecutionError {
  return new PluginExecutionError(response.status === 429 ? 'DOUYIN_RATE_LIMITED'
    : response.status === 404 || response.status === 410 ? 'DOUYIN_NOT_FOUND'
    : response.status === 401 || response.status === 403 ? media ? 'DOUYIN_MEDIA_UNAVAILABLE' : 'DOUYIN_VISITOR_REJECTED'
    : media ? 'DOUYIN_MEDIA_UNAVAILABLE' : 'DOUYIN_NETWORK_FAILED', response.status >= 500);
}
export async function boundedBytes(response: Response, max: number): Promise<Buffer> {
  if (!response.ok) { await response.body?.cancel(); throw statusError(response); }
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > max) { await response.body?.cancel(); return fail('DOUYIN_RESPONSE_TOO_LARGE'); }
  const reader = response.body?.getReader(); if (!reader) return fail('DOUYIN_RESPONSE_INVALID');
  let size = 0; const chunks: Buffer[] = [];
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.length;
      if (size > max) return fail('DOUYIN_RESPONSE_TOO_LARGE');
      chunks.push(Buffer.from(next.value));
    }
    return Buffer.concat(chunks,size);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function visitorCookie(response: Response, fallback?: Visitor): Visitor | undefined {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const cookies = headers.getSetCookie?.() ?? (headers.get('set-cookie') ? [headers.get('set-cookie')!] : []);
  let result = fallback;
  for (const line of cookies) {
    const value = /(?:^|,\s*)ttwid=([^;\s,]{1,16000})/u.exec(line)?.[1];
    if (!value) continue;
    const age = /(?:^|;)\s*max-age=(\d+)/iu.exec(line)?.[1];
    const ttl = age === undefined ? VISITOR_TTL : Math.min(VISITOR_TTL, Number(age) * 1000);
    if (!Number.isFinite(ttl) || ttl <= 0) continue;
    result = { cookie: `ttwid=${value}`, expiresAt: Date.now() + ttl };
  }
  return result;
}
function scopeKey(botId: string, proxy: NetworkProxyConfig): string {
  // Credential material only participates in the digest; cache keys are never logged.
  return createHash('sha256').update(JSON.stringify({ botId, proxy, ua: DOUYIN_MOBILE_UA })).digest('hex');
}
function trimSessions(state: DouyinState): void {
  const now = Date.now();
  for (const [key,entry] of state.sessions) if (!entry.pending && (!entry.visitor || entry.visitor.expiresAt <= now)) state.sessions.delete(key);
  while (state.sessions.size >= MAX_CACHE_ENTRIES) {
    const available = [...state.sessions].filter(([,entry]) => !entry.pending).sort((a,b) => a[1].usedAt - b[1].usedAt)[0];
    if (!available) return fail('DOUYIN_VISITOR_QUEUE_FULL',true);
    state.sessions.delete(available[0]);
  }
}
async function initializeVisitor(fetcher: typeof fetch, signal: AbortSignal): Promise<Visitor> {
  const response = await fetcher(REGISTER_URL,{ method: 'POST', redirect: 'manual', signal,
    headers: { 'content-type': 'application/json', 'user-agent': DOUYIN_MOBILE_UA, referer: 'https://www.iesdouyin.com/' },
    body: JSON.stringify({ region: 'cn', aid: 1768, needFid: false, service: 'www.iesdouyin.com', union: true, fid: '' }) });
  let cookie = visitorCookie(response);
  let body: Record<string,any>;
  try { body = object(JSON.parse((await boundedBytes(response,128 * 1024)).toString('utf8'))); }
  catch (error) { if (error instanceof PluginExecutionError) throw error; return fail('DOUYIN_VISITOR_REJECTED'); }
  if (body.status_code !== 0) return fail('DOUYIN_VISITOR_REJECTED');
  if (body.redirect_url !== undefined) {
    if (typeof body.redirect_url !== 'string' || body.redirect_url.length > 4096) return fail('DOUYIN_REDIRECT_REJECTED');
    const callback = await fetcher(officialUrl(body.redirect_url,true),{ redirect: 'manual', signal,
      headers: { 'user-agent': DOUYIN_MOBILE_UA, referer: 'https://www.iesdouyin.com/', ...(cookie ? { cookie: cookie.cookie } : {}) } });
    cookie = visitorCookie(callback,cookie);
    await callback.body?.cancel();
    if (!callback.ok) throw statusError(callback);
  }
  if (!cookie) return fail('DOUYIN_VISITOR_REJECTED');
  return cookie;
}
function waitForVisitor(pending: Promise<Visitor>, signal: AbortSignal): Promise<Visitor> {
  return new Promise((resolve,reject) => {
    const onAbort = () => { signal.removeEventListener('abort',onAbort); reject(signal.reason); };
    signal.addEventListener('abort',onAbort,{ once: true });
    void pending.then(value => { signal.removeEventListener('abort',onAbort); resolve(value); },error => { signal.removeEventListener('abort',onAbort); reject(error); });
    if (signal.aborted) onAbort();
  });
}
async function visitor(state: DouyinState, key: string, createTransport: () => DouyinVisitorTransport, signal: AbortSignal): Promise<Visitor> {
  signal.throwIfAborted();
  let entry = state.sessions.get(key);
  if (entry?.visitor && entry.visitor.expiresAt > Date.now()) { entry.usedAt = Date.now(); return entry.visitor; }
  if (!entry?.pending || entry.controller?.signal.aborted) {
    state.sessions.delete(key); trimSessions(state);
    const current: SessionEntry = { usedAt: Date.now(), waiters: 0, controller: new AbortController() };
    state.sessions.set(key,current); entry = current;
    current.pending = (async () => {
      let transport: DouyinVisitorTransport | undefined;
      try {
        transport = createTransport();
        const identity = await initializeVisitor(transport.fetch,AbortSignal.any([current.controller!.signal,AbortSignal.timeout(15000)]));
        current.visitor = identity;
        return identity;
      } finally {
        await transport?.close().catch(() => {});
        delete current.pending; delete current.controller;
        if (!current.visitor && state.sessions.get(key) === current) state.sessions.delete(key);
      }
    })();
  }
  const current = entry;
  current.waiters++; current.usedAt = Date.now();
  try { return await waitForVisitor(current.pending!,signal); }
  finally {
    current.waiters--;
    if (current.waiters === 0 && current.pending && !current.visitor) current.controller?.abort();
  }
}
export function parseRouterData(html: string): Record<string,any> {
  const match = /\bwindow\._ROUTER_DATA\s*=\s*/u.exec(html); if (!match) return fail('DOUYIN_VISITOR_REJECTED');
  const start = match.index + match[0].length; if (html[start] !== '{') return fail('DOUYIN_RESPONSE_INVALID');
  let depth = 0, quoted = false, escaped = false;
  for (let index = start; index < html.length; index++) {
    const char = html[index];
    if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
    if (char === '"') quoted = true;
    else if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') {
      depth--; if (depth === 0) {
        try { return object(JSON.parse(html.slice(start,index + 1))); } catch { return fail('DOUYIN_RESPONSE_INVALID'); }
      }
    }
  }
  return fail('DOUYIN_RESPONSE_INVALID');
}
export function parseDouyinInfo(router: unknown, videoId: string): DouyinInfo {
  const loader = object(object(router).loaderData); let item: Record<string,any> | undefined, seen = false;
  for (const value of Object.values(loader).slice(0,64)) {
    const info = object(object(value).videoInfoRes);
    if (Object.keys(info).length) seen = true;
    for (const value of Array.isArray(info.item_list) ? info.item_list.slice(0,32) : []) {
      const candidate = object(value); if (String(candidate.aweme_id) === videoId) item = candidate;
    }
    if (Array.isArray(info.filter_list) && info.filter_list.length) seen = true;
  }
  if (!item) return fail(seen ? 'DOUYIN_NOT_FOUND' : 'DOUYIN_VISITOR_REJECTED');
  if (Buffer.byteLength(JSON.stringify(item)) > 256 * 1024) return fail('DOUYIN_RESPONSE_TOO_LARGE');
  if (Array.isArray(item.images) && item.images.length || ![0,4,51,55,61].includes(Number(item.aweme_type))) return fail('DOUYIN_NOT_VIDEO');
  const video = object(item.video), play = object(video.play_addr);
  if (typeof play.uri !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/u.test(play.uri)) return fail('DOUYIN_RESPONSE_INVALID');
  const canonical = `https://www.douyin.com/video/${videoId}`, caption = typeof item.desc === 'string' ? item.desc.slice(0,12000).trim() : '';
  const content: PluginContent = { type: 'video', platform: 'douyin', resourceId: `video:${videoId}`, url: canonical,
    title: caption.slice(0,500) || '抖音视频', ...(caption ? { description: caption } : {}),
    observedAt: Date.now() / 1000, subtitle: { status: 'absent' }, retrieval: { status: 'ready' } };
  const author = object(item.author); if (typeof author.nickname === 'string') content.author = author.nickname.slice(0,500);
  if (typeof author.uid === 'string' && /^\d{1,30}$/u.test(author.uid)) content.authorId = author.uid;
  if (typeof item.create_time === 'number' && Number.isFinite(item.create_time) && item.create_time > 0) content.publishedAt = item.create_time;
  const duration = Number(video.duration ?? item.duration);
  if (Number.isFinite(duration) && duration > 0) content.durationSeconds = duration / 1000;
  const covers = (Array.isArray(object(video.cover).url_list) ? object(video.cover).url_list : []).flatMap((url: unknown) => { const safe = imageUrl(url); return safe ? [safe] : []; }).slice(0,4) as string[];
  const avatars = ['avatar_larger', 'avatar_medium', 'avatar_thumb'].flatMap(key => {
    const value = object(author[key]);
    return (Array.isArray(value.url_list) ? value.url_list.slice(0,4) : []).flatMap((url: unknown) => { const safe = imageUrl(url); return safe ? [safe] : []; });
  }).slice(0,4);
  const avatar = publicImageUrl(avatars[0]);
  if (avatar) content.authorAvatar = { id: `video:${videoId}:avatar`, role: 'avatar', url: avatar, status: 'pending' };
  const cover = publicImageUrl(covers[0]);
  content.blocks = [...(caption ? [{ type: 'paragraph' as const, text: caption }] : []),
    ...(cover ? [{ type: 'image' as const, image: { id: `video:${videoId}:cover`, role: 'cover' as const, url: cover, status: 'pending' as const } }] : [])];
  if (!content.blocks.length) delete content.blocks;
  return { content, item, covers, avatars };
}
export async function resolveDouyinUrl(resource: DouyinResource, fetcher: typeof fetch, signal: AbortSignal): Promise<DouyinResource> {
  let current = resource;
  for (let index = 0; index < 5; index++) {
    if (current.kind === 'note') return fail('DOUYIN_NOT_VIDEO');
    if (current.kind === 'video') return current;
    const response = await fetcher(officialUrl(current.url),{ redirect: 'manual', signal, headers: { 'user-agent': DOUYIN_MOBILE_UA } });
    await response.body?.cancel();
    if (response.status < 300 || response.status >= 400) throw response.ok ? new PluginExecutionError('DOUYIN_SHORT_LINK_FAILED') : statusError(response);
    const location = response.headers.get('location'); if (!location) return fail('DOUYIN_SHORT_LINK_FAILED');
    const url = officialUrl(new URL(location,current.url).toString()), next = normalizeDouyinResource(url);
    if (!next) return fail('DOUYIN_SHORT_LINK_FAILED'); current = next;
  }
  return fail('DOUYIN_REDIRECT_LIMIT');
}
export class DouyinClient {
  private readonly key: string;
  constructor(private readonly fetcher: typeof fetch, botId: string, proxy: NetworkProxyConfig, private readonly state = sharedState,
    private readonly createVisitorTransport: () => DouyinVisitorTransport = () => ({ fetch: fetcher, close: async () => {} })) { this.key = scopeKey(botId,proxy); }
  async info(resource: DouyinResource, signal: AbortSignal): Promise<DouyinInfo> {
    const canonical = await resolveDouyinUrl(resource,this.fetcher,signal), videoId = canonical.id.slice('video:'.length), key = `${this.key}:${videoId}`;
    const cached = this.state.metadata.get(key); if (cached && cached.expiresAt > Date.now()) return cached.info;
    for (let attempt = 0; attempt < 2; attempt++) {
      const identity = await visitor(this.state,this.key,this.createVisitorTransport,signal);
      try {
        const response = await this.fetcher(`https://www.iesdouyin.com/share/video/${videoId}/`,{ redirect: 'manual', signal,
          headers: { 'user-agent': DOUYIN_MOBILE_UA, cookie: identity.cookie, referer: 'https://www.iesdouyin.com/' } });
        const html = (await boundedBytes(response,MAX_HTML_BYTES)).toString('utf8');
        const info = parseDouyinInfo(parseRouterData(html),videoId);
        for (const [id,entry] of this.state.metadata) if (entry.expiresAt <= Date.now()) this.state.metadata.delete(id);
        while (this.state.metadata.size >= MAX_CACHE_ENTRIES) this.state.metadata.delete(this.state.metadata.keys().next().value!);
        this.state.metadata.set(key,{ info, expiresAt: Date.now() + METADATA_TTL });
        return info;
      } catch (error) {
        if (!(error instanceof PluginExecutionError) || error.code !== 'DOUYIN_VISITOR_REJECTED' || attempt !== 0) throw error;
        const current = this.state.sessions.get(this.key); if (current?.visitor === identity) this.state.sessions.delete(this.key);
      }
    }
    return fail('DOUYIN_VISITOR_REJECTED');
  }
}
export async function mediaResponse(url: string, fetcher: typeof fetch, signal: AbortSignal, image = false): Promise<Response> {
  let current: string | undefined = image ? imageUrl(url) : mediaUrl(url);
  if (!current) return fail(image ? 'DOUYIN_IMAGE_URL_REJECTED' : 'DOUYIN_MEDIA_URL_REJECTED');
  for (let attempt = 0; attempt < 5; attempt++) {
    const response: Response = await fetcher(current,{ redirect: 'manual', signal, headers: { 'user-agent': DOUYIN_MOBILE_UA, referer: 'https://www.iesdouyin.com/' } });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel(); const location: string | null = response.headers.get('location'); if (!location) return fail('DOUYIN_MEDIA_UNAVAILABLE');
      current = image ? imageUrl(new URL(location,current).toString()) : mediaUrl(new URL(location,current).toString());
      if (!current) return fail(image ? 'DOUYIN_IMAGE_URL_REJECTED' : 'DOUYIN_MEDIA_URL_REJECTED');
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw statusError(response,true); }
    return response;
  }
  return fail('DOUYIN_REDIRECT_LIMIT');
}
export function videoCandidates(info: DouyinInfo, maxResolution: number, maxBytes: number): string[] {
  const video = object(info.item.video), candidates: Array<{ url: string; resolution: number; bitrate: number }> = [];
  for (const raw of Array.isArray(video.bit_rate) ? video.bit_rate.slice(0,32) : []) {
    const item = object(raw), play = object(item.play_addr), width = Number(play.width ?? item.width), height = Number(play.height ?? item.height);
    const resolution = Math.min(width,height), size = Number(play.data_size);
    if (!Number.isFinite(resolution) || resolution <= 0 || resolution > maxResolution || Number.isFinite(size) && size > maxBytes) continue;
    // H.265-only variants are skipped; the generic play endpoint provides a fallback.
    if (item.is_h265 === 1 || /(?:hevc|h265|hvc1)/iu.test(String(item.gear_name ?? ''))) continue;
    for (const input of Array.isArray(play.url_list) ? play.url_list.slice(0,4) : []) { const url = mediaUrl(input); if (url) candidates.push({ url, resolution, bitrate: Number(item.bit_rate) || 0 }); }
  }
  candidates.sort((a,b) => b.resolution - a.resolution || b.bitrate - a.bitrate);
  const uri = object(video.play_addr).uri;
  if (typeof uri !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/u.test(uri)) return fail('DOUYIN_RESPONSE_INVALID');
  const ratios = [1080,720,540,360,240,144].filter(ratio => ratio <= maxResolution);
  const generic = (ratio: number) => `https://aweme.snssdk.com/aweme/v1/play/?video_id=${encodeURIComponent(uri)}&ratio=${ratio}p&line=0`;
  const native = [...new Set(candidates.map(item => item.url))].slice(0,2);
  if (!native.length) return ratios.slice(0,3).map(generic);
  const fallback = ratios.find(ratio => ratio < candidates[0]!.resolution) ?? ratios[0];
  const fallbacks = native.length === 1 ? [...new Set([ratios[0],fallback])] : [fallback];
  return [...new Set([...native, ...fallbacks.filter((ratio): ratio is number => ratio !== undefined).map(generic)])].slice(0,3);
}
