import type { PublicBot } from '../../src/console/contracts.ts';
import type { ModelPresetSelection, PublicModelPreset } from '../../src/model-preset-contract.ts';
import { MODEL_SETTING_KEYS } from '../../src/model-preset-contract.ts';

/** A preset is resolved with its secret on the server; stale form fields cannot override it. */
export function presetConfigPatch(config: Record<string, unknown>, selection?: ModelPresetSelection | null): Record<string, unknown> {
  return selection ? Object.fromEntries(Object.entries(config).filter(([key]) => !(MODEL_SETTING_KEYS as readonly string[]).includes(key))) : config;
}
export function presetStatus(binding: PublicBot['modelPreset'], presets: PublicModelPreset[]): string {
  if (!binding) return '自定义配置';
  const latest = presets.find(preset => preset.id === binding.id);
  if (!latest) return `${binding.name} · v${binding.revision} · 预设已删除，保留当前配置`;
  return `${binding.name} · v${binding.revision}${latest.revision !== binding.revision ? ` · 有更新 v${latest.revision}` : ''}`;
}
