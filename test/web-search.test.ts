import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { test, type TestContext } from 'node:test';
import {
  createWebSearchProvider, loadWebSearchConfig, WebSearchError,
  type WebSearchConfig, type WebSearchProvider,
} from '../src/web-search.js';

const active = { WEB_SEARCH_PROVIDER: 'tavily', TAVILY_API_KEY: 'test-private-api-key' };

function assertCode(code: string): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof WebSearchError);
    assert.equal(error.code, code);
    assert.doesNotMatch(error.message, /private-api-key|secret-network-detail|private-upstream-body|private-query|private-url/);
    assert.equal(error.cause, undefined);
    return true;
  };
}

async function service(t: TestContext, handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

function provider(baseUrl: string, timeoutMs = 1_000): WebSearchProvider {
  const config = loadWebSearchConfig({ ...active, TAVILY_SEARCH_BASE_URL: baseUrl });
  assert.equal(config.provider, 'tavily');
  const result = createWebSearchProvider({ ...config, timeoutMs } as WebSearchConfig);
  assert.ok(result);
  return result;
}

function json(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

test('搜索供应商默认禁用，禁用时忽略其他设置，仅允许选择一个供应商', () => {
  assert.deepEqual(loadWebSearchConfig({}), { provider: 'none' });
  assert.deepEqual(loadWebSearchConfig({
    WEB_SEARCH_PROVIDER: ' none ', TAVILY_API_KEY: ' ', TAVILY_SEARCH_BASE_URL: 'bad',
    TAVILY_SEARCH_DEPTH: 'bad', TAVILY_MAX_RESULTS: '-1', WEB_SEARCH_TIMEOUT_MS: 'bad',
  }), { provider: 'none' });
  assert.equal(createWebSearchProvider({ provider: 'none' }), null);
  for (const value of ['bing', 'tavily,bing', 'TAVILY']) {
    assert.throws(() => loadWebSearchConfig({ WEB_SEARCH_PROVIDER: value }), assertCode('WEB_CONFIG_ERROR'));
  }
});

test('Tavily 配置默认值及自定义端点、搜索深度、结果数和超时', () => {
  assert.deepEqual(loadWebSearchConfig(active), {
    provider: 'tavily', apiKey: 'test-private-api-key', baseUrl: 'https://api.tavily.com',
    searchDepth: 'basic', maxResults: 8, timeoutMs: 30_000,
  });
  assert.deepEqual(loadWebSearchConfig({
    ...active, WEB_SEARCH_PROVIDER: ' tavily ', TAVILY_API_KEY: ' test-private-api-key ',
    TAVILY_SEARCH_BASE_URL: ' https://API.example.com:443/gateway/// ',
    TAVILY_SEARCH_DEPTH: ' advanced ', TAVILY_MAX_RESULTS: '20', WEB_SEARCH_TIMEOUT_MS: '300000',
  }), {
    provider: 'tavily', apiKey: 'test-private-api-key', baseUrl: 'https://api.example.com/gateway',
    searchDepth: 'advanced', maxResults: 20, timeoutMs: 300_000,
  });
  assert.equal(loadWebSearchConfig({ ...active, TAVILY_SEARCH_BASE_URL: 'http://127.0.0.1:3000/' }).provider, 'tavily');
});

test('无效 Tavily 配置在启动前拒绝，错误不回显输入', () => {
  for (const apiKey of [undefined, '', ' \n\t ']) {
    assert.throws(() => loadWebSearchConfig({ ...active, TAVILY_API_KEY: apiKey }), assertCode('WEB_CONFIG_ERROR'));
  }
  for (const baseUrl of ['private-url', 'file:///private-url', 'https://user:private-api-key@example.com', 'https://example.com/?private-query', 'https://example.com/#private-query', 'https://example.com/?', 'https://example.com/#']) {
    assert.throws(() => loadWebSearchConfig({ ...active, TAVILY_SEARCH_BASE_URL: baseUrl }), assertCode('WEB_CONFIG_ERROR'));
  }
  for (const searchDepth of ['auto', 'private-api-key']) {
    assert.throws(() => loadWebSearchConfig({ ...active, TAVILY_SEARCH_DEPTH: searchDepth }), assertCode('WEB_CONFIG_ERROR'));
  }
  for (const [name, values] of [
    ['TAVILY_MAX_RESULTS', ['0', '-1', '21', '1.5', 'NaN', 'Infinity', 'private-api-key']],
    ['WEB_SEARCH_TIMEOUT_MS', ['0', '-1', '300001', '0.5', '9007199254740992', 'private-api-key']],
  ] as const) {
    for (const value of values) assert.throws(() => loadWebSearchConfig({ ...active, [name]: value }), assertCode('WEB_CONFIG_ERROR'));
  }
});

test('搜索发送 Bearer 和标准字段，映射摘要、来源、日期并按 URL 去重和截断', async (t) => {
  const received: Array<{ path: string | undefined; method: string | undefined; auth: string | undefined; body: unknown }> = [];
  const baseUrl = await service(t, (request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push({ path: request.url, method: request.method, auth: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
      json(response, {
        answer: '答'.repeat(8_001),
        results: [
          null, { url: 'javascript:private-url' }, { url: '' },
          { url: 'https://example.com/a', title: 'A', content: '😀'.repeat(4_001), published_date: '2026-10-23' },
          { url: 'https://example.com/a', title: 'Duplicate' },
          { url: 'https://example.com/b', title: '', content: null },
          { url: 'https://example.com/c' },
        ],
      });
    });
  });
  const result = await provider(`${baseUrl}/gateway`).search({ query: '  问题  ', maxResults: 2, topic: 'news', days: 7 }, new AbortController().signal);
  assert.deepEqual(received, [{
    path: '/gateway/search', method: 'POST', auth: 'Bearer test-private-api-key',
    body: { query: '问题', max_results: 2, search_depth: 'basic', include_answer: true, include_raw_content: false, include_images: false, topic: 'news', days: 7 },
  }]);
  assert.equal([...result.content!].length, 8_000);
  assert.deepEqual(result.sources, [
    { url: 'https://example.com/a', title: 'A', snippet: '😀'.repeat(4_000), publishedAt: '2026-10-23' },
    { url: 'https://example.com/b' },
  ]);
});

test('搜索没有可选摘要时返回空来源，沿用配置的默认结果数', async (t) => {
  const baseUrl = await service(t, (request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(body.max_results, 8);
      assert.equal(body.topic, undefined);
      assert.equal(body.days, undefined);
      assert.equal(body.api_key, undefined);
      json(response, { answer: null, results: [] });
    });
  });
  assert.deepEqual(await provider(baseUrl).search({ query: '问题' }, new AbortController().signal), { sources: [] });
});

test('抓取通过 extract 批量发送 URL，保留部分成功并脱敏失败原因', async (t) => {
  const baseUrl = await service(t, (request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      assert.equal(request.url, '/extract');
      assert.equal(request.headers.authorization, 'Bearer test-private-api-key');
      assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), {
        urls: ['https://example.com/a', 'https://example.com/b', 'https://example.com/c'], format: 'markdown',
      });
      json(response, {
        results: [null, { url: 'https://example.com/a', raw_content: '文'.repeat(20_001) }, { url: 'https://example.com/a', raw_content: 'Duplicate' }, { url: 'https://unrequested.example.com/', raw_content: 'Ignore' }],
        failed_results: [null, { url: 'https://example.com/b', error: 'private-upstream-body test-private-api-key' }],
      });
    });
  });
  assert.deepEqual(await provider(baseUrl).fetch({ urls: ['https://example.com/a', 'https://example.com/a', 'https://example.com/b', 'https://example.com/c'] }, new AbortController().signal), {
    sources: [{ url: 'https://example.com/a', content: '文'.repeat(20_000) }],
    failures: [
      { url: 'https://example.com/b', error: 'Failed to extract content' },
      { url: 'https://example.com/c', error: 'No extracted content returned' },
    ],
  });
});

test('直调搜索和抓取也校验参数，不发起无效请求', async () => {
  const p = provider('http://127.0.0.1:1');
  for (const request of [
    {}, { query: '' }, { query: ' \n ' }, { query: null },
    { query: 'ok', maxResults: 0 }, { query: 'ok', maxResults: 21 }, { query: 'ok', maxResults: 1.5 }, { query: 'ok', maxResults: null },
    { query: 'ok', topic: 'finance' }, { query: 'ok', topic: null },
    { query: 'ok', days: -1 }, { query: 'ok', days: 0.5 }, { query: 'ok', days: null }, { query: 'ok', days: Number.MAX_SAFE_INTEGER + 1 },
    { query: 'ok', days: 1 }, { query: 'ok', topic: 'general', days: 1 },
  ]) {
    await assert.rejects(p.search(request as never, new AbortController().signal), assertCode('WEB_INVALID_REQUEST'));
  }
  for (const urls of [[], Array(21).fill('https://example.com'), ['private-url'], ['file:///private-url'], ['ftp://example.com'], ['https://user:private-api-key@example.com'], [null], undefined]) {
    await assert.rejects(p.fetch({ urls } as never, new AbortController().signal), assertCode('WEB_INVALID_REQUEST'));
  }
});

test('HTTP 错误只返回状态码，不泄漏上游正文且不重试', async (t) => {
  let requests = 0;
  const baseUrl = await service(t, (_request, response) => {
    requests++;
    response.writeHead(429);
    response.end('private-upstream-body test-private-api-key');
  });
  await assert.rejects(provider(baseUrl).search({ query: 'private-query' }, new AbortController().signal), (error) => {
    assertCode('WEB_HTTP_ERROR')(error);
    assert.match((error as Error).message, /HTTP 429/);
    return true;
  });
  assert.equal(requests, 1);
});

test('拒绝 HTTP 重定向，不访问 Location 或向它发送凭据', async (t) => {
  let followed = 0;
  const target = await service(t, (_request, response) => { followed++; json(response, { results: [] }); });
  const baseUrl = await service(t, (_request, response) => { response.writeHead(307, { location: `${target}/private-url` }); response.end(); });
  await assert.rejects(provider(baseUrl).fetch({ urls: ['https://example.com/a'] }, new AbortController().signal), assertCode('WEB_HTTP_ERROR'));
  assert.equal(followed, 0);
});

test('超时覆盖响应头和响应体，取消不泄漏 AbortSignal 的原因', async (t) => {
  const baseUrl = await service(t, (request, response) => {
    if (request.url === '/slow-body/search') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"results":[');
    }
  });
  const signal = new AbortController().signal;
  await assert.rejects(provider(baseUrl, 30).search({ query: 'ok' }, signal), assertCode('WEB_TIMEOUT'));
  await assert.rejects(provider(`${baseUrl}/slow-body`, 30).search({ query: 'ok' }, signal), assertCode('WEB_TIMEOUT'));
  const controller = new AbortController();
  const pending = provider(baseUrl).search({ query: 'ok' }, controller.signal);
  controller.abort(new Error('secret-network-detail private-api-key'));
  await assert.rejects(pending, assertCode('WEB_ABORTED'));
  await assert.rejects(provider(baseUrl).search({ query: 'ok' }, controller.signal), assertCode('WEB_ABORTED'));
});

test('流式读取超过 4 MiB 失败，即使没有 Content-Length', async (t) => {
  const baseUrl = await service(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"answer":"');
    for (let index = 0; index < 65; index++) response.write('x'.repeat(64 * 1024));
    response.end('","results":[]}');
  });
  await assert.rejects(provider(baseUrl).search({ query: 'ok' }, new AbortController().signal), assertCode('WEB_RESPONSE_TOO_LARGE'));
});

test('坏 JSON、坏顶层和缺失结果数组均拒绝，错误不回显响应内容', async (t) => {
  const bodies = ['private-upstream-body', 'null', '[]', '{}', '{"results":{}}'];
  const baseUrl = await service(t, (_request, response) => response.end(bodies.shift()));
  const p = provider(baseUrl);
  for (let index = 0; index < 5; index++) {
    await assert.rejects(p.search({ query: 'ok' }, new AbortController().signal), assertCode('WEB_INVALID_RESPONSE'));
  }
});

test('网络异常不泄漏 URL、查询、密钥或底层错误详情', async (t) => {
  const baseUrl = await service(t, (request) => request.destroy(new Error('secret-network-detail')));
  await assert.rejects(provider(`${baseUrl}/private-url`).search({ query: 'private-query' }, new AbortController().signal), assertCode('WEB_REQUEST_FAILED'));
});
