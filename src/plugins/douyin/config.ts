import type { PluginSettings } from '../../plugin-system/contracts.js';

export interface DouyinConfig extends PluginSettings {
  enhance: boolean; autoVideo: boolean; videoDisplay: 'off' | 'card'; maxDurationSeconds: number; maxMiB: number;
  maxResolution: number; timeoutSeconds: number; waitSeconds: number; cacheHours: number; cacheMaxMiB: number;
}
export const DOUYIN_DEFAULTS: DouyinConfig = {
  enhance: true, autoVideo: true, videoDisplay: 'off', maxDurationSeconds: 300, maxMiB: 50, maxResolution: 720,
  timeoutSeconds: 120, waitSeconds: 3, cacheHours: 24, cacheMaxMiB: 1024,
};
const ranges = { maxDurationSeconds: [1, 3600], maxMiB: [1, 256], maxResolution: [144, 1080],
  timeoutSeconds: [10, 600], waitSeconds: [0, 30], cacheHours: [1, 720], cacheMaxMiB: [16, 10240] } as const;
export function validateDouyinConfig(input: unknown, current: DouyinConfig = DOUYIN_DEFAULTS): DouyinConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('抖音插件配置必须为对象');
  for (const key of Object.keys(input)) if (!Object.hasOwn(DOUYIN_DEFAULTS, key)) throw new Error('抖音插件配置包含未知项目');
  const value = { ...DOUYIN_DEFAULTS, ...current, ...input } as DouyinConfig;
  for (const key of ['enhance', 'autoVideo'] as const) if (typeof value[key] !== 'boolean') throw new Error('抖音插件开关必须为布尔值');
  if (!['off', 'card'].includes(value.videoDisplay)) throw new Error('抖音视频展示方式无效');
  for (const [key, [min, max]] of Object.entries(ranges)) {
    const item = value[key];
    if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < min || item > max) throw new Error(`抖音插件配置 ${key} 超出允许范围`);
  }
  return value;
}
