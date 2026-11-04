import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import type { IncomingImageDescriptor } from '../incoming-image-contract.js';
import { cacheImage, imageExtension, readIncomingImage } from '../images.js';
import { fingerprint, logEvent } from '../logging.js';
import { imageSources } from '../napcat.js';
import { createNetworkClient } from '../network.js';
import type { Logger } from '../types.js';
import type { BotRecord } from './contracts.js';

interface ImageRow {
  id: string; bot_id: string; message_id: string; image_index: number; status: string;
  source_key?: string | null;
  source_cipher: string | null; sha256: string | null; mime_type: string | null; size: number | null;
  created_at: number; expires_at: number; acknowledged_at: number | null; error: string | null;
}
interface Dependencies {
  requireBot(id: string): BotRecord;
  encrypt(value: unknown): string;
  decrypt(value: string): unknown;
  transaction<T>(fn: () => T): T;
}

const MiB = 1024 * 1024;
export const IMAGE_TRANSIT_TASK_LIMITS = { count: 1000, encryptedSourceBytes: 32 * MiB } as const;
const mimeFor = (extension: string) => `image/${extension === 'jpg' ? 'jpeg' : extension}`;
const extensionFor = (mime: string) => ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' })[mime];
const failure = (message: string, statusCode = 404) => Object.assign(new Error(message), { statusCode });

/** Shares the ingress transaction, but media acknowledgement is independent of message ACK. */
export class ConsoleIncomingImages {
  private readonly listeners = new Set<(event: { botId: string; rejected: number }) => void>();
  constructor(private readonly db: DatabaseSync, private readonly deps: Dependencies) {
    db.exec(`CREATE TABLE IF NOT EXISTS console_incoming_images (
      id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id), message_id TEXT NOT NULL,
      image_index INTEGER NOT NULL, status TEXT NOT NULL, source_cipher TEXT, sha256 TEXT, mime_type TEXT, size INTEGER,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, acknowledged_at INTEGER, error TEXT,
      UNIQUE(bot_id,message_id,image_index)
    ); CREATE INDEX IF NOT EXISTS console_incoming_images_pending ON console_incoming_images(status,created_at);
    CREATE INDEX IF NOT EXISTS console_incoming_images_bot ON console_incoming_images(bot_id,acknowledged_at,created_at);`);
    const columns = db.prepare('PRAGMA table_info(console_incoming_images)').all() as Array<{name: string}>;
    if (!columns.some(column => column.name === 'source_key')) db.exec('ALTER TABLE console_incoming_images ADD COLUMN source_key TEXT');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS console_incoming_images_source ON console_incoming_images(bot_id,message_id,source_key) WHERE source_key IS NOT NULL');
  }

  registerForwardSource(botId: string, messageId: string, sourceKey: string, source: string, now = Date.now()): IncomingImageDescriptor | null {
    const previous = this.db.prepare('SELECT * FROM console_incoming_images WHERE bot_id=? AND message_id=? AND source_key=?').get(botId, messageId, sourceKey) as unknown as ImageRow | undefined;
    if (previous) return this.descriptor(previous);
    const bot = this.deps.requireBot(botId);
    const count = this.db.prepare('SELECT COUNT(*) AS count,COALESCE(MAX(image_index),-1) AS last FROM console_incoming_images WHERE bot_id=? AND message_id=?').get(botId, messageId) as {count: number; last: number};
    if (count.count >= 64) return null;
    const occupancy = this.db.prepare('SELECT COUNT(*) AS count,COALESCE(SUM(LENGTH(source_cipher)),0) AS bytes FROM console_incoming_images WHERE bot_id=? AND source_cipher IS NOT NULL').get(botId) as {count: number; bytes: number};
    const estimate = Math.ceil(Buffer.byteLength(JSON.stringify(source)) * 4 / 3) + 128;
    const full = occupancy.count >= IMAGE_TRANSIT_TASK_LIMITS.count || occupancy.bytes + estimate > IMAGE_TRANSIT_TASK_LIMITS.encryptedSourceBytes;
    const attachmentId = randomUUID();
    this.db.prepare(`INSERT INTO console_incoming_images
      (id,bot_id,message_id,image_index,source_key,status,source_cipher,created_at,expires_at,error) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(attachmentId, botId, messageId, count.last + 1, sourceKey, full ? 'failed' : 'pending', full ? null : this.deps.encrypt(source), now,
        now + bot.config.imageTransitHours * 3600_000, full ? '图片下载队列已满' : null);
    for (const listener of this.listeners) listener({botId, rejected: full ? 1 : 0});
    return this.get(botId, attachmentId);
  }

  register(botId: string, event: unknown, now = Date.now()): void {
    const packet = event && typeof event === 'object' && !Array.isArray(event) ? event as Record<string, unknown> : null;
    const value = packet?.message_id;
    const messageId = typeof value === 'string' && value && value.length <= 200 ? value : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : null;
    if (!messageId) return;
    const sources = imageSources(JSON.stringify(event));
    if (!sources.length) return;
    const bot = this.deps.requireBot(botId);
    const occupancy = this.db.prepare('SELECT COUNT(*) AS count,COALESCE(SUM(LENGTH(source_cipher)),0) AS bytes FROM console_incoming_images WHERE bot_id=? AND source_cipher IS NOT NULL').get(botId) as { count: number; bytes: number };
    let rejected = 0;
    for (const [index, source] of sources.entries()) {
      if (this.db.prepare('SELECT 1 FROM console_incoming_images WHERE bot_id=? AND message_id=? AND image_index=?').get(botId, messageId, index)) continue;
      const estimate = Math.ceil(Buffer.byteLength(JSON.stringify(source)) * 4 / 3) + 128;
      const full = occupancy.count >= IMAGE_TRANSIT_TASK_LIMITS.count || occupancy.bytes + estimate > IMAGE_TRANSIT_TASK_LIMITS.encryptedSourceBytes;
      const cipher = full ? null : this.deps.encrypt(source);
      this.db.prepare(`INSERT INTO console_incoming_images
        (id,bot_id,message_id,image_index,status,source_cipher,created_at,expires_at,error) VALUES(?,?,?,?,?,?,?,?,?)`)
        .run(randomUUID(), botId, messageId, index, full ? 'failed' : 'pending', cipher, now, now + bot.config.imageTransitHours * 3600_000, full ? '图片下载队列已满' : null);
      if (full) rejected++;
      else { occupancy.count++; occupancy.bytes += Buffer.byteLength(cipher!); }
    }
    for (const listener of this.listeners) listener({ botId, rejected });
  }

  subscribe(listener: (event: { botId: string; rejected: number }) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  recover(): void { this.db.prepare("UPDATE console_incoming_images SET status='pending' WHERE status='downloading'").run(); }
  forMessage(botId: string, messageId: string): IncomingImageDescriptor[] {
    return (this.db.prepare('SELECT * FROM console_incoming_images WHERE bot_id=? AND message_id=? ORDER BY image_index').all(botId, messageId) as unknown as ImageRow[]).map(row => this.descriptor(row));
  }
  list(botId: string, after?: string): IncomingImageDescriptor[] {
    this.deps.requireBot(botId);
    const cursor = typeof after === 'string' ? this.db.prepare('SELECT created_at,id FROM console_incoming_images WHERE bot_id=? AND id=?').get(botId, after) as {created_at: number; id: string} | undefined : undefined;
    const rows = cursor ? this.db.prepare(`SELECT * FROM console_incoming_images WHERE bot_id=? AND acknowledged_at IS NULL
      AND (created_at>? OR created_at=? AND id>?) ORDER BY created_at,id LIMIT 100`).all(botId, cursor.created_at, cursor.created_at, cursor.id)
      : this.db.prepare('SELECT * FROM console_incoming_images WHERE bot_id=? AND acknowledged_at IS NULL ORDER BY created_at,id LIMIT 100').all(botId);
    return (rows as unknown as ImageRow[]).map(row => this.descriptor(row));
  }
  get(botId: string, id: string): IncomingImageDescriptor { return this.descriptor(this.require(botId, id)); }
  source(id: string): { botId: string; source: string } | null {
    const row = this.db.prepare("SELECT * FROM console_incoming_images WHERE id=? AND status='downloading'").get(id) as unknown as ImageRow | undefined;
    if (!row?.source_cipher) return null;
    const source = this.deps.decrypt(row.source_cipher);
    return typeof source === 'string' ? { botId: row.bot_id, source } : null;
  }
  pending(limit = 100): Array<{ id: string; botId: string }> {
    return (this.db.prepare(`SELECT id,bot_id FROM (SELECT id,bot_id,created_at,
      ROW_NUMBER() OVER (PARTITION BY bot_id ORDER BY created_at,id) AS rank FROM console_incoming_images WHERE status='pending')
      WHERE rank<=2 ORDER BY created_at,id LIMIT ?`).all(limit) as Array<{id: string; bot_id: string}>).map(row => ({ id: row.id, botId: row.bot_id }));
  }
  claim(id: string): boolean { return this.db.prepare("UPDATE console_incoming_images SET status='downloading' WHERE id=? AND status='pending'").run(id).changes === 1; }
  reset(id: string): void { this.db.prepare("UPDATE console_incoming_images SET status='pending' WHERE id=? AND status='downloading'").run(id); }
  fail(id: string, error: string): void {
    this.db.prepare("UPDATE console_incoming_images SET status='failed',source_cipher=NULL,error=? WHERE id=? AND status IN ('pending','downloading')").run(error, id);
  }
  unavailable(botId: string, id: string): void {
    this.db.prepare("UPDATE console_incoming_images SET status='failed',source_cipher=NULL,error='图片缓存文件不可用' WHERE bot_id=? AND id=? AND status='ready'").run(botId, id);
  }
  complete(id: string, sha256: string, mimeType: string, size: number): boolean {
    return this.deps.transaction(() => {
      const row = this.db.prepare('SELECT * FROM console_incoming_images WHERE id=?').get(id) as unknown as ImageRow | undefined;
      if (!row || row.status !== 'downloading') return false;
      const config = this.deps.requireBot(row.bot_id).config;
      const same = this.references(row.bot_id, sha256) > 0;
      const used = Number(this.db.prepare("SELECT COALESCE(SUM(size),0) AS bytes FROM (SELECT sha256,MAX(size) AS size FROM console_incoming_images WHERE bot_id=? AND status='ready' GROUP BY sha256)").get(row.bot_id)!.bytes);
      if (!same && used + size > config.imageTransitMaxMiB * MiB) { this.fail(id, '图片中转缓存空间不足'); return false; }
      this.db.prepare("UPDATE console_incoming_images SET status='ready',source_cipher=NULL,sha256=?,mime_type=?,size=?,error=NULL WHERE id=?").run(sha256, mimeType, size, id);
      return true;
    });
  }
  acknowledge(botId: string, id: string, sha256?: unknown): IncomingImageDescriptor {
    return this.deps.transaction(() => {
      const row = this.require(botId, id);
      if (row.status === 'pending' || row.status === 'downloading') throw failure('请求的图片尚未下载完成', 409);
      if ((row.status === 'ready' || row.status === 'transferred') && (typeof sha256 !== 'string' || sha256 !== row.sha256)) throw failure('请求的图片校验值无效', 409);
      if (row.acknowledged_at === null) this.db.prepare("UPDATE console_incoming_images SET acknowledged_at=?,status=CASE WHEN status='ready' THEN 'transferred' ELSE status END WHERE id=?").run(Date.now(), id);
      return this.get(botId, id);
    });
  }
  expire(now = Date.now()): number {
    return Number(this.db.prepare("UPDATE console_incoming_images SET status='expired',source_cipher=NULL,error='图片中转缓存已过期' WHERE expires_at<=? AND status IN ('pending','downloading','ready')").run(now).changes);
  }
  references(botId: string, sha256: string): number { return Number(this.db.prepare("SELECT COUNT(*) AS n FROM console_incoming_images WHERE bot_id=? AND sha256=? AND status='ready'").get(botId, sha256)!.n); }
  botIds(): string[] { return (this.db.prepare('SELECT DISTINCT bot_id FROM console_incoming_images').all() as Array<{bot_id: string}>).map(row => row.bot_id); }
  private require(botId: string, id: string): ImageRow {
    this.deps.requireBot(botId);
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/u.test(id)) throw failure('请求的图片不存在');
    const row = this.db.prepare('SELECT * FROM console_incoming_images WHERE bot_id=? AND id=?').get(botId, id) as unknown as ImageRow | undefined;
    if (!row) throw failure('请求的图片不存在');
    return row;
  }
  private descriptor(row: ImageRow): IncomingImageDescriptor {
    return { id: row.id, messageId: row.message_id, index: row.image_index,
      ...(row.source_key ? { sourceKey: row.source_key } : {}),
      status: row.status === 'downloading' ? 'pending' : row.status as IncomingImageDescriptor['status'],
      ...(row.sha256 ? { sha256: row.sha256 } : {}), ...(row.mime_type ? { mimeType: row.mime_type } : {}),
      ...(row.size !== null ? { size: row.size } : {}), ...(row.error ? { error: row.error } : {}) };
  }
}

interface PrefetchOptions {
  store: ConsoleIncomingImages; root: string; bot(id: string): BotRecord | null; logger: Logger;
  fetch?: typeof globalThis.fetch; intervalMs?: number;
}

/** Downloads run independently of model generation and Worker availability. */
export class ConsoleImagePrefetch {
  private readonly controller = new AbortController();
  private readonly active = new Map<string, { botId: string; done: Promise<void> }>();
  private readonly fileLocks = new Map<string, Promise<unknown>>();
  private unsubscribe?: () => void;
  private timer?: ReturnType<typeof setInterval>;
  private scheduled = false;
  private started = false;
  private maintenance?: Promise<void>;
  constructor(private readonly options: PrefetchOptions) {}
  start(timers = true): void {
    if (this.started) return;
    this.started = true;
    this.options.store.recover();
    this.unsubscribe = this.options.store.subscribe(event => {
      if (event.rejected) logEvent(this.options.logger, 'warn', 'console.image.queue_full', { bot_id: event.botId, rejected_count: event.rejected });
      this.notify();
    });
    if (timers) { this.timer = setInterval(() => this.notify(), this.options.intervalMs ?? 2000); this.timer.unref(); }
    this.notify();
  }
  notify(): void {
    if (this.scheduled || this.controller.signal.aborted) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.tick(); });
  }
  tick(): void {
    if (this.controller.signal.aborted) return;
    const expired = this.options.store.expire();
    if (expired) logEvent(this.options.logger, 'info', 'console.image.expired', { count: expired });
    this.maintenance ??= this.cleanup().catch(() => logEvent(this.options.logger, 'warn', 'console.image.cleanup_failed')).finally(() => { this.maintenance = undefined; });
    for (const job of this.options.store.pending(1000)) {
      if (this.active.size >= 4) break;
      if ([...this.active.values()].filter(value => value.botId === job.botId).length >= 2 || !this.options.store.claim(job.id)) continue;
      const done = Promise.resolve().then(() => this.download(job.id)).catch(() => {
        if (!this.controller.signal.aborted) this.options.store.fail(job.id, '图片读取失败');
      }).finally(() => { this.active.delete(job.id); this.notify(); });
      this.active.set(job.id, { botId: job.botId, done });
    }
  }
  async content(botId: string, id: string): Promise<{ bytes: Buffer; mimeType: string }> {
    this.options.store.expire();
    const image = this.options.store.get(botId, id);
    if (image.status !== 'ready' || !image.sha256 || !image.mimeType) throw failure('请求的图片暂不可用', image.status === 'expired' || image.status === 'transferred' ? 410 : 404);
    const path = this.path(botId, image.sha256, image.mimeType);
    try {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size !== image.size || stat.size > 16 * MiB) throw failure('请求的图片校验失败');
        const bytes = await handle.readFile();
        if (createHash('sha256').update(bytes).digest('hex') !== image.sha256 || mimeFor(imageExtension(bytes)) !== image.mimeType) throw failure('请求的图片校验失败');
        return { bytes, mimeType: image.mimeType };
      } finally { await handle.close(); }
    } catch {
      this.options.store.unavailable(botId, id);
      throw failure('请求的图片暂不可用');
    }
  }
  async acknowledge(botId: string, id: string, sha256?: unknown): Promise<void> {
    const image = this.options.store.acknowledge(botId, id, sha256);
    if (image.sha256 && image.mimeType) {
      const path = this.path(botId, image.sha256, image.mimeType);
      await this.withFile(path, async () => { if (this.options.store.references(botId, image.sha256!) === 0) await rm(path, { force: true }); });
    }
    logEvent(this.options.logger, 'info', 'console.image.transferred', { bot_id: botId, attachment_id: id });
  }
  async close(): Promise<void> {
    this.unsubscribe?.(); if (this.timer) clearInterval(this.timer);
    this.controller.abort();
    await Promise.allSettled([...this.active.values()].map(value => value.done));
    await this.maintenance;
    await Promise.allSettled([...this.fileLocks.values()]);
  }
  private workspace(botId: string): string {
    if (!/^[a-zA-Z0-9_-]{1,100}$/u.test(botId)) throw failure('实例标识无效');
    return join(this.options.root, botId);
  }
  private path(botId: string, hash: string, mimeType: string): string {
    const extension = extensionFor(mimeType);
    if (!/^[a-f0-9]{64}$/u.test(hash) || !extension) throw failure('请求的图片校验失败');
    return join(this.workspace(botId), '.qq-images', `${hash}.${extension}`);
  }
  private async download(id: string): Promise<void> {
    const item = this.options.store.source(id); if (!item) return;
    const bot = this.options.bot(item.botId); if (!bot) { this.options.store.fail(id, '图片所属实例不存在'); return; }
    const started = Date.now();
    const fields = { bot_id: bot.id, attachment_id: id, message_ref: fingerprint(this.options.store.get(bot.id, id).messageId) };
    logEvent(this.options.logger, 'info', 'console.image.download_started', fields);
    const config = bot.config;
    const network = createNetworkClient({ enabled: config.proxyEnabled, url: config.proxyUrl, username: config.proxyUsername,
      password: config.proxyPassword, noProxy: config.proxyNoProxy, forTools: config.proxyForTools }, this.options.logger, 'images');
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(config.imageTimeout * 1000)]);
    let saved: string | undefined;
    try {
      const workspace = this.workspace(bot.id); await mkdir(workspace, { recursive: true, mode: 0o700 });
      let bytes: Buffer | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        let status: number | undefined;
        try {
          bytes = await readIncomingImage(item.source, { workspace, maxBytes: config.imageMaxMiB * MiB, timeoutMs: config.imageTimeout * 1000,
            fetch: async (input, init) => { const response = await (this.options.fetch ?? network.fetch)(input, init); status = response.status; return response; } }, signal);
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : '';
          const retry = status === undefined || status === 408 || status === 429 || status >= 500;
          if (attempt === 2 || !retry || signal.aborted || message.includes('格式') || message.includes('大小') || message.includes('编码')) throw error;
          await delay(100 * (attempt + 1), undefined, { signal });
        }
      }
      if (!bytes) throw new Error('图片读取失败');
      const hash = createHash('sha256').update(bytes).digest('hex');
      const mime = mimeFor(imageExtension(bytes));
      const target = this.path(bot.id, hash, mime);
      await this.withFile(target, async () => {
        saved = await cacheImage(bytes, { workspace, maxBytes: config.imageMaxMiB * MiB, timeoutMs: config.imageTimeout * 1000 }, signal);
        if (!this.options.store.complete(id, hash, mime, bytes.length) && this.options.store.references(bot.id, hash) === 0) await rm(saved, { force: true });
      });
      const image = this.options.store.get(bot.id, id);
      logEvent(this.options.logger, image.status === 'ready' ? 'info' : 'warn', image.status === 'ready' ? 'console.image.ready' : 'console.image.failed', {
        ...fields, bytes: bytes.length, duration_ms: Date.now() - started, ...(image.error ? { reason: image.error } : {}),
      });
    } catch (error) {
      if (this.controller.signal.aborted) this.options.store.reset(id);
      else {
        const message = error instanceof Error ? error.message : '';
        const reason = signal.aborted ? '图片下载超时' : /^图片(?:来源不支持|格式不支持|超过大小限制|编码无效|下载失败|下载超时|读取失败)$/u.test(message) ? message : '图片读取失败';
        this.options.store.fail(id, reason);
        logEvent(this.options.logger, 'warn', 'console.image.failed', { ...fields, duration_ms: Date.now() - started, reason });
      }
    } finally { await network.close(); }
  }
  private async cleanup(): Promise<void> {
    for (const botId of this.options.store.botIds()) {
      const directory = join(this.workspace(botId), '.qq-images');
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const match = /^([a-f0-9]{64})\.(png|jpg|gif|webp)$/u.exec(entry.name);
        const path = join(directory, entry.name);
        if (entry.isFile() && match) await this.withFile(path, async () => {
          if (this.options.store.references(botId, match[1]!) === 0) await rm(path, { force: true });
        });
        else if (entry.isFile() && /^[a-f0-9-]{36}\.tmp$/u.test(entry.name)) {
          const metadata = await stat(path).catch(() => undefined);
          if (metadata && Date.now() - metadata.mtimeMs > 15 * 60_000) await rm(path, { force: true });
        }
      }
    }
  }
  private async withFile<T>(path: string, action: () => Promise<T>): Promise<T> {
    const previous = this.fileLocks.get(path) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(action);
    this.fileLocks.set(path, current);
    try { return await current; }
    finally { if (this.fileLocks.get(path) === current) this.fileLocks.delete(path); }
  }
}
