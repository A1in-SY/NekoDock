import type { ContentPluginDefinition, PluginDefinition } from './contracts.js';
import { pluginDefinitions } from './generated/console.js';
import { pluginManifests } from './generated/catalog.js';

export const PLUGIN_MANIFESTS = pluginManifests;
export const contentPlugins: readonly ContentPluginDefinition[] = pluginDefinitions.filter((plugin: PluginDefinition): plugin is ContentPluginDefinition => plugin.kind === 'content');

export function contentPlugin(id: string): ContentPluginDefinition {
  const plugin = contentPlugins.find(plugin => plugin.manifest.id === id);
  if (!plugin) throw new Error('插件不存在');
  return plugin;
}

export function controlCommand(event: unknown) {
  for (const plugin of pluginDefinitions) if (plugin.kind === 'control') {
    const dispatch = plugin.command(event);
    if (dispatch) return dispatch;
  }
}
