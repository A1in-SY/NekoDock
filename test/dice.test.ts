import test from 'node:test';
import assert from 'node:assert/strict';
import { DICE_USAGE, executeDice, parseDiceRange, rollDice } from '../src/plugins/dice/dice.js';
import createPlugin from '../src/plugins/dice/index.js';
import type { PluginManifest } from '../src/plugin-system/contracts.js';

const manifest: PluginManifest = { id: 'dice', name: '骰子', version: '1.0.0', apiVersion: 1, required: false,
  capabilities: ['commands'], resourceTypes: [], commands: [] };
const plugin = createPlugin(manifest);
const event = (text: string) => ({ message_id: 'example-message', self_id: '9000', message: [{ type: 'text', data: { text } }] });

test('dice defaults, sorts signed decimal endpoints and accepts ordinary space separators', () => {
  for (const input of ['', '   ']) assert.deepEqual(parseDiceRange(input), { min: 1, max: 100 });
  for (const input of ['1 6', ' 6   1 ', '+01 06']) assert.deepEqual(parseDiceRange(input), { min: 1, max: 6 });
  assert.deepEqual(parseDiceRange('-5 5'), { min: -5, max: 5 });
  assert.deepEqual(parseDiceRange('-0 0'), { min: 0, max: 0 });
  assert.deepEqual(parseDiceRange('8 8'), { min: 8, max: 8 });
  assert.deepEqual(parseDiceRange(`${Number.MAX_SAFE_INTEGER} ${Number.MIN_SAFE_INTEGER}`),
    { min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER });
});

test('dice rejects incomplete, extra, noninteger, nonspace and unsafe arguments with the same usage text', () => {
  for (const input of ['6', '1 6 10', 'abc def', '1,6', ',1,6', '1.5 6', '1e2 6', '0x10 6',
    'NaN 6', 'Infinity 6', '1\t6', '1\n6', '1\u30006', '\t1 6', '1 6\nextra',
    '9007199254740992 1', '-9007199254740992 1', '1 6 extra']) {
    assert.equal(parseDiceRange(input), undefined, input);
    assert.equal(executeDice(input).text, DICE_USAGE, input);
  }
  assert.equal(executeDice('+1 6').text, DICE_USAGE, 'arguments must be separated from the command name');
  assert.match(executeDice(' +1 6').text, /范围 1～6/u);
});

test('dice samples both closed endpoints and retries discarded draws without modulo bias', () => {
  assert.equal(rollDice({ min: 1, max: 6 }, () => Uint8Array.of(0)), 1);
  assert.equal(rollDice({ min: 1, max: 6 }, () => Uint8Array.of(5)), 6);
  let draws = 0;
  assert.equal(rollDice({ min: -2, max: 3 }, () => Uint8Array.of(draws++ === 0 ? 7 : 5)), 3);
  assert.equal(draws, 2);
  assert.equal(rollDice({ min: 8, max: 8 }, () => { throw new Error('Singletons need no entropy'); }), 8);
  const range = { min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER };
  assert.equal(rollDice(range, bytes => new Uint8Array(bytes)), range.min);
  assert.equal(rollDice(range, bytes => Uint8Array.from([0x3f, ...new Array(bytes - 2).fill(0xff), 0xfe])), range.max);
  for (let draw = 0; draw < 100; draw++) {
    const value = rollDice(range);
    assert.ok(Number.isSafeInteger(value) && value >= range.min && value <= range.max);
  }
});

test('dice recognizes its own command before validating parameters, including quoted and self-mentioned input', () => {
  for (const input of ['/dice', '/dice 1 6', '/dice abc', '/dice 1', '/dice\t1\t6', '/dice,1,6']) {
    const dispatch = plugin.command(event(input));
    assert.equal(dispatch?.pluginId, 'dice', input);
    assert.equal(dispatch?.sourceMessageId, 'example-message');
    assert.equal(dispatch?.contextPolicy, 'chat');
    assert.equal(dispatch?.executor, 'console');
  }
  const quoted = { ...event(' /dice 8 8'), message: [{ type: 'reply', data: { id: 'real-quote' } },
    { type: 'at', data: { qq: '9000' } }, ...event(' /dice 8 8').message] };
  assert.equal(plugin.execute(plugin.command(quoted)!, {}).text, '🎲 骰子结果：8（范围 8～8）');
  assert.equal(plugin.command({ ...event(''), message: '[CQ:reply,id=real-quote][CQ:at,qq=9000] /dice' })?.command, 'dice');
  for (const input of ['/dicex', '/dice-test', '/dice2', 'please /dice', '/DICE']) assert.equal(plugin.command(event(input)), undefined);
});

test('dice never executes embedded cards, forwarded commands or other participants mentions', () => {
  for (const message of [
    [{ type: 'json', data: { data: JSON.stringify({ text: '/dice' }) } }],
    [{ type: 'node', data: { content: event('/dice').message } }],
    [{ type: 'forward', data: { id: 'example-forward' } }],
    [{ type: 'at', data: { qq: 'someone-else' } }, ...event('/dice').message],
  ]) assert.equal(plugin.command({ ...event(''), message }), undefined);
  assert.deepEqual(plugin.validateConfig({}), {});
  for (const input of [null, [], '', { range: 6 }]) assert.throws(() => plugin.validateConfig(input));
});
