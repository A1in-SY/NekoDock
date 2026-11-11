import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { PublicBot } from '../../src/console/contracts';
import type { PluginInstanceView, PluginJobView, PublicPluginDefinition } from '../../src/plugin-contract';
import { api, errorText } from './api';
import { date, Empty, ErrorBox, Icon, Notice } from './ui';
import { filterPluginJobs, isCommandOnlyPlugin, isForwardInspectionPlugin, pluginDefaults, pluginDeliveryKindLabels, pluginDeliveryLabels, pluginFieldGroups, pluginFieldRows, pluginJobLabels, pluginJobNeedsAttention, pluginInspectionOutcomeText, pluginInspectionPercent, pluginInspectionReasonText, pluginOperationLabels, pluginPayload, pluginRecordTitle, pluginResourceLink, pluginSupportsTarget } from './plugins-state';
import type { PluginFieldEntry, PluginJobFilter } from './plugins-state';
import './plugins.css';

export function PluginCatalog() {
  const [plugins, setPlugins] = useState<PublicPluginDefinition[] | null>(null);
  const [selectedId, setSelectedId] = useState('core');
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try { setPlugins(await api<PublicPluginDefinition[]>('/api/plugins')); setError(''); }
    catch (error) { setError(errorText(error)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const selected = plugins?.find(plugin => plugin.id === selectedId) ?? plugins?.[0];
  return <>
    <div className="page-heading"><div><div className="eyebrow">PLUGINS</div><h1>插件</h1><p>为实例添加聊天指令、内容识别和媒体能力。</p></div><button className="btn" onClick={() => void load()}><Icon name="refresh" />刷新</button></div>
    {error && <ErrorBox error={error} retry={() => void load()} />}
    {plugins === null ? <Empty title="正在加载插件…" /> : selected && <div className="plugins-layout">
      <PluginList plugins={plugins} selectedId={selected.id} onSelect={setSelectedId} />
      <article className="panel plugin-card">
        <PluginHeading plugin={selected}><span className="feature-chip">{selected.required ? '内置 · 始终启用' : '已安装'}</span></PluginHeading>
        <p className="plugin-description">{selected.description || '提供会话控制和帮助指令。'}</p>
        <PluginCommands plugin={selected} />
        <footer className="plugin-card-footer">{selected.required ? '所有实例均可使用。' : '在实例的“插件”页面启用并配置。'}</footer>
      </article>
    </div>}
  </>;
}

function PluginList({ plugins, selectedId, onSelect, views }: { plugins: PublicPluginDefinition[]; selectedId: string; onSelect: (id: string) => void; views?: PluginInstanceView[] }) {
  return <nav className="panel plugin-list" aria-label="插件列表">{plugins.map(plugin => {
    const view = views?.find(item => item.id === plugin.id);
    return <button key={plugin.id} type="button" className={'plugin-list-item ' + (selectedId === plugin.id ? 'selected' : '')} aria-current={selectedId === plugin.id ? 'true' : undefined} onClick={() => onSelect(plugin.id)}>
      <span className="plugin-list-title"><strong>{plugin.name}</strong><span className={'plugin-pill ' + (view && !view.enabled ? 'disabled' : '')}>{plugin.required ? '内置' : view ? view.enabled ? '已启用' : '未启用' : '已安装'}</span></span>
      <span className="plugin-list-description">{plugin.description || '会话控制和帮助指令'}</span>
      <span className="plugin-list-meta"><span className="mono">v{plugin.version}</span><span>{view ? `${view.jobs.length} 条最近记录` : isForwardInspectionPlugin(plugin) ? '自动图片检查' : `${plugin.commands.length} 个指令`}</span></span>
    </button>;
  })}</nav>;
}

function PluginHeading({ plugin, children }: { plugin: PublicPluginDefinition; children?: ReactNode }) {
  return <div className="plugin-card-heading"><div className="plugin-icon"><Icon name={plugin.required ? 'shield' : 'spark'} /></div><div><h3>{plugin.name}</h3><span className="muted mono">v{plugin.version}</span></div>{children}</div>;
}

function PluginCommands({ plugin }: { plugin: PublicPluginDefinition }) {
  return plugin.commands.length > 0 && <div className="plugin-command-list">{plugin.commands.map(command => <div key={command.name}><code>{command.name}</code><span>{command.description}</span></div>)}</div>;
}

export function InstancePlugins({ bot, notify }: { bot: PublicBot; notify: (text: string, error?: boolean) => void }) {
  const [views, setViews] = useState<PluginInstanceView[] | null>(null);
  const [selectedId, setSelectedId] = useState('core');
  const [error, setError] = useState('');
  const generation = useRef(0);
  const load = useCallback(async () => {
    const version = ++generation.current;
    try { const result = await api<PluginInstanceView[]>(`/api/bots/${encodeURIComponent(bot.id)}/plugins`); if (version === generation.current) { setViews(result); setError(''); } }
    catch (error) { if (version === generation.current) setError(errorText(error)); }
  }, [bot.id]);
  useEffect(() => {
    void load(); let timer: ReturnType<typeof setTimeout> | undefined;
    const stream = new EventSource('/api/stream');
    stream.addEventListener('change', event => {
      try { const body = JSON.parse((event as MessageEvent).data); if (Array.isArray(body.botIds) && !body.botIds.includes(bot.id)) return; } catch { return; }
      clearTimeout(timer); timer = setTimeout(() => void load(), 100);
    });
    stream.onopen = () => void load();
    return () => { generation.current++; clearTimeout(timer); stream.close(); };
  }, [bot.id, load]);
  const selected = views?.find(view => view.id === selectedId) ?? views?.[0];
  return <div className="plugins-page">
    <div className="section-heading"><div><h2>实例插件</h2><p className="muted">选择聊天指令、内容增强与媒体能力，设置保存后自动生效。</p></div><button className="btn" onClick={() => void load()}><Icon name="refresh" />刷新</button></div>
    {error && <ErrorBox error={error} retry={() => void load()} />}
    {views === null ? <Empty title="正在加载插件…" /> : selected && <div className="plugins-layout">
      <PluginList plugins={views.map(view => view.manifest)} views={views} selectedId={selected.id} onSelect={setSelectedId} />
      <div className="plugin-detail">{views.map(view => <div key={view.id + ':' + view.revision} hidden={view.id !== selected.id}>
        <PluginEditor view={view} botId={bot.id} targetType={bot.targetType} notify={notify} onSaved={load} />
      </div>)}</div>
    </div>}
  </div>;
}

function PluginEditor({ view, botId, targetType, notify, onSaved }: { view: PluginInstanceView; botId: string; targetType: 'group' | 'private'; notify: (text: string, error?: boolean) => void; onSaved: () => Promise<void> }) {
  const [enabled, setEnabled] = useState(view.enabled);
  const [values, setValues] = useState<Record<string, unknown>>(() => ({ ...pluginDefaults(view.manifest), ...view.config }));
  const [cleared, setCleared] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState(false), [error, setError] = useState('');
  const [tab, setTab] = useState<'config' | 'records'>('config');
  const commandOnly = isCommandOnlyPlugin(view.manifest);
  const inspectionPlugin = isForwardInspectionPlugin(view.manifest);
  const supportsTarget = pluginSupportsTarget(view.manifest, targetType);
  const multilineField = (key: string) => inspectionPlugin && ['instructions', 'warningText'].includes(key);
  const groups = pluginFieldGroups(view.manifest);
  const patch = (key: string, value: unknown) => { setValues(old => ({ ...old, [key]: value })); setError(''); };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError(''); setPending(true);
    try {
      const body = pluginPayload(view, enabled, values, cleared);
      await api(`/api/bots/${encodeURIComponent(botId)}/plugins/${encodeURIComponent(view.id)}`, { method: 'PUT', body: JSON.stringify(body) });
      await onSaved(); notify('插件配置已保存');
    } catch (error) { setError(errorText(error)); }
    finally { setPending(false); }
  };
  const renderField = ([key, field]: PluginFieldEntry) => {
    const configured = Boolean((view.configuredSecrets as Record<string, boolean>)[key]);
    const id = `plugin-${view.id}-${key}`, hintId = field.description ? `${id}-hint` : undefined;
    if (field.type === 'boolean' || field.enum) return <div className={'plugin-setting-row ' + (field.enum ? 'plugin-setting-select' : 'plugin-setting-toggle')}>
      <div className="plugin-setting-copy"><label htmlFor={id}>{field.title}</label>{field.description && <p id={hintId}>{field.description}</p>}</div>
      <div className="plugin-setting-control">{field.type === 'boolean' ? <label className="toggle"><input id={id} type="checkbox" aria-label={field.title} aria-describedby={hintId} checked={values[key] === true} disabled={pending} onChange={event => patch(key, event.target.checked)} /><span className="toggle-track" /></label>
        : <select id={id} aria-describedby={hintId} disabled={pending} value={typeof values[key] === 'string' ? values[key] : ''} onChange={event => patch(key, event.target.value)}>
          {field.enum!.map((value, index) => <option key={value} value={value}>{field.enumLabels?.[index] ?? value}</option>)}
        </select>}</div>
    </div>;
    return <div className="form-field plugin-parameter-field"><label htmlFor={id}>{field.title}</label><div className={field.secret ? 'secret-row' : ''}>
      {multilineField(key) ? <textarea id={id} aria-describedby={hintId} rows={3} disabled={pending} value={typeof values[key] === 'string' ? values[key] : ''} onChange={event => patch(key, event.target.value)} />
        : <input id={id} aria-describedby={hintId} type={field.secret ? 'password' : field.type === 'integer' ? 'number' : 'text'} min={field.minimum} max={field.maximum} step={field.type === 'integer' ? 1 : undefined} autoComplete={field.secret ? 'new-password' : undefined} disabled={pending || cleared.has(key)} value={typeof values[key] === 'string' || typeof values[key] === 'number' ? values[key] as string | number : ''}
          placeholder={field.secret ? cleared.has(key) ? '保存后清除' : configured ? '已配置，留空保留' : '可选' : undefined} onChange={event => patch(key, field.type === 'integer' ? event.target.value === '' ? '' : Number(event.target.value) : event.target.value)} />}
      {field.secret && configured && <button className="btn" type="button" disabled={pending} onClick={() => setCleared(old => { const next = new Set(old); if (next.has(key)) next.delete(key); else next.add(key); return next; })}>{cleared.has(key) ? '保留' : '清除'}</button>}
    </div>{field.description && <small id={hintId} className="field-hint">{field.description}</small>}</div>;
  };
  return <section className="panel plugin-instance-card">
    <PluginHeading plugin={view.manifest}>{view.manifest.required ? <span className="feature-chip">内置 · 不可关闭</span> : <span className={'plugin-pill ' + (!view.enabled ? 'disabled' : '')}>{view.enabled ? '已启用' : '未启用'}</span>}</PluginHeading>
    <p className="plugin-description">{view.manifest.description || '提供 /new、/compact 和 /help。'}</p>
    <div className="plugin-detail-tabs" role="tablist" aria-label={`${view.manifest.name}详情`}>
      <button type="button" role="tab" id={`plugin-${view.id}-config-tab`} aria-selected={tab === 'config'} aria-controls={`plugin-${view.id}-config`} onClick={() => setTab('config')}>{view.manifest.required ? '指令' : '配置'}</button>
      <button type="button" role="tab" id={`plugin-${view.id}-records-tab`} aria-selected={tab === 'records'} aria-controls={`plugin-${view.id}-records`} onClick={() => setTab('records')}>最近处理记录<span>{view.jobs.length}</span></button>
    </div>
    <div role="tabpanel" id={`plugin-${view.id}-config`} aria-labelledby={`plugin-${view.id}-config-tab`} hidden={tab !== 'config'}>
    <form onSubmit={event => void submit(event)}>
      {!view.manifest.required && <div className="switch-row plugin-enable"><div className="switch-copy"><strong>启用插件</strong><p>{inspectionPlugin ? '异步检查群聊中新收到的合并转发图片。' : commandOnly ? '为当前实例处理新收到的插件指令。' : '为当前实例处理新收到的分享和插件指令。'}</p></div><label className="toggle"><input type="checkbox" aria-label={`启用${view.manifest.name}`} checked={enabled} disabled={pending || !supportsTarget && !enabled} onChange={event => setEnabled(event.target.checked)} /><span className="toggle-track" /></label></div>}
      {!supportsTarget && <Notice>此插件仅适用于群聊实例，私聊实例无法启用。</Notice>}
      <PluginCommands plugin={view.manifest} />
      {groups.length > 0 && enabled && <div className="plugin-fields">{groups.map(group => {
        const rows = pluginFieldRows(group.fields);
        const parameters = rows.every(row => row.field.type !== 'boolean' && !row.field.enum && row.children.length === 0);
        return <fieldset className="plugin-field-group" key={group.name} data-plugin-group={group.name}>
          {group.name && <legend>{group.name}</legend>}
          <div className={parameters ? 'plugin-parameter-grid' : 'plugin-behavior-list'}>{rows.map(({ key, field, children }) => <div className={'plugin-field-unit ' + (field.secret || multilineField(key) ? 'plugin-field-unit-full' : '')} key={key} data-plugin-field={key}>
            {renderField([key, field])}
            {children.length > 0 && <div className="plugin-field-children" role="group" aria-label={`${field.title}的选项`} data-parent-field={key}>
              {children.map(entry => <div className="plugin-field-unit" key={entry[0]} data-plugin-field={entry[0]}>{renderField(entry)}</div>)}
            </div>}
          </div>)}</div>
        </fieldset>;
      })}</div>}
      {!view.manifest.required && <><Notice>{inspectionPlugin ? enabled ? '图片检查独立于主会话运行。提醒发送成功后进入聊天上下文，不额外触发模型回复；检查过程与分值仅保留在插件记录。' : '启用后检查新收到的合并转发；已有转发不会补查。' : enabled ? view.manifest.commands.length ? '插件指令及其实际回复会进入聊天上下文，不额外触发模型回复。' : '解析资料和自动展示分别由本页开关控制，实际发送的媒体会进入聊天记录。' : commandOnly ? '启用后处理新收到的插件指令；已有聊天记录继续保留。' : '启用后处理新收到的分享；已有资料和聊天记录继续保留。'}</Notice>
        {error && <p className="field-error" role="alert">{error}</p>}<div className="plugin-save"><button className="btn primary" disabled={pending} type="submit"><Icon name="check" />{pending ? '保存中…' : '保存插件配置'}</button></div></>}
    </form>
    </div>
    <div role="tabpanel" id={`plugin-${view.id}-records`} aria-labelledby={`plugin-${view.id}-records-tab`} hidden={tab !== 'records'}><PluginRecords view={view} /></div>
  </section>;
}

function PluginRecords({ view }: { view: PluginInstanceView }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<PluginJobFilter>('all');
  const jobs = filterPluginJobs(view.jobs, query, filter);
  if (!view.jobs.length) return <div className="plugin-records-empty"><Icon name="document" /><h4>暂无处理记录</h4><p>{view.manifest.required ? '内置指令在实例中执行，不会产生后台内容处理任务。' : isForwardInspectionPlugin(view.manifest) ? '插件检查新的合并转发后，统计、判定及提醒投递记录会实时出现在这里。' : '插件处理新的分享或指令后，记录会实时出现在这里。'}</p></div>;
  return <div className="plugin-records">
    <div className="plugin-records-toolbar"><label className="plugin-records-search"><Icon name="search" /><input aria-label="搜索处理记录" placeholder={isForwardInspectionPlugin(view.manifest) ? '搜索判定结果、原因或消息 ID' : isCommandOnlyPlugin(view.manifest) ? '搜索指令、参数、结果或消息 ID' : '搜索标题、资源 ID、作者或消息 ID'} value={query} onChange={event => setQuery(event.target.value)} /></label>
      <select aria-label="筛选处理记录" value={filter} onChange={event => setFilter(event.target.value as PluginJobFilter)}><option value="all">全部状态</option><option value="active">进行中</option><option value="attention">需要关注</option></select></div>
    <p className="plugin-records-note">{query || filter !== 'all' ? `${jobs.length} 条匹配 · ` : ''}最近 {view.jobs.length} 条 · 时间为 UTC+08:00</p>
    {!jobs.length ? <div className="plugin-records-empty"><p>没有匹配的处理记录</p></div> : <div className="plugin-record-list">{jobs.map(job => <PluginRecord key={job.id} job={job} />)}</div>}
  </div>;
}

function PluginRecord({ job }: { job: PluginJobView }) {
  const resource = job.resource;
  const execution = job.commandExecution;
  const inspection = job.inspection;
  const link = pluginResourceLink(resource?.url, job.pluginId);
  const command = job.commandName || job.command;
  return <details className={'plugin-record ' + (pluginJobNeedsAttention(job) ? 'needs-attention' : '')}>
    <summary><div className="plugin-record-main"><div className="plugin-record-title"><span className="plugin-operation">{pluginOperationLabels[job.operation] || job.operation}</span><strong>{pluginRecordTitle(job)}</strong></div>
      <div className="plugin-record-meta">{resource?.title && <span className="mono">{resource.id}</span>}<span>消息 <span className="mono">{job.sourceMessageId}</span></span><span>{job.operation === 'inspect' ? '转发触发' : job.automatic ? '自动识别' : '指令触发'}</span>{inspection && <span>图片 {inspection.imageCount} 张 · 含图消息 {inspection.imageMessageCount}/{inspection.messageCount} 条</span>}<time dateTime={new Date(job.createdAt).toISOString()}>{date(job.createdAt, { second: '2-digit' })}</time></div>
    </div><div className="plugin-record-status"><span>{pluginJobLabels[job.state] || job.state}</span>{job.deliveries.map((delivery, index) => <small className={'plugin-delivery ' + delivery.status} key={delivery.kind + ':' + index}>{pluginDeliveryKindLabels[delivery.kind] || delivery.kind} · {pluginDeliveryLabels[delivery.status] || delivery.status}</small>)}</div><Icon name="chevron" /></summary>
    <div className="plugin-record-body"><dl className="plugin-record-facts">
      {resource && <><div><dt>资源</dt><dd className="mono">{resource.id}</dd></div>{(resource.author || resource.part !== undefined) && <div><dt>{resource.part !== undefined ? '作者 / 分 P' : '作者'}</dt><dd>{resource.author || '—'}{resource.part !== undefined ? ` · P${resource.part}` : ''}</dd></div>}</>}
      <div><dt>来源消息 ID</dt><dd className="mono">{job.sourceMessageId}</dd></div><div><dt>任务 ID</dt><dd className="mono">{job.id}</dd></div>
      <div><dt>所属会话</dt><dd className="mono">{job.conversationId || (job.operation === 'inspect' ? '不依赖主会话' : '等待实例接收消息')}</dd></div><div><dt>尝试次数</dt><dd>{job.attempts}</dd></div>
      {!job.automatic && <div><dt>触发指令</dt><dd className="mono">{command}</dd></div>}
      {execution && <><div><dt>原始参数</dt><dd className="plugin-command-output">{execution.input || '无参数'}</dd></div>
        {execution.details.map((detail, index) => <div key={index}><dt>{detail.label}</dt><dd>{detail.value}</dd></div>)}
        <div className="plugin-command-reply"><dt>回复内容</dt><dd className="plugin-command-output">{execution.text}</dd></div></>}
      {inspection && <>
        <div><dt>检查结果</dt><dd>{pluginInspectionOutcomeText(inspection)}</dd></div>
        <div><dt>转发消息统计</dt><dd>共 {inspection.messageCount} 条，其中 {inspection.imageMessageCount} 条含图</dd></div>
        <div><dt>图片数量</dt><dd>共 {inspection.imageCount} 张 · 抽样 {inspection.sampledCount} 张 · 已检查 {inspection.checkedCount} 张</dd></div>
        {inspection.requestCount !== undefined && <div><dt>本次请求</dt><dd>{inspection.requestCount} 次 Jev 请求 · 复用 {inspection.cacheHits ?? 0} 张判定结果 · 复用 {inspection.preparedCacheHits ?? 0} 张压缩图片</dd></div>}
        <div><dt>转发展开</dt><dd>{inspection.structuralComplete ? '结构完整' : '结构不完整'}{!inspection.structuralComplete && '，无法完整统计图片数量'}</dd></div>
        {!['pending', 'skipped'].includes(inspection.outcome) && inspection.checkedCount < inspection.sampledCount && <div className="plugin-inspection-note"><dt>样本覆盖</dt><dd>{inspection.checkedCount ? '部分样本未完成检查；已取得的分值仍参与判定，未检出不代表整条转发安全。' : '样本均未完成判断，不能据此判断整条转发是否包含 NSFW。'}</dd></div>}
        {inspection.reason && <div><dt>检查说明</dt><dd>{pluginInspectionReasonText(inspection.reason)}{pluginInspectionReasonText(inspection.reason) !== inspection.reason && <span className="plugin-error-code mono">{inspection.reason}</span>}</dd></div>}
        {!!inspection.scores?.length && <div className="plugin-inspection-scores"><dt>样本判定分值</dt><dd><ol>{inspection.scores.map((score, index) => <li key={score.sourceKey}><span>样本 {index + 1}<small className="mono">{score.sourceKey}</small></span><strong>{pluginInspectionPercent(score.score * 100)}</strong></li>)}</ol></dd></div>}
        {!!inspection.failures?.length && <div className="plugin-inspection-scores"><dt>未完成的样本</dt><dd><ol>{inspection.failures.map((failure, index) => <li key={failure.sourceKey}><span>样本 {index + 1}<small className="mono">{failure.sourceKey}</small></span><span>{pluginInspectionReasonText(failure.code)}{failure.httpStatus !== undefined && ` · HTTP ${failure.httpStatus}`}<small className="mono">{failure.code}</small></span></li>)}</ol></dd></div>}
      </>}
      {job.finishedAt !== undefined && <div><dt>处理结束</dt><dd>{date(job.finishedAt, { second: '2-digit' })}</dd></div>}
      {job.durationMs !== undefined && <div><dt>总耗时（含排队）</dt><dd>{(job.durationMs / 1000).toLocaleString('zh-CN', { maximumFractionDigits: 1 })} 秒</dd></div>}
      {job.deliveries.map((delivery, index) => <div key={delivery.kind + ':' + index}><dt>{pluginDeliveryKindLabels[delivery.kind] || delivery.kind}投递 {job.deliveries.length > 1 ? index + 1 : ''}</dt><dd>{pluginDeliveryLabels[delivery.status] || delivery.status}{delivery.messageId && <span className="plugin-receipt-id mono">QQ 消息 {delivery.messageId}</span>}{delivery.code && <span className="plugin-error-code mono">{delivery.code}</span>}</dd></div>)}
    </dl>{job.error && <div className="plugin-record-error"><Icon name="info" /><span>{inspection ? pluginInspectionReasonText(job.error) : job.error}{inspection && pluginInspectionReasonText(job.error) !== job.error && <span className="plugin-error-code mono">{job.error}</span>}</span></div>}
      {link && <a className="plugin-resource-link" href={link} target="_blank" rel="noreferrer">打开原分享<Icon name="arrow" /></a>}
    </div>
  </details>;
}
