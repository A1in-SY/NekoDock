import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { prepareImageReply, prepareIncomingImages } from '../src/images.js';
import type { StoredMessage } from '../src/types.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ioAAAAASUVORK5CYII=', 'base64');
const controller = () => new AbortController();

function message(id: string, ...sources: string[]): StoredMessage {
  return {
    seq: Number(id), messageId: id, senderId: '123', senderName: '小明', time: 0,
    text: '[图片]', replyTo: null, trigger: true,
    rawJson: JSON.stringify({ message: sources.map(source => ({ type: 'image', data: { file: source } })) }),
  };
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'qq-images-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(workspace);
  const options = { workspace, maxBytes: 1024, timeoutMs: 1000 };
  return { root, workspace, options };
}

async function http(t: TestContext, handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

test('incoming HTTP and base64 images share content-addressed readable cache files', async t => {
  const { options } = await fixture(t);
  let requests = 0;
  const url = await http(t, (_request, response) => {
    requests++;
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    response.end(png);
  });
  const result = await prepareIncomingImages([
    message('1', `${url}/photo.png?secret=hidden`), message('2', `base64://${png.toString('base64')}`),
  ], options, controller().signal);
  assert.equal(requests, 1);
  assert.equal(result.files.length, 1);
  assert.deepEqual(result.byMessageId.get('1'), [{ path: result.files[0] }]);
  assert.deepEqual(result.byMessageId.get('2'), [{ path: result.files[0] }]);
  assert.match(result.files[0]!, /\.qq-images\/[a-f\d]{64}\.png$/);
  assert.deepEqual(await readFile(result.files[0]!), png);
  assert.deepEqual(await readdir(join(options.workspace, '.qq-images')), [result.files[0]!.split('/').at(-1)]);
});

test('incoming failures are isolated, sanitized and preserve successful images', async t => {
  const { options } = await fixture(t);
  const url = await http(t, (request, response) => {
    if (request.url?.startsWith('/bad')) response.end('not an image');
    else if (request.url?.startsWith('/missing')) { response.writeHead(404); response.end('secret content'); }
    else response.end(png);
  });
  const result = await prepareIncomingImages([
    message('1', `${url}/bad?token=top-secret`, `${url}/missing?token=top-secret`, `${url}/ok`),
  ], options, controller().signal);
  assert.deepEqual(result.byMessageId.get('1')?.slice(0, 2), [{ error: '图片格式不支持' }, { error: '图片下载失败' }]);
  assert.equal(result.files.length, 1);
  assert.doesNotMatch(JSON.stringify([...result.byMessageId]), /top-secret|127\.0\.0\.1|secret content/);
});

test('图片日志记录方向、大小、结果和耗时，失败不暴露 URL、文件路径或内容', async t => {
  const { options } = await fixture(t);
  const logs: string[] = [];
  const logger = { info: (line: string) => logs.push(line), warn: (line: string) => logs.push(line), error: (line: string) => logs.push(line) };
  const url = await http(t, (_request, response) => { response.writeHead(403); response.end('private-body'); });
  const incoming = await prepareIncomingImages([
    message('private-message-id', `base64://${png.toString('base64')}`, `${url}/private-file?token=private-token`),
  ], { ...options, logger }, controller().signal);
  assert.equal(incoming.files.length, 1);
  await prepareImageReply(incoming.files[0]!, { ...options, logger }, controller().signal);
  await assert.rejects(prepareImageReply('private-file-missing.png', { ...options, logger }, controller().signal), /图片读取失败/);
  assert.equal(logs.filter(line => line.startsWith('image.prepare_started ')).length, 4);
  assert.equal(logs.filter(line => line.startsWith('image.prepared ')).length, 2);
  assert.equal(logs.filter(line => line.startsWith('image.failed ')).length, 2);
  assert.ok(logs.some(line => line.includes('direction="inbound"') && line.includes(`bytes=${png.length}`)));
  assert.ok(logs.some(line => line.includes('direction="outbound"') && line.includes(`bytes=${png.length}`)));
  assert.ok(logs.some(line => line.includes('reason="图片下载失败"')));
  assert.doesNotMatch(logs.join('\n'), /private-message-id|private-file|private-token|private-body|base64:\/\/|127\.0\.0\.1|\.qq-images|iVBOR/);
});

test('incoming downloads enforce both declared and streamed byte limits', async t => {
  const { options } = await fixture(t);
  const url = await http(t, (request, response) => {
    if (request.url === '/declared') response.writeHead(200, { 'content-length': '100000000' });
    response.write(png);
    response.end(Buffer.alloc(2048));
  });
  const result = await prepareIncomingImages([message('1', `${url}/declared`, `${url}/streamed`)], options, controller().signal);
  assert.deepEqual(result.byMessageId.get('1'), [{ error: '图片超过大小限制' }, { error: '图片超过大小限制' }]);
  assert.deepEqual(result.files, []);
});

test('incoming base64 rejects invalid syntax, noncanonical encoding and oversized data', async t => {
  const { options } = await fixture(t);
  const result = await prepareIncomingImages([
    message('1', 'base64://!!', 'base64://aGVsbG8', 'base64://YR==', `base64://${Buffer.alloc(2000).toString('base64')}`),
  ], options, controller().signal);
  assert.deepEqual(result.byMessageId.get('1'), [
    { error: '图片编码无效' }, { error: '图片编码无效' }, { error: '图片编码无效' }, { error: '图片超过大小限制' },
  ]);
});

test('image magic determines accepted formats regardless of filename or content type', async t => {
  const { options } = await fixture(t);
  const formats = [
    { suffix: 'png', bytes: png },
    { suffix: 'jpg', bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0]) },
    { suffix: 'gif', bytes: Buffer.from('GIF89a12345') },
    { suffix: 'webp', bytes: Buffer.from('RIFF0000WEBP1234') },
  ];
  const result = await prepareIncomingImages(formats.map((format, i) => message(String(i), `base64://${format.bytes.toString('base64')}`)), options, controller().signal);
  assert.deepEqual(result.files.map(path => path.split('.').at(-1)), formats.map(format => format.suffix));
  const bad = await prepareIncomingImages([message('9', `base64://${Buffer.from('<svg/>').toString('base64')}`)], options, controller().signal);
  assert.deepEqual(bad.byMessageId.get('9'), [{ error: '图片格式不支持' }]);
});

test('incoming download times out while headers or body are pending', async t => {
  const { options } = await fixture(t);
  const url = await http(t, (request, response) => {
    if (request.url === '/body') { response.writeHead(200); response.write(png.subarray(0, 4)); }
  });
  const result = await prepareIncomingImages([message('1', `${url}/headers`, `${url}/body`)], { ...options, timeoutMs: 30 }, controller().signal);
  assert.deepEqual(result.byMessageId.get('1'), [{ error: '图片下载超时' }, { error: '图片下载超时' }]);
});

test('caller cancellation propagates during incoming downloads instead of becoming a failed image', async t => {
  const { options } = await fixture(t);
  const abort = controller();
  const reason = new Error('cancelled by caller');
  const url = await http(t, (_request, response) => {
    response.writeHead(200); response.write(png.subarray(0, 4));
    abort.abort(reason);
  });
  await assert.rejects(prepareIncomingImages([message('1', `${url}/pending`)], options, abort.signal), error => error === reason);
  await assert.rejects(prepareIncomingImages([], options, abort.signal), error => error === reason);
});

test('incoming ignores stickers and NapCat-local image paths', async t => {
  const { options } = await fixture(t);
  const incoming = message('1');
  incoming.rawJson = JSON.stringify({ message: [
    { type: 'image', data: { file: '/tmp/should-not-read.png' } },
    { type: 'image', data: { sub_type: 1, file: `base64://${png.toString('base64')}` } },
  ] });
  assert.deepEqual(await prepareIncomingImages([incoming], options, controller().signal), { files: [], byMessageId: new Map() });
});

test('prepared local reply snapshots relative or absolute workspace files', async t => {
  const { options } = await fixture(t);
  const file = join(options.workspace, 'photo.anything');
  await writeFile(file, png);
  const first = await prepareImageReply('photo.anything', options, controller().signal);
  const second = await prepareImageReply(file, options, controller().signal);
  assert.deepEqual(first, { type: 'image', file: `base64://${png.toString('base64')}` });
  assert.deepEqual(first, second);
  await writeFile(file, 'changed');
  assert.deepEqual(Buffer.from(first.file.slice('base64://'.length), 'base64'), png);
});

test('outbound HTTP reply downloads and snapshots validated image bytes', async t => {
  const { options } = await fixture(t);
  const url = await http(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' }); response.end(png);
  });
  assert.deepEqual(await prepareImageReply(`${url}/not-a-png.txt`, options, controller().signal), {
    type: 'image', file: `base64://${png.toString('base64')}`,
  });
});

test('outbound paths cannot escape workspace through traversal, absolute paths or symlinks', async t => {
  const { root, workspace, options } = await fixture(t);
  const outside = join(root, 'secret.png');
  await writeFile(outside, png);
  await symlink(outside, join(workspace, 'link.png'));
  await symlink(root, join(workspace, 'parent'));
  for (const source of ['../secret.png', outside, 'link.png', 'parent/secret.png']) {
    await assert.rejects(prepareImageReply(source, options, controller().signal), { message: '图片路径不允许' });
  }
});

test('outbound rejects non-files, oversized files, invalid formats and unsupported schemes', async t => {
  const { workspace, options } = await fixture(t);
  await writeFile(join(workspace, 'large.png'), Buffer.alloc(2048));
  await writeFile(join(workspace, 'fake.png'), '<svg>secret</svg>');
  await assert.rejects(prepareImageReply('.', options, controller().signal), { message: '图片必须为普通文件' });
  await assert.rejects(prepareImageReply('large.png', options, controller().signal), { message: '图片超过大小限制' });
  await assert.rejects(prepareImageReply('fake.png', options, controller().signal), { message: '图片格式不支持' });
  for (const source of ['', 'file:///etc/secret.png', 'ftp://host/secret.png', `base64://${png.toString('base64')}`]) {
    await assert.rejects(prepareImageReply(source, options, controller().signal), { message: '图片来源不支持' });
  }
  await assert.rejects(prepareImageReply('secret-missing.png', options, controller().signal), { message: '图片读取失败' });
});

test('outbound timeout and caller cancellation use distinct failure semantics', async t => {
  const { options } = await fixture(t);
  const url = await http(t, (_request, response) => { response.writeHead(200); response.write(png.subarray(0, 2)); });
  await assert.rejects(prepareImageReply(`${url}/slow`, { ...options, timeoutMs: 30 }, controller().signal), { message: '图片下载超时' });
  const abort = controller();
  const reason = new Error('caller stopped');
  abort.abort(reason);
  await assert.rejects(prepareImageReply(`${url}/slow`, options, abort.signal), error => error === reason);
});

test('incoming refuses a cache symlink instead of writing outside the workspace', async t => {
  const { root, workspace, options } = await fixture(t);
  await symlink(root, join(workspace, '.qq-images'));
  const result = await prepareIncomingImages([message('1', `base64://${png.toString('base64')}`)], options, controller().signal);
  assert.deepEqual(result.byMessageId.get('1'), [{ error: '图片缓存路径不允许' }]);
  assert.deepEqual(await readdir(root), ['workspace']);
});
