import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { test, type TestContext } from 'node:test';
import { createWebSearchProvider, loadWebSearchConfig, WebSearchError, type WebSearchConfig } from '../src/web-search.js';

const active = { WEB_SEARCH_PROVIDER: 'deepseek', DEEPSEEK_SEARCH_API_KEY: 'synthetic-deepseek-private-key' };
const signal = () => new AbortController().signal;
function code(expected: string) {
  return (error: unknown) => {
    assert.ok(error instanceof WebSearchError);
    assert.equal(error.code, expected);
    assert.doesNotMatch(error.message, /synthetic-deepseek-private-key|private-body|private-query|private-url|private-abort/);
    assert.equal(error.cause, undefined);
    return true;
  };
}
function provider(baseUrl = 'https://api.example.com', timeoutMs = 1000, requestFetch?: typeof fetch) {
  const config = { ...loadWebSearchConfig({ ...active, DEEPSEEK_SEARCH_BASE_URL: baseUrl }), timeoutMs } as WebSearchConfig;
  return createWebSearchProvider(config, requestFetch)!;
}
async function service(t: TestContext, handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}
const json = (value: unknown) => Response.json(value);

test('DeepSeek has independent defaults and ignores inactive Tavily settings', () => {
  assert.deepEqual(loadWebSearchConfig({ ...active, TAVILY_SEARCH_BASE_URL: 'invalid', TAVILY_SEARCH_DEPTH: 'invalid' }), {
    provider: 'deepseek', apiKey: active.DEEPSEEK_SEARCH_API_KEY, baseUrl: 'https://api.deepseek.com', maxResults: 8, timeoutMs: 30_000,
  });
  assert.deepEqual(loadWebSearchConfig({ ...active, DEEPSEEK_SEARCH_BASE_URL: ' https://API.example.com:443/gateway/// ', DEEPSEEK_SEARCH_MAX_RESULTS: '20', WEB_SEARCH_TIMEOUT_MS: '300000' }), {
    provider: 'deepseek', apiKey: active.DEEPSEEK_SEARCH_API_KEY, baseUrl: 'https://api.example.com/gateway', maxResults: 20, timeoutMs: 300_000,
  });
  assert.deepEqual(loadWebSearchConfig({ WEB_SEARCH_PROVIDER: 'none', DEEPSEEK_SEARCH_BASE_URL: 'invalid' }), { provider: 'none' });
  for (const apiKey of [undefined, '', ' \t ']) {
    assert.throws(() => loadWebSearchConfig({ ...active, DEEPSEEK_SEARCH_API_KEY: apiKey, AGENT_API_KEY: 'model-key', TAVILY_API_KEY: 'tavily-key' }), code('WEB_CONFIG_ERROR'));
  }
  for (const baseUrl of ['private-url', 'file:///private-url', 'https://user:secret@example.com', 'https://example.com/?', 'https://example.com/#']) {
    assert.throws(() => loadWebSearchConfig({ ...active, DEEPSEEK_SEARCH_BASE_URL: baseUrl }), code('WEB_CONFIG_ERROR'));
  }
  for (const maxResults of ['0', '21', '1.5', 'NaN']) assert.throws(() => loadWebSearchConfig({ ...active, DEEPSEEK_SEARCH_MAX_RESULTS: maxResults }), code('WEB_CONFIG_ERROR'));
  for (const timeout of ['0', '300001', 'NaN']) assert.throws(() => loadWebSearchConfig({ ...active, WEB_SEARCH_TIMEOUT_MS: timeout }), code('WEB_CONFIG_ERROR'));
});

test('DeepSeek search sends exact authenticated JSON and maps ranked summaries, dates and unique URLs', async t => {
  const requests: unknown[] = [];
  const baseUrl = await service(t, (request, response) => { void (async () => {
    let raw = ''; for await (const chunk of request) raw += String(chunk);
    requests.push({ path: request.url, method: request.method, auth: request.headers.authorization, body: JSON.parse(raw) });
    response.end(JSON.stringify({ results: [null, { url: 'javascript:alert(1)' },
      { url: 'https://example.com/a', title: 'A', summary: '😀'.repeat(4001), snippet: 'short', date: '2026-01-01T00:00:00Z' },
      { url: 'https://example.com/a', title: 'duplicate' }, { url: 'https://example.com/b', summary: ' ', snippet: 'fallback', date: null },
      { url: 'https://example.com/c' }] }));
  })().catch(error => { response.statusCode = 500; response.end(String(error)); }); });
  const result = await provider(`${baseUrl}/gateway`).search({ query: '  新闻 site:example.com after:2026-01-01  ', maxResults: 2 }, signal());
  assert.deepEqual(requests, [{ path: '/gateway/v1/tools/search', method: 'POST', auth: `Bearer ${active.DEEPSEEK_SEARCH_API_KEY}`,
    body: { query: '新闻 site:example.com after:2026-01-01', count: 2, need_content: false } }]);
  assert.deepEqual(result, { sources: [
    { url: 'https://example.com/a', title: 'A', snippet: '😀'.repeat(4000), publishedAt: '2026-01-01T00:00:00Z' },
    { url: 'https://example.com/b', snippet: 'fallback' },
  ] });
});

test('DeepSeek validates Unicode query length, unsupported filters and all URLs before any request', async () => {
  let calls = 0;
  const p = provider(undefined, undefined, async (_url, init) => {
    calls++; assert.equal(JSON.parse(String(init?.body)).count, 8); return json({ results: [] });
  });
  assert.deepEqual(await p.search({ query: '😀'.repeat(128) }, signal()), { sources: [] });
  for (const request of [{}, { query: '' }, { query: ' ' }, { query: 4 }, { query: '😀'.repeat(129) },
    ...[0, 21, 1.5, null].map(maxResults => ({ query: 'ok', maxResults })),
    { query: 'ok', topic: 'news' }, { query: 'ok', topic: 'general' }, { query: 'ok', days: 1 }]) {
    await assert.rejects(p.search(request as never, signal()), code('WEB_INVALID_REQUEST'));
  }
  for (const urls of [[], Array(21).fill('https://example.com'), ['https://example.com', 'private-url'], ['https://user:secret@example.com'],
    ['https://example.com/' + 'x'.repeat(8192)], [null], undefined]) {
    await assert.rejects(p.fetch({ urls } as never, signal()), code('WEB_INVALID_REQUEST'));
  }
  assert.equal(calls, 1);
});

test('DeepSeek HTTP failures are actionable, sanitized and never retried', async t => {
  const statuses = [400, 401, 402, 403, 404, 408, 429, 500, 504, 307];
  let calls = 0;
  const baseUrl = await service(t, (_request, response) => {
    response.writeHead(statuses[calls++]!, { location: 'http://127.0.0.1:1/private-url' }); response.end('private-body synthetic-deepseek-private-key');
  });
  const expected = ['WEB_INVALID_REQUEST', 'WEB_AUTH_FAILED', 'WEB_INSUFFICIENT_BALANCE', 'WEB_ACCESS_DENIED', 'WEB_HTTP_ERROR',
    'WEB_HTTP_ERROR', 'WEB_RATE_LIMITED', 'WEB_UPSTREAM_ERROR', 'WEB_TIMEOUT', 'WEB_HTTP_ERROR'];
  for (const errorCode of expected) await assert.rejects(provider(baseUrl).search({ query: 'private-query' }, signal()), code(errorCode));
  assert.equal(calls, statuses.length);
});

test('DeepSeek rejects invalid JSON, malformed search results and oversized bodies', async () => {
  for (const body of ['private-body', 'null', '[]', '{}', '{"results":{}}']) {
    await assert.rejects(provider(undefined, undefined, async () => new Response(body)).search({ query: 'ok' }, signal()), code('WEB_INVALID_RESPONSE'));
  }
  await assert.rejects(provider(undefined, undefined, async () => new Response('x'.repeat(4 * 1024 * 1024 + 1))).search({ query: 'ok' }, signal()), code('WEB_RESPONSE_TOO_LARGE'));
  await assert.rejects(provider(undefined, undefined, async () => { throw new Error('private-body'); }).search({ query: 'ok' }, signal()), code('WEB_REQUEST_FAILED'));
});

test('DeepSeek fetch deduplicates, limits concurrency and preserves ordered partial results', async () => {
  let activeCalls = 0; let peak = 0;
  const requested: string[] = [];
  const urls = ['a', 'b', 'c', 'd', 'e', 'f'].map(path => `https://example.com/${path}`);
  const p = provider(undefined, undefined, async (url, init) => {
    assert.equal(url, 'https://api.example.com/v1/tools/fetch');
    assert.equal(init?.redirect, 'manual');
    assert.equal((init?.headers as Record<string, string>).authorization, `Bearer ${active.DEEPSEEK_SEARCH_API_KEY}`);
    const body = JSON.parse(String(init?.body)); assert.deepEqual(Object.keys(body), ['url']);
    requested.push(body.url); activeCalls++; peak = Math.max(peak, activeCalls);
    await new Promise(resolve => setTimeout(resolve, 10)); activeCalls--;
    if (body.url === urls[1]) return new Response('private-body', { status: 404 });
    if (body.url === urls[2]) return new Response('private-body', { status: 403 });
    if (body.url === urls[3]) return json({ content: '' });
    return json({ title: 'page', content: '文'.repeat(20_001) });
  });
  const result = await p.fetch({ urls: [urls[0]!, ...urls] }, signal());
  assert.equal(peak, 3); assert.equal(activeCalls, 0); assert.deepEqual(requested, urls);
  assert.deepEqual(result.sources.map(source => source.url), [urls[0], urls[4], urls[5]]);
  assert.ok(result.sources.every(source => [...source.content].length === 20_000));
  assert.deepEqual(result.failures.map(failure => [failure.url, failure.code]), [
    [urls[1], 'WEB_FETCH_UNAVAILABLE'], [urls[2], 'WEB_ACCESS_DENIED'], [urls[3], 'WEB_INVALID_RESPONSE'],
  ]);
  assert.doesNotMatch(JSON.stringify(result), /private-body|synthetic-deepseek-private-key/);
});

test('DeepSeek authentication and balance errors stop queued fetches and cancel other requests', async () => {
  for (const [status, errorCode] of [[401, 'WEB_AUTH_FAILED'], [402, 'WEB_INSUFFICIENT_BALANCE']] as const) {
    let calls = 0; let aborted = 0;
    const p = provider(undefined, undefined, async (_url, init) => {
      if (++calls === 1) return new Response('private-body', { status });
      return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => { aborted++; reject(new Error('private-abort')); }, { once: true }));
    });
    await assert.rejects(p.fetch({ urls: Array.from({ length: 10 }, (_, index) => `https://example.com/${index}`) }, signal()), code(errorCode));
    assert.equal(calls, 3); assert.equal(aborted, 2);
  }
});

test('DeepSeek fetch shares one deadline across queueing and cancels all in-flight requests', async () => {
  let calls = 0; let aborted = 0;
  const signals = new Set<AbortSignal>();
  const p = provider(undefined, 40, async (_url, init) => {
    signals.add(init!.signal!);
    if (++calls <= 3) return json({ content: 'first wave' });
    return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => { aborted++; reject(new Error('private-abort')); }, { once: true }));
  });
  // The unref'ed production deadline needs a live resource in this synthetic transport.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(p.fetch({ urls: Array.from({ length: 10 }, (_, index) => `https://example.com/${index}`) }, signal()), code('WEB_TIMEOUT'));
    assert.equal(calls, 6); assert.equal(aborted, 3); assert.equal(signals.size, 1);
  } finally { clearInterval(keepAlive); }
});

test('DeepSeek explicit cancellation stops queued pages and pre-aborted requests make no calls', async () => {
  let calls = 0; let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const p = provider(undefined, undefined, async (_url, init) => {
    if (++calls === 3) started();
    return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('private-abort')), { once: true }));
  });
  const controller = new AbortController();
  const pending = p.fetch({ urls: Array.from({ length: 10 }, (_, index) => `https://example.com/${index}`) }, controller.signal);
  await ready; controller.abort(new Error('private-abort'));
  await assert.rejects(pending, code('WEB_ABORTED')); assert.equal(calls, 3);
  await assert.rejects(p.search({ query: 'ok' }, controller.signal), code('WEB_ABORTED'));
  await assert.rejects(p.fetch({ urls: ['https://example.com'] }, controller.signal), code('WEB_ABORTED')); assert.equal(calls, 3);
});

test('DeepSeek timeout covers both response headers and streaming bodies', async t => {
  const baseUrl = await service(t, (request, response) => {
    if (request.url?.startsWith('/body/')) { response.writeHead(200); response.write('{"results":['); }
  });
  await assert.rejects(provider(baseUrl, 30).search({ query: 'ok' }, signal()), code('WEB_TIMEOUT'));
  await assert.rejects(provider(`${baseUrl}/body`, 30).search({ query: 'ok' }, signal()), code('WEB_TIMEOUT'));
});
