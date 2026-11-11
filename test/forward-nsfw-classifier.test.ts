import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {crc32, deflateSync} from 'node:zlib';
import * as photon from '@silvia-odwyer/photon-node';
import {prepareJevModelImage, prepareModelImage} from '../src/model-image.js';
import {FORWARD_NSFW_DEFAULTS, validateForwardNsfwConfig} from '../src/plugins/forward-nsfw/config.js';
import {classifyImages, ForwardNsfwError, type NsfwCachedScore, type NsfwClassificationCache, type NsfwPreparedImage} from '../src/plugins/forward-nsfw/inspect.js';
import {largeModelImage} from './fixtures/model-image.js';

function image(width = 400, height = 300): Buffer {
  const stride = width * 3 + 1, pixels = Buffer.alloc(stride * height, 0);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels[y * stride + 1 + x * 3 + (x < width / 2 ? 0 : 2)] = 255;
  const chunk = (type: string, data: Buffer) => {
    const tag = Buffer.from(type), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([tag, data])));
    return Buffer.concat([length, tag, data, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
function inspect(data: string) {
  const decoded = photon.PhotonImage.new_from_byteslice(Buffer.from(data, 'base64'));
  try { return {width: decoded.get_width(), height: decoded.get_height(), pixels: decoded.get_raw_pixels()}; }
  finally { decoded.free(); }
}
const sample = (sourceKey = 'forward:/n0/s0', bytes = image(), mimeType = 'image/png') => ({sourceKey, bytes, mimeType});
const config = {...FORWARD_NSFW_DEFAULTS, apiKey: 'synthetic-token'};
const success = (noul = 0.9) => Response.json({model: 'synthetic-vision', answers: {nsfw_0: {type: 'noul', noul}}, usage: {input_tokens: 20, output_tokens: 2}});
function memoryCache(): NsfwClassificationCache & {prepared: Map<string, NsfwPreparedImage>; scores: Map<string, NsfwCachedScore>} {
  const prepared = new Map<string, NsfwPreparedImage>(), scores = new Map<string, NsfwCachedScore>();
  return {prepared, scores, getPrepared: key => prepared.get(key), setPrepared: (key, image) => {prepared.set(key, image);},
    getScore: key => scores.get(key), setScore: (key, value) => {scores.set(key, value);}};
}

test('forward NSFW configuration validates boundaries, normalizes endpoint and preserves or clears secrets', () => {
  assert.deepEqual(validateForwardNsfwConfig({}), FORWARD_NSFW_DEFAULTS);
  assert.equal(FORWARD_NSFW_DEFAULTS.timeoutSeconds, 60);
  assert.deepEqual(validateForwardNsfwConfig({maxImages: 8}, config).apiKey, 'synthetic-token');
  assert.equal(validateForwardNsfwConfig({apiKey: ''}, config).apiKey, undefined);
  assert.equal(validateForwardNsfwConfig({baseUrl: 'https://JUDGE.example:443/prefix/v1///'}).baseUrl, 'https://judge.example/prefix/v1');
  for (const item of [{maxImages: 0}, {maxImages: 17}, {maxImages: 1.5}, {minImages: 0}, {minImages: -1}, {minImages: 1.5}, {minImages: 1001}, {nsfwThresholdPercent: 101}, {timeoutSeconds: 0}, {timeoutSeconds: 61}, {warningText: ' '}, {unknown: true}, {apiKey: 'synthetic\r\nheader'}]) assert.throws(() => validateForwardNsfwConfig(item));
  for (const baseUrl of ['file:///tmp/image', 'https://user:pass@example.test/v1', 'https://example.test/v1?key=synthetic', 'https://example.test/v1#fragment', 'https://example.test/v1/systemone/']) assert.throws(() => validateForwardNsfwConfig({baseUrl}));
});

test('legacy percentage settings adopt the default image count while preserving classifier settings', () => {
  const {minImages: _minimum, ...legacy} = {...config, maxImages: 8, nsfwThresholdPercent: 90, timeoutSeconds: 30};
  const migrated = validateForwardNsfwConfig({...legacy, imageRatioPercent: 60});
  assert.deepEqual(migrated, {...legacy, minImages: 1});
  assert.equal('imageRatioPercent' in migrated, false);
  assert.equal(validateForwardNsfwConfig({minImages: 3}, migrated).minImages, 3);
  assert.equal(validateForwardNsfwConfig({imageRatioPercent: 100}, {...migrated, minImages: 3}).minImages, 3);
});

test('Jev image preparation preserves the existing chat profile and meets both image contracts', async () => {
  const small = image();
  const chat = await prepareModelImage(small, 'image/png');
  assert.equal(chat.data, small.toString('base64'), 'The normal chat profile remains byte-stable.');
  for (const bytes of [small, image(70, 40), image(1900, 80), largeModelImage()]) {
    const prepared = await prepareJevModelImage(bytes, 'image/png'), actual = inspect(prepared.data);
    assert.ok(actual.width >= 280 && actual.height >= 280);
    assert.ok(actual.width <= 1568 && actual.height <= 1568);
    assert.ok(Buffer.byteLength(prepared.data) < 512 * 1024);
    assert.ok(['image/png', 'image/jpeg'].includes(prepared.mimeType));
  }
});

test('Jev prepares upright pixels even when a JPEG already fits normal chat limits', async () => {
  const original = photon.PhotonImage.new_from_byteslice(image(800, 400));
  let jpg: Buffer;
  try { jpg = Buffer.from(original.get_bytes_jpeg(90)); } finally { original.free(); }
  const payload = Buffer.alloc(32); payload.write('Exif\0\0II', 0, 'ascii'); payload.writeUInt16LE(42, 8); payload.writeUInt32LE(8, 10);
  payload.writeUInt16LE(1, 14); payload.writeUInt16LE(0x0112, 16); payload.writeUInt16LE(3, 18); payload.writeUInt32LE(1, 20); payload.writeUInt16LE(6, 24);
  const segment = Buffer.alloc(4); segment[0] = 0xff; segment[1] = 0xe1; segment.writeUInt16BE(payload.length + 2, 2);
  const prepared = await prepareJevModelImage(Buffer.concat([jpg.subarray(0, 2), segment, payload, jpg.subarray(2)]), 'image/jpeg');
  const actual = inspect(prepared.data);
  assert.deepEqual([actual.width, actual.height], [400, 800]);
  const at = (y: number) => [...actual.pixels.subarray((y * actual.width + 200) * 4, (y * actual.width + 200) * 4 + 3)];
  assert.ok(at(100)[0]! > 200 && at(100)[2]! < 50, 'The former left half rotates to the top.');
  assert.ok(at(700)[2]! > 200 && at(700)[0]! < 50);
});

test('Jev converts a GIF first frame to a padded static image and honours cancellation', async () => {
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  const prepared = await prepareJevModelImage(gif, 'image/gif');
  assert.equal(prepared.mimeType, 'image/png');
  assert.deepEqual([inspect(prepared.data).width, inspect(prepared.data).height], [280, 280]);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(prepareJevModelImage(image(), 'image/png', controller.signal));
});

test('classifier uploads real image assets with native Jev headers and no chat metadata', async () => {
  let body: any;
  const result = await classifyImages({...config, baseUrl: 'https://judge.example/prefix/v1/', instructions: 'Synthetic additional criteria.'}, [sample()], async (url, init) => {
    assert.equal(url, 'https://judge.example/prefix/v1/systemone');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('TypeSafe-Danger-Zone-Images'), 'true');
    assert.equal(headers.get('authorization'), 'Bearer synthetic-token');
    assert.equal(init?.redirect, 'error');
    body = JSON.parse(String(init?.body)); return success();
  }, new AbortController().signal);
  assert.deepEqual(Object.keys(body).sort(), ['assets', 'model', 'questions', 'state']);
  const reference = body.state.images[0].image;
  assert.match(reference, /^[0-9a-f-]{36}$/u);
  assert.equal(body.assets[reference].type, 'image');
  assert.equal(body.assets[reference].format, 'png');
  assert.ok(body.assets[reference].data_base64.length > 100);
  assert.match(body.questions.nsfw_0.instructions, /images\[0\]\.image/u);
  assert.equal(body.state.additional_criteria, 'Synthetic additional criteria.');
  assert.doesNotMatch(JSON.stringify(body), /synthetic-token|forward:\/|persona|senderId/u);
  assert.deepEqual(result.scores, [{sourceKey: 'forward:/n0/s0', score: 0.9}]);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.usage, {inputTokens: 20, outputTokens: 2});
  assert.equal(result.requestBytes, Buffer.byteLength(JSON.stringify(body)));
});

test('classifier retains valid samples when another image cannot be prepared', async () => {
  const result = await classifyImages(config, [sample('bad', Buffer.from('invalid')), sample('good')], async (_url, init) => {
    assert.equal(Object.keys(JSON.parse(String(init?.body)).assets).length, 1); return success(0.2);
  }, new AbortController().signal);
  assert.deepEqual(result.scores, [{sourceKey: 'good', score: 0.2}]);
  assert.deepEqual(result.failures, [{sourceKey: 'bad', code: 'IMAGE_PREPARATION_FAILED'}]);
  await assert.rejects(classifyImages(config, [sample('bad', Buffer.from('invalid'))], async () => { throw new Error('must not call network'); }, new AbortController().signal), /NSFW_NO_VALID_IMAGES/u);
});

test('classifier strictly rejects invalid scores, failed HTTP and oversized responses without leaking server content', async () => {
  for (const body of [{answers: {}}, {answers: {nsfw_0: {type: 'noul', noul: 1.1}}}, {answers: {nsfw_0: {type: 'choice', noul: 0.9}}}, {answers: {nsfw_0: {type: 'noul', noul: '0.9'}}}]) {
    await assert.rejects(classifyImages(config, [sample()], async () => Response.json(body), new AbortController().signal), /NSFW_INVALID_RESPONSE/u);
  }
  await assert.rejects(classifyImages(config, [sample()], async () => new Response('synthetic private server details', {status: 401}), new AbortController().signal), (error: unknown) => error instanceof ForwardNsfwError && error.code === 'NSFW_HTTP_ERROR' && error.httpStatus === 401 && !error.message.includes('private'));
  await assert.rejects(classifyImages(config, [sample()], async () => new Response(' '.repeat(70 * 1024)), new AbortController().signal), /NSFW_INVALID_RESPONSE/u);
});

test('classifier timeout bounds fetch implementations that ignore AbortSignal', async () => {
  const result = classifyImages({...config, timeoutSeconds: 1}, [sample()], () => new Promise(() => {}), new AbortController().signal);
  const keepAlive = setTimeout(() => {}, 3000);
  try { await assert.rejects(result, /NSFW_TIMEOUT/u); } finally { clearTimeout(keepAlive); }
});


test('classifier reads lazy samples sequentially and sends one image per independent request', async () => {
  const reads: string[] = [];
  let calls = 0;
  const result = await classifyImages(config, [
    {sourceKey: 'first', read: async () => {reads.push('first'); return {bytes: image(), mimeType: 'image/png'};}},
    {sourceKey: 'unreadable', read: async () => {reads.push('unreadable'); throw new Error('synthetic file unavailable');}},
    {sourceKey: 'last', read: async () => {reads.push('last'); return {bytes: image(401), mimeType: 'image/png'};}},
  ], async (_url, init) => {
    assert.deepEqual(reads, ['first', 'unreadable', 'last']);
    const body = JSON.parse(String(init?.body));
    assert.equal(Object.keys(body.assets).length, 1);
    assert.equal(body.state.images.length, 1);
    assert.deepEqual(Object.keys(body.questions), ['nsfw_0']);
    return success(calls++ ? 0.8 : 0.1);
  }, new AbortController().signal);
  assert.deepEqual(result.scores, [{sourceKey: 'first', score: 0.1}, {sourceKey: 'last', score: 0.8}]);
  assert.deepEqual(result.failures, [{sourceKey: 'unreadable', code: 'IMAGE_PREPARATION_FAILED'}]);
  assert.equal(result.requestCount, 2);
});

test('classifier limits concurrent requests to two and preserves input ordering and aggregate usage', async () => {
  let active = 0, maximum = 0, calls = 0;
  const result = await classifyImages(config, [0, 1, 2, 3].map(index => sample(String(index), image(400 + index))), async () => {
    const index = calls++; active++; maximum = Math.max(maximum, active);
    await delay(index ? 5 : 25); active--; return success(index / 10);
  }, new AbortController().signal);
  assert.equal(maximum, 2); assert.equal(calls, 4);
  assert.deepEqual(result.scores, [0, 1, 2, 3].map(index => ({sourceKey: String(index), score: index / 10})));
  assert.deepEqual(result.usage, {inputTokens: 80, outputTokens: 8});
});

test('one timed-out or invalid image cannot discard another image score', async () => {
  let calls = 0;
  const keepAlive = setTimeout(() => {}, 4000);
  try {
    const result = await classifyImages({...config, timeoutSeconds: 1}, [0, 1, 2].map(index => sample(String(index), image(400 + index))), async () => {
      const index = calls++;
      if (index === 0) return new Promise(() => {});
      if (index === 1) return success(0.95);
      return Response.json({answers: {nsfw_0: {type: 'noul', noul: 'invalid'}}});
    }, new AbortController().signal);
    assert.deepEqual(result.scores, [{sourceKey: '1', score: 0.95}]);
    assert.deepEqual(result.failures, [{sourceKey: '0', code: 'NSFW_TIMEOUT'}, {sourceKey: '2', code: 'NSFW_INVALID_RESPONSE'}]);
    assert.equal(result.requestCount, 3);
  } finally { clearTimeout(keepAlive); }
});

test('all failed images preserve per-image HTTP reasons and request metrics', async () => {
  let calls = 0;
  await assert.rejects(classifyImages(config, [sample('first'), sample('second', image(401))], async () => new Response('synthetic private details', {status: calls++ ? 503 : 401}), new AbortController().signal), (error: unknown) => {
    assert.ok(error instanceof ForwardNsfwError);
    assert.equal(error.code, 'NSFW_HTTP_ERROR'); assert.equal(error.httpStatus, 401);
    assert.deepEqual(error.failures, [{sourceKey: 'first', code: 'NSFW_HTTP_ERROR', httpStatus: 401}, {sourceKey: 'second', code: 'NSFW_HTTP_ERROR', httpStatus: 503}]);
    assert.equal(error.metrics?.requestCount, 2); assert.ok(error.metrics!.requestBytes > 0);
    assert.doesNotMatch(error.message, /private/u); return true;
  });
});

test('cancelling the job aborts both requests and never starts remaining images', async () => {
  const controller = new AbortController(); let calls = 0, aborted = 0;
  const operation = classifyImages(config, [0, 1, 2, 3].map(index => sample(String(index), image(400 + index))), async (_url, init) => {
    calls++;
    const pending = new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => {aborted++; reject(new Error('synthetic aborted'));}, {once: true}));
    if (calls === 2) queueMicrotask(() => controller.abort());
    return pending;
  }, controller.signal);
  await assert.rejects(operation, (error: unknown) => error instanceof ForwardNsfwError && error.code === 'NSFW_CANCELLED' && error.metrics?.requestCount === 2);
  assert.equal(calls, 2); assert.equal(aborted, 2);
});

test('waiting for a shared request slot does not consume the per-image HTTP timeout', async () => {
  let released = 0;
  const result = await classifyImages({...config, timeoutSeconds: 1}, [sample()], async () => success(), new AbortController().signal, undefined,
    {acquireRequest: async () => {await delay(1100); return () => {released++;};}});
  assert.equal(result.scores.length, 1); assert.equal(released, 1); assert.equal(result.requestCount, 1);
});

test('identical images in a batch share one request and preserve each source key', async () => {
  let calls = 0;
  const bytes = image(), hash = createHash('sha256').update(bytes).digest('hex');
  const result = await classifyImages(config, [sample('first', bytes), {sourceKey: 'second', sha256: hash, read: async () => {throw new Error('duplicate must not read');}}, sample('third', bytes)], async () => {calls++; return success(0.92);}, new AbortController().signal);
  assert.equal(calls, 1); assert.equal(result.requestCount, 1); assert.equal(result.cacheHits, 2);
  assert.deepEqual(result.scores, ['first', 'second', 'third'].map(sourceKey => ({sourceKey, score: 0.92})));
});

test('successful score cache skips source reads and changes in threshold do not invalidate it', async () => {
  const cache = memoryCache(), bytes = image(), sha256 = createHash('sha256').update(bytes).digest('hex');
  const first = await classifyImages(config, [sample()], async () => success(0.75), new AbortController().signal, cache);
  assert.equal(first.requestCount, 1); assert.equal(cache.prepared.size, 1); assert.equal(cache.scores.size, 1);
  const second = await classifyImages({...config, nsfwThresholdPercent: 70, warningText: 'Synthetic replacement warning.', timeoutSeconds: 1}, [{sourceKey: 'later', sha256, read: async () => {throw new Error('score hit must not read');}}], async () => {throw new Error('score hit must not request');}, new AbortController().signal, cache);
  assert.deepEqual(second.scores, [{sourceKey: 'later', score: 0.75}]);
  assert.equal(second.cacheHits, 1); assert.equal(second.requestCount, 0); assert.equal(second.requestBytes, 0); assert.equal(second.usage, undefined);
  const withoutHash = await classifyImages(config, [{sourceKey: 'unhashed', read: async () => ({bytes, mimeType: 'image/png'})}], async () => {throw new Error('computed hash should find score');}, new AbortController().signal, cache);
  assert.equal(withoutHash.cacheHits, 1);
});

test('score cache isolates endpoint model credentials instructions and source bytes while reusing prepared images', async () => {
  const cache = memoryCache(), bytes = image(), sha256 = createHash('sha256').update(bytes).digest('hex');
  await classifyImages(config, [sample()], async () => success(), new AbortController().signal, cache);
  const variants = [{...config, baseUrl: 'https://other.example/v1'}, {...config, model: 'synthetic-other-model'}, {...config, apiKey: 'synthetic-other-key'}, {...config, instructions: 'Synthetic alternate policy.'}];
  for (const variant of variants) {
    const result = await classifyImages(variant, [{sourceKey: 'same-image', sha256, read: async () => {throw new Error('prepared image should be reused');}}], async () => success(0.5), new AbortController().signal, cache);
    assert.equal(result.requestCount, 1); assert.equal(result.cacheHits, 0); assert.equal(result.preparedCacheHits, 1);
  }
  assert.equal(cache.prepared.size, 1); assert.equal(cache.scores.size, 5);
  const changedImage = await classifyImages(config, [sample('different', image(401))], async () => success(), new AbortController().signal, cache);
  assert.equal(changedImage.requestCount, 1); assert.equal(changedImage.cacheHits, 0);
  for (const key of [...cache.scores.keys(), ...cache.prepared.keys()]) assert.match(key, /^[a-f0-9]{64}$/u);
});

test('failed requests are retried later using prepared cache without caching failures', async () => {
  const cache = memoryCache();
  await assert.rejects(classifyImages(config, [sample()], async () => new Response('', {status: 503}), new AbortController().signal, cache), /NSFW_HTTP_ERROR/u);
  assert.equal(cache.scores.size, 0); assert.equal(cache.prepared.size, 1);
  const later = await classifyImages(config, [sample()], async () => success(), new AbortController().signal, cache);
  assert.equal(later.requestCount, 1); assert.equal(later.preparedCacheHits, 1); assert.equal(cache.scores.size, 1);
});

test('unavailable or malformed caches degrade to fresh classification without turning successes into failures', async () => {
  for (const badRead of ['throw', 'malformed']) {
    const cache: NsfwClassificationCache = {
      getScore() {if (badRead === 'throw') throw new Error('synthetic storage unavailable'); return {score: Number.NaN};},
      getPrepared() {if (badRead === 'throw') throw new Error('synthetic storage unavailable'); return {type: 'image', mimeType: 'image/png', data: 'not a PNG'};},
      setPrepared() {throw new Error('synthetic storage full');}, setScore() {throw new Error('synthetic storage full');},
    };
    const result = await classifyImages(config, [sample()], async () => success(0.8), new AbortController().signal, cache);
    assert.deepEqual(result.scores, [{sourceKey: 'forward:/n0/s0', score: 0.8}]);
    assert.deepEqual(result.failures, []); assert.equal(result.requestCount, 1); assert.equal(result.cacheHits, 0);
  }
});
