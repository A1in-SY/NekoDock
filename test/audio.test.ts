import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMp3, isMp3Snapshot } from '../src/audio.js';

const frame = Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0]);

test('语音快照只接受规范 Base64 的 MPEG Layer III 数据，兼容 ID3', () => {
  for (const version of [2, 3, 4]) {
    const tagged = Buffer.concat([Buffer.from([0x49, 0x44, 0x33, version, 0, 0, 0, 0, 0, 2, 0, 0]), frame]);
    assert.equal(isMp3(tagged), true);
    assert.equal(isMp3Snapshot(`base64://${tagged.toString('base64')}`), true);
  }
  assert.equal(isMp3(frame), true);
  assert.equal(isMp3Snapshot(`base64://${frame.toString('base64')}`), true);
  for (const value of ['', 'base64://', '/data/voice.mp3', 'https://example.com/voice.mp3', null,
    `base64://${frame.toString('base64')}\n`, 'base64://<html>', `base64://${Buffer.from('ID3not-mp3').toString('base64')}`,
    `base64://${Buffer.from('<html>HTTP error</html>').toString('base64')}`]) {
    assert.equal(isMp3Snapshot(value), false);
  }
  for (const bytes of [[], [0xff, 0xfb, 0x90, 0x64], [0xff, 0xeb, 0x90, 0x64, 0],
    [0xff, 0xfb, 0x0c, 0x64, 0], [0xff, 0xfb, 0xfc, 0x64, 0], [0xff, 0xff, 0x90, 0x64, 0],
    [0x49, 0x44, 0x33, 4, 0, 0, 0x80, 0, 0, 0, ...frame],
    [0x49, 0x44, 0x33, 4, 0, 0, 0x7f, 0x7f, 0x7f, 0x7f, ...frame]]) {
    assert.equal(isMp3(Buffer.from(bytes)), false);
  }
});
