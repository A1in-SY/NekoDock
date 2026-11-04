import { pluginManifests } from '../../plugin-system/generated/catalog.js';
import type { BilibiliConfig } from './types.js';

const schema = pluginManifests.find(plugin => plugin.id === 'bilibili')!.configSchema!;
export const BILIBILI_DEFAULTS = Object.fromEntries(Object.entries(schema.properties)
  .filter(([, field]) => !field.secret && field.default !== undefined)
  .map(([key, field]) => [key, field.default])) as BilibiliConfig;

export function validateBilibiliConfig(input: unknown, current: BilibiliConfig = BILIBILI_DEFAULTS): BilibiliConfig {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('插件配置必须为对象');
  const value = input as Record<string, unknown>;
  for (const key of Object.keys(value)) if (!Object.hasOwn(schema.properties, key)) throw new Error('插件配置包含未知项目');
  const result = { ...current, ...value } as BilibiliConfig;
  for (const [key, field] of Object.entries(schema.properties)) {
    const item = result[key];
    if (field.type === 'boolean' && typeof item !== 'boolean') throw new Error('插件开关必须为布尔值');
    if (field.type === 'integer' && (typeof item !== 'number' || !Number.isSafeInteger(item)
      || field.minimum !== undefined && item < field.minimum || field.maximum !== undefined && item > field.maximum)) {
      throw new Error(`插件配置 ${key} 超出允许范围`);
    }
    if (field.type === 'string' && !field.secret && (typeof item !== 'string' || field.enum && !field.enum.includes(item))) throw new Error(`插件配置 ${key} 选项无效`);
  }
  if (result.cookie !== undefined && (typeof result.cookie !== 'string' || result.cookie.length > 65536 || /[\r\n\0]/u.test(result.cookie))) {
    throw new Error('插件 Cookie 格式无效');
  }
  if (!result.cookie) delete result.cookie;
  return result;
}
