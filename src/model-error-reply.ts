const providerReasons: Record<string, string> = {
  model_not_found: '模型不存在或当前账号无权使用',
  model_not_available: '当前模型暂时不可用',
  invalid_api_key: '模型服务鉴权失败',
  authentication_error: '模型服务鉴权失败',
  permission_denied: '当前账号没有调用权限',
  rate_limit_exceeded: '模型服务请求频率受限',
  insufficient_quota: '模型服务额度不足',
  quota_exceeded: '模型服务额度不足',
  context_length_exceeded: '输入超过模型上下文限制',
  content_filter: '生成被模型服务拦截',
  content_policy_violation: '生成被模型服务拦截',
  origin_response_timeout: '模型服务响应超时',
  upstream_timeout: '模型服务响应超时',
  'ModelArts.81104': '模型服务处理媒体内容失败',
};

/** Expose only recognized diagnostics; provider prose can contain echoed input or credentials. */
export function modelErrorReply(error: unknown): string {
  const metadata = error as { code?: unknown; message?: unknown; providerStatus?: unknown } | null;
  const message = typeof metadata?.message === 'string' ? metadata.message.slice(0, 8192).trim() : '';
  const detail = message.replace(/^PI_[A-Z0-9_]+:\s*/u, '');
  const http = /^(?:HTTP\s+)?([45]\d\d)(?=\b|:)/iu.exec(detail)
    ?? /^bridge API error \(([45]\d\d)\):/iu.exec(detail);
  const status = typeof metadata?.providerStatus === 'number' && Number.isInteger(metadata.providerStatus)
    && metadata.providerStatus >= 400 && metadata.providerStatus <= 599 ? metadata.providerStatus : http ? Number(http[1]) : undefined;
  const body = http ? detail.slice(http[0].length).replace(/^:\s*/u, '').trim() : detail;
  const evidence = body.replace(/\\+"/gu, '"');
  const diagnostics = [body];
  for (let index = 0; index < diagnostics.length && diagnostics.length < 16; index++) {
    for (const match of diagnostics[index]!.matchAll(/"(?:message|error_msg)"\s*:\s*("(?:\\.|[^"\\])*")/gu)) {
      try { diagnostics.push(JSON.parse(match[1]!) as string); } catch { /* Incomplete provider JSON has no usable field. */ }
      if (diagnostics.length >= 16) break;
    }
  }
  const code = Object.keys(providerReasons).find(candidate => {
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    return metadata?.code === candidate || body === candidate || body === `Response incomplete: ${candidate}`
      || new RegExp(`"(?:code|error_code|error_name|reason)"\\s*:\\s*"${escaped}"`, 'u').test(evidence);
  });
  let reason = code ? providerReasons[code] : undefined;
  if (!reason && (metadata?.code === 'PI_TIMEOUT' || /^PI_TIMEOUT(?:$|:)/u.test(message))) reason = '模型调用超时';
  if (!reason && diagnostics.some(value => /^(?:Connection error\.?|(?:TypeError: )?fetch failed|socket hang up|connect (?:ECONNREFUSED|ENETUNREACH|EHOSTUNREACH)\b|(?:ECONNRESET|ENOTFOUND|EAI_AGAIN)\b)/iu.test(value))) reason = '无法连接模型服务';
  if (!reason && diagnostics.some(value => /^(?:maximum context length exceeded|context length exceeded|input is too long|too many tokens)\b/iu.test(value))) reason = '输入超过模型上下文限制';
  if (!reason && diagnostics.some(value => /^Media conversion failed\b/iu.test(value))) reason = '模型服务处理媒体内容失败';
  if (!reason && status !== undefined) {
    reason = status === 401 ? '模型服务鉴权失败' : status === 403 ? '当前账号没有调用权限'
      : status === 404 ? '模型服务接口或模型不存在' : status === 429 ? '模型服务请求受限或额度不足'
      : [408, 504, 524].includes(status) ? '模型服务响应超时' : status === 413 ? '请求内容超过模型服务限制'
      : status >= 500 ? '模型服务暂时不可用' : status === 400 ? '模型服务拒绝了请求' : '模型服务返回错误';
  }
  const codes = [...(status !== undefined ? [`HTTP ${status}`] : []), ...(code ? [code] : [])];
  return `模型调用失败：${reason ?? '暂时无法确定具体原因'}${codes.length ? `（${codes.join('，')}）` : ''}。`;
}
