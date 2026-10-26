import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { FormEvent, ReactNode } from "react";
import type { BotSettings, PublicBot } from "../../src/console/contracts";
import { api, errorText, post } from "./api";
import { Avatar, Empty, ErrorBox, fmt, Icon, Notice, Status } from "./ui";
import { Configuration } from "./config";
import { Conversation } from "./conversation";
import { Logs } from "./logs";
const Monitor = lazy(() =>
  import("./monitor").then((module) => ({ default: module.Monitor })),
);

class MonitorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <ErrorBox
        error="监控页面未能加载。若控制台刚完成更新，请刷新页面后重试。"
        retry={() => location.reload()}
      />
    ) : (
      this.props.children
    );
  }
}

type Route = {
  page: "overview" | "monitor" | "logs" | "bot";
  id?: string;
  tab: "chat" | "config" | "logs";
};
function route(): Route {
  const p = location.hash.slice(1).split("/");
  return {
    page:
      p[0] === "monitor"
        ? "monitor"
        : p[0] === "logs"
          ? "logs"
          : p[0] === "bot"
            ? "bot"
            : "overview",
    id: p[1],
    tab: p[2] === "config" ? "config" : p[2] === "logs" ? "logs" : "chat",
  };
}
const botUrl = (bot: PublicBot, tab = "chat") =>
  "#bot/" + encodeURIComponent(bot.id) + "/" + tab;
export function App() {
  const [auth, setAuth] = useState<"loading" | "setup" | "login" | "ready">(
    "loading",
  );
  const [authError, setAuthError] = useState("");
  const [bots, setBots] = useState<PublicBot[]>([]);
  const [loadError, setLoadError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [current, setCurrent] = useState<Route>(route);
  const [creating, setCreating] = useState(false);
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(
    null,
  );
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [streamOnline, setStreamOnline] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );
  const notify = useCallback((text: string, error = false) => {
    setToast({ text, error });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4500);
  }, []);
  const loadBots = useCallback(async () => {
    try {
      const data = await api<PublicBot[]>("/api/bots");
      if (alive.current) {
        setBots(data);
        setLoadError("");
        setLoaded(true);
      }
    } catch (error) {
      if (alive.current) {
        setLoadError(errorText(error));
        setLoaded(true);
      }
    }
  }, []);
  useEffect(() => {
    let active = true;
    const run = async () => {
      try {
        const setup = await api<{ needsSetup: boolean }>("/api/setup");
        if (!active) return;
        if (setup.needsSetup) {
          setAuth("setup");
          return;
        }
        try {
          await api("/api/session");
          if (active) setAuth("ready");
        } catch {
          if (active) setAuth("login");
        }
      } catch (error) {
        if (active) setAuthError(errorText(error));
      }
    };
    void run();
    const expired = () => {
      setAuth("login");
      setBots([]);
      setLoaded(false);
    };
    window.addEventListener("session-expired", expired);
    return () => {
      active = false;
      window.removeEventListener("session-expired", expired);
    };
  }, []);
  useEffect(() => {
    const change = () => setCurrent(route());
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  useEffect(() => {
    if (auth !== "ready") return;
    void loadBots();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const events = new EventSource("/api/stream");
    const refresh = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void loadBots();
      }, 350);
    };
    events.addEventListener("change", refresh);
    events.onopen = () => setStreamOnline(true);
    events.onerror = () => setStreamOnline(false);
    return () => {
      events.close();
      setStreamOnline(false);
      if (timer) clearTimeout(timer);
    };
  }, [auth, loadBots]);
  const act = async (bot: PublicBot, action: "start" | "stop" | "restart") => {
    setPending((p) => new Set(p).add(bot.id));
    try {
      await post("/api/bots/" + encodeURIComponent(bot.id) + "/" + action);
      notify(
        action === "start"
          ? "启动请求已接受"
          : action === "stop"
            ? "停止请求已接受；等待当前处理结束"
            : "重启请求已接受；等待当前处理结束",
      );
      await loadBots();
    } catch (error) {
      notify(errorText(error), true);
    } finally {
      setPending((p) => {
        const next = new Set(p);
        next.delete(bot.id);
        return next;
      });
    }
  };
  const logout = async () => {
    try {
      await post("/api/logout");
      setAuth("login");
      setBots([]);
      setLoaded(false);
    } catch (error) {
      notify(errorText(error), true);
    }
  };
  if (auth !== "ready")
    return (
      <Login
        mode={auth}
        error={authError}
        onReady={() => {
          setAuth("ready");
          setAuthError("");
        }}
        onRetry={() => location.reload()}
      />
    );
  const bot = bots.find((b) => b.id === current.id);
  const running = bots.filter((b) => b.state === "running").length;
  const selected = bots.filter(
    (b) =>
      (b.name + " " + b.targetId)
        .toLowerCase()
        .includes(search.toLowerCase()) &&
      (filter === "all" ||
        (filter === "running" ? b.state === "running" : b.state === "stopped")),
  );
  return (
    <>
      <div className="app-shell">
        <aside className="sidebar">
          <a className="brand" href="#overview" aria-label="NekoDock 实例总览">
            <div className="brand-mark">
              <Icon name="cat" />
            </div>
            <div>
              <div className="brand-name">
                NekoDock<span style={{ color: "#85a38e" }}>.</span>
              </div>
              <div className="brand-caption">猫坞 · BOT CONSOLE</div>
            </div>
          </a>
          <div className="sidebar-label">控制台</div>
          <a
            className={
              "nav-item " + (current.page === "overview" ? "active" : "")
            }
            href="#overview"
            title="实例总览"
          >
            <Icon name="grid" />
            <span className="nav-label">实例总览</span>
            <span className="count">{bots.length}</span>
          </a>
          <a
            className={
              "nav-item " + (current.page === "monitor" ? "active" : "")
            }
            href="#monitor"
            title="监控"
          >
            <Icon name="activity" />
            <span className="nav-label">监控</span>
          </a>
          <a
            className={"nav-item " + (current.page === "logs" ? "active" : "")}
            href="#logs"
            title="后端日志"
          >
            <Icon name="document" />
            <span className="nav-label">后端日志</span>
          </a>
          <hr className="nav-divider" />
          <div className="sidebar-label">BOT 实例</div>
          {bots.map((b) => (
            <a
              key={b.id}
              href={botUrl(b)}
              className={
                "nav-item bot-nav " + (bot?.id === b.id ? "active" : "")
              }
              title={b.name}
            >
              <span className="nav-label">{b.name}</span>
              <i
                className={"status-dot " + (b.state === "running" ? "" : "off")}
              />
            </a>
          ))}
          <button
            className="nav-item sidebar-add"
            onClick={() => setCreating(true)}
            title="创建新实例"
          >
            <Icon name="plus" />
            <span>创建新实例</span>
          </button>
          <div className="sidebar-footer">
            <div
              className="sidebar-connection"
              role="status"
              title={streamOnline ? "实时连接" : "重新连接中"}
            >
              <i className={"status-dot " + (streamOnline ? "" : "off")} />
              <span className="sidebar-connection-label">
                {streamOnline ? "实时连接" : "重新连接中"}
              </span>
            </div>
            <button
              className="sidebar-logout"
              type="button"
              onClick={() => void logout()}
              title="退出登录"
              aria-label="退出登录"
            >
              <Icon name="logout" />
            </button>
          </div>
        </aside>
        <main
          className={
            "content " +
            (current.page === "bot" && current.tab === "chat"
              ? "conversation-content"
              : current.page === "logs" || (current.page === "bot" && current.tab === "logs")
                ? "logs-content"
              : "")
          }
        >
          {loadError && (
            <ErrorBox error={loadError} retry={() => void loadBots()} />
          )}
          {current.page === "overview" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow" style={{ marginBottom: 6 }}>
                    BOT INSTANCES
                  </div>
                  <h1>实例总览</h1>
                  <p>管理在线实例，查看今天收到和回复的消息。</p>
                </div>
                <div className="heading-actions">
                  <button className="btn" onClick={() => void loadBots()}>
                    <Icon name="refresh" />
                    刷新状态
                  </button>
                  <button
                    className="btn primary"
                    onClick={() => setCreating(true)}
                  >
                    <Icon name="plus" />
                    创建实例
                  </button>
                </div>
              </div>
              <div className="stats-grid">
                <Stat
                  title="在线实例"
                  icon="bots"
                  value={
                    <>
                      {running}
                      <small>/ {bots.length}</small>
                    </>
                  }
                  bottom={
                    bots.length
                      ? running === bots.length
                        ? "所有实例运行正常"
                        : "部分实例已停止"
                      : "创建第一个 Bot 开始聊天"
                  }
                />
                <Stat
                  title="今日收到消息"
                  icon="chat"
                  value={fmt(
                    bots.reduce((n, b) => n + b.statistics.todayMessages, 0),
                  )}
                  bottom={
                    <>
                      <span className="stat-history-label">历史收到消息</span>
                      <strong className="stat-history-value">
                        {fmt(
                          bots.reduce(
                            (n, b) => n + b.statistics.totalMessages,
                            0,
                          ),
                        )}
                      </strong>
                    </>
                  }
                />
                <Stat
                  title="今日回复消息"
                  icon="send"
                  value={fmt(
                    bots.reduce((n, b) => n + b.statistics.todayReplies, 0),
                  )}
                  bottom={
                    <>
                      <span className="stat-history-label">历史回复消息</span>
                      <strong
                        className="stat-history-value"
                        title="导入实例按接管后的实际确认发送量累计"
                      >
                        {fmt(
                          bots.reduce(
                            (n, b) => n + b.statistics.totalReplies,
                            0,
                          ),
                        )}
                      </strong>
                    </>
                  }
                />
              </div>
              <div className="section-heading">
                <h2>
                  我的实例 <span className="number-pill">{bots.length}</span>
                </h2>
                <div className="filters">
                  <div className="search-input">
                    <Icon name="search" />
                    <input
                      type="search"
                      aria-label="搜索实例"
                      placeholder="搜索实例名称…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </div>
                  <select
                    className="filter-select"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    aria-label="按运行状态筛选"
                  >
                    <option value="all">全部状态</option>
                    <option value="running">运行中</option>
                    <option value="stopped">已停止</option>
                  </select>
                </div>
              </div>
              <div className="bots-grid">
                {!loaded ? (
                  <Empty title="正在加载实例…" />
                ) : !bots.length ? (
                  <Empty title="创建你的第一个 Bot">
                    <p>填写名称和绑定会话，即可从默认配置开始。</p>
                    <button
                      className="btn primary"
                      onClick={() => setCreating(true)}
                    >
                      <Icon name="plus" />
                      创建第一个实例
                    </button>
                  </Empty>
                ) : !selected.length ? (
                  <Empty title="没有找到实例">
                    <p>试试其他名称、群号，或调整状态筛选。</p>
                    <button
                      className="btn"
                      onClick={() => {
                        setSearch("");
                        setFilter("all");
                      }}
                    >
                      清除筛选
                    </button>
                  </Empty>
                ) : (
                  selected.map((b, index) => (
                    <BotCard
                      key={b.id}
                      bot={b}
                      index={index}
                      pending={pending.has(b.id)}
                      act={act}
                    />
                  ))
                )}
              </div>
              <div className="bottom-note">
                <span>
                  <Icon name="shield" />
                  配置集中管理，每个实例独立运行。
                </span>
                <span>时间与统计按 UTC+08:00 展示</span>
              </div>
            </>
          )}
          {current.page === "monitor" && (
            <MonitorBoundary>
              <Suspense fallback={<Empty title="正在加载监控…" />}>
                <Monitor bots={bots} />
              </Suspense>
            </MonitorBoundary>
          )}
          {current.page === "logs" && (
            <>
              <div className="page-heading">
                <div>
                  <h1>后端日志</h1>
                  <p>查看 Web 控制台后端的运行日志。</p>
                </div>
              </div>
              <Logs key="console" />
            </>
          )}
          {current.page === "bot" &&
            (bot ? (
              <>
                <div className="page-heading detail-heading">
                  <div className="detail-identity">
                    <div>
                      <h1>
                        {bot.name} <Status bot={bot} />
                      </h1>
                      <p>
                        {bot.targetType === "group" ? "QQ 群聊" : "QQ 私聊"} ·{" "}
                        <span className="mono">{bot.targetId}</span>
                      </p>
                    </div>
                  </div>
                  <div className="heading-actions">
                    <button
                      className="btn"
                      disabled={pending.has(bot.id) || bot.state !== "running"}
                      onClick={() => void act(bot, "restart")}
                    >
                      <Icon name="refresh" />
                      重启实例
                    </button>
                    <button
                      className={
                        "btn " +
                        (bot.desiredState === "running" ? "" : "primary")
                      }
                      disabled={pending.has(bot.id)}
                      onClick={() =>
                        void act(
                          bot,
                          bot.desiredState === "running" ? "stop" : "start",
                        )
                      }
                    >
                      <Icon
                        name={
                          bot.desiredState === "running" ? "square" : "play"
                        }
                      />
                      {pending.has(bot.id)
                        ? "请求中…"
                        : bot.desiredState === "running"
                          ? "停止"
                          : "启动"}
                    </button>
                  </div>
                </div>
                <nav className="detail-tabs" aria-label="实例页面">
                  {(
                    [
                      ["chat", "chat", "当前会话"],
                      ["config", "sliders", "实例配置"],
                      ["logs", "document", "日志"],
                    ] as const
                  ).map(([tab, icon, label]) => (
                    <a
                      key={tab}
                      className={current.tab === tab ? "active" : ""}
                      href={botUrl(bot, tab)}
                    >
                      <Icon name={icon} />
                      {label}
                    </a>
                  ))}
                </nav>
                {bot.error && <ErrorBox error={bot.error} />}{" "}
                {bot.state === "stopped" && (
                  <div className="stopped-banner">
                    <Icon name="info" />
                    实例已停止，以下展示保留的会话、配置和容器日志。
                  </div>
                )}
                {current.tab === "config" ? (
                  <Configuration
                    key={bot.id}
                    bot={bot}
                    onSaved={async (updated) => {
                      setBots((all) =>
                        all.map((b) => (b.id === updated.id ? updated : b)),
                      );
                      notify("配置已保存；将在安全切换点生效");
                    }}
                    notify={notify}
                  />
                ) : current.tab === "logs" ? (
                  <Logs key={bot.id} botId={bot.id} />
                ) : (
                  <Conversation
                    key={bot.id}
                    bot={bot}
                  />
                )}
              </>
            ) : (
              <Empty title={loaded ? "实例不存在" : "正在加载实例…"}>
                <a className="btn" href="#overview">
                  返回实例总览
                </a>
              </Empty>
            ))}
        </main>
      </div>
      {creating && (
        <CreateDrawer
          bots={bots}
          onClose={() => setCreating(false)}
          onCreated={(bot) => {
            setBots((all) => [...all, bot]);
            setCreating(false);
            location.hash = botUrl(bot, "config");
            notify("实例已创建；完成配置后可启动");
          }}
        />
      )}
      {toast && (
        <div className={"toast " + (toast.error ? "error" : "")} role="status">
          <Icon name={toast.error ? "info" : "check"} />
          {toast.text}
        </div>
      )}
    </>
  );
}
function Stat({
  title,
  value,
  icon,
  bottom,
}: {
  title: string;
  value: React.ReactNode;
  icon: string;
  bottom: React.ReactNode;
}) {
  return (
    <section className="panel stat-card">
      <div className="stat-top">
        {title}
        <span className="stat-icon">
          <Icon name={icon} />
        </span>
      </div>
      <div className="stat-value">{value}</div>
      <div className="stat-bottom">{bottom}</div>
    </section>
  );
}
function BotCard({
  bot: b,
  index,
  pending,
  act,
}: {
  bot: PublicBot;
  index: number;
  pending: boolean;
  act: (b: PublicBot, a: "start" | "stop" | "restart") => Promise<void>;
}) {
  return (
    <article className="panel bot-card">
      <div className="bot-card-head">
        <Avatar bot={b} index={index} />
        <div>
          <a className="bot-title" href={botUrl(b)}>
            {b.name}
          </a>
          <div className="bot-subtitle">
            <Icon name={b.targetType === "group" ? "users" : "user"} />
            {b.targetType === "group" ? "群聊" : "私聊"} ·{" "}
            <span className="mono">{b.targetId}</span>
          </div>
        </div>
        <div style={{ marginLeft: "auto" }}>
          <Status bot={b} />
        </div>
      </div>
      <div className="card-meta">
        <div>
          <span className="meta-label">当前模型</span>
          <div className="meta-value" title={b.config.model}>
            <span className="model-tag">
              API
            </span>
            {b.config.model || "未配置模型"}
          </div>
        </div>
        <div>
          <span className="meta-label">普通消息回复概率</span>
          <div className="meta-value">
            {b.targetType === "group"
              ? Math.round(b.config.replyProbability) + "%"
              : "私聊正常回复"}{" "}
            <span className="muted" style={{ fontSize: 9 }}>
              {b.targetType === "group" ? "· 被 @ 时必回" : ""}
            </span>
          </div>
        </div>
      </div>
      <div className="feature-chips">
        <span className="feature-chip">
          <Icon name="spark" />
          {b.config.persona ? "自定义人格" : "默认人格"}
        </span>
        <span
          className={
            "feature-chip " +
            (b.config.searchProvider !== "none" ? "enabled" : "")
          }
        >
          <Icon name="globe" />
          {b.config.searchProvider === "tavily" ? "Tavily 搜索" : "搜索已关闭"}
        </span>
        <span
          className={"feature-chip " + (b.config.voiceEnabled ? "enabled" : "")}
        >
          <Icon name={b.config.voiceEnabled ? "mic" : "mute"} />
          {b.config.voiceEnabled
            ? b.config.ttsProvider === "mimo"
              ? "MiMo 语音"
              : "Edge 语音"
            : "纯文字回复"}
        </span>
      </div>
      <div className="card-resources">
        <span className="resource-item">
          <Icon name="chat" />
          今日收到 <b>{fmt(b.statistics.todayMessages)}</b>
        </span>
        <span
          className="resource-item"
          title={
            "回复自 " +
            new Date(b.statistics.replyCountSince).toLocaleString("zh-CN") +
            " 起累计"
          }
        >
          <Icon name="send" />
          回复 <b>{fmt(b.statistics.todayReplies)}</b>
        </span>
        <span className="resource-item">
          <i className={"status-dot " + (b.state === "running" ? "" : "off")} />
          {b.processing
            ? "正在处理"
            : b.state === "running"
              ? b.connected
                ? "等待新消息"
                : "NapCat 未连接"
              : b.state === "stopped"
                ? "已停止"
                : "等待状态更新"}
        </span>
      </div>
      {b.imported && (
        <div className="count-since">回复统计从接管后开始累计</div>
      )}
      <div className="card-footer">
        <a href={botUrl(b)} className="btn conversation-btn">
          <Icon name="chat" />
          查看会话
        </a>
        <a href={botUrl(b, "config")} className="btn">
          <Icon name="sliders" />
          配置
        </a>
        <button
          className="text-action"
          disabled={pending}
          onClick={() =>
            void act(b, b.desiredState === "running" ? "stop" : "start")
          }
        >
          <Icon name={b.desiredState === "running" ? "square" : "play"} />
          {pending ? "请求中" : b.desiredState === "running" ? "停止" : "启动"}
        </button>
      </div>
    </article>
  );
}
function Login({
  mode,
  error,
  onReady,
  onRetry,
}: {
  mode: string;
  error: string;
  onReady: () => void;
  onRetry: () => void;
}) {
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [pending, setPending] = useState(false);
  const [localError, setError] = useState("");
  const setup = mode === "setup";
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if (setup && password !== repeat) {
      setError("两次密码不一致");
      return;
    }
    setPending(true);
    try {
      await post(setup ? "/api/setup" : "/api/login", { password });
      onReady();
    } catch (error) {
      setError(errorText(error));
    } finally {
      setPending(false);
    }
  };
  return (
    <main className="login-page">
      <section className="panel login-card">
        <div className="brand-mark">
          <Icon name="cat" />
        </div>
        <h1>NekoDock · 猫坞</h1>
        <p>
          {mode === "loading"
            ? "正在连接控制台…"
            : setup
              ? "设置管理员密码，开始管理 Bot。"
              : "登录后管理你的 Bot 实例。"}
        </p>
        {error && <ErrorBox error={error} retry={onRetry} />}{" "}
        {mode !== "loading" && (
          <form onSubmit={(e) => void submit(e)}>
            <div className="form-field">
              <label htmlFor="login-password">
                {setup ? "设置密码" : "管理员密码"}
              </label>
              <input
                id="login-password"
                type="password"
                autoComplete={setup ? "new-password" : "current-password"}
                minLength={setup ? 12 : 1}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
              />
              {setup && (
                <small className="field-hint">
                  至少 12 个字符。密码仅用于控制台登录。
                </small>
              )}
            </div>
            {setup && (
              <div className="form-field">
                <label htmlFor="repeat-password">确认密码</label>
                <input
                  id="repeat-password"
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  required
                  value={repeat}
                  onChange={(e) => setRepeat(e.target.value)}
                />
              </div>
            )}
            {localError && (
              <div className="field-error" role="alert">
                {localError}
              </div>
            )}
            <button className="btn primary" disabled={pending}>
              {pending ? "提交中…" : setup ? "设置并登录" : "登录"}
            </button>
          </form>
        )}
      </section>
    </main>
  );
}
function CreateDrawer({
  bots,
  onClose,
  onCreated,
}: {
  bots: PublicBot[];
  onClose: () => void;
  onCreated: (bot: PublicBot) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [targetType, setTargetType] = useState<"group" | "private">("group");
  const [targetId, setTargetId] = useState("");
  const [template, setTemplate] = useState("");
  const [defaults, setDefaults] = useState<BotSettings | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    void api<BotSettings>("/api/defaults")
      .then(setDefaults)
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !pending) onClose();
      if (e.key === "Tab") {
        const inputs = Array.from(
          ref.current?.querySelectorAll<HTMLElement>(
            "button:not(:disabled),input,select,textarea",
          ) || [],
        );
        if (!inputs.length) return;
        if (e.shiftKey && document.activeElement === inputs[0]) {
          e.preventDefault();
          inputs.at(-1)?.focus();
        } else if (!e.shiftKey && document.activeElement === inputs.at(-1)) {
          e.preventDefault();
          inputs[0]?.focus();
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose, pending]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!defaults) return;
    if (!/^[1-9]\d*$/.test(targetId)) {
      setError("请填写有效的群号或 QQ 号");
      return;
    }
    setError("");
    setPending(true);
    try {
      const config = template
        ? bots.find((b) => b.id === template)?.config
        : defaults;
      const result = await post<PublicBot>("/api/bots", {
        name: name.trim(),
        description: description.trim(),
        targetType,
        targetId,
        config,
        ...(template ? { copyFrom: template } : {}),
      });
      onCreated(result);
    } catch (error) {
      setError(errorText(error));
    } finally {
      setPending(false);
    }
  };
  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !pending) onClose();
      }}
    >
      <section
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-title"
        ref={ref}
      >
        <header className="drawer-header">
          <div>
            <h2 id="create-title">创建新实例</h2>
            <p>一个 Bot，一段独立的对话。</p>
          </div>
          <button
            className="icon-btn"
            aria-label="关闭创建窗口"
            disabled={pending}
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </header>
        <form onSubmit={(e) => void submit(e)} style={{ display: "contents" }}>
          <div className="drawer-body">
            <div className="form-grid">
              <div className="form-field full">
                <label htmlFor="create-name">
                  实例名称 <span className="required">*</span>
                </label>
                <input
                  id="create-name"
                  required
                  maxLength={40}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例如 friends、dev-chat"
                  autoFocus
                />
              </div>
              <div className="form-field full">
                <label htmlFor="create-description">备注</label>
                <input
                  id="create-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="这个 Bot 用来做什么？"
                />
              </div>
              <div className="form-field full">
                <label htmlFor="create-type">绑定会话类型</label>
                <select
                  id="create-type"
                  value={targetType}
                  onChange={(e) =>
                    setTargetType(e.target.value as "group" | "private")
                  }
                >
                  <option value="group">QQ 群聊</option>
                  <option value="private">QQ 私聊</option>
                </select>
              </div>
              <div className="form-field full">
                <label htmlFor="create-target">
                  {targetType === "group" ? "QQ 群号" : "对方 QQ 号"}{" "}
                  <span className="required">*</span>
                </label>
                <input
                  id="create-target"
                  required
                  pattern="[1-9][0-9]*"
                  inputMode="numeric"
                  value={targetId}
                  onChange={(e) => setTargetId(e.target.value)}
                  placeholder={
                    targetType === "group"
                      ? "填写要绑定的群号"
                      : "填写对方的 QQ 号"
                  }
                />
                <small className="field-hint">
                  创建后会话类型和目标号码不可更改。
                </small>
              </div>
            </div>
            <hr className="form-divider" />
            <div className="form-field">
              <label htmlFor="create-template">初始配置</label>
              <select
                id="create-template"
                value={template}
                onChange={(e) => setTemplate(e.target.value)}
              >
                <option value="">使用默认配置</option>
                {bots.map((b) => (
                  <option key={b.id} value={b.id}>
                    复制 {b.name} 的配置
                  </option>
                ))}
              </select>
              <small className="field-hint">
                {bots.length
                  ? "默认配置可直接开始，也可复制已有实例后单独修改。"
                  : "使用基础默认值，创建后继续配置模型、连接和人格。"}
              </small>
            </div>
            <Notice>
              新实例拥有独立的配置与空会话。创建后先完成必需配置，再启动实例。
            </Notice>
            {error && (
              <div className="field-error" role="alert">
                {error}
              </div>
            )}
          </div>
          <footer className="drawer-footer">
            <button
              className="btn"
              type="button"
              disabled={pending}
              onClick={onClose}
            >
              取消
            </button>
            <button
              className="btn primary"
              type="submit"
              disabled={pending || !defaults}
            >
              <Icon name="plus" />
              {pending ? "创建中…" : "创建实例"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
