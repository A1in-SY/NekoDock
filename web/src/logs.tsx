import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "./api";
import { filterLogLines, formatLogTime, parseLogSnapshot } from "./logs-state";
import type { LogLevel, LogSnapshot } from "./logs-state";
import { Icon } from "./ui";
import "./logs.css";

type Connection = "connecting" | "connected" | "reconnecting" | "unavailable";
const connectionLabels: Record<Connection, string> = {
  connecting: "正在连接",
  connected: "实时更新",
  reconnecting: "重新连接中",
  unavailable: "暂不可用",
};

export function Logs({ botId }: { botId?: string }) {
  const [snapshot, setSnapshot] = useState<LogSnapshot | null>(null);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [statusMessage, setStatusMessage] = useState("");
  const [search, setSearch] = useState("");
  const [level, setLevel] = useState<LogLevel | "all">("all");
  const [following, setFollowing] = useState(true);
  const list = useRef<HTMLDivElement>(null);
  const listSize = useRef({ width: 0, height: 0 });
  const source = useRef<string | null>(null);
  const visible = useMemo(
    () => filterLogLines(snapshot?.lines ?? [], level, search),
    [snapshot, level, search],
  );

  useEffect(() => {
    let active = true;
    let authChecked = false;
    const controller = new AbortController();
    const events = new EventSource(
      botId ? `/api/bots/${encodeURIComponent(botId)}/logs/stream` : "/api/logs/stream",
    );
    setSnapshot(null);
    setConnection("connecting");
    setStatusMessage("");
    source.current = null;
    events.addEventListener("logs", (event: MessageEvent<string>) => {
      if (!active) return;
      const next = parseLogSnapshot(event.data);
      if (!next) {
        setStatusMessage("日志数据无法读取，等待下一次更新。");
        return;
      }
      if (source.current && source.current !== next.sourceId) setFollowing(true);
      source.current = next.sourceId;
      setSnapshot(next);
      setConnection("connected");
      setStatusMessage("");
    });
    events.addEventListener("status", (event: MessageEvent<string>) => {
      if (!active) return;
      try {
        const status = JSON.parse(event.data) as { state?: string; message?: string };
        if (status.state === "unavailable") {
          setConnection("unavailable");
          setSnapshot(null);
          source.current = null;
          setStatusMessage(typeof status.message === "string" ? status.message : "当前容器日志暂不可用。");
        } else if (status.state === "connected") {
          setConnection("connected");
          setStatusMessage("");
        }
      } catch {
        setStatusMessage("日志状态无法读取，等待下一次更新。");
      }
    });
    events.onopen = () => { authChecked = false; };
    events.onerror = () => {
      if (!active) return;
      setConnection("reconnecting");
      setStatusMessage("连接中断，正在自动重连。已显示的日志保留至连接恢复。");
      if (authChecked) return;
      authChecked = true;
      void api("/api/session", { signal: controller.signal }).catch((error: unknown) => {
        if (active && error instanceof ApiError && error.status === 401) events.close();
      });
    };
    return () => {
      active = false;
      controller.abort();
      events.close();
    };
  }, [botId]);

  useLayoutEffect(() => {
    if (following && list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [snapshot, visible, following]);

  useEffect(() => {
    const element = list.current;
    if (!following || !element) return;
    const observer = new ResizeObserver(() => {
      listSize.current = { width: element.clientWidth, height: element.clientHeight };
      element.scrollTop = element.scrollHeight;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [following]);

  return (
    <section className="logs-panel" aria-label={botId ? "实例日志" : "控制台后端日志"}>
      <header className="logs-toolbar">
        <div className="logs-filters">
          <label className="logs-level">
            <span className="logs-visually-hidden">日志级别</span>
            <select aria-label="日志级别" value={level} onChange={(event) => setLevel(event.target.value as LogLevel | "all")}>
              <option value="all">全部级别</option>
              <option value="error">ERROR</option>
              <option value="warn">WARN</option>
              <option value="info">INFO</option>
              <option value="debug">DEBUG</option>
              <option value="unknown">UNKNOWN</option>
            </select>
            <Icon name="down" />
          </label>
          <label className="logs-search">
            <Icon name="search" />
            <span className="logs-visually-hidden">搜索日志</span>
            <input type="search" value={search} placeholder="搜索日志内容…" onChange={(event) => setSearch(event.target.value)} />
          </label>
        </div>
        <div className="logs-toolbar-right">
          <span className={"logs-connection " + connection} role="status">
            <i className={"status-dot " + (connection === "connected" ? "" : "off")} />
            {connectionLabels[connection]}
          </span>
          <button type="button" className={"btn logs-follow " + (following ? "selected" : "")} aria-pressed={following} onClick={() => setFollowing((value) => !value)}>
            <Icon name="down" />
            {following ? "跟随最新" : "继续跟随"}
          </button>
        </div>
      </header>
      {statusMessage && <p className="logs-status-message" role="status">{statusMessage}</p>}
      <div className="logs-list" ref={list} tabIndex={0} aria-label="日志内容" onScroll={() => {
        const element = list.current;
        if (!element) return;
        const size = { width: element.clientWidth, height: element.clientHeight };
        const resized = size.width !== listSize.current.width || size.height !== listSize.current.height;
        listSize.current = size;
        if (resized) {
          if (following) element.scrollTop = element.scrollHeight;
          return;
        }
        if (element.scrollHeight - element.scrollTop - element.clientHeight > 40) setFollowing(false);
      }}>
        {visible.length ? visible.map((line) => (
          <article className={"log-line level-" + line.level} key={line.id}>
            <time dateTime={line.time} title={line.time}>{formatLogTime(line.time)}</time>
            <span className="log-level" title={line.stream}>{line.level.toUpperCase()}</span>
            <pre>{line.message}</pre>
          </article>
        )) : (
          <div className="logs-empty">
            <Icon name="document" />
            <h2>{connection === "unavailable" ? "暂无可用容器日志" : !snapshot && connection !== "connected" ? "正在连接日志流…" : snapshot?.lines.length ? "没有匹配的日志" : "当前容器暂无日志"}</h2>
            <p>{snapshot?.lines.length ? "调整级别或搜索内容查看其他日志。" : "新日志将在这里自动显示。"}</p>
          </div>
        )}
      </div>
      <footer className="logs-footer">
        <span>{visible.length} / {snapshot?.lines.length ?? 0} 行 · UTC+08:00</span>
        <span>{snapshot?.truncated ? "仅显示最近 500 行" : "最多显示最近 500 行"} · 仅当前容器保留的日志</span>
      </footer>
    </section>
  );
}
