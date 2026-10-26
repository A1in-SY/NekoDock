import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ConsoleEvent,
  ConversationUpdate,
  ConversationView,
  PublicBot,
} from "../../src/console/contracts";
import { api, errorText } from "./api";
import { conversationActivity, conversationDisplay, mergeConversationUpdate, mergeLatestConversation, mergeOlderConversation } from "./conversation-state";
import { compact, date, ErrorBox, fmt, Icon } from "./ui";

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) => (typeof value === "string" ? value : "");
const count = (value: number | null | undefined) =>
  value == null ? "—" : fmt(value) + " tok";
export function Conversation({ bot }: { bot: PublicBot }) {
  const [view, setView] = useState<ConversationView | null>(null);
  const [loading, setLoading] = useState(true);
  const [older, setOlder] = useState(false);
  const [error, setError] = useState("");
  const [streamError, setStreamError] = useState("");
  const [reload, setReload] = useState(0);
  const request = useRef(0);
  const current = useRef<ConversationView | null>(null);
  const olderRequest = useRef<AbortController | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  useEffect(() => {
    const generation = ++request.current;
    const controller = new AbortController();
    let events: EventSource | null = null;
    let active = true;
    setLoading(true);
    setOlder(false);
    setError("");
    setStreamError("");
    const connect = async () => {
      try {
        const next = await api<ConversationView | null>(
          "/api/bots/" + encodeURIComponent(bot.id) + "/conversation?limit=100",
          { signal: controller.signal },
        );
        if (!active) return;
        current.current = mergeLatestConversation(current.current, next);
        setView(current.current);
        setLoading(false);
        let cursor = next?.cursor ?? 0;
        events = new EventSource(
          "/api/bots/" + encodeURIComponent(bot.id) + "/conversation/stream?after=" + cursor,
        );
        events.addEventListener("conversation", (event) => {
          if (!active) return;
          try {
            const update = JSON.parse((event as MessageEvent<string>).data) as ConversationUpdate;
            if (!Number.isSafeInteger(update.cursor) || update.cursor < 0 || (!update.reset && update.cursor < cursor)) return;
            if (update.view && current.current?.id !== update.view.id) atBottom.current = true;
            cursor = update.cursor;
            current.current = mergeConversationUpdate(current.current, update);
            setView(current.current);
            setStreamError("");
          } catch {
            setStreamError("会话更新无法读取，请重新连接。");
          }
        });
        events.onopen = () => { if (active) setStreamError(""); };
        events.onerror = () => {
          if (active) setStreamError("实时连接已断开，正在重新连接…");
        };
      } catch (error) {
        if (active) { setError(errorText(error)); setLoading(false); }
      }
    };
    void connect();
    return () => {
      active = false;
      if (request.current === generation) ++request.current;
      controller.abort();
      olderRequest.current?.abort();
      olderRequest.current = null;
      events?.close();
    };
  }, [bot.id, reload]);
  useEffect(() => {
    if (atBottom.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [view]);
  const loadOlder = async () => {
    const cursor = current.current?.nextBefore;
    if (cursor == null || olderRequest.current) return;
    const generation = request.current;
    const controller = new AbortController();
    olderRequest.current = controller;
    setOlder(true);
    const container = scroll.current,
      previousHeight = container?.scrollHeight || 0;
    try {
      const next = await api<ConversationView | null>(
        "/api/bots/" + encodeURIComponent(bot.id) + "/conversation?before=" + cursor + "&limit=100",
        { signal: controller.signal },
      );
      if (generation !== request.current || controller.signal.aborted) return;
      if (next && next.id === current.current?.id) {
        current.current = mergeOlderConversation(current.current, next);
        setView(current.current);
        atBottom.current = false;
        requestAnimationFrame(() => {
          if (container && generation === request.current)
            container.scrollTop += container.scrollHeight - previousHeight;
        });
      }
    } catch (error) {
      if (generation === request.current && !controller.signal.aborted) setError(errorText(error));
    } finally {
      if (olderRequest.current === controller) olderRequest.current = null;
      if (generation === request.current) setOlder(false);
    }
  };
  const display = useMemo(() => conversationDisplay(view), [view]);
  const activity = conversationActivity(view, bot.processing);
  const u = view?.usage;
  const input = u?.input ?? null,
    cached = u?.cached ?? null,
    output = u?.output ?? null;
  const total =
    u?.total ?? (input != null && output != null ? input + output : null);
  const hit =
    input != null && input > 0 && cached != null
      ? Math.round((cached / input) * 100) + "%"
      : "—";
  const uncached =
    input != null && cached != null ? Math.max(input - cached, 0) : null;
  const context = view?.context,
    used = context?.used ?? null,
    window = context?.window ?? bot.config.contextWindow ?? null,
    limit = context?.compactLimit ?? bot.config.compactLimit ?? null;
  const percent =
    used != null && window != null && window > 0
      ? Math.round((used / window) * 100)
      : null;
  useEffect(() => {
    const close = (event: Event) =>
      document
        .querySelectorAll<HTMLDetailsElement>(".usage-popover[open]")
        .forEach((pop) => {
          if (!pop.contains(event.target as Node)) pop.open = false;
        });
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape")
        document
          .querySelectorAll<HTMLDetailsElement>(".usage-popover[open]")
          .forEach((pop) => (pop.open = false));
    };
    document.addEventListener("click", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", escape);
    };
  }, []);
  return (
    <section className="conversation-view">
      <header className="conversation-toolbar">
        <span className="conversation-model">
          <Icon name="spark" />
          <span>{bot.config.model || "未配置模型"}</span>
          <span className="reasoning-label">
            {bot.config.supportsReasoning ? bot.config.reasoning || "default" : ""}
          </span>
        </span>
        <div className="conversation-actions">
          <details className="token-popover usage-popover">
            <summary className="usage-trigger" aria-label="Token 用量">
              <Icon name="database" />
              <span>{compact(total)} tok</span>
              <span className="token-hit-summary">· 缓存命中 {hit}</span>
            </summary>
            <div className="token-popup usage-popup">
              <div className="token-popup-title">
                <span>
                  <Icon name="database" />
                  Token 用量
                </span>
                <strong>{count(total)}</strong>
              </div>
              <dl>
                <div>
                  <dt>缓存命中</dt>
                  <dd>{hit}</dd>
                </div>
                <div>
                  <dt>未缓存输入</dt>
                  <dd>{count(uncached)}</dd>
                </div>
                <div>
                  <dt>缓存读取</dt>
                  <dd>{count(cached)}</dd>
                </div>
                <div>
                  <dt>输出</dt>
                  <dd>{count(output)}</dd>
                </div>
              </dl>
              <p>当前会话累计用量；未上报的数据以 — 显示。</p>
            </div>
          </details>
          <details className="context-popover usage-popover">
            <summary className="usage-trigger" aria-label="上下文用量">
              <svg
                viewBox="0 0 24 24"
                className="context-ring"
                aria-hidden="true"
              >
                <circle
                  cx="12"
                  cy="12"
                  r="9"
                  fill="none"
                  stroke="#e8ece9"
                  strokeWidth="2.5"
                />
                <circle
                  cx="12"
                  cy="12"
                  r="9"
                  fill="none"
                  stroke="#83a28b"
                  strokeWidth="2.5"
                  strokeDasharray={
                    Math.min(percent ?? 0, 100) * 0.5655 + " 56.55"
                  }
                  transform="rotate(-90 12 12)"
                />
              </svg>
              上下文 {percent == null ? "—" : percent + "%"}
            </summary>
            <div className="context-popup usage-popup">
              <strong>上下文用量</strong>
              <div className="context-label">
                <span>{count(used)}</span>
                <span>{percent == null ? "—" : percent + "%"}</span>
              </div>
              <div className="context-bar">
                <span style={{ width: Math.min(percent ?? 0, 100) + "%" }} />
              </div>
              <div className="context-label">
                <span>窗口</span>
                <span>{count(window)}</span>
              </div>
              <div className="context-caption">
                {limit == null
                  ? "自动压缩阈值跟随模型默认。"
                  : `达到 ${fmt(limit)} tokens 时自动压缩。`}
                {used == null && " 当前执行器未提供上下文占用。"}
                {context?.estimated && " 当前占用为估算值。"}
              </div>
            </div>
          </details>
        </div>
      </header>
      {(error || streamError) && <ErrorBox error={error || streamError} retry={() => setReload((value) => value + 1)} />}
      <div
        className="conversation-scroll"
        ref={scroll}
        onScroll={() => {
          const el = scroll.current;
          if (el)
            atBottom.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <div className="conversation-stream">
          {view?.nextBefore != null && (
            <div className="history-control">
              <button
                className="btn"
                disabled={older}
                onClick={() => void loadOlder()}
              >
                {older ? "加载中…" : "加载更早消息"}
              </button>
            </div>
          )}
          {loading ? (
            <div className="conversation-empty">
              <p>正在加载当前会话…</p>
            </div>
          ) : !display.length ? (
            <div className="conversation-empty">
              <h2>对话从这里开始</h2>
              <p>等待绑定的 QQ 会话发来第一条消息。</p>
            </div>
          ) : (
            display.map((item) => (
              <EventItem key={item.type === "thinking.updated" ? "thinking:" + (item.runId ?? item.itemId ?? item.seq) : item.seq} event={item} botId={bot.id} />
            ))
          )}
          {activity && <ActiveExecution kind={activity.kind} startedAt={activity.startedAt} />}
        </div>
      </div>
      <footer className="conversation-footer">
        <span>
          <Icon name="eye" />
          只读会话
        </span>
        <span>
          {view ? "开始于 " + date(view.startedAt) : "等待会话"} · UTC+08:00
        </span>
      </footer>
    </section>
  );
}
function ActiveExecution({ kind, startedAt }: { kind: "run" | "compact"; startedAt: number | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const seconds = startedAt === null ? null : Math.max(0, Math.floor((now - startedAt) / 1000));
  return <div className="conversation-tool" role="status"><summary><Icon name="clock" />
    <span>{kind === "compact" ? "正在压缩上下文" : "正在处理"}</span>
    {seconds !== null && <time>已用时 {seconds >= 60 ? Math.floor(seconds / 60) + " 分 " : ""}{seconds % 60} 秒</time>}
  </summary></div>;
}
function EventItem({ event, botId }: { event: ConsoleEvent; botId: string }) {
  const p = event.payload;
  if (event.type === "thinking.updated")
    return (
      <details className="conversation-tool conversation-thinking">
        <summary>
          <Icon name="chevron" className="chevron" />
          <Icon name="spark" />
          <span>{p.status === "in_progress" ? "思考中" : "思考过程"}</span>
          {p.status === "failed" && <time>已结束</time>}
        </summary>
        <pre>{text(p.text)}{p.truncated === true ? "\n\n（内容已截断）" : ""}</pre>
      </details>
    );
  if (event.type === "message.received" || event.type === "incoming")
    return (
      <article className="conversation-message from-user">
        <div className="conversation-author">
          {text(p.senderName) || text(p.senderId) || "QQ 用户"}
          <time>{date(typeof p.time === "number" ? p.time : event.time)}</time>
        </div>
        <div className="conversation-text">
          {text(p.text) || "（非文字消息）"}
        </div>
      </article>
    );
  if (event.type === "reply.accepted")
    return <AcceptedReply payload={p} botId={botId} />;
  if (event.type === "run.failed" || event.type === "compact.failed") {
    const detail = text(p.error) || (event.type === "compact.failed"
      ? p.aborted ? "上下文压缩已中止，可在实例日志查看详细信息。" : "上下文压缩未完成，可在实例日志查看详细信息。"
      : text(p.reason) || "本次执行已结束，可在实例日志查看详细信息。");
    return <details className="conversation-tool"><summary><Icon name="chevron" className="chevron" /><Icon name="info" />
      <span>{event.type === "compact.failed" ? "上下文压缩失败" : "本轮处理失败"}</span><time>{date(event.time)}</time>
    </summary><pre>{detail}</pre></details>;
  }
  const tool = text(p.tool) || text(p.toolType) || "工具调用";
  const running = event.type === "tool.started";
  const description = text(p.command) || text(p.server);
  const duration =
    typeof p.startedAt === "number"
      ? Math.max(0, event.time - p.startedAt)
      : null;
  return (
    <details className="conversation-tool">
      <summary>
        <Icon name="chevron" className="chevron" />
        <Icon
          name={running ? "clock" : p.status === "failed" ? "info" : "check"}
        />
        <span className="mono">{tool}</span>
        <span className="tool-description">{description}</span>
        <time>
          {running
            ? "执行中"
            : duration == null
              ? text(p.status) === "failed"
                ? "失败"
                : "完成"
              : duration < 1000
                ? duration + " ms"
                : (duration / 1000).toFixed(1) + " s"}
        </time>
      </summary>
      <pre>
        {p.command !== undefined
          ? "命令\n" + stringify(p.command) + "\n\n"
          : ""}
        {p.arguments !== undefined
          ? "输入\n" + stringify(p.arguments) + "\n\n"
          : ""}
        {p.result !== undefined
          ? "结果\n" + stringify(p.result)
          : running
            ? "等待工具返回结果…"
            : "未提供详细结果。"}
        {p.exitCode !== undefined ? "\n\n退出码 " + String(p.exitCode) : ""}
      </pre>
    </details>
  );
}
function AcceptedReply({
  payload,
  botId,
}: {
  payload: Record<string, unknown>;
  botId: string;
}) {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const deliveries = (
    Array.isArray(payload.deliveries) ? payload.deliveries : []
  ).map(object);
  let imageIndex = 0;
  const images = deliveries.filter((d) => d.kind === "image");
  const unusedVoice = deliveries.filter(
    (d) => d.kind === "voice" && typeof d.logicalMessageIndex !== "number",
  );
  return (
    <>
      {messages.map((value, index) => {
        const message = object(value);
        const attached = deliveries.filter(
          (d) => d.logicalMessageIndex === index,
        );
        const image =
          message.type === "image"
            ? attached.find((d) => d.kind === "image") || images[imageIndex++]
            : undefined;
        const voices = attached.filter((d) => d.kind === "voice");
        return (
          <article key={index} className="conversation-message from-assistant">
            <div className="conversation-text">
              <ReplyBody
                message={
                  image
                    ? { ...message, url: mediaUrl(botId, image.mediaPath) }
                    : value
                }
                botId={botId}
              />
              {voices.map((voice, i) => (
                <audio
                  key={i}
                  controls
                  src={mediaUrl(botId, voice.mediaPath)}
                />
              ))}
            </div>
          </article>
        );
      })}
      {unusedVoice.length > 0 && (
        <div className="reply-audio-attachments">
          {unusedVoice.map((voice, i) => (
            <audio key={i} controls src={mediaUrl(botId, voice.mediaPath)} />
          ))}
        </div>
      )}
    </>
  );
}
function mediaUrl(botId: string, path: unknown) {
  return typeof path === "string"
    ? "/api/bots/" +
        encodeURIComponent(botId) +
        "/media?path=" +
        encodeURIComponent(path)
    : undefined;
}
function stringify(value: unknown) {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
function safeMedia(value: unknown) {
  if (typeof value !== "string") return null;
  if (value.startsWith("/api/")) return value;
  return null;
}
function ReplyBody({ message, botId }: { message: unknown; botId: string }) {
  const m = object(message);
  if (typeof message === "string") return <>{message}</>;
  if (m.type === "text") return <>{text(m.text)}</>;
  if (m.type === "message" && Array.isArray(m.segments))
    return (
      <>
        {m.segments.map((s, i) => {
          const segment = object(s);
          return segment.type === "at" ? (
            <span className="mention" key={i}>
              @{text(segment.userId)}
            </span>
          ) : (
            <span key={i}>{text(segment.text)}</span>
          );
        })}
      </>
    );
  if (m.type === "image" || m.type === "voice") {
    const src =
      safeMedia(m.url) ||
      safeMedia(m.mediaUrl) ||
      (typeof m.mediaId === "string"
        ? "/api/bots/" +
          encodeURIComponent(botId) +
          "/media/" +
          encodeURIComponent(m.mediaId)
        : null);
    if (src)
      return m.type === "image" ? (
        <a href={src} target="_blank" rel="noreferrer">
          <img
            className="conversation-image"
            src={src}
            alt="Bot 发送的图片"
            loading="lazy"
          />
        </a>
      ) : (
        <>
          <audio controls src={src} />
          {m.text && <p className="voice-transcript">{text(m.text)}</p>}
        </>
      );
    return (
      <div className="attachment-placeholder">
        <Icon name={m.type === "image" ? "document" : "mic"} />
        {m.type === "image" ? "图片" : "语音"}
        <span>
          {text(m.text) || text(m.path).split("/").pop() || "附件记录"}
        </span>
      </div>
    );
  }
  return null;
}
