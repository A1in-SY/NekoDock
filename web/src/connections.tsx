import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { PublicBot } from "../../src/console/contracts";
import { api, errorText } from "./api";
import { affectedBots, connectionLabel, connectionPayload } from "./connections-state";
import type { ConnectionDraft, ConnectionView } from "./connections-state";
import { date, Empty, ErrorBox, Icon, Notice } from "./ui";

export function Connections({ connections, bots, error, reload, notify }: {
  connections: ConnectionView[]; bots: PublicBot[]; error: string;
  reload: () => Promise<void>;
  notify: (message: string, error?: boolean) => void;
}) {
  const [editing, setEditing] = useState<ConnectionView | "new" | null>(null);
  const [deleting, setDeleting] = useState<ConnectionView | null>(null);
  const [pending, setPending] = useState(false);
  const remove = async () => {
    if (!deleting || deleting.botIds.length) return;
    setPending(true);
    try {
      await api("/api/napcat-connections/" + encodeURIComponent(deleting.id), { method: "DELETE" });
      setDeleting(null);
      await reload();
      notify("NapCat 连接已删除");
    } catch (error) { notify(errorText(error), true); }
    finally { setPending(false); }
  };
  return <>
    <div className="page-heading">
      <div><div className="eyebrow" style={{ marginBottom: 6 }}>NAPCAT CONNECTIONS</div><h1>NapCat 连接</h1><p>多个实例共享连接，按绑定会话接收消息。</p></div>
      <div className="heading-actions">
        <button className="btn" onClick={() => void reload()}><Icon name="refresh" />刷新状态</button>
        <button className="btn primary" onClick={() => setEditing("new")}><Icon name="plus" />添加连接</button>
      </div>
    </div>
    {error && <ErrorBox error={error} retry={() => void reload()} />}
    {!connections.length ? <Empty title={error ? "暂时无法加载连接" : "添加第一个 NapCat 连接"}>
      <p>填写 NapCat WebSocket 服务端地址，再将实例绑定到这个连接。</p>
      <button className="btn primary" onClick={() => setEditing("new")}><Icon name="plus" />添加连接</button>
    </Empty> : <div className="connection-grid">{connections.map(connection => {
      const references = affectedBots(connection, bots);
      return <section className="panel connection-card" key={connection.id}>
        <div className="connection-card-heading"><div><h2>{connection.name}</h2><span className="connection-address mono">{connection.wsUrl}</span></div>
          <span className={"status-badge " + (connection.enabled && connection.connected && connection.online ? "" : "stopped")}>
            <i className={"status-dot " + (connection.enabled && connection.connected && connection.online ? "" : "off")} />{connectionLabel(connection)}
          </span>
        </div>
        <dl className="connection-facts">
          <div><dt>登录 QQ</dt><dd className="mono">{connection.accountId || "—"}</dd></div>
          <div><dt>引用实例</dt><dd>{connection.botIds.length} 个</dd></div>
          <div><dt>访问 Token</dt><dd>{connection.tokenConfigured ? "已配置" : "未配置"}</dd></div>
          <div><dt>连接状态</dt><dd>{connection.connected === undefined ? "等待状态" : connection.connected ? "WebSocket 已连接" : "WebSocket 未连接"}</dd></div>
        </dl>
        <div className="connection-references">{references.length ? references.map(bot => <a key={bot.id} className="feature-chip" href={"#bot/" + encodeURIComponent(bot.id) + "/config"}>{bot.name}<Icon name="arrow" /></a>) : <span className="muted">尚未绑定实例</span>}</div>
        {connection.error && <div className="connection-error" role="status"><Icon name="info" /><span>{connection.error}</span></div>}
        <footer className="connection-card-footer"><small>更新于 {date(connection.updatedAt)}</small><div>
          <button className="btn" onClick={() => setEditing(connection)}><Icon name="sliders" />编辑</button>
          <button className="btn danger" disabled={connection.botIds.length > 0} title={connection.botIds.length ? "请先为引用实例选择其他连接" : "删除连接"} onClick={() => setDeleting(connection)}>删除</button>
        </div></footer>
      </section>;
    })}</div>}
    {editing && <ConnectionEditor key={editing === "new" ? "new" : editing.id} connection={editing === "new" ? undefined : editing} bots={bots}
      onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await reload(); notify("NapCat 连接已保存"); }} />}
    {deleting && <div className="modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget && !pending) setDeleting(null); }}>
      <section className="panel connection-delete" role="dialog" aria-modal="true" aria-labelledby="delete-connection-title">
        <h2 id="delete-connection-title">删除 {deleting.name}？</h2><p>该连接当前没有引用实例，删除后需重新创建才能使用。</p>
        <div><button className="btn" disabled={pending} onClick={() => setDeleting(null)}>取消</button><button className="btn danger" disabled={pending} onClick={() => void remove()}>{pending ? "删除中…" : "删除连接"}</button></div>
      </section>
    </div>}
  </>;
}

function ConnectionEditor({ connection, bots, onClose, onSaved }: {
  connection?: ConnectionView; bots: PublicBot[]; onClose: () => void; onSaved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<ConnectionDraft>({ name: connection?.name || "", wsUrl: connection?.wsUrl || "", mediaBaseUrl: connection?.mediaBaseUrl || "", reconnectSeconds: connection?.reconnectSeconds ?? 3, actionTimeout: connection?.actionTimeout ?? 15, enabled: connection?.enabled ?? true });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [probe, setProbe] = useState<{ ok: boolean; text: string } | null>(null);
  const ref = useRef<HTMLElement>(null);
  const references = connection ? affectedBots(connection, bots) : [];
  const referenceCount = connection?.botIds.length || 0;
  const patch = <K extends keyof ConnectionDraft>(key: K, value: ConnectionDraft[K]) => { setDraft(old => ({ ...old, [key]: value })); setError(""); };
  useEffect(() => {
    ref.current?.querySelector<HTMLInputElement>("input")?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending) onClose();
      if (event.key !== "Tab") return;
      const items = Array.from(ref.current?.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),select,a[href]") || []);
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [pending, onClose]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setPending(true);
    try {
      const body = connectionPayload(draft, connection?.revision);
      await api("/api/napcat-connections" + (connection ? "/" + encodeURIComponent(connection.id) : ""), { method: connection ? "PUT" : "POST", body: JSON.stringify(body) });
      await onSaved();
    } catch (error) { setError(errorText(error)); }
    finally { setPending(false); }
  };
  const probeMedia = async () => {
    if (!connection) return;
    setPending(true); setProbe(null);
    try {
      const result = await api<{ reachable: boolean; error?: string }>(`/api/napcat-connections/${encodeURIComponent(connection.id)}/media-probe`, { method: 'POST', body: '{}' });
      setProbe({ ok: result.reachable, text: result.reachable ? 'NapCat 已成功从该地址下载测试资源。' : result.error || '媒体回源地址不可达，请检查地址和容器网络。' });
    } catch (error) { setProbe({ ok: false, text: errorText(error) }); }
    finally { setPending(false); }
  };
  return <div className="modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget && !pending) onClose(); }}>
    <section className="drawer" role="dialog" aria-modal="true" aria-labelledby="connection-editor-title" ref={ref}>
      <header className="drawer-header"><div><h2 id="connection-editor-title">{connection ? "编辑 NapCat 连接" : "添加 NapCat 连接"}</h2><p>连接由控制台统一维护。</p></div><button className="icon-btn" disabled={pending} onClick={onClose} aria-label="关闭连接编辑"><Icon name="close" /></button></header>
      <form onSubmit={event => void submit(event)} style={{ display: "contents" }}><div className="drawer-body">
        {referenceCount > 0 && <div className="connection-impact"><Icon name="users" /><div><strong>本次更改将影响 {referenceCount} 个实例</strong><p>{references.map(bot => bot.name).join("、") || "绑定到该连接的实例"}。修改连接参数后将重新建立连接，期间暂停收发消息。</p></div></div>}
        <div className="form-grid">
          <div className="form-field full"><label htmlFor="connection-name">连接名称 <span className="required">*</span></label><input id="connection-name" required maxLength={80} value={draft.name} onChange={event => patch("name", event.target.value)} placeholder="例如 主账号" /></div>
          <div className="form-field full"><label htmlFor="connection-url">WebSocket 地址 <span className="required">*</span></label><input id="connection-url" required value={draft.wsUrl} onChange={event => patch("wsUrl", event.target.value)} placeholder="ws://napcat:3002/" spellCheck={false} /><small className="field-hint">填写控制台容器能够访问的 NapCat WebSocket 服务端地址。</small></div>
          <div className="form-field full"><label htmlFor="connection-media-url">媒体回源地址</label><div className="secret-row"><input id="connection-media-url" value={draft.mediaBaseUrl || ''} onChange={event => { patch('mediaBaseUrl', event.target.value); setProbe(null); }} placeholder="http://console:4180" spellCheck={false} /><button className="btn" type="button" disabled={pending || !connection?.mediaBaseUrl || draft.mediaBaseUrl !== connection.mediaBaseUrl} onClick={() => void probeMedia()}>检查回源</button></div><small className="field-hint">NapCat 获取插件视频时访问的 Console 地址，须从 NapCat 所在网络可达。修改后先保存，再检查回源。</small>{probe && <small className={probe.ok ? 'field-hint' : 'field-error'} role="status">{probe.text}</small>}</div>
          <div className="form-field full"><label htmlFor="connection-token">访问 Token</label><div className="secret-row"><div className="password-field"><input id="connection-token" type="password" autoComplete="new-password" value={draft.token || ""} disabled={draft.token === null} placeholder={draft.token === null ? "保存后清除 Token" : connection?.tokenConfigured ? "已配置，留空保留" : "输入 Token（可选）"} onChange={event => patch("token", event.target.value || undefined)} /></div>{connection?.tokenConfigured && <button className={"btn " + (draft.token === null ? "" : "danger")} type="button" onClick={() => patch("token", draft.token === null ? undefined : null)}>{draft.token === null ? "保留原 Token" : "清除"}</button>}</div><small className="field-hint">加密保存，写入后仅显示是否已配置。</small></div>
          <div className="form-field"><label htmlFor="connection-reconnect">断线重连间隔 · 秒</label><input id="connection-reconnect" type="number" min={1} step={1} required value={draft.reconnectSeconds} onChange={event => patch("reconnectSeconds", Number(event.target.value))} /><small className="field-hint">连接断开后再次连接的等待时间，默认 3 秒。</small></div>
          <div className="form-field"><label htmlFor="connection-timeout">发送确认超时 · 秒</label><input id="connection-timeout" type="number" min={1} step={1} required value={draft.actionTimeout} onChange={event => patch("actionTimeout", Number(event.target.value))} /><small className="field-hint">等待 NapCat 返回动作回执的时间，默认 15 秒。</small></div>
        </div>
        <div className="switch-row"><div className="switch-copy"><strong>启用连接</strong><p>停用后，引用实例暂停接收和发送 QQ 消息。</p></div><label className="toggle"><input aria-label="启用连接" type="checkbox" checked={draft.enabled} onChange={event => patch("enabled", event.target.checked)} /><span className="toggle-track" /></label></div>
        <Notice>同一个连接可绑定多个群聊或私聊实例，每个实例保留独立的对话和工作目录。</Notice>
        {error && <div className="field-error" role="alert">{error}</div>}
      </div><footer className="drawer-footer"><button className="btn" type="button" disabled={pending} onClick={onClose}>取消</button><button className="btn primary" type="submit" disabled={pending}><Icon name="check" />{pending ? "保存中…" : "保存连接"}</button></footer></form>
    </section>
  </div>;
}
