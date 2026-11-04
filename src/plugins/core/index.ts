import type { ControlPluginDefinition, PluginManifest } from '../../plugin-system/contracts.js';
import { pluginCommandText } from '../../plugin-system/command-parser.js';

export default function createPlugin(manifest: PluginManifest): ControlPluginDefinition {
  return {
    kind: 'control',
    manifest,
    command(event) {
      const input = pluginCommandText(event);
      if (!input) return;
      const command = manifest.commands.find(command => command.name === input.text);
      if (command) return {
        pluginId: manifest.id,
        command: command.name.slice(1),
        args: '',
        sourceMessageId: input.sourceMessageId,
        contextPolicy: command.contextPolicy,
        executor: command.executor,
      };
    },
  };
}
