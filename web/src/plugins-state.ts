import type { PluginInstanceView, PluginJobView, PluginManifest } from '../../src/plugin-contract';
import { sharedContentLink } from './shared-content-state.ts';

export const pluginJobLabels: Record<string, string> = {
  queued: '等待处理', pending: '等待处理', running: '处理中', completed: '已完成',
  failed: '失败', cancelled: '已取消', expired: '已过期', ready: '已就绪',
};

export const pluginOperationLabels: Record<string, string> = { resolve: '内容解析', download: '视频下载', prepare: '图片获取与展示准备', execute: '指令执行', inspect: '转发图片检查' };
export const pluginDeliveryKindLabels: Record<string, string> = { reply: '文字', video: '视频', image: '图片', notification: '提醒' };
export const pluginDeliveryLabels: Record<string, string> = {
  pending: '等待发送', sending: '发送中', acknowledged: '已发送', failed: '发送失败', unconfirmed: '发送未确认',
};
export type PluginJobFilter = 'all' | 'active' | 'attention';

export function isCommandOnlyPlugin(manifest: PluginManifest): boolean {
  return manifest.capabilities?.length === 1 && manifest.capabilities[0] === 'commands';
}

export function isForwardInspectionPlugin(manifest: PluginManifest): boolean {
  return manifest.capabilities?.includes('forward-inspection') === true;
}

export function pluginSupportsTarget(manifest: PluginManifest, targetType: 'group' | 'private'): boolean {
  return !isForwardInspectionPlugin(manifest) || targetType === 'group';
}

export const pluginInspectionOutcomeLabels: Record<string, string> = {
  pending: '等待检查', detected: '疑似 NSFW', not_detected: '抽样未检出', unknown: '未完成判断', skipped: '已跳过',
};

const pluginInspectionReasonLabels: Record<string, string> = {
  NO_IMAGES: '转发中没有可检查的图片',
  RATIO_NOT_EXCEEDED: '含图消息占比未超过阈值',
  IMAGE_COUNT_BELOW_THRESHOLD: '图片数量未达到检查门槛',
  FORWARD_INCOMPLETE: '转发结构未完整展开，已跳过检查',
  PARTIAL_IMAGE_COVERAGE: '部分样本未完成检查',
  NSFW_NO_VALID_IMAGES: '没有可用的图片样本',
  IMAGE_PREPARATION_FAILED: '图片读取或压缩失败',
  IMAGE_UNAVAILABLE: '图片缓存尚未就绪或已不可用',
  NSFW_NOT_CONFIGURED: 'Jev 服务尚未配置',
  NSFW_INVALID_IMAGES: '图片样本数量无效',
  NSFW_REQUEST_TOO_LARGE: '检查请求超过体积上限',
  NSFW_HTTP_ERROR: 'Jev 服务返回错误',
  NSFW_INVALID_RESPONSE: 'Jev 响应格式无效',
  NSFW_TIMEOUT: 'Jev 请求超时',
  NSFW_CANCELLED: 'Jev 请求已取消',
  NSFW_NETWORK_ERROR: 'Jev 网络请求失败',
  PLUGIN_CONFIGURATION_CHANGED: '插件配置已更新或运行条件已变化，检查已取消',
  PLUGIN_JOB_EXPIRED: '检查任务已过期',
  PLUGIN_JOB_CANCELLED: '检查任务已取消',
  PLUGIN_NOTIFICATION_CANCELLED: '提醒发送条件已失效',
  PLUGIN_STORAGE_ERROR: '插件任务状态保存失败',
  PLUGIN_DISABLED: '插件或实例已停止',
  PLUGIN_CONVERSATION_CHANGED: '主会话已切换',
};

export function pluginInspectionReasonText(reason: string): string {
  return pluginInspectionReasonLabels[reason] || reason;
}

export function pluginInspectionPercent(value: number): string {
  return `${value.toLocaleString('zh-CN', { maximumFractionDigits: 1 })}%`;
}

export function pluginInspectionOutcomeText(inspection: NonNullable<PluginJobView['inspection']>): string {
  if (inspection.outcome === 'not_detected' && inspection.checkedCount < inspection.sampledCount) return '部分样本未检出';
  return pluginInspectionOutcomeLabels[inspection.outcome] || inspection.outcome;
}

export function pluginInspectionSummary(inspection: NonNullable<PluginJobView['inspection']>): string {
  const label = pluginInspectionOutcomeText(inspection);
  if (inspection.outcome === 'skipped') return `${label} · ${inspection.imageCount} 张图片`;
  return `${label} · ${inspection.outcome === 'pending' ? '抽样' : '检查'} ${inspection.outcome === 'pending' ? inspection.sampledCount : inspection.checkedCount} / ${inspection.imageCount} 张图片`;
}

export function pluginRecordTitle(job: PluginJobView): string {
  if (job.operation === 'execute') return job.commandExecution?.summary || job.commandName || job.command;
  if (job.operation === 'inspect') return job.inspection ? pluginInspectionSummary(job.inspection) : '转发图片检查';
  return job.resource?.title || job.resource?.id || '未识别的分享';
}

export function pluginJobNeedsAttention(job: PluginJobView): boolean {
  return ['failed', 'expired'].includes(job.state)
    || job.inspection?.outcome === 'unknown'
    || !!job.inspection && !['pending', 'skipped'].includes(job.inspection.outcome) && job.inspection.checkedCount < job.inspection.sampledCount
    || job.deliveries.some(delivery => ['failed', 'unconfirmed'].includes(delivery.status));
}

export function filterPluginJobs(jobs: PluginJobView[], query: string, filter: PluginJobFilter): PluginJobView[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  return jobs.filter(job => {
    if (filter === 'attention' && !pluginJobNeedsAttention(job)) return false;
    if (filter === 'active' && !['queued', 'pending', 'running'].includes(job.state)
      && !job.deliveries.some(delivery => ['pending', 'sending'].includes(delivery.status))) return false;
    const text = [job.id, job.sourceMessageId, job.resource?.title, job.resource?.id, job.resource?.author, job.resource?.url,
      job.commandName, job.command, job.commandExecution?.input, job.commandExecution?.summary, job.commandExecution?.text,
      ...(job.commandExecution?.details.flatMap(detail => [detail.label, detail.value]) ?? []),
      ...(job.inspection ? [pluginRecordTitle(job), job.inspection.reason, job.inspection.reason && pluginInspectionReasonText(job.inspection.reason), pluginInspectionPercent(job.inspection.ratioPercent),
        ...(job.inspection.scores?.map(score => score.sourceKey) ?? []),
        ...(job.inspection.failures?.flatMap(failure => [failure.sourceKey, failure.code, pluginInspectionReasonText(failure.code), failure.httpStatus]) ?? [])] : [])]
      .filter(Boolean).join(' ').toLocaleLowerCase();
    return terms.every(term => text.includes(term));
  });
}

export function pluginResourceLink(value: string | undefined, platform?: string): string | undefined {
  return sharedContentLink(value, platform);
}

export function pluginDefaults(manifest: PluginManifest): Record<string, unknown> {
  return Object.fromEntries(Object.entries(manifest.configSchema?.properties ?? {})
    .filter(([, field]) => !field.secret && field.default !== undefined)
    .map(([key, field]) => [key, field.default]));
}

export function pluginPayload(view: PluginInstanceView, enabled: boolean, values: Record<string, unknown>, clearedSecrets: ReadonlySet<string>) {
  if (view.manifest.required && !enabled) throw new Error('内置插件不可关闭');
  const config: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(view.manifest.configSchema?.properties ?? {})) {
    const value = values[key];
    if (field.secret) {
      if (clearedSecrets.has(key)) config[key] = '';
      else if (typeof value === 'string' && value.length) config[key] = value;
      continue;
    }
    if (field.type === 'boolean') {
      if (typeof value !== 'boolean') throw new Error(`${field.title}必须是开关值`);
      config[key] = value;
    } else if (field.type === 'integer') {
      if (typeof value !== 'number' || !Number.isSafeInteger(value)
        || field.minimum !== undefined && value < field.minimum
        || field.maximum !== undefined && value > field.maximum) throw new Error(`${field.title}超出允许范围`);
      config[key] = value;
    } else {
      if (typeof value !== 'string') throw new Error(`${field.title}必须是文本`);
      if (field.enum && !field.enum.includes(value)) throw new Error(`${field.title}不是可选项`);
      config[key] = value;
    }
  }
  return { expectedRevision: view.revision, enabled: view.manifest.required || enabled, config };
}

export function pluginFieldGroups(manifest: PluginManifest) {
  const groups = new Map<string, Array<[string, NonNullable<PluginManifest['configSchema']>['properties'][string]]>>();
  for (const entry of Object.entries(manifest.configSchema?.properties ?? {})) {
    const name = entry[1].group ?? '';
    const fields = groups.get(name) ?? [];
    fields.push(entry);
    groups.set(name, fields);
  }
  return [...groups].map(([name, fields]) => ({ name, fields }));
}

export type PluginFieldEntry = [string, NonNullable<PluginManifest['configSchema']>['properties'][string]];

export function pluginFieldRows(fields: PluginFieldEntry[]) {
  const roots = fields.filter(([, field]) => !field.parent || !fields.some(([key]) => key === field.parent));
  return roots.map(([key, field]) => ({ key, field, children: fields.filter(([, child]) => child.parent === key) }));
}
