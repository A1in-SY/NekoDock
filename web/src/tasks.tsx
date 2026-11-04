import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { PublicBot } from "../../src/console/contracts";
import type { ScheduledRun, ScheduledTask, ScheduledTaskInput, TaskRunDetail } from "../../src/scheduled-contract";
import { api, errorText, post } from "./api";
import { date, Empty, ErrorBox, Icon, Notice } from "./ui";
import { deliveryLabels, displayLocalTaskTime, mergeTaskRunDetail, newTask, runLabels, taskApplication, taskDetailEvents, taskEditorPayload, taskPayload, taskRunOutcome } from "./tasks-state";
import "./tasks.css";

const taskPath = (botId: string) => `/api/bots/${encodeURIComponent(botId)}/tasks`;
const time = (instant: number | null | undefined, zone: string) => {
  if (instant == null) return "—";
  try { return new Intl.DateTimeFormat("zh-CN", { timeZone: zone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(instant); }
  catch { return date(instant); }
};

export function Tasks({ bot, notify }: { bot: PublicBot; notify: (message: string, error?: boolean) => void }) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [runs, setRuns] = useState<ScheduledRun[]>([]);
  const [runsError, setRunsError] = useState("");
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskRunDetail | null>(null);
  const [detailError, setDetailError] = useState("");
  const [editing, setEditing] = useState<ScheduledTask | "new" | null>(null);
  const [confirmation, setConfirmation] = useState<{ task: ScheduledTask; action: "delete" | "reset-state" | "run" } | null>(null);
  const [pending, setPending] = useState(false);
  const [showDeleted, setShowDeleted] = useState(false);
  const [connected, setConnected] = useState(false);
  const generation = useRef(0);
  const runsGeneration = useRef(0);
  const detailsGeneration = useRef(0);
  const detailRef = useRef<TaskRunDetail | null>(null);
  const detailRequest = useRef<AbortController | null>(null);
  const detailFlight = useRef<{ id: string; promise: Promise<void> } | null>(null);
  const detailDirty = useRef<string | null>(null);
  const selectedTask = tasks.find(task => task.id === selected);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    try { const result = await api<ScheduledTask[]>(taskPath(bot.id)); if (request === generation.current) { setTasks(result); setError(""); setLoaded(true); } }
    catch (error) { if (request === generation.current) { setError(errorText(error)); setLoaded(true); } }
  }, [bot.id]);
  const refreshRuns = useCallback(async () => {
    if (!selected) return;
    const request = ++runsGeneration.current;
    try { const result = await api<ScheduledRun[]>(taskPath(bot.id) + "/" + encodeURIComponent(selected) + "/runs"); if (request === runsGeneration.current) { setRuns(result); setRunsError(""); setHistoryLoaded(true); } }
    catch (error) { if (request === runsGeneration.current) { setRunsError(errorText(error)); setHistoryLoaded(true); } }
  }, [bot.id, selected]);
  const refreshDetail = useCallback((): Promise<void> => {
    if (!runId) return Promise.resolve();
    if (detailFlight.current?.id === runId) { detailDirty.current = runId; return detailFlight.current.promise; }
    const request = ++detailsGeneration.current;
    detailRequest.current?.abort();
    const controller = new AbortController(); detailRequest.current = controller;
    const promise = (async () => {
      try {
        let current = detailRef.current?.run.id === runId ? detailRef.current : null;
        const path = taskPath(bot.id) + "/runs/" + encodeURIComponent(runId);
        for (let page = 0; page < 20; page++) {
          const after = current?.cursor;
          let result = await api<TaskRunDetail | null>(path + (after === undefined ? "" : "?after=" + after), { signal: controller.signal });
          if (request !== detailsGeneration.current || controller.signal.aborted) return;
          if (!result) { setDetailError("没有找到这次执行记录"); return; }
          if (current?.cursor !== undefined && result.cursor !== undefined && result.cursor < current.cursor) {
            result = await api<TaskRunDetail>(path, { signal: controller.signal });
            if (request !== detailsGeneration.current || controller.signal.aborted) return;
            current = null;
          }
          current = mergeTaskRunDetail(current, result);
          detailRef.current = current; setDetail(current); setDetailError("");
          const hasMore = (result as TaskRunDetail & { hasMore?: boolean }).hasMore;
          if (!(hasMore ?? result.events.length === 500) || result.cursor === undefined || result.cursor === after) break;
        }
      } catch (error) { if (request === detailsGeneration.current && !controller.signal.aborted) setDetailError(errorText(error)); }
    })().finally(() => {
      if (detailRequest.current === controller) detailRequest.current = null;
      if (detailFlight.current?.promise === promise) detailFlight.current = null;
      if (detailDirty.current === runId && !controller.signal.aborted && request === detailsGeneration.current) {
        detailDirty.current = null;
        queueMicrotask(() => void refreshers.current.refreshDetail());
      }
    });
    detailFlight.current = { id: runId, promise }; return promise;
  }, [bot.id, runId]);
  const refreshers = useRef({ refresh, refreshRuns, refreshDetail });
  refreshers.current = { refresh, refreshRuns, refreshDetail };
  useEffect(() => { void refresh(); return () => { generation.current++; }; }, [refresh]);
  useEffect(() => { void refreshRuns(); return () => { runsGeneration.current++; }; }, [refreshRuns]);
  useEffect(() => { void refreshDetail(); return () => { detailsGeneration.current++; detailRequest.current?.abort(); detailFlight.current = null; detailDirty.current = null; }; }, [refreshDetail]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const events = new EventSource("/api/stream");
    const update = (event: MessageEvent) => {
      try { const data = JSON.parse(event.data) as { botIds?: string[]; type?: string }; if (data.type !== "connected" && data.botIds?.length && !data.botIds.includes(bot.id)) return; } catch { /* Re-fetch on an unreadable invalidation. */ }
      if (timer) return;
      timer = setTimeout(() => { timer = undefined; void refreshers.current.refresh(); void refreshers.current.refreshRuns(); void refreshers.current.refreshDetail(); }, 1000);
    };
    events.addEventListener("change", update as EventListener);
    events.onopen = () => { setConnected(true); void refreshers.current.refresh(); void refreshers.current.refreshRuns(); void refreshers.current.refreshDetail(); };
    events.onerror = () => setConnected(false);
    return () => { events.close(); clearTimeout(timer); };
  }, [bot.id]);
  const select = (id: string) => { if (selected === id) return; setSelected(id); setRuns([]); setRunsError(""); setHistoryLoaded(false); setRunId(null); setDetail(null); detailRef.current = null; };
  const mutate = async (task: ScheduledTask, action: "toggle" | "delete" | "reset-state" | "run") => {
    setPending(true);
    try {
      const path = taskPath(bot.id) + "/" + encodeURIComponent(task.id);
      if (action === "toggle") await api(path, { method: "PUT", body: JSON.stringify({ ...taskPayload({ ...task, enabled: !task.enabled }, task.revision) }) });
      else if (action === "delete") await api(path, { method: "DELETE", body: JSON.stringify({ expectedRevision: task.revision }) });
      else await post(path + "/" + action);
      setConfirmation(null);
      await refresh(); await refreshRuns();
      notify(action === "toggle" ? task.enabled ? "暂停请求已保存，等待 Worker 应用" : "恢复请求已保存，等待 Worker 应用" : action === "delete" ? "任务已删除，执行历史继续保留" : action === "run" ? "运行请求已保存，将在实例空闲后执行" : "清空状态请求已保存，等待 Worker 应用");
    } catch (error) { notify(errorText(error), true); }
    finally { setPending(false); }
  };
  const visible = tasks.filter(task => showDeleted || !task.deletedAt);
  return <div className="tasks-page">
    <div className="tasks-toolbar"><div><h2>定时任务</h2><p>按计划执行脚本或唤起模型，结果发送到本实例绑定的会话。</p></div><div className="heading-actions"><button className="btn" onClick={() => void refresh()}><Icon name="refresh" />刷新</button><button className="btn primary" onClick={() => setEditing("new")}><Icon name="plus" />创建任务</button></div></div>
    {error && <ErrorBox error={error} retry={() => void refresh()} />}
    <div className="tasks-view-options"><label><input type="checkbox" checked={showDeleted} onChange={event => setShowDeleted(event.target.checked)} />显示已删除任务</label><span><i className={"status-dot " + (connected ? "" : "off")} />{connected ? "实时更新" : "重新连接中"}</span></div>
    {!visible.length ? <Empty title={loaded ? "还没有定时任务" : "正在加载任务…"}><p>可以在 QQ 会话中描述定时需求，也可以在这里创建任务。</p>{loaded && <button className="btn primary" onClick={() => setEditing("new")}><Icon name="plus" />创建任务</button>}</Empty> : <div className="tasks-layout"><section className="panel tasks-list" aria-label="定时任务列表">{visible.map(task => <button key={task.id} className={"task-item " + (selected === task.id ? "selected" : "")} onClick={() => select(task.id)}><div className="task-item-title"><strong>{task.name}</strong><span className={"task-pill " + (task.enabled && !task.deletedAt ? "" : "muted")}>{task.deletedAt ? "已删除" : task.enabled ? "已启用" : "已暂停"}</span></div><p><Icon name={task.kind === "model" ? "spark" : "code"} />{task.kind === "model" ? "自然语言" : task.script?.runtime === "python" ? "Python 脚本" : "Node.js 脚本"}<span>·</span>{task.schedule.kind === "cron" ? task.schedule.expression : time(Date.parse(task.schedule.at), task.schedule.timezone)}</p><div className="task-item-time"><span>下次 {time(task.nextRunAt, task.schedule.timezone)}</span><span>{taskApplication(task)}</span></div></button>)}</section>
      <section className="panel task-inspector">{!selectedTask ? <div className="task-inspector-empty"><Icon name="calendar" /><h3>选择一个任务</h3><p>查看执行计划和运行历史。</p></div> : <><div className="task-inspector-heading"><div><h3>{selectedTask.name}</h3><p>{selectedTask.schedule.timezone} · 版本 {selectedTask.revision} · {taskApplication(selectedTask)}</p></div><div className="task-inspector-actions">{!selectedTask.deletedAt && <><button className="btn" disabled={pending || !selectedTask.enabled || bot.desiredState !== "running"} onClick={() => setConfirmation({ task: selectedTask, action: "run" })}><Icon name="play" />立即运行</button><button className="btn" disabled={pending} onClick={() => void mutate(selectedTask, "toggle")}>{selectedTask.enabled ? "暂停" : "恢复"}</button><button className="btn" onClick={() => setEditing(selectedTask)}>编辑</button><button className="btn danger" disabled={pending} onClick={() => setConfirmation({ task: selectedTask, action: "delete" })}>删除</button></>}</div></div>
        <dl className="task-facts"><div><dt>执行计划</dt><dd>{selectedTask.schedule.kind === "cron" ? <code>{selectedTask.schedule.expression}</code> : time(Date.parse(selectedTask.schedule.at), selectedTask.schedule.timezone)}</dd></div><div><dt>下次执行</dt><dd>{time(selectedTask.nextRunAt, selectedTask.schedule.timezone)}</dd></div><div><dt>允许延迟</dt><dd>{selectedTask.maxDelaySeconds} 秒</dd></div><div><dt>执行超时</dt><dd>{selectedTask.timeoutSeconds} 秒</dd></div></dl>
        {selectedTask.instructions && <p className="task-instructions">{selectedTask.instructions}</p>}
        <div className="task-context-tags">{selectedTask.context.taskState && <span className="feature-chip"><Icon name="database" />任务状态</span>}{selectedTask.context.chatHistory && <span className="feature-chip"><Icon name="chat" />{selectedTask.context.chatHistory.range === "scheduled_day" ? "当天聊天" : selectedTask.context.chatHistory.range === "previous_day" ? "前一天聊天" : `过去 ${selectedTask.context.chatHistory.hours} 小时`}</span>}{!selectedTask.context.taskState && !selectedTask.context.chatHistory && <span className="muted">不带入历史上下文</span>}{selectedTask.context.taskState && !selectedTask.deletedAt && <button className="task-link" disabled={pending} onClick={() => setConfirmation({ task: selectedTask, action: "reset-state" })}>清空任务状态</button>}</div>
        <div className="task-runs-heading"><h4>运行历史</h4><span>最新 100 次</span></div>{runsError && <ErrorBox error={runsError} retry={() => void refreshRuns()} />}{!runs.length ? <p className="task-runs-empty">{historyLoaded ? "还没有执行记录" : "正在加载运行历史…"}</p> : <div className="task-runs">{runs.map(run => <button key={run.id} className="task-run" onClick={() => { setRunId(run.id); setDetail(null); setDetailError(""); }}><div><strong>{time(run.scheduledAt, selectedTask.schedule.timezone)}</strong><span>{run.manual ? "手动运行" : "定时执行"} · 任务版本 {run.taskRevision}</span></div><div><span className={"task-run-status " + run.status}>{runLabels[run.status]}</span><small>{deliveryLabels[run.deliveryStatus]}{run.acknowledgedMessages > 0 ? ` ${run.acknowledgedMessages} 条` : ""}</small></div><Icon name="chevron" /></button>)}</div>}
      </>}</section></div>}
    {editing && <TaskEditor key={editing === "new" ? "new" : editing.id} bot={bot} task={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} onSaved={async task => { setEditing(null); select(task.id); await refresh(); await refreshRuns(); notify("任务已保存，等待 Worker 应用"); }} />}
    {confirmation && <div className="modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget && !pending) setConfirmation(null); }}><section className="panel connection-delete" role="dialog" aria-modal="true" aria-labelledby="task-confirm-title"><h2 id="task-confirm-title">{confirmation.action === "delete" ? "删除" : confirmation.action === "run" ? "立即运行" : "清空状态"}：{confirmation.task.name}？</h2><p>{confirmation.action === "delete" ? "停止后续调度，保留已有执行历史。正在执行的任务和已受理消息仍会完成收尾。" : confirmation.action === "run" ? "这会执行一次正式任务，并向当前绑定会话发送结果。原有执行计划不变。" : "清除该任务保存的业务数据，下次执行将从空状态开始。执行历史继续保留。"}</p><div><button className="btn" disabled={pending} onClick={() => setConfirmation(null)}>取消</button><button className={"btn " + (confirmation.action === "run" ? "primary" : "danger")} disabled={pending} onClick={() => void mutate(confirmation.task, confirmation.action)}>{pending ? "提交中…" : "确认"}</button></div></section></div>}
    {runId && <RunDetail detail={detail} error={detailError} onClose={() => { setRunId(null); setDetail(null); }} onRetry={() => void refreshDetail()} />}
  </div>;
}

function TaskEditor({ bot, task, onClose, onSaved }: { bot: PublicBot; task?: ScheduledTask; onClose: () => void; onSaved: (task: ScheduledTask) => Promise<void> }) {
  const [draft, setDraft] = useState<ScheduledTaskInput>(() => structuredClone(task || newTask()));
  const [onceTime, setOnceTime] = useState(() => task?.schedule.kind === "once" ? displayLocalTaskTime(task.schedule.at, task.schedule.timezone) : "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<number[] | null>(null);
  const ref = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  const pendingRef = useRef(pending);
  closeRef.current = onClose;
  pendingRef.current = pending;
  const patch = <K extends keyof ScheduledTaskInput>(key: K, value: ScheduledTaskInput[K]) => { setDraft(old => ({ ...old, [key]: value })); setError(""); setPreview(null); };
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLInputElement>("input")?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pendingRef.current) closeRef.current();
      if (event.key !== "Tab") return;
      const controls = Array.from(ref.current?.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]") || []);
      if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
    };
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("keydown", key); previous?.focus(); };
  }, []);
  const payload = () => taskEditorPayload(draft, onceTime, task);
  const save = async (event: FormEvent) => { event.preventDefault(); setPending(true); setError(""); try { const saved = await api<ScheduledTask>(taskPath(bot.id) + (task ? "/" + encodeURIComponent(task.id) : ""), { method: task ? "PUT" : "POST", body: JSON.stringify(payload()) }); await onSaved(saved); } catch (error) { setError(errorText(error)); } finally { setPending(false); } };
  const previewTimes = async () => { setPending(true); setError(""); try { const result = await post<{ nextRuns: number[] }>(taskPath(bot.id) + "/preview", payload()); setPreview(result.nextRuns); } catch (error) { setError(errorText(error)); setPreview(null); } finally { setPending(false); } };
  const history = draft.context.chatHistory;
  const setHistory = (change: Partial<NonNullable<ScheduledTaskInput["context"]["chatHistory"]>>) => patch("context", { ...draft.context, chatHistory: { range: "scheduled_day", includeBotReplies: true, maxMessages: 2000, maxInputTokens: 20000, ...history, ...change } });
  return <div className="modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget && !pending) onClose(); }}><section className="drawer task-editor" role="dialog" aria-modal="true" aria-labelledby="task-editor-title" ref={ref}><header className="drawer-header"><div><h2 id="task-editor-title">{task ? "编辑任务" : "创建定时任务"}</h2><p>发送到{bot.targetType === "group" ? "群聊" : "私聊"} {bot.targetId}</p></div><button className="icon-btn" disabled={pending} onClick={onClose} aria-label="关闭任务编辑"><Icon name="close" /></button></header><form onSubmit={event => void save(event)} style={{ display: "contents" }}><div className="drawer-body"><fieldset disabled={pending} className="task-fields"><div className="form-grid">
    <div className="form-field full"><label htmlFor="task-name">任务名称</label><input id="task-name" required maxLength={100} value={draft.name} onChange={event => patch("name", event.target.value)} placeholder="例如 每日早安" /></div>
    <div className="form-field full"><label htmlFor="task-kind">执行方式</label><select id="task-kind" value={draft.kind} onChange={event => { const kind = event.target.value as ScheduledTaskInput["kind"]; setDraft(old => ({ ...old, kind, script: kind === "script" ? old.script || { runtime: "python", source: "" } : old.script, timeoutSeconds: kind === "script" ? 120 : bot.config.modelTimeout })); setPreview(null); }}><option value="model">自然语言 · 调用模型完成任务</option><option value="script" disabled={!bot.config.allowCommands}>脚本 · 直接执行 Python / Node.js</option></select>{!bot.config.allowCommands && <small className="field-hint">实例开启命令执行权限后，可创建脚本任务。</small>}</div>
    <div className="form-field"><label htmlFor="task-schedule-kind">执行计划</label><select id="task-schedule-kind" value={draft.schedule.kind} onChange={event => patch("schedule", event.target.value === "once" ? { kind: "once", at: "", timezone: draft.schedule.timezone } : { kind: "cron", expression: "0 8 * * *", timezone: draft.schedule.timezone })}><option value="cron">周期执行</option><option value="once">执行一次</option></select></div>
    <div className="form-field"><label htmlFor="task-timezone">时区</label><input id="task-timezone" required value={draft.schedule.timezone} onChange={event => patch("schedule", { ...draft.schedule, timezone: event.target.value })} placeholder="Asia/Shanghai" /></div>
    {draft.schedule.kind === "cron" ? <div className="form-field full"><label htmlFor="task-cron">Cron 表达式</label><input id="task-cron" className="mono" required spellCheck={false} value={draft.schedule.expression} onChange={event => patch("schedule", { ...draft.schedule, kind: "cron", expression: event.target.value })} /><small className="field-hint">分钟 小时 日 月 星期。例如 0 8 * * * 表示每天 08:00；0 8 * * 1-5 表示周一至周五 08:00。</small></div> : <div className="form-field full"><label htmlFor="task-once">执行时间 · {draft.schedule.timezone}</label><input id="task-once" required type="datetime-local" value={onceTime} onChange={event => { setOnceTime(event.target.value); setPreview(null); }} /></div>}
    <div className="form-field full"><label htmlFor="task-instructions">{draft.kind === "model" ? "任务要求" : "任务说明（可选）"}</label><textarea id="task-instructions" rows={5} required={draft.kind === "model"} value={draft.instructions} onChange={event => patch("instructions", event.target.value)} placeholder="描述每次执行要做什么、数据来源和输出要求。" /><small className="field-hint">自然语言任务使用实例当前的人格、模型和工具，每次启动独立会话。</small></div>
    {draft.kind === "script" && <><div className="form-field full"><label htmlFor="task-runtime">脚本语言</label><select id="task-runtime" value={draft.script?.runtime || "python"} onChange={event => patch("script", { runtime: event.target.value as "python" | "node", source: draft.script?.source || "" })}><option value="python">Python 3</option><option value="node">Node.js</option></select></div><div className="form-field full"><label htmlFor="task-source">脚本内容</label><textarea id="task-source" className="task-source mono" spellCheck={false} required rows={12} value={draft.script?.source || ""} onChange={event => patch("script", { runtime: draft.script?.runtime || "python", source: event.target.value })} placeholder={draft.script?.runtime === "node" ? "import { sendMessage } from './nekodock_tasks.mjs';\nawait sendMessage({messages: [{type: 'text', text: '早安'}]});" : "from nekodock_tasks import send_message\nsend_message({'messages': [{'type': 'text', 'text': '早安'}]})"} /><small className="field-hint">发送接口与模型工具使用相同消息结构，发送目标固定为本实例会话。源码保存于数据库。</small></div></>}
    </div><div className="task-context-section"><h3>上下文</h3><label className="task-check"><input type="checkbox" checked={draft.context.taskState} onChange={event => patch("context", { ...draft.context, taskState: event.target.checked })} /><span><strong>任务状态</strong><small>加载本任务上次保存的业务数据；模型或脚本可显式保存新状态。</small></span></label><label className="task-check"><input type="checkbox" checked={!!history} onChange={event => patch("context", { ...draft.context, chatHistory: event.target.checked ? { range: "scheduled_day", includeBotReplies: true, maxMessages: 2000, maxInputTokens: 20000 } : undefined })} /><span><strong>指定范围聊天</strong><small>从本实例实际收到的消息读取背景，可跨 /new；不会带入思考和工具结果。</small></span></label>{history && <div className="form-grid task-history-options"><div className="form-field"><label htmlFor="task-range">时间范围</label><select id="task-range" value={history.range} onChange={event => setHistory({ range: event.target.value as typeof history.range, ...(event.target.value === "rolling" ? { hours: history.hours || 24 } : {}) })}><option value="scheduled_day">计划执行日 00:00 至计划时间</option><option value="previous_day">计划执行日的前一天</option><option value="rolling">计划时间之前若干小时</option></select></div>{history.range === "rolling" && <div className="form-field"><label htmlFor="task-hours">小时数</label><input id="task-hours" required type="number" min={1} max={744} value={history.hours || 24} onChange={event => setHistory({ hours: Number(event.target.value) })} /></div>}<div className="form-field"><label htmlFor="task-message-limit">消息条数上限</label><input id="task-message-limit" required type="number" min={1} max={10000} value={history.maxMessages} onChange={event => setHistory({ maxMessages: Number(event.target.value) })} /></div><div className="form-field"><label htmlFor="task-token-limit">聊天输入 Token 预算</label><input id="task-token-limit" required type="number" min={100} max={100000} value={history.maxInputTokens} onChange={event => setHistory({ maxInputTokens: Number(event.target.value) })} /></div><label className="task-check full"><input type="checkbox" checked={history.includeBotReplies} onChange={event => setHistory({ includeBotReplies: event.target.checked })} /><span>包含本机器人已确认发送的回复</span></label><small className="field-hint full">材料超出预算时会标明实际覆盖范围，模型不得声称已总结完整时段。</small></div>}</div>
    <details className="task-advanced"><summary>执行选项</summary><div className="form-grid"><div className="form-field"><label htmlFor="task-delay">允许延迟 · 秒</label><input id="task-delay" type="number" min={0} max={86400} required value={draft.maxDelaySeconds} onChange={event => patch("maxDelaySeconds", Number(event.target.value))} /><small className="field-hint">忙碌或恢复后超出此时间的执行记为错过。</small></div><div className="form-field"><label htmlFor="task-timeout">执行超时 · 秒</label><input id="task-timeout" type="number" min={1} max={3600} required value={draft.timeoutSeconds} onChange={event => patch("timeoutSeconds", Number(event.target.value))} /></div><label className="task-check full"><input type="checkbox" checked={draft.notifyOnFailure} onChange={event => patch("notifyOnFailure", event.target.checked)} /><span>失败时向会话发送一条通知</span></label></div></details>
    <div className="switch-row"><div className="switch-copy"><strong>启用任务</strong><p>实例运行且 Worker 应用后按计划执行。</p></div><label className="toggle"><input aria-label="启用任务" type="checkbox" checked={draft.enabled} onChange={event => patch("enabled", event.target.checked)} /><span className="toggle-track" /></label></div>
    <div className="task-preview"><button className="btn" type="button" disabled={pending} onClick={() => void previewTimes()}><Icon name="calendar" />检查计划时间</button>{preview && <div><strong>接下来{preview.length > 1 ? ` ${preview.length} 次` : ""}执行 · {draft.schedule.timezone}</strong>{preview.length ? <ol>{preview.map(instant => <li key={instant}>{new Intl.DateTimeFormat("zh-CN", { timeZone: draft.schedule.timezone, dateStyle: "medium", timeStyle: "medium" }).format(instant)}</li>)}</ol> : <p>没有后续执行时间。</p>}</div>}</div>
    </fieldset><Notice>计划时间检查只验证配置，不执行任务。忙碌时任务排队；执行失败或发送未确认时不会自动重跑。</Notice>{error && <div className="field-error" role="alert">{error}</div>}</div><footer className="drawer-footer"><button className="btn" type="button" disabled={pending} onClick={onClose}>取消</button><button className="btn primary" type="submit" disabled={pending || (draft.kind === "script" && !bot.config.allowCommands)}><Icon name="check" />{pending ? "处理中…" : "保存任务"}</button></footer></form></section></div>;
}

function RunDetail({ detail, error, onClose, onRetry }: { detail: TaskRunDetail | null; error: string; onClose: () => void; onRetry: () => void }) {
  const ref = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
      if (event.key !== "Tab") return;
      const controls = Array.from(ref.current?.querySelectorAll<HTMLElement>("button:not(:disabled),summary") || []);
      if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
    };
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("keydown", key); previous?.focus(); };
  }, []);
  return <div className="modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><section className="drawer task-run-detail" role="dialog" aria-modal="true" aria-labelledby="task-run-title" ref={ref}><header className="drawer-header"><div><h2 id="task-run-title">任务执行详情</h2><p>{detail ? taskRunOutcome(detail.run) : "正在加载执行记录…"}</p></div><button className="icon-btn" onClick={onClose} aria-label="关闭执行详情"><Icon name="close" /></button></header><div className="drawer-body">{error && <ErrorBox error={error} retry={onRetry} />}{detail && <><dl className="task-facts"><div><dt>计划时间</dt><dd>{date(detail.run.scheduledAt)}</dd></div><div><dt>实际开始</dt><dd>{date(detail.run.startedAt)}</dd></div><div><dt>结束时间</dt><dd>{date(detail.run.finishedAt)}</dd></div><div><dt>已确认消息</dt><dd>{detail.run.acknowledgedMessages} / {detail.run.acceptedMessages}</dd></div></dl>{detail.run.error && <div className="field-error">{detail.run.error}</div>}<div className="task-run-events">{!detail.events.length && <p className="muted">暂无详细事件。</p>}{taskDetailEvents(detail.events, detail.run.status).map((event, index) => <details className="task-run-event" key={index}><summary><Icon name="chevron" /><span>{event.type === "thinking.updated" ? "思考过程" : event.type === "script.output" ? "脚本输出" : event.type.startsWith("tool.") ? String(event.payload.tool || event.payload.name || "工具调用") : event.type === "delivery.acknowledged" ? "消息已确认发送" : event.type}</span><time>{date(event.time)}</time></summary><pre>{typeof event.payload.text === "string" ? event.payload.text + (event.payload.truncated ? "\n\n（内容已截断）" : "") : JSON.stringify(event.payload, null, 2)}</pre></details>)}</div>{detail.taskState && <details className="task-run-event"><summary><Icon name="database" />当前任务状态 · 版本 {detail.taskState.version}</summary><pre>{JSON.stringify(detail.taskState.data, null, 2)}</pre></details>}</>}</div></section></div>;
}
