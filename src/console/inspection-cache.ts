import type { DatabaseSync } from 'node:sqlite';
import type { NsfwCachedScore, NsfwClassificationCache, NsfwPreparedImage } from '../plugins/forward-nsfw/inspect.js';
import { MODEL_IMAGE_OPTIONS } from '../model-image.js';

export const INSPECTION_CACHE_LIMITS = { ttlMs: 24 * 3600_000, preparedBytes: 16 * 1024 * 1024, preparedCount: 128, scoreCount: 1024 } as const;
type Kind = 'prepared' | 'score';
interface Host { requireBot(id: string): unknown; encrypt(value: unknown): string; decrypt(cipher: string): unknown; }
interface Row { payload_cipher: string; }
const object = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;

/** Derived images and successful scores belong to one instance and expire independently of chat history. */
export class ConsoleInspectionCache {
  constructor(private readonly db: DatabaseSync, private readonly host: Host) {
    db.exec(`CREATE TABLE IF NOT EXISTS plugin_inspection_cache (
      bot_id TEXT NOT NULL REFERENCES bots(id),kind TEXT NOT NULL,cache_key TEXT NOT NULL,payload_cipher TEXT NOT NULL,
      bytes INTEGER NOT NULL,expires_at INTEGER NOT NULL,touched_at INTEGER NOT NULL,PRIMARY KEY(bot_id,kind,cache_key)
    ); CREATE INDEX IF NOT EXISTS plugin_inspection_cache_retention ON plugin_inspection_cache(bot_id,kind,touched_at);`);
  }
  forBot(botId: string): NsfwClassificationCache {
    this.host.requireBot(botId);
    return {
      getPrepared: key => {
        const value = object(this.get(botId, 'prepared', key));
        if (!value || value.type !== 'image' || !['image/png', 'image/jpeg'].includes(String(value.mimeType))
          || typeof value.data !== 'string' || !value.data.length || value.data.length > MODEL_IMAGE_OPTIONS.maxBytes
          || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value.data) || value.data.length % 4 !== 0) return undefined;
        return value as unknown as NsfwPreparedImage;
      },
      setPrepared: (key, value) => this.put(botId, 'prepared', key, value),
      getScore: key => {
        const value = object(this.get(botId, 'score', key));
        if (!value || typeof value.score !== 'number' || !Number.isFinite(value.score) || value.score < 0 || value.score > 1
          || value.model !== undefined && (typeof value.model !== 'string' || value.model.length > 200)) return undefined;
        return value as unknown as NsfwCachedScore;
      },
      setScore: (key, value) => this.put(botId, 'score', key, value),
    };
  }
  private get(botId: string, kind: Kind, key: string, now = Date.now()): unknown {
    if (!/^[a-f0-9]{64}$/u.test(key)) return undefined;
    const row = this.db.prepare('SELECT payload_cipher FROM plugin_inspection_cache WHERE bot_id=? AND kind=? AND cache_key=? AND expires_at>?')
      .get(botId, kind, key, now) as Row | undefined;
    if (!row) return undefined;
    let value: unknown;
    try { value = this.host.decrypt(row.payload_cipher); }
    catch { return undefined; }
    this.db.prepare('UPDATE plugin_inspection_cache SET touched_at=? WHERE bot_id=? AND kind=? AND cache_key=?').run(now, botId, kind, key);
    return value;
  }
  private put(botId: string, kind: Kind, key: string, value: NsfwPreparedImage | NsfwCachedScore, now = Date.now()): void {
    if (!/^[a-f0-9]{64}$/u.test(key)) return;
    const cipher = this.host.encrypt(value), bytes = Buffer.byteLength(cipher);
    if (kind === 'prepared' && bytes > INSPECTION_CACHE_LIMITS.preparedBytes) return;
    this.db.prepare(`INSERT INTO plugin_inspection_cache(bot_id,kind,cache_key,payload_cipher,bytes,expires_at,touched_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(bot_id,kind,cache_key) DO UPDATE SET payload_cipher=excluded.payload_cipher,bytes=excluded.bytes,expires_at=excluded.expires_at,touched_at=excluded.touched_at`)
      .run(botId, kind, key, cipher, bytes, now + INSPECTION_CACHE_LIMITS.ttlMs, now);
    this.prune(botId, now);
  }
  prune(botId: string, now = Date.now()): void {
    this.db.prepare('DELETE FROM plugin_inspection_cache WHERE bot_id=? AND expires_at<=?').run(botId, now);
    for (const [kind, maxCount, maxBytes] of [['prepared', INSPECTION_CACHE_LIMITS.preparedCount, INSPECTION_CACHE_LIMITS.preparedBytes], ['score', INSPECTION_CACHE_LIMITS.scoreCount, Infinity]] as const) {
      const rows = this.db.prepare('SELECT cache_key,bytes FROM plugin_inspection_cache WHERE bot_id=? AND kind=? ORDER BY touched_at DESC,cache_key DESC')
        .all(botId, kind) as Array<{cache_key: string; bytes: number}>;
      let keptBytes = 0, count = 0;
      for (const row of rows) {
        if (count < maxCount && keptBytes + row.bytes <= maxBytes) { count++; keptBytes += row.bytes; }
        else this.db.prepare('DELETE FROM plugin_inspection_cache WHERE bot_id=? AND kind=? AND cache_key=?').run(botId, kind, row.cache_key);
      }
    }
  }
}
