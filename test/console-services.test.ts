import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConsoleAuth } from '../src/console/auth.js';
import { ConsoleDatabase } from '../src/console/database.js';
import { MetricsDatabase, resourceSample } from '../src/console/metrics.js';
import { Lifecycle } from '../src/console/lifecycle.js';
import type { DockerClient, ContainerInfo, DockerStats } from '../src/console/docker.js';
import type { BotRecord, MetricSample } from '../src/console/contracts.js';

class Settings {
  rows = new Map<string, string>();
  getSetting(key: string): string | null { return this.rows.get(key) ?? null; }
  setSetting(key: string, value: string): void { this.rows.set(key, value); }
}

test('admin setup serializes first-password requests and sessions contain only opaque hashes', async () => {
  const store = new Settings(); const auth = new ConsoleAuth(store);
  assert.equal(auth.needsSetup(), true);
  const first = auth.setup('test-password-one', '127.0.0.1');
  await assert.rejects(auth.setup('test-password-two', '127.0.0.2'), /管理员已经设置/u);
  const token = await first;
  assert.equal(auth.needsSetup(), false); assert.equal(auth.valid(token), true);
  assert.equal(store.rows.has(`session.${token}`), false);
  assert.equal(JSON.stringify([...store.rows]).includes('test-password-one'), false);
  assert.equal(JSON.stringify([...store.rows]).includes(token), false);
  await assert.rejects(auth.setup('test-password-two', '127.0.0.2'), /管理员已经设置/u);
  await assert.rejects(auth.login('test-password-two', '127.0.0.3'), /密码不正确/u);
  assert.equal(auth.valid(await auth.login('test-password-one', '127.0.0.3')), true);
  auth.logout(token); assert.equal(auth.valid(token), false);
  assert.equal(auth.valid('malformed'), false); assert.equal(auth.valid(null), false);
});

test('admin sessions expire at twelve hours and login rate limits reset without clearing other clients', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const store = new Settings(); const auth = new ConsoleAuth(store);
  const token = await auth.setup('test-password-example', 'setup');
  for (let index = 0; index < 10; index++) await assert.rejects(auth.login(null, 'blocked'), /密码不正确/u);
  await assert.rejects(auth.login(null, 'blocked'), /请求过于频繁/u);
  for (let index = 0; index < 1000; index++) await assert.rejects(auth.login(null, `client-${index}`), /密码不正确|请求过于频繁/u);
  await assert.rejects(auth.login(null, 'blocked'), /请求过于频繁/u);
  t.mock.timers.tick(60000);
  await assert.rejects(auth.login(null, 'blocked'), /密码不正确/u);
  assert.equal(auth.valid(token), true);
  t.mock.timers.tick(12 * 3600000 - 60000);
  assert.equal(auth.valid(token), false);
});

test('admin validation rejects short setup and corrupted hashes using fixed diagnostics', async () => {
  const store = new Settings(); const auth = new ConsoleAuth(store);
  await assert.rejects(auth.setup('short', 'client'), /12–256/u);
  await assert.rejects(auth.login('password', 'client'), /请先设置/u);
  store.setSetting('admin.password', 'broken');
  await assert.rejects(auth.login('password', 'client'), /凭据格式无效/u);
});

test('Docker resource sampling converts CPU, memory and network units without replacing unknowns with zero', () => {
  const result = resourceSample('bot', {
    cpu_stats: { cpu_usage: { total_usage: 300 }, system_cpu_usage: 1000, online_cpus: 4 },
    precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 600 },
    memory_stats: { usage: 100 * 1048576, stats: { inactive_file: 20 * 1048576 } },
    networks: { eth0: { rx_bytes: 4096, tx_bytes: 8192 }, eth1: { rx_bytes: 1024, tx_bytes: 0 } },
  }, { time: 1000, rx: 1024, tx: 2048 }, 3000);
  assert.deepEqual(result.sample, { botId: 'bot', time: 3000, cpu: 200, memory: 80, rx: 2, tx: 3, latency: null });
  const missing = resourceSample('bot', {}, result.counters, 5000);
  assert.deepEqual(missing.sample, { botId: 'bot', time: 5000, cpu: null, memory: null, rx: null, tx: null, latency: null });
  assert.equal(missing.counters.rx, null); assert.equal(missing.counters.tx, null);
  assert.equal(resourceSample('bot', { networks: { eth0: { rx_bytes: 1024, tx_bytes: 2048 } } }, missing.counters, 7000).sample.rx, null);
  const reset = resourceSample('bot', { networks: { eth0: { rx_bytes: 0, tx_bytes: 0 } } }, result.counters, 5000);
  assert.equal(reset.sample.rx, null); assert.equal(reset.sample.tx, null);
  assert.equal(resourceSample('bot', { networks: { eth0: { rx_bytes: 0, tx_bytes: 0 } } }, reset.counters, 7000).sample.rx, 0);
  assert.equal(resourceSample('bot', { cpu_stats: { system_cpu_usage: 1000, online_cpus: 4 }, precpu_stats: { system_cpu_usage: 600 } }).sample.cpu, null);
});

function statsAt(time: number, read = new Date(time).toISOString()): DockerStats {
  return { read, cpu_stats: { cpu_usage: { total_usage: time * 1e6 } }, memory_stats: { usage: 1048576 },
    networks: { eth0: { rx_bytes: time / 1000 * 1024, tx_bytes: time / 1000 * 2048 } } };
}

test('resource rates and timestamps follow Docker collection time when responses are delayed', () => {
  const first = resourceSample('bot', statsAt(1000), undefined, 121000);
  assert.equal(first.sample.time, 1000);
  const next = resourceSample('bot', statsAt(121000), first.counters, 123000);
  assert.deepEqual(next.sample, { botId: 'bot', time: 121000, cpu: 100, memory: 1, rx: 1, tx: 2, latency: null });
  assert.equal(next.counters.time, 121000); assert.equal(next.counters.clock, 'docker');
});

test('invalid, duplicate and backwards Docker timestamps reset rate baselines without overwriting the original time', () => {
  for (const read of ['invalid', new Date(1000).toISOString(), new Date(500).toISOString()]) {
    const first = resourceSample('bot', statsAt(1000), undefined, 1000);
    const invalid = resourceSample('bot', statsAt(2000, read), first.counters, 2500);
    assert.deepEqual(invalid.sample, { botId: 'bot', time: 2500, cpu: null, memory: 1, rx: null, tx: null, latency: null });
    assert.equal(invalid.counters.clock, 'invalid');
    assert.equal(invalid.counters.cpuNs, null); assert.equal(invalid.counters.rx, null); assert.equal(invalid.counters.tx, null);
    const recovered = resourceSample('bot', statsAt(3000), invalid.counters, 3500);
    assert.equal(recovered.sample.cpu, null); assert.equal(recovered.sample.rx, null); assert.equal(recovered.sample.tx, null);
    const next = resourceSample('bot', statsAt(5000), recovered.counters, 5500);
    assert.equal(next.sample.cpu, 100); assert.equal(next.sample.rx, 1); assert.equal(next.sample.tx, 2);
  }
});

test('switching between Docker and local fallback timestamps starts a new rate baseline', () => {
  const { read: _read, ...legacy } = statsAt(1000);
  const first = resourceSample('bot', legacy, undefined, 120000);
  const docker = resourceSample('bot', statsAt(3000), first.counters, 121000);
  assert.equal(docker.sample.cpu, null); assert.equal(docker.sample.rx, null);
  const next = resourceSample('bot', statsAt(5000), docker.counters, 122000);
  assert.equal(next.sample.cpu, 100); assert.equal(next.sample.rx, 1);
  const fallback = resourceSample('bot', legacy, next.counters, 123000);
  assert.equal(fallback.sample.time, 123000); assert.equal(fallback.sample.cpu, null); assert.equal(fallback.sample.rx, null);
});

function sample(time: number, cpu: number | null, extra: Partial<MetricSample> = {}): MetricSample {
  return { botId: 'bot', time, cpu, memory: null, rx: null, tx: null, latency: null, ...extra };
}

test('metrics compact complete minutes after seven days, preserve weighted averages and peaks, and retain thirty days', t => {
  const db = new MetricsDatabase(':memory:'); t.after(() => db.close());
  const day = 86400000; const minute = 3 * day;
  db.insert(sample(minute + 15000, 10, { latency: 1 })); db.insert(sample(minute + 45000, 50, { latency: 3 }));
  db.compact(10 * day + 59000);
  assert.equal((db.db.prepare('SELECT COUNT(*) AS count FROM metric_samples WHERE resolution=15').get() as { count: number }).count, 2);
  db.compact(10 * day + 61000);
  const aggregated = db.db.prepare('SELECT * FROM metric_samples').get() as { resolution: number; cpu: number; cpu_count: number; cpu_peak: number; memory: null };
  assert.equal(aggregated.resolution, 60); assert.equal(aggregated.cpu, 30); assert.equal(aggregated.cpu_count, 2); assert.equal(aggregated.cpu_peak, 50); assert.equal(aggregated.memory, null);
  // A late sample merges into the aggregate instead of overwriting the previously retained minute.
  db.insert(sample(minute + 30000, 90)); db.compact(10 * day + 90000); db.compact(10 * day + 95000);
  const queried = db.query(minute, minute + 60000);
  assert.equal(queried.samples[0]!.cpu, 50); assert.equal(queried.peaks[0]!.cpu, 90); assert.equal(queried.samples[0]!.latency, 3);
  assert.equal(queried.samples[0]!.memory, null);
  db.insert(sample(39 * day, null)); db.compact(40 * day);
  assert.equal(db.query(0, 40 * day).samples.length, 1); assert.equal(db.query(0, 40 * day).samples[0]!.cpu, null);
});

test('minute compaction merges late values per resource while preserving null weights and the next raw minute', t => {
  const db = new MetricsDatabase(':memory:'); t.after(() => db.close());
  const day = 86400000, minute = 3 * day, now = 10 * day + 61000;
  db.insert(sample(minute + 1000, 10, { memory: 30, tx: 3, latency: 1 }));
  db.insert(sample(minute + 2000, 50, { rx: 4, latency: 3 }));
  db.insert(sample(minute + 1000, 80, { botId: 'other', memory: 12 }));
  db.compact(now);
  const unrelated = db.db.prepare("SELECT * FROM metric_samples WHERE bot_id='other'").get();
  db.insert(sample(minute + 30000, 90, { memory: 60, rx: 8, tx: 7, latency: 2 }));
  db.insert(sample(minute + 60000, 999));
  db.compact(now);
  const merged = db.db.prepare("SELECT * FROM metric_samples WHERE bot_id='bot' AND resolution=60").get()!;
  for (const [name, average, count, peak] of [['cpu', 50, 3, 90], ['memory', 45, 2, 60], ['rx', 6, 2, 8], ['tx', 5, 2, 7]] as const) {
    assert.equal(merged[name], average); assert.equal(merged[`${name}_count`], count); assert.equal(merged[`${name}_peak`], peak);
  }
  assert.equal(merged.latency, 3); assert.equal(merged.latency_count, 3);
  assert.deepEqual(db.db.prepare("SELECT * FROM metric_samples WHERE bot_id='other'").get(), unrelated);
  assert.equal(db.db.prepare('SELECT cpu FROM metric_samples WHERE resolution=15').get()!.cpu, 999);
  const rows = db.db.prepare('SELECT * FROM metric_samples ORDER BY bot_id,time,resolution').all();
  db.compact(now);
  assert.deepEqual(db.db.prepare('SELECT * FROM metric_samples ORDER BY bot_id,time,resolution').all(), rows);
});

test('metrics query weights mixed resolutions and keeps missing provider fields null', t => {
  const db = new MetricsDatabase(':memory:'); t.after(() => db.close());
  const day = 86400000;
  db.insert(sample(15000, 10)); db.insert(sample(45000, 30)); db.compact(7 * day + 60000);
  db.insert(sample(75000, 80));
  const queried = db.query(0, 8 * 60 * 60000);
  assert.equal(queried.samples.length, 1); assert.equal(queried.samples[0]!.cpu, 40); assert.equal(queried.peaks[0]!.cpu, 80);
  assert.equal(queried.samples[0]!.memory, null);
  assert.throws(() => db.insert(sample(90000, NaN)), /采样值无效/u);
  assert.throws(() => db.query(10, 0), /时间范围无效/u);
});

class FakeDocker {
  container: ContainerInfo | null = null;
  calls: string[] = [];
  nextId = 1;
  beforeStop?: () => Promise<void>;
  afterCreate?: () => void;
  async inspect(id: string): Promise<ContainerInfo | null> { return this.container?.Config.Labels['io.napcat.console.bot'] === id ? this.container : null; }
  async create(bot: BotRecord): Promise<void> { this.calls.push('create'); this.container = { Id: `container-${this.nextId++}`, State: { Running: false, Status: 'created' }, Config: { Labels: { 'io.napcat.console.bot': bot.id } } }; this.afterCreate?.(); }
  async start(_id: string): Promise<void> { this.calls.push('start'); this.container!.State.Running = true; this.container!.State.Status = 'running'; }
  async stop(_id: string): Promise<void> { this.calls.push('stop'); await this.beforeStop?.(); this.container!.State.Running = false; this.container!.State.Status = 'exited'; }
  async remove(_id: string): Promise<void> { this.calls.push('remove'); this.container = null; }
}

function lifecycleFixture(t: test.TestContext): { db: ConsoleDatabase; id: string; docker: FakeDocker; lifecycle: Lifecycle } {
  const dir = mkdtempSync(join(tmpdir(), 'napcat-console-services-'));
  const db = new ConsoleDatabase(join(dir, 'console.sqlite3'), join(dir, 'master.key'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const bot = db.createBot({ name: 'test', targetType: 'group', targetId: '10001', config: {} });
  const docker = new FakeDocker(); const lifecycle = new Lifecycle(db, docker as unknown as DockerClient);
  return { db, id: bot.id, docker, lifecycle };
}
function report(db: ConsoleDatabase, id: string, drained = false): void {
  db.ingestHeartbeat(id, { revision: 1, connected: true, processing: !drained, drained, events: [] });
}

test('lifecycle starts, waits for graceful drain, stops and can start the existing container again', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100000 });
  const { db, id, docker, lifecycle } = lifecycleFixture(t);
  lifecycle.request(id, 'start'); await lifecycle.reconcile();
  assert.deepEqual(docker.calls, ['create', 'start']); assert.equal(db.getRuntime(id).connected, false);
  t.mock.timers.tick(1000); report(db, id); await lifecycle.reconcile(); assert.equal(lifecycle.operation(id), null);
  lifecycle.request(id, 'stop'); await lifecycle.reconcile(); assert.equal(docker.calls.includes('stop'), false);
  assert.equal(lifecycle.effectiveState(db.getBot(id)!), 'stopped');
  t.mock.timers.tick(1000); report(db, id, true); await lifecycle.reconcile();
  assert.equal(db.getRuntime(id).state, 'stopped'); assert.equal(docker.container!.State.Running, false);
  lifecycle.request(id, 'start'); await lifecycle.reconcile();
  assert.deepEqual(docker.calls, ['create', 'start', 'stop', 'start']);
  t.mock.timers.tick(1000); report(db, id); await lifecycle.reconcile();
  assert.equal(lifecycle.operation(id), null); assert.equal(db.getRuntime(id).state, 'running');
});

test('lifecycle restart cannot be acknowledged by a heartbeat from before the replacement start', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100000 });
  const { db, id, docker, lifecycle } = lifecycleFixture(t);
  lifecycle.request(id, 'start'); await lifecycle.reconcile();
  t.mock.timers.tick(1000); report(db, id); await lifecycle.reconcile();
  lifecycle.request(id, 'restart');
  t.mock.timers.tick(1000); report(db, id, true); await lifecycle.reconcile();
  assert.deepEqual(docker.calls, ['create', 'start', 'stop', 'remove', 'create', 'start']);
  assert.equal(lifecycle.operation(id)!.phase, 'starting'); assert.equal(lifecycle.operation(id)!.containerId, 'container-2');
  await lifecycle.reconcile(); assert.ok(lifecycle.operation(id)); assert.equal(db.getRuntime(id).connected, false);
  t.mock.timers.tick(1000); report(db, id); await lifecycle.reconcile();
  assert.equal(lifecycle.operation(id), null); assert.equal(docker.container!.State.Running, true);
});

test('a newer start request during an awaited stop is preserved and resumes on reconciliation', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100000 });
  const { db, id, docker, lifecycle } = lifecycleFixture(t);
  lifecycle.request(id, 'start'); await lifecycle.reconcile(); t.mock.timers.tick(1000); report(db, id); await lifecycle.reconcile();
  lifecycle.request(id, 'restart'); t.mock.timers.tick(1000); report(db, id, true);
  docker.beforeStop = async () => { lifecycle.request(id, 'start'); };
  await lifecycle.reconcile();
  assert.equal(lifecycle.operation(id)!.kind, 'start'); assert.equal(docker.calls.includes('remove'), false);
  docker.beforeStop = undefined;
  await lifecycle.reconcile(); assert.equal(docker.container!.State.Running, true);
  t.mock.timers.tick(1000); report(db, id); await lifecycle.reconcile();
  assert.equal(lifecycle.operation(id), null);
});

test('unreachable or undrained workers remain pending instead of being forcibly stopped', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100000 });
  const { db, id, docker, lifecycle } = lifecycleFixture(t);
  lifecycle.request(id, 'start'); await lifecycle.reconcile(); t.mock.timers.tick(1000); report(db, id); await lifecycle.reconcile();
  lifecycle.request(id, 'stop'); t.mock.timers.tick(30000); await lifecycle.reconcile();
  assert.equal(docker.calls.includes('stop'), false); assert.equal(db.getRuntime(id).state, 'stopping');
  t.mock.timers.tick(1000); report(db, id, false); await lifecycle.reconcile();
  assert.equal(docker.calls.includes('stop'), false);
  lifecycle.request(id, 'start'); await lifecycle.reconcile();
  t.mock.timers.tick(1000); report(db, id); await lifecycle.reconcile();
  assert.equal(lifecycle.operation(id), null); assert.equal(docker.container!.State.Running, true);
});

test('a stop request arriving during container creation prevents its subsequent start', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100000 });
  const { db, id, docker, lifecycle } = lifecycleFixture(t);
  lifecycle.request(id, 'start');
  docker.afterCreate = () => lifecycle.request(id, 'stop');
  await lifecycle.reconcile();
  assert.deepEqual(docker.calls, ['create']); assert.equal(docker.container!.State.Running, false);
  await lifecycle.reconcile(); assert.equal(db.getRuntime(id).state, 'stopped'); assert.equal(lifecycle.operation(id), null);
});

test('a second instance cannot start for the same target until the first worker finishes stopping', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100000 });
  const { db, id, lifecycle } = lifecycleFixture(t);
  const second = db.createBot({ name: 'second', targetType: 'group', targetId: '10001', config: {} });
  lifecycle.request(id, 'start'); await lifecycle.reconcile();
  t.mock.timers.tick(1000); report(db, id); await lifecycle.reconcile();
  lifecycle.request(id, 'stop');
  assert.equal(db.getBot(id)!.desiredState, 'stopped'); assert.equal(db.getRuntime(id).state, 'stopping');
  assert.throws(() => lifecycle.request(second.id, 'start'), /已有运行实例/u);
  t.mock.timers.tick(1000); report(db, id, true); await lifecycle.reconcile();
  assert.equal(db.getRuntime(id).state, 'stopped');
  assert.doesNotThrow(() => lifecycle.request(second.id, 'start'));
});
