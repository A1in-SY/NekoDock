import test from 'node:test';
import assert from 'node:assert/strict';
import { bilibiliResources, normalizeBilibiliResource } from '../src/plugins/bilibili/recognize.js';

test('confirmed zh-Hans video paths normalize BV and av links with their requested part', () => {
  for (const id of ['BV0123456789', 'av123456']) {
    for (const host of ['www.bilibili.com', 'bilibili.com', 'm.bilibili.com']) {
      assert.deepEqual(normalizeBilibiliResource(`https://${host}/zh-Hans/video/${id}?p=2&share_source=copy`), {
        kind: 'video', id: `${id}:p2`, url: `https://www.bilibili.com/video/${id}?p=2`, part: 2,
      });
    }
    assert.deepEqual(normalizeBilibiliResource(`http://www.bilibili.com/zh-Hans/video/${id}/`), {
      kind: 'video', id: `${id}:p1`, url: `https://www.bilibili.com/video/${id}`, part: 1,
    });
  }
});

test('localized video shares retain the complete URL and part in text and card inputs', () => {
  for (const id of ['BV0123456789', 'av123456']) {
    const url = `https://www.bilibili.com/zh-Hans/video/${id}?share_source=copy&p=3`;
    const resource = { kind: 'video', id: `${id}:p3`, url: `https://www.bilibili.com/video/${id}?p=3`, part: 3 };
    assert.deepEqual(bilibiliResources({ message: `分享 ${url}。` }), [resource]);
    assert.deepEqual(bilibiliResources({ message: [{ type: 'text', data: { text: url } }] }), [resource]);
    for (const field of ['qqdocurl', 'url', 'jumpUrl']) {
      const card = { meta: { detail_1: { [field]: url, desc: 'Synthetic video title' } } };
      for (const data of [card, JSON.stringify(card)]) {
        assert.deepEqual(bilibiliResources({ message: [{ type: 'json', data: { data } }] }), [
          { ...resource, title: 'Synthetic video title' },
        ]);
      }
    }
    assert.deepEqual(bilibiliResources({ message: `${url} https://www.bilibili.com/video/${id}?p=3` }), [resource]);
  }
});

test('localized video support keeps other prefixes, paths and URL authorities outside the allowlist', () => {
  for (const url of [
    'https://www.bilibili.com/zh-Hant/video/BV0123456789',
    'https://www.bilibili.com/en/video/BV0123456789',
    'https://www.bilibili.com/zh-hans/video/BV0123456789',
    'https://www.bilibili.com/arbitrary/zh-Hans/video/BV0123456789',
    'https://www.bilibili.com/zh-Hans/opus/100001',
    'https://live.bilibili.com/zh-Hans/100001',
    'https://www.bilibili.com/zh-Hans/video/BV0123456789/extra',
    'https://www.bilibili.com.evil.example/zh-Hans/video/BV0123456789',
    'https://user:password@www.bilibili.com/zh-Hans/video/BV0123456789',
    'https://www.bilibili.com:8443/zh-Hans/video/BV0123456789',
    'ftp://www.bilibili.com/zh-Hans/video/BV0123456789',
  ]) assert.equal(normalizeBilibiliResource(url), null, url);
});
