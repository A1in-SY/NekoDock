import test from 'node:test';
import assert from 'node:assert/strict';
import { filterPluginJobs, pluginDefaults, pluginFieldGroups, pluginJobNeedsAttention, pluginPayload, pluginResourceLink } from '../src/plugins-state.ts';
import type { PluginJobView } from '../../src/plugin-contract.ts';

const manifest = { id: 'bilibili', name: 'Video', version: '1', apiVersion: 1, required: false, resourceTypes: ['video'], commands: [], configSchema: { type: 'object', properties: {
  autoVideo: { type: 'boolean', title: '自动发送', default: false },
  maxMiB: { type: 'integer', title: '大小', minimum: 1, maximum: 256, default: 50 },
  cookie: { type: 'string', title: 'Cookie', secret: true },
} } } as any;
const view = { id: 'bilibili', pluginId: 'bilibili', enabled: false, revision: 3, config: {}, configuredSecrets: { cookie: true }, manifest, jobs: [] } as any;

test('plugin defaults exclude secrets and payload preserves an unedited credential', () => {
  const values = pluginDefaults(manifest);
  assert.deepEqual(values, { autoVideo: false, maxMiB: 50 });
  assert.deepEqual(pluginPayload(view, true, values, new Set()), { expectedRevision: 3, enabled: true, config: values });
});
test('plugin credential replacement and clearing are explicit', () => {
  const defaults = pluginDefaults(manifest);
  assert.equal(pluginPayload(view, true, { ...defaults, cookie: 'synthetic-session' }, new Set()).config.cookie, 'synthetic-session');
  assert.equal(pluginPayload(view, true, defaults, new Set(['cookie'])).config.cookie, '');
});
test('plugin limits are validated before sending a configuration change', () => {
  for (const maxMiB of [0, 257, 1.5, '', NaN]) assert.throws(() => pluginPayload(view, true, { autoVideo: true, maxMiB }, new Set()), /大小/);
});
test('required core plugin cannot be disabled', () => {
  assert.throws(() => pluginPayload({ ...view, manifest: { ...manifest, required: true } }, false, pluginDefaults(manifest), new Set()), /不可关闭/);
});

const job = (id: string, patch: Partial<PluginJobView> = {}): PluginJobView => ({
  id, pluginId: 'bilibili', sourceMessageId: 'message-' + id, operation: 'download', state: 'completed',
  createdAt: 1_000, attempts: 1, automatic: true, command: 'share', deliveries: [],
  resource: { id: 'BV1234567890:p1', title: '同一秒的视频分享', url: 'https://www.bilibili.com/video/BV1234567890', part: 1, author: '示例作者' }, ...patch,
});

test('plugin record search distinguishes same-second shares by source ID and combines resource terms', () => {
  const jobs = [job('first'), job('second')];
  assert.deepEqual(filterPluginJobs(jobs, 'message-second', 'all').map(item => item.id), ['second']);
  assert.deepEqual(filterPluginJobs(jobs, 'bv1234567890 示例作者', 'all').map(item => item.id), ['first', 'second']);
  assert.deepEqual(filterPluginJobs(jobs, '不存在', 'all'), []);
});

test('plugin record filters keep download completion separate from pending and uncertain sends', () => {
  const jobs = [
    job('queued', { state: 'queued' }),
    job('ack', { deliveries: [{ kind: 'video', status: 'acknowledged', messageId: 'qq-ack' }] }),
    job('pending', { deliveries: [{ kind: 'video', status: 'pending' }] }),
    job('sending', { deliveries: [{ kind: 'video', status: 'sending' }] }),
    job('unknown', { deliveries: [{ kind: 'video', status: 'unconfirmed', code: 'NAPCAT_RESPONSE_TIMEOUT' }] }),
    job('failed', { state: 'failed', error: 'BILIBILI_HTTP_412' }),
    job('send-failed', { deliveries: [{ kind: 'video', status: 'failed' }] }),
  ];
  assert.deepEqual(filterPluginJobs(jobs, '', 'active').map(item => item.id), ['queued', 'pending', 'sending']);
  assert.deepEqual(filterPluginJobs(jobs, '', 'attention').map(item => item.id), ['unknown', 'failed', 'send-failed']);
  assert.equal(pluginJobNeedsAttention(jobs[1]!), false);
  assert.deepEqual(filterPluginJobs(jobs, 'message-unknown', 'attention').map(item => item.id), ['unknown']);
});

test('plugin resource links reject script URLs and embedded credentials', () => {
  assert.equal(pluginResourceLink('javascript:alert(1)'), undefined);
  assert.equal(pluginResourceLink('https://user:secret@example.com/video'), undefined);
  assert.equal(pluginResourceLink('https://www.bilibili.com/video/BV1234567890'), 'https://www.bilibili.com/video/BV1234567890');
  assert.equal(pluginResourceLink('https://www.xiaoheihe.cn/app/topic/game/pc/10001', 'heybox'), 'https://www.xiaoheihe.cn/app/topic/game/pc/10001');
  assert.equal(pluginResourceLink('https://www.douyin.com/video/123', 'douyin'), 'https://www.douyin.com/video/123');
  assert.equal(pluginResourceLink('https://example.invalid/game', 'heybox'), undefined);
  assert.equal(pluginResourceLink('https://example.invalid/video', 'douyin'), undefined);
});

test('grouped display configuration uses declared defaults and rejects unknown enum values', () => {
  const grouped = { ...manifest, configSchema: { type: 'object', properties: {
    enhance: { type: 'boolean', title: '增强', default: true, group: '动态' },
    display: { type: 'string', title: '展示方式', enum: ['off', 'original', 'card'], default: 'off', group: '动态' },
    liveDisplay: { type: 'string', title: '直播展示', enum: ['off', 'original', 'card'], default: 'off', group: '直播' },
    cookie: manifest.configSchema.properties.cookie,
  } } } as any;
  assert.deepEqual(pluginFieldGroups(grouped).map(group => [group.name, group.fields.map(([key]) => key)]), [['动态', ['enhance', 'display']], ['直播', ['liveDisplay']], ['', ['cookie']]]);
  const defaults = pluginDefaults(grouped);
  assert.deepEqual(defaults, { enhance: true, display: 'off', liveDisplay: 'off' });
  assert.equal(pluginPayload({ ...view, manifest: grouped }, true, { ...defaults, display: 'card' }, new Set()).config.display, 'card');
  for (const display of ['image', 'CARD', '', 1]) assert.throws(() => pluginPayload({ ...view, manifest: grouped }, true, { ...defaults, display }, new Set()), /展示方式/u);
});

test('post and live jobs remain searchable and image delivery uncertainty needs attention', () => {
  const jobs = [job('post', { operation: 'prepare', resource: { id: 'post:1234567890123456789', url: 'https://t.bilibili.com/1234567890123456789', title: '示例动态', author: '示例作者' }, deliveries: [{kind:'image',status:'unconfirmed'}] }), job('live', { operation: 'resolve', resource: {id:'live:123456',url:'https://live.bilibili.com/123456',title:'示例直播'} })];
  assert.deepEqual(filterPluginJobs(jobs, '1234567890123456789 示例动态', 'attention').map(item => item.id), ['post']);
  assert.deepEqual(filterPluginJobs(jobs, 'live:123456', 'all').map(item => item.id), ['live']);
});
