import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeMessage } from '../src/napcat.js';
import type { Target } from '../src/types.js';

const target: Target = { type: 'group', id: '1001' };
const text = (value: string) => ({ type: 'text', data: { text: value } });
const at = (qq: string) => ({ type: 'at', data: { qq } });
const event = (overrides: Record<string, unknown> = {}) => ({
  post_type: 'message', message_type: 'group', group_id: 1001, self_id: 999,
  message_id: 1, user_id: 123, time: 1_792_727_200,
  sender: { nickname: '用户' }, message: [text('继续聊')], ...overrides,
});

test('busy groups suppress probability replies entirely, including probability one', () => {
  const noRandom = () => { assert.fail('busy messages must not draw a probability'); };
  for (const probability of [0, 0.5, 1]) {
    for (const message of [
      [text('继续聊')], [at('888'), text('其他人的话题')],
      [{ type: 'image', data: { file: 'picture.png' } }],
      [{ type: 'face', data: { id: '1' } }],
    ]) assert.equal(normalizeMessage(event({ message }), target, probability, noRandom, true)?.trigger, false);
  }
  let draws = 0;
  assert.equal(normalizeMessage(event(), target, 0.5, () => { draws++; return 0.1; }, false)?.trigger, true);
  assert.equal(draws, 1);
});

test('busy mentions retain their content and explicit mention metadata without sampling', () => {
  const noRandom = () => { assert.fail('mentions must not draw a probability'); };
  for (const message of [
    [{ type: 'reply', data: { id: '42' } }, at('999'), text('你怎么看')],
    '[CQ:reply,id=42][CQ:at,qq=999]你怎么看',
  ]) {
    const input = event({ message });
    const normalized = normalizeMessage(input, target, 1, noRandom, true);
    assert.equal(normalized?.trigger, true);
    assert.equal(normalized?.directlyMentioned, true);
    assert.equal(normalized?.replyTo, '42');
    assert.equal(normalized?.text, '[引用 42][@999]你怎么看');
    assert.deepEqual(JSON.parse(normalized!.rawJson), input);
  }
  for (const message of [[at('888')], '[CQ:at,qq=all]', '&#91;CQ:at,qq=999&#93;']) {
    const normalized = normalizeMessage(event({ message }), target, 1, noRandom, true);
    assert.equal(normalized?.trigger, false);
    assert.equal(Object.hasOwn(normalized!, 'directlyMentioned'), false);
  }
});

test('busy commands and private messages retain their existing trigger semantics', () => {
  const noRandom = () => { assert.fail('explicit requests must not draw a probability'); };
  for (const command of ['help', 'new', 'compact']) {
    for (const message of [[text(`/${command}`)], [at('999'), text(` /${command}`)]]) {
      const normalized = normalizeMessage(event({ message }), target, 0, noRandom, true);
      assert.equal(normalized?.command, command);
      assert.equal(normalized?.trigger, true);
    }
  }
  const privateTarget: Target = { type: 'private', id: '123' };
  for (const message of [[text('你好')], [{ type: 'face', data: { id: '1' } }]]) {
    assert.equal(normalizeMessage(event({ message_type: 'private', message }), privateTarget, 0, noRandom, true)?.trigger, true);
  }
});
