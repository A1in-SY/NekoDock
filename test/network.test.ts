import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { promisify } from 'node:util';
import { test, type TestContext } from 'node:test';
import {
  createNetworkClient, defaultNetworkProxy, directFetch, loadNetworkProxyConfig, NetworkError,
  normalizeNetworkProxy, playwrightProxy, proxyEnvironment, proxySecrets, proxyUrlWithCredentials, routeNetworkUrl,
  type NetworkProxyConfig,
} from '../src/network.js';
import { createLogger } from '../src/logging.js';

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

async function service(t: TestContext, handler: Handler) {
  const server = createServer(handler);
  const sockets = new Set<Socket>();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  return { server, url: `http://127.0.0.1:${address.port}` };
}

function config(url: string, extra: Partial<NetworkProxyConfig> = {}): NetworkProxyConfig {
  return normalizeNetworkProxy({ ...defaultNetworkProxy(), enabled: true, url, noProxy: '', ...extra });
}

function code(expected: string) {
  return (error: unknown) => {
    assert.ok(error instanceof NetworkError); assert.equal(error.code, expected); assert.equal(error.cause, undefined);
    return true;
  };
}

test('proxy configuration defaults to direct and validates endpoints without echoing input', () => {
  assert.deepEqual(loadNetworkProxyConfig({}), defaultNetworkProxy());
  assert.equal(normalizeNetworkProxy({ url: ' HTTPS://EXAMPLE.com:443/ ' }).url, 'https://example.com');
  for (const url of ['bad-private-endpoint', 'socks5://example.com:1080', 'http://user:private-password@example.com',
    'https://example.com/path', 'http://example.com/?', 'https://example.com/#', 'http://exam\nple.com', 'http:example.com', 'http://@example.com']) {
    assert.throws(() => normalizeNetworkProxy({ enabled: false, url }), error => {
      assert.ok(error instanceof NetworkError); assert.equal(error.code, 'NETWORK_PROXY_CONFIG_ERROR');
      assert.doesNotMatch(error.message, /private|example|user/); return true;
    });
  }
  assert.throws(() => normalizeNetworkProxy({ enabled: true }), code('NETWORK_PROXY_CONFIG_ERROR'));
  assert.throws(() => normalizeNetworkProxy({ password: 'password-only' }), code('NETWORK_PROXY_CONFIG_ERROR'));
  assert.throws(() => normalizeNetworkProxy({ username: 'user:name' }), code('NETWORK_PROXY_CONFIG_ERROR'));
  assert.throws(() => loadNetworkProxyConfig({ NETWORK_PROXY_FOR_TOOLS: '1' }), code('NETWORK_PROXY_CONFIG_ERROR'));
  assert.equal(normalizeNetworkProxy({ username: '', password: '' }).username, undefined);
});

test('bypass matches domains, boundaries, ports, IPv4 and canonical IPv6 without resolving DNS', () => {
  const proxy = config('http://proxy.example:7890', { noProxy: '.EXAMPLE.com, 127.0.0.1\n[0:0:0:0:0:0:0:1]:8080 *.internal.example:443' });
  assert.equal(proxy.noProxy, 'example.com,127.0.0.1,[::1]:8080,internal.example:443');
  for (const url of ['https://example.com', 'https://sub.example.com', 'https://sub.example.com.',
    'http://127.0.0.1:1234', 'http://[::1]:8080', 'wss://nested.internal.example/']) {
    assert.deepEqual(routeNetworkUrl(proxy, url), { mode: 'direct', reason: 'bypass' }, url);
  }
  for (const url of ['https://badexample.com', 'http://[::1]:8081', 'http://internal.example', 'https://127.0.0.2']) {
    assert.equal(routeNetworkUrl(proxy, url).mode, 'proxy', url);
  }
  assert.equal(routeNetworkUrl(config('http://proxy.example', { noProxy: '*' }), 'https://any.example').mode, 'direct');
  for (const noProxy of ['https://example.com', 'example.com:0', '[::1]:65536', '*.']) {
    assert.throws(() => normalizeNetworkProxy({ noProxy }), code('NETWORK_PROXY_CONFIG_ERROR'));
  }
});

test('CIDR bypass matches only IP literals within IPv4 and IPv6 subnet boundaries', () => {
  const proxy = config('http://proxy.example', { noProxy: '10.20.0.0/22,2001:0DB8:0042:0000::/64,10.20.0.0/22' });
  assert.equal(proxy.noProxy, '10.20.0.0/22,2001:db8:42::/64');
  for (const url of ['http://10.20.0.0', 'https://10.20.0.8:8443', 'http://10.20.3.255',
    'http://[2001:db8:42::]', 'https://[2001:db8:42::1]', 'http://[2001:db8:42:0:ffff:ffff:ffff:ffff]']) {
    assert.deepEqual(routeNetworkUrl(proxy, url), { mode: 'direct', reason: 'bypass' }, url);
  }
  for (const url of ['http://10.19.255.255', 'http://10.20.4.0', 'http://[2001:db8:41:ffff:ffff:ffff:ffff:ffff]',
    'http://[2001:db8:42:1::]', 'http://[::ffff:10.20.0.8]', 'http://localhost', 'http://internal.example']) {
    assert.equal(routeNetworkUrl(proxy, url).mode, 'proxy', url);
  }
  const exact = config('http://proxy.example', { noProxy: '192.0.2.1/32,2001:db8::1/128' });
  assert.equal(routeNetworkUrl(exact, 'http://192.0.2.1').mode, 'direct');
  assert.equal(routeNetworkUrl(exact, 'http://192.0.2.2').mode, 'proxy');
  assert.equal(routeNetworkUrl(exact, 'http://[2001:db8::1]').mode, 'direct');
  assert.equal(routeNetworkUrl(exact, 'http://[2001:db8::2]').mode, 'proxy');
  const allIPs = config('http://proxy.example', { noProxy: '0.0.0.0/0,::/0' });
  assert.equal(routeNetworkUrl(allIPs, 'https://192.0.2.8').mode, 'direct');
  assert.equal(routeNetworkUrl(allIPs, 'https://[2001:db8::8]').mode, 'direct');
  assert.equal(routeNetworkUrl(allIPs, 'https://internal.example').mode, 'proxy');
});

test('CIDR bypass rejects invalid prefixes, non-IP networks and port suffixes', () => {
  for (const noProxy of ['10.20.0.0/', '10.20.0.0/33', '10.20.0.0/-1', '10.20.0.0/+1', '10.20.0.0/1.5',
    '10.20.0.0/08', '10.20.0.0/8/1', '2001:db8::/129', 'internal.example/24', '10.20.0.0/22:8080',
    '10.20.0.0:8080/22', '[2001:db8::]/64', '[2001:db8::]/64:8080', '2001:db8::/64:8080', 'fe80::1%eth0/64']) {
    assert.throws(() => normalizeNetworkProxy({ noProxy }), code('NETWORK_PROXY_CONFIG_ERROR'), noProxy);
  }
});

test('tool proxy settings preserve CIDR entries without domain wildcard expansion', () => {
  const proxy = config('http://proxy.example', { noProxy: '10.20.0.0/16,2001:db8::/32,internal.example,[::1]:8080' });
  const env = proxyEnvironment(proxy, {}, true);
  assert.equal(env.NO_PROXY, '10.20.0.0/16,2001:db8::/32,internal.example,.internal.example,[::1]:8080');
  assert.equal(env.no_proxy, env.NO_PROXY);
  assert.equal(playwrightProxy(proxy)?.bypass, '10.20.0.0/16,2001:db8::/32,internal.example,*.internal.example,[::1]:8080');
  assert.deepEqual(JSON.parse(env.NEKODOCK_PLAYWRIGHT_PROXY!), playwrightProxy(proxy));
});

test('CIDR bypass sends local HTTP requests directly and keeps unrelated requests on the proxy', async t => {
  let directCount = 0; const proxied: string[] = [];
  const target = await service(t, (request, response) => {
    directCount++; assert.equal(request.headers['proxy-authorization'], undefined); response.end('direct');
  });
  const proxy = await service(t, (request, response) => { proxied.push(request.url!); response.end('proxy'); });
  const client = createNetworkClient(config(proxy.url, { noProxy: '127.0.0.0/8', username: 'user', password: 'password' }));
  t.after(() => client.close());
  assert.equal(await (await client.fetch(target.url)).text(), 'direct');
  assert.equal(await (await client.fetch('http://192.0.2.1/outside')).text(), 'proxy');
  assert.equal(directCount, 1); assert.deepEqual(proxied, ['http://192.0.2.1/outside']);
});

test('proxy environment removes ambient settings and preserves exact credentials with percent escapes', () => {
  const proxy = config('https://proxy.example:8443', { username: 'proxy%40user', password: 'pass%25:@/中文', noProxy: 'local.example' });
  const source = { PATH: '/test/path', HTTP_PROXY: 'http://ambient.example', hTtPs_PrOxY: 'http://ambient.example',
    ALL_PROXY: 'socks5://ambient.example', NO_PROXY: '*', NODE_USE_ENV_PROXY: '1', GLOBAL_AGENT_HTTP_PROXY: 'http://ambient.example', NEKODOCK_PLAYWRIGHT_PROXY: 'private-ambient-settings',
    npm_config_noproxy: '', npm_config_proxy: 'http://ambient.example', NPM_CONFIG_HTTP_PROXY: 'http://ambient.example',
    npm_config_https_proxy: 'http://ambient.example', npm_config_no_proxy: '*' };
  const env = proxyEnvironment(proxy, source, true);
  const url = new URL(env.HTTPS_PROXY!);
  assert.equal(decodeURIComponent(url.username), proxy.username); assert.equal(decodeURIComponent(url.password), proxy.password);
  assert.equal(env.HTTP_PROXY, env.http_proxy); assert.equal(env.WSS_PROXY, env.HTTPS_PROXY);
  assert.equal(env.NO_PROXY, 'local.example,.local.example'); assert.equal(env.NODE_USE_ENV_PROXY, '1'); assert.equal(env.PATH, '/test/path');
  assert.deepEqual(JSON.parse(env.NEKODOCK_PLAYWRIGHT_PROXY!), playwrightProxy(proxy));
  assert.equal(new URL(proxyUrlWithCredentials(proxy)).password, url.password);
  assert.deepEqual(proxyEnvironment(defaultNetworkProxy(), source), { PATH: '/test/path' });
  assert.deepEqual(proxyEnvironment({ ...proxy, forTools: false }, source, true), { PATH: '/test/path' });
  assert.ok(proxyEnvironment({ ...proxy, forTools: false }, {}, false).HTTPS_PROXY);
  assert.deepEqual(playwrightProxy(proxy), { server: 'https://proxy.example:8443', username: proxy.username, password: proxy.password, bypass: 'local.example,*.local.example' });
  assert.equal(playwrightProxy({ ...proxy, forTools: false }), undefined);
});

test('instance proxies use independent pools and Basic credentials never reach a direct target', async t => {
  const seen: Array<{ proxy: string; path?: string; auth?: string }> = [];
  const first = await service(t, (request, response) => { seen.push({ proxy: 'first', path: request.url, auth: request.headers['proxy-authorization'] }); response.end('first'); });
  const second = await service(t, (request, response) => { seen.push({ proxy: 'second', path: request.url, auth: request.headers['proxy-authorization'] }); response.end('second'); });
  const target = await service(t, (request, response) => { assert.equal(request.headers['proxy-authorization'], undefined); response.end('direct'); });
  const one = createNetworkClient(config(first.url, { username: 'proxy-user', password: 'proxy-secret', noProxy: '127.0.0.1' }));
  const two = createNetworkClient(config(second.url));
  t.after(() => one.close()); t.after(() => two.close());
  const responses = await Promise.all([one.fetch('http://target.invalid/one'), two.fetch('http://target.invalid/two'), one.fetch(target.url), directFetch(target.url)]);
  assert.deepEqual(await Promise.all(responses.map(response => response.text())), ['first', 'second', 'direct', 'direct']);
  assert.deepEqual(seen, [
    { proxy: 'first', path: 'http://target.invalid/one', auth: `Basic ${Buffer.from('proxy-user:proxy-secret').toString('base64')}` },
    { proxy: 'second', path: 'http://target.invalid/two', auth: undefined },
  ]);
});

test('redirects re-evaluate bypass instead of retaining the initial request route', async t => {
  let directCount = 0; const paths: string[] = [];
  const direct = await service(t, (request, response) => {
    directCount++; assert.equal(request.headers['proxy-authorization'], undefined);
    if (request.url === '/redirect') { response.writeHead(302, { location: 'http://target.invalid/final' }); response.end(); }
    else response.end('direct-destination');
  });
  const proxy = await service(t, (request, response) => {
    paths.push(request.url!);
    if (request.url === 'http://target.invalid/redirect') { response.writeHead(302, { location: `${direct.url}/final` }); response.end(); }
    else response.end('proxy-destination');
  });
  const client = createNetworkClient(config(proxy.url, { noProxy: '127.0.0.1', username: 'user', password: 'password' })); t.after(() => client.close());
  assert.equal(await (await client.fetch('http://target.invalid/redirect')).text(), 'direct-destination');
  assert.equal(await (await client.fetch(`${direct.url}/redirect`)).text(), 'proxy-destination');
  assert.equal(directCount, 2); assert.deepEqual(paths, ['http://target.invalid/redirect', 'http://target.invalid/final']);
});

test('native Request objects from SDKs preserve method, headers, body and cancellation', async t => {
  const proxy = await service(t, async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    response.end(JSON.stringify({ method: request.method, header: request.headers['x-test'], body: Buffer.concat(chunks).toString() }));
  });
  const client = createNetworkClient(config(proxy.url)); t.after(() => client.close());
  const request = new Request('http://target.invalid/native', { method: 'POST', headers: { 'x-test': 'sdk' }, body: 'native-body' });
  assert.deepEqual(await (await client.fetch(request)).json(), { method: 'POST', header: 'sdk', body: 'native-body' });
  const local = new Request(proxy.url, { method: 'POST', headers: { 'x-test': 'direct' }, body: 'direct-body' });
  assert.deepEqual(await (await directFetch(local)).json(), { method: 'POST', header: 'direct', body: 'direct-body' });
});

test('control-plane direct fetch ignores process proxy defaults while Node tools inherit instance policy', async t => {
  let proxyCount = 0; let targetCount = 0;
  const target = await service(t, (_request, response) => { targetCount++; response.end('direct-target'); });
  const proxy = await service(t, (_request, response) => { proxyCount++; response.end('proxy-target'); });
  proxy.server.on('connect', (_request, socket) => {
    proxyCount++;
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.once('data', () => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 12\r\nConnection: close\r\n\r\nproxy-target'));
  });
  const execute = promisify(execFile);
  const module = new URL('../src/network.js', import.meta.url).href;
  const env = proxyEnvironment(config(proxy.url, { noProxy: '' }), {}, true);
  const control = await execute(process.execPath, ['--input-type=module', '-e', `
    import { directFetch, createNetworkClient } from ${JSON.stringify(module)};
    const client=createNetworkClient();
    console.log(await(await directFetch(${JSON.stringify(target.url)})).text());
    console.log(await(await client.fetch(${JSON.stringify(target.url)})).text());
    await client.close();
  `], { env, timeout: 5000 });
  assert.equal(control.stdout.trim(), 'direct-target\ndirect-target');
  const inherited = await execute(process.execPath, ['--input-type=module', '-e', `
    console.log(await(await fetch(${JSON.stringify(target.url)})).text());
  `], { env, timeout: 5000 });
  assert.equal(inherited.stdout.trim(), 'proxy-target');
  const bypassEnv = proxyEnvironment(config(proxy.url, { noProxy: 'local.example' }), {}, true);
  const port = new URL(target.url).port;
  const bypass = await execute(process.execPath, ['--input-type=module', '-e', `
    import http from 'node:http';
    const lookup=(_host,options,callback)=>options.all?callback(null,[{address:'127.0.0.1',family:4}]):callback(null,'127.0.0.1',4);
    for(const hostname of ['local.example','sub.local.example']){
      const result=await new Promise((resolve,reject)=>http.get({hostname,port:${port},lookup},r=>{
        let body='';r.on('data',c=>body+=c);r.on('end',()=>resolve(body));
      }).on('error',reject));console.log(result);
    }
  `], { env: bypassEnv, timeout: 5000 });
  assert.equal(bypass.stdout.trim(), 'direct-target\ndirect-target');
  assert.equal(targetCount, 4); assert.equal(proxyCount, 1);
});

test('proxy authentication failures do not fall back to a reachable direct endpoint', async t => {
  let directCount = 0;
  const direct = await service(t, (_request, response) => { directCount++; response.end('should-not-be-sent'); });
  const proxy = await service(t, (_request, response) => { response.writeHead(407, { 'proxy-authenticate': 'Basic realm="test"' }); response.end('private-proxy-error'); });
  proxy.server.on('connect', (_request, socket) => { socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n'); });
  const client = createNetworkClient(config(proxy.url)); t.after(() => client.close());
  await assert.rejects(client.fetch(direct.url), code('NETWORK_PROXY_AUTH_FAILED'));
  await assert.rejects(client.fetch('https://target.invalid'), code('NETWORK_PROXY_AUTH_FAILED'));
  assert.equal(directCount, 0);
});

test('proxy connection, target CONNECT and TLS failures have distinct safe diagnostic codes', async t => {
  const unreachable = await service(t, (_request, response) => response.end('unused'));
  await new Promise<void>(resolve => unreachable.server.close(() => resolve()));
  const dead = createNetworkClient(config(unreachable.url)); t.after(() => dead.close());
  await assert.rejects(dead.fetch('http://target.invalid'), code('NETWORK_PROXY_UNREACHABLE'));
  const rejected = await service(t, (_request, response) => response.end('unused'));
  rejected.server.on('connect', (_request, socket) => socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n'));
  const reject = createNetworkClient(config(rejected.url)); t.after(() => reject.close());
  await assert.rejects(reject.fetch('https://target.invalid'), code('NETWORK_TARGET_UNREACHABLE'));
  const tls = createNetworkClient(config(rejected.url.replace('http:', 'https:'))); t.after(() => tls.close());
  await assert.rejects(tls.fetch('https://target.invalid'), code('NETWORK_TLS_FAILED'));
});

test('proxy transport preserves large request bodies and chunked SSE responses', async t => {
  let receivedBytes = 0;
  const proxy = await service(t, (request, response) => {
    request.on('data', (chunk: Buffer) => { receivedBytes += chunk.length; });
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: first\n\n');
      setTimeout(() => response.end('data: second\n\n'), 30);
    });
  });
  const client = createNetworkClient(config(proxy.url)); t.after(() => client.close());
  const response = await client.fetch('http://target.invalid/stream', { method: 'POST', body: 'x'.repeat(8_750_000), signal: AbortSignal.timeout(5000) });
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const reader = response.body!.getReader(); const chunks: Buffer[] = [];
  while (true) { const next = await reader.read(); if (next.done) break; chunks.push(Buffer.from(next.value)); }
  assert.equal(Buffer.concat(chunks).toString(), 'data: first\n\ndata: second\n\n'); assert.equal(receivedBytes, 8_750_000);
});

test('abort and timeout interrupt an in-flight proxy request without exposing upstream errors', async t => {
  const proxy = await service(t, (_request, _response) => {});
  const client = createNetworkClient(config(proxy.url)); t.after(() => client.close());
  await assert.rejects(client.fetch('http://target.invalid/timeout', { signal: AbortSignal.timeout(50) }), code('NETWORK_TIMEOUT'));
  const abort = new AbortController(); const flight = client.fetch('http://target.invalid/abort', { signal: abort.signal });
  setTimeout(() => abort.abort(new Error('private-abort-detail')), 30);
  await assert.rejects(flight, code('NETWORK_REQUEST_ABORTED'));
});

test('stream cancellation and client close release pending network operations', async t => {
  const proxy = await service(t, (_request, response) => { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write('data: open\n\n'); });
  const client = createNetworkClient(config(proxy.url)); t.after(() => client.close());
  const abort = new AbortController(); const response = await client.fetch('http://target.invalid/stream', { signal: abort.signal });
  const reader = response.body!.getReader(); await reader.read();
  const pending = reader.read(); abort.abort(); await assert.rejects(pending);
  await client.close(); await assert.rejects(client.fetch('http://target.invalid/closed'), code('NETWORK_CLIENT_CLOSED'));
});

test('network logs contain only routing metadata and all credential representations are redacted', async t => {
  const proxy = await service(t, (_request, response) => response.end('ok'));
  const settings = config(proxy.url, { username: 'proxy%40user', password: 'secret:@/中文', noProxy: '' });
  const lines: string[] = [];
  const logger = createLogger({ secrets: proxySecrets(settings), write: (_level, line) => lines.push(line) });
  const client = createNetworkClient(settings, logger, 'image'); t.after(() => client.close());
  assert.equal(await (await client.fetch('http://private-target.invalid/private-path?private-query')).text(), 'ok');
  for (const secret of proxySecrets(settings)) { logger.warn(secret); }
  const output = lines.join('\n');
  assert.match(output, /category="image"/u); assert.match(output, /mode="proxy"/u);
  assert.doesNotMatch(output, /private-target|private-path|private-query|proxy%40user|secret:|%E4%B8%AD|Basic /u);
});
