import assert from "node:assert/strict";
import test from "node:test";
import type { ConsoleEvent, ConversationView } from "../../src/console/contracts.ts";
import { conversationActivity, conversationDisplay, mergeConversationUpdate, mergeLatestConversation, mergeOlderConversation } from "../src/conversation-state.ts";

function view(
  sequences: number[],
  nextBefore: number | null = null,
  id = "chat",
): ConversationView {
  return {
    id,
    cursor: sequences.at(-1) ?? 0,
    agentSessionId: null,
    startedAt: 1,
    items: sequences.map((seq) => ({
      seq,
      type: "message.received",
      time: seq,
      payload: { text: String(seq) },
    })),
    nextBefore,
    usage: { input: null, cached: null, output: null, total: null },
    context: { used: null, window: null, compactLimit: null },
  };
}

test("reconnect gap rebases to latest page and preserves its older-page cursor", () => {
  const old = view([1, 2, 3]);
  const next = view([104, 105, 106], 104);
  assert.strictEqual(mergeLatestConversation(old, next), next);
  assert.equal(mergeLatestConversation(old, next)!.nextBefore, 104);
});

test("overlapping pages retain loaded history and replace duplicate event values", () => {
  const old = view([1, 2, 3], 1);
  const next = view([3, 4, 5], 3);
  next.items[0]!.payload = { text: "updated" };
  const merged = mergeLatestConversation(old, next)!;
  assert.deepEqual(
    merged.items.map((item) => item.seq),
    [1, 2, 3, 4, 5],
  );
  assert.deepEqual(merged.items[2]!.payload, { text: "updated" });
  assert.equal(merged.nextBefore, 1);
});

test("contiguous new events merge without resetting completed history", () => {
  const merged = mergeLatestConversation(view([1, 2]), view([3, 4], 3))!;
  assert.deepEqual(
    merged.items.map((item) => item.seq),
    [1, 2, 3, 4],
  );
  assert.equal(merged.nextBefore, null);
});

test("a different conversation replaces the old history", () => {
  const next = view([20], null, "new-chat");
  assert.strictEqual(mergeLatestConversation(view([1]), next), next);
});

test("empty previous and latest pages preserve the appropriate history cursor", () => {
  const next = view([10, 11], 10);
  assert.strictEqual(mergeLatestConversation(view([]), next), next);
  const old = view([1, 2], 1);
  const empty = view([]);
  empty.cursor = old.cursor;
  const merged = mergeLatestConversation(old, empty)!;
  assert.deepEqual(merged.items, old.items);
  assert.equal(merged.nextBefore, 1);
});

test("missing conversations clear or establish the view", () => {
  const next = view([1]);
  assert.strictEqual(mergeLatestConversation(null, next), next);
  assert.equal(mergeLatestConversation(next, null), null);
});


test("activity follows runtime heartbeat and real run and compaction events", () => {
  const current = view([]);
  current.items = [{ seq: 1, type: "run.started", time: 100, runId: "one", payload: {} }];
  assert.equal(conversationActivity(current, false), null);
  assert.deepEqual(conversationActivity(current, true), { kind: "run", startedAt: 100 });
  current.items.push({ seq: 2, type: "compact.started", time: 200, runId: "one", payload: {} });
  assert.deepEqual(conversationActivity(current, true), { kind: "compact", startedAt: 200 });
  current.items.push({ seq: 3, type: "compact.completed", time: 300, runId: "one", payload: {} });
  assert.deepEqual(conversationActivity(current, true), { kind: "run", startedAt: 100 });
  current.items.push({ seq: 4, type: "run.failed", time: 400, runId: "one", payload: {} });
  assert.equal(conversationActivity(current, false), null);
  assert.equal(conversationActivity(current, true), null);
  assert.deepEqual(conversationActivity(null, true), { kind: "run", startedAt: null });
});


test("live deltas merge by sequence and ignore replayed or stale cursors", () => {
  const initial = view([1, 2], 1);
  const delta = view([2, 3, 4]);
  delta.items[0]!.payload = { text: "same sequence" };
  const update = { cursor: 4, reset: false, view: delta };
  const merged = mergeConversationUpdate(initial, update)!;
  assert.deepEqual(merged.items.map((item) => item.seq), [1, 2, 3, 4]);
  assert.equal(merged.cursor, 4);
  assert.equal(merged.nextBefore, 1);
  assert.strictEqual(mergeConversationUpdate(merged, update), merged);
  assert.strictEqual(mergeConversationUpdate(merged, { cursor: 3, reset: false, view: view([3]) }), merged);
  assert.strictEqual(mergeConversationUpdate(merged, { cursor: 2, reset: false, view: null }), merged);
});

test("a reset changes conversation identity and clears an absent conversation", () => {
  const old = view([1, 2]);
  const next = view([10], null, "new-chat");
  assert.strictEqual(mergeConversationUpdate(old, { cursor: 10, reset: true, view: next }), next);
  assert.equal(mergeConversationUpdate(next, { cursor: 11, reset: true, view: null }), null);
  assert.strictEqual(mergeConversationUpdate(null, { cursor: 10, reset: false, view: next }), next);
});

test("same-conversation reset rebases the entire view even when the snapshot overlaps", () => {
  const old = view([1, 2, 3, 4], 1);
  const next = view([4, 5], 4);
  const merged = mergeConversationUpdate(old, { cursor: 5, reset: true, view: next })!;
  assert.strictEqual(merged, next);
  assert.deepEqual(merged.items.map((item) => item.seq), [4, 5]);
  assert.equal(merged.nextBefore, 4);
});

test("reset accepts a lower live cursor, including an unchanged conversation id", () => {
  const old = view([10, 11, 12]);
  const restored = view([1, 2], 1);
  restored.agentSessionId = "restored-session";
  restored.usage = { input: 20, cached: 10, output: 2, total: 22 };
  const merged = mergeConversationUpdate(old, { cursor: 2, reset: true, view: restored });
  assert.strictEqual(merged, restored);
  assert.equal(merged!.cursor, 2);
  assert.deepEqual(merged!.items.map((item) => item.seq), [1, 2]);
  assert.equal(mergeConversationUpdate(old, { cursor: 0, reset: true, view: null }), null);
  const nextConversation = view([1], null, "restored-conversation");
  assert.strictEqual(mergeConversationUpdate(old, { cursor: 1, reset: true, view: nextConversation }), nextConversation);
});

test("retry snapshot accepts a restored lower cursor and keeps older history for a continuous latest snapshot", () => {
  const old = view([10, 11, 12], 10);
  const restored = view([1, 2], 1);
  assert.strictEqual(mergeLatestConversation(old, restored), restored);
  const continuous = mergeLatestConversation(old, view([12, 13], 12))!;
  assert.deepEqual(continuous.items.map((item) => item.seq), [10, 11, 12, 13]);
  assert.equal(continuous.nextBefore, 10);
});

test("a late older page preserves live cursor, session and token metadata", () => {
  const current = view([10, 11, 12], 10);
  current.cursor = 20;
  current.agentSessionId = "live-session";
  current.usage = { input: 100, cached: 80, output: 10, total: 110 };
  current.context = { used: 50, window: 200000, compactLimit: 160000 };
  const older = view([1, 2, 10], 1);
  const merged = mergeOlderConversation(current, older)!;
  assert.deepEqual(merged.items.map((item) => item.seq), [1, 2, 10, 11, 12]);
  assert.equal(merged.cursor, 20);
  assert.equal(merged.agentSessionId, "live-session");
  assert.deepEqual(merged.usage, current.usage);
  assert.deepEqual(merged.context, current.context);
  assert.equal(merged.nextBefore, 1);
  assert.strictEqual(mergeOlderConversation(merged, view([1], null, "old-chat")), merged);
});

function event(seq: number, type: string, runId: string, payload: Record<string, unknown> = {}, itemId?: string): ConsoleEvent {
  return { seq, type, time: seq, runId, itemId, payload };
}

test("thinking snapshots replace the same model message and combine model calls once per run", () => {
  const current = view([]);
  current.items = [
    event(1, "thinking.updated", "a", { text: "first", status: "in_progress" }, "call1"),
    event(2, "thinking.updated", "a", { text: "first full", status: "completed" }, "call1"),
    event(3, "tool.started", "a", { tool: "read" }, "tool1"),
    event(4, "tool.completed", "a", { tool: "read", result: "ok" }, "tool1"),
    event(5, "thinking.updated", "a", { text: "second", status: "in_progress" }, "call2"),
    event(6, "reply.accepted", "a", { requestId: "reply", messages: ["hello"] }),
    event(7, "thinking.updated", "a", { text: "second full", status: "completed", truncated: true }, "call2"),
    event(8, "run.completed", "a"),
  ];
  const display = conversationDisplay(current);
  assert.deepEqual(display.map((item) => item.type), ["thinking.updated", "tool.completed", "reply.accepted"]);
  assert.equal(display[0]!.seq, 1);
  assert.deepEqual(display[0]!.payload, { text: "first full\n\nsecond full", status: "completed", truncated: true });
  assert.equal(display[1]!.payload.startedAt, 3);
});

test("different runs keep separate thinking groups and terminal events settle unfinished thoughts", () => {
  const current = view([]);
  current.items = [
    event(1, "thinking.updated", "one", { text: "one", status: "in_progress" }, "same-id"),
    event(2, "run.completed", "one"),
    event(3, "thinking.updated", "two", { text: "two", status: "in_progress" }, "same-id"),
    event(4, "run.failed", "two", { reason: "timeout" }),
    event(5, "thinking.updated", "three", { text: "three", status: "in_progress" }, "same-id"),
  ];
  const thoughts = conversationDisplay(current).filter((item) => item.type === "thinking.updated");
  assert.deepEqual(thoughts.map((item) => [item.runId, item.payload.text, item.payload.status]), [
    ["one", "one", "completed"], ["two", "two", "failed"], ["three", "three", "in_progress"],
  ]);
});

test("thinking content stays plain text and cumulative updates preserve the display identity", () => {
  const current = view([]);
  current.items = [event(1, "thinking.updated", "one", { text: "<script>alert(1)</script>", status: "in_progress" }, "call")];
  const first = conversationDisplay(current)[0]!;
  current.items.push(event(2, "thinking.updated", "one", { text: "<script>alert(1)</script> more", status: "completed" }, "call"));
  const second = conversationDisplay(current)[0]!;
  assert.equal(first.seq, second.seq);
  assert.equal(first.runId, second.runId);
  assert.equal(second.payload.text, "<script>alert(1)</script> more");
});
