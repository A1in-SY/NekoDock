import type { ConsoleEvent } from '../../src/console/contracts';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === 'string' ? value : '';

/** Project real platform identities; source-message associations are never quote targets. */
export function messageStateDisplay(items: ConsoleEvent[], events: ConsoleEvent[]): ConsoleEvent[] {
  const recalled = new Map<string, number>();
  const logicalRecalls=new Map<string,{recalled:number;cancelled:number;total:number}>();
  const cancellations=new Map<string,Set<number>>();
  const known = new Map<string, {messageId: string; senderName: string; text: string; recalled?: boolean}>();
  for (const event of events) {
    const p = event.payload, id = text(p.messageId) || text(p.qqMessageId);
    if (id && (event.type === 'message.recalled' || p.recalled === true))
      recalled.set(id, typeof p.recalledAt === 'number' ? p.recalledAt : typeof p.time === 'number' ? p.time : event.time / 1000);
    if(event.type==='message.recalled'&&typeof p.messageRef==='string'&&typeof p.logicalRecallCount==='number'&&typeof p.logicalPartCount==='number')
      logicalRecalls.set(p.messageRef,{recalled:p.logicalRecallCount,cancelled:typeof p.logicalCancelledCount==='number'?p.logicalCancelledCount:0,total:p.logicalPartCount});
    if(event.type==='delivery.cancelled'&&typeof p.requestId==='string'&&typeof p.logicalMessageIndex==='number'&&typeof p.partIndex==='number') {
      const key=JSON.stringify([p.requestId,p.logicalMessageIndex]),parts=cancellations.get(key)??new Set<number>();parts.add(p.partIndex);cancellations.set(key,parts);
    }
    if (id && (event.type === 'message.received' || event.type === 'incoming' || event.type === 'plugin.message.sent'))
      known.set(id, {messageId:id,senderName:text(p.senderName) || (event.type === 'plugin.message.sent' ? '机器人' : 'QQ 用户'),text:text(p.text).slice(0,240),...(p.recalled===true?{recalled:true}:{})});
  }
  for (const event of items) if (event.type === 'reply.accepted') {
    const messages = Array.isArray(event.payload.messages) ? event.payload.messages : [];
    for (const raw of Array.isArray(event.payload.deliveries) ? event.payload.deliveries : []) {
      const d=object(raw), id=text(d.messageId), index=typeof d.logicalMessageIndex==='number'?d.logicalMessageIndex:messages.length===1?0:-1;
      const m=object(messages[index]);
      const body=m.type==='message'&&Array.isArray(m.segments)?m.segments.map(s=>text(object(s).text)).join(''):text(m.text);
      if(id)known.set(id,{messageId:id,senderName:'机器人',text:body.slice(0,240),...(d.recalled===true?{recalled:true}:{})});
      if(id&&d.recalled===true)recalled.set(id,typeof d.recalledAt==='number'?d.recalledAt:event.time/1000);
    }
  }
  const preview=(id:unknown,fallback:unknown) => {
    if(typeof id!=='string'||!id)return undefined;
    const stored=object(fallback), source=known.get(id);
    return {messageId:id,senderName:source?.senderName||text(stored.senderName),text:source?.text||text(stored.text).slice(0,240),
      recalled:recalled.has(id)||source?.recalled===true||stored.recalled===true};
  };
  return items.map(event=>{
    const p=event.payload;
    if(event.type==='reply.accepted'&&Array.isArray(p.messages)) {
      const deliveries=(Array.isArray(p.deliveries)?p.deliveries:[]).map(object);
      const counts=Array.isArray(p.partCounts)?p.partCounts:[];
      const refs=Array.isArray(p.messageRefs)?p.messageRefs:[];
      const messages=p.messages.map((raw,index)=>{
        const m=object(raw), attached=deliveries.filter(d=>d.logicalMessageIndex===index||p.messages instanceof Array&&p.messages.length===1&&d.logicalMessageIndex===undefined);
        const summary=object(m.deliverySummary);
        const live=logicalRecalls.get(text(refs[index]));
        const withdrawn=Math.max(live?.recalled??0,typeof summary.recalledParts==='number'?summary.recalledParts:0,attached.filter(d=>d.recalled===true||recalled.has(text(d.messageId))).length);
        const cancelled=Math.max(live?.cancelled??0,typeof summary.cancelledParts==='number'?summary.cancelledParts:0,cancellations.get(JSON.stringify([p.requestId,index]))?.size??0);
        const expected=typeof counts[index]==='number'?counts[index] as number:live?.total??(typeof summary.totalParts==='number'?summary.totalParts:undefined);
        const quoted=preview(m.replyTo,m.replyPreview);
        return {...m,...(quoted?{replyPreview:quoted}:{}),...(cancelled&&expected!==undefined&&cancelled===expected?{cancelled:true}:{}),
          ...(withdrawn?{recalled:expected!==undefined&&withdrawn+cancelled===expected,partiallyRecalled:expected===undefined||withdrawn+cancelled<expected,recalledPartCount:withdrawn}:{} )};
      });
      return {...event,payload:{...p,messages}};
    }
    if(event.type==='message.received'||event.type==='incoming'||event.type==='plugin.message.sent') {
      const id=text(p.messageId)||text(p.qqMessageId), time=recalled.get(id), quoted=preview(p.replyTo,p.replyPreview);
      return {...event,payload:{...p,...(time===undefined?{}:{recalled:true,recalledAt:time}),...(quoted?{replyPreview:quoted}:{})}};
    }
    return event;
  });
}
