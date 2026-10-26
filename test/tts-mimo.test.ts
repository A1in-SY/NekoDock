import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { test, type TestContext } from 'node:test';
import { isMp3Snapshot, MAX_VOICE_BYTES } from '../src/audio.js';
import { createLogger } from '../src/logging.js';
import { createSpeechProvider, loadTtsConfig, TtsError, type SpeechProvider, type TtsConfig } from '../src/tts.js';

const active = { TTS_PROVIDER: 'mimo', MIMO_TTS_API_KEY: 'private-key' };
const mp3 = Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0]);
const quiet = { info() {}, warn() {}, error() {} };
type MimoConfig = Extract<TtsConfig, { provider: 'mimo' }>;

function assertCode(code: string): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof TtsError);
    assert.equal(error.code, code);
    assert.doesNotMatch(error.message, /private-text|private-style|private-key|private-value|private-url|private-upstream/);
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

function provider(baseUrl: string, options: Partial<MimoConfig> = {}, lines?: string[]): SpeechProvider {
  const config = loadTtsConfig({ ...active, MIMO_TTS_BASE_URL: baseUrl });
  assert.equal(config.provider, 'mimo');
  const logger = lines ? createLogger({ now: () => new Date('2026-10-23T10:00:00.123Z'), write: (_, line) => lines.push(line) }) : quiet;
  const result = createSpeechProvider({ ...config, ...options } as MimoConfig, logger);
  assert.ok(result);
  assert.equal(result.name, 'mimo');
  return result;
}

function audioResponse(data: unknown = mp3.toString('base64')): object {
  return { choices: [{ finish_reason: 'stop', message: { audio: { data } } }] };
}

function json(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

test('MiMo 默认模型、预置声音和空风格，沿用通用资源限制', () => {
  assert.deepEqual(loadTtsConfig(active), {
    provider: 'mimo', apiKey: 'private-key', baseUrl: 'https://api.xiaomimimo.com/v1',
    model: 'mimo-v2.5-tts', voice: 'mimo_default', style: '',
    timeoutMs: 30_000, maxBytes: 5 * 1_024 * 1_024, maxChars: 300,
  });
  assert.deepEqual(loadTtsConfig({
    ...active, TTS_PROVIDER: ' mimo ', MIMO_TTS_API_KEY: ' private-key ',
    MIMO_TTS_BASE_URL: ' https://API.example.com:443/gateway/// ',
    MIMO_TTS_MODEL: ' mimo-v2.5-tts ', MIMO_TTS_VOICE: ' 冰糖 ', MIMO_TTS_STYLE: '  温柔可爱\n自然轻快  ',
    TTS_TIMEOUT_MS: '300000', TTS_MAX_BYTES: String(MAX_VOICE_BYTES), TTS_MAX_CHARS: '10000',
  }), {
    provider: 'mimo', apiKey: 'private-key', baseUrl: 'https://api.example.com/gateway',
    model: 'mimo-v2.5-tts', voice: '冰糖', style: '温柔可爱\n自然轻快',
    timeoutMs: 300_000, maxBytes: MAX_VOICE_BYTES, maxChars: 10_000,
  });
  for (const voice of ['mimo_default', '冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean']) {
    const config = loadTtsConfig({ ...active, MIMO_TTS_VOICE: voice });
    assert.equal(config.provider === 'mimo' && config.voice, voice);
  }
});

test('MiMo 风格按 Unicode 字符计数，清空或空白配置关闭额外风格', () => {
  const boundary = '🦭'.repeat(4_000);
  const config = loadTtsConfig({ ...active, MIMO_TTS_STYLE: boundary });
  assert.equal(config.provider === 'mimo' && config.style, boundary);
  assert.throws(() => loadTtsConfig({ ...active, MIMO_TTS_STYLE: boundary + '字' }), assertCode('TTS_CONFIG_ERROR'));
  for (const style of [undefined, '', ' \n\t ']) {
    const empty = loadTtsConfig({ ...active, MIMO_TTS_STYLE: style });
    assert.equal(empty.provider === 'mimo' && empty.style, '');
  }
});

test('无效 MiMo 密钥、端点、模型和声音拒绝启动且不回显配置值', () => {
  for (const apiKey of [undefined, '', '   ', 'private-key\n', '\rprivate-key', 'private-key\tvalue', 'private-key\0', 'private-keyé', 'private-key🦭']) {
    assert.throws(() => loadTtsConfig({ ...active, MIMO_TTS_API_KEY: apiKey }), assertCode('TTS_CONFIG_ERROR'));
  }
  for (const baseUrl of ['private-url', 'file:///private-url', 'ftp://example.com', 'https://user:private-key@example.com', 'https://example.com/?private-value', 'https://example.com/#private-value', 'https://example.com/?', 'https://example.com/#', 'https://example.com/private-\nurl']) {
    assert.throws(() => loadTtsConfig({ ...active, MIMO_TTS_BASE_URL: baseUrl }), assertCode('TTS_CONFIG_ERROR'));
  }
  for (const model of ['mimo-v2-tts', 'private-value']) {
    assert.throws(() => loadTtsConfig({ ...active, MIMO_TTS_MODEL: model }), assertCode('TTS_CONFIG_ERROR'));
  }
  for (const voice of ['bingtang', 'mia', 'private-value', '冰糖\nfoo']) {
    assert.throws(() => loadTtsConfig({ ...active, MIMO_TTS_VOICE: voice }), assertCode('TTS_CONFIG_ERROR'));
  }
  for (const [name, value] of [['TTS_TIMEOUT_MS', '300001'], ['TTS_MAX_BYTES', String(MAX_VOICE_BYTES + 1)], ['TTS_MAX_CHARS', '0']]) {
    assert.throws(() => loadTtsConfig({ ...active, [name!]: value }), assertCode('TTS_CONFIG_ERROR'));
  }
  for (const value of ['mimo,edge-tts', 'edge-tts,mimo', 'MIMO']) {
    assert.throws(() => loadTtsConfig({ ...active, TTS_PROVIDER: value }), assertCode('TTS_CONFIG_ERROR'));
  }
});

test('只验证被选中的语音供应商配置，MiMo 与 Edge 参数互不干扰', () => {
  const invalidMimo = {
    MIMO_TTS_API_KEY: 'private-key\r\n', MIMO_TTS_BASE_URL: 'private-url',
    MIMO_TTS_MODEL: 'private-value', MIMO_TTS_VOICE: 'private-value', MIMO_TTS_STYLE: 'x'.repeat(4_001),
  };
  assert.deepEqual(loadTtsConfig({ ...invalidMimo, TTS_PROVIDER: 'none' }), { provider: 'none' });
  assert.equal(loadTtsConfig({ ...invalidMimo, TTS_PROVIDER: 'edge-tts' }).provider, 'edge-tts');
  assert.equal(loadTtsConfig({
    ...active, EDGE_TTS_BIN: '\nprivate-path', EDGE_TTS_VOICE: 'private-value!',
    EDGE_TTS_RATE: 'bad', EDGE_TTS_VOLUME: 'bad', EDGE_TTS_PITCH: 'bad',
  }).provider, 'mimo');
});

test('MiMo 用 api-key 及 assistant 正文调用合成端点，不配置风格时省略 user 消息', async (t) => {
  const captured: unknown[] = [];
  const baseUrl = await service(t, (request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      captured.push({ path: request.url, method: request.method, key: request.headers['api-key'], authorization: request.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      json(response, audioResponse());
    });
  });
  const text = '  你好🦭 private-text\n下一行  ';
  const result = await provider(`${baseUrl}/v1`).synthesize(text, new AbortController().signal);
  assert.equal(isMp3Snapshot(result.file), true);
  assert.deepEqual(Buffer.from(result.file.slice(9), 'base64'), mp3);
  assert.deepEqual(captured, [{
    path: '/v1/chat/completions', method: 'POST', key: 'private-key', authorization: undefined,
    body: { model: 'mimo-v2.5-tts', messages: [{ role: 'assistant', content: text }],
      audio: { format: 'mp3', voice: 'mimo_default' }, stream: false },
  }]);
});

test('可配置风格作为独立 user 消息，冰糖音色与朗读正文保持原文', async (t) => {
  const captured: unknown[] = [];
  const baseUrl = await service(t, (request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      captured.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      json(response, audioResponse());
    });
  });
  const style = 'private-style\n声音清亮柔和，带一点甜感。';
  const text = 'private-text 你好呀，今天过得怎么样？';
  await provider(baseUrl, { style, voice: '冰糖' }).synthesize(text, new AbortController().signal);
  assert.deepEqual(captured, [{ model: 'mimo-v2.5-tts', messages: [
    { role: 'user', content: style }, { role: 'assistant', content: text },
  ], audio: { format: 'mp3', voice: '冰糖' }, stream: false }]);
});

test('MiMo 文本按 Unicode 字符限制，无效或超长输入不发请求', async (t) => {
  let requests = 0;
  const baseUrl = await service(t, (_, response) => { requests++; json(response, audioResponse()); });
  const speech = provider(baseUrl, { maxChars: 3 });
  await speech.synthesize('甲🦭乙', new AbortController().signal);
  for (const value of ['', ' \n\t ', null, 12]) {
    await assert.rejects(speech.synthesize(value as string, new AbortController().signal), assertCode('TTS_INVALID_REQUEST'));
  }
  await assert.rejects(speech.synthesize('甲🦭乙丙', new AbortController().signal), assertCode('TTS_TEXT_TOO_LONG'));
  assert.equal(requests, 1);
});

test('MiMo 日志使用东八区且只记录长度、字节、耗时，不泄露风格或返回正文', async (t) => {
  const baseUrl = await service(t, (_, response) => json(response, { ...audioResponse(), private: 'private-upstream' }));
  const lines: string[] = [];
  await provider(baseUrl, { style: 'private-style', voice: '冰糖' }, lines).synthesize('private-text', new AbortController().signal);
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /^2026-10-23T18:00:00\.123\+08:00 INFO tts\.synthesis\.started provider="mimo" text_chars=12$/);
  assert.match(lines[1]!, /tts\.synthesis\.completed.*bytes=8.*duration_ms=\d+/);
  assert.doesNotMatch(lines.join('\n'), /private-text|private-style|private-key|private-upstream|base64|127\.0\.0\.1/);
});

test('MiMo HTTP 失败只保留数字状态，不重试、不泄露响应体或凭据', async (t) => {
  let requests = 0;
  const baseUrl = await service(t, (_, response) => {
    requests++;
    response.writeHead(429);
    response.end('private-upstream private-key private-text private-style');
  });
  const lines: string[] = [];
  await assert.rejects(provider(baseUrl, { style: 'private-style' }, lines).synthesize('private-text', new AbortController().signal), (error) => {
    assertCode('TTS_HTTP_ERROR')(error);
    assert.equal((error as Error).message, 'MiMo request failed (HTTP 429)');
    return true;
  });
  assert.equal(requests, 1);
  assert.match(lines[1]!, /tts\.synthesis\.failed.*code="TTS_HTTP_ERROR"/);
  assert.doesNotMatch(lines.join('\n'), /private-text|private-style|private-key|private-upstream|127\.0\.0\.1/);
});

test('MiMo 不跟随重定向，避免将 api-key 转发到其他端点', async (t) => {
  let forwarded = 0;
  const target = await service(t, (_, response) => { forwarded++; json(response, audioResponse()); });
  const baseUrl = await service(t, (_, response) => {
    response.writeHead(307, { location: `${target}/private-url` });
    response.end();
  });
  await assert.rejects(provider(baseUrl).synthesize('private-text', new AbortController().signal), assertCode('TTS_HTTP_ERROR'));
  assert.equal(forwarded, 0);
});

test('MiMo 拒绝无效 JSON、缺失音频、未完成的合成及错误结构', async (t) => {
  const values = ['private-upstream', null, [], {}, { choices: [] }, { choices: [null] },
    { choices: [{ finish_reason: 'length', message: { audio: { data: mp3.toString('base64') } } }] },
    { choices: [{ finish_reason: null, message: { audio: { data: mp3.toString('base64') } } }] },
    { choices: [{ finish_reason: 'stop', message: { audio: null } }] }, audioResponse(null), audioResponse(123)];
  const baseUrl = await service(t, (_, response) => {
    const value = values.shift();
    if (value === 'private-upstream') { response.end(value); return; }
    json(response, value);
  });
  const speech = provider(baseUrl);
  while (values.length) await assert.rejects(speech.synthesize('private-text', new AbortController().signal), assertCode('TTS_INVALID_RESPONSE'));
});

test('MiMo 只接受规范 Base64 及有效 MP3，拒绝文本、WAV、ID3 标签和无效 MPEG 帧', async (t) => {
  const invalid = ['', '%%%%', mp3.toString('base64') + '\n', mp3.toString('base64').replace(/=$/u, ''), '/wB=',
    Buffer.from('private-text').toString('base64'), Buffer.from('RIFFabcWAVEdata').toString('base64'),
    Buffer.from('ID3private-text').toString('base64'), Buffer.from([0xff, 0xff, 0xff, 0xff, 0]).toString('base64')];
  const baseUrl = await service(t, (_, response) => json(response, audioResponse(invalid.shift())));
  const speech = provider(baseUrl);
  while (invalid.length) await assert.rejects(speech.synthesize('private-text', new AbortController().signal), assertCode('TTS_INVALID_AUDIO'));
});

test('MiMo Base64 解码前后均限制音频大小，恰好上限可以发送', async (t) => {
  const baseUrl = await service(t, (_, response) => json(response, audioResponse()));
  await provider(baseUrl, { maxBytes: mp3.length }).synthesize('private-text', new AbortController().signal);
  // Seven and eight bytes have the same Base64 length, so decoded size must also be checked.
  await assert.rejects(provider(baseUrl, { maxBytes: mp3.length - 1 }).synthesize('private-text', new AbortController().signal), assertCode('TTS_AUDIO_TOO_LARGE'));
  await assert.rejects(provider(baseUrl, { maxBytes: 3 }).synthesize('private-text', new AbortController().signal), assertCode('TTS_AUDIO_TOO_LARGE'));
});

test('MiMo 响应体受流式字节上限约束，超限主动取消下载', async (t) => {
  let closed!: () => void;
  const disconnected = new Promise<void>((resolve) => { closed = resolve; });
  const baseUrl = await service(t, (_, response) => {
    response.on('close', closed);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"private-upstream":"' + 'x'.repeat(70 * 1_024));
  });
  await assert.rejects(provider(baseUrl, { maxBytes: 8 }).synthesize('private-text', new AbortController().signal), assertCode('TTS_RESPONSE_TOO_LARGE'));
  await disconnected;
});

test('MiMo 超时覆盖响应头等待和响应体读取，取消下载后返回固定错误', async (t) => {
  let mode: 'headers' | 'body' = 'headers';
  const baseUrl = await service(t, (_, response) => {
    if (mode === 'body') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"choices":');
    }
  });
  const speech = provider(baseUrl, { timeoutMs: 50 });
  await assert.rejects(speech.synthesize('private-text', new AbortController().signal), assertCode('TTS_TIMEOUT'));
  mode = 'body';
  await assert.rejects(speech.synthesize('private-text', new AbortController().signal), assertCode('TTS_TIMEOUT'));
});

test('MiMo 支持预先取消与请求中取消，调用者取消优先且不泄露取消原因', async (t) => {
  let requests = 0;
  let requested!: () => void;
  const ready = new Promise<void>((resolve) => { requested = resolve; });
  const baseUrl = await service(t, (_, response) => {
    requests++;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"choices":');
    requested();
  });
  const preAborted = new AbortController();
  preAborted.abort(new Error('private-key private-style'));
  await assert.rejects(provider(baseUrl).synthesize('private-text', preAborted.signal), assertCode('TTS_ABORTED'));
  assert.equal(requests, 0);
  const controller = new AbortController();
  const promise = provider(baseUrl).synthesize('private-text', controller.signal);
  const rejection = assert.rejects(promise, assertCode('TTS_ABORTED'));
  await ready;
  controller.abort(new Error('private-key private-style'));
  await rejection;
  assert.equal(requests, 1);
});

test('MiMo 网络失败返回静态错误，不保留网络原因或服务器地址', async () => {
  await assert.rejects(provider('http://127.0.0.1:1/private-url').synthesize('private-text', new AbortController().signal), assertCode('TTS_REQUEST_FAILED'));
});
