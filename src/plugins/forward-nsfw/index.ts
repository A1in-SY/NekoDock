import type { ObserverPluginDefinition, PluginManifest } from '../../plugin-system/contracts.js';
import { FORWARD_NSFW_DEFAULTS, validateForwardNsfwConfig, type ForwardNsfwConfig } from './config.js';

export default function createPlugin(manifest: PluginManifest): ObserverPluginDefinition {
  return {
    kind: 'observer', manifest, defaults: FORWARD_NSFW_DEFAULTS,
    validateEnabled(settings) { if (!(settings as ForwardNsfwConfig).apiKey) throw new Error('插件启用前请填写 Jev API Key'); },
    validateConfig: (input, current) => validateForwardNsfwConfig(input, current as ForwardNsfwConfig | undefined),
  };
}
