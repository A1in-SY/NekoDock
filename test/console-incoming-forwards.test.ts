import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { ConsoleDatabase } from '../src/console/database.js';
import { ConsoleIncomingForwards } from '../src/console/incoming-forwards.js';
import type { BotRecord } from '../src/console/contracts.js';

const event = (id: string) => ({post_type: 'message', message_type: 'group', group_id: '1001', user_id: '123', self_id: '999', message_id: id, time: 100,
  message: [{type: 'forward', data: {id: 'synthetic-private-resource'}}]});
const resolved = [{type: 'forward' as const, path: 's0', status: 'ready' as const, nodes: [{path: 's0/n0', senderName: 'Original', segments: [{type: 'text' as const, text: 'synthetic-private-discussion'}]}]}];
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'nekodock-forward-store-'));
  const file = join(root, 'console.sqlite3'), key = join(root, 'master.key');
  const db = new ConsoleDatabase(file, key);
  const bot = db.createBot({name: 'Example', targetType: 'group', targetId: '1001', config: {}});
  db.setDesiredState(bot.id, 'running');
  t.after(() => { db.close(); return rm(root, {recursive: true, force: true}); });
  return {db, bot, file, key};
}

test('forward completion updates its original message through an independent durable delivery', async t => {
  const {db, bot, file} = await fixture(t);
  const seq = db.enqueueNapcatEvent(bot.id, event('101'), 'first')!;
  const original = db.pendingNapcatEvents(bot.id)[0]!;
  assert.equal(original.forwards!.contents[0]!.status, 'pending');
  assert.doesNotMatch(JSON.stringify(original.forwards), /synthetic-private-resource/);
  const job = db.forwards.pending()[0]!;
  assert.equal(db.forwards.claim(job), true);
  db.forwards.complete(job, resolved);
  assert.equal(db.pendingNapcatEventCount(bot.id), 2);
  db.ackNapcatEvents(bot.id, seq);
  const update = db.pendingNapcatEvents(bot.id)[0]!;
  assert.equal(update.event, null);
  assert.equal(update.update!.messageId, '101');
  assert.equal(update.update!.revision, 2);
  db.ackNapcatEvents(bot.id, update.seq);
  assert.equal(db.pendingNapcatEventCount(bot.id), 0);
  assert.equal(db.forwards.get(bot.id, '101')!.contents[0]!.status, 'ready');
  assert.equal(db.forwards.get(bot.id, 'unreceived'), null);
  assert.equal(db.enqueueNapcatEvent(bot.id, event('101'), 'first'), null);
  assert.equal(db.forwards.pending().length, 0);
  const sql = new DatabaseSync(file, {readOnly: true});
  try {
    const row = sql.prepare('SELECT event_cipher,snapshot_cipher FROM console_incoming_forwards').get()!;
    assert.equal(row.event_cipher, null);
    assert.doesNotMatch(String(row.snapshot_cipher), /synthetic-private-discussion|Original/);
  } finally { sql.close(); }
});

test('a full inbound queue retains the completed content outbox until an ACK frees capacity', async t => {
  const {db, bot} = await fixture(t);
  const seq = db.enqueueNapcatEvent(bot.id, event('101'), 'first')!;
  for (let index = 0; index < 999; index++) db.enqueueNapcatEvent(bot.id, {...event(String(index + 1000)), message: [{type: 'text', data: {text: 'queued'}}]}, `message-${index}`);
  const job = db.forwards.pending()[0]!;
  assert.equal(db.forwards.claim(job), true);
  db.forwards.complete(job, resolved);
  assert.equal(db.pendingNapcatEventCount(bot.id), 1000);
  assert.equal(db.forwards.get(bot.id, '101')!.contents[0]!.status, 'ready');
  db.ackNapcatEvents(bot.id, seq);
  const queue = db.pendingNapcatEvents(bot.id, 1000);
  assert.equal(queue.length, 1000);
  assert.equal(queue.at(-1)!.update!.messageId, '101');
  db.forwards.publishPending();
  assert.equal(db.pendingNapcatEventCount(bot.id), 1000);
});

test('pending jobs recover after reconstruction and completed content survives its delivery ACK', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nekodock-forward-recover-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const file = join(root, 'console.sqlite3'), key = join(root, 'master.key');
  let db = new ConsoleDatabase(file, key);
  const bot = db.createBot({name: 'Example', targetType: 'group', targetId: '1001', config: {}});
  db.setDesiredState(bot.id, 'running');
  db.enqueueNapcatEvent(bot.id, event('101'), 'first');
  let job = db.forwards.pending()[0]!;
  assert.equal(db.forwards.claim(job), true);
  db.close();
  db = new ConsoleDatabase(file, key);
  try {
    db.forwards.recover();
    job = db.forwards.pending()[0]!;
    assert.equal(job.messageId, '101');
    assert.equal(db.forwards.claim(job), true);
    db.forwards.complete(job, resolved);
    const update = db.pendingNapcatEvents(bot.id, 100).at(-1)!;
    db.ackNapcatEvents(bot.id, update.seq);
  } finally { db.close(); }
  db = new ConsoleDatabase(file, key);
  try {
    assert.equal(db.forwards.get(bot.id, '101')!.revision, 2);
    assert.equal(db.forwards.pending().length, 0);
    assert.equal(db.pendingNapcatEventCount(bot.id), 0);
  } finally { db.close(); }
});

test('forward image identities survive late discovery, redelivery and the shared outer-message limit', async t => {
  const {db, bot} = await fixture(t);
  const first = db.images.registerForwardSource(bot.id, '101', 'forward:s0/n2/s1', 'https://example.invalid/first?auth=private')!;
  const second = db.images.registerForwardSource(bot.id, '101', 'forward:s0/n0/s1', 'https://example.invalid/second')!;
  assert.notEqual(first.id, second.id);
  assert.equal(db.images.registerForwardSource(bot.id, '101', 'forward:s0/n2/s1', 'https://example.invalid/refreshed')!.id, first.id);
  for (let index = 2; index < 64; index++) assert.ok(db.images.registerForwardSource(bot.id, '101', `forward:s0/n${index + 10}/s1`, 'https://example.invalid/next'));
  assert.equal(db.images.registerForwardSource(bot.id, '101', 'forward:s0/overflow', 'https://example.invalid/extra'), null);
  assert.equal(db.images.registerForwardSource(bot.id, '101', 'forward:s0/n2/s1', 'https://example.invalid/refreshed')!.id, first.id);
  assert.equal(db.images.forMessage(bot.id, '101').length, 64);
  assert.doesNotMatch(JSON.stringify(db.images.forMessage(bot.id, '101')), /https:|auth=|private/);
});

test('a blocked instance outbox does not starve another instance after one hundred older results', () => {
  const sql = new DatabaseSync(':memory:');
  sql.exec('CREATE TABLE bots(id TEXT PRIMARY KEY); INSERT INTO bots VALUES (\'blocked\'),(\'healthy\');');
  let publishing = false;
  const attempts: string[] = [];
  const forwards = new ConsoleIncomingForwards(sql, {
    requireBot: id => ({connectionId: id} as BotRecord), encrypt: JSON.stringify, decrypt: JSON.parse,
    transaction: fn => fn(), updated: botId => { attempts.push(botId); return publishing && botId === 'healthy'; },
  });
  try {
    for (let index = 0; index < 101; index++) {
      const botId = index < 100 ? 'blocked' : 'healthy';
      forwards.register(botId, event(String(index)), 'account', Date.now() + index);
      const job = forwards.pending().find(job => job.botId === botId && job.messageId === String(index))!;
      assert.ok(forwards.claim(job)); forwards.complete(job, resolved);
    }
    publishing = true; attempts.length = 0;
    forwards.publishPending();
    assert.deepEqual(attempts, ['blocked', 'healthy']);
    assert.equal(sql.prepare("SELECT published FROM console_incoming_forwards WHERE bot_id='healthy'").get()!.published, 1);
    assert.equal(sql.prepare("SELECT COUNT(*) n FROM console_incoming_forwards WHERE bot_id='blocked' AND published=0").get()!.n, 100);
  } finally { sql.close(); }
});

test('unavailable connections cannot hide an eligible job behind one thousand older jobs', () => {
  const sql = new DatabaseSync(':memory:');
  sql.exec('CREATE TABLE bots(id TEXT PRIMARY KEY); INSERT INTO bots VALUES (\'offline\'),(\'online\');');
  const forwards = new ConsoleIncomingForwards(sql, {
    requireBot: id => ({connectionId: id} as BotRecord), encrypt: JSON.stringify, decrypt: JSON.parse,
    transaction: fn => fn(), updated: () => true,
  });
  try {
    for (let index = 0; index < 1001; index++) forwards.register(index < 1000 ? 'offline' : 'online', event(String(index)), 'account', Date.now() + index);
    const selected = forwards.pending(['online']);
    assert.equal(selected.length, 1); assert.equal(selected[0]!.messageId, '1000');
  } finally { sql.close(); }
});
