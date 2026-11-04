import type { PluginInstanceView, PluginJobView, PluginManifest } from '../../src/plugin-contract';
import { sharedContentLink } from './shared-content-state.ts';

export const pluginJobLabels: Record<string, string> = {
  queued: '等待处理', pending: '等待处理', running: '处理中', completed: '已完成',
  failed: '失败', cancelled: '已取消', expired: '已过期', ready: '已就绪',
};

export const pluginOperationLabels: Record<string, string> = { resolve: '内容解析', download: '视频下载', prepare: '图片获取与展示准备' };
export const pluginDeliveryKindLabels: Record<string, string> = { reply: '文字', video: '视频', image: '图片' };
export const pluginDeliveryLabels: Record<string, string> = {
  pending: '等待发送', sending: '发送中', acknowledged: '已发送', failed: '发送失败', unconfirmed: '发送未确认',
};
export type PluginJobFilter = 'all' | 'active' | 'attention';

export function pluginJobNeedsAttention(job: PluginJobView): boolean {
  return ['failed', 'expired'].includes(job.state)
    || job.deliveries.some(delivery => ['failed', 'unconfirmed'].includes(delivery.status));
}

export function filterPluginJobs(jobs: PluginJobView[], query: string, filter: PluginJobFilter): PluginJobView[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  return jobs.filter(job => {
    if (filter === 'attention' && !pluginJobNeedsAttention(job)) return false;
    if (filter === 'active' && !['queued', 'pending', 'running'].includes(job.state)
      && !job.deliveries.some(delivery => ['pending', 'sending'].includes(delivery.status))) return false;
    const text = [job.id, job.sourceMessageId, job.resource?.title, job.resource?.id, job.resource?.author, job.resource?.url]
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
