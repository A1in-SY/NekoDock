import test from 'node:test';
import assert from 'node:assert/strict';
import {presetConfigPatch, presetStatus} from '../src/model-preset-state.ts';
import type {PublicModelPreset} from '../../src/model-preset-contract.ts';

test('selecting a preset excludes stale model fields and credentials from instance form submissions', () => {
  const config = {model: 'old', baseUrl: 'https://old.example', modelApiKey: 'stale-key', supportsImages: false, compactLimit: 100, persona: 'retained', searchProvider: 'tavily'};
  assert.deepEqual(presetConfigPatch(config, {id: 'new', revision: 3}), {persona: 'retained', searchProvider: 'tavily'});
  assert.deepEqual(presetConfigPatch(config, null), config);
  assert.deepEqual(presetConfigPatch(config), config);
});
test('preset labels distinguish custom, applied, updated and deleted snapshots', () => {
  const binding = {id: 'a', revision: 1, name: 'Example'};
  assert.equal(presetStatus(undefined, []), '自定义配置');
  assert.equal(presetStatus(binding, [{id: 'a', revision: 1} as PublicModelPreset]), 'Example · v1');
  assert.match(presetStatus(binding, [{id: 'a', revision: 2} as PublicModelPreset]), /有更新 v2/u);
  assert.match(presetStatus(binding, []), /预设已删除，保留当前配置/u);
});
