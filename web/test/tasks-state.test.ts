import assert from "node:assert/strict";
import test from "node:test";
import { displayLocalTaskTime, localTaskTime, mergeTaskRunDetail, newTask, taskApplication, taskDetailEvents, taskEditorPayload, taskPayload, taskRunOutcome } from "../src/tasks-state.ts";
import type { ScheduledRun, ScheduledTask, TaskRunDetail } from "../../src/scheduled-contract.ts";

test("one-time schedule uses its selected timezone rather than the browser timezone", () => {
  assert.equal(localTaskTime("2026-10-28T08:30", "Asia/Shanghai"), "2026-10-28T00:30:00.000Z");
  assert.equal(localTaskTime("2026-10-28T08:30", "UTC"), "2026-10-28T08:30:00.000Z");
  assert.equal(displayLocalTaskTime("2026-10-28T00:30:00.000Z", "Asia/Shanghai"), "2026-10-28T08:30");
  assert.equal(localTaskTime("2026-07-01T08:30", "America/New_York"), "2026-07-01T12:30:00.000Z");
});

test("one-time input rejects invalid dates and daylight-saving gaps", () => {
  assert.throws(() => localTaskTime("2026-02-31T08:00", "Asia/Shanghai"));
  assert.throws(() => localTaskTime("2026-03-08T02:30", "America/New_York"));
  assert.throws(() => localTaskTime("2026-10-28T25:00", "Asia/Shanghai"));
  assert.throws(() => localTaskTime("invalid", "Asia/Shanghai"));
  assert.throws(() => localTaskTime("2026-10-28T08:00", "invalid/timezone"));
});

test("editing a past one-time schedule preserves its original second precision unless the time is changed", () => {
  const task = { ...newTask(), id: "task-a", botId: "bot-a", name: "Reminder", instructions: "Say hello", schedule: { kind: "once" as const, at: "2020-01-01T00:00:33.000Z", timezone: "Asia/Shanghai" }, creatorId: null, revision: 4, createdAt: 0, updatedAt: 0, deletedAt: null } satisfies ScheduledTask;
  const payload = taskEditorPayload({ ...task, name: "Renamed reminder", enabled: false }, "2020-01-01T08:00", task);
  assert.equal(payload.schedule.kind === "once" && payload.schedule.at, task.schedule.at);
  assert.equal(payload.name, "Renamed reminder");
  assert.equal(payload.enabled, false);
  assert.equal(payload.expectedRevision, 4);
  const changed = taskEditorPayload(task, "2030-01-01T08:00", task);
  assert.equal(changed.schedule.kind === "once" && changed.schedule.at, "2030-01-01T00:00:00.000Z");
});

test("task payload isolates mutable fields from server-owned identity and state", () => {
  const task = { ...newTask(), name: "  Daily report ", instructions: "  Fetch current data ", id: "task-a", botId: "bot-a", creatorId: "1001", revision: 4, createdAt: 0, updatedAt: 0, deletedAt: null, appliedRevision: 3, nextRunAt: 1 } satisfies ScheduledTask;
  const payload = taskPayload(task, 4);
  assert.equal(payload.name, "Daily report");
  assert.equal(payload.instructions, "Fetch current data");
  assert.equal(payload.expectedRevision, 4);
  for (const field of ["id", "botId", "creatorId", "revision", "appliedRevision", "nextRunAt", "deletedAt"]) assert.equal(field in payload, false);
  assert.equal("expectedRevision" in taskPayload(task), false);
});

test("state and chat history are independently enabled and combined without retaining script contents", () => {
  const input = { ...newTask(), name: "Summary", instructions: "Compare today's conversation with the prior summary", script: { runtime: "python" as const, source: "old_source" }, context: { taskState: true, chatHistory: { range: "rolling" as const, hours: 24, includeBotReplies: true, maxMessages: 2000, maxInputTokens: 20000 } } };
  const payload = taskPayload(input);
  assert.equal(payload.script, null);
  assert.equal(payload.context.taskState, true);
  assert.equal(payload.context.chatHistory?.hours, 24);
  payload.context.chatHistory!.hours = 12;
  assert.equal(input.context.chatHistory.hours, 24);
  assert.throws(() => taskPayload({ ...input, name: " " }));
  assert.throws(() => taskPayload({ ...input, instructions: " " }));
  assert.throws(() => taskPayload({ ...input, kind: "script", script: { runtime: "python", source: " " } }));
});

test("application and execution labels keep failed generation separate from confirmed delivery", () => {
  const task = { ...newTask(), id: "task-a", botId: "bot-a", creatorId: null, revision: 4, createdAt: 0, updatedAt: 0, deletedAt: null } satisfies ScheduledTask;
  assert.equal(taskApplication(task), "等待 Worker 应用");
  assert.equal(taskApplication({ ...task, appliedRevision: 4 }), "已应用");
  assert.equal(taskApplication({ ...task, appliedRevision: 4, enabled: false }), "已暂停");
  assert.equal(taskApplication({ ...task, appliedRevision: 4, deletedAt: 1 }), "已删除");
  const run = { id: "run-a", taskId: "task-a", taskRevision: 4, scheduledAt: 0, startedAt: 0, finishedAt: 1, status: "failed", deliveryStatus: "acknowledged", acceptedMessages: 1, acknowledgedMessages: 1, manual: false, conversationId: "conversation-a" } satisfies ScheduledRun;
  assert.equal(taskRunOutcome(run), "执行失败 · 已确认发送 1 条");
  assert.equal(taskRunOutcome({ ...run, deliveryStatus: "unconfirmed", acknowledgedMessages: 0 }), "执行失败 · 发送未确认");
});

test("task detail coalesces cumulative thinking and tools while retaining scripts and delivery events", () => {
  const events = [
    { type: "thinking.updated", time: 1, payload: { itemId: "model-one", text: "initial", status: "in_progress" } },
    { type: "tool.started", time: 2, payload: { itemId: "tool-one", tool: "web_search" } },
    { type: "thinking.updated", time: 3, payload: { itemId: "model-one", text: "first complete", status: "completed" } },
    { type: "script.output", time: 4, payload: { text: "script output" } },
    { type: "tool.completed", time: 5, payload: { itemId: "tool-one", result: "found" } },
    { type: "thinking.updated", time: 6, payload: { itemId: "model-two", text: "second partial", status: "in_progress", truncated: true } },
    { type: "delivery.acknowledged", time: 7, payload: {} },
  ];
  const previous = structuredClone(events);
  const result = taskDetailEvents(events, "failed");
  assert.deepEqual(result.map(event => event.type), ["thinking.updated", "tool.completed", "script.output", "delivery.acknowledged"]);
  assert.deepEqual(result[0]!.payload, { text: "first complete\n\nsecond partial", status: "failed", truncated: true });
  assert.equal(result[1]!.payload.tool, "web_search");
  assert.equal(result[1]!.payload.result, "found");
  assert.deepEqual(events, previous);
});

test("run detail deltas retain prior events and replace matching cumulative snapshots", () => {
  const run = { id: "run-a", taskId: "task-a", taskRevision: 1, scheduledAt: 0, startedAt: 0, finishedAt: null, status: "running", deliveryStatus: "none", acceptedMessages: 0, acknowledgedMessages: 0, manual: false, conversationId: "c" } satisfies ScheduledRun;
  const original: TaskRunDetail = { run, cursor: 2, events: [{ seq: 1, type: "thinking.updated", time: 1, payload: { itemId: "thought", text: "first" } }, { seq: 2, type: "tool.started", time: 2, payload: { itemId: "tool", tool: "web_search" } }] };
  const delta: TaskRunDetail = { run: { ...run, status: "completed", finishedAt: 10 }, cursor: 4, events: [{ seq: 3, type: "thinking.updated", time: 3, payload: { itemId: "thought", text: "full" } }, { seq: 4, type: "tool.completed", time: 4, payload: { itemId: "tool", result: "done" } }] };
  const before = structuredClone(original);
  const merged = mergeTaskRunDetail(original, delta);
  assert.equal(merged.cursor, 4);
  assert.equal(merged.events.length, 2);
  assert.equal(merged.events[0]!.payload.text, "full");
  assert.equal(merged.events[0]!.time, 1);
  assert.equal(merged.events[1]!.type, "tool.completed");
  assert.equal(merged.events[1]!.payload.tool, "web_search");
  assert.equal(merged.run.status, "completed");
  assert.deepEqual(mergeTaskRunDetail(merged, delta), merged);
  assert.deepEqual(original, before);
  const restored: TaskRunDetail = { run, cursor: 1, events: [] };
  assert.strictEqual(mergeTaskRunDetail(merged, restored), restored);
});
