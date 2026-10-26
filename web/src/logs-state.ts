export type LogLevel = "info" | "warn" | "error" | "debug" | "unknown";
export type LogLine = {
  id: string;
  time: string;
  level: LogLevel;
  stream: "stdout" | "stderr";
  message: string;
};
export type LogSnapshot = {
  sourceId: string;
  lines: LogLine[];
  truncated: boolean;
};

const levels = new Set<string>(["info", "warn", "error", "debug", "unknown"]);

export function parseLogSnapshot(data: string): LogSnapshot | null {
  try {
    const parsed: unknown = JSON.parse(data);
    if (!parsed || typeof parsed !== "object") return null;
    const value = parsed as Record<string, unknown>;
    if (
      typeof value.sourceId !== "string" ||
      typeof value.truncated !== "boolean" ||
      !Array.isArray(value.lines) ||
      value.lines.length > 500
    ) return null;
    for (const line of value.lines) {
      if (
        !line || typeof line !== "object" ||
        typeof line.id !== "string" ||
        typeof line.time !== "string" ||
        !levels.has(line.level) ||
        !["stdout", "stderr"].includes(line.stream) ||
        typeof line.message !== "string"
      ) return null;
    }
    return value as LogSnapshot;
  } catch {
    return null;
  }
}

export function filterLogLines(lines: LogLine[], level: LogLevel | "all", search: string) {
  const query = search.trim().toLowerCase();
  return lines.filter((line) =>
    (level === "all" || line.level === level) &&
    (!query || `${line.message} ${line.level} ${line.stream}`.toLowerCase().includes(query)),
  );
}

const logTime = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

export function formatLogTime(value: string) {
  const time = new Date(value);
  return Number.isFinite(time.getTime()) ? logTime.format(time) : "—";
}
