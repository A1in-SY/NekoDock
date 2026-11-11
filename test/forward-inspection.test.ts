import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ForwardInspectionCollector, type ForwardInspectionSample } from '../src/forward-inspection.js';
import { resolveForwardContents } from '../src/forward-resolver.js';
import { FORWARD_LIMITS } from '../src/forward-contract.js';

const text = (value: string) => ({ type: 'text', data: { text: value } });
const image = (index: number, extra = {}) => ({ type: 'image', data: { url: `https://example.invalid/${index}.png`, ...extra } });
const message = (...segments: unknown[]) => ({ message: segments });
const forward = (...nodes: unknown[]) => ({ type: 'forward', data: { content: nodes } });

async function inspect(event: unknown, maxImages = 4, register?: (key: string, source: string) => string | null) {
  const collector = new ForwardInspectionCollector(maxImages, { randomInt: () => 0 });
  const contents = await resolveForwardContents(event, { signal: new AbortController().signal, deadline: Date.now() + 2000,
    fetch: async () => { throw new Error('synthetic lookup failure'); }, image: register ?? (key => key), observer: collector });
  return { summary: collector.summary(), contents };
}

test('inspection counts real messages across nested forwards and excludes wrapper and empty nodes', async () => {
  const { summary } = await inspect({ message: [forward(
    message(forward(message(image(1), text('caption')), message(text('discussion')))),
    message(image(2), image(3)), message(text(' ')), message({ type: 'face', data: { id: 1 } }),
  )] });
  assert.equal(summary.structuralComplete, true);
  assert.equal(summary.messageCount, 4);
  assert.equal(summary.imageMessageCount, 2);
  assert.equal(summary.imageCount, 3);
});

test('sampling observes stickers and pictures after the ordinary sixty-four attachment limit', async () => {
  let registered = 0;
  const { summary, contents } = await inspect({ message: [forward(
    ...Array.from({ length: 75 }, (_, i) => message(image(i))),
    message(image(75, { sub_type: 1, summary: 'synthetic sticker' })),
  )] }, 1, key => ++registered <= 64 ? `asset:${key}` : null);
  assert.equal(summary.structuralComplete, true, 'chat cache exhaustion does not truncate the parsed structure');
  assert.equal(summary.messageCount, 76);
  assert.equal(summary.imageMessageCount, 76);
  assert.equal(summary.imageCount, 76);
  assert.equal(summary.samples.length, 1);
  assert.equal(summary.samples[0]!.source, 'https://example.invalid/75.png');
  assert.equal(summary.samples[0]!.attachmentId, undefined);
  assert.equal(contents[0]!.status, 'partial');
  assert.doesNotMatch(JSON.stringify(contents), /example.invalid/);
});

test('reservoir sampling visits every occurrence and replaces only the selected slot', () => {
  const replaced: Array<[string, string | undefined]> = [];
  const maximums: number[] = [];
  const collector = new ForwardInspectionCollector(2, {
    randomInt: maximum => { maximums.push(maximum); return maximum === 3 ? 1 : 3; },
    sample: (added, removed) => replaced.push([added.sourceKey, removed?.sourceKey]),
  });
  for (let i = 0; i < 4; i++) collector.image(`position-${i}`, `https://example.invalid/${i}`, `asset-${i}`);
  assert.deepEqual(maximums, [3, 4]);
  assert.deepEqual(collector.summary().samples.map(sample => sample.sourceKey), ['position-0', 'position-2']);
  assert.deepEqual(replaced, [['position-0', undefined], ['position-1', undefined], ['position-2', 'position-1']]);
  const copy = collector.summary();
  copy.samples.length = 0;
  assert.equal(collector.summary().samples.length, 2);
});

test('uniform reservoirs give later image occurrences the same selection count', () => {
  const counts = [0, 0, 0];
  // Enumerate all equally likely choices for the third item of a size-two reservoir.
  for (let draw = 0; draw < 3; draw++) {
    const collector = new ForwardInspectionCollector(2, { randomInt: () => draw });
    for (let index = 0; index < 3; index++) collector.image(String(index), undefined);
    for (const sample of collector.summary().samples) counts[Number(sample.sourceKey)]!++;
  }
  assert.deepEqual(counts, [2, 2, 2]);
});

test('depth, node, malformed and failed branches mark the ratio as structurally incomplete', async () => {
  let deep: unknown = forward(message(image(1)));
  for (let i = 0; i < 9; i++) deep = forward(message(deep));
  for (const event of [
    { message: [deep] },
    { message: [forward(...Array.from({ length: FORWARD_LIMITS.nodes + 1 }, () => message(image(1))))] },
    { message: [forward({ message: 42 })] },
    { message: [{ type: 'forward', data: { id: 'missing' } }] },
  ]) assert.equal((await inspect(event)).summary.structuralComplete, false);
});

test('observer gets a newly registered attachment synchronously before another branch is awaited', async () => {
  const notifications: ForwardInspectionSample[] = [];
  const collector = new ForwardInspectionCollector(1, { sample: added => notifications.push({ ...added }) });
  await resolveForwardContents({ message: [forward(message(image(1)), message({ type: 'forward', data: { id: 'next' } }))] }, {
    signal: new AbortController().signal, deadline: Date.now() + 2000, observer: collector,
    image: () => 'fresh-attachment', fetch: async () => {
      assert.deepEqual(notifications.map(item => item.attachmentId), ['fresh-attachment']);
      return { messages: [message(text('next'))] };
    },
  });
});
