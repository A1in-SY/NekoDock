import type { CommandPluginDefinition, ContentPluginDefinition, ObserverPluginDefinition, PluginDefinition } from './contracts.js';
import { pluginDefinitions } from './generated/console.js';
import { pluginManifests } from './generated/catalog.js';

export const PLUGIN_MANIFESTS = pluginManifests;
export const contentPlugins: readonly ContentPluginDefinition[] = pluginDefinitions.filter((plugin: PluginDefinition): plugin is ContentPluginDefinition => plugin.kind === 'content');
export const commandPlugins: readonly CommandPluginDefinition[] = pluginDefinitions.filter((plugin: PluginDefinition): plugin is CommandPluginDefinition => plugin.kind === 'command');
export const observerPlugins: readonly ObserverPluginDefinition[] = pluginDefinitions.filter((plugin: PluginDefinition): plugin is ObserverPluginDefinition => plugin.kind === 'observer');

export function configurablePlugin(id: string): ContentPluginDefinition | CommandPluginDefinition | ObserverPluginDefinition {
  const plugin = contentPlugins.find(plugin => plugin.manifest.id === id) ?? commandPlugins.find(plugin => plugin.manifest.id === id) ?? observerPlugins.find(plugin => plugin.manifest.id === id);
  if (!plugin) throw new Error('插件不存在');
  return plugin;
}

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
