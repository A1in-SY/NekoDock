import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareIncomingImages } from './images.js';
import { fingerprint, logEvent } from './logging.js';
import { safeToolPayload } from './conversation-recorder.js';
import { validateReplyRequest } from './reply-contract.js';
import type { AgentResult, AgentRunner, Logger, PendingBatch, ReplyTools, RunObserver } from './types.js';
import type { PiChildMessage, PiConfig, PiStart } from './pi-protocol.js';

export interface PiRunnerOptions extends PiConfig {
  timeoutMs: number; logger: Logger; imageMaxBytes?: number; imageTimeoutMs?: number;
  presentationSecrets?:string[];
}
const CHILD = fileURLToPath(new URL('./pi-child.js', import.meta.url));
export const BASE_INSTRUCTIONS_PATH = fileURLToPath(new URL('../../prompts/base-instructions.md', import.meta.url));
const GRACE_MS = 1_000;

export function piFailure(code: string, message: string, secrets: string[]): Error & { code: string; providerStatus?: number } {
  const safeCode = /^PI_[A-Z0-9_]{1,60}$/.test(code) ? code : 'PI_EXECUTION_FAILED';
  const status = /^(?:HTTP\s+)?([45]\d\d)(?:\b|:)/.exec(message.trim());
  const detail = (safeToolPayload(message, secrets) as string)
    .replace(/https?:\/\/[^\s<>"']+/gi, '[url]')
    .replace(/\b(?:localhost|host\.docker\.internal)(?::\d+)?(?:\/[^\s<>"']*)?/gi, '[host]')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, 500);
  return Object.assign(new Error(`${safeCode}${detail ? `: ${detail}` : ''}`), { code: safeCode,
    ...(status ? { providerStatus: Number(status[1]) } : {}) });
}

/** Keep model and service credentials out of subprocess and shell environments. */
export function piEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'TEMP', 'TMP', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'PLAYWRIGHT_BROWSERS_PATH', 'PYTHONPATH', 'VIRTUAL_ENV']) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  result.PI_SKIP_VERSION_CHECK = '1';
  return result;
}

function within(root: string, path: string): boolean {
  const child = relative(root, path);
  return !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`);
}

export async function validatePiSession(home: string, session: string): Promise<string> {
  const root = await realpath(resolve(home, 'sessions'));
  if (!isAbsolute(session) || !session.endsWith('.jsonl')) throw new Error('PI_INVALID_SESSION');
  const actual = await realpath(session);
  if (!within(root, actual) || !(await stat(actual)).isFile()) throw new Error('PI_INVALID_SESSION');
  return actual;
}

export class PiRunner implements AgentRunner {
  constructor(readonly options: PiRunnerOptions) {}

  async run(batch: PendingBatch, session: string | null, onSession: (id: string) => void, signal: AbortSignal, replies?: ReplyTools, observer?: RunObserver): Promise<AgentResult> {
    signal.throwIfAborted();
    const images = await prepareIncomingImages(batch.messages, { workspace: this.options.workspace,
      maxBytes: this.options.imageMaxBytes ?? 10 * 1024 * 1024, timeoutMs: this.options.imageTimeoutMs ?? 30_000,
      logger: this.options.logger }, signal);
    const prompt = JSON.stringify(batch.messages.map(message => ({ messageId: message.messageId,
      senderId: message.senderId, senderName: message.senderName, time: message.time, text: message.text,
      replyTo: message.replyTo, ...(images.byMessageId.has(message.messageId) ? { images: images.byMessageId.get(message.messageId) } : {}),
    })));
    const attachments: PiStart['images'] = [];
    if (this.options.supportsImages) for (const path of images.files) {
      const bytes = await readFile(path);
      const mimeType = path.endsWith('.png') ? 'image/png' : path.endsWith('.gif') ? 'image/gif' : path.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
      attachments.push({ type: 'image', data: bytes.toString('base64'), mimeType });
    }
    await this.execute(batch.replyAllowed ? 'run' : 'append', session, prompt, attachments, onSession, signal, batch.replyAllowed ? replies : undefined, observer);
    return { messages: [] };
  }

  async compact(session: string, signal: AbortSignal, observer?: RunObserver): Promise<void> {
    await this.execute('compact', session, '', [], () => {}, signal, undefined, observer);
  }

  private async execute(operation: PiStart['operation'], session: string | null, prompt: string, images: PiStart['images'], onSession: (id: string) => void,
    signal: AbortSignal, replies?: ReplyTools, observer?: RunObserver): Promise<void> {
    signal.throwIfAborted();
    if (operation !== 'append' && (!this.options.model.trim() || !this.options.baseUrl.trim())) {
      throw piFailure('PI_CONFIGURATION_REQUIRED', 'Configure both the model and provider base URL before generating or compacting.', []);
    }
    await mkdir(resolve(this.options.home, 'sessions'), { recursive: true, mode: 0o700 });
    if (session !== null) session = await validatePiSession(this.options.home, session);
    const runId = randomUUID(); const started = Date.now();
    const log = (level: 'info' | 'warn' | 'error', event: string, fields = {}) => logEvent(this.options.logger, level, event,
      { run_id: runId, operation, ...fields });
    const { logger: _logger, timeoutMs: _timeout, imageMaxBytes: _bytes, imageTimeoutMs: _imageTimeout, presentationSecrets=[], ...config } = this.options;
    const system = `${await readFile(BASE_INSTRUCTIONS_PATH, 'utf8')}\n\n${config.persona}`;
    log('info', 'agent.run.started', { resumed: session !== null, model: config.model, api: config.api });
    await new Promise<void>((resolveRun, rejectRun) => {
      const child = fork(CHILD, [], { cwd: config.workspace, env: piEnvironment(), execArgv: [],
        detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      let failure: Error | undefined; let done = false; let accepted = 0; let ended = false;
      let queue: Promise<void> = Promise.resolve(); let killTimer: NodeJS.Timeout | undefined;
      let stderrBytes = 0;
      const activeThinking=new Map<string,Record<string,unknown>>();
      child.stderr?.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; });
      const kill = () => {
        if (!child.pid) return;
        try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {}
      };
      const stop = (error: Error) => {
        failure ??= error;
        if (ended) return;
        if (child.connected) child.send({ type: 'abort' });
        killTimer ??= setTimeout(kill, GRACE_MS);
      };
      const abort = () => stop(new Error('PI_ABORTED'));
      const timeout = setTimeout(() => stop(new Error('PI_TIMEOUT')), this.options.timeoutMs);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      child.on('message', (raw: unknown) => {
        const message = raw as PiChildMessage;
        queue = queue.then(async () => {
          if (!message || typeof message !== 'object') throw new Error('PI_INVALID_EVENT');
          if (message.type === 'send') {
            let allowed = false;
            if (!failure && !signal.aborted && replies && operation === 'run') {
              try { await replies.send(validateReplyRequest(message.request, config.targetType)); accepted++; allowed = true; }
              catch { stop(new Error('PI_REPLY_ACCEPT_FAILED')); }
            }
            if (child.connected) child.send({ type: 'send-result', id: message.id, accepted: allowed });
          } else if (message.type === 'session') {
            const path = await validatePiSession(config.home, message.path);
            onSession(path); log('info', 'agent.session.established', { session_ref: fingerprint(path) });
          } else if (message.type === 'event') {
            const secrets = [...presentationSecrets,config.apiKey, config.webSearch?.provider === 'tavily' ? config.webSearch.apiKey : undefined].filter((value): value is string => !!value);
            const payload=message.event.type.startsWith('tool.')||message.event.type==='thinking.updated'
              ? safeToolPayload(message.event.payload,secrets) as Record<string,unknown>:message.event.payload;
            if(message.event.type==='thinking.updated'&&message.event.itemId) {
              if(payload.status==='in_progress')activeThinking.set(message.event.itemId,payload);else activeThinking.delete(message.event.itemId);
            }
            observer?.({ ...message.event,payload });
            if (message.event.type.startsWith('tool.')) log('info', `agent.${message.event.type}`, {
              tool: String(message.event.payload.tool ?? 'unknown'), item_ref: fingerprint(message.event.itemId ?? ''), status: String(message.event.payload.status ?? '') });
          } else if (message.type === 'failure') {
            // Provider messages may contain URLs or echoed input. Persist only bounded, redacted diagnostics.
            const error = piFailure(message.code, message.message ?? '', [config.apiKey ?? '', config.webSearch?.provider === 'tavily' ? config.webSearch.apiKey : '']);
            stop(error);
          } else if (message.type === 'done') { done = true; }
          else throw new Error('PI_INVALID_EVENT');
        }).catch(error => stop(error instanceof Error ? error : new Error('PI_EVENT_FAILED')));
      });
      child.once('error', error => stop(error));
      child.once('close', (code, childSignal) => {
        ended = true;
        kill(); // Reap terminal children that kept the Agent process group alive.
        clearTimeout(timeout); clearTimeout(killTimer); signal.removeEventListener('abort', abort);
        void queue.then(() => {
          if (!failure && (!done || code !== 0)) failure = new Error('PI_PROCESS_FAILED');
          if (!failure && operation === 'run' && accepted === 0) failure = new Error('PI_NO_REPLY');
          for(const [itemId,payload] of activeThinking)observer?.({type:'thinking.updated',itemId,payload:{...payload,status:'failed'}});
          log(failure ? 'warn' : 'info', failure ? 'agent.run.failed' : 'agent.run.completed',
            { duration_ms: Date.now() - started, exit_code: code, signal: childSignal, stderr_bytes: stderrBytes,
              accepted_requests: accepted, reason: failure ? /^PI_[A-Z0-9_]+/.exec(failure.message)?.[0] ?? 'PI_PROCESS_FAILED' : undefined });
          failure ? rejectRun(failure) : resolveRun();
        });
      });
      if (!ended && child.connected) child.send({ type: 'start', operation, config, session, prompt, system, images } satisfies PiStart);
    });
  }
}
