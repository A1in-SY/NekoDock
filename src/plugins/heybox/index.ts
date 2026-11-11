import type { ContentPluginDefinition, PluginManifest } from '../../plugin-system/contracts.js';
import { HEYBOX_DEFAULTS, validateHeyboxConfig } from './config.js';
import { heyboxResources, normalizeHeyboxLink } from './recognize.js';
import { contentText, validateHeyboxContent } from './content.js';
import { postContentText, validatePostContent } from './post-content.js';

export default function createPlugin(manifest: PluginManifest): ContentPluginDefinition {
  return {
    kind: 'content', manifest, defaults: HEYBOX_DEFAULTS,
    validateConfig: (input, current) => validateHeyboxConfig(input, current ? validateHeyboxConfig(current) : undefined),
    match: heyboxResources, command: () => undefined,
    validateContent(value, source) { const resource = normalizeHeyboxLink(source.url); if (!resource) throw new Error('插件链接无效');
      return resource.kind === 'post' ? validatePostContent(value, resource) : validateHeyboxContent(value, resource); },
    contentText: content => content.type === 'post' ? postContentText(content) : contentText(content),
    failureContent: (source, error) => ({ type: source.kind === 'post' ? 'post' : 'game', platform: 'heybox', resourceId: source.id, url: source.url,
      title: (source.title || (source.kind === 'post' ? '小黑盒帖子' : '小黑盒游戏分享')).slice(0, 500), retrieval: { status: 'partial', error } }),
    errorText: error => error === 'HEYBOX_ACCESS_RESTRICTED' ? '小黑盒暂时限制了资料访问，已保留原始分享。'
      : error === 'HEYBOX_GAME_TYPE_UNKNOWN' ? '未能确认游戏类型，已保留原始分享。' : '这次未能完成小黑盒资料处理，已保留原始分享。',
    shouldProcess(config, source) { const s = validateHeyboxConfig(config);
      return source?.kind === 'post' ? s.postEnhance || s.postAutoCard : source ? s.enhance || s.autoCard : s.enhance || s.autoCard || s.postEnhance || s.postAutoCard; },
    policy(config) { const s = validateHeyboxConfig(config); return { timeoutSeconds: s.timeoutSeconds, waitSeconds: s.waitSeconds,
      maxAssetBytes: s.maxMiB * 1024 * 1024, cacheMaxBytes: s.cacheMaxMiB * 1024 * 1024, cacheHours: s.cacheHours }; },
    summarize(source, content) {
      const resource = normalizeHeyboxLink(content?.url ?? source?.url ?? '');
      if (resource) return { id: resource.id, url: resource.url, ...(content?.title ?? source?.title ? { title: (content?.title ?? source?.title)!.slice(0, 500) } : {}), ...(content?.author ? { author: content.author.slice(0, 500) } : {}) };
    },
    missingResourceText: '请提供小黑盒游戏或帖子分享链接。',
    afterResolve(_command, source, config, content) {
      const settings = validateHeyboxConfig(config);
      if (source.kind === 'post') return { provideContext: settings.postEnhance,
        ...(settings.postAutoCard ? { prepare: { mode: 'card' as const, provideContext: settings.postEnhance } }
          : settings.postEnhance && content.blocks?.some(block => block.type === 'image') ? { prepare: { mode: 'none' as const, provideContext: true } } : {}) };
      return { provideContext: settings.enhance, ...(settings.autoCard ? { prepare: { mode: 'card' as const, provideContext: settings.enhance } } : {}) };
    },
  };
}
