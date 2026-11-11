import { createHash, randomUUID } from 'node:crypto';
import { constants, existsSync, mkdirSync } from 'node:fs';
import { lstat, open, readdir, realpath, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate as yieldToEventLoop, setTimeout as delay } from 'node:timers/promises';
import { cacheImage, imageExtension, readIncomingImage, type ImageOptions } from './images.js';
import type { CachedIncomingImage, IncomingImageDescriptor, IncomingImageRemote, PreparedIncomingImages } from './incoming-image-contract.js';
import { fingerprint, logEvent } from './logging.js';
import { imageSources } from './napcat.js';
import type { IncomingMessage, Logger, StoredMessage } from './types.js';

interface ImageRow {
  id: string; message_id: string; image_index: number; source: string | null; remote_id: string | null;
  status: CachedIncomingImage['status']; sha256: string | null; mime_type: string | null; size: number | null;
  path: string | null; error: string | null; created_at: number; last_access_at: number;
  consumed: number; ack_pending: number; next_attempt_at: number; managed: number;
  source_plugin: string | null; plugin_asset_id: string | null; plugin_attempts: number;
  source_key: string | null;
}

export interface WorkerIncomingImageOptions {
  dbPath: string; workspace: string; maxBytes: number; timeoutMs: number; cacheDays: number; cacheMaxBytes: number;
  logger: Logger; fetch?: typeof globalThis.fetch; remote?: IncomingImageRemote;
  onUpdated?: (messageId: string, images: CachedIncomingImage[]) => void | boolean;
  isProtected?: (messageId: string) => boolean;
  pluginContent?: (assetId: string, signal: AbortSignal) => Promise<Buffer>;
}

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const mime = (extension: string) => `image/${extension === 'jpg' ? 'jpeg' : extension}`;
const safeError = (error: unknown) => error instanceof Error && /^图片(?:超过大小限制|格式不支持|下载失败|下载超时|编码无效|来源不支持|缓存路径不允许|路径不允许|读取失败|缓存空间不足|内容校验失败|缓存已过期)$/u.test(error.message)
  ? error.message : '图片读取失败';

/** Independent media lane. It never starts a model turn or changes the conversation's busy state. */
export class WorkerIncomingImages {
  private readonly db: DatabaseSync;
  private readonly controller = new AbortController();
  private readonly active = new Map<string, Promise<void>>();
  private readonly pins = new Map<string, number>();
  private started = false;
  private closed = false;
  private timer?: NodeJS.Timeout;
  private syncing?: Promise<void>;
  private recoveringPresentations?: Promise<void>;
  private lastRemoteSyncAt = 0;
  private cleanupAt = 0;
  private persistence: Promise<void> = Promise.resolve();
  private readonly contentLocks = new Map<string, Promise<void>>();
  private parentAbort?: () => void;

  constructor(readonly options: WorkerIncomingImageOptions, private readonly parentSignal?: AbortSignal) {
    for (const value of [options.maxBytes, options.timeoutMs, options.cacheMaxBytes]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error('图片配置无效');
    }
    if (!Number.isFinite(options.cacheDays) || options.cacheDays <= 0) throw new Error('图片配置无效');
    if (options.dbPath !== ':memory:') mkdirSync(dirname(options.dbPath), { recursive: true, mode: 0o700 });
    mkdirSync(options.workspace, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(options.dbPath);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS incoming_image_cache (
        id TEXT PRIMARY KEY, message_id TEXT NOT NULL, image_index INTEGER NOT NULL,
        source TEXT, remote_id TEXT, status TEXT NOT NULL, sha256 TEXT, mime_type TEXT, size INTEGER,
        path TEXT, error TEXT, created_at INTEGER NOT NULL, last_access_at INTEGER NOT NULL,
        consumed INTEGER NOT NULL DEFAULT 0, ack_pending INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0, managed INTEGER NOT NULL DEFAULT 0, UNIQUE(message_id,image_index)
      ); CREATE INDEX IF NOT EXISTS incoming_image_work ON incoming_image_cache(status,next_attempt_at);
      CREATE TABLE IF NOT EXISTS incoming_image_presentations(message_id TEXT PRIMARY KEY,signature TEXT NOT NULL);`);
    if (!this.db.prepare('PRAGMA table_info(incoming_image_cache)').all().some(column => column.name === 'managed'))
      this.db.exec('ALTER TABLE incoming_image_cache ADD COLUMN managed INTEGER NOT NULL DEFAULT 0');
    const columns=this.db.prepare('PRAGMA table_info(incoming_image_cache)').all();
    for(const [name,type] of [['source_plugin','TEXT'],['plugin_asset_id','TEXT'],['plugin_attempts','INTEGER NOT NULL DEFAULT 0'],['source_key','TEXT']])
      if(!columns.some(column=>column.name===name))this.db.exec(`ALTER TABLE incoming_image_cache ADD COLUMN ${name} ${type}`);
    if (parentSignal) {
      this.parentAbort = () => this.controller.abort(parentSignal.reason);
      parentSignal.addEventListener('abort', this.parentAbort, { once: true });
      if (parentSignal.aborted) this.parentAbort();
    }
  }

  start(): void {
    if (this.started || this.closed || this.controller.signal.aborted) return;
    this.started = true;
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref();
    this.tick();
    this.recoveringPresentations = this.recoverPresentations().catch(() => {
      if (!this.controller.signal.aborted) logEvent(this.options.logger, 'warn', 'image.cache.presentation_recovery_failed');
    }).finally(() => { this.recoveringPresentations = undefined; });
  }

  private async recoverPresentations(): Promise<void> {
    if (!this.options.onUpdated) return;
    let after = '';
    while (!this.closed && !this.controller.signal.aborted) {
      const messages = this.db.prepare(`SELECT DISTINCT message_id FROM incoming_image_cache
        WHERE message_id>? ORDER BY message_id LIMIT 100`).all(after) as { message_id: string }[];
      if (!messages.length) return;
      for (const row of messages) this.updated(row.message_id);
      after = messages.at(-1)!.message_id;
      await yieldToEventLoop(undefined, { signal: this.controller.signal });
    }
  }

  register(message: IncomingMessage | StoredMessage, descriptors?: IncomingImageDescriptor[]): void {
    if (this.closed || message.command) return;
    const now = Date.now();
    const sources = imageSources(message.rawJson);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const [index, source] of sources.entries()) {
        this.db.prepare(`INSERT OR IGNORE INTO incoming_image_cache
          (id,message_id,image_index,source,status,created_at,last_access_at,managed) VALUES(?,?,?,?,?,?,?,?)`)
          .run(randomUUID(), message.messageId, index, source, 'pending', now, now, descriptors === undefined ? 0 : 1);
      }
      for (const descriptor of descriptors ?? []) {
        if (descriptor.messageId === message.messageId) this.importDescriptor(descriptor);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    if (sources.length || descriptors?.length) this.updated(message.messageId);
    this.pump();
  }

  lookup(messageId: string): CachedIncomingImage[] {
    if (this.closed) return [];
    return this.rows(messageId).map(row => this.publicImage(row));
  }

  /** Plugin source pictures share the bounded durable cache, with a separate attachment namespace. */
  registerPlugin(messageId: string, pluginId: string, assetIds: string[]): void {
    if(this.closed||!this.options.pluginContent||!messageId||messageId.length>200||!/^[a-z][a-z0-9-]{0,79}$/u.test(pluginId))return;
    const ids=[...new Set(assetIds)].filter(id=>/^[A-Za-z0-9_-]{1,200}$/u.test(id)).slice(0,64),now=Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      let index=Math.max(9999,Number((this.db.prepare('SELECT MAX(image_index) AS n FROM incoming_image_cache WHERE message_id=?').get(messageId) as {n:number|null}).n??0));
      for(const assetId of ids) {
        const id=`plugin:${createHash('sha256').update(`${pluginId}\n${assetId}`).digest('hex')}`;
        // The same asset may be shared by several source messages; attachment ownership remains per message.
        const attachment=`${id}:${createHash('sha256').update(messageId).digest('hex').slice(0,16)}`;
        if(this.db.prepare('SELECT 1 FROM incoming_image_cache WHERE id=?').get(attachment))continue;
        this.db.prepare(`INSERT OR IGNORE INTO incoming_image_cache
          (id,message_id,image_index,status,created_at,last_access_at,source_plugin,plugin_asset_id)
          VALUES(?,?,?,'pending',?,?,?,?)`).run(attachment,messageId,++index,now,now,pluginId,assetId);
      }
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
    if(ids.length)this.updated(messageId);
    this.pump();
  }

  /** Keep referenced files alive until the caller finishes generation and its file tools. */
  retain(messageIds: string[]): () => void {
    const ids = [...new Set(messageIds)];
    for (const id of ids) this.pins.set(id, (this.pins.get(id) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const id of ids) {
        const count = (this.pins.get(id) ?? 1) - 1;
        if (count) this.pins.set(id, count); else this.pins.delete(id);
      }
    };
  }

  /** Accept only a verified content-addressed path explicitly referenced by an older session. */
  async adoptLegacy(messageId: string, index: number, path: string, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    if (this.closed || !messageId || !Number.isSafeInteger(index) || index < 0) return false;
    try {
      const directory = resolve(this.options.workspace, '.qq-images');
      const candidate = resolve(path);
      if (dirname(candidate) !== directory || !/^[a-f0-9]{64}\.(png|jpg|gif|webp)$/.test(candidate.slice(directory.length + 1))
        || (await lstat(directory)).isSymbolicLink() || (await lstat(candidate)).isSymbolicLink()
        || await realpath(candidate) !== resolve(await realpath(this.options.workspace), '.qq-images', candidate.slice(directory.length + 1))) return false;
      const handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Buffer, createdAt: number;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > this.options.maxBytes) return false;
        bytes = await handle.readFile({ signal }); createdAt = stat.mtimeMs;
      } finally { await handle.close(); }
      const extension = imageExtension(bytes), sha256 = hash(bytes);
      if (candidate !== resolve(directory, `${sha256}.${extension}`)) return false;
      const previous = this.db.prepare('SELECT * FROM incoming_image_cache WHERE message_id=? AND image_index=?').get(messageId, index) as unknown as ImageRow | undefined;
      if (previous?.managed || previous?.status === 'ready') return previous?.path === candidate;
      if (previous) {
        this.db.prepare("UPDATE incoming_image_cache SET status='ready',path=?,sha256=?,mime_type=?,size=?,error=NULL WHERE id=?")
          .run(candidate, sha256, mime(extension), bytes.length, previous.id);
      } else {
        this.db.prepare(`INSERT INTO incoming_image_cache(id,message_id,image_index,status,path,sha256,mime_type,size,created_at,last_access_at,consumed)
          VALUES(?,?,?,'ready',?,?,?,?,?,?,1)`).run(randomUUID(), messageId, index, candidate, sha256, mime(extension), bytes.length, createdAt, Date.now());
      }
      this.updated(messageId);
      return true;
    } catch {
      signal.throwIfAborted();
      return false;
    }
  }

  /** One batch-wide wait budget; media failure never becomes model-generation failure. */
  async prepare(messages: StoredMessage[], signal: AbortSignal): Promise<PreparedIncomingImages> {
    signal.throwIfAborted();
    const ids = [...new Set(messages.map(message => message.messageId))];
    const release = this.retain(ids);
    try {
      for (const message of messages) this.register(message);
      const deadline = Date.now() + this.options.timeoutMs;
      const workSignal = AbortSignal.any([signal, this.controller.signal]);
      void this.syncRemote();
      do {
        workSignal.throwIfAborted();
        this.pump();
        if (!ids.some(id => this.rows(id).some(row => row.status === 'pending'))) break;
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await delay(Math.min(20, remaining), undefined, { signal: workSignal });
      } while (Date.now() < deadline);
      const files = new Set<string>();
      const byMessageId = new Map<string, CachedIncomingImage[]>();
      for (const id of ids) {
        const images: CachedIncomingImage[] = [];
        for (const row of this.rows(id)) {
          if (row.status === 'ready' && row.path) {
            try {
              await this.readCached(row, workSignal);
              files.add(row.path);
            } catch (error) {
              workSignal.throwIfAborted();
              this.db.prepare("UPDATE incoming_image_cache SET status='failed',path=NULL,error=? WHERE id=?")
                .run(safeError(error), row.id);
              this.updated(id);
            }
          }
          const current = this.row(row.id)!;
          images.push(current.status === 'pending' ? { ...this.publicImage(current), error: '图片仍在下载，本轮暂不可用' } : this.publicImage(current));
        }
        if (images.length) {
          byMessageId.set(id, images);
          this.db.prepare('UPDATE incoming_image_cache SET consumed=1,last_access_at=? WHERE message_id=?').run(Date.now(), id);
        }
      }
      signal.throwIfAborted();
      return { files: [...files], byMessageId };
    } finally {
      release();
    }
  }

  private importDescriptor(descriptor: IncomingImageDescriptor): void {
    if (!descriptor || typeof descriptor.id !== 'string' || !descriptor.id || descriptor.id.length > 200
      || typeof descriptor.messageId !== 'string' || !descriptor.messageId || descriptor.messageId.length > 200
      || !Number.isSafeInteger(descriptor.index) || descriptor.index < 0 || descriptor.index > 1000
      || descriptor.sourceKey !== undefined && (typeof descriptor.sourceKey !== 'string' || descriptor.sourceKey.length > 500)
      || !['pending', 'ready', 'failed', 'expired', 'transferred'].includes(descriptor.status)) return;
    const previous = this.db.prepare('SELECT * FROM incoming_image_cache WHERE message_id=? AND image_index=?')
      .get(descriptor.messageId, descriptor.index) as unknown as ImageRow | undefined;
    const now = Date.now();
    if (!previous) {
      this.db.prepare(`INSERT INTO incoming_image_cache
        (id,message_id,image_index,remote_id,status,created_at,last_access_at,managed) VALUES(?,?,?,?,?,?,?,1)`)
        .run(randomUUID(), descriptor.messageId, descriptor.index, descriptor.id, 'pending', now, now);
    } else if (previous.remote_id !== descriptor.id) {
      this.db.prepare('UPDATE incoming_image_cache SET remote_id=?,managed=1,next_attempt_at=0 WHERE id=?').run(descriptor.id, previous.id);
    }
    const row = this.db.prepare('SELECT * FROM incoming_image_cache WHERE message_id=? AND image_index=?')
      .get(descriptor.messageId, descriptor.index) as unknown as ImageRow;
    if(descriptor.sourceKey !== undefined && row.source_key !== descriptor.sourceKey)
      this.db.prepare('UPDATE incoming_image_cache SET source_key=? WHERE id=?').run(descriptor.sourceKey,row.id);
    if (row.status === 'ready') {
      if (descriptor.status === 'ready' && row.sha256 === descriptor.sha256)
        this.db.prepare('UPDATE incoming_image_cache SET ack_pending=1 WHERE id=?').run(row.id);
      return;
    }
    if (descriptor.status === 'failed' || descriptor.status === 'expired' || descriptor.status === 'transferred') {
      const status = descriptor.status === 'failed' ? 'failed' : 'expired';
      const error = descriptor.status === 'failed' ? safeError(new Error(descriptor.error)) : '图片缓存已过期';
      this.db.prepare('UPDATE incoming_image_cache SET status=?,error=?,ack_pending=? WHERE id=?')
        .run(status, error, descriptor.status === 'transferred' ? 0 : 1, row.id);
    }
  }

  private tick(): void {
    if (this.closed || this.controller.signal.aborted) return;
    if (Date.now() - this.lastRemoteSyncAt >= 2000) void this.syncRemote();
    if (Date.now() - this.cleanupAt >= 60_000) {
      this.cleanupAt = Date.now();
      void this.serial(() => this.cleanupUnlocked(Date.now())).catch(() => {
        if (!this.closed) logEvent(this.options.logger, 'warn', 'image.cache.cleanup_failed');
      });
    }
    this.pump();
  }

  private syncRemote(): Promise<void> {
    if (!this.options.remote || this.closed || this.controller.signal.aborted) return Promise.resolve();
    if (this.syncing) return this.syncing;
    this.lastRemoteSyncAt = Date.now();
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(Math.min(this.options.timeoutMs, 5000))]);
    this.syncing = (async () => {
      try {
        for (const descriptor of await this.options.remote!.list(signal)) {
          this.importDescriptor(descriptor);
          this.updated(descriptor.messageId);
        }
      } catch { /* Persisted tasks and each batch's bounded wait tolerate transport outages. */ }
      finally { this.syncing = undefined; this.pump(); }
    })();
    return this.syncing;
  }

  private pump(): void {
    if (!this.started || this.closed || this.controller.signal.aborted) return;
    const rows = this.db.prepare(`SELECT * FROM incoming_image_cache WHERE (status='pending' OR ack_pending=1)
      AND next_attempt_at<=? ORDER BY created_at,image_index LIMIT 100`).all(Date.now()) as unknown as ImageRow[];
    for (const row of rows) {
      if (this.active.size >= 2) break;
      if (this.active.has(row.id)) continue;
      const work = this.process(row).catch(() => {
        if (!this.controller.signal.aborted && !this.closed) {
          this.db.prepare('UPDATE incoming_image_cache SET next_attempt_at=? WHERE id=?').run(Date.now() + 2000, row.id);
          logEvent(this.options.logger, 'warn', 'image.cache.task_failed', { attachment_ref: fingerprint(row.id) });
        }
      }).finally(() => { this.active.delete(row.id); this.pump(); });
      this.active.set(row.id, work);
    }
  }

  private async process(initial: ImageRow): Promise<void> {
    const signal = this.controller.signal;
    if (initial.status !== 'pending') { await this.acknowledge(initial, signal); return; }
    const started = Date.now();
    const logStarted = () => logEvent(this.options.logger, 'info', 'image.cache.started', { attachment_ref: fingerprint(initial.id), message_ref: fingerprint(initial.message_id) });
    try {
      let bytes: Buffer;
      let expected: IncomingImageDescriptor | undefined;
      if (initial.managed && !initial.remote_id) {
        this.db.prepare('UPDATE incoming_image_cache SET next_attempt_at=? WHERE id=?').run(Date.now() + 250, initial.id);
        return;
      }
      if(initial.plugin_asset_id&&this.options.pluginContent) {
        logStarted();
        this.db.prepare('UPDATE incoming_image_cache SET plugin_attempts=plugin_attempts+1 WHERE id=?').run(initial.id);
        bytes=await this.options.pluginContent(initial.plugin_asset_id,AbortSignal.any([signal,AbortSignal.timeout(this.options.timeoutMs)]));
      } else if (initial.remote_id && this.options.remote) {
        const remoteSignal = AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs)]);
        expected = await this.options.remote.get(initial.remote_id, remoteSignal);
        if (expected.id !== initial.remote_id || expected.messageId !== initial.message_id || expected.index !== initial.image_index) throw new Error('图片内容校验失败');
        this.importDescriptor(expected);
        this.updated(initial.message_id);
        if (expected.status === 'pending') {
          this.db.prepare('UPDATE incoming_image_cache SET next_attempt_at=? WHERE id=?').run(Date.now() + 250, initial.id);
          return;
        }
        if (expected.status !== 'ready') { await this.acknowledge(this.row(initial.id)!, remoteSignal); return; }
        if (!expected.sha256 || !/^[a-f0-9]{64}$/.test(expected.sha256) || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(expected.mimeType ?? '') || !Number.isSafeInteger(expected.size)
          || expected.size! <= 0 || expected.size! > this.options.maxBytes) throw new Error('图片内容校验失败');
        const descriptor = expected;
        await this.withContent(descriptor.sha256!, async () => {
          remoteSignal.throwIfAborted();
          if (await this.reuseCached(initial, descriptor, remoteSignal)) {
            logEvent(this.options.logger, 'info', 'image.cache.hit', { attachment_ref: fingerprint(initial.id), bytes: descriptor.size, duration_ms: Date.now() - started });
            return;
          }
          logStarted();
          const downloaded = await this.options.remote!.content(initial.remote_id!, remoteSignal);
          await this.save(initial, downloaded, descriptor, remoteSignal);
          logEvent(this.options.logger, 'info', 'image.cache.ready', { attachment_ref: fingerprint(initial.id), bytes: downloaded.length, duration_ms: Date.now() - started });
        });
        this.updated(initial.message_id);
        await this.acknowledge(this.row(initial.id)!, signal);
        return;
      } else if (initial.source) {
        logStarted();
        bytes = await readIncomingImage(initial.source, this.imageOptions(), signal);
      } else {
        this.db.prepare('UPDATE incoming_image_cache SET next_attempt_at=? WHERE id=?').run(Date.now() + 1000, initial.id);
        return;
      }
      await this.save(initial, bytes, expected, signal);
      this.updated(initial.message_id);
      logEvent(this.options.logger, 'info', 'image.cache.ready', { attachment_ref: fingerprint(initial.id), bytes: bytes.length, duration_ms: Date.now() - started });
      await this.acknowledge(this.row(initial.id)!, signal);
    } catch (error) {
      signal.throwIfAborted();
      const row = this.row(initial.id)!;
      if(initial.plugin_asset_id&&row.plugin_attempts<3&&!(error instanceof Error&&/^(图片超过大小限制|图片格式不支持|图片缓存空间不足)$/u.test(error.message))) {
        this.db.prepare('UPDATE incoming_image_cache SET next_attempt_at=? WHERE id=?').run(Date.now()+2000,initial.id);
        return;
      }
      if (row.status === 'ready' || initial.remote_id && !(error instanceof Error && /^(图片内容校验失败|图片超过大小限制|图片格式不支持|图片缓存空间不足)$/u.test(error.message))) {
        this.db.prepare('UPDATE incoming_image_cache SET next_attempt_at=? WHERE id=?').run(Date.now() + 2000, initial.id);
        return;
      }
      this.db.prepare("UPDATE incoming_image_cache SET status='failed',error=?,ack_pending=0,next_attempt_at=0 WHERE id=?")
        .run(safeError(error), initial.id);
      this.updated(initial.message_id);
      logEvent(this.options.logger, 'warn', 'image.cache.failed', { attachment_ref: fingerprint(initial.id), reason: safeError(error), duration_ms: Date.now() - started });
    }
  }

  private async withContent(key: string, action: () => Promise<void>): Promise<void> {
    const previous = this.contentLocks.get(key) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(action);
    this.contentLocks.set(key, work);
    try { await work; }
    finally { if (this.contentLocks.get(key) === work) this.contentLocks.delete(key); }
  }

  private async reuseCached(initial: ImageRow, expected: IncomingImageDescriptor, signal: AbortSignal): Promise<boolean> {
    return this.serial(async () => {
      const candidates = this.db.prepare("SELECT * FROM incoming_image_cache WHERE sha256=? AND status='ready' AND size=? AND mime_type=? ORDER BY last_access_at DESC")
        .all(expected.sha256!, expected.size!, expected.mimeType!) as unknown as ImageRow[];
      for (const candidate of candidates) {
        signal.throwIfAborted();
        try {
          const bytes = await this.readCached(candidate, signal);
          if (mime(imageExtension(bytes)) !== expected.mimeType) continue;
          this.setReady(initial.id, candidate.path!, expected.sha256!, expected.mimeType!, expected.size!);
          return true;
        } catch { signal.throwIfAborted(); }
      }
      return false;
    });
  }

  private setReady(id: string, path: string, sha256: string, mimeType: string, size: number): void {
    this.db.prepare(`UPDATE incoming_image_cache SET status='ready',path=?,sha256=?,mime_type=?,size=?,error=NULL,
      last_access_at=?,ack_pending=CASE WHEN remote_id IS NULL THEN 0 ELSE 1 END,next_attempt_at=0 WHERE id=?`)
      .run(path, sha256, mimeType, size, Date.now(), id);
  }

  private async save(initial: ImageRow, bytes: Buffer, expected: IncomingImageDescriptor | undefined, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (bytes.length > this.options.maxBytes) throw new Error('图片超过大小限制');
    const extension = imageExtension(bytes), sha256 = hash(bytes);
    if (expected && (sha256 !== expected.sha256 || bytes.length !== expected.size || mime(extension) !== expected.mimeType)) throw new Error('图片内容校验失败');
    await this.serial(async () => {
      signal.throwIfAborted();
      const existing = this.db.prepare("SELECT path FROM incoming_image_cache WHERE sha256=? AND status='ready' LIMIT 1").get(sha256) as { path: string } | undefined;
      const duplicate = existing && existsSync(existing.path);
      const used = await this.cleanupUnlocked(Date.now(), duplicate ? 0 : bytes.length);
      if (used + (duplicate ? 0 : bytes.length) > this.options.cacheMaxBytes) throw new Error('图片缓存空间不足');
      const path = await cacheImage(bytes, this.imageOptions(), signal);
      this.setReady(initial.id, path, sha256, mime(extension), bytes.length);
    });
  }

  private async acknowledge(row: ImageRow, signal: AbortSignal): Promise<void> {
    if (!row.ack_pending || !row.remote_id || !this.options.remote) return;
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.min(this.options.timeoutMs, 5000))]);
    try {
      await this.options.remote.acknowledge(row.remote_id, row.status === 'ready' ? row.sha256 ?? undefined : undefined, requestSignal);
      this.db.prepare('UPDATE incoming_image_cache SET ack_pending=0,next_attempt_at=0 WHERE id=?').run(row.id);
    } catch {
      signal.throwIfAborted();
      this.db.prepare('UPDATE incoming_image_cache SET next_attempt_at=? WHERE id=?').run(Date.now() + 2000, row.id);
    }
  }

  private imageOptions(): ImageOptions {
    return { workspace: this.options.workspace, maxBytes: this.options.maxBytes, timeoutMs: this.options.timeoutMs, fetch: this.options.fetch };
  }

  private async readCached(row: ImageRow, signal: AbortSignal): Promise<Buffer> {
    const path = resolve(row.path ?? '');
    const directory = resolve(this.options.workspace, '.qq-images');
    if (!row.sha256 || !path.startsWith(`${directory}/`) || !new RegExp(`^${row.sha256}\\.(png|jpg|gif|webp)$`).test(path.slice(directory.length + 1))) throw new Error('图片内容校验失败');
    if ((await lstat(directory)).isSymbolicLink()) throw new Error('图片缓存路径不允许');
    signal.throwIfAborted();
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > this.options.maxBytes || stat.size !== row.size) throw new Error('图片内容校验失败');
      const bytes = await handle.readFile({ signal });
      if (hash(bytes) !== row.sha256) throw new Error('图片内容校验失败');
      imageExtension(bytes);
      return bytes;
    } finally { await handle.close(); }
  }

  private rows(messageId: string): ImageRow[] {
    return this.db.prepare('SELECT * FROM incoming_image_cache WHERE message_id=? ORDER BY image_index').all(messageId) as unknown as ImageRow[];
  }
  private row(id: string): ImageRow | undefined { return this.db.prepare('SELECT * FROM incoming_image_cache WHERE id=?').get(id) as unknown as ImageRow | undefined; }
  private publicImage(row: ImageRow): CachedIncomingImage {
    return { attachmentId: row.remote_id ?? row.id, status: row.status,
      ...(row.source_key ? { sourceKey: row.source_key } : {}),
      ...(row.status === 'ready' && row.path ? { path: row.path } : {}), ...(row.error ? { error: row.error } : {}),
      ...(row.source_plugin&&row.plugin_asset_id?{origin:'plugin' as const,pluginId:row.source_plugin,assetId:row.plugin_asset_id}:{}) };
  }
  private updated(messageId: string): void {
    if (!this.options.onUpdated) return;
    try {
      const images = this.lookup(messageId);
      const signature = hash(Buffer.from(JSON.stringify(images)));
      if (this.db.prepare('SELECT signature FROM incoming_image_presentations WHERE message_id=?').get(messageId)?.signature === signature) return;
      // A descriptor can arrive before its message. The caller returns false to retry presentation after ingress.
      if (this.options.onUpdated(messageId, images) === false) return;
      this.db.prepare('INSERT INTO incoming_image_presentations(message_id,signature) VALUES(?,?) ON CONFLICT(message_id) DO UPDATE SET signature=excluded.signature')
        .run(messageId, signature);
    }
    catch { logEvent(this.options.logger, 'warn', 'image.cache.presentation_failed', { message_ref: fingerprint(messageId) }); }
  }
  private protected(row: ImageRow): boolean {
    return this.pins.has(row.message_id) || (this.options.isProtected ? this.options.isProtected(row.message_id) : row.consumed === 0);
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.persistence.then(operation);
    this.persistence = work.then(() => {}, () => {});
    return work;
  }

  /** Expired metadata remains queryable; pending/unconsumed and active-turn files are pinned. */
  async cleanup(now = Date.now()): Promise<void> { await this.serial(() => this.cleanupUnlocked(now)).then(() => {}); }

  private async cleanupUnlocked(now: number, incomingBytes = 0): Promise<number> {
    const directory = resolve(this.options.workspace, '.qq-images');
    let entries;
    try {
      if ((await lstat(directory)).isSymbolicLink()) throw new Error('图片缓存路径不允许');
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
    const rows = this.db.prepare("SELECT * FROM incoming_image_cache WHERE status='ready' AND path IS NOT NULL ORDER BY last_access_at,id").all() as unknown as ImageRow[];
    const groups = new Map<string, ImageRow[]>();
    for (const row of rows) { const group = groups.get(row.path!) ?? []; group.push(row); groups.set(row.path!, group); }
    const files: Array<{ path: string; size: number; age: number; rows: ImageRow[] }> = [];
    let used = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.(png|jpg|gif|webp)$/.test(entry.name)) continue;
      const path = resolve(directory, entry.name), stat = await lstat(path);
      if (!stat.isFile()) continue;
      used += stat.size;
      files.push({ path, size: stat.size, age: stat.mtimeMs, rows: groups.get(path) ?? [] });
    }
    files.sort((a, b) => Math.min(...a.rows.map(row => row.last_access_at), a.age) - Math.min(...b.rows.map(row => row.last_access_at), b.age));
    const cutoff = now - this.options.cacheDays * 86400_000;
    for (const file of files) {
      if (file.rows.some(row => this.protected(row) || row.ack_pending || this.active.has(row.id))) continue;
      const expired = file.rows.length ? file.rows.every(row => row.created_at < cutoff) : file.age < cutoff;
      if (!expired && used + incomingBytes <= this.options.cacheMaxBytes) continue;
      // Unindexed files may be referenced by older Pi sessions; only their retention deadline permits removal.
      if (!file.rows.length && !expired) continue;
      const affected = new Set(file.rows.map(row => row.message_id));
      this.db.prepare("UPDATE incoming_image_cache SET status='expired',path=NULL,error='图片缓存已过期' WHERE path=?").run(file.path);
      await rm(file.path, { force: true });
      used -= file.size;
      for (const id of affected) this.updated(id);
      logEvent(this.options.logger, 'info', 'image.cache.evicted', { bytes: file.size, reason: expired ? 'retention' : 'capacity' });
    }
    return used;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.parentSignal?.removeEventListener('abort', this.parentAbort!);
    this.controller.abort();
    await Promise.allSettled([...this.active.values(), ...(this.syncing ? [this.syncing] : []),
      ...(this.recoveringPresentations ? [this.recoveringPresentations] : [])]);
    await this.persistence;
    this.db.close();
  }
}
