import type { ActivitySpan, ObservedProcessSample } from '../../src/activity-contract';

export function spanKey(span: Pick<ActivitySpan,'resourceId'|'botId'|'id'>):string {return `${span.resourceId}/${span.botId??''}/${span.id}`;}
export function activeActivities(spans:ActivitySpan[],at:number,to=at):ActivitySpan[]{
  const active=spans.filter(span=>span.startedAt<=to&&(span.endedAt??Infinity)>=at);
  const parents=new Set(active.filter(span=>span.parentId).map(span=>`${span.traceId}/${span.botId??''}/${span.parentId}`));
  return active.filter(span=>!parents.has(`${span.traceId}/${span.botId??''}/${span.id}`));
}
export function activityLane(span:ActivitySpan):string {
  if(span.kind==='run'&&span.name==='append')return '上下文';
  if(span.kind==='model')return '模型';
  if(span.kind==='render'||span.kind==='render_wait')return '渲染';
  if(span.kind==='command')return '命令';
  if(span.kind==='send'||span.name==='send_message'||span.name==='recall_message')return '发送';
  if(span.kind==='plugin'||span.kind==='download'||span.kind==='upload')return '插件';
  if(span.kind==='memory'||span.kind==='schedule'||span.kind==='compact')return '后台';
  return span.kind==='run'?'回复':'工具 / 准备';
}
export interface ActivityTrack {lane:string;spans:ActivitySpan[];}
export function activityTracks(spans:ActivitySpan[],from:number,to:number,now=Date.now()):ActivityTrack[] {
  const groups=new Map<string,ActivitySpan[]>();
  for(const span of spans){
    if(span.startedAt>to||(span.endedAt??now)<from)continue;
    // The execution root already represents the enclosing agent activity.
    if(span.kind==='run'&&span.runId&&(span.name==='run'||span.name==='append'&&span.id!==`run:${span.runId}`))continue;
    const lane=activityLane(span);groups.set(lane,[...(groups.get(lane)??[]),span]);
  }
  const result:ActivityTrack[]=[];
  for(const lane of ['回复','上下文','模型','插件','渲染','命令','发送','工具 / 准备','后台']){
    const tracks:Array<{end:number;row:ActivityTrack}>=[];
    for(const span of (groups.get(lane)??[]).sort((a,b)=>a.startedAt-b.startedAt)){
      const start=Math.max(from,span.startedAt),end=Math.max(start+Math.max(50,(to-from)*.006),Math.min(to,span.endedAt??now));
      let track=tracks.find(row=>row.end<start);
      if(!track){track={end,row:{lane,spans:[]}};tracks.push(track);}track.end=end;track.row.spans.push(span);
    }result.push(...tracks.map(track=>track.row));
  }return result;
}
export function nearbyProcesses(samples:ObservedProcessSample[],at:number,spans:ActivitySpan[],windowMs?:number):Array<{span:ActivitySpan;sample:ObservedProcessSample}> {
  const selected=new Map<string,{span:ActivitySpan;sample:ObservedProcessSample}>();
  const byId=new Map(spans.map(span=>[spanKey(span),span]));
  for(const sample of samples){
    const key=`${sample.resourceId}/${sample.botId??''}/${sample.spanId}`,span=byId.get(key);
    if(!span||sample.time<at-5000||sample.time>at+(windowMs??5000))continue;
    const previous=selected.get(key);
    if(!previous||(windowMs!==undefined?(sample.cpu??-1)>(previous.sample.cpu??-1):Math.abs(sample.time-at)<Math.abs(previous.sample.time-at)))selected.set(key,{span,sample});
  }return [...selected.values()].sort((a,b)=>(b.sample.cpu??-1)-(a.sample.cpu??-1));
}
export function traceAncestors(span:ActivitySpan,spans:ActivitySpan[]):ActivitySpan[] {
  const result=[span],seen=new Set([spanKey(span)]);let current=span;
  for(let depth=0;depth<30&&current.parentId;depth++){
    const parent=spans.find(value=>value.id===current.parentId&&value.botId===span.botId&&value.traceId===span.traceId);
    if(!parent||seen.has(spanKey(parent)))break;result.unshift(parent);seen.add(spanKey(parent));current=parent;
  }return result;
}
