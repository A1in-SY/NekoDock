export type WebSearchConfig =
  | { provider: 'none' }
  | {
    provider: 'tavily';
    apiKey: string;
    baseUrl: string;
    searchDepth: 'basic' | 'advanced';
    maxResults: number;
    timeoutMs: number;
  }
  | {
    provider: 'deepseek';
    apiKey: string;
    baseUrl: string;
    maxResults: number;
    timeoutMs: number;
  };

export interface WebSearchRequest {
  query: string;
  maxResults?: number;
  topic?: 'general' | 'news';
  days?: number;
}

export interface WebSearchResult {
  content?: string;
  sources: Array<{ url: string; title?: string; snippet?: string; publishedAt?: string }>;
}

export interface WebFetchRequest { urls: string[] }

export interface WebFetchResult {
  sources: Array<{ url: string; content: string }>;
  failures: Array<{ url: string; error: string; code?: string }>;
}

export interface WebSearchProvider {
  search(request: WebSearchRequest, signal: AbortSignal): Promise<WebSearchResult>;
  fetch(request: WebFetchRequest, signal: AbortSignal): Promise<WebFetchResult>;
}

export class WebSearchError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'WebSearchError';
  }
}

export function loadWebSearchConfig(env: NodeJS.ProcessEnv = process.env): WebSearchConfig {
  const provider = env.WEB_SEARCH_PROVIDER?.trim() || 'none';
  if (provider === 'none') return { provider };
  if (provider === 'deepseek') {
    const apiKey = env.DEEPSEEK_SEARCH_API_KEY?.trim();
    if (!apiKey) throw configError('DEEPSEEK_SEARCH_API_KEY is required when WEB_SEARCH_PROVIDER is deepseek');
    return {
      provider, apiKey,
      baseUrl: normalizeBaseUrl(env.DEEPSEEK_SEARCH_BASE_URL?.trim() || 'https://api.deepseek.com', 'DEEPSEEK_SEARCH_BASE_URL'),
      maxResults: integerSetting(env.DEEPSEEK_SEARCH_MAX_RESULTS, 'DEEPSEEK_SEARCH_MAX_RESULTS', 8, 20),
      timeoutMs: integerSetting(env.WEB_SEARCH_TIMEOUT_MS, 'WEB_SEARCH_TIMEOUT_MS', 30_000, 300_000),
    };
  }
  if (provider !== 'tavily') throw configError('WEB_SEARCH_PROVIDER must be none, tavily or deepseek');
  const apiKey = env.TAVILY_API_KEY?.trim();
  if (!apiKey) throw configError('TAVILY_API_KEY is required when WEB_SEARCH_PROVIDER is tavily');
  const baseUrl = normalizeBaseUrl(env.TAVILY_SEARCH_BASE_URL?.trim() || 'https://api.tavily.com');
  const searchDepth = env.TAVILY_SEARCH_DEPTH?.trim() || 'basic';
  if (searchDepth !== 'basic' && searchDepth !== 'advanced') {
    throw configError('TAVILY_SEARCH_DEPTH must be basic or advanced');
  }
  return {
    provider, apiKey, baseUrl, searchDepth,
    maxResults: integerSetting(env.TAVILY_MAX_RESULTS, 'TAVILY_MAX_RESULTS', 8, 20),
    timeoutMs: integerSetting(env.WEB_SEARCH_TIMEOUT_MS, 'WEB_SEARCH_TIMEOUT_MS', 30_000, 300_000),
  };
}

export function createWebSearchProvider(config: WebSearchConfig, requestFetch?:typeof globalThis.fetch): WebSearchProvider | null {
  if (config.provider === 'none') return null;
  return config.provider === 'deepseek' ? new DeepSeekProvider(config, requestFetch) : new TavilyProvider(config, requestFetch);
}

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
type TavilyConfig = Extract<WebSearchConfig, { provider: 'tavily' }>;
type ActiveSearchConfig = Exclude<WebSearchConfig, { provider: 'none' }>;

class TavilyProvider implements WebSearchProvider {
  constructor(private readonly config: TavilyConfig,private readonly requestFetch?:typeof globalThis.fetch) {}

  async search(request: WebSearchRequest, signal: AbortSignal): Promise<WebSearchResult> {
    if (!isRecord(request) || typeof request.query !== 'string' || !request.query.trim()) {
      throw invalidRequest('query must be a non-empty string');
    }
    const maxResults = request.maxResults === undefined ? this.config.maxResults : request.maxResults;
    if (!positiveInteger(maxResults) || maxResults > 20) {
      throw invalidRequest('maxResults must be an integer from 1 to 20');
    }
    if (request.topic !== undefined && request.topic !== 'general' && request.topic !== 'news') {
      throw invalidRequest('topic must be general or news');
    }
    if (request.days !== undefined && !positiveInteger(request.days)) {
      throw invalidRequest('days must be a positive safe integer');
    }
    if (request.days !== undefined && request.topic !== 'news') {
      throw invalidRequest('days is only supported when topic is news');
    }
    const response = await this.post('/search', {
      query: request.query.trim(),
      max_results: maxResults,
      search_depth: this.config.searchDepth,
      include_answer: true,
      include_raw_content: false,
      include_images: false,
      ...(request.topic === undefined ? {} : { topic: request.topic }),
      ...(request.days === undefined ? {} : { days: request.days }),
    }, signal);
    if (!Array.isArray(response.results)) throw invalidResponse();
    const seen = new Set<string>();
    const sources: WebSearchResult['sources'] = [];
    for (const item of response.results) {
      if (!isRecord(item)) continue;
      const url = sourceUrl(item.url);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      sources.push({
        url,
        ...optionalText('title', item.title, 1_000),
        ...optionalText('snippet', item.content, 4_000),
        ...optionalText('publishedAt', item.published_date, 200),
      });
      if (sources.length === maxResults) break;
    }
    return { ...optionalText('content', response.answer, 8_000), sources };
  }

  async fetch(request: WebFetchRequest, signal: AbortSignal): Promise<WebFetchResult> {
    if (!isRecord(request) || !Array.isArray(request.urls) || request.urls.length < 1 || request.urls.length > 20) {
      throw invalidRequest('urls must contain from 1 to 20 HTTP or HTTPS URLs');
    }
    const urls: string[] = [];
    for (const value of request.urls) {
      const url = sourceUrl(value);
      if (!url) throw invalidRequest('urls must contain from 1 to 20 HTTP or HTTPS URLs');
      if (!urls.includes(url)) urls.push(url);
    }
    const response = await this.post('/extract', { urls, format: 'markdown' }, signal);
    if (!Array.isArray(response.results) || (response.failed_results !== undefined && !Array.isArray(response.failed_results))) {
      throw invalidResponse();
    }
    const seen = new Set<string>();
    const sources: WebFetchResult['sources'] = [];
    const failures: WebFetchResult['failures'] = [];
    for (const item of response.results) {
      if (!isRecord(item)) continue;
      const url = sourceUrl(item.url);
      if (!url || seen.has(url) || !urls.includes(url) || typeof item.raw_content !== 'string') continue;
      seen.add(url);
      sources.push({ url, content: truncate(item.raw_content, 20_000) });
    }
    for (const item of response.failed_results ?? []) {
      if (!isRecord(item)) continue;
      const url = sourceUrl(item.url);
      if (!url || seen.has(url) || !urls.includes(url)) continue;
      seen.add(url);
      failures.push({ url, error: 'Failed to extract content' });
    }
    for (const url of urls) {
      if (!seen.has(url)) failures.push({ url, error: 'No extracted content returned' });
    }
    return { sources, failures };
  }

  private async post(path: string, body: object, signal: AbortSignal): Promise<Record<string, unknown>> {
    return withTimeout(this.config.timeoutMs, signal, combined => postJson(this.config, path, body, combined, this.requestFetch));
  }
}

class DeepSeekProvider implements WebSearchProvider {
  constructor(private readonly config: Extract<WebSearchConfig, { provider: 'deepseek' }>, private readonly requestFetch?: typeof globalThis.fetch) {}

  async search(request: WebSearchRequest, signal: AbortSignal): Promise<WebSearchResult> {
    if (!isRecord(request) || typeof request.query !== 'string' || !request.query.trim() || [...request.query.trim()].length > 128) {
      throw invalidRequest('DeepSeek query must contain 1 to 128 Unicode characters');
    }
    if (request.topic !== undefined || request.days !== undefined) {
      throw invalidRequest('DeepSeek does not support topic or days; use after:YYYY-MM-DD or before:YYYY-MM-DD in query');
    }
    const count = request.maxResults === undefined ? this.config.maxResults : request.maxResults;
    if (!positiveInteger(count) || count > 20) throw invalidRequest('maxResults must be an integer from 1 to 20');
    return withTimeout(this.config.timeoutMs, signal, async combined => {
      const response = await postJson(this.config, '/v1/tools/search', { query: request.query.trim(), count, need_content: false }, combined, this.requestFetch);
      if (!Array.isArray(response.results)) throw invalidResponse('DeepSeek');
      const sources: WebSearchResult['sources'] = [];
      const seen = new Set<string>();
      for (const item of response.results) {
        if (!isRecord(item)) continue;
        const url = sourceUrl(item.url);
        if (!url || seen.has(url)) continue;
        seen.add(url);
        sources.push({ url, ...optionalText('title', item.title, 1_000),
          ...optionalText('snippet', typeof item.summary === 'string' && item.summary.trim() ? item.summary : item.snippet, 4_000),
          ...optionalText('publishedAt', item.date, 200) });
        if (sources.length === count) break;
      }
      return { sources };
    });
  }

  async fetch(request: WebFetchRequest, signal: AbortSignal): Promise<WebFetchResult> {
    if (!isRecord(request) || !Array.isArray(request.urls) || request.urls.length < 1 || request.urls.length > 20) {
      throw invalidRequest('urls must contain from 1 to 20 HTTP or HTTPS URLs');
    }
    const urls: string[] = [];
    for (const value of request.urls) {
      const url = sourceUrl(value);
      if (!url || [...url].length > 8192) throw invalidRequest('Each URL must be an HTTP(S) URL with at most 8192 characters and no credentials');
      if (!urls.includes(url)) urls.push(url);
    }
    // One deadline includes queueing, headers and bodies for the entire batch.
    return withTimeout(this.config.timeoutMs, signal, async combined => {
      const stop = new AbortController();
      const batchSignal = AbortSignal.any([combined, stop.signal]);
      const pages = new Map<string, string>();
      const errors = new Map<string, WebSearchError>();
      let next = 0;
      let fatal: WebSearchError | undefined;
      await Promise.all(Array.from({ length: Math.min(3, urls.length) }, async () => {
        while (!batchSignal.aborted) {
          const url = urls[next++];
          if (!url) return;
          try {
            const response = await postJson(this.config, '/v1/tools/fetch', { url }, batchSignal, this.requestFetch);
            if (typeof response.content !== 'string' || !response.content.trim()) throw invalidResponse('DeepSeek');
            pages.set(url, truncate(response.content, 20_000));
          } catch (error) {
            if (batchSignal.aborted) return;
            const failure = error instanceof WebSearchError ? error : new WebSearchError('WEB_REQUEST_FAILED', 'DeepSeek request failed');
            if (failure.code === 'WEB_AUTH_FAILED' || failure.code === 'WEB_INSUFFICIENT_BALANCE') {
              fatal = failure; stop.abort(); return;
            }
            errors.set(url, failure);
          }
        }
      }));
      if (fatal) throw fatal;
      const sources: WebFetchResult['sources'] = [];
      const failures: WebFetchResult['failures'] = [];
      for (const url of urls) {
        const content = pages.get(url);
        if (content !== undefined) sources.push({ url, content });
        else {
          const error = errors.get(url);
          if (error) failures.push({ url, code: error.code, error: error.message });
        }
      }
      return { sources, failures };
    });
  }
}

async function withTimeout<T>(timeoutMs: number, signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  timer.unref();
  const combined = AbortSignal.any([signal, timeout.signal]);
  try {
    combined.throwIfAborted();
    const result = await operation(combined);
    combined.throwIfAborted();
    return result;
  } catch (error) {
    if (signal.aborted) throw new WebSearchError('WEB_ABORTED', 'Web request was cancelled');
    if (timeout.signal.aborted) throw new WebSearchError('WEB_TIMEOUT', 'Web request timed out');
    throw error;
  } finally { clearTimeout(timer); }
}

async function postJson(config: ActiveSearchConfig, path: string, body: object, signal: AbortSignal, requestFetch: typeof globalThis.fetch = fetch): Promise<Record<string, unknown>> {
  const name = config.provider === 'deepseek' ? 'DeepSeek' : 'Tavily';
  try {
    signal.throwIfAborted();
    const response = await requestFetch(`${config.baseUrl}${path}`, {
      method: 'POST', redirect: 'manual',
      headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body), signal,
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      if (config.provider === 'deepseek') throw deepSeekHttpError(response.status, path.endsWith('/fetch'));
      throw new WebSearchError('WEB_HTTP_ERROR', `Tavily request failed (HTTP ${response.status})`);
    }
    const bytes = await readResponse(response, name);
    let parsed: unknown;
    try { parsed = JSON.parse(bytes.toString('utf8')); } catch { throw invalidResponse(name); }
    if (!isRecord(parsed)) throw invalidResponse(name);
    return parsed;
  } catch (error) {
    if (error instanceof WebSearchError) throw error;
    throw new WebSearchError('WEB_REQUEST_FAILED', `${name} request failed`);
  }
}

function deepSeekHttpError(status: number, fetching: boolean): WebSearchError {
  const errors: Record<number, [string, string]> = {
    400: ['WEB_INVALID_REQUEST', 'Invalid request'],
    401: ['WEB_AUTH_FAILED', 'API key is missing or invalid'],
    402: ['WEB_INSUFFICIENT_BALANCE', 'Account balance is insufficient'],
    403: ['WEB_ACCESS_DENIED', 'Request was rejected by the security policy'],
    429: ['WEB_RATE_LIMITED', 'Rate limit exceeded'],
    504: ['WEB_TIMEOUT', 'Upstream request timed out'],
  };
  const [code, reason] = errors[status] ?? (status === 404 && fetching
    ? ['WEB_FETCH_UNAVAILABLE', 'No usable page content could be retrieved']
    : status >= 500 ? ['WEB_UPSTREAM_ERROR', 'Upstream service failed'] : ['WEB_HTTP_ERROR', 'Request failed']);
  return new WebSearchError(code, `DeepSeek: ${reason} (HTTP ${status})`);
}

async function readResponse(response: Response, provider = 'Tavily'): Promise<Buffer> {
  if (!response.body) throw invalidResponse(provider);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, total);
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => {});
        throw new WebSearchError('WEB_RESPONSE_TOO_LARGE', `${provider} response exceeds 4 MiB`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}

function configError(message: string): WebSearchError {
  return new WebSearchError('WEB_CONFIG_ERROR', message);
}

function invalidRequest(message: string): WebSearchError {
  return new WebSearchError('WEB_INVALID_REQUEST', message);
}

function invalidResponse(provider = 'Tavily'): WebSearchError {
  return new WebSearchError('WEB_INVALID_RESPONSE', `${provider} returned an invalid response`);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function integerSetting(value: string | undefined, name: string, fallback: number, max: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!positiveInteger(parsed) || parsed > max) throw configError(`${name} must be an integer from 1 to ${max}`);
  return parsed;
}

function normalizeBaseUrl(value: string, setting = 'TAVILY_SEARCH_BASE_URL'): string {
  let url: URL;
  try { url = new URL(value); } catch { throw configError(`${setting} must be an HTTP or HTTPS URL without credentials, query, or fragment`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || value.includes('?') || value.includes('#')) {
    throw configError(`${setting} must be an HTTP or HTTPS URL without credentials, query, or fragment`);
  }
  return url.href.replace(/\/+$/u, '');
}

function sourceUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
    return url.href;
  } catch { return undefined; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function truncate(value: string, limit: number): string {
  return [...value].slice(0, limit).join('');
}

function optionalText<K extends string>(name: K, value: unknown, limit: number): Partial<Record<K, string>> {
  return typeof value === 'string' && value.length > 0 ? { [name]: truncate(value, limit) } as Record<K, string> : {};
}
