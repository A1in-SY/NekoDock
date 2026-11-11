import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {ConsoleDatabase} from '../src/console/database.js';
import {INSPECTION_CACHE_LIMITS} from '../src/console/inspection-cache.js';
import {InspectionRequestLimiter} from '../src/console/inspection-request-limiter.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'nekodock-inspection-cache-'));
  const file = join(root, 'console.sqlite3'), master = join(root, 'master.key');
  let db = new ConsoleDatabase(file, master);
  const bot = db.createBot({name: 'Synthetic cache owner', targetType: 'group', targetId: '1001', config: {}});
  const other = db.createBot({name: 'Other synthetic owner', targetType: 'group', targetId: '1002', config: {}});
  t.after(async () => {db.close(); await rm(root, {recursive: true, force: true});});
  return {bot, other, file, get db() {return db;}, restart() {db.close(); db = new ConsoleDatabase(file, master);}};
}
const key = (index: number) => index.toString(16).padStart(64, '0');
const prepared = {type: 'image' as const, mimeType: 'image/png', data: Buffer.from('synthetic derived image').toString('base64')};

test('inspection cache is encrypted, instance scoped and survives Console reconstruction', async t => {
  const f = await fixture(t), a = f.db.plugins.inspections.classificationCache(f.bot.id);
  await a.setPrepared(key(1), prepared); await a.setScore(key(2), {score: 0.94, model: 'synthetic-vision'});
  assert.equal(await f.db.plugins.inspections.classificationCache(f.other.id).getScore(key(2)), undefined);
  f.restart();
  const b = f.db.plugins.inspections.classificationCache(f.bot.id);
  assert.deepEqual(await b.getPrepared(key(1)), prepared);
  assert.deepEqual(await b.getScore(key(2)), {score: 0.94, model: 'synthetic-vision'});
  const sql = new DatabaseSync(f.file, {readOnly: true});
  try {assert.doesNotMatch(JSON.stringify(sql.prepare('SELECT * FROM plugin_inspection_cache').all()), /synthetic-vision|synthetic derived image|0\.94/u);}
  finally {sql.close();}
});

test('expired or malformed cached payloads are misses and pruning leaves other instances intact', async t => {
  const f = await fixture(t), a = f.db.plugins.inspections.classificationCache(f.bot.id);
  await a.setScore(key(1), {score: 0.6});
  await f.db.plugins.inspections.classificationCache(f.other.id).setScore(key(1), {score: 0.7});
  const sql = new DatabaseSync(f.file);
  try {
    sql.prepare('UPDATE plugin_inspection_cache SET expires_at=? WHERE bot_id=?').run(Date.now() - 1, f.bot.id);
    assert.equal(await a.getScore(key(1)), undefined);
    await a.setPrepared(key(2), prepared);
    sql.prepare('UPDATE plugin_inspection_cache SET payload_cipher=? WHERE bot_id=? AND cache_key=?').run('invalid-encrypted-payload', f.bot.id, key(2));
    assert.equal(await a.getPrepared(key(2)), undefined);
    await a.setScore(key(3), {score: 0.8});
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM plugin_inspection_cache WHERE bot_id=? AND cache_key=?').get(f.bot.id, key(1))!.n, 0);
    assert.deepEqual(await f.db.plugins.inspections.classificationCache(f.other.id).getScore(key(1)), {score: 0.7});
  } finally {sql.close();}
});

test('prepared cache enforces its count and byte budget', async t => {
  const f = await fixture(t), a = f.db.plugins.inspections.classificationCache(f.bot.id);
  for (let i = 0; i < INSPECTION_CACHE_LIMITS.preparedCount + 2; i++) await a.setPrepared(key(i), prepared);
  const sql = new DatabaseSync(f.file);
  try {
    assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM plugin_inspection_cache WHERE bot_id=? AND kind='prepared'").get(f.bot.id)!.n, INSPECTION_CACHE_LIMITS.preparedCount);
    sql.prepare('UPDATE plugin_inspection_cache SET bytes=? WHERE bot_id=?').run(INSPECTION_CACHE_LIMITS.preparedBytes, f.bot.id);
    await a.setPrepared(key(999), prepared);
    const row = sql.prepare("SELECT COUNT(*) AS n,SUM(bytes) AS bytes FROM plugin_inspection_cache WHERE bot_id=? AND kind='prepared'").get(f.bot.id)!;
    assert.equal(row.n, 1); assert.ok(Number(row.bytes) <= INSPECTION_CACHE_LIMITS.preparedBytes);
    assert.deepEqual(await a.getPrepared(key(999)), prepared);
  } finally {sql.close();}
});

test('request slots are globally bounded, FIFO, released once and cancelled waiters do not block other jobs', async () => {
  const slots = new InspectionRequestLimiter(2), controller = new AbortController();
  const freeA = await slots.acquire(controller.signal), freeB = await slots.acquire(controller.signal);
  const cancelled = new AbortController(), pending = slots.acquire(cancelled.signal);
  const rejected = assert.rejects(pending);
  let acquired = false;
  const next = slots.acquire(controller.signal).then(release => {acquired = true; return release;});
  await Promise.resolve(); assert.equal(acquired, false);
  cancelled.abort(); await rejected;
  freeA(); const freeC = await next;
  freeA();
  let fourth = false;
  const waiting = slots.acquire(controller.signal).then(release => {fourth = true; return release;});
  await Promise.resolve(); assert.equal(fourth, false, 'a duplicate release must not create a third slot');
  freeB(); const freeD = await waiting;
  freeC(); freeD();
});
