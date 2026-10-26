export type WebSearchConfig =
  | { provider: 'none' }
  | {
    provider: 'tavily';
    apiKey: string;
    baseUrl: string;
    searchDepth: 'basic' | 'advanced';
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
  failures: Array<{ url: string; error: string }>;
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
  if (provider !== 'tavily') throw configError('WEB_SEARCH_PROVIDER must be none or tavily');
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

export function createWebSearchProvider(config: WebSearchConfig): WebSearchProvider | null {
  return config.provider === 'none' ? null : new TavilyProvider(config);
}

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
type TavilyConfig = Extract<WebSearchConfig, { provider: 'tavily' }>;

class TavilyProvider implements WebSearchProvider {
  constructor(private readonly config: TavilyConfig) {}

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
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.config.timeoutMs);
    timer.unref();
    const combined = AbortSignal.any([signal, timeout.signal]);
    try {
      combined.throwIfAborted();
      const response = await fetch(`${this.config.baseUrl}${path}`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: combined,
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new WebSearchError('WEB_HTTP_ERROR', `Tavily request failed (HTTP ${response.status})`);
      }
      const bytes = await readResponse(response);
      let parsed: unknown;
      try { parsed = JSON.parse(bytes.toString('utf8')); } catch { throw invalidResponse(); }
      if (!isRecord(parsed)) throw invalidResponse();
      return parsed;
    } catch (error) {
      if (signal.aborted) throw new WebSearchError('WEB_ABORTED', 'Web request was cancelled');
      if (timeout.signal.aborted) throw new WebSearchError('WEB_TIMEOUT', 'Web request timed out');
      if (error instanceof WebSearchError) throw error;
      throw new WebSearchError('WEB_REQUEST_FAILED', 'Tavily request failed');
    } finally {
      clearTimeout(timer);
    }
  }
}

async function readResponse(response: Response): Promise<Buffer> {
  if (!response.body) throw invalidResponse();
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
        throw new WebSearchError('WEB_RESPONSE_TOO_LARGE', 'Tavily response exceeds 4 MiB');
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

function invalidResponse(): WebSearchError {
  return new WebSearchError('WEB_INVALID_RESPONSE', 'Tavily returned an invalid response');
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

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw configError('TAVILY_SEARCH_BASE_URL must be an HTTP or HTTPS URL without credentials, query, or fragment'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || value.includes('?') || value.includes('#')) {
    throw configError('TAVILY_SEARCH_BASE_URL must be an HTTP or HTTPS URL without credentials, query, or fragment');
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
