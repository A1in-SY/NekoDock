import test from 'node:test';
import assert from 'node:assert/strict';
import { filterPluginJobs, isCommandOnlyPlugin, isForwardInspectionPlugin, pluginDefaults, pluginDeliveryKindLabels, pluginFieldGroups, pluginFieldRows, pluginInspectionOutcomeText, pluginInspectionPercent, pluginInspectionReasonText, pluginJobNeedsAttention, pluginOperationLabels, pluginPayload, pluginRecordTitle, pluginResourceLink, pluginSupportsTarget } from '../src/plugins-state.ts';
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

test('independent plugin behaviors stay peers while declared card options belong only to their parent', () => {
  const settings = { ...manifest, configSchema: { type: 'object', properties: {
    enhance: { type: 'boolean', title: '增强', default: true, group: '游戏行为' },
    autoCard: { type: 'boolean', title: '自动卡片', default: true, group: '游戏行为' },
    showPrices: { type: 'boolean', title: '卡片价格', default: true, group: '游戏行为', parent: 'autoCard' },
    display: { type: 'string', title: '视频展示', enum: ['off', 'card'], default: 'off', group: '视频行为' },
    autoVideo: { type: 'boolean', title: '视频回发', default: false, group: '视频行为' },
  } } } as any;
  const [game, video] = pluginFieldGroups(settings);
  assert.deepEqual(pluginFieldRows(game!.fields).map(row => [row.key, row.children.map(([key]) => key)]), [['enhance', []], ['autoCard', ['showPrices']]]);
  assert.deepEqual(pluginFieldRows(video!.fields).map(row => [row.key, row.children.length]), [['display', 0], ['autoVideo', 0]]);
  const values = { ...pluginDefaults(settings), autoCard: false };
  const payload = pluginPayload({ ...view, manifest: settings }, true, values, new Set());
  assert.equal(payload.config.showPrices, true, 'Turning off a capability retains its child settings');
  assert.equal(payload.config.autoCard, false);
  assert.deepEqual(Object.keys(payload.config).sort(), ['autoCard', 'autoVideo', 'display', 'enhance', 'showPrices']);
});

test('post and live jobs remain searchable and image delivery uncertainty needs attention', () => {
  const jobs = [job('post', { operation: 'prepare', resource: { id: 'post:1234567890123456789', url: 'https://t.bilibili.com/1234567890123456789', title: '示例动态', author: '示例作者' }, deliveries: [{kind:'image',status:'unconfirmed'}] }), job('live', { operation: 'resolve', resource: {id:'live:123456',url:'https://live.bilibili.com/123456',title:'示例直播'} })];
  assert.deepEqual(filterPluginJobs(jobs, '1234567890123456789 示例动态', 'attention').map(item => item.id), ['post']);
  assert.deepEqual(filterPluginJobs(jobs, 'live:123456', 'all').map(item => item.id), ['live']);
});

test('command-only plugins save only their instance switch without media configuration', () => {
  const dice = { ...manifest, id: 'dice', name: '骰子', capabilities: ['commands'], resourceTypes: [], configSchema: undefined,
    commands: [{ name: '/dice', description: '掷骰子', pluginId: 'dice', executor: 'console', contextPolicy: 'chat' }] };
  assert.equal(isCommandOnlyPlugin(dice), true);
  assert.equal(isCommandOnlyPlugin({ ...dice, capabilities: ['commands', 'content-enrichment'] }), false);
  assert.equal(isCommandOnlyPlugin(manifest), false);
  assert.deepEqual(pluginDefaults(dice), {});
  assert.deepEqual(pluginPayload({ ...view, manifest: dice }, true, {}, new Set()), { expectedRevision: 3, enabled: true, config: {} });
});

test('command records show their execution summary without requiring a shared resource', () => {
  const command = job('dice', { pluginId: 'dice', operation: 'execute', automatic: false, command: 'dice', commandName: '/dice', resource: undefined,
    commandExecution: { input: '6 1', summary: '骰子结果：4（范围 1～6）', text: '🎲 骰子结果：4（范围 1～6）', details: [{ label: '范围', value: '1～6' }, { label: '点数', value: '4' }] } });
  assert.equal(pluginRecordTitle(command), '骰子结果：4（范围 1～6）');
  assert.equal(pluginRecordTitle({ ...command, commandExecution: undefined }), '/dice');
  assert.equal(pluginRecordTitle(job('content')), '同一秒的视频分享');
});

test('command record search includes names, raw parameters, results and parameter hints', () => {
  const jobs = [
    job('roll', { pluginId: 'dice', operation: 'execute', automatic: false, command: 'dice', commandName: '/dice', resource: undefined,
      commandExecution: { input: '20 10', summary: '骰子结果：17', text: '🎲 骰子结果：17（范围 10～20）', details: [{ label: '范围', value: '10～20' }] }, deliveries: [{ kind: 'reply', status: 'pending' }] }),
    job('hint', { pluginId: 'dice', operation: 'execute', automatic: false, command: 'dice', commandName: '/dice', resource: undefined,
      commandExecution: { input: 'oops', summary: '参数无效', text: '骰子用法：/dice 整数1 整数2', details: [] }, deliveries: [{ kind: 'reply', status: 'acknowledged' }] }),
  ];
  assert.deepEqual(filterPluginJobs(jobs, '/dice', 'all').map(item => item.id), ['roll', 'hint']);
  assert.deepEqual(filterPluginJobs(jobs, '20 10 17', 'active').map(item => item.id), ['roll']);
  assert.deepEqual(filterPluginJobs(jobs, 'oops 参数无效', 'all').map(item => item.id), ['hint']);
  assert.deepEqual(filterPluginJobs(jobs, '整数1', 'all').map(item => item.id), ['hint']);
  assert.equal(pluginJobNeedsAttention(jobs[1]!), false);
});

const inspection = {
  messageCount: 10, imageMessageCount: 7, imageCount: 20, ratioPercent: 70, sampledCount: 4, checkedCount: 4,
  structuralComplete: true, outcome: 'not_detected' as const,
};

test('forward inspection titles distinguish samples from checking the full forwarded collection', () => {
  const record = job('checked', { pluginId: 'forward-nsfw', operation: 'inspect', resource: undefined, inspection });
  assert.equal(pluginRecordTitle(record), '抽样未检出 · 检查 4 / 20 张图片');
  assert.equal(pluginRecordTitle({ ...record, state: 'queued', inspection: { ...inspection, checkedCount: 0, outcome: 'pending' } }), '等待检查 · 抽样 4 / 20 张图片');
  assert.equal(pluginRecordTitle({ ...record, inspection: { ...inspection, outcome: 'detected' } }), '疑似 NSFW · 检查 4 / 20 张图片');
  assert.equal(pluginRecordTitle({ ...record, inspection: { ...inspection, outcome: 'skipped' } }), '已跳过 · 20 张图片');
  assert.equal(pluginRecordTitle({ ...record, inspection: undefined }), '转发图片检查');
  assert.equal(pluginInspectionPercent(200 / 3), '66.7%');
});

test('inspection search includes outcome, reason, ratio and sample position while attention keeps detection separate from failure', () => {
  const jobs = [
    job('detected', { pluginId: 'forward-nsfw', operation: 'inspect', inspection: { ...inspection, outcome: 'detected', scores: [{ sourceKey: 'forward:f0/n2/s1', score: 0.93 }] }, deliveries: [{ kind: 'notification', status: 'acknowledged' }] }),
    job('unknown', { pluginId: 'forward-nsfw', operation: 'inspect', inspection: { ...inspection, outcome: 'unknown', reason: 'JEV_TIMEOUT' } }),
    job('unsent', { pluginId: 'forward-nsfw', operation: 'inspect', inspection: { ...inspection, outcome: 'detected' }, deliveries: [{ kind: 'notification', status: 'unconfirmed' }] }),
  ];
  assert.deepEqual(filterPluginJobs(jobs, 'nsfw 70%', 'all').map(item => item.id), ['detected', 'unsent']);
  assert.deepEqual(filterPluginJobs(jobs, 'JEV_TIMEOUT', 'attention').map(item => item.id), ['unknown']);
  assert.deepEqual(filterPluginJobs(jobs, 'f0/n2/s1', 'all').map(item => item.id), ['detected']);
  assert.deepEqual(filterPluginJobs(jobs, '', 'attention').map(item => item.id), ['unknown', 'unsent']);
  assert.equal(pluginJobNeedsAttention(jobs[0]!), false);
  assert.equal(pluginDeliveryKindLabels.notification, '提醒');
  assert.equal(pluginOperationLabels.inspect, '转发图片检查');
});

test('partial image checks remain visible as incomplete without discarding valid detection', () => {
  const partial = { ...inspection, checkedCount: 2, reason: 'PARTIAL_IMAGE_COVERAGE', failures: [
    { sourceKey: 'forward:f0/n4/s1', code: 'NSFW_HTTP_ERROR', httpStatus: 503 },
    { sourceKey: 'forward:f0/n6/s0', code: 'NSFW_TIMEOUT' },
  ] };
  const records = [
    job('partial-negative', { operation: 'inspect', inspection: partial }),
    job('partial-positive', { operation: 'inspect', inspection: { ...partial, outcome: 'detected', scores: [{ sourceKey: 'forward:f0/n2/s0', score: 0.93 }] } }),
    job('pending', { state: 'running', operation: 'inspect', inspection: { ...partial, checkedCount: 0, outcome: 'pending' } }),
    job('skipped', { operation: 'inspect', inspection: { ...partial, checkedCount: 0, outcome: 'skipped' } }),
  ];
  assert.equal(pluginInspectionOutcomeText(partial), '部分样本未检出');
  assert.equal(pluginRecordTitle(records[0]!), '部分样本未检出 · 检查 2 / 20 张图片');
  assert.equal(pluginInspectionOutcomeText(records[1]!.inspection!), '疑似 NSFW');
  assert.equal(pluginInspectionOutcomeText({ ...partial, checkedCount: 0, outcome: 'unknown' }), '未完成判断');
  assert.deepEqual(filterPluginJobs(records, '', 'attention').map(record => record.id), ['partial-negative', 'partial-positive']);
  assert.deepEqual(filterPluginJobs(records, '503', 'attention').map(record => record.id), ['partial-negative', 'partial-positive']);
  assert.deepEqual(filterPluginJobs(records, 'f0/n6/s0 请求超时', 'attention').map(record => record.id), ['partial-negative', 'partial-positive']);
});

test('forward inspection enablement is restricted to group targets without restricting existing plugins', () => {
  const inspector = { ...manifest, id: 'forward-nsfw', capabilities: ['forward-inspection'] };
  assert.equal(isForwardInspectionPlugin(inspector), true);
  assert.equal(pluginSupportsTarget(inspector, 'group'), true);
  assert.equal(pluginSupportsTarget(inspector, 'private'), false);
  assert.equal(pluginSupportsTarget(manifest, 'private'), true);
  assert.equal(pluginSupportsTarget({ ...manifest, capabilities: ['commands'] }, 'private'), true);
});

test('inspection reasons explain skips, unavailable samples and service errors while preserving unknown codes', () => {
  assert.equal(pluginInspectionReasonText('NO_IMAGES'), '转发中没有可检查的图片');
  assert.equal(pluginInspectionReasonText('RATIO_NOT_EXCEEDED'), '含图消息占比未超过阈值');
  assert.equal(pluginInspectionReasonText('IMAGE_COUNT_BELOW_THRESHOLD'), '图片数量未达到检查门槛');
  assert.equal(pluginInspectionReasonText('FORWARD_INCOMPLETE'), '转发结构未完整展开，已跳过检查');
  assert.equal(pluginInspectionReasonText('PARTIAL_IMAGE_COVERAGE'), '部分样本未完成检查');
  assert.equal(pluginInspectionReasonText('NSFW_NO_VALID_IMAGES'), '没有可用的图片样本');
  assert.equal(pluginInspectionReasonText('IMAGE_PREPARATION_FAILED'), '图片读取或压缩失败');
  assert.equal(pluginInspectionReasonText('NSFW_TIMEOUT'), 'Jev 请求超时');
  assert.equal(pluginInspectionReasonText('PLUGIN_JOB_EXPIRED'), '检查任务已过期');
  assert.equal(pluginInspectionReasonText('PLUGIN_FUTURE_CODE'), 'PLUGIN_FUTURE_CODE');
  const record = job('unknown', { pluginId: 'forward-nsfw', operation: 'inspect', inspection: { ...inspection, outcome: 'unknown', reason: 'NSFW_TIMEOUT' } });
  assert.deepEqual(filterPluginJobs([record], '请求超时', 'attention').map(item => item.id), ['unknown']);
});
