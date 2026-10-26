import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { promisify } from 'node:util';

const dockerImage = process.env.BRIDGE_E2E_IMAGE;
const execFileAsync = promisify(execFile);

const pythonScript = String.raw`
from pathlib import Path
import sys
from PIL import Image

assert sys.version_info.major == 3
image = Image.new("RGB", (32, 24), "#2477aa")
image.save("pillow.png")
with Image.open("pillow.png") as saved:
    assert saved.size == (32, 24)
assert Path("pillow.png").read_bytes().startswith(b"\x89PNG\r\n\x1a\n")
`;

const browserScript = String.raw`
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { chromium } from 'playwright';

await access(chromium.executablePath(), constants.X_OK);
const browser = await chromium.launch({ headless: true, timeout: 20_000 });
try {
  const page = await browser.newPage({ viewport: { width: 480, height: 240 } });
  await page.setContent('<!doctype html><meta charset="utf-8"><h1>中文浏览器验证</h1>', { timeout: 10_000 });
  assert.equal(await page.locator('h1').textContent(), '中文浏览器验证');
  await page.screenshot({ path: process.argv[2], timeout: 10_000 });
  const screenshot = await readFile(process.argv[2]);
  assert.ok(screenshot.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
  assert.ok(screenshot.length > 100);
} finally {
  await browser.close();
}
`;

// This fixture runs entirely inside an isolated container without credentials or network access.
const containerScript = String.raw`
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BASE_INSTRUCTIONS_PATH } from '/app/dist/src/pi.js';
import { createPiTools } from '/app/dist/src/pi-tools.js';

assert.equal(process.getuid(), 1000, '镜像应使用默认非 root 用户');
assert.equal(process.cwd(), '/data/workspace');
assert.equal(process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/playwright-browsers');
assert.ok((await readFile(BASE_INSTRUCTIONS_PATH, 'utf8')).trim(), '镜像应包含 Agent 基础指令文件');
assert.equal(process.env.AGENT_HOME, '/data/pi');
assert.equal(process.env.CODEX_HOME, undefined);
assert.throws(() => execFileSync('codex', ['--version'], { stdio: 'pipe' }), { code: 'ENOENT' });
await writeFile('writable.txt', 'workspace is writable');
assert.equal(await readFile('writable.txt', 'utf8'), 'workspace is writable');

const run = (command, args, cwd = process.cwd(), timeout = 15_000) =>
  execFileSync(command, args, { cwd, encoding: 'utf8', timeout, maxBuffer: 1024 * 1024 });
const commands = [
  'python', 'python3', 'pip', 'pip3', 'uv', 'uvx', 'curl', 'jq', 'file',
  'zip', 'unzip', 'xz', 'zstd', 'sqlite3', 'ps', 'top', 'pgrep', 'ip', 'ss',
  'dig', 'nc', 'fc-match', 'playwright', 'edge-tts',
];
for (const command of commands) {
  assert.ok(run('/bin/sh', ['-c', 'command -v "$1"', 'tool-check', command]).trim(), command + ' 应可执行');
}
for (const command of ['python', 'python3', 'pip', 'pip3', 'uv', 'uvx', 'curl', 'jq', 'playwright', 'edge-tts']) {
  assert.ok(run(command, ['--version']).trim(), command + ' 应能启动');
}
assert.match(run('edge-tts', ['--version']), /edge-tts.*\d+\.\d+/i);
assert.equal(run('sqlite3', [':memory:', 'select 6 * 7;']).trim(), '42');
assert.equal(run('jq', ['-n', '6 * 7']).trim(), '42');
assert.ok(run('ps', ['-o', 'pid=', '-p', String(process.pid)]).trim());
assert.match(run('fc-list', ['-f', '%{family}', ':family=Noto Sans CJK SC:charset=4e2d 6587']), /Noto Sans CJK SC/);

run('python', ['-c', ${JSON.stringify(pythonScript)}]);
assert.match(run('file', ['--mime-type', 'pillow.png']), /image\/png/);
const tools = createPiTools({ workspace: process.cwd(), home: '/data/pi', model: 'offline', baseUrl: 'http://127.0.0.1/v1',
  api: 'openai-responses', contextWindow: 200000, compactLimit: 160000, maxOutputTokens: 8192,
  supportsImages: true, supportsReasoning: false, allowCommands: false, allowFileWrites: false, persona: '', targetType: 'group' }, async () => {});
assert.deepEqual(tools.map(tool => tool.name), ['read', 'send_message']);
const imageResult = await tools.find(tool => tool.name === 'read').execute('offline-image-read', { path: 'pillow.png' }, new AbortController().signal);
assert.ok(imageResult.content.some(block => block.type === 'image' && block.mimeType === 'image/png' && typeof block.data === 'string' && block.data.length > 0));

run('python3', ['-m', 'venv', 'python-venv']);
assert.match(run(join(process.cwd(), 'python-venv/bin/python'), ['-m', 'pip', '--version']), /^pip /);
run('uv', ['venv', '--offline', '--python', 'python3', 'uv-venv']);
assert.match(run(join(process.cwd(), 'uv-venv/bin/python'), ['--version']), /^Python 3\./);

// NODE_PATH alone cannot satisfy ESM imports; exercise ordinary package resolution from both locations.
run('node', ['-e', "const assert = require('node:assert/strict'); const { chromium } = require('playwright'); assert.equal(typeof chromium.launch, 'function');"]);
await mkdir('scripts/nested', { recursive: true });
await writeFile('browser.mjs', ${JSON.stringify(browserScript)});
await writeFile('scripts/nested/browser.mjs', ${JSON.stringify(browserScript)});
run('node', ['browser.mjs', join(process.cwd(), 'browser.png')], process.cwd(), 30_000);
run('node', ['browser.mjs', join(process.cwd(), 'nested-browser.png')], join(process.cwd(), 'scripts/nested'), 30_000);
console.log('image-tools: non-root, commands, Python/Pillow/venv, fonts, CJS/ESM and Chromium screenshots passed');
`;

test('镜像工具可在非 root 工作目录离线运行 Python 和 Chromium', {
  skip: !dockerImage,
  timeout: 100_000,
}, async t => {
  assert.ok(dockerImage);
  const name = `napcat-image-tools-${randomUUID()}`;
  let child: ReturnType<typeof spawn> | undefined;
  t.after(async () => {
    // A timeout may stop the Docker client while its container is still running.
    await execFileAsync('docker', ['rm', '--force', name], { timeout: 10_000 }).catch(() => {});
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });

  const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    child = spawn('docker', ['run', '--rm', '--init', '--interactive', '--network', 'none',
      '--name', name, '--workdir', '/data/workspace', '--entrypoint', 'node', dockerImage,
      '--input-type=module'], { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    let output = '';
    const timer = setTimeout(() => {
      child?.kill('SIGKILL');
      reject(new Error(`镜像工具验证超过 80 秒\n${output}`));
    }, 80_000);
    const record = (chunk: Buffer) => {
      if (output.length < 1024 * 1024) output += chunk.toString();
    };
    child.stdout?.on('data', record);
    child.stderr?.on('data', record);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, output }); });
    child.stdin?.on('error', () => {});
    child.stdin?.end(containerScript);
  });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /image-tools: .*Chromium screenshots passed/);
});
