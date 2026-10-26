import assert from "node:assert/strict";
import test from "node:test";
import { filterLogLines, formatLogTime, parseLogSnapshot } from "../src/logs-state.ts";
import type { LogLine } from "../src/logs-state.ts";

const lines: LogLine[] = [
  { id: "1", time: "2026-10-25T06:00:00.000Z", level: "info", stream: "stdout", message: "codex.run.started" },
  { id: "2", time: "2026-10-25T06:01:00.000Z", level: "error", stream: "stderr", message: "Codex failed" },
];

test("log snapshots replace current container data and accept empty logs", () => {
  const first = parseLogSnapshot(JSON.stringify({ sourceId: "old", lines, truncated: true }));
  assert.equal(first?.lines.length, 2);
  const replacement = parseLogSnapshot(JSON.stringify({ sourceId: "new", lines: [], truncated: false }));
  assert.equal(replacement?.sourceId, "new");
  assert.deepEqual(replacement?.lines, []);
});

test("log snapshots reject malformed, unexpected-level and oversized payloads", () => {
  assert.equal(parseLogSnapshot("invalid"), null);
  assert.equal(parseLogSnapshot(JSON.stringify({ sourceId: "x", lines: [null], truncated: false })), null);
  assert.equal(parseLogSnapshot(JSON.stringify({ sourceId: "x", lines: [{ ...lines[0], level: "fatal" }], truncated: false })), null);
  assert.equal(parseLogSnapshot(JSON.stringify({ sourceId: "x", lines: Array(501).fill(lines[0]), truncated: false })), null);
});

test("log filters combine exact level and case-insensitive search without changing the snapshot", () => {
  assert.deepEqual(filterLogLines(lines, "error", "  codex  "), [lines[1]]);
  assert.deepEqual(filterLogLines(lines, "info", "stderr"), []);
  assert.deepEqual(filterLogLines(lines, "all", "stderr"), [lines[1]]);
  assert.deepEqual(filterLogLines(lines, "all", ""), lines);
  assert.equal(lines.length, 2);
});

test("log times use UTC+8 regardless of browser or server timezone", () => {
  assert.equal(formatLogTime("2026-10-25T06:00:00.000Z"), "2026/10/25 14:00:00");
  assert.equal(formatLogTime("invalid"), "—");
});
