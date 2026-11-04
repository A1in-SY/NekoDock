import assert from 'node:assert/strict';
import test from 'node:test';
import { createIncomingImageRemote } from '../src/incoming-image-remote.js';

const identity = { url: 'http://console.invalid', botId: 'worker-example', token: 'synthetic-private-token', dataDir: '/unused' };
const item = { id: 'image-example', messageId: 'message-example', index: 0, status: 'ready', sha256: 'a'.repeat(64), mimeType: 'image/png', size: 4 };
const signal = () => new AbortController().signal;

test('image transfer authenticates every operation, validates metadata and preserves binary bytes', async () => {
  const requests: Array<{ url: string; body: unknown }> = [];
  const request: typeof fetch = async (input, init) => {
    const url = String(input);
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${identity.token}`);
    assert.equal(init?.redirect, 'error'); requests.push({ url, body: init?.body });
    if (url.endsWith('/content')) return new Response(Buffer.from([1, 2, 3, 4]));
    return Response.json(url.endsWith('/ack') ? { ok: true } : url.endsWith('/image-example') ? item : { images: [item] });
  };
  const remote = createIncomingImageRemote(identity, 8, 1000, request);
  assert.deepEqual(await remote.list(signal()), [item]);
  assert.deepEqual(await remote.get(item.id, signal()), item);
  assert.deepEqual(await remote.content(item.id, signal()), Buffer.from([1, 2, 3, 4]));
  await remote.acknowledge(item.id, item.sha256, signal());
  assert.deepEqual(JSON.parse(String(requests.at(-1)!.body)), { sha256: item.sha256 });
  await assert.rejects(remote.content('../other-worker', signal()), /IMAGE_TRANSFER_INVALID/);
  assert.equal(requests.length, 4);
});

test('image transfer rejects oversized and invalid replies without exposing response bodies', async () => {
  const tooLarge = createIncomingImageRemote(identity, 4, 1000, async () => new Response('private-body', { headers: { 'content-length': '12' } }));
  await assert.rejects(tooLarge.content(item.id, signal()), /IMAGE_TRANSFER_TOO_LARGE/);
  const streamed = createIncomingImageRemote(identity, 4, 1000, async () => new Response('private-body'));
  await assert.rejects(streamed.content(item.id, signal()), /IMAGE_TRANSFER_TOO_LARGE/);
  const missing = createIncomingImageRemote(identity, 4, 1000, async () => new Response('private-body', { status: 404 }));
  await assert.rejects(missing.get(item.id, signal()), /IMAGE_TRANSFER_UNAVAILABLE/);
  const invalid = createIncomingImageRemote(identity, 4, 1000, async () => Response.json({ ...item, sha256: 'invalid' }));
  await assert.rejects(invalid.get(item.id, signal()), /IMAGE_TRANSFER_INVALID/);
});

test('media polling advances past unacknowledged pages and restarts after reaching the end', async () => {
  const paths: string[] = [];
  const remote = createIncomingImageRemote(identity, 8, 1000, async input => {
    paths.push(String(input));
    return Response.json({ images: [item], nextCursor: paths.length === 1 ? item.id : null });
  });
  await remote.list(signal()); await remote.list(signal()); await remote.list(signal());
  assert.equal(paths[1], `${paths[0]}?after=${item.id}`);
  assert.equal(paths[2], paths[0]);
});
