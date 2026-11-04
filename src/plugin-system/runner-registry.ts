import { runnerDefinitions } from './generated/runner.js';
import { PluginExecutionError, type PluginRunnerDefinition } from './contracts.js';

export function pluginRunner(id: string): PluginRunnerDefinition {
  const entry = runnerDefinitions.find(plugin => plugin.pluginId === id);
  if (!entry) throw new PluginExecutionError('PLUGIN_RUNNER_NOT_FOUND');
  return entry.definition;
}
