import test from 'node:test';
import assert from 'node:assert/strict';
import { forwardImageAssetIds, forwardImageAttachment, forwardStatusLabel, gameFacts, gamePrices, gameScore, incomingImageUrl, liveStatusLabels, nativeIncomingImages, pluginAssetUrl, pluginMediaAssetId, sharedContentKind, sharedContentLink, sharedContentPlatform, sharedContentTime, sharedImageCaption } from '../src/shared-content-state.ts';

test('plugin images use instance authenticated asset routes rather than source URLs', () => {
  assert.equal(pluginAssetUrl('bot-example', 'asset-123'), '/api/bots/bot-example/plugins/assets/asset-123');
  for (const id of ['https://cdn.example/image.jpg', '../other', 'asset?signature=secret', '', undefined]) assert.equal(pluginAssetUrl('bot-example', id), undefined);
  assert.equal(pluginAssetUrl('bot/other', 'asset-123'), '/api/bots/bot%2Fother/plugins/assets/asset-123');
});

test('content image source IDs cannot override authenticated media asset IDs', () => {
  assert.equal(pluginAssetUrl('bot-example', pluginMediaAssetId({ id: 'source-cover', assetId: 'asset-ready' })), '/api/bots/bot-example/plugins/assets/asset-ready');
  assert.equal(pluginAssetUrl('bot-example', pluginMediaAssetId({ id: 'asset-snapshot' })), '/api/bots/bot-example/plugins/assets/asset-snapshot');
  assert.equal(pluginAssetUrl('bot-example', pluginMediaAssetId(undefined)), undefined);
});

test('shared links accept dynamic and live canonical hosts while rejecting misleading hosts and credentials', () => {
  for (const url of ['https://t.bilibili.com/123', 'https://www.bilibili.com/opus/123', 'https://live.bilibili.com/123']) assert.equal(sharedContentLink(url, 'bilibili'), url);
  for (const url of ['javascript:alert(1)', 'https://live.bilibili.com.evil.invalid/123', 'https://user:secret@live.bilibili.com/123', 'https://live.bilibili.com:8443/123']) assert.equal(sharedContentLink(url, 'bilibili'), undefined);
});

test('game and short video links stay on the matching platform without credentials or custom ports', () => {
  for (const url of ['https://api.xiaoheihe.cn/game/share_game_detail?appid=abc123&game_type=pc', 'https://www.xiaoheihe.cn/app/topic/game/console/10001']) assert.equal(sharedContentLink(url, 'heybox'), url);
  for (const url of ['https://v.douyin.com/Synthetic/', 'https://www.douyin.com/video/123', 'https://www.iesdouyin.com/share/video/123/']) assert.equal(sharedContentLink(url, 'douyin'), url);
  for (const platform of ['heybox', 'douyin']) {
    for (const url of ['javascript:alert(1)', 'https://example.invalid/game', 'https://www.douyin.com.evil.invalid/video/123', 'https://api.xiaoheihe.cn.evil.invalid/game', 'http://127.0.0.1/game']) assert.equal(sharedContentLink(url, platform), undefined);
  }
  for (const [url, platform] of [
    ['https://user:secret@api.xiaoheihe.cn/game/share_game_detail', 'heybox'],
    ['https://www.xiaoheihe.cn:8443/app/topic/game/pc/123', 'heybox'],
    ['https://user:secret@www.douyin.com/video/123', 'douyin'],
    ['https://www.douyin.com:8443/video/123', 'douyin'],
    ['https://www.douyin.com/video/123', 'heybox'],
    ['https://www.xiaoheihe.cn/app/topic/game/pc/123', 'douyin'],
  ]) assert.equal(sharedContentLink(url, platform), undefined);
});

test('content timestamps retain seconds precision and live statuses stay distinct', () => {
  assert.equal(sharedContentTime(1_700_000_001), 1_700_000_001_000);
  for (const value of [0, -1, NaN, Infinity, '1700000001', 1_700_000_001_000]) assert.equal(sharedContentTime(value), undefined);
  assert.deepEqual(['post', 'live', 'video', 'game'].map(sharedContentKind), ['动态', '直播', '视频', '游戏']);
  assert.deepEqual(['live', 'offline', 'replay'].map(status => liveStatusLabels[status]), ['直播中', '未开播', '轮播中']);
});

test('platform and image labels distinguish game assets, video covers and generated presentations', () => {
  assert.deepEqual(['bilibili', 'heybox', 'douyin', 'unknown'].map(sharedContentPlatform), ['哔哩哔哩', '小黑盒', '抖音', undefined]);
  assert.equal(sharedImageCaption('game', 'cover'), '游戏封面');
  assert.equal(sharedImageCaption('game', 'presentation'), '游戏资料卡片');
  assert.equal(sharedImageCaption('video', 'cover'), '视频封面');
  assert.equal(sharedImageCaption('post', 'content'), '动态配图');
  assert.equal(sharedImageCaption('video', 'content'), '分享图片');
});

test('game facts retain the selected platform and omit missing basic information', () => {
  assert.deepEqual(gameFacts({ platform: 'epic', platformName: 'Epic', releaseDate: '2030年01月01日', developers: ['Example Studio'], publishers: [], platforms: [{ name: 'Steam' }, { name: 'Epic' }, { name: 'Steam' }]}), [
    { label: '当前平台', value: 'Epic' },
    { label: '发行日期', value: '2030年01月01日' },
    { label: '开发商', value: 'Example Studio' },
    { label: '游戏平台', value: 'Steam / Epic' },
  ]);
  assert.deepEqual(gameFacts({ developers: [undefined, 42], publishers: {}, platforms: null }), []);
  assert.deepEqual(gameFacts(undefined), []);
});

test('game scores preserve their source and scale without inventing missing counts', () => {
  assert.deepEqual(gameScore({ score: { source: 'heybox', value: 8.4, scale: 10, count: 1200 } }), { label: '小黑盒评分', value: '8.4 / 10', count: 1200 });
  assert.deepEqual(gameScore({ score: { source: 'Example', value: 84, scale: 100 } }), { label: 'Example评分', value: '84 / 100' });
  for (const score of [{ value: 11, scale: 10 }, { value: -1, scale: 10 }, { value: NaN, scale: 10 }, { value: 0, scale: 0 }, { value: '8.4', scale: 10 }]) assert.equal(gameScore({ score }), undefined);
  assert.equal(gameScore(undefined), undefined);
});

test('game prices keep platform prices separate from conditional mall offers and scoped recorded lows', () => {
  assert.deepEqual(gamePrices({ prices: [
    { source: 'platform', label: 'Epic', current: '80', original: '100', currency: 'CNY', region: '中国', discountPercent: 20, recordedLowest: '60' },
    { source: 'heybox', label: '商城券后价', current: '75', currency: 'CNY', condition: '先领券；新用户可用' },
  ] }), [
    { label: 'Epic', source: '平台商店', current: '80 CNY', original: '100 CNY', discount: '优惠 20%', region: '中国', lowest: '小黑盒记录史低（该平台） 60 CNY' },
    { label: '商城券后价', source: '小黑盒商城', current: '75 CNY', condition: '先领券；新用户可用' },
  ]);
  assert.deepEqual(gamePrices({ prices: [{ source: 'platform', current: '0', original: '0', discountPercent: 0 }, { source: 'unknown', current: '50' }, { source: 'heybox' }] }), [
    { label: '平台商店', source: '平台商店', current: '0' },
  ]);
  assert.deepEqual(gamePrices(undefined), []);
});

test('plugin source images are not duplicated through the ordinary incoming image endpoint', () => {
  const native = {attachmentId:'qq-image',status:'ready'}, plugin = {attachmentId:'plugin:source-image',origin:'plugin',assetId:'asset-123',status:'ready'};
  assert.deepEqual(nativeIncomingImages([native,plugin]),[native]);
  assert.deepEqual(nativeIncomingImages([plugin]),[]);
  assert.deepEqual(nativeIncomingImages(undefined),[]);
});

test('nested forwarded images stay at their source node without duplicating outer attachments', () => {
  const contents = [{ type: 'forward', status: 'partial', nodes: [{ segments: [
    { type: 'image', assetId: 'forward-first' },
    { type: 'forward', status: 'ready', nodes: [{ segments: [{ type: 'image', assetId: 'forward-nested' }, { type: 'image', assetId: 'forward-first' }] }] },
  ] }] }, { type: 'video', assetId: 'ordinary' }];
  const outer = { attachmentId: 'ordinary', status: 'ready', path: '/data/workspace/.qq-images/outer.png' };
  const first = { attachmentId: 'forward-first', status: 'pending' };
  const nested = { attachmentId: 'forward-nested', status: 'ready', path: '/data/workspace/.qq-images/nested.png' };
  const images = [outer, first, nested];
  assert.deepEqual([...forwardImageAssetIds(contents)], ['forward-first', 'forward-nested']);
  assert.deepEqual(nativeIncomingImages(images, contents), [outer]);
  assert.strictEqual(forwardImageAttachment('forward-nested', images), nested);
  assert.strictEqual(forwardImageAttachment('forward-first', images), first);
  assert.equal(forwardImageAttachment('missing', images), undefined);
  assert.deepEqual(images, [outer, first, nested]);
});

test('forwarded images only display authenticated cached files with an exact attachment association', () => {
  assert.equal(incomingImageUrl('bot/other', { status: 'ready', path: '/data/workspace/image #1.png' }), '/api/bots/bot%2Fother/media?path=%2Fdata%2Fworkspace%2Fimage%20%231.png');
  for (const image of [undefined, { status: 'ready', url: 'https://example.invalid/signed-image' }, { status: 'ready', path: 'relative.png' }, { status: 'pending', path: '/old.png' }, { status: 'expired', path: '/old.png' }]) assert.equal(incomingImageUrl('bot-example', image), undefined);
  assert.equal(forwardImageAttachment('other', [{ attachmentId: 'inner', assetId: 'other' }]), undefined);
  assert.equal(forwardImageAttachment(undefined, []), undefined);
});

test('forward status and missing metadata remain distinct without fabricated identities or times', () => {
  assert.deepEqual(['pending', 'ready', 'partial', 'failed', undefined].map(forwardStatusLabel), ['正在读取聊天记录', '', '部分内容未读取', '聊天记录读取失败', '聊天记录状态未知']);
  assert.deepEqual([...forwardImageAssetIds([{ type: 'forward', nodes: [null, { segments: null }] }])], []);
  assert.equal(sharedContentTime(undefined), undefined);
});
