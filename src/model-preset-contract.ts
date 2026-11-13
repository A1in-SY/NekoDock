import type { BotSettings } from './console/contracts.js';

export const MODEL_SETTING_KEYS = [
  'modelApi', 'baseUrl', 'modelApiKey', 'model', 'supportsImages', 'supportsReasoning',
  'reasoning', 'maxOutputTokens', 'contextWindow', 'compactLimit',
  'compactKeepRecentTokens', 'compactSummaryMaxTokens',
] as const;
export type ModelSettings = Pick<BotSettings, typeof MODEL_SETTING_KEYS[number]>;
export type PublicModelSettings = Omit<ModelSettings, 'modelApiKey'>;
export interface ModelPresetSelection { id: string; revision: number }
export interface ModelPresetBinding extends ModelPresetSelection { name: string }
export interface PublicModelPreset {
  id: string; name: string; revision: number; config: PublicModelSettings;
  keyConfigured: boolean; createdAt: number; updatedAt: number;
}

export function modelSettings(config: Partial<BotSettings>): ModelSettings {
  return Object.fromEntries(MODEL_SETTING_KEYS.map(key => [key, config[key]])) as ModelSettings;
}
