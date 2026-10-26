import type { ConsoleEvent, ConversationUpdate, ConversationView } from "../../src/console/contracts";

function mergeItems(previous: ConsoleEvent[], next: ConsoleEvent[]) {
  const items = new Map(previous.map((item) => [item.seq, item]));
  next.forEach((item) => items.set(item.seq, item));
  return [...items.values()].sort((a, b) => a.seq - b.seq);
}

export function mergeLatestConversation(
  old: ConversationView | null,
  next: ConversationView | null,
): ConversationView | null {
  if (!next || !old || old.id !== next.id) return next;
  // A fresh GET is authoritative after a database restore or cursor reset.
  if (next.cursor < old.cursor) return next;
  if (old.items.length === 0) return next;

  const previousLast = old.items.at(-1)!.seq;
  const nextFirst = next.items[0]?.seq;
  // Keep the new page's cursor when a reconnect skipped more than one page.
  if (nextFirst !== undefined && nextFirst > previousLast + 1) return next;

  return {
    ...next,
    items: mergeItems(old.items, next.items),
    nextBefore: old.nextBefore,
  };
}

/** A stream cursor tracks the live tail independently of the older-page cursor. */
export function mergeConversationUpdate(
  old: ConversationView | null,
  update: ConversationUpdate,
): ConversationView | null {
  if (update.reset) return update.view;
  if (old && update.cursor < old.cursor) return old;
  const next = update.view;
  if (!next) return old;
  if (!old || old.id !== next.id) return next;
  if (update.cursor === old.cursor) return old;
  return {
    ...next,
    cursor: update.cursor,
    items: mergeItems(old.items, next.items),
    nextBefore: old.nextBefore,
  };
}

/** An older page may arrive after newer stream events; keep all live metadata. */
export function mergeOlderConversation(
  current: ConversationView | null,
  older: ConversationView | null,
): ConversationView | null {
  if (!current || !older || current.id !== older.id) return current;
  return {
    ...current,
    items: mergeItems(older.items, current.items),
    nextBefore: older.nextBefore,
  };
}

/** Coalesce cumulative thinking snapshots and render a single stable entry per run. */
export function conversationDisplay(view: ConversationView | null): ConsoleEvent[] {
  const result: ConsoleEvent[] = [];
  const tools = new Map<string, number>();
  const replies = new Map<string, number>();
  const thinking = new Map<string, {
    index: number;
    parts: Map<string, ConsoleEvent>;
  }>();
  const terminals = new Map<string, "completed" | "failed">();
  for (const item of view?.items ?? []) {
    if (item.type === "run.completed" || item.type === "run.failed")
      terminals.set(item.runId ?? "", item.type === "run.failed" ? "failed" : "completed");
    if (item.type === "thinking.updated") {
      const key = item.runId ?? "thinking:" + (item.itemId ?? item.seq);
      let group = thinking.get(key);
      if (!group) {
        group = { index: result.length, parts: new Map() };
        thinking.set(key, group);
        result.push(item);
      }
      group.parts.set(item.itemId ?? "thinking", item);
    } else if (
      item.type === "message.received" || item.type === "incoming" ||
      item.type === "reply.accepted" || item.type === "run.failed" ||
      item.type === "compact.failed"
    ) {
      if (item.type === "reply.accepted" && typeof item.payload.requestId === "string")
        replies.set(item.payload.requestId, result.length);
      result.push(item);
    } else if (item.type === "delivery.acknowledged" && typeof item.payload.mediaPath === "string") {
      const index = replies.get(String(item.payload.requestId));
      if (index !== undefined) {
        const reply = result[index]!;
        const deliveries = Array.isArray(reply.payload.deliveries) ? reply.payload.deliveries : [];
        result[index] = { ...reply, payload: { ...reply.payload, deliveries: [...deliveries, item.payload] } };
      }
    } else if (item.type === "tool.started" || item.type === "tool.completed") {
      const key = (item.runId ?? "") + ":" + (item.itemId ?? item.seq);
      const index = tools.get(key);
      if (index !== undefined) {
        const previous = result[index]!;
        result[index] = { ...item, seq: previous.seq, payload: { ...previous.payload, ...item.payload, startedAt: previous.time } };
      } else {
        tools.set(key, result.length);
        result.push(item);
      }
    }
  }
  for (const group of thinking.values()) {
    const first = result[group.index]!;
    const parts = [...group.parts.values()];
    const status = terminals.get(first.runId ?? "") ?? (
      parts.some((part) => part.payload.status === "in_progress") ? "in_progress" :
        parts.some((part) => part.payload.status === "failed") ? "failed" : "completed"
    );
    result[group.index] = {
      ...first,
      payload: {
        text: parts.map((part) => typeof part.payload.text === "string" ? part.payload.text : "").filter(Boolean).join("\n\n"),
        status,
        truncated: parts.some((part) => part.payload.truncated === true),
      },
    };
  }
  return result;
}

export interface ConversationActivity { kind: "run" | "compact"; startedAt: number | null; }

/** Runtime heartbeat decides whether an unfinished event still represents active work. */
export function conversationActivity(view: ConversationView | null, processing: boolean): ConversationActivity | null {
  if (!processing) return null;
  let run: { id?: string; time: number } | null = null;
  let compact: { id?: string; time: number } | null = null;
  let settled = false;
  for (const item of view?.items ?? []) {
    if (item.type === "run.started") { run = { id: item.runId, time: item.time }; compact = null; settled = false; }
    if ((item.type === "run.completed" || item.type === "run.failed") && (!run?.id || !item.runId || item.runId === run.id)) { run = null; compact = null; settled = true; }
    if (item.type === "compact.started") { compact = { id: item.runId, time: item.time }; settled = false; }
    if ((item.type === "compact.completed" || item.type === "compact.failed") && (!compact?.id || !item.runId || item.runId === compact.id)) { compact = null; settled = true; }
  }
  if (compact) return { kind: "compact", startedAt: compact.time };
  if (!run && settled) return null;
  return { kind: "run", startedAt: run?.time ?? null };
}
