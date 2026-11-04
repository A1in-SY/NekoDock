import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryFtsQuery, memoryIndexText, memoryRelevance, memoryTerms } from '../src/memory-search.js';

test('indexes Chinese unigrams and bigrams without requiring spaces',()=>{
  assert.ok(memoryTerms('我喜欢无糖咖啡，生日在三月').includes('咖啡'));
  assert.ok(memoryTerms('我喜欢无糖咖啡，生日在三月').includes('生日'));
  assert.equal(memoryFtsQuery('咖啡'),'"咖啡"');
  assert.ok(memoryIndexText('Coffee 无糖咖啡').includes('coffee'));
  assert.ok(memoryRelevance('咖啡','喜欢咖啡')>memoryRelevance('咖啡','喜欢茶'));
});

test('FTS expressions are quoted data and normalization is stable',()=>{
  assert.equal(memoryFtsQuery('COFFEE OR "tea"'),'"coffee" OR "or" OR "tea"');
  assert.equal(memoryIndexText('Ｃｏｆｆｅｅ'),memoryIndexText('coffee'));
  assert.equal(memoryFtsQuery('???'),'');
});
