import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { isMp3Snapshot } from './audio.js';
import { isSegmentMessage } from './messages.js';
import { logEvent } from './logging.js';
import type { BridgeCommand, IncomingMessage, Logger, MessageSegment, MessageSender, SendReceipt, Target } from './types.js';

type JsonObject = Record<string, unknown>;
interface Segment { type: string; data: JsonObject }

function sendFailure(error: Error, code: string, deliveryStatus: 'failed' | 'unconfirmed', retcode?: number) {
  return Object.assign(error, { code, deliveryStatus, ...(retcode !== undefined ? { retcode } : {}) });
}

const sendFailureCodes: Record<string, string> = {
  api_rejected: 'NAPCAT_API_REJECTED', response_timeout: 'NAPCAT_RESPONSE_TIMEOUT',
  aborted: 'NAPCAT_SEND_CANCELLED', disconnected: 'NAPCAT_CONNECTION_LOST',
  stopped: 'NAPCAT_CLIENT_STOPPED', send_failed: 'NAPCAT_SEND_FAILED',
};

function object(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : null;
}

function identifier(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  return typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : null;
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

function decodeEntities(value: string): string {
  // Decode once, after parsing CQ syntax, so escaped text cannot become a mention.
  return value.replace(/&amp;|&#91;|&#93;|&#44;/g, entity => ({
    '&amp;': '&', '&#91;': '[', '&#93;': ']', '&#44;': ',',
  })[entity] ?? entity);
}

function parseSegments(value: unknown): Segment[] | null {
  if (Array.isArray(value)) {
    const segments: Segment[] = [];
    for (const item of value) {
      const segment = object(item);
      if (!segment || typeof segment.type !== 'string') return null;
      segments.push({ type: segment.type, data: object(segment.data) ?? {} });
    }
    return segments;
  }
  if (typeof value !== 'string') return null;
  const segments: Segment[] = [];
  let cursor = 0;
  for (const match of value.matchAll(/\[CQ:([^,\[\]]+)((?:,[^\[\]]*)?)\]/g)) {
    const start = match.index;
    if (start > cursor) segments.push({ type: 'text', data: { text: decodeEntities(value.slice(cursor, start)) } });
    const data: JsonObject = {};
    for (const param of (match[2] ?? '').split(',').slice(1)) {
      const separator = param.indexOf('=');
      if (separator > 0) data[param.slice(0, separator)] = decodeEntities(param.slice(separator + 1));
    }
    segments.push({ type: match[1]!, data });
    cursor = start + match[0].length;
  }
  if (cursor < value.length) segments.push({ type: 'text', data: { text: decodeEntities(value.slice(cursor)) } });
  return segments;
}

function isSticker(segment: Segment): boolean {
  return ['face', 'mface', 'bface', 'sface'].includes(segment.type)
    || (segment.type === 'image' && (
      string(segment.data.sub_type ?? segment.data.subtype) === '1'
      || segment.data.file === 'marketface'
      || string(segment.data.emoji_id).length > 0
      || string(segment.data.emoji_package_id).length > 0
    ));
}

function httpSource(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? value : null;
  } catch { return null; }
}

/** Return portable ordinary image sources, without assuming access to NapCat's local files. */
export function imageSources(rawJson: string): string[] {
  let event: JsonObject | null;
  try { event = object(JSON.parse(rawJson)); } catch { return []; }
  const segments = parseSegments(event?.message);
  if (!segments) return [];
  return segments.flatMap(segment => {
    if (segment.type !== 'image' || isSticker(segment)) return [];
    const { url, file } = segment.data;
    const source = httpSource(url) ?? httpSource(file)
      ?? (typeof file === 'string' && file.startsWith('base64://') ? file : null);
    return source === null ? [] : [source];
  });
}

function hasContent(segment: Segment): boolean {
  if (segment.type === 'text') return string(segment.data.text).trim().length > 0;
  return segment.type !== 'at' && segment.type !== 'reply' && !isSticker(segment);
}

function bridgeCommand(segments: Segment[], selfId: string | null): BridgeCommand | undefined {
  if (segments.some(segment => segment.type !== 'text' && segment.type !== 'reply'
    && !(segment.type === 'at' && selfId !== null && identifier(segment.data.qq) === selfId))) return undefined;
  const text = segments.filter(segment => segment.type === 'text').map(segment => string(segment.data.text)).join('').trim();
  if (text === '/new') return 'new';
  if (text === '/compact') return 'compact';
  if (text === '/help') return 'help';
  return undefined;
}

function segmentText(segment: Segment): string {
  const { type, data } = segment;
  if (type === 'text') return string(data.text);
  if (type === 'at') return `[@${string(data.qq)}]`;
  if (type === 'reply') return `[引用 ${string(data.id ?? data.seq)}]`;
  if (isSticker(segment)) return `[表情包 ${string(data.summary ?? data.id ?? data.emoji_id ?? data.file)}]`;
  const labels: Record<string, string> = {
    image: '图片', record: '语音', video: '视频', file: '文件', forward: '转发',
    json: 'JSON', xml: 'XML', markdown: 'Markdown', dice: '骰子', rps: '猜拳',
  };
  const detail = [data.name ?? data.summary ?? data.title, data.url ?? data.file ?? data.id ?? data.text ?? data.data]
    .map(string).filter(Boolean).join(' ');
  return `[${labels[type] ?? type}${detail ? ` ${detail}` : ''}]`;
}

/** Preserve every matching incoming message; trigger only controls whether a batch may answer. */
export function normalizeMessage(
  event: unknown,
  target: Target,
  probability: number,
  random: () => number = Math.random,
  busy = false,
): IncomingMessage | null {
  const message = object(event);
  if (!message || message.post_type !== 'message' || message.message_type !== target.type) return null;
  const senderId = identifier(message.user_id);
  const selfId = identifier(message.self_id);
  const messageId = identifier(message.message_id);
  if (!senderId || !messageId || senderId === selfId) return null;
  const targetId = identifier(target.type === 'group' ? message.group_id : message.user_id);
  if (targetId !== target.id) return null;
  if (typeof message.time !== 'number' || !Number.isFinite(message.time)) return null;
  const segments = parseSegments(message.message);
  if (!segments) return null;
  const sender = object(message.sender);
  const senderName = string(sender?.card).trim() || string(sender?.nickname).trim() || senderId;
  const reply = segments.find(segment => segment.type === 'reply');
  const command = bridgeCommand(segments, selfId);
  const directlyMentioned = selfId !== null
    && segments.some(segment => segment.type === 'at' && identifier(segment.data.qq) === selfId);
  const sampled = () => !busy && segments.some(hasContent) && probability > 0 && (probability >= 1 || random() < probability);
  let rawJson: string;
  try { rawJson = JSON.stringify(event); } catch { return null; }
  return {
    messageId,
    senderId,
    senderName,
    time: message.time,
    text: segments.map(segmentText).join(''),
    replyTo: reply ? identifier(reply.data.id ?? reply.data.seq) : null,
    trigger: command !== undefined || target.type === 'private' || directlyMentioned || sampled(),
    rawJson,
    ...(command ? { command } : {}),
    ...(directlyMentioned ? { directlyMentioned: true as const } : {}),
  };
}

export interface NapCatClientOptions {
  url: string;
  token: string;
  target: Target;
  logger: Logger;
  reconnectMs: number;
  actionTimeoutMs: number;
  onEvent: (event: unknown) => void;
}

interface PendingAction {
  socket: WebSocket;
  finish: (error?: Error, reason?: string, retcode?: number, messageId?: string) => void;
}

interface ConnectionWaiter {
  resolve: (socket: WebSocket) => void;
  reject: (error: Error) => void;
}

function aborted(): Error {
  const error = new Error('NapCat send aborted');
  error.name = 'AbortError';
  return error;
}

/** One universal forward WebSocket carries both events and correlated API replies. */
export class NapCatClient implements MessageSender {
  private socket: WebSocket | null = null;
  private running = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pending = new Map<string, PendingAction>();
  private readonly waiters = new Set<ConnectionWaiter>();

  constructor(private readonly options: NapCatClientOptions) {}

  get connected(): boolean {return this.running && this.socket?.readyState===WebSocket.OPEN;}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  async stop(): Promise<void> {
    logEvent(this.options.logger, 'info', 'napcat.stopping', { pending_count: this.pending.size, waiter_count: this.waiters.size });
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    for (const waiter of [...this.waiters]) waiter.reject(new Error('NapCat client stopped'));
    for (const pending of [...this.pending.values()]) pending.finish(new Error('NapCat client stopped'), 'stopped');
    const socket = this.socket;
    this.socket = null;
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>(resolve => {
      socket.once('close', () => resolve());
      socket.terminate();
    });
  }

  async sendText(text: string, signal: AbortSignal): Promise<SendReceipt> {
    return this.sendSegments([{ type: 'text', data: { text } }], signal);
  }

  async sendImage(file: string, signal: AbortSignal): Promise<SendReceipt> {
    return this.sendSegments([{ type: 'image', data: { file, sub_type: 0 } }], signal);
  }

  async sendVoice(file: string, signal: AbortSignal): Promise<SendReceipt> {
    if (!isMp3Snapshot(file)) throw new Error('Invalid outgoing voice snapshot');
    return this.sendSegments([{ type: 'record', data: { file } }], signal);
  }

  async sendMessage(segments: MessageSegment[], signal: AbortSignal): Promise<SendReceipt> {
    if (this.options.target.type !== 'group') throw new Error('Segment messages require a group target');
    if (!isSegmentMessage({ type: 'message', segments })) throw new Error('Invalid outgoing message segments');
    return this.sendSegments(segments.map(segment => segment.type === 'at'
      ? { type: 'at', data: { qq: segment.userId } }
      : { type: 'text', data: { text: segment.text } }), signal);
  }

  private async sendSegments(segments: Segment[], signal: AbortSignal): Promise<SendReceipt> {
    const started = Date.now();
    const deadline = Date.now() + this.options.actionTimeoutMs;
    const { target, logger } = this.options;
    const action = target.type === 'group' ? 'send_group_msg' : 'send_private_msg';
    let socket: WebSocket;
    try {
      socket = await this.waitForConnection(signal, this.options.actionTimeoutMs);
      if (signal.aborted) throw aborted();
      if (!this.running || socket !== this.socket || socket.readyState !== WebSocket.OPEN) {
        throw new Error('NapCat connection lost before send');
      }
    } catch (error) {
      const failure = sendFailure(error instanceof Error ? error : new Error('NapCat unavailable before send'),
        signal.aborted ? 'NAPCAT_SEND_CANCELLED' : 'NAPCAT_CONNECTION_UNAVAILABLE', 'failed');
      logEvent(logger, 'warn', 'napcat.api.failed', {
        action, stage: 'connection', reason: signal.aborted ? 'aborted' : this.running ? 'unavailable' : 'stopped',
        error_code: failure.code, delivery_status: failure.deliveryStatus,
        segment_count: segments.length, pending_count: this.pending.size, duration_ms: Date.now() - started,
      });
      throw failure;
    }
    const echo = randomUUID();
    const request = JSON.stringify({
      action,
      params: {
        [target.type === 'group' ? 'group_id' : 'user_id']: target.id,
        message: segments,
      },
      echo,
    });
    return new Promise<SendReceipt>((resolve, reject) => {
      const onAbort = () => finish(aborted(), 'aborted');
      const timer = setTimeout(() => {
        finish(new Error('NapCat API response timed out; send outcome unknown'), 'response_timeout');
        socket.terminate();
      }, Math.max(0, deadline - Date.now()));
      const finish = (error?: Error, reason?: string, retcode?: number, messageId?:string) => {
        if (!this.pending.delete(echo)) return;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        const failure = error ? sendFailure(error, sendFailureCodes[reason ?? ''] ?? 'NAPCAT_SEND_UNCONFIRMED',
          reason === 'api_rejected' ? 'failed' : 'unconfirmed', retcode) : undefined;
        logEvent(logger, error ? 'warn' : 'info', reason === 'response_timeout' ? 'napcat.api.timeout' : error ? 'napcat.api.failed' : 'napcat.api.succeeded', {
          echo, action, stage: 'send', reason, retcode, segment_count: segments.length,
          error_code: failure?.code, delivery_status: failure?.deliveryStatus,
          pending_count: this.pending.size, duration_ms: Date.now() - started,
        });
        if (failure) reject(failure); else resolve(messageId?{messageId}:{});
      };
      this.pending.set(echo, { socket, finish });
      signal.addEventListener('abort', onAbort, { once: true });
      logEvent(logger, 'info', 'napcat.api.send_started', { echo, action, segment_count: segments.length, pending_count: this.pending.size });
      try {
        socket.send(request, error => {
          if (error) finish(new Error('NapCat API send failed; send outcome unknown'), 'send_failed');
        });
      } catch {
        finish(new Error('NapCat API send failed; send outcome unknown'), 'send_failed');
      }
    });
  }

  private waitForConnection(signal: AbortSignal, timeoutMs: number): Promise<WebSocket> {
    if (signal.aborted) return Promise.reject(aborted());
    if (!this.running) return Promise.reject(new Error('NapCat client stopped'));
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve(this.socket);
    return new Promise<WebSocket>((resolve, reject) => {
      const cleanup = () => {
        this.waiters.delete(waiter);
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      };
      const waiter: ConnectionWaiter = {
        resolve: socket => { cleanup(); resolve(socket); },
        reject: error => { cleanup(); reject(error); },
      };
      const onAbort = () => waiter.reject(aborted());
      const timer = setTimeout(() => {
        logEvent(this.options.logger, 'warn', 'napcat.connection.wait_timeout', { timeout_ms: timeoutMs, waiter_count: this.waiters.size });
        waiter.reject(new Error('NapCat connection timed out'));
      }, timeoutMs);
      this.waiters.add(waiter);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private connect(): void {
    if (!this.running) return;
    const started = Date.now();
    logEvent(this.options.logger, 'info', 'napcat.connection.started', { timeout_ms: this.options.actionTimeoutMs });
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.options.url, {
        headers: this.options.token ? { Authorization: `Bearer ${this.options.token}` } : {},
        handshakeTimeout: this.options.actionTimeoutMs,
      });
    } catch {
      logEvent(this.options.logger, 'warn', 'napcat.connection.failed', { reason: 'invalid_configuration', duration_ms: Date.now() - started });
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.on('open', () => {
      if (!this.running || this.socket !== socket) { socket.terminate(); return; }
      logEvent(this.options.logger, 'info', 'napcat.connection.connected', {
        duration_ms: Date.now() - started, pending_count: this.pending.size, waiter_count: this.waiters.size,
      });
      for (const waiter of [...this.waiters]) waiter.resolve(socket);
    });
    socket.on('message', data => {
      if (!this.running || this.socket !== socket) return;
      let packet: JsonObject | null;
      try { packet = object(JSON.parse(data.toString())); } catch {
        logEvent(this.options.logger, 'warn', 'napcat.packet.invalid_json');
        return;
      }
      if (!packet) return;
      if (packet.status === 'failed' && packet.retcode === 1403 && packet.echo == null) {
        this.options.logger.error('NapCat WebSocket authentication failed; reconnecting');
        socket.terminate();
        return;
      }
      if (typeof packet.echo === 'string') {
        const pending = this.pending.get(packet.echo);
        if (pending?.socket === socket) {
          pending.finish(packet.status === 'ok' && packet.retcode === 0
            ? undefined : new Error(`NapCat API request failed (retcode ${typeof packet.retcode === 'number' ? packet.retcode : 'unknown'})`),
          packet.status === 'ok' && packet.retcode === 0 ? undefined : 'api_rejected',
          typeof packet.retcode === 'number' && Number.isFinite(packet.retcode) ? packet.retcode : undefined,
          typeof object(packet.data)?.message_id==='number'||typeof object(packet.data)?.message_id==='string'?String(object(packet.data)!.message_id):undefined);
          return;
        }
      }
      if (typeof packet.post_type === 'string') {
        try { this.options.onEvent(packet); } catch {
          logEvent(this.options.logger, 'error', 'napcat.event_handler.failed');
        }
      }
    });
    socket.on('error', () => {
      // ws errors can contain the complete URL and credentials. Keep logs static.
      if (this.running) logEvent(this.options.logger, 'warn', 'napcat.connection.error', { duration_ms: Date.now() - started });
      socket.terminate();
    });
    socket.on('close', code => {
      logEvent(this.options.logger, 'info', 'napcat.connection.closed', {
        code, reconnecting: this.running, pending_count: this.pending.size, duration_ms: Date.now() - started,
      });
      for (const pending of [...this.pending.values()]) {
        if (pending.socket === socket) pending.finish(new Error('NapCat connection lost; send outcome unknown'), 'disconnected');
      }
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.running) this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) return;
    logEvent(this.options.logger, 'info', 'napcat.connection.reconnect_scheduled', { retry_ms: this.options.reconnectMs });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.options.reconnectMs);
  }
}
