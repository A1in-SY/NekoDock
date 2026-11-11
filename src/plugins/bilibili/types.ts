import type { PluginContent, PluginResource } from '../../plugin-system/contracts.js';

export interface BilibiliConfig extends Record<string, unknown> {
  enhance: boolean;
  subtitles: boolean;
  videoDisplay: 'off' | 'card';
  autoVideo: boolean;
  dynamicEnhance: boolean;
  dynamicDisplay: 'off' | 'original' | 'card';
  liveEnhance: boolean;
  liveDisplay: 'off' | 'original' | 'card';
  maxDurationSeconds: number;
  maxMiB: number;
  maxHeight: number;
  timeoutSeconds: number;
  waitSeconds: number;
  cacheHours: number;
  cacheMaxMiB: number;
  cookie?: string;
}

export interface BilibiliResource extends PluginResource {
  kind: 'video' | 'post' | 'live' | 'short';
  part?: number;
}

export interface BilibiliContent extends PluginContent {
  type: 'video';
  platform: 'bilibili';
  part: number;
}
