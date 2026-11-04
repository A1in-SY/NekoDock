import type { BridgeCommand } from '../../types.js';
import { pluginManifests } from '../../plugin-system/generated/catalog.js';

export interface RegisteredCommand {
  name: string;
  description: string;
  executor: 'worker' | 'console';
  contextPolicy: 'control' | 'chat';
}

export const coreCommands: ReadonlyArray<RegisteredCommand & { command: BridgeCommand }> =
  pluginManifests.find(plugin => plugin.id === 'core')!.commands.map(command => ({
    name: command.name,
    description: command.description,
    executor: command.executor,
    contextPolicy: command.contextPolicy,
    command: command.name.slice(1) as BridgeCommand,
  }));

export function parseCoreCommand(text: string): BridgeCommand | undefined {
  return coreCommands.find(command => command.name === text.trim())?.command;
}

export function formatCommandHelp(additional: ReadonlyArray<Pick<RegisteredCommand, 'name' | 'description'>> = []): string {
  const unique = new Map(coreCommands.map(command => [command.name, command] as const));
  const extras = additional.filter(command => !unique.has(command.name));
  return ['可用指令：', ...[...coreCommands, ...extras].map(command => `${command.name} — ${command.description}`), '',
    '群聊和私聊均可用；群聊无需 @。会话控制指令会在当前轮完成后执行并回复结果。'].join('\n');
}
