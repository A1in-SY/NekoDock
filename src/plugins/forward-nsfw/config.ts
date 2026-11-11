import type { PluginSettings } from '../../plugin-system/contracts.js';

export interface ForwardNsfwConfig extends PluginSettings {
  minImages: number;
  maxImages: number;
  nsfwThresholdPercent: number;
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutSeconds: number;
  instructions: string;
  warningText: string;
}

export const FORWARD_NSFW_DEFAULTS: ForwardNsfwConfig = {
  minImages: 1, maxImages: 4, nsfwThresholdPercent: 80,
  baseUrl: 'https://api.typesafe.ai/v1', model: 'jev-latest', timeoutSeconds: 60,
  instructions: '', warningText: '这条转发里可能有不适合公开场合查看的图片，打开前留意一下哦。',
};

export function validateForwardNsfwConfig(input: unknown, current: ForwardNsfwConfig = FORWARD_NSFW_DEFAULTS): ForwardNsfwConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('转发图片检查配置必须为对象');
  const known = new Set([...Object.keys(FORWARD_NSFW_DEFAULTS), 'apiKey', 'imageRatioPercent']);
  for (const key of Object.keys(input)) if (!known.has(key)) throw new Error('转发图片检查配置包含未知项目');
  const value = { ...FORWARD_NSFW_DEFAULTS, ...current, ...input } as ForwardNsfwConfig;
  // Legacy percentage settings use the default count and are omitted from subsequent saves.
  delete value.imageRatioPercent;
  const ranges = { minImages: [1, 1000], maxImages: [1, 16], nsfwThresholdPercent: [0, 100], timeoutSeconds: [1, 60] } as const;
  for (const [key, [minimum, maximum]] of Object.entries(ranges)) {
    const item = value[key];
    if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < minimum || item > maximum) throw new Error(`转发图片检查配置 ${key} 超出允许范围`);
  }
  if (typeof value.baseUrl !== 'string') throw new Error('Jev Base URL 无效');
  let url: URL;
  try { url = new URL(value.baseUrl.trim()); } catch { throw new Error('Jev Base URL 无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || /\/systemone\/*$/u.test(url.pathname)) {
    throw new Error('Jev Base URL 应为不含鉴权信息、查询参数和 /systemone 的 HTTP(S) API 根路径');
  }
  value.baseUrl = url.toString().replace(/\/+$/u, '');
  if (typeof value.model !== 'string' || !value.model.trim() || value.model.length > 200 || /[\r\n\0]/u.test(value.model)) throw new Error('Jev Model 无效');
  value.model = value.model.trim();
  if (typeof value.instructions !== 'string' || value.instructions.length > 8000 || /\0/u.test(value.instructions)) throw new Error('补充判断说明应为最多 8000 字符的文字');
  if (typeof value.warningText !== 'string' || !value.warningText.trim() || value.warningText.length > 1000 || /\0/u.test(value.warningText)) throw new Error('提醒文案应为 1～1000 字符的文字');
  value.instructions = value.instructions.trim(); value.warningText = value.warningText.trim();
  if (value.apiKey !== undefined && (typeof value.apiKey !== 'string' || value.apiKey.length > 4096 || /[\r\n\0]/u.test(value.apiKey))) throw new Error('Jev API Key 格式无效');
  if (value.apiKey?.trim()) value.apiKey = value.apiKey.trim(); else delete value.apiKey;
  return value;
}
