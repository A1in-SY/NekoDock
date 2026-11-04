import type { ScheduledRun, ScheduledTask, ScheduledTaskInput, TaskDeliveryStatus, TaskRunDetail, TaskRunStatus } from "../../src/scheduled-contract.ts";

export const runLabels: Record<TaskRunStatus, string> = { queued: "等待执行", running: "执行中", completed: "已完成", failed: "执行失败", interrupted: "已中断", missed: "已错过" };
export const deliveryLabels: Record<TaskDeliveryStatus, string> = { none: "未发送", pending: "发送中", acknowledged: "已确认发送", failed: "发送失败", unconfirmed: "发送未确认", partial: "部分已发送" };

export function newTask(): ScheduledTaskInput {
  return { name: "", kind: "model", enabled: true, schedule: { kind: "cron", expression: "0 8 * * *", timezone: "Asia/Shanghai" },
    instructions: "", script: null, context: { taskState: false }, maxDelaySeconds: 600, timeoutSeconds: 600, notifyOnFailure: false };
}

/** Round-trip the selected local time in its task timezone, independent of browser timezone. */
export function localTaskTime(value: string, timezone: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) throw new Error("请选择有效的执行时间");
  const parts = match.slice(1).map(Number);
  const wanted = Date.UTC(parts[0]!, parts[1]! - 1, parts[2]!, parts[3]!, parts[4]!, parts[5] || 0);
  const format = new Intl.DateTimeFormat("sv-SE", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  let instant = wanted;
  for (let i = 0; i < 4; i++) {
    const p = Object.fromEntries(format.formatToParts(instant).map(x => [x.type, x.value]));
    const actual = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
    const delta = wanted - actual;
    if (delta === 0) {
      const normalized = new Date(wanted).toISOString().slice(0, 19);
      if (normalized !== value.slice(0, 16) + ":" + (match[6] || "00")) break;
      return new Date(instant).toISOString();
    }
    instant += delta;
  }
  throw new Error("该日期或时间在所选时区中不存在，请重新选择");
}

export function displayLocalTaskTime(instant: string, timezone: string): string {
  if (!instant || !Number.isFinite(Date.parse(instant))) return "";
  return new Intl.DateTimeFormat("sv-SE", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(instant)).replace(" ", "T");
}

export function taskPayload(task: ScheduledTaskInput, expectedRevision?: number): ScheduledTaskInput & { expectedRevision?: number } {
  const copy: ScheduledTaskInput = { name: task.name.trim(), kind: task.kind, enabled: task.enabled, schedule: { ...task.schedule },
    instructions: task.instructions.trim(), script: task.kind === "script" && task.script ? { ...task.script } : null,
    context: { taskState: task.context.taskState, ...(task.context.chatHistory ? { chatHistory: { ...task.context.chatHistory } } : {}) },
    maxDelaySeconds: task.maxDelaySeconds, timeoutSeconds: task.timeoutSeconds, notifyOnFailure: task.notifyOnFailure };
  if (!copy.name) throw new Error("请输入任务名称");
  if (copy.kind === "model" && !copy.instructions) throw new Error("请输入任务要求");
  if (copy.kind === "script" && !copy.script?.source.trim()) throw new Error("请输入脚本内容");
  if (copy.schedule.kind === "once" && !Number.isFinite(Date.parse(copy.schedule.at))) throw new Error("请选择有效的执行时间");
  if (copy.schedule.kind === "cron" && !copy.schedule.expression.trim()) throw new Error("请输入 Cron 表达式");
  new Intl.DateTimeFormat("zh-CN", { timeZone: copy.schedule.timezone });
  return { ...copy, ...(expectedRevision === undefined ? {} : { expectedRevision }) };
}

export function taskEditorPayload(draft: ScheduledTaskInput, onceTime: string, original?: ScheduledTask): ScheduledTaskInput & { expectedRevision?: number } {
  let schedule = draft.schedule;
  if (schedule.kind === "once") {
    const originalSchedule = original?.schedule.kind === "once" ? original.schedule : null;
    const unchanged = originalSchedule && schedule.timezone === originalSchedule.timezone
      && onceTime === displayLocalTaskTime(originalSchedule.at, originalSchedule.timezone);
    schedule = { ...schedule, at: unchanged ? originalSchedule.at : localTaskTime(onceTime, schedule.timezone) };
  }
  return taskPayload({ ...draft, schedule }, original?.revision);
}

/** The response cursor tracks all scanned events, including compacted thinking snapshots. */
export function mergeTaskRunDetail(previous: TaskRunDetail | null, next: TaskRunDetail): TaskRunDetail {
  if (!previous || previous.run.id !== next.run.id || (next.cursor !== undefined && previous.cursor !== undefined && next.cursor < previous.cursor)) return next;
  if (next.cursor === undefined) return next;
  const keyed = new Map<string, TaskRunDetail["events"][number]>();
  for (const event of [...previous.events, ...next.events]) {
    const itemId = typeof event.payload.itemId === "string" ? event.payload.itemId : "";
    const key = itemId && event.type === "thinking.updated" ? `thinking:${itemId}` : itemId && (event.type === "tool.started" || event.type === "tool.completed") ? `tool:${itemId}` : event.seq !== undefined ? `seq:${event.seq}` : `legacy:${event.time}:${event.type}:${keyed.size}`;
    const old = keyed.get(key);
    keyed.set(key, old ? { ...event, time: old.time, payload: event.type.startsWith("tool.") ? { ...old.payload, ...event.payload } : event.payload } : event);
  }
  return { ...next, events: [...keyed.values()].sort((a, b) => a.time - b.time || (a.seq ?? 0) - (b.seq ?? 0)).slice(-2000) };
}

export function taskApplication(task: ScheduledTask): string {
  if (task.appliedRevision !== task.revision) return "等待 Worker 应用";
  return task.deletedAt ? "已删除" : task.enabled ? "已应用" : "已暂停";
}

export function taskRunOutcome(run: ScheduledRun): string {
  return `${runLabels[run.status]} · ${deliveryLabels[run.deliveryStatus]}${run.acknowledgedMessages > 0 ? ` ${run.acknowledgedMessages} 条` : ""}`;
}

/** Provider thinking events are cumulative snapshots; show one expandable group per execution. */
export function taskDetailEvents(events: TaskRunDetail["events"], status: TaskRunStatus): TaskRunDetail["events"] {
  const result: TaskRunDetail["events"] = [];
  const thoughts = new Map<string, TaskRunDetail["events"][number]>();
  let thinkingIndex: number | undefined;
  const tools = new Map<string, number>();
  for (const event of events) {
    const itemId = typeof event.payload.itemId === "string" ? event.payload.itemId : "";
    if (event.type === "thinking.updated") {
      if (thinkingIndex === undefined) { thinkingIndex = result.length; result.push(event); }
      thoughts.set(itemId || "thinking", event);
    } else if ((event.type === "tool.started" || event.type === "tool.completed") && itemId) {
      const index = tools.get(itemId);
      if (index === undefined) { tools.set(itemId, result.length); result.push(event); }
      else result[index] = { ...event, time: result[index]!.time, payload: { ...result[index]!.payload, ...event.payload } };
    } else result.push(event);
  }
  if (thinkingIndex !== undefined) {
    const terminal = ["completed", "failed", "interrupted", "missed"].includes(status);
    result[thinkingIndex] = { ...result[thinkingIndex]!, payload: {
      text: [...thoughts.values()].map(item => typeof item.payload.text === "string" ? item.payload.text : "").filter(Boolean).join("\n\n"),
      status: terminal ? status === "completed" ? "completed" : "failed" : [...thoughts.values()].some(item => item.payload.status === "in_progress") ? "in_progress" : "completed",
      truncated: [...thoughts.values()].some(item => item.payload.truncated === true),
    } };
  }
  return result;
}
