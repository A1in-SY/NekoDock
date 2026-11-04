import { PluginExecutionError } from '../../plugin-system/contracts.js';

export class BilibiliError extends PluginExecutionError {}

export function bilibiliError(error: unknown): BilibiliError {
  if (error instanceof BilibiliError) return error;
  const s = error instanceof Error ? error.message : String(error);
  if (/\b412\b/u.test(s)) return new BilibiliError('BILIBILI_HTTP_412');
  if (/\b401\b|login|log in|登录|premium|permission|members.only/iu.test(s)) return new BilibiliError('BILIBILI_LOGIN_REQUIRED');
  if (/max.filesize|too large|larger than/iu.test(s)) return new BilibiliError('BILIBILI_MEDIA_TOO_LARGE');
  if (/timed? ?out|timeout|AbortError|aborted/iu.test(s)) return new BilibiliError('BILIBILI_TIMEOUT', true);
  if (/\b429\b|\b50[0234]\b|network|connection|unreachable|ECONN/iu.test(s)) return new BilibiliError('BILIBILI_NETWORK_FAILED', true);
  return new BilibiliError('BILIBILI_FETCH_FAILED');
}
