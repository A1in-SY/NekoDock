import type { ContentPluginDefinition, PluginManifest } from '../../plugin-system/contracts.js';
import { DOUYIN_DEFAULTS, validateDouyinConfig } from './config.js';
import { contentText, errorText, validateDouyinContent } from './content.js';
import { douyinResources, normalizeDouyinResource } from './recognize.js';

export default function createPlugin(manifest: PluginManifest): ContentPluginDefinition {
  return {
    kind: 'content', manifest, defaults: DOUYIN_DEFAULTS,
    validateConfig: (value,current) => validateDouyinConfig(value,current ? validateDouyinConfig(current) : undefined),
    match: douyinResources, command: () => undefined,
    validateContent: (value,source) => {
      const normalized = normalizeDouyinResource(source.url); if (!normalized) throw new Error('抖音链接无效');
      return validateDouyinContent(value,normalized);
    },
    contentText, errorText,
    failureContent: (source,error) => ({ type: 'video', platform: 'douyin', resourceId: source.id, url: source.url,
      title: source.title?.slice(0,500) ?? '抖音视频', subtitle: { status: 'absent' }, retrieval: { status: 'failed', error } }),
    shouldProcess: config => { const value = validateDouyinConfig(config); return value.enhance || value.autoVideo; },
    policy: config => { const value = validateDouyinConfig(config); return { timeoutSeconds: value.timeoutSeconds, waitSeconds: value.waitSeconds,
      maxAssetBytes: value.maxMiB * 1024 * 1024, cacheMaxBytes: value.cacheMaxMiB * 1024 * 1024, cacheHours: value.cacheHours }; },
    summarize: (source,content) => {
      const resource = normalizeDouyinResource(content?.url ?? source?.url ?? ''); if (!resource) return;
      return { id: resource.id, url: resource.url, ...(content?.title || source?.title ? { title: (content?.title ?? source?.title)!.slice(0,500) } : {}),
        ...(content?.author ? { author: content.author.slice(0,500) } : {}) };
    },
    missingResourceText: '请提供抖音视频分享链接。',
    afterResolve: (_command,source,config,content) => {
      const value = validateDouyinConfig(config), cover = content.blocks?.some(block => block.type === 'image' && block.image.role === 'cover');
      return { provideContext: value.enhance,
        ...(value.enhance && cover ? { prepare: { mode: 'none' as const, provideContext: true } } : {}),
        ...(value.autoVideo && content.durationSeconds !== undefined && content.durationSeconds > 0 && content.durationSeconds <= value.maxDurationSeconds
          ? { download: { ...source, kind: 'video', id: content.resourceId, url: content.url, title: content.title } } : {}) };
    },
  };
}
