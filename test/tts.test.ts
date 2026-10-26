import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { isMp3Snapshot, MAX_VOICE_BYTES } from '../src/audio.js';
import { createLogger } from '../src/logging.js';
import { createSpeechProvider, loadTtsConfig, TtsError, type SpeechProvider, type TtsConfig } from '../src/tts.js';

const active = { TTS_PROVIDER: 'edge-tts' };
const mp3 = Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0]);
const quiet = { info() {}, warn() {}, error() {} };
type EdgeConfig = Extract<TtsConfig, { provider: 'edge-tts' }>;

function assertCode(code: string): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof TtsError);
    assert.equal(error.code, code);
    assert.doesNotMatch(error.message, /private-text|private-key|private-stderr|private-path|private-value/);
    assert.equal(error.cause, undefined);
    return true;
  };
}

async function binary(t: TestContext, body: string): Promise<{ bin: string; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'napcat-tts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, 'fake edge tts.mjs');
  await writeFile(bin, `#!${process.execPath}\n${body}\n`);
  await chmod(bin, 0o700);
  return { bin, directory };
}

function provider(bin: string, options: Partial<EdgeConfig> = {}): SpeechProvider {
  const config = loadTtsConfig({ ...active, EDGE_TTS_BIN: bin });
  assert.equal(config.provider, 'edge-tts');
  const result = createSpeechProvider({ ...config, ...options } as EdgeConfig, quiet);
  assert.ok(result);
  return result;
}

async function waitPid(path: string): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { return Number(await readFile(path, 'utf8')); } catch { await delay(10); }
  }
  assert.fail('fake speech process did not start');
}

function assertStopped(pid: number): void {
  assert.throws(() => process.kill(pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH');
}

test('语音供应商默认禁用，禁用忽略其他参数，只能选择一个供应商', () => {
  assert.deepEqual(loadTtsConfig({}), { provider: 'none' });
  assert.deepEqual(loadTtsConfig({
    TTS_PROVIDER: ' none ', EDGE_TTS_BIN: '\nprivate-path', EDGE_TTS_VOICE: 'private-value!',
    EDGE_TTS_RATE: 'bad', EDGE_TTS_VOLUME: 'bad', EDGE_TTS_PITCH: 'bad',
    TTS_TIMEOUT_MS: 'bad', TTS_MAX_BYTES: 'bad', TTS_MAX_CHARS: 'bad',
  }), { provider: 'none' });
  assert.equal(createSpeechProvider({ provider: 'none' }, quiet), null);
  for (const value of ['azure', 'edge-tts,azure', 'EDGE-TTS', 'private-value']) {
    assert.throws(() => loadTtsConfig({ TTS_PROVIDER: value }), assertCode('TTS_CONFIG_ERROR'));
  }
});

test('edge-tts 默认中文声音、语速、音量、音调及资源限制可配置', () => {
  assert.deepEqual(loadTtsConfig(active), {
    provider: 'edge-tts', bin: 'edge-tts', voice: 'zh-CN-XiaoxiaoNeural',
    rate: '+0%', volume: '+0%', pitch: '+0Hz', timeoutMs: 30_000,
    maxBytes: 5 * 1_024 * 1_024, maxChars: 300,
  });
  assert.deepEqual(loadTtsConfig({
    TTS_PROVIDER: ' edge-tts ', EDGE_TTS_BIN: ' /opt/tts/edge-tts ',
    EDGE_TTS_VOICE: ' zh-CN-YunxiNeural ', EDGE_TTS_RATE: ' -10% ',
    EDGE_TTS_VOLUME: '+20%', EDGE_TTS_PITCH: '-15Hz', TTS_TIMEOUT_MS: '300000',
    TTS_MAX_BYTES: String(MAX_VOICE_BYTES), TTS_MAX_CHARS: '10000',
  }), {
    provider: 'edge-tts', bin: '/opt/tts/edge-tts', voice: 'zh-CN-YunxiNeural',
    rate: '-10%', volume: '+20%', pitch: '-15Hz', timeoutMs: 300_000,
    maxBytes: MAX_VOICE_BYTES, maxChars: 10_000,
  });
});

test('无效 TTS 设置拒绝启动，报错不回显配置值', () => {
  for (const bin of ['private-path\0', 'private-path\nx', '-private-path']) {
    assert.throws(() => loadTtsConfig({ ...active, EDGE_TTS_BIN: bin }), assertCode('TTS_CONFIG_ERROR'));
  }
  for (const voice of ['private-value!', '--voice bad', 'x'.repeat(129)]) {
    assert.throws(() => loadTtsConfig({ ...active, EDGE_TTS_VOICE: voice }), assertCode('TTS_CONFIG_ERROR'));
  }
  for (const name of ['EDGE_TTS_RATE', 'EDGE_TTS_VOLUME', 'EDGE_TTS_PITCH']) {
    for (const value of ['private-value', '0', '+1.5%', '10%', '+12345%', '+0%\nx']) {
      assert.throws(() => loadTtsConfig({ ...active, [name]: value }), assertCode('TTS_CONFIG_ERROR'));
    }
  }
  for (const [name, aboveMaximum] of [
    ['TTS_TIMEOUT_MS', '300001'], ['TTS_MAX_BYTES', String(MAX_VOICE_BYTES + 1)], ['TTS_MAX_CHARS', '10001'],
  ]) {
    for (const value of ['0', '-1', '1.5', 'NaN', 'Infinity', '1e3', 'private-value', aboveMaximum]) {
      assert.throws(() => loadTtsConfig({ ...active, [name!]: value }), assertCode('TTS_CONFIG_ERROR'));
    }
  }
});

test('文本通过 UTF-8 stdin 传递，参数独立且负数设置使用等号，MP3 转为可传输快照', async (t) => {
  const fixture = await binary(t, `
    import { writeFile } from 'node:fs/promises';
    let text = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) text += chunk;
    await writeFile(new URL('./capture.json', import.meta.url), JSON.stringify({
      text, args: process.argv.slice(2), encoding: process.env.PYTHONIOENCODING,
    }));
    process.stdout.write(Buffer.from(${JSON.stringify([...mp3])}));
  `);
  const text = '  你好🦭 private-text; $(touch /tmp/not-a-command)\n下一行  ';
  const result = await provider(fixture.bin, { rate: '-10%', volume: '-20%', pitch: '-15Hz' })
    .synthesize(text, new AbortController().signal);
  assert.equal(isMp3Snapshot(result.file), true);
  assert.deepEqual(Buffer.from(result.file.slice(9), 'base64'), mp3);
  const captured = JSON.parse(await readFile(join(fixture.directory, 'capture.json'), 'utf8'));
  assert.equal(captured.text, text);
  assert.equal(captured.encoding, 'utf-8');
  assert.deepEqual(captured.args, [
    '--file', '-', '--write-media', '-', '--no-progress', '--voice', 'zh-CN-XiaoxiaoNeural',
    '--rate=-10%', '--volume=-20%', '--pitch=-15Hz',
  ]);
  assert.equal(captured.args.some((arg: string) => arg.includes('private-text')), false);
});

test('限制按照 Unicode 字符计数，空文本或超长文本不会启动程序', async (t) => {
  const fixture = await binary(t, `process.stdout.write(Buffer.from(${JSON.stringify([...mp3])}));`);
  const speech = provider(fixture.bin, { maxChars: 3 });
  await speech.synthesize('甲🦭乙', new AbortController().signal);
  await assert.rejects(speech.synthesize('甲🦭乙丙', new AbortController().signal), assertCode('TTS_TEXT_TOO_LONG'));
  for (const value of ['', ' \n\t ', null, 12]) {
    await assert.rejects(speech.synthesize(value as string, new AbortController().signal), assertCode('TTS_INVALID_REQUEST'));
  }
});

test('成功日志使用东八区并只记录长度、字节和耗时', async (t) => {
  const fixture = await binary(t, `
    process.stdin.resume();
    process.stderr.write('private-stderr private-key');
    process.stdout.write(Buffer.from(${JSON.stringify([...mp3])}));
  `);
  const lines: string[] = [];
  const logger = createLogger({ now: () => new Date('2026-10-23T10:00:00.123Z'), write: (_, line) => lines.push(line) });
  const config = loadTtsConfig({ ...active, EDGE_TTS_BIN: fixture.bin });
  const speech = createSpeechProvider(config, logger)!;
  await speech.synthesize('private-text', new AbortController().signal);
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /^2026-10-23T18:00:00\.123\+08:00 INFO tts\.synthesis\.started provider="edge-tts" text_chars=12$/);
  assert.match(lines[1]!, /tts\.synthesis\.completed.*bytes=8.*duration_ms=\d+/);
  assert.doesNotMatch(lines.join('\n'), /private-text|private-stderr|private-key|base64/);
});

test('启动失败与非零退出返回静态错误，不暴露路径、正文或 stderr', async (t) => {
  await assert.rejects(provider('/private-path/does-not-exist').synthesize('private-text', new AbortController().signal), assertCode('TTS_START_FAILED'));
  const fixture = await binary(t, `
    process.stdin.resume();
    process.stderr.write('private-stderr private-key');
    process.stdout.write(Buffer.from(${JSON.stringify([...mp3])}));
    process.exitCode = 17;
  `);
  await assert.rejects(provider(fixture.bin).synthesize('private-text', new AbortController().signal), assertCode('TTS_PROCESS_FAILED'));
});

test('空输出、文本输出、仅 ID3 标签及无效 MPEG 帧拒绝作为语音', async (t) => {
  for (const invalid of [Buffer.alloc(0), Buffer.from('private-text'), Buffer.from('ID3private-text'), Buffer.from([0xff, 0xff, 0xff, 0xff, 0])]) {
    const fixture = await binary(t, `process.stdin.resume(); process.stdout.write(Buffer.from(${JSON.stringify([...invalid])}));`);
    await assert.rejects(provider(fixture.bin).synthesize('private-text', new AbortController().signal), assertCode('TTS_INVALID_AUDIO'));
  }
});

test('音频允许恰好等于字节限制，超过限制拒绝且停止进程', async (t) => {
  const fixture = await binary(t, `process.stdin.resume(); process.stdout.write(Buffer.from(${JSON.stringify([...mp3])}));`);
  await provider(fixture.bin, { maxBytes: mp3.length }).synthesize('test', new AbortController().signal);
  await assert.rejects(provider(fixture.bin, { maxBytes: mp3.length - 1 }).synthesize('test', new AbortController().signal), assertCode('TTS_AUDIO_TOO_LARGE'));
});

test('失控 stderr 有固定上限且不会进入错误或日志', async (t) => {
  const fixture = await binary(t, `
    process.stdin.resume();
    process.stderr.write('private-stderr'.repeat(10000));
    setInterval(() => {}, 1000);
  `);
  const lines: string[] = [];
  const config = loadTtsConfig({ ...active, EDGE_TTS_BIN: fixture.bin });
  const speech = createSpeechProvider(config, createLogger({ write: (_, line) => lines.push(line) }))!;
  await assert.rejects(speech.synthesize('private-text', new AbortController().signal), assertCode('TTS_DIAGNOSTIC_TOO_LARGE'));
  assert.match(lines[1]!, /tts\.synthesis\.failed.*TTS_DIAGNOSTIC_TOO_LARGE/);
  assert.doesNotMatch(lines.join('\n'), /private-stderr|private-text/);
});

test('超时终止忽略 SIGTERM 的进程，升级 SIGKILL 并回收后再返回', async (t) => {
  const fixture = await binary(t, `
    import { writeFile } from 'node:fs/promises';
    process.on('SIGTERM', () => {});
    process.stdin.resume();
    await writeFile(new URL('./pid', import.meta.url), String(process.pid));
    setInterval(() => {}, 1000);
  `);
  const promise = provider(fixture.bin, { timeoutMs: 300 }).synthesize('private-text', new AbortController().signal);
  const rejection = assert.rejects(promise, assertCode('TTS_TIMEOUT'));
  const pid = await waitPid(join(fixture.directory, 'pid'));
  await rejection;
  assertStopped(pid);
});

test('取消终止活跃进程，预先取消不会启动供应商', async (t) => {
  const fixture = await binary(t, `
    import { writeFile } from 'node:fs/promises';
    process.on('SIGTERM', () => {});
    process.stdin.resume();
    await writeFile(new URL('./pid', import.meta.url), String(process.pid));
    setInterval(() => {}, 1000);
  `);
  const controller = new AbortController();
  const promise = provider(fixture.bin).synthesize('private-text', controller.signal);
  const rejection = assert.rejects(promise, assertCode('TTS_ABORTED'));
  const pid = await waitPid(join(fixture.directory, 'pid'));
  controller.abort(new Error('private-key'));
  await rejection;
  assertStopped(pid);
  await assert.rejects(provider('/private-path/does-not-exist').synthesize('private-text', controller.signal), assertCode('TTS_ABORTED'));
});
