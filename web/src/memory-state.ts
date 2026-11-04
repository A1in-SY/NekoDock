import type { MemoryControl, MemoryItem, MemoryView } from '../../src/memory-contract.ts';
export interface MemoryCommand extends MemoryControl {
  status: 'pending' | 'completed' | 'failed'; error: string | null; createdAt: number; finishedAt: number | null;
}
export interface MemoryPage { view: MemoryView | null; updatedAt: number | null; controls: MemoryCommand[] }
export const memoryStates = {active:'有效',superseded:'已替代',disabled:'已停用'} as const;
export const memoryJobStates = {pending:'等待整理',running:'整理中',completed:'已完成',failed:'失败',cancelled:'已取消'} as const;
export const memoryReasons = {daily:'每日定时',compaction:'会话压缩后',manual:'手动整理',backfill:'历史回填',control:'管理操作'} as const;
export function memoryFilteredItems(items: readonly MemoryItem[], query: string, includeInactive: boolean): MemoryItem[] {
  const search = query.trim().toLowerCase();
  return items.filter(item => (includeInactive || item.status === 'active') && `${item.content} ${item.topic} ${item.subjectUserId ?? ''}`.toLowerCase().includes(search));
}
export function memoryListPage<T>(items: readonly T[], requestedPage: number, pageSize: number) {
  const total = items.length, pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.max(1, Math.min(pages, requestedPage));
  const offset = (page - 1) * pageSize;
  return {items: items.slice(offset, offset + pageSize), page, pages, total, start: total ? offset + 1 : 0, end: Math.min(offset + pageSize, total)};
}
export function memoryLocalTime(value: number): string { return new Date(value + 8 * 3600_000).toISOString().slice(0,16); }
export function memoryRange(from: string, to: string): {from:number;to:number} {
  const parse = (input: string) => /^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(input) ? Date.parse(input+':00+08:00') : NaN;
  const start = parse(from), end = parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || memoryLocalTime(start) !== from || memoryLocalTime(end) !== to) throw new Error('请选择有效的起止时间');
  return {from:start,to:end};
}
export function memoryControlPayload(operation: MemoryControl['operation'], item?: {id:string;revision:number}, content?: string, restore = false): Omit<MemoryControl,'id'> {
  if (operation === 'update' || operation === 'disable') {
    if (!item || !Number.isSafeInteger(item.revision) || item.revision < 1) throw new Error('请重新选择记忆');
    if (operation === 'update' && (!content?.trim() || content.length > 4000)) throw new Error('记忆内容必须为 1 至 4000 字符');
    return {operation,memoryId:item.id,expectedRevision:item.revision,...(operation==='update'?{content:content!.trim(),...(restore?{restore:true}:{})}:{})};
  }
  return {operation};
}

export function memoryDetailEvents(view: MemoryView | null | undefined, jobId: string | null) {
  const result: MemoryView['events'] = []; const positions = new Map<string,number>();
  for (const event of view?.events ?? []) {
    if (event.jobId !== jobId) continue;
    const item = typeof event.payload.itemId === 'string' ? event.payload.itemId : undefined;
    const key = item && (event.type === 'thinking.updated' || event.type.startsWith('tool.')) ? `${event.type === 'thinking.updated' ? 'thinking' : 'tool'}:${item}` : undefined;
    const position = key ? positions.get(key) : undefined;
    if (position !== undefined) result[position] = {...event,payload:{...result[position]!.payload,...event.payload}};
    else {if(key)positions.set(key,result.length);result.push(event);}
  }
  return result;
}
