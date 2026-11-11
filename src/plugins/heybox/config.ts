import type { HeyboxConfig } from './types.js';

export const HEYBOX_DEFAULTS: HeyboxConfig = { enhance: true, autoCard: true, showPrices: true, postEnhance: true, postAutoCard: true, maxMiB: 10,
  timeoutSeconds: 60, waitSeconds: 3, cacheMaxMiB: 512, cacheHours: 24 };
const limits = { maxMiB: [1, 16], timeoutSeconds: [10, 300], waitSeconds: [0, 15], cacheMaxMiB: [16, 4096], cacheHours: [1, 168] } as const;
export function validateHeyboxConfig(input: unknown, current: HeyboxConfig = HEYBOX_DEFAULTS): HeyboxConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('插件配置必须为对象');
  const value = input as Record<string, unknown>;
  for (const key of Object.keys(value)) if (!Object.hasOwn(HEYBOX_DEFAULTS, key) && key !== 'cookie') throw new Error('插件配置包含未知项目');
  const result = { ...current, ...value } as HeyboxConfig;
  for (const key of ['enhance', 'autoCard', 'showPrices', 'postEnhance', 'postAutoCard'] as const) if (typeof result[key] !== 'boolean') throw new Error('插件开关必须为布尔值');
  for (const [key, range] of Object.entries(limits)) {
    const item = result[key];
    if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < range[0] || item > range[1]) throw new Error('插件配置超出允许范围');
  }
  if (result.cookie !== undefined && (typeof result.cookie !== 'string' || result.cookie.length > 65536 || /[\r\n\0]/u.test(result.cookie))) throw new Error('插件 Cookie 格式无效');
  if (!result.cookie) delete result.cookie;
  return result;
}
