import type { BridgeStore } from './store.js';
import type { ScheduledInput, ScheduledTask } from './scheduled-contract.js';

function localParts(time:number,timezone:string):number[] {
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(time);
 const get=(type:string)=>Number(parts.find(part=>part.type===type)!.value);
 return ['year','month','day','hour','minute','second'].map(get);
}
function dayStart(time:number,timezone:string,days=0):number {
 const [year,month,day]=localParts(time,timezone) as [number,number,number];
 const civil=Date.UTC(year,month-1,day+days);let candidate=civil;
 for(let i=0;i<5;i++) {
  const [y,m,d,h,min,s]=localParts(candidate,timezone) as [number,number,number,number,number,number];
  const difference=Date.UTC(y,m-1,d,h,min,s)-civil;if(!difference)break;candidate-=difference;
 }
 return candidate;
}
export function taskHistoryRange(task:ScheduledTask,scheduledAt:number):{from:number;to:number} {
 const selector=task.context.chatHistory;if(!selector)throw new Error('TASK_HISTORY_DISABLED');
 if(selector.range==='rolling')return {from:scheduledAt-(selector.hours??24)*3600_000,to:scheduledAt};
 const midnight=dayStart(scheduledAt,task.schedule.timezone);
 return selector.range==='previous_day'?{from:dayStart(scheduledAt,task.schedule.timezone,-1),to:midnight}:{from:midnight,to:scheduledAt};
}
/** Read a synchronous local snapshot; budget conservatively by UTF-8 bytes (at least one byte per token). */
export function buildTaskHistory(store:BridgeStore,task:ScheduledTask,scheduledAt:number,modelBudget=20000):ScheduledInput['context'] {
 const selector=task.context.chatHistory;if(!selector)return {};
 const {from,to}=taskHistoryRange(task,scheduledAt);
 const {messages,availableCount}=store.readTaskChat(from,to,selector.includeBotReplies,selector.maxMessages,task.id);
 const budget=Math.max(0,Math.min(selector.maxInputTokens,modelBudget));
 let remaining=budget;const selected:typeof messages=[];
 for(const message of [...messages].reverse()) {
  const size=Buffer.byteLength(JSON.stringify(message))+1;
  if(size>remaining)break;
  selected.push(message);remaining-=size;
 }
 selected.reverse();const truncated=selected.length<availableCount;
 return {chatMessages:selected,chatCoverage:{from,to,availableCount,includedCount:selected.length,truncated,coverage:truncated?'latest_messages_in_range':'complete'}};
}
