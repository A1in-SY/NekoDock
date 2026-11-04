import { Cron } from 'croner';
import type { ScheduledTaskInput, TaskSchedule } from './scheduled-contract.js';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('任务配置必须为对象');
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`任务${label}无效`);
  return value.trim();
}
function integer(value: unknown, fallback: number, min: number, max: number): number {
  const n = value === undefined ? fallback : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) throw new Error('任务数值超出允许范围');
  return n;
}
function boolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error('任务开关必须为布尔值');
  return value;
}
export function validateSchedule(value: unknown): TaskSchedule {
  const input = object(value); const timezone = text(input.timezone ?? 'Asia/Shanghai', '时区', 100);
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(); } catch { throw new Error('任务时区无效'); }
  if (input.kind === 'once') {
    const at = text(input.at, '执行时间', 100);
    if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(at) || !Number.isFinite(Date.parse(at))) throw new Error('任务时间必须包含时区偏移');
    return {kind: 'once', at: new Date(at).toISOString(), timezone};
  }
  if (input.kind !== 'cron') throw new Error('任务计划类型无效');
  const expression = text(input.expression, 'Cron 表达式', 200);
  try { const cron = new Cron(expression, {timezone, mode: '5-part', paused: true}); cron.stop(); }
  catch { throw new Error('任务 Cron 表达式无效，请使用五段分钟级表达式'); }
  return {kind: 'cron', expression, timezone};
}
export function nextTaskTime(task: {schedule: TaskSchedule}, after: number): number | null {
  if (task.schedule.kind === 'once') { const at = Date.parse(task.schedule.at); return at > after ? at : null; }
  const cron = new Cron(task.schedule.expression, {timezone: task.schedule.timezone, mode: '5-part', paused: true});
  try { return cron.nextRun(new Date(after))?.getTime() ?? null; } finally { cron.stop(); }
}
export function previousTaskTime(task: {schedule: TaskSchedule}, before: number): number | null {
  if (task.schedule.kind === 'once') { const at=Date.parse(task.schedule.at); return at <= before ? at : null; }
  const cron = new Cron(task.schedule.expression, {timezone: task.schedule.timezone, mode: '5-part', paused: true});
  try { const at=cron.previousRuns(1,new Date(Math.floor(before/1000)*1000+1000))[0]?.getTime(); return at!==undefined&&at<=before?at:null; } finally { cron.stop(); }
}
export function nextTaskRuns(task: {schedule: TaskSchedule}, after=Date.now(), count=3): number[] {
  const result:number[]=[]; let cursor=after;
  for(let i=0;i<count;i++){const next=nextTaskTime(task,cursor);if(next===null)break;result.push(next);cursor=next;}
  return result;
}
export function validateTask(value: unknown, allowCommands=true, now=Date.now()): ScheduledTaskInput {
  const input=object(value); const kind=input.kind;
  if(kind!=='model'&&kind!=='script')throw new Error('任务类型无效');
  const schedule=validateSchedule(input.schedule);
  if(schedule.kind==='once'&&Date.parse(schedule.at)<=now)throw new Error('任务执行时间必须晚于当前时间');
  let script:ScheduledTaskInput['script']=null;
  if(kind==='script') {
    if(!allowCommands)throw new Error('任务脚本需要先启用实例的命令执行权限');
    const source=object(input.script);
    if(source.runtime!=='python'&&source.runtime!=='node')throw new Error('任务脚本运行时无效');
    if(typeof source.source!=='string'||!source.source.trim()||Buffer.byteLength(source.source)>128*1024)throw new Error('任务脚本须为非空文本，且不超过 128 KiB');
    script={runtime:source.runtime,source:source.source};
  }
  const ctx=object(input.context??{}); const taskState=boolean(ctx.taskState,false);
  let chatHistory:ScheduledTaskInput['context']['chatHistory'];
  if(ctx.chatHistory!==undefined&&ctx.chatHistory!==null){
    const h=object(ctx.chatHistory);
    if(!['scheduled_day','previous_day','rolling'].includes(String(h.range)))throw new Error('任务聊天时间范围无效');
    chatHistory={range:h.range as 'scheduled_day'|'previous_day'|'rolling',includeBotReplies:boolean(h.includeBotReplies,true),
      maxMessages:integer(h.maxMessages,2000,1,10000),maxInputTokens:integer(h.maxInputTokens,20000,100,100000),
      ...(h.range==='rolling'?{hours:integer(h.hours,24,1,24*31)}:{})};
  }
  return {name:text(input.name,'名称',120),kind,enabled:boolean(input.enabled,true),schedule,
    instructions:kind==='model'?text(input.instructions,'执行要求',16000):typeof input.instructions==='string'?input.instructions.slice(0,16000):'',script,
    context:{taskState,...(chatHistory?{chatHistory}:{})},maxDelaySeconds:integer(input.maxDelaySeconds,600,0,86400),
    timeoutSeconds:integer(input.timeoutSeconds,kind==='script'?120:600,1,3600),notifyOnFailure:boolean(input.notifyOnFailure,false)};
}
