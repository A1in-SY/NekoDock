import type { CommandPluginDefinition, PluginManifest } from '../../plugin-system/contracts.js';
import { pluginCommandText } from '../../plugin-system/command-parser.js';
import { executeDice } from './dice.js';

export default function createPlugin(manifest: PluginManifest): CommandPluginDefinition {
  return {
    kind: 'command', manifest, defaults: {},
    validateConfig(input) {
      if (input === null || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) {
        throw new Error('骰子插件没有可修改配置。');
      }
      return {};
    },
    command(event) {
      const input = pluginCommandText(event);
      if (!input || !/^\/dice(?:$|[^A-Za-z0-9_-])/u.test(input.text)) return;
      return { pluginId: manifest.id, command: 'dice', args: input.text.slice(5),
        sourceMessageId: input.sourceMessageId, contextPolicy: 'chat', executor: 'console' };
    },
    execute: dispatch => executeDice(dispatch.args),
  };
}
