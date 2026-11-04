import type { PluginResource } from '../../plugin-system/contracts.js';

export type HeyboxGameType = 'pc' | 'console' | 'mobile';
export interface HeyboxResource extends PluginResource { kind: 'game'; appId: string; gameType?: HeyboxGameType; }
export interface HeyboxConfig extends Record<string, unknown> {
  enhance: boolean; autoCard: boolean; showPrices: boolean; maxMiB: number;
  timeoutSeconds: number; waitSeconds: number; cacheMaxMiB: number; cacheHours: number; cookie?: string;
}
