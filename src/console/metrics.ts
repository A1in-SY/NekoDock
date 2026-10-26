import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { MetricSample } from './contracts.js';
import type { DockerStats } from './docker.js';

export interface ResourceCounters { time: number; rx: number | null; tx: number | null }

/** CPU is percent of one core, memory is MiB and throughput is KiB/s. */
export function resourceSample(botId: string, stats: DockerStats, previous?: ResourceCounters, now = Date.now()): { sample: MetricSample; counters: ResourceCounters } {
  const cpu = stats.cpu_stats; const before = stats.precpu_stats;
  const total = cpu?.cpu_usage?.total_usage; const priorTotal = before?.cpu_usage?.total_usage;
  const system = cpu?.system_cpu_usage; const priorSystem = before?.system_cpu_usage;
  let cpuPercent: number | null = null;
  if (nonnegative(total) && nonnegative(priorTotal) && nonnegative(system) && nonnegative(priorSystem)
    && positive(cpu?.online_cpus) && system > priorSystem && total >= priorTotal) {
    cpuPercent = (total - priorTotal) / (system - priorSystem) * cpu.online_cpus * 100;
  }
  const memory = stats.memory_stats;
  const cache = memory?.stats?.inactive_file ?? memory?.stats?.total_inactive_file ?? 0;
  const memoryMiB = nonnegative(memory?.usage) && nonnegative(cache) ? Math.max(0, memory.usage - cache) / 1048576 : null;
  const interfaces = Object.values(stats.networks ?? {});
  const totalBytes = (direction: 'rx_bytes' | 'tx_bytes'): number | null => {
    if (!interfaces.length || interfaces.some(value => !nonnegative(value[direction]))) return null;
    return interfaces.reduce((sum, value) => sum + value[direction]!, 0);
  };
  const rx = totalBytes('rx_bytes'); const tx = totalBytes('tx_bytes');
  const seconds = previous ? (now - previous.time) / 1000 : 0;
  const rate = (current: number | null, prior: number | null | undefined): number | null => nonnegative(current) && nonnegative(prior) && seconds > 0 && current >= prior ? (current - prior) / seconds / 1024 : null;
  return { sample: { botId, time: now, cpu: cpuPercent, memory: memoryMiB, rx: rate(rx, previous?.rx), tx: rate(tx, previous?.tx), latency: null }, counters: { time: now, rx, tx } };
}

type MetricName = 'cpu' | 'memory' | 'rx' | 'tx' | 'latency';
const metricNames: MetricName[] = ['cpu', 'memory', 'rx', 'tx', 'latency'];
interface MetricRow { bot_id: string; bucket: number; cpu: number | null; memory: number | null; rx: number | null; tx: number | null; latency: number | null; cpu_peak: number | null; memory_peak: number | null; rx_peak: number | null; tx_peak: number | null }
interface AggregateRow extends Record<string, string | number | null> { bot_id: string; bucket: number }
export interface MetricQuery { samples: MetricSample[]; peaks: MetricSample[]; step: number }

export class MetricsDatabase {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS metric_samples (
        bot_id TEXT NOT NULL,time INTEGER NOT NULL,resolution INTEGER NOT NULL DEFAULT 15,
        cpu REAL,memory REAL,rx REAL,tx REAL,latency REAL,
        cpu_count INTEGER NOT NULL DEFAULT 0,memory_count INTEGER NOT NULL DEFAULT 0,rx_count INTEGER NOT NULL DEFAULT 0,tx_count INTEGER NOT NULL DEFAULT 0,latency_count INTEGER NOT NULL DEFAULT 0,
        cpu_peak REAL,memory_peak REAL,rx_peak REAL,tx_peak REAL,
        PRIMARY KEY(bot_id,time,resolution));
      CREATE INDEX IF NOT EXISTS metric_time ON metric_samples(time);`);
    const columns = new Set((this.db.prepare('PRAGMA table_info(metric_samples)').all() as Array<{ name: string }>).map(row => row.name));
    for (const name of metricNames) {
      if (!columns.has(`${name}_count`)) {
        this.db.exec(`ALTER TABLE metric_samples ADD COLUMN ${name}_count INTEGER NOT NULL DEFAULT 0`);
        this.db.exec(`UPDATE metric_samples SET ${name}_count=CASE WHEN ${name} IS NULL THEN 0 ELSE 1 END`);
      }
      if (name !== 'latency' && !columns.has(`${name}_peak`)) {
        this.db.exec(`ALTER TABLE metric_samples ADD COLUMN ${name}_peak REAL`);
        this.db.exec(`UPDATE metric_samples SET ${name}_peak=${name}`);
      }
    }
    if (path !== ':memory:') chmodSync(path, 0o600);
  }
  insert(sample: MetricSample): void {
    if (!sample.botId || !Number.isSafeInteger(sample.time)) throw new Error('监控采样标识或时间无效');
    for (const name of metricNames) if (sample[name] !== null && !nonnegative(sample[name])) throw new Error('监控采样值无效');
    this.db.prepare(`INSERT OR REPLACE INTO metric_samples(bot_id,time,resolution,cpu,memory,rx,tx,latency,cpu_count,memory_count,rx_count,tx_count,latency_count,cpu_peak,memory_peak,rx_peak,tx_peak) VALUES (?,?,15,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(sample.botId, sample.time, sample.cpu, sample.memory, sample.rx, sample.tx, sample.latency, ...metricNames.map(name => sample[name] === null ? 0 : 1), sample.cpu, sample.memory, sample.rx, sample.tx);
  }
  query(from: number, to: number): MetricQuery {
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) throw new Error('监控时间范围无效');
    const step = Math.max(15000, Math.ceil((to - from) / 300 / 15000) * 15000);
    const averages = metricNames.filter(name => name !== 'latency').map(name => `SUM(${name}*${name}_count)/NULLIF(SUM(${name}_count),0) AS ${name}`).join(',');
    const peaks = ['cpu', 'memory', 'rx', 'tx'].map(name => `MAX(${name}_peak) AS ${name}_peak`).join(',');
    const rows = this.db.prepare(`SELECT bot_id,CAST(time/? AS INTEGER)*? AS bucket,${averages},MAX(latency) AS latency,${peaks} FROM metric_samples WHERE time>=? AND time<=? GROUP BY bot_id,bucket ORDER BY bucket`)
      .all(step, step, from, to) as unknown as MetricRow[];
    const samples = rows.map(row => ({ botId: row.bot_id, time: row.bucket, cpu: row.cpu, memory: row.memory, rx: row.rx, tx: row.tx, latency: row.latency }));
    return { step, samples, peaks: rows.map(row => ({ botId: row.bot_id, time: row.bucket, cpu: row.cpu_peak, memory: row.memory_peak, rx: row.rx_peak, tx: row.tx_peak, latency: row.latency })) };
  }
  compact(now = Date.now()): void {
    // A complete minute is compacted at once, so the moving seven-day boundary cannot overwrite a partial bucket.
    const cutoff = Math.floor((now - 7 * 86400000) / 60000) * 60000;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const expressions = metricNames.map(name => name === 'latency'
        ? `MAX(latency) AS latency,SUM(latency_count) AS latency_count`
        : `SUM(${name}*${name}_count)/NULLIF(SUM(${name}_count),0) AS ${name},SUM(${name}_count) AS ${name}_count,MAX(${name}_peak) AS ${name}_peak`).join(',');
      const rows = this.db.prepare(`SELECT m.bot_id,CAST(m.time/60000 AS INTEGER)*60000 AS bucket,${expressions}
        FROM metric_samples m WHERE m.time<? AND (m.resolution=15 OR (m.resolution=60 AND EXISTS
          (SELECT 1 FROM metric_samples raw WHERE raw.bot_id=m.bot_id AND raw.resolution=15 AND CAST(raw.time/60000 AS INTEGER)=CAST(m.time/60000 AS INTEGER))))
        GROUP BY m.bot_id,CAST(m.time/60000 AS INTEGER)`).all(cutoff) as unknown as AggregateRow[];
      const insert = this.db.prepare(`INSERT OR REPLACE INTO metric_samples(bot_id,time,resolution,cpu,memory,rx,tx,latency,cpu_count,memory_count,rx_count,tx_count,latency_count,cpu_peak,memory_peak,rx_peak,tx_peak) VALUES (?,?,60,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const row of rows) insert.run(row.bot_id, row.bucket, row.cpu!, row.memory!, row.rx!, row.tx!, row.latency!, ...metricNames.map(name => row[`${name}_count`]!), row.cpu_peak!, row.memory_peak!, row.rx_peak!, row.tx_peak!);
      this.db.prepare('DELETE FROM metric_samples WHERE (time<? AND resolution=15) OR time<?').run(cutoff, now - 30 * 86400000);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close(): void { this.db.close(); }
}
function nonnegative(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
function positive(value: unknown): value is number { return nonnegative(value) && value > 0; }
