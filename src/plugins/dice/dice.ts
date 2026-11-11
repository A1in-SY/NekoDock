import { randomBytes } from 'node:crypto';
import type { PluginCommandExecution } from '../../plugin-system/contracts.js';

export const DICE_USAGE = [
  '骰子用法：',
  '/dice：在 1～100 内随机取一个整数。',
  '/dice 整数1 整数2：在两个整数之间随机取值，包含两端，顺序不限。',
  '示例：/dice 1 6 或 /dice 6 1。',
  '请提供两个有效整数，并用半角空格分隔。',
].join('\n');

export interface DiceRange { min: number; max: number; }

export function parseDiceRange(args: string): DiceRange | undefined {
  const input = args.replace(/^ +| +$/gu, '');
  if (input === '') return { min: 1, max: 100 };
  const match = /^([+-]?\d+) +([+-]?\d+)$/u.exec(input);
  if (!match) return;
  const first = Number(match[1]), second = Number(match[2]);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(second)) return;
  return { min: Math.min(first, second) || 0, max: Math.max(first, second) || 0 };
}

/** Rejection sampling preserves equal probability even across the entire safe-integer range. */
export function rollDice(range: DiceRange, entropy: (size: number) => Uint8Array = randomBytes): number {
  if (!Number.isSafeInteger(range.min) || !Number.isSafeInteger(range.max) || range.min > range.max) {
    throw new RangeError('Dice endpoints must be ordered safe integers.');
  }
  const start = BigInt(range.min), count = BigInt(range.max) - start + 1n;
  if (count === 1n) return range.min;
  const bits = (count - 1n).toString(2).length, bytes = Math.ceil(bits / 8);
  const mask = (1 << (bits - (bytes - 1) * 8)) - 1;
  for (;;) {
    const data = entropy(bytes);
    let offset = BigInt(data[0]! & mask);
    for (let index = 1; index < bytes; index++) offset = (offset << 8n) | BigInt(data[index]!);
    if (offset < count) return Number(start + offset);
  }
}

export function executeDice(args: string): PluginCommandExecution {
  const range = args === '' || args.startsWith(' ') ? parseDiceRange(args) : undefined;
  if (!range) return { text: DICE_USAGE, summary: '参数无效，返回使用提示', details: [{ label: '参数校验', value: '无效' }] };
  const value = rollDice(range), interval = `${range.min}～${range.max}`;
  return {
    text: `🎲 骰子结果：${value}（范围 ${interval}）`,
    summary: `骰子结果：${value}（范围 ${interval}）`,
    details: [{ label: '范围（包含两端）', value: interval }, { label: '骰子结果', value: String(value) }],
  };
}
