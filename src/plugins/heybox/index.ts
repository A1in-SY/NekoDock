import type { ContentPluginDefinition, PluginManifest } from '../../plugin-system/contracts.js';
import { HEYBOX_DEFAULTS, validateHeyboxConfig } from './config.js';
import { heyboxResources, normalizeHeyboxResource } from './recognize.js';
import { contentText, validateHeyboxContent } from './content.js';

export default function createPlugin(manifest: PluginManifest): ContentPluginDefinition {
  return {
    kind: 'content', manifest, defaults: HEYBOX_DEFAULTS,
    validateConfig: (input, current) => validateHeyboxConfig(input, current ? validateHeyboxConfig(current) : undefined),
    match: heyboxResources, command: () => undefined,
    validateContent(value, source) { const resource = normalizeHeyboxResource(source.url); if (!resource) throw new Error('插件链接无效'); return validateHeyboxContent(value, resource); },
    contentText,
    failureContent: (source, error) => ({ type: 'game', platform: 'heybox', resourceId: source.id, url: source.url,
      title: (source.title || '小黑盒游戏分享').slice(0, 500), retrieval: { status: 'partial', error } }),
    errorText: error => error === 'HEYBOX_ACCESS_RESTRICTED' ? '小黑盒暂时限制了资料访问，已保留原始分享。'
      : error === 'HEYBOX_GAME_TYPE_UNKNOWN' ? '未能确认游戏类型，已保留原始分享。' : '这次未能完成游戏资料处理，已保留原始分享。',
    shouldProcess(config) { const settings = validateHeyboxConfig(config); return settings.enhance || settings.autoCard; },
    policy(config) { const s = validateHeyboxConfig(config); return { timeoutSeconds: s.timeoutSeconds, waitSeconds: s.waitSeconds,
      maxAssetBytes: s.maxMiB * 1024 * 1024, cacheMaxBytes: s.cacheMaxMiB * 1024 * 1024, cacheHours: s.cacheHours }; },
    summarize(source, content) {
      const resource = normalizeHeyboxResource(content?.url ?? source?.url ?? '');
      if (resource) return { id: resource.id, url: resource.url, ...(content?.title ?? source?.title ? { title: (content?.title ?? source?.title)!.slice(0, 500) } : {}) };
    },
    missingResourceText: '请提供小黑盒游戏分享链接。',
    afterResolve(_command, _source, config) {
      const settings = validateHeyboxConfig(config);
      return { provideContext: settings.enhance, ...(settings.autoCard ? { prepare: { mode: 'card' as const, provideContext: settings.enhance } } : {}) };
    },
  };
}
