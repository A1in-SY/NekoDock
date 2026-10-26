import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLogger, fingerprint, formatLogTime, logEvent } from '../src/logging.js';

test('日志固定为东八区，正确处理跨日与跨年且保留毫秒', () => {
  assert.equal(formatLogTime(new Date('2026-10-23T09:27:06.735Z')), '2026-10-23T17:27:06.735+08:00');
  assert.equal(formatLogTime(new Date('2026-12-31T20:01:02.003Z')), '2027-01-01T04:01:02.003+08:00');
  assert.equal(formatLogTime(new Date('2026-10-23T17:27:06.735+08:00')), '2026-10-23T17:27:06.735+08:00');
});

test('各级日志使用同一时间格式，去掉凭据并防止多行内容伪造日志', () => {
  const lines: Array<{ level: string; line: string }> = [];
  const logger = createLogger({
    now: () => new Date('2026-10-23T09:27:06.735Z'),
    write: (level, line) => { lines.push({ level, line }); },
    secrets: ['private-token', 'private-token-long', 'private-api-key'],
  });
  logger.info('ready');
  logger.warn('private-token-long private-token private-api-key\r\nFORGED');
  logger.error('failed');
  assert.deepEqual(lines, [
    { level: 'info', line: '2026-10-23T17:27:06.735+08:00 INFO ready' },
    { level: 'warn', line: '2026-10-23T17:27:06.735+08:00 WARN [redacted] [redacted] [redacted]\\r\\nFORGED' },
    { level: 'error', line: '2026-10-23T17:27:06.735+08:00 ERROR failed' },
  ]);
});

test('事件元信息保留类型、忽略未定义字段并对换行编码，会话只使用短指纹', () => {
  const logs: string[] = [];
  const logger = { info: (line: string) => logs.push(line), warn() {}, error() {} };
  logEvent(logger, 'info', 'batch.completed', { through_seq: 12, reply_allowed: false, empty: null, omitted: undefined, label: 'one\ntwo' });
  assert.equal(logs[0], 'batch.completed through_seq=12 reply_allowed=false empty=null label="one\\ntwo"');
  assert.match(fingerprint('private-session-id'), /^[0-9a-f]{12}$/);
  assert.equal(fingerprint('private-session-id'), fingerprint('private-session-id'));
  assert.notEqual(fingerprint('private-session-id'), fingerprint('other-session-id'));
});

test('默认日志脱敏覆盖 MiMo 语音供应商的 API Key', () => {
  const previous = process.env.MIMO_TTS_API_KEY;
  const lines: string[] = [];
  try {
    process.env.MIMO_TTS_API_KEY = 'fake-mimo-private-key-for-logging';
    const logger = createLogger({ write: (_level, line) => lines.push(line) });
    logger.error('credential=fake-mimo-private-key-for-logging');
    assert.match(lines[0]!, /credential=\[redacted\]/);
    assert.doesNotMatch(lines[0]!, /fake-mimo-private-key-for-logging/);
  } finally {
    if (previous === undefined) delete process.env.MIMO_TTS_API_KEY;
    else process.env.MIMO_TTS_API_KEY = previous;
  }
});
