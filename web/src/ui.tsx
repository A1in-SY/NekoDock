import type { ReactNode } from "react";
import type { PublicBot } from "../../src/console/contracts";
const paths: Record<string, string> = {
  calendar:
    "M4 5h16v16H4zM4 10h16M8 2v6M16 2v6M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01",
  cat: "M4 15V5l5 4h6l5-4v10c-2 7-14 7-16 0M8 14h.01M16 14h.01M10 18h4",
  grid: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
  bots: "M8 4h8M12 2v2M5 7h14v13H5zM2 11v5M22 11v5M9 11h.01M15 11h.01M9 16h6",
  plus: "M12 5v14M5 12h14",
  chevron: "m9 5 7 7-7 7",
  down: "m6 9 6 6 6-6",
  arrow: "M5 12h14m-5-5 5 5-5 5",
  server: "M4 3h16v7H4zM4 14h16v7H4zM7 6.5h.01M7 17.5h.01M11 6.5h6M11 17.5h6",
  chat: "M4 4h16v12H9l-5 4V4zM8 8h8M8 12h5",
  users:
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  user: "M20 21v-2a7 7 0 0 0-14 0v2M13 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8",
  cpu: "M7 7h10v10H7zM9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 15h3M1 9h3M1 15h3M10 10h4v4h-4z",
  memory:
    "M3 7h18v11H3zM6 10v4M10 10v4M14 10v4M18 10v4M6 18v3M10 18v3M14 18v3M18 18v3",
  globe:
    "M21 12a9 9 0 1 0-18 0 9 9 0 0 0 18 0M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18",
  mic: "M8 5a4 4 0 0 1 8 0v6a4 4 0 0 1-8 0V5M5 10v1a7 7 0 0 0 14 0v-1M12 18v4M8 22h8",
  mute: "M4 4l16 16M8 5a4 4 0 0 1 8 0v6M5 10v1a7 7 0 0 0 11 6M19 10v1a7 7 0 0 1-1 4M12 18v4M8 22h8",
  settings:
    "m12 2 2 3 3-1 2 3-2 3 2 3-2 3-3-1-2 3-2-3-3 1-2-3 2-3-2-3 2-3 3 1 2-3zM15 10a3 3 0 1 0-6 0 3 3 0 0 0 6 0",
  sliders: "M4 5h16M4 12h16M4 19h16M8 2v6M16 9v6M10 16v6",
  activity: "M2 12h5l3-8 4 16 3-8h5",
  clock: "M21 12a9 9 0 1 0-18 0 9 9 0 0 0 18 0M12 7v5l3 2",
  search: "M20 20l-5-5M17 10a7 7 0 1 0-14 0 7 7 0 0 0 14 0",
  refresh: "M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 3M18 18a8 8 0 0 1-13-3",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  check: "m5 12 4 4L19 6",
  square: "M6 6h12v12H6z",
  play: "m8 4 12 8-12 8V4z",
  bell: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4",
  info: "M21 12a9 9 0 1 0-18 0 9 9 0 0 0 18 0M12 11v6M12 7h.01",
  shield: "m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6l9-4m-4 10 3 3 5-6",
  logout: "M9 5H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4M16 17l5-5-5-5M21 12H9",
  spark: "m12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5L12 2",
  document: "M14 2H5v20h14V7l-5-5v5h5M8 12h8M8 16h8",
  tool: "M14 6a5 5 0 0 0-6 6L2 18l4 4 6-6a5 5 0 0 0 6-6l-4 4-4-4 4-4",
  code: "m8 5-7 7 7 7M16 5l7 7-7 7M14 3l-4 18",
  close: "m6 6 12 12M6 18 18 6",
  copy: "M8 8h13v13H8zM16 4V2H2v14h2",
  eye: "M2 12c5-9 15-9 20 0-5 9-15 9-20 0M15 12a3 3 0 1 0-6 0 3 3 0 0 0 6 0",
  send: "m22 2-7 20-4-9-9-4 20-7M22 2 11 13",
  download: "M12 3v12m-5-5 5 5 5-5M4 15v6h16v-6",
  folder: "M3 6h7l2 3h9v12H3V6z",
  network: "M12 3v6M4 14v7M20 14v7M4 14h16M12 9v5M9 1h6v6H9z",
  database:
    "M20 6c0 5-16 5-16 0s16-5 16 0M4 6v6c0 5 16 5 16 0V6M4 12v6c0 5 16 5 16 0v-6",
  key: "M16 3a5 5 0 1 0 0 10 5 5 0 0 0 0-10M12 12 2 22M6 18l-3-3M9 15l-3-3",
};

export function Icon({
  name,
  className = "",
}: {
  name: string;
  className?: string;
}) {
  return (
    <svg className={"icon " + className} viewBox="0 0 24 24" aria-hidden="true">
      <path d={paths[name] || paths.bots} />
    </svg>
  );
}
export const fmt = (n: number | null | undefined) =>
  n == null ? "—" : Number(n).toLocaleString("en-US");
export function compact(n: number | null | undefined) {
  return n == null
    ? "—"
    : n >= 1e6
      ? (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M"
      : n >= 1e3
        ? Math.round(n / 1e3) + "K"
        : String(n);
}
export function date(
  n: number | null | undefined,
  options: Intl.DateTimeFormatOptions = {},
) {
  return n == null
    ? "—"
    : new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        ...options,
      }).format(n);
}
export function Status({ bot }: { bot: PublicBot }) {
  const labels: Record<string, string> = {
    running: "运行中",
    stopped: "已停止",
    starting: "启动中",
    stopping: "停止中",
    error: "异常",
    unknown: "状态未知",
  };
  return (
    <span
      className={"status-badge " + (bot.state === "running" ? "" : "stopped")}
      title={bot.error}
    >
      <i className={"status-dot " + (bot.state === "running" ? "" : "off")} />
      {labels[bot.state] || bot.state}
    </span>
  );
}
export function Avatar({
  bot,
  small = false,
  index = 0,
}: {
  bot: PublicBot;
  small?: boolean;
  index?: number;
}) {
  return (
    <span
      className={
        (small ? "small-avatar" : "bot-avatar") + (index % 2 ? "" : " teal")
      }
    >
      {bot.name.slice(0, 1).toUpperCase()}
    </span>
  );
}
export function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="notice">
      <Icon name="info" />
      <span>{children}</span>
    </div>
  );
}
export function Empty({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <div>
        <Icon name="bots" />
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}
export function ErrorBox({
  error,
  retry,
}: {
  error: string;
  retry?: () => void;
}) {
  return (
    <div className="error-banner" role="alert">
      <Icon name="info" />
      <span>{error}</span>
      {retry && (
        <button className="btn" onClick={retry}>
          重试
        </button>
      )}
    </div>
  );
}
