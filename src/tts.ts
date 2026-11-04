import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, open, realpath } from 'node:fs/promises';
import { basename, delimiter, isAbsolute, resolve } from 'node:path';
import { defaultNetworkProxy, proxyEnvironment, proxyUrlWithCredentials, routeNetworkUrl, type NetworkProxyConfig } from './network.js';
import { isMp3, MAX_VOICE_BYTES } from './audio.js';
import { logEvent } from './logging.js';
import type { Logger } from './types.js';

export type TtsConfig =
  | { provider: 'none' }
  | {
    provider: 'edge-tts';
    bin: string;
    voice: string;
    rate: string;
    volume: string;
    pitch: string;
    timeoutMs: number;
    maxBytes: number;
    maxChars: number;
  }
  | {
    provider: 'mimo';
    apiKey: string;
    baseUrl: string;
    model: string;
    voice: string;
    style: string;
    timeoutMs: number;
    maxBytes: number;
    maxChars: number;
  };

export interface SpeechProvider {
  readonly name: string;
  synthesize(text: string, signal: AbortSignal): Promise<{ file: string }>;
}

/** Messages contain fixed diagnostics only; never retain provider output or spoken text. */
export class TtsError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'TtsError';
  }
}

export function loadTtsConfig(env: NodeJS.ProcessEnv = process.env): TtsConfig {
  const provider = env.TTS_PROVIDER?.trim() || 'none';
  if (provider === 'none') return { provider };
  if (provider === 'mimo') return loadMimoConfig(env);
  if (provider !== 'edge-tts') throw configError('TTS_PROVIDER must be none, edge-tts, or mimo');
  const bin = env.EDGE_TTS_BIN?.trim() || 'edge-tts';
  if (bin.length > 4_096 || /[\x00-\x1f\x7f]/u.test(bin) || bin.startsWith('-')) {
    throw configError('EDGE_TTS_BIN must be an executable name or path');
  }
  const voice = env.EDGE_TTS_VOICE?.trim() || 'zh-CN-XiaoxiaoNeural';
  if (!/^[A-Za-z0-9-]{1,128}$/u.test(voice)) throw configError('EDGE_TTS_VOICE must be a voice identifier');
  return {
    provider, bin, voice,
    rate: adjustment(env.EDGE_TTS_RATE, 'EDGE_TTS_RATE', '+0%', '%'),
    volume: adjustment(env.EDGE_TTS_VOLUME, 'EDGE_TTS_VOLUME', '+0%', '%'),
    pitch: adjustment(env.EDGE_TTS_PITCH, 'EDGE_TTS_PITCH', '+0Hz', 'Hz'),
    timeoutMs: integerSetting(env.TTS_TIMEOUT_MS, 'TTS_TIMEOUT_MS', 30_000, 300_000),
    maxBytes: integerSetting(env.TTS_MAX_BYTES, 'TTS_MAX_BYTES', 5 * 1_024 * 1_024, MAX_VOICE_BYTES),
    maxChars: integerSetting(env.TTS_MAX_CHARS, 'TTS_MAX_CHARS', 300, 10_000),
  };
}

export interface SpeechNetworkOptions {
  fetch?: typeof globalThis.fetch;
  networkProxy?: NetworkProxyConfig;
}

export function createSpeechProvider(config: TtsConfig, logger: Logger, options: SpeechNetworkOptions = {}): SpeechProvider | null {
  if (config.provider === 'none') return null;
  return config.provider === 'mimo' ? new MimoTtsProvider(config, logger, options) : new EdgeTtsProvider(config, logger, options);
}

const MAX_STDERR_BYTES = 64 * 1_024;
const TERMINATE_GRACE_MS = 250;
type EdgeConfig = Extract<TtsConfig, { provider: 'edge-tts' }>;
type MimoConfig = Extract<TtsConfig, { provider: 'mimo' }>;

const MIMO_VOICES = new Set(['mimo_default', '冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean']);

function loadMimoConfig(env: NodeJS.ProcessEnv): MimoConfig {
  const rawKey = env.MIMO_TTS_API_KEY;
  if (rawKey !== undefined && /[^\x20-\x7e]/u.test(rawKey)) {
    throw configError('MIMO_TTS_API_KEY must contain valid HTTP header characters');
  }
  const apiKey = rawKey?.trim();
  if (!apiKey) throw configError('MIMO_TTS_API_KEY is required when TTS_PROVIDER is mimo');
  const model = env.MIMO_TTS_MODEL?.trim() || 'mimo-v2.5-tts';
  if (model !== 'mimo-v2.5-tts') throw configError('MIMO_TTS_MODEL must be mimo-v2.5-tts');
  const voice = env.MIMO_TTS_VOICE?.trim() || 'mimo_default';
  if (!MIMO_VOICES.has(voice)) throw configError('MIMO_TTS_VOICE must be a supported preset voice');
  const style = env.MIMO_TTS_STYLE?.trim() || '';
  if (Array.from(style).length > 4_000) throw configError('MIMO_TTS_STYLE must contain at most 4000 Unicode characters');
  return {
    provider: 'mimo', apiKey, model, voice, style,
    baseUrl: normalizeMimoBaseUrl(env.MIMO_TTS_BASE_URL?.trim() || 'https://api.xiaomimimo.com/v1'),
    timeoutMs: integerSetting(env.TTS_TIMEOUT_MS, 'TTS_TIMEOUT_MS', 30_000, 300_000),
    maxBytes: integerSetting(env.TTS_MAX_BYTES, 'TTS_MAX_BYTES', 5 * 1_024 * 1_024, MAX_VOICE_BYTES),
    maxChars: integerSetting(env.TTS_MAX_CHARS, 'TTS_MAX_CHARS', 300, 10_000),
  };
}

class MimoTtsProvider implements SpeechProvider {
  readonly name = 'mimo';

  constructor(private readonly config: MimoConfig, private readonly logger: Logger, private readonly network: SpeechNetworkOptions) {}

  async synthesize(text: string, signal: AbortSignal): Promise<{ file: string }> {
    const started = Date.now();
    const chars = typeof text === 'string' ? Array.from(text).length : 0;
    logEvent(this.logger, 'info', 'tts.synthesis.started', { provider: this.name, text_chars: chars });
    try {
      if (signal.aborted) throw cancelled();
      if (typeof text !== 'string' || !text.trim()) throw new TtsError('TTS_INVALID_REQUEST', 'Speech text must be non-empty');
      if (chars > this.config.maxChars) throw new TtsError('TTS_TEXT_TOO_LONG', 'Speech text exceeds TTS_MAX_CHARS');
      const audio = await this.request(text, signal);
      if (signal.aborted) throw cancelled();
      logEvent(this.logger, 'info', 'tts.synthesis.completed', {
        provider: this.name, text_chars: chars, bytes: audio.length, duration_ms: Date.now() - started,
      });
      return { file: `base64://${audio.toString('base64')}` };
    } catch (error) {
      const safe = error instanceof TtsError ? error : new TtsError('TTS_REQUEST_FAILED', 'Speech synthesis failed');
      logEvent(this.logger, 'warn', 'tts.synthesis.failed', {
        provider: this.name, text_chars: chars, code: safe.code, duration_ms: Date.now() - started,
      });
      throw safe;
    }
  }

  private async request(text: string, signal: AbortSignal): Promise<Buffer> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.config.timeoutMs);
    timer.unref();
    const combined = AbortSignal.any([signal, timeout.signal]);
    try {
      combined.throwIfAborted();
      const response = await (this.network.fetch ?? fetch)(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'api-key': this.config.apiKey,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            ...(this.config.style ? [{ role: 'user', content: this.config.style }] : []),
            { role: 'assistant', content: text },
          ],
          audio: { format: 'mp3', voice: this.config.voice },
          stream: false,
        }),
        signal: combined,
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new TtsError('TTS_HTTP_ERROR', `MiMo request failed (HTTP ${response.status})`);
      }
      const maximumEncodedLength = 4 * Math.ceil(this.config.maxBytes / 3);
      const bytes = await readMimoResponse(response, maximumEncodedLength + 64 * 1_024);
      let parsed: unknown;
      try { parsed = JSON.parse(bytes.toString('utf8')); } catch { throw invalidMimoResponse(); }
      const choice = isRecord(parsed) && Array.isArray(parsed.choices) ? parsed.choices[0] : undefined;
      if (!isRecord(choice) || choice.finish_reason !== 'stop' || !isRecord(choice.message)
        || !isRecord(choice.message.audio) || typeof choice.message.audio.data !== 'string') throw invalidMimoResponse();
      const encoded = choice.message.audio.data;
      if (encoded.length > maximumEncodedLength) throw audioTooLarge();
      if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) throw invalidMimoAudio();
      const audio = Buffer.from(encoded, 'base64');
      if (audio.length > this.config.maxBytes) throw audioTooLarge();
      if (audio.toString('base64') !== encoded || !isMp3(audio)) throw invalidMimoAudio();
      return audio;
    } catch (error) {
      if (signal.aborted) throw cancelled();
      if (timeout.signal.aborted) throw new TtsError('TTS_TIMEOUT', 'Speech synthesis timed out');
      if (error instanceof TtsError) throw error;
      throw new TtsError('TTS_REQUEST_FAILED', 'MiMo speech request failed');
    } finally {
      clearTimeout(timer);
    }
  }
}

async function readMimoResponse(response: Response, maximumBytes: number): Promise<Buffer> {
  if (!response.body) throw invalidMimoResponse();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, total);
      total += value.byteLength;
      if (total > maximumBytes) {
        void reader.cancel().catch(() => {});
        throw new TtsError('TTS_RESPONSE_TOO_LARGE', 'MiMo response exceeds the allowed size');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}

function normalizeMimoBaseUrl(value: string): string {
  const message = 'MIMO_TTS_BASE_URL must be an HTTP or HTTPS URL without credentials, query, or fragment';
  let url: URL;
  try { url = new URL(value); } catch { throw configError(message); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || /[\x00-\x20\x7f?#]/u.test(value)) throw configError(message);
  return url.href.replace(/\/+$/u, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidMimoResponse(): TtsError { return new TtsError('TTS_INVALID_RESPONSE', 'MiMo returned an invalid response'); }
function invalidMimoAudio(): TtsError { return new TtsError('TTS_INVALID_AUDIO', 'Speech provider returned invalid MP3 audio'); }
function audioTooLarge(): TtsError { return new TtsError('TTS_AUDIO_TOO_LARGE', 'Speech audio exceeds TTS_MAX_BYTES'); }

class EdgeTtsProvider implements SpeechProvider {
  readonly name = 'edge-tts';

  constructor(private readonly config: EdgeConfig, private readonly logger: Logger, private readonly network: SpeechNetworkOptions) {}

  async synthesize(text: string, signal: AbortSignal): Promise<{ file: string }> {
    const started = Date.now();
    const chars = typeof text === 'string' ? Array.from(text).length : 0;
    logEvent(this.logger, 'info', 'tts.synthesis.started', { provider: this.name, text_chars: chars });
    try {
      if (signal.aborted) throw cancelled();
      if (typeof text !== 'string' || !text.trim()) throw new TtsError('TTS_INVALID_REQUEST', 'Speech text must be non-empty');
      if (chars > this.config.maxChars) throw new TtsError('TTS_TEXT_TOO_LONG', 'Speech text exceeds TTS_MAX_CHARS');
      const audio = await this.run(text, signal);
      if (signal.aborted) throw cancelled();
      if (!isMp3(audio)) throw new TtsError('TTS_INVALID_AUDIO', 'Speech provider returned invalid MP3 audio');
      logEvent(this.logger, 'info', 'tts.synthesis.completed', {
        provider: this.name, text_chars: chars, bytes: audio.length, duration_ms: Date.now() - started,
      });
      return { file: `base64://${audio.toString('base64')}` };
    } catch (error) {
      const safe = error instanceof TtsError ? error : new TtsError('TTS_PROCESS_FAILED', 'Speech synthesis failed');
      logEvent(this.logger, 'warn', 'tts.synthesis.failed', {
        provider: this.name, text_chars: chars, code: safe.code, duration_ms: Date.now() - started,
      });
      throw safe;
    }
  }

  private async run(text: string, signal: AbortSignal): Promise<Buffer> {
    const proxy = this.network.networkProxy ?? defaultNetworkProxy();
    const launch = proxy.enabled ? await edgeProxyLaunch(this.config, proxy) : undefined;
    if (signal.aborted) throw cancelled();
    if (this.network.networkProxy) logEvent(this.logger, 'info', 'network.route', {
      category: 'tts', ...routeNetworkUrl(proxy, 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1'),
    });
    return new Promise((resolve, reject) => {
      // Text uses stdin and media uses stdout. Proxy credentials use an extra pipe,
      // never argv, and the Python API selects the proxy explicitly for WSS.
      const child = spawn(launch?.command ?? this.config.bin, launch?.args ?? [
        '--file', '-', '--write-media', '-', '--no-progress', '--voice', this.config.voice,
        `--rate=${this.config.rate}`, `--volume=${this.config.volume}`, `--pitch=${this.config.pitch}`,
      ], {
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe', ...(launch ? ['pipe' as const] : [])],
        env: { ...proxyEnvironment({ ...proxy, enabled: false }, process.env), PYTHONIOENCODING: 'utf-8' },
      });
      let failure: TtsError | undefined;
      let closed = false;
      let bytes = 0;
      let stderrBytes = 0;
      let chunks: Buffer[] = [];
      let killTimer: NodeJS.Timeout | undefined;

      const kill = (kind: NodeJS.Signals) => {
        if (!child.pid) return;
        try {
          if (process.platform === 'win32') child.kill(kind);
          else process.kill(-child.pid, kind);
        } catch { /* The child may already have exited. */ }
      };
      const fail = (error: TtsError) => {
        if (failure || closed) return;
        failure = error;
        chunks = [];
        child.stdin!.destroy();
        kill('SIGTERM');
        killTimer = setTimeout(() => kill('SIGKILL'), TERMINATE_GRACE_MS);
        killTimer.unref();
      };
      const abort = () => fail(cancelled());
      const timer = setTimeout(() => fail(new TtsError('TTS_TIMEOUT', 'Speech synthesis timed out')), this.config.timeoutMs);
      timer.unref();
      signal.addEventListener('abort', abort, { once: true });
      child.on('error', () => fail(new TtsError('TTS_START_FAILED', 'Speech provider could not be started')));
      if (launch) {
        const configuration = child.stdio[3] as import('node:stream').Writable;
        configuration.on('error', () => fail(new TtsError('TTS_IO_ERROR', 'Speech provider configuration failed')));
        configuration.end(JSON.stringify(launch.config), 'utf8');
      }
      child.stdin!.on('error', () => fail(new TtsError('TTS_IO_ERROR', 'Speech provider input failed')));
      child.stdout!.on('error', () => fail(new TtsError('TTS_IO_ERROR', 'Speech provider output failed')));
      child.stderr!.on('error', () => fail(new TtsError('TTS_IO_ERROR', 'Speech provider diagnostics failed')));
      child.stdout!.on('data', (chunk: Buffer) => {
        if (failure) return;
        bytes += chunk.length;
        if (bytes > this.config.maxBytes) fail(new TtsError('TTS_AUDIO_TOO_LARGE', 'Speech audio exceeds TTS_MAX_BYTES'));
        else chunks.push(chunk);
      });
      child.stderr!.on('data', (chunk: Buffer) => {
        if (failure) return;
        stderrBytes += chunk.length;
        if (stderrBytes > MAX_STDERR_BYTES) fail(new TtsError('TTS_DIAGNOSTIC_TOO_LARGE', 'Speech provider diagnostics exceeded the limit'));
      });
      child.on('close', (code, terminationSignal) => {
        closed = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        signal.removeEventListener('abort', abort);
        if (failure) reject(failure);
        else if (code !== 0 || terminationSignal) reject(new TtsError('TTS_PROCESS_FAILED', 'Speech provider exited unsuccessfully'));
        else resolve(Buffer.concat(chunks, bytes));
        chunks = [];
      });
      if (signal.aborted) abort();
      if (!failure) child.stdin!.end(text, 'utf8');
    });
  }
}

const EDGE_PROXY_PYTHON = `
import asyncio, json, os, sys
from edge_tts import Communicate
with os.fdopen(3, 'r', encoding='utf-8') as config_pipe:
    config = json.load(config_pipe)
text = sys.stdin.buffer.read().decode('utf-8')
async def run():
    communicate = Communicate(text, config['voice'], rate=config['rate'], volume=config['volume'],
                              pitch=config['pitch'], proxy=config['proxy'])
    async for chunk in communicate.stream():
        if chunk['type'] == 'audio':
            sys.stdout.buffer.write(chunk['data'])
            sys.stdout.buffer.flush()
asyncio.run(run())
`;

async function edgeProxyLaunch(config: EdgeConfig, proxy: NetworkProxyConfig): Promise<{
  command: string; args: string[]; config: { voice: string; rate: string; volume: string; pitch: string; proxy: string | null };
}> {
  let command: string;
  try {
    const candidates = isAbsolute(config.bin) || config.bin.includes('/') ? [resolve(config.bin)] :
      (process.env.PATH ?? '').split(delimiter).map(directory => resolve(directory, config.bin));
    let entry: string | undefined;
    for (const candidate of candidates) {
      try { await access(candidate, constants.X_OK); entry = await realpath(candidate); break; } catch { /* Try the next PATH entry. */ }
    }
    if (!entry) throw new Error();
    const file = await open(entry, 'r');
    let line: string;
    try { const bytes = Buffer.alloc(512); const read = await file.read(bytes, 0, bytes.length, 0); line = bytes.subarray(0, read.bytesRead).toString('utf8').split('\n')[0]!; }
    finally { await file.close(); }
    const shebang = /^#!\s*(\S+)(?:\s+(\S+))?\s*$/u.exec(line);
    if (!shebang) throw new Error();
    command = basename(shebang[1]!) === 'env' ? shebang[2] ?? '' : shebang[1]!;
    if (!/^python(?:\d+(?:\.\d+)*)?$/u.test(basename(command))) throw new Error();
  } catch {
    throw new TtsError('TTS_PROXY_UNSUPPORTED', 'Speech proxy requires a Python edge-tts entry point');
  }
  const route = routeNetworkUrl(proxy, 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1');
  return { command, args: ['-c', EDGE_PROXY_PYTHON], config: {
    voice: config.voice, rate: config.rate, volume: config.volume, pitch: config.pitch,
    proxy: route.mode === 'proxy' ? proxyUrlWithCredentials(proxy) : null,
  } };
}

function integerSetting(raw: string | undefined, name: string, fallback: number, maximum: number): number {
  const value = raw?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw configError(`${name} must be an integer from 1 to ${maximum}`);
  }
  return parsed;
}

function adjustment(raw: string | undefined, name: string, fallback: string, unit: '%' | 'Hz'): string {
  const value = raw?.trim() || fallback;
  const pattern = unit === '%' ? /^[+-]\d{1,4}%$/u : /^[+-]\d{1,4}Hz$/u;
  if (!pattern.test(value)) throw configError(`${name} must be a signed integer followed by ${unit}`);
  return value;
}

function cancelled(): TtsError { return new TtsError('TTS_ABORTED', 'Speech synthesis was cancelled'); }
function configError(message: string): TtsError { return new TtsError('TTS_CONFIG_ERROR', message); }
