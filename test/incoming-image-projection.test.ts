import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConsoleDatabase } from '../src/console/database.js';
import { BridgeStore } from '../src/store.js';

test('older conversation pages include the latest attachment state without loading intervening events', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'incoming-image-projection-'));
  const db = new ConsoleDatabase(join(dir, 'console.sqlite3'), join(dir, 'master.key'));
  t.after(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });
  const bot = db.createBot({ name: 'Example', targetType: 'group', targetId: '1001', config: {} });
  const images = [{ attachmentId: 'image-example', status: 'ready', path: `/data/workspace/.qq-images/${'a'.repeat(64)}.png` }];
  const ev = (seq: number, type: string, payload: Record<string, unknown>, conversationId = 'first') => ({ seq, type, payload, conversationId, time: Date.now() });
  db.ingestEvents(bot.id, [ev(1, 'conversation.started', {}), ev(2, 'message.received', { messageId: 'one', text: '[图片]' }),
    ev(3, 'message.received', { messageId: 'two', text: 'hello' }), ev(4, 'message.images.updated', { messageId: 'one', images }),
    ev(5, 'message.received', { messageId: 'three', text: 'hello again' })]);
  assert.deepEqual(db.getConversation(bot.id, 3, 1)!.items[0]!.payload.images, images);
  db.ingestEvents(bot.id, [ev(6, 'conversation.started', {}, 'second'), ev(7, 'conversation.messages_moved', { messageIds: ['one'] }, 'second')]);
  assert.deepEqual(db.getConversation(bot.id, 3, 1)!.items[0]!.payload.images, images);
  assert.equal(db.getConversation(bot.id)!.items.find(item => item.type === 'message.images.updated')!.conversationId, 'second');
});

test('Worker attachment changes follow queued messages moved by new without changing reply policy', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'incoming-image-worker-events-'));
  const store = new BridgeStore(join(dir, 'bridge.sqlite3'), { type: 'group', id: '1001' });
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  store.insert({ messageId: 'one', senderId: '123', senderName: 'Example', text: '[图片]', time: 123, trigger: false, replyTo: null, rawJson: '{}' });
  const previous = store.recorder.conversationId;
  store.insert({ messageId: 'command', senderId: '123', senderName: 'Example', text: '/new', time: 124, trigger: true, replyTo: null, rawJson: '{}', command: 'new' });
  store.insert({ messageId: 'two', senderId: '123', senderName: 'Example', text: '[图片]', time: 125, trigger: false, replyTo: null, rawJson: '{}' });
  store.resetSessionForCommand(store.getPendingCommand()!.id);
  store.recordIncomingImages('one', [{ attachmentId: 'first', status: 'failed', error: '图片下载失败' }]);
  store.recordIncomingImages('two', [{ attachmentId: 'second', status: 'pending' }]);
  const updates = store.recorder.pending(100).filter(item => item.type === 'message.images.updated');
  assert.equal(updates[0]!.conversationId, previous);
  assert.equal(updates[1]!.conversationId, store.recorder.conversationId);
  assert.equal(store.openOrCreateBatch(50), null);
});
