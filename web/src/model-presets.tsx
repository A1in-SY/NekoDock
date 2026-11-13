import { useEffect, useRef, useState } from 'react';
import type { PublicModelPreset, PublicModelSettings } from '../../src/model-preset-contract';
import { MODEL_SETTING_KEYS } from '../../src/model-preset-contract';
import { api, errorText } from './api';
import { ModelFields } from './model-fields';
import { SecretInput } from './secret-input';
import { Empty, ErrorBox, Icon, Notice, date } from './ui';

export function ModelPresets() {
  const [presets, setPresets] = useState<PublicModelPreset[]>([]);
  const [defaults, setDefaults] = useState<PublicModelSettings | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<PublicModelPreset | 'new' | null>(null);
  const [deleting, setDeleting] = useState<PublicModelPreset | null>(null);
  const [pending, setPending] = useState(false);
  const reload = async () => {
    try { const [items, config] = await Promise.all([api<PublicModelPreset[]>('/api/model-presets'), api<PublicModelSettings>('/api/defaults')]); setPresets(items); setDefaults(config); setError(''); }
    catch (error) { setError(errorText(error)); }
  };
  useEffect(() => { void reload(); }, []);
  const remove = async () => {
    if (!deleting) return;
    setPending(true);
    try { await api('/api/model-presets/' + encodeURIComponent(deleting.id), {method: 'DELETE', body: JSON.stringify({expectedRevision: deleting.revision})}); setDeleting(null); await reload(); }
    catch (error) { setError(errorText(error)); }
    finally { setPending(false); }
  };
  return <>
    <div className="page-heading"><div><h1>模型预设</h1><p>保存整套模型参数，供所有实例选择使用。</p></div><div className="heading-actions"><button className="btn" onClick={() => void reload()}><Icon name="refresh" />刷新</button><button className="btn primary" disabled={!defaults} onClick={() => setEditing('new')}><Icon name="plus" />添加预设</button></div></div>
    {error && <ErrorBox error={error} retry={() => void reload()} />}
    <Notice>实例保存所选预设的独立快照。编辑或删除预设后，已运行实例继续使用原配置；在实例页面重新选择预设并保存即可应用更新。</Notice>
    {!presets.length ? <Empty title={defaults ? '保存第一个模型预设' : '正在加载模型预设…'}><p>可以在此添加，或从实例的「模型与上下文」保存当前配置。</p></Empty> : <div className="connection-grid">{presets.map(preset => <section className="panel connection-card" key={preset.id}>
      <div className="connection-card-heading"><div><h2>{preset.name}</h2><span className="connection-address mono">{preset.config.model}</span></div><span className="feature-chip">v{preset.revision}</span></div>
      <dl className="connection-facts"><div><dt>服务地址</dt><dd className="preset-url">{preset.config.baseUrl}</dd></div><div><dt>API 协议</dt><dd>{preset.config.modelApi === 'openai-responses' ? 'Responses' : 'Chat Completions'}</dd></div><div><dt>API Key</dt><dd>{preset.keyConfigured ? '已配置' : '未配置'}</dd></div><div><dt>上下文窗口</dt><dd>{preset.config.contextWindow.toLocaleString()} tokens</dd></div></dl>
      <footer className="connection-card-footer"><small>更新于 {date(preset.updatedAt)}</small><div><button className="btn" onClick={() => setEditing(preset)}>编辑</button><button className="btn danger" onClick={() => setDeleting(preset)}>删除</button></div></footer>
    </section>)}</div>}
    {editing && defaults && <PresetEditor key={editing === 'new' ? 'new' : editing.id} preset={editing === 'new' ? undefined : editing} defaults={defaults} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await reload(); }} />}
    {deleting && <div className="modal-overlay"><section className="panel connection-delete" role="dialog" aria-modal="true" aria-labelledby="delete-preset-title"><h2 id="delete-preset-title">删除 {deleting.name}？</h2><p>已使用该预设的实例保留当前配置。删除后，其他实例无法再选择此预设。</p><div><button className="btn" disabled={pending} onClick={() => setDeleting(null)}>取消</button><button className="btn danger" disabled={pending} onClick={() => void remove()}>{pending ? '删除中…' : '删除预设'}</button></div></section></div>}
  </>;
}

function PresetEditor({preset, defaults, onClose, onSaved}: {preset?: PublicModelPreset; defaults: PublicModelSettings; onClose: () => void; onSaved: () => Promise<void>}) {
  const [name, setName] = useState(preset?.name ?? '');
  const [config, setConfig] = useState<PublicModelSettings>(preset?.config ?? defaults);
  const [key, setKey] = useState<string | null | undefined>();
  const [pending, setPending] = useState(false), [error, setError] = useState('');
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLInputElement>('input')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !pending) onClose();
      if (event.key !== 'Tab') return;
      const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href]') ?? []);
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
    };
    document.addEventListener('keydown', onKey);return () => { document.removeEventListener('keydown', onKey); previous?.focus(); };
  }, [pending, onClose]);
  const save = async () => {
    setPending(true); setError('');
    try {
      const fields = Object.fromEntries(MODEL_SETTING_KEYS.filter(field => field !== 'modelApiKey').map(field => [field, config[field]]));
      await api('/api/model-presets' + (preset ? '/' + encodeURIComponent(preset.id) : ''), {method: preset ? 'PUT' : 'POST', body: JSON.stringify({name, config: {...fields, ...(key === undefined ? {} : {modelApiKey: key})}, ...(preset ? {expectedRevision: preset.revision} : {})})});
      await onSaved();
    } catch (error) { setError(errorText(error)); } finally { setPending(false); }
  };
  return <div className="modal-overlay"><section className="drawer" role="dialog" aria-modal="true" aria-labelledby="preset-editor-title" ref={ref}>
    <header className="drawer-header"><h2 id="preset-editor-title">{preset ? '编辑模型预设' : '添加模型预设'}</h2><button className="icon-btn" disabled={pending} aria-label="关闭预设编辑" onClick={onClose}><Icon name="close" /></button></header>
    <form style={{display: 'contents'}} onSubmit={event => {event.preventDefault(); void save();}}><div className="drawer-body"><fieldset disabled={pending} className="preset-fields">
      <div className="form-field full"><label htmlFor="preset-name">预设名称</label><input id="preset-name" required maxLength={80} value={name} onChange={event => setName(event.target.value)} placeholder="例如 日常对话模型" /></div>
      <ModelFields value={config} onChange={(field, value) => setConfig(old => ({...old, [field]: value}))} secret={<SecretInput label="API Key" field="modelApiKey" configured={preset?.keyConfigured ?? false} value={key} onChange={setKey} />} />
    </fieldset>{error && <div className="field-error" role="alert">{error}</div>}</div><footer className="drawer-footer"><button className="btn" type="button" disabled={pending} onClick={onClose}>取消</button><button className="btn primary" type="submit" disabled={pending}>{pending ? '保存中…' : '保存预设'}</button></footer></form>
  </section></div>;
}
