import { isSticker, parseSegments, portableImageSource } from './napcat.js';
import { FORWARD_LIMITS, type ForwardContent, type ForwardNode, type ForwardSegment } from './forward-contract.js';

type Json = Record<string, unknown>;
const object = (value: unknown): Json | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;
const identifier = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 && value.length <= 200 ? value
  : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : undefined;
const string = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const bounded = (value: unknown, length: number): string | undefined => string(value)?.slice(0, length);
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
async function untilAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason); signal.addEventListener('abort', abort, {once: true});
    })]);
  } finally { signal.removeEventListener('abort', abort); }
}

interface Root { path: string; data: Json; }
function roots(event: unknown): Root[] {
  const segments = parseSegments(object(event)?.message) ?? [];
  return segments.flatMap((segment, index) => segment.type === 'forward' ? [{ path: `s${index}`, data: segment.data }]
    : segment.type === 'node' ? [{ path: `s${index}`, data: { content: [segment] } }] : []).slice(0, FORWARD_LIMITS.nodes);
}
export function pendingForwardContents(event: unknown): ForwardContent[] {
  return roots(event).map(root => ({ type: 'forward', path: root.path, status: 'pending', nodes: [] }));
}

export interface ResolveForwardOptions {
  signal: AbortSignal;
  deadline: number;
  fetch(resourceId: string, signal: AbortSignal, deadline: number): Promise<unknown>;
  image(sourceKey: string, source: string): string | null;
}

/** Normalize recursively expanded NapCat replies before attempting another resource lookup. */
export async function resolveForwardContents(event: unknown, options: ResolveForwardOptions): Promise<ForwardContent[]> {
  const inputs = roots(event);
  const rootOverflow = (parseSegments(object(event)?.message) ?? []).filter(segment => segment.type === 'forward' || segment.type === 'node').length > FORWARD_LIMITS.nodes;
  const contents: ForwardContent[] = inputs.map(root => ({ type: 'forward', path: root.path, status: 'pending', nodes: [] }));
  let nodeCount = 0;
  let referenceCount = 0;
  let exhausted = false;
  const loaded = new Map<string, Promise<unknown>>();
  const timeout = AbortSignal.timeout(Math.max(1, options.deadline - Date.now()));
  const signal = AbortSignal.any([options.signal, timeout]);
  const available = () => { signal.throwIfAborted(); if (Date.now() >= options.deadline) throw new Error('timeout'); };
  const fail = (target: ForwardContent, error: string) => { target.status = target.nodes.length ? 'partial' : 'failed'; target.error = error; };
  const append = (node: ForwardNode, segment: ForwardSegment): boolean => {
    node.segments.push(segment);
    if (bytes(contents) <= FORWARD_LIMITS.bytes - 2048) return true;
    node.segments.pop(); exhausted = true; return false;
  };
  const list = (value: unknown): unknown[] | null => {
    if (Array.isArray(value)) return value;
    const record = object(value);
    if (!record) return null;
    if (Array.isArray(record.messages)) return record.messages;
    if (Array.isArray(record.message)) return record.message;
    return null;
  };
  const inline = (data: Json): unknown[] | null => {
    const content = list(data.content);
    const message = list(data.message);
    return content?.length ? content : message?.length ? message : content ?? message;
  };
  const forward = async (target: ForwardContent, data: Json, depth: number, ancestors: Set<string>): Promise<void> => {
    try {
      available();
      if (depth > FORWARD_LIMITS.depth) { fail(target, '转发嵌套超过 8 层，后续内容未展开'); return; }
      if (++referenceCount > FORWARD_LIMITS.nodes || exhausted) { fail(target, '转发内容达到读取上限，后续内容未展开'); return; }
      let items = inline(data);
      const resourceId = identifier(data.id ?? data.message_id);
      let nextAncestors = ancestors;
      if (items === null) {
        if (!resourceId) { fail(target, '转发缺少可读取的内容'); return; }
        if (ancestors.has(resourceId)) { fail(target, '检测到循环转发，未继续展开'); return; }
        nextAncestors = new Set(ancestors).add(resourceId);
        let request = loaded.get(resourceId);
        if (!request) { request = options.fetch(resourceId, signal, options.deadline); loaded.set(resourceId, request); }
        const response = await untilAbort(request, signal);
        available();
        const record = object(response);
        items = list(record?.data ?? response);
        if (items === null) { fail(target, '转发接口返回格式无效'); return; }
      } else if (resourceId) nextAncestors = new Set(ancestors).add(resourceId);
      target.status = 'ready';
      for (const [index, item] of items.entries()) {
        available();
        if (nodeCount >= FORWARD_LIMITS.nodes || exhausted) { fail(target, '转发内容达到读取上限，后续内容未展开'); break; }
        const record = object(item);
        const value = record?.type === 'node' ? object(record.data) ?? {} : record ?? {};
        const sender = object(value.sender);
        const path = `${target.path}/n${index}`;
        const senderId = [value.user_id, value.uin, sender?.user_id].map(identifier).find(Boolean);
        const senderName = [value.nickname, value.name, sender?.card, sender?.nickname]
          .map(name => bounded(name, 160)?.trim()).find(Boolean);
        const rawTime = value.time;
        const time = typeof rawTime === 'number' && Number.isFinite(rawTime) && rawTime >= 0 ? rawTime
          : typeof rawTime === 'string' && /^\d{1,12}$/u.test(rawTime) ? Number(rawTime) : undefined;
        const node: ForwardNode = { path, ...(senderId ? { senderId } : {}), ...(senderName ? { senderName } : {}), ...(time !== undefined ? { time } : {}), segments: [] };
        target.nodes.push(node); nodeCount++;
        if (bytes(contents) > FORWARD_LIMITS.bytes - 2048) { target.nodes.pop(); fail(target, '转发内容达到大小上限，后续内容未展开'); exhausted = true; break; }
        let source = value.content;
        if (source === undefined || Array.isArray(source) && !source.length) source = value.message ?? source;
        if (source === undefined && record?.type && record.type !== 'node') source = [record];
        if (source === undefined && typeof item === 'string') source = item;
        const segments = parseSegments(source);
        if (!segments) { append(node, { type: 'media', kind: 'unknown', text: '这条转发内容格式无法识别' }); target.status = 'partial'; continue; }
        for (const [segmentIndex, segment] of segments.entries()) {
          available();
          const sourceKey = `forward:${path}/s${segmentIndex}`;
          if (segment.type === 'forward' || segment.type === 'node') {
            if (depth >= FORWARD_LIMITS.depth) {
              append(node, { type: 'media', kind: 'forward', text: '转发嵌套超过 8 层，后续内容未展开' });
              target.status = 'partial'; continue;
            }
            const child: ForwardContent = { type: 'forward', path: `${path}/s${segmentIndex}`, status: 'pending', nodes: [] };
            if (!append(node, child)) { fail(target, '转发内容达到大小上限，后续内容未展开'); break; }
            await forward(child, segment.type === 'node' ? { content: [segment] } : segment.data, depth + 1, nextAncestors);
            if (child.status !== 'ready') target.status = 'partial';
          } else if (segment.type === 'text') {
            const text = string(segment.data.text) ?? '';
            const remaining = FORWARD_LIMITS.bytes - 2048 - bytes(contents) - 100;
            const truncated = Buffer.byteLength(text) > remaining;
            const selected = truncated ? Buffer.from(text).subarray(0, Math.max(0, remaining)).toString('utf8') : text;
            if (selected && !append(node, { type: 'text', text: selected })) { fail(target, '转发内容达到大小上限，后续内容未展开'); break; }
            if (truncated) { exhausted = true; fail(target, '转发内容达到大小上限，后续内容未展开'); break; }
          } else if (segment.type === 'image') {
            if (isSticker(segment)) { append(node, { type: 'media', kind: 'sticker', text: bounded(segment.data.summary, 200) ?? '[表情包]' }); continue; }
            const source = portableImageSource(segment);
            if (bytes(contents) > FORWARD_LIMITS.bytes - 2400) { exhausted = true; fail(target, '转发内容达到大小上限，后续内容未展开'); break; }
            const assetId = source ? options.image(sourceKey, source) : null;
            append(node, assetId ? { type: 'image', assetId, sourceKey } : { type: 'media', kind: 'image', text: source ? '图片数量达到上限，未读取' : '图片来源不可用' });
            if (!assetId) target.status = 'partial';
          } else {
            const text = segment.type === 'at' ? `[@${identifier(segment.data.qq) ?? bounded(segment.data.qq, 200) ?? ''}]`
              : segment.type === 'reply' ? '[引用了转发记录中的消息]'
                : bounded(segment.data.summary ?? segment.data.title ?? segment.data.text ?? segment.data.data, 2000);
            const name = bounded(segment.data.name, 200);
            if (!append(node, { type: 'media', kind: segment.type, ...(name ? { name } : {}), ...(text ? { text } : {}) })) { fail(target, '转发内容达到大小上限，后续内容未展开'); break; }
          }
        }
      }
    } catch {
      if (options.signal.aborted) throw options.signal.reason;
      fail(target, signal.aborted || Date.now() >= options.deadline ? '读取转发内容超时' : '转发内容不存在、已失效或读取失败');
    }
  };
  for (const [index, input] of inputs.entries()) await forward(contents[index]!, input.data, 1, new Set());
  if (rootOverflow && contents.length) {
    const last = contents.at(-1)!; last.status = 'partial'; last.error = '转发数量达到读取上限，后续转发未展开';
  }
  // Error markers also occupy bytes. Keep every emitted snapshot valid even when
  // many later branches fail after an earlier branch has consumed the budget.
  while (bytes(contents) > FORWARD_LIMITS.bytes) {
    const lastWithNodes = [...contents].reverse().find(content => content.nodes.length);
    if (lastWithNodes) { lastWithNodes.nodes.pop(); lastWithNodes.status = 'partial'; lastWithNodes.error = '转发内容达到大小上限，后续内容未展开'; }
    else { contents.pop(); if (contents[0]) { contents[0].status = 'partial'; contents[0].error = '转发内容达到大小上限，后续内容未展开'; } }
  }
  return contents;
}
