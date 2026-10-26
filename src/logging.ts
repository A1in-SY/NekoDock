import { createHash } from 'node:crypto';
import type { Logger } from './types.js';

type Level = 'info' | 'warn' | 'error';
type Fields = Record<string, string | number | boolean | null | undefined>;

/** Fixed UTC+8, independent of the host/container timezone. */
export function formatLogTime(date = new Date()): string {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().replace('Z', '+08:00');
}

export function createLogger(options: {
  now?: () => Date;
  write?: (level: Level, line: string) => void;
  secrets?: readonly string[];
} = {}): Logger {
  const secrets = [...new Set(options.secrets ?? [
    process.env.NAPCAT_TOKEN, process.env.AGENT_API_KEY, process.env.CODEX_API_KEY, process.env.TAVILY_API_KEY, process.env.MIMO_TTS_API_KEY,
  ])].filter((value): value is string => typeof value === 'string' && value.length > 0)
    .sort((a, b) => b.length - a.length);
  const write = options.write ?? ((level: Level, line: string) => {
    if (level === 'info') console.log(line);
    else if (level === 'warn') console.warn(line);
    else console.error(line);
  });
  const emit = (level: Level, message: string) => {
    let safe = message;
    for (const secret of secrets) safe = safe.replaceAll(secret, '[redacted]');
    safe = safe.replaceAll('\r', '\\r').replaceAll('\n', '\\n');
    write(level, `${formatLogTime(options.now?.())} ${level.toUpperCase()} ${safe}`);
  };
  return {
    info: message => emit('info', message),
    warn: message => emit('warn', message),
    error: message => emit('error', message),
  };
}

/** Callers provide selected metadata only, never message bodies or raw errors. */
export function logEvent(logger: Logger, level: Level, event: string, fields: Fields = {}): void {
  const metadata = Object.entries(fields).filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(' ');
  logger[level](metadata ? `${event} ${metadata}` : event);
}

export function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}
