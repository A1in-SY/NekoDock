import type { ReactNode } from 'react';
import type { PublicModelSettings } from '../../src/model-preset-contract';

export function ModelFields({value, onChange, secret}: {
  value: PublicModelSettings;
  onChange: <K extends keyof PublicModelSettings>(key: K, value: PublicModelSettings[K]) => void;
  secret: ReactNode;
}) {
  const field = (label: string, key: 'baseUrl' | 'model' | 'maxOutputTokens' | 'contextWindow' | 'compactLimit' | 'compactKeepRecentTokens' | 'compactSummaryMaxTokens', hint: string) => {
    const numeric = typeof value[key] === 'number';
    return <div className={'form-field ' + (numeric ? '' : 'full')}>
      <label htmlFor={'f-' + key}>{label}</label>
      <input id={'f-' + key} type={numeric ? 'number' : key === 'baseUrl' ? 'url' : 'text'} min={numeric ? 1 : undefined} step={numeric ? 1 : undefined}
        value={value[key]} onChange={event => onChange(key, (numeric ? Number(event.target.value) : event.target.value) as never)} />
      <small className="field-hint">{hint}</small>
    </div>;
  };
  const toggle = (label: string, key: 'supportsImages' | 'supportsReasoning', hint: string) => <div className="switch-row">
    <div className="switch-copy"><strong>{label}</strong><p>{hint}</p></div><label className="toggle"><input type="checkbox" aria-label={label} checked={value[key]} onChange={event => onChange(key, event.target.checked)} /><span className="toggle-track" /></label>
  </div>;
  return <>
    <div className="form-grid">
      <div className="form-field full"><label htmlFor="f-modelApi">API 协议</label><select id="f-modelApi" value={value.modelApi} onChange={event => onChange('modelApi', event.target.value as PublicModelSettings['modelApi'])}><option value="openai-responses">Responses</option><option value="openai-completions">Chat Completions</option></select><small className="field-hint">按服务商实际支持选择；执行失败时不会自动切换协议。</small></div>
      {field('API Base URL', 'baseUrl', '填写服务地址，包含服务商要求的 /v1 等路径。')}
      {secret}
      {field('模型 ID', 'model', '填写服务商支持的准确模型 ID。')}
      {value.supportsReasoning && <div className="form-field"><label htmlFor="f-reasoning">思考等级</label><select id="f-reasoning" value={value.reasoning} onChange={event => onChange('reasoning', event.target.value as PublicModelSettings['reasoning'])}>{['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map(level => <option key={level} value={level}>{level || 'default'}</option>)}</select><small className="field-hint">仅发送所选等级；服务商与模型需实际支持。</small></div>}
      {field('最大输出 · tokens', 'maxOutputTokens', '包含模型的输出预算，须小于等于上下文预留量。')}
    </div>
    <hr className="form-divider" /><h3 className="form-subtitle">模型能力</h3>
    {toggle('支持图片输入', 'supportsImages', '关闭时不向模型发送图片内容。')}
    {toggle('支持思考参数', 'supportsReasoning', '关闭后保留已选等级，但不发送思考参数。')}
    <hr className="form-divider" /><h3 className="form-subtitle">上下文管理</h3>
    <div className="form-grid">
      {field('上下文窗口 · tokens', 'contextWindow', '不能超过服务商和模型的实际能力。')}
      {field('自动压缩阈值 · tokens', 'compactLimit', '窗口与阈值之间须留足最大输出空间。')}
      {field('压缩保留近期历史 · tokens', 'compactKeepRecentTokens', '必须小于压缩阈值。')}
      {field('压缩摘要输出上限 · tokens', 'compactSummaryMaxTokens', '不能超过模型最大输出量。')}
    </div>
  </>;
}
