import { createHash } from 'node:crypto';
import type { ChatRecallEvent } from './chat-context-contract.js';
import type { Target } from './types.js';

const id=(value:unknown):string|undefined=>typeof value==='string'&&value.length>0&&value.length<=200?value:
  typeof value==='number'&&Number.isSafeInteger(value)?String(value):undefined;

/** Direct connections use their fixed target; managed connections receive Console-verified events. */
export function incomingRecall(event:unknown,target:Target,knownMessage:(messageId:string)=>boolean):ChatRecallEvent|null {
  if(!event||typeof event!=='object'||Array.isArray(event))return null;
  const p=event as Record<string,unknown>;
  if(p.post_type!=='notice'||p.notice_type!==(target.type==='group'?'group_recall':'friend_recall'))return null;
  const messageId=id(p.message_id),account=id(p.self_id),author=id(p.user_id);
  if(!messageId||!account||!author||typeof p.time!=='number'||!Number.isFinite(p.time)||p.time<0)return null;
  if(target.type==='group'&&id(p.group_id)!==target.id)return null;
  if(target.type==='private'&&(author!==target.id&&author!==account||author===account&&!knownMessage(messageId)))return null;
  return {eventId:'recall:'+createHash('sha256').update(JSON.stringify([account,target.type,target.id,messageId])).digest('hex'),messageId,time:p.time,
    authorId:author,...(id(p.operator_id)?{operatorId:id(p.operator_id)}:{})};
}
