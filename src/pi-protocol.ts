import type { RunObservation, TargetType } from './types.js';
import type { WebSearchConfig } from './web-search.js';

export interface PiConfig {
  home: string; workspace: string; model: string; baseUrl: string; apiKey?: string;
  api: 'openai-responses' | 'openai-completions'; reasoning?: string;
  contextWindow: number; compactLimit: number; maxOutputTokens: number;
  supportsImages: boolean; supportsReasoning: boolean; allowCommands: boolean; allowFileWrites: boolean;
  persona: string; targetType: TargetType; webSearch?: WebSearchConfig;
}
export interface PiStart {
  type: 'start'; operation: 'run' | 'append' | 'compact'; config: PiConfig;
  session: string | null; prompt: string; system: string;
  images: Array<{ type: 'image'; data: string; mimeType: string }>;
}
export type PiParentMessage = PiStart | { type: 'abort' } | { type: 'send-result'; id: string; accepted: boolean };
export type PiChildMessage =
  | { type: 'session'; path: string }
  | { type: 'event'; event: RunObservation }
  | { type: 'send'; id: string; request: unknown }
  | { type: 'done' }
  | { type: 'failure'; code: string; message?: string };
