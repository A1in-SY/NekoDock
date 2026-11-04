import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { defaultSettings, normalizeSettings, settingsFromEnv, settingsToEnv, validateSettings } from '../src/console/settings.js';

const base = { NAPCAT_WS_URL: 'ws://localhost:3001', TARGET_TYPE: 'group', TARGET_ID: '10001' };

test('image retention defaults populate old settings without changing other values', () => {
  const old = normalizeSettings({ imageTimeout: 9, persona: 'Example persona' });
  assert.equal(old.imageCacheDays, 30);
  assert.equal(old.imageCacheMaxMiB, 2048);
  assert.equal(old.imageTransitHours, 24);
  assert.equal(old.imageTransitMaxMiB, 1024);
  assert.equal(old.imageTimeout, 9);
  assert.equal(old.persona, 'Example persona');
  const worker = loadConfig(base);
  assert.equal(worker.imageCacheDays, 30);
  assert.equal(worker.imageCacheMaxBytes, 2048 * 1024 * 1024);
});

test('worker retention settings project to env in the correct units and import back', () => {
  const settings = validateSettings({ imageCacheDays: 7, imageCacheMaxMiB: 64, napcatToken: '' });
  const env = settingsToEnv(settings, { type: 'private', id: '10001' });
  assert.equal(env.IMAGE_CACHE_DAYS, '7');
  assert.equal(env.IMAGE_CACHE_MAX_BYTES, String(64 * 1024 * 1024));
  assert.equal(loadConfig(env).imageCacheMaxBytes, 64 * 1024 * 1024);
  assert.deepEqual(settingsFromEnv(env), settings);
  const customTransit = validateSettings({ imageTransitHours: 36, imageTransitMaxMiB: 128 });
  assert.equal(customTransit.imageTransitHours, 36);
  assert.equal(customTransit.imageTransitMaxMiB, 128);
  assert.equal(Object.keys(settingsToEnv(customTransit, { type: 'group', id: '10001' })).some(key => key.startsWith('IMAGE_TRANSIT')), false);
});

test('cache configuration rejects fractional values, unsafe conversions and invalid worker input', () => {
  for (const field of ['imageCacheDays', 'imageCacheMaxMiB', 'imageTransitHours', 'imageTransitMaxMiB']) {
    for (const value of [0, -1, 0.5, Number.MAX_SAFE_INTEGER, Infinity, 'private-invalid-value']) {
      assert.throws(() => validateSettings({ [field]: value }), error => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(field));
        assert.equal(error.message.includes('private-invalid-value'), false);
        return true;
      });
    }
  }
  for (const name of ['IMAGE_CACHE_DAYS', 'IMAGE_CACHE_MAX_BYTES']) {
    for (const value of ['', '0', '-1', '0.5', 'Infinity', 'private-invalid-value']) {
      assert.throws(() => loadConfig({ ...base, [name]: value }), error => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(name));
        assert.equal(error.message.includes('private-invalid-value'), false);
        return true;
      });
    }
  }
  assert.throws(() => loadConfig({ ...base, IMAGE_CACHE_DAYS: String(Math.floor(Number.MAX_SAFE_INTEGER / 86_400_000) + 1) }), /IMAGE_CACHE_DAYS/);
  assert.equal(defaultSettings().imageCacheDays, 30);
});
