import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { prepareImageReply, prepareIncomingImages } from '../src/images.js';
import { createNetworkClient, defaultNetworkProxy, proxyUrlWithCredentials, type NetworkProxyConfig } from '../src/network.js';
import { createLogger } from '../src/logging.js';
import { createSpeechProvider, loadTtsConfig, TtsError } from '../src/tts.js';
import type { StoredMessage } from '../src/types.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ioAAAAASUVORK5CYII=', 'base64');
const mp3 = Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0]);
const quiet = { info() {}, warn() {}, error() {} };

async function directory(t: TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'nekodock-proxy-media-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function listen(t: TestContext, server: Server): Promise<number> {
  const sockets = new Set<Socket>();
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { for (const socket of sockets) socket.destroy(); return new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return address.port;
}

test('incoming/outgoing images and MiMo route through the supplied instance client', async t => {
  const workspace = await directory(t);
  const originCalls: string[] = [];
  const origin = createServer((request, response) => {
    originCalls.push(request.url!);
    request.resume();
    if (request.url === '/v1/chat/completions') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { audio: { data: mp3.toString('base64') } } }] }));
    } else response.end(png);
  });
  const originPort = await listen(t, origin);
  const authorizations: string[] = [];
  const proxy = createServer((request, response) => {
    authorizations.push(String(request.headers['proxy-authorization']));
    const target = new URL(request.url!);
    const forwarded = httpRequest({ host: '127.0.0.1', port: originPort, method: request.method,
      path: target.pathname, headers: { 'content-type': request.headers['content-type'] ?? 'application/octet-stream' } }, upstream => {
      response.writeHead(upstream.statusCode ?? 502, upstream.headers); upstream.pipe(response);
    });
    forwarded.on('error', () => response.destroy()); request.pipe(forwarded);
  });
  proxy.on('connect', (request, socket, head) => {
    authorizations.push(String(request.headers['proxy-authorization']));
    const upstream = connect(originPort, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(socket); socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
  });
  const proxyPort = await listen(t, proxy);
  const client = createNetworkClient({ ...defaultNetworkProxy(), enabled: true, noProxy: '',
    url: `http://127.0.0.1:${proxyPort}`, username: 'fixture-user', password: 'fixture-password' });
  t.after(() => client.close());
  const remote = `http://media.invalid:${originPort}`;
  const options = { workspace, maxBytes: 1024, timeoutMs: 2000, fetch: client.fetch };
  const message: StoredMessage = { seq: 1, messageId: '1', senderId: '100', senderName: 'Example', time: 0,
    text: '[image]', replyTo: null, trigger: true, rawJson: JSON.stringify({ message: [{ type: 'image', data: { url: `${remote}/incoming.png` } }] }) };
  const incoming = await prepareIncomingImages([message], options, new AbortController().signal);
  assert.equal(incoming.files.length, 1);
  assert.deepEqual(await readFile(incoming.files[0]!), png);
  const outgoing = await prepareImageReply(`${remote}/outgoing.png`, options, new AbortController().signal);
  assert.equal(outgoing.file, `base64://${png.toString('base64')}`);
  const speech = createSpeechProvider(loadTtsConfig({ TTS_PROVIDER: 'mimo', MIMO_TTS_API_KEY: 'synthetic-key', MIMO_TTS_BASE_URL: `${remote}/v1` }), quiet, { fetch: client.fetch })!;
  assert.equal((await speech.synthesize('Example speech', new AbortController().signal)).file, `base64://${mp3.toString('base64')}`);
  assert.deepEqual(originCalls, ['/incoming.png', '/outgoing.png', '/v1/chat/completions']);
  assert.ok(authorizations.length > 0);
  assert.ok(authorizations.every(value => value === `Basic ${Buffer.from('fixture-user:fixture-password').toString('base64')}`));
});

test('media proxy rejection is sanitized and never falls back to the origin', async t => {
  const workspace = await directory(t);
  let originRequests = 0;
  const originPort = await listen(t, createServer((_request, response) => { originRequests++; response.end(png); }));
  let proxyRequests = 0;
  const proxy = createServer((_request, response) => { proxyRequests++; response.writeHead(407); response.end(); });
  proxy.on('connect', (_request, socket) => { proxyRequests++; socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n'); });
  const proxyPort = await listen(t, proxy);
  const client = createNetworkClient({ ...defaultNetworkProxy(), enabled: true, noProxy: '', url: `http://127.0.0.1:${proxyPort}` });
  t.after(() => client.close());
  await assert.rejects(prepareImageReply(`http://127.0.0.1:${originPort}/image.png`, {
    workspace, maxBytes: 1024, timeoutMs: 2000, fetch: client.fetch,
  }, new AbortController().signal), /图片读取失败/u);
  const speech = createSpeechProvider(loadTtsConfig({ TTS_PROVIDER: 'mimo', MIMO_TTS_API_KEY: 'synthetic-key', MIMO_TTS_BASE_URL: `http://127.0.0.1:${originPort}/v1` }), quiet, { fetch: client.fetch })!;
  await assert.rejects(speech.synthesize('Example speech', new AbortController().signal), error => error instanceof TtsError && error.code === 'TTS_REQUEST_FAILED');
  assert.equal(originRequests, 0);
  assert.equal(proxyRequests, 2);
});

async function pythonEdge(t: TestContext): Promise<{ bin: string; captured(): Promise<Record<string, unknown>> }> {
  const path = await directory(t);
  const bin = join(path, 'edge-tts');
  const capture = join(path, 'capture.json');
  await writeFile(bin, '#!/usr/bin/env python3\nraise RuntimeError("CLI must not be used with an explicit proxy")\n', { mode: 0o700 });
  await writeFile(join(path, 'edge_tts.py'), `import json, os, sys
class Communicate:
    def __init__(self, text, voice, **options):
        with open(${JSON.stringify(capture)}, 'w', encoding='utf-8') as output:
            json.dump({'text': text, 'voice': voice, 'options': options, 'argv': sys.argv,
                       'proxy_env': {key: value for key, value in os.environ.items() if key.lower() in ('http_proxy','https_proxy','ws_proxy','wss_proxy','all_proxy','no_proxy')}}, output)
    async def stream(self):
        yield {'type': 'audio', 'data': bytes(${JSON.stringify([...mp3])})}
`);
  const beforePath = process.env.PYTHONPATH;
  process.env.PYTHONPATH = path;
  t.after(() => { if (beforePath === undefined) delete process.env.PYTHONPATH; else process.env.PYTHONPATH = beforePath; });
  return { bin, captured: async () => JSON.parse(await readFile(capture, 'utf8')) as Record<string, unknown> };
}

test('Edge proxy credentials travel through a pipe and WSS uses the instance bypass decision', async t => {
  const fixture = await pythonEdge(t);
  const lines: string[] = [];
  const proxy: NetworkProxyConfig = { ...defaultNetworkProxy(), enabled: true, url: 'https://proxy.example:8443', noProxy: '', username: 'fixture-user', password: 'fixture-p@ss%20word' };
  const config = loadTtsConfig({ TTS_PROVIDER: 'edge-tts', EDGE_TTS_BIN: fixture.bin });
  const logger = createLogger({ write: (_level, line) => lines.push(line) });
  const speech = createSpeechProvider(config, logger, { networkProxy: proxy })!;
  assert.equal((await speech.synthesize('Example speech', new AbortController().signal)).file, `base64://${mp3.toString('base64')}`);
  const capture = await fixture.captured();
  assert.equal(capture.text, 'Example speech');
  assert.deepEqual(capture.options, { rate: '+0%', volume: '+0%', pitch: '+0Hz', proxy: proxyUrlWithCredentials(proxy) });
  assert.deepEqual(capture.proxy_env, {});
  assert.equal(JSON.stringify(capture.argv).includes('fixture-user'), false);
  assert.equal(JSON.stringify(capture.argv).includes('fixture-p'), false);
  assert.equal(JSON.stringify(capture.argv).includes('Example speech'), false);
  assert.doesNotMatch(lines.join('\n'), /fixture-user|fixture-p|proxy\.example/u);
  const bypass = createSpeechProvider(config, quiet, { networkProxy: { ...proxy, noProxy: 'speech.platform.bing.com:443' } })!;
  await bypass.synthesize('Example bypass', new AbortController().signal);
  assert.equal(((await fixture.captured()).options as Record<string, unknown>).proxy, null);
});

test('disabled Edge proxy removes inherited proxy environment variables', async t => {
  const path = await directory(t);
  const bin = join(path, 'mock-edge.mjs');
  const capture = join(path, 'capture.json');
  await writeFile(bin, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';process.stdin.resume();writeFileSync(${JSON.stringify(capture)}, JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([key])=>/proxy/i.test(key)))));process.stdout.write(Buffer.from(${JSON.stringify([...mp3])}));\n`);
  await chmod(bin, 0o700);
  const before = process.env.HTTPS_PROXY;
  process.env.HTTPS_PROXY = 'http://ambient.example:8080';
  t.after(() => { if (before === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = before; });
  const config = loadTtsConfig({ TTS_PROVIDER: 'edge-tts', EDGE_TTS_BIN: bin });
  await createSpeechProvider(config, quiet, { networkProxy: defaultNetworkProxy() })!.synthesize('Example', new AbortController().signal);
  assert.deepEqual(JSON.parse(await readFile(capture, 'utf8')), {});
});

test('unsupported custom Edge executable fails before starting when an explicit proxy is required', async t => {
  const path = await directory(t);
  const bin = join(path, 'custom-edge.mjs');
  const marker = join(path, 'started');
  await writeFile(bin, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)}, 'started');\n`, { mode: 0o700 });
  const config = loadTtsConfig({ TTS_PROVIDER: 'edge-tts', EDGE_TTS_BIN: bin });
  const speech = createSpeechProvider(config, quiet, {
    networkProxy: { ...defaultNetworkProxy(), enabled: true, url: 'http://proxy.example:8080' },
  })!;
  await assert.rejects(speech.synthesize('Example', new AbortController().signal), error =>
    error instanceof TtsError && error.code === 'TTS_PROXY_UNSUPPORTED');
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});
