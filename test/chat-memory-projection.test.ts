import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BridgeStore } from '../src/store.js';
import { MemoryStore } from '../src/memory-store.js';

test('async memory sources journal enhanced chat revisions without overwriting cited raw sources', () => {
  const directory = mkdtempSync(join(tmpdir(), 'chat-memory-')), path = join(directory, 'bridge.sqlite3');
  const chat = new BridgeStore(path, { type: 'group', id: '1001' }); const memory = new MemoryStore(path);
  try {
    memory.enableChatProjection();
    chat.insert({ messageId: 'share', senderId: '2001', senderName: 'Example', time: 1, text: 'Original share', replyTo: null, trigger: true, rawJson: '{}' });
    const original = memory.db.prepare("SELECT * FROM memory_ingest WHERE id='in:share'").get()!;
    chat.mergeEnrichment('share', 'bilibili', { resourceId: 'video-example', title: 'Example', description: 'Verified description' }, 1);
    const revision = memory.db.prepare("SELECT * FROM memory_ingest WHERE id LIKE 'revision:in:share:%'").get()!;
    assert.match(String(revision.text), /Verified description/);
    assert.equal(memory.db.prepare("SELECT text FROM memory_ingest WHERE id='in:share'").get()!.text, original.text);
    const count = memory.highWater();
    chat.mergeEnrichment('share', 'bilibili', { resourceId: 'video-example', title: 'Example', description: 'Verified description' }, 1);
    assert.equal(memory.highWater(), count);
    chat.recordPluginReply({ id: 'reply', pluginId: 'bilibili', sourceMessageId: 'share', conversationId: chat.recorder.conversationId, text: 'Actual plugin reply.', qqMessageId: '90001' });
    assert.equal(memory.db.prepare("SELECT COUNT(*) AS n FROM memory_ingest WHERE message_id='90001'").get()!.n, 1);
  } finally { memory.close(); chat.close(); rmSync(directory, { recursive: true, force: true }); }
});
