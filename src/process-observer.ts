import { readFile, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ProcessPoint, ProcessSample } from './activity-contract.js';

export interface ProcCounter { pid: number; parent: number; startTime: string; ticks: number; program: ProcessPoint['program']; }
export function parseProcStat(text: string): ProcCounter {
  const left = text.indexOf('('), right = text.lastIndexOf(')');
  const pid = Number(text.slice(0, left).trim()), fields = text.slice(right + 2).trim().split(/\s+/u);
  const parent = Number(fields[1]), ticks = Number(fields[11]) + Number(fields[12]), startTime = fields[19];
  if (left < 1 || right <= left || !Number.isSafeInteger(pid) || pid < 1 || !Number.isSafeInteger(parent) || !Number.isSafeInteger(ticks) || !startTime || !/^\d+$/u.test(startTime)) throw new Error('Invalid proc counters');
  const command = text.slice(left + 1, right).toLowerCase();
  const program: ProcessPoint['program'] = /chrom|firefox|webkit|playwright/u.test(command) ? 'browser' : /python/u.test(command) ? 'python' : /ffmpeg|ffprobe/u.test(command) ? 'ffmpeg' : /node/u.test(command) ? 'node' : /bash|^sh$|^dash$/u.test(command) ? 'bash' : /yt-dlp|youtube-dl/u.test(command) ? 'downloader' : 'other';
  return { pid, parent, startTime, ticks, program };
}
let clockTicks: number | undefined;
function ticksPerSecond(): number {
  if (clockTicks !== undefined) return clockTicks;
  try { clockTicks = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()); } catch { clockTicks = 0; }
  return clockTicks;
}
export function processDelta(current: ProcCounter[], previous: Map<string, ProcCounter>, intervalMs: number, hz: number): ProcessPoint[] {
  if (!(hz > 0 && intervalMs > 0)) return [];
  return current.flatMap(row => {
    const prior = previous.get(`${row.pid}:${row.startTime}`);
    return prior && row.ticks >= prior.ticks ? [{ pid: row.pid, startTime: row.startTime, program: row.program, cpu: (row.ticks - prior.ticks) / hz / (intervalMs / 1000) * 100 }] : [];
  });
}
export function watchProcessTree(pid: number, spanId: string, emit: (sample: ProcessSample) => void, options: { intervalMs?: number; root?: string; hz?: number; descendants?: boolean } = {}): () => Promise<void> {
  const root = options.root ?? '/proc', hz = options.hz ?? (process.platform === 'linux' ? ticksPerSecond() : 0);
  let stopped = false, flight: Promise<void> | undefined, previous = new Map<string, ProcCounter>(), previousAt = performance.now();
  let rootIdentity: string | undefined, known = new Set<string>();
  try{const own=parseProcStat(readFileSync(`${root}/${pid}/stat`,'utf8'));rootIdentity=`${pid}:${own.startTime}`;}catch{/* Never adopt a later process that reuses this PID. */}
  const output = (value: Omit<ProcessSample, 'id' | 'spanId' | 'time'>) => { try { emit({ id: randomUUID(), spanId, time: Date.now(), scope:options.descendants===false?'self':'tree',...value }); } catch {} };
  const read = async () => {
    const time = performance.now(), intervalMs = Math.max(0, time - previousAt);
    try {
      if (!hz) throw new Error('unavailable');
      const pids = options.descendants===false?[String(pid)]:(await readdir(root)).filter(name => /^\d+$/u.test(name)).slice(0, 4096);
      const counters = (await Promise.all(pids.map(async name => { try { return parseProcStat(await readFile(`${root}/${name}/stat`, 'utf8')); } catch { return null; } }))).filter((row): row is ProcCounter => row !== null);
      const selected = new Map<number, ProcCounter>();
      for (const row of counters) if (`${row.pid}:${row.startTime}` === rootIdentity || known.has(`${row.pid}:${row.startTime}`)) selected.set(row.pid, row);
      for (let changed = true; changed;) { changed = false; for (const row of counters) if (!selected.has(row.pid) && selected.has(row.parent)) { selected.set(row.pid, row); changed = true; } }
      const rows = [...selected.values()], points = processDelta(rows, previous, intervalMs, hz);
      output({ intervalMs, cpu: points.length ? points.reduce((sum, row) => sum + row.cpu, 0) : null,
        coverage: points.length === rows.length && rows.length===previous.size && rows.length > 0 && points.length<=20 && pids.length < 4096 ? 'sampled' : 'partial', processes: points.sort((a,b) => b.cpu-a.cpu).slice(0, 20) });
      previous = new Map(rows.map(row => [`${row.pid}:${row.startTime}`, row])); known = new Set(previous.keys()); previousAt = time;
    } catch { output({ intervalMs, cpu: null, coverage: 'unavailable', processes: [] }); }
  };
  const tick = () => flight ??= read().finally(() => { flight = undefined; });
  void tick();
  const timer = setInterval(() => { if (!stopped) void tick(); }, options.intervalMs ?? 1000); timer.unref();
  return async () => { if (stopped) return; stopped = true; clearInterval(timer); await flight; await tick(); };
}
