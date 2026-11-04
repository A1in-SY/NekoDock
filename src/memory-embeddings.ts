import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { MemoryConfig, MemoryItem } from './memory-contract.js';
import type { MemoryStore } from './memory-store.js';

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return -1;
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i]!, y = b[i]!; dot += x * y; aa += x * x; bb += y * y; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : -1;
}
function vector(value: unknown): number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8192 || value.some(n => typeof n !== 'number' || !Number.isFinite(n))) throw new Error('MEMORY_EMBEDDING_INVALID');
  return value;
}

/** Optional remote embeddings. SQLite remains the source of truth and keyword fallback. */
export class MemoryEmbeddings {
  private readonly db: DatabaseSync;
  private readonly identity: string;
  private updating?: Promise<void>;
  private closed = false;
  constructor(file: string, readonly config: MemoryConfig, readonly store: MemoryStore, readonly fetcher: typeof fetch) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS memory_vectors(model_key TEXT NOT NULL,item_id TEXT NOT NULL,revision INTEGER NOT NULL,vector_json TEXT NOT NULL,PRIMARY KEY(model_key,item_id))');
    this.identity = createHash('sha256').update(`${config.embeddingBaseUrl}\n${config.embeddingModel}`).digest('hex');
  }
  private async embed(input: string[], signal: AbortSignal): Promise<number[][]> {
    const response = await this.fetcher(`${this.config.embeddingBaseUrl.replace(/\/+$/, '')}/embeddings`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(this.config.embeddingApiKey ? { authorization: `Bearer ${this.config.embeddingApiKey}` } : {}) },
      body: JSON.stringify({ model: this.config.embeddingModel, input, encoding_format: 'float' }),
      signal,
    });
    if (!response.ok) throw new Error('MEMORY_EMBEDDING_HTTP_ERROR');
    // Bound a misconfigured endpoint before decoding untrusted vector data.
    const reader = response.body?.getReader();
    if (!reader) throw new Error('MEMORY_EMBEDDING_INVALID');
    let size = 0; const parts: Uint8Array[] = [];
    try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 4 * 1024 * 1024) throw new Error('MEMORY_EMBEDDING_LIMIT'); parts.push(value); } }
    finally { await reader.cancel().catch(() => {}); }
    const value = JSON.parse(Buffer.concat(parts).toString('utf8')) as { data?: Array<{ index: number; embedding: unknown }> };
    if (!Array.isArray(value.data) || value.data.length !== input.length) throw new Error('MEMORY_EMBEDDING_INVALID');
    const sorted = [...value.data].sort((a, b) => a.index - b.index);
    const result = sorted.map((entry, index) => { if (entry.index !== index) throw new Error('MEMORY_EMBEDDING_INVALID'); return vector(entry.embedding); });
    if (result.some(v => v.length !== result[0]!.length)) throw new Error('MEMORY_EMBEDDING_DIMENSION');
    return result;
  }
  update(signal: AbortSignal): Promise<void> {
    return this.updating ??= this.updateBatch(signal).finally(() => { this.updating = undefined; });
  }
  private async updateBatch(signal: AbortSignal): Promise<void> {
    if (this.closed || this.config.embeddingProvider === 'none') return;
    // Index in small resumable batches. Revision checks reject a result that became stale in flight.
    const rows = this.db.prepare(`SELECT item_id,revision FROM memory_vectors WHERE model_key=?`).all(this.identity);
    const versions = new Map(rows.map(row => [String(row.item_id), Number(row.revision)]));
    const items: MemoryItem[] = [];
    let afterId = '';
    while (items.length < 16) {
      const page = this.store.activeItems(256, afterId);
      if (!page.length) break;
      for (const item of page) if (versions.get(item.id) !== item.revision && items.length < 16) items.push(item);
      afterId = page.at(-1)!.id;
      signal.throwIfAborted();
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    if (!items.length) return;
    const vectors = await this.embed(items.map(item => item.content), AbortSignal.any([signal, AbortSignal.timeout(30_000)]));
    signal.throwIfAborted();
    for (const [index, item] of items.entries()) {
      const current = this.store.get(item.id);
      if (!current || current.status !== 'active' || current.revision !== item.revision) continue;
      this.db.prepare('INSERT OR REPLACE INTO memory_vectors(model_key,item_id,revision,vector_json) VALUES(?,?,?,?)').run(this.identity, item.id, item.revision, JSON.stringify(vectors[index]));
    }
  }
  async search(query: string, subjectIds: string[], limit: number, signal?: AbortSignal): Promise<MemoryItem[]> {
    if (this.closed || !query.trim() || this.config.embeddingProvider === 'none') return [];
    const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(2500)]) : AbortSignal.timeout(2500);
    const [needle] = await this.embed([query.slice(0, 4000)], deadline);
    if (!needle) return [];
    const ranked: Array<{ item: MemoryItem; score: number }> = [];
    const now = Date.now();
    // Bounded scans yield to ingress; no native extension or extra database service is required.
    let afterId = '';
    while (true) {
      await new Promise<void>(resolve => setImmediate(resolve)); deadline.throwIfAborted();
      if (this.closed) return [];
      const rows = this.db.prepare('SELECT item_id,revision,vector_json FROM memory_vectors WHERE model_key=? AND item_id>? ORDER BY item_id LIMIT 128').all(this.identity, afterId);
      if (!rows.length) break;
      afterId = String(rows.at(-1)!.item_id);
      for (const row of rows) {
      const item = this.store.get(String(row.item_id));
      if (!item || item.status !== 'active' || item.revision !== Number(row.revision) || (item.validFrom !== null && item.validFrom > now) || (item.validTo !== null && item.validTo <= now)) continue;
      if (item.scope === 'person' && !subjectIds.includes(item.subjectUserId ?? '')) continue;
      const score = cosine(needle, vector(JSON.parse(String(row.vector_json))));
      if (score >= 0.55) ranked.push({ item, score });
      }
    }
    ranked.sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id));
    return ranked.slice(0, limit).map(row => row.item);
  }
  close(): void { this.closed = true; this.db.close(); }
}
