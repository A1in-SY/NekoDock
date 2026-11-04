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
  const scheduled = new Map<string, number>();
  const imageUpdates = new Map<string, { seq: number; images: unknown[] }>();
  const contentUpdates = new Map<string, { seq: number; contents: unknown[]; text?: string; revision?: number }>();
  const thinking = new Map<string, {
    index: number;
    parts: Map<string, ConsoleEvent>;
  }>();
  const terminals = new Map<string, "completed" | "failed">();
  for (const item of view?.items ?? []) {
    if (item.type === "message.content.updated") {
      if (typeof item.payload.messageId === "string" && Array.isArray(item.payload.contents))
        contentUpdates.set(item.payload.messageId, { seq: item.seq, contents: item.payload.contents,
          ...(typeof item.payload.text === 'string' ? { text: item.payload.text } : {}),
          ...(typeof item.payload.revision === 'number' ? { revision: item.payload.revision } : {}) });
      continue;
    }
    if (item.type === "message.images.updated") {
      if (typeof item.payload.messageId === "string" && Array.isArray(item.payload.images))
        imageUpdates.set(item.payload.messageId, { seq: item.seq, images: item.payload.images });
      continue;
    }
    if (item.type === "schedule.run.updated" || item.type === "schedule.run.event") {
      const run = item.payload.run && typeof item.payload.run === "object" && !Array.isArray(item.payload.run)
        ? item.payload.run as Record<string, unknown> : undefined;
      const key = item.runId ?? (typeof run?.id === "string" ? run.id : "");
      if (!key) continue;
      let index = scheduled.get(key);
      if (index === undefined) {
        index = result.length;
        scheduled.set(key, index);
        result.push({ ...item, type: "schedule.run.updated", runId: key, payload: { ...item.payload, events: [] } });
      }
      const previous = result[index]!;
      const events = Array.isArray(previous.payload.events) ? previous.payload.events as ConsoleEvent[] : [];
      if (item.type === "schedule.run.updated") {
        result[index] = { ...previous, payload: { ...previous.payload, ...item.payload, events } };
      } else if (typeof item.payload.eventType === "string" && /^(?:thinking\.updated|tool\.(?:started|completed)|script\.output)$/.test(item.payload.eventType)) {
        const body = item.payload.eventPayload;
        if (body && typeof body === "object" && !Array.isArray(body))
          events.push({ ...item, type: item.payload.eventType, payload: body as Record<string, unknown> });
      }
      continue;
    }
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
      item.type === "reply.accepted" || item.type === "plugin.message.sent" || item.type === "run.failed" ||
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
  // Updates can be on a different page from the incoming message. Keep raw events
  // in the view so loading an older page can resolve the same stable attachment.
  for (const [index, item] of result.entries()) {
    if ((item.type === "message.received" || item.type === "incoming") && typeof item.payload.messageId === "string") {
      const update = imageUpdates.get(item.payload.messageId);
      const currentSeq = typeof item.payload.imagesUpdatedSeq === "number" ? item.payload.imagesUpdatedSeq : 0;
      if (update && update.seq > currentSeq)
        result[index] = { ...item, payload: { ...item.payload, images: update.images, imagesUpdatedSeq: update.seq } };
      const content = contentUpdates.get(item.payload.messageId);
      const contentSeq = typeof item.payload.contentUpdatedSeq === 'number' ? item.payload.contentUpdatedSeq : 0;
      if (content && content.seq > contentSeq) {
        const current = result[index]!;
        result[index] = { ...current, payload: { ...current.payload, contents: content.contents, contentUpdatedSeq: content.seq,
          ...(content.text === undefined ? {} : { text: content.text }), ...(content.revision === undefined ? {} : { revision: content.revision }) } };
      }
    }
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
    if (item.type === "schedule.run.updated") {
      const value = item.payload.run;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const scheduled = value as Record<string, unknown>;
        const id = typeof scheduled.id === "string" ? scheduled.id : item.runId;
        if (scheduled.status === "running") { run = { id, time: typeof scheduled.startedAt === "number" ? scheduled.startedAt : item.time }; compact = null; settled = false; }
        else if (["completed", "failed", "interrupted", "missed"].includes(String(scheduled.status)) && run?.id === id) { run = null; settled = true; }
      }
    }
    if (item.type === "run.started") { run = { id: item.runId, time: item.time }; compact = null; settled = false; }
    if ((item.type === "run.completed" || item.type === "run.failed") && (!run?.id || !item.runId || item.runId === run.id)) { run = null; compact = null; settled = true; }
    if (item.type === "compact.started") { compact = { id: item.runId, time: item.time }; settled = false; }
    if ((item.type === "compact.completed" || item.type === "compact.failed") && (!compact?.id || !item.runId || item.runId === compact.id)) { compact = null; settled = true; }
  }
  if (compact) return { kind: "compact", startedAt: compact.time };
  if (!run && settled) return null;
  return { kind: "run", startedAt: run?.time ?? null };
}
