import { useEffect, useMemo, useRef, useState } from 'react';
import { ACTIVITY_NAMES, type ActivitySpan, type ActivityTimeline, type MonitorResource } from '../../src/activity-contract';
import type { PublicBot } from '../../src/console/contracts';
import { api, errorText } from './api';
import { date, ErrorBox } from './ui';
import { activeActivities, activityTracks, nearbyProcesses, spanKey, traceAncestors } from './activity-state';

const states={running:'进行中',completed:'已完成',failed:'失败',cancelled:'已取消',interrupted:'已中断'};
const programs={bash:'Shell',browser:'浏览器',python:'Python',ffmpeg:'媒体处理',node:'Node.js',downloader:'下载器',other:'其他程序'};
export const activityColors=['#629b86','#9882bd','#cc9b6c','#7e9db7','#b87e89','#98aa67'];
const elapsed=(raw:number)=>{const value=Math.max(0,raw);return value<1000?Math.round(value)+' ms':value<60000?(value/1000).toFixed(1)+' 秒':(value/60000).toFixed(1)+' 分钟';};

export function ActivityTimelineView({bots,resources,range,at,onInspect,onZoom,step,refreshNonce,botFilter,resourceFilter,onBotFilter,onResourceFilter}:{
  bots:PublicBot[];resources:MonitorResource[];range:{from:number;to:number};at:number|null;onInspect:(at:number|null)=>void;refreshNonce:number;
  botFilter:string;resourceFilter:string;onBotFilter:(id:string)=>void;onResourceFilter:(id:string)=>void;
  step:number;onZoom:(from:number,to:number)=>void;
}){
  const [data,setData]=useState<ActivityTimeline|null>(null),[error,setError]=useState(''),[selected,setSelected]=useState<ActivitySpan|null>(null),[trace,setTrace]=useState<ActivityTimeline|null>(null),[traceError,setTraceError]=useState('');
  const request=useRef(0),traceRequest=useRef(0);
  const focus=Math.min(range.to,Math.max(range.from,at??range.to)),now=Math.min(Date.now(),range.to),width=range.to-range.from;
  useEffect(()=>{
    const seq=++request.current,query=new URLSearchParams({from:String(range.from),to:String(range.to),at:String(focus),window:String(step)});
    if(botFilter)query.set('botId',botFilter);if(resourceFilter)query.set('resourceId',resourceFilter);
    void api<ActivityTimeline>('/api/monitor/timeline?'+query).then(value=>{if(seq===request.current){setData(value);setError('');}}).catch(error=>{if(seq===request.current)setError(errorText(error));});
    return()=>{request.current++;};
  },[range.from,range.to,focus,step,refreshNonce,botFilter,resourceFilter]);
  const selectedKey=selected?spanKey(selected):'';
  useEffect(()=>{
    const seq=++traceRequest.current;if(!selected){setTrace(null);setTraceError('');return;}
    const query=new URLSearchParams({from:String(Math.max(Date.now()-31*86400000,Math.min(selected.startedAt,focus)-86400000,0)),to:String(Date.now()+1),at:String(focus),window:String(step),traceId:selected.traceId});
    if(selected.botId)query.set('botId',selected.botId);
    void api<ActivityTimeline>('/api/monitor/timeline?'+query).then(value=>{if(seq===traceRequest.current){setTrace(value);setTraceError('');}}).catch(error=>{if(seq===traceRequest.current)setTraceError(errorText(error));});
    return()=>{traceRequest.current++;};
  },[selectedKey,focus,step,refreshNonce,range.to]);
  useEffect(()=>{setSelected(null);setTrace(null);},[botFilter,resourceFilter]);
  const tracks=useMemo(()=>activityTracks(data?.spans??[],range.from,range.to),[data?.spans,range.from,range.to]);
  const resourceName=(id:string)=>resources.find(value=>value.id===id)?.name??'历史实例';
  const botName=(id:string|null)=>bots.find(value=>value.id===id)?.name??'共享服务';
  const color=(id:string)=>activityColors[Math.max(0,resources.findIndex(value=>value.id===id))%activityColors.length]!;
  const all=trace?.spans??data?.spans??[],current=selected?(all.find(span=>spanKey(span)===selectedKey)??selected):null;
  const candidates=current?all.filter(span=>span.traceId===current.traceId&&span.botId===current.botId):data?.spans??[];
  const evidence=nearbyProcesses([...(data?.processes??[]),...(trace?.processes??[])],focus,candidates,step);
  const windowFrom=Math.max(range.from,focus-5000),windowTo=Math.min(range.to,focus+step),active=activeActivities(data?.spans??[],windowFrom,windowTo);
  const choose=(span:ActivitySpan)=>{setSelected(span);onInspect(Math.min(now,Math.max(range.from,span.startedAt+(Math.min(span.endedAt??now,range.to)-span.startedAt)/2)));};
  return <section className="mon-activity-panel" aria-label="执行时间线">
    <header className="mon-activity-heading"><div><h2>执行时间线</h2><p>点击曲线选取时刻，点击阶段查看完整过程和进程采样。</p></div>
      <div className="mon-activity-filters"><label>实例<select value={botFilter} onChange={event=>onBotFilter(event.target.value)}><option value="">全部实例</option>{bots.map(bot=><option key={bot.id} value={bot.id}>{bot.name}</option>)}</select></label>
      <label>执行位置<select value={resourceFilter} onChange={event=>onResourceFilter(event.target.value)}><option value="">全部位置</option>{resources.map(resource=><option key={resource.id} value={resource.id}>{resource.name}</option>)}</select></label></div>
    </header>
    {error&&<ErrorBox error={error}/>}
    {(data?.truncated||data?.processTruncated)&&<p className="mon-activity-notice">当前结果达到查询上限，请缩小时间范围或选择实例。</p>}
    <div className="mon-activity-axis"><span/>{[0,.25,.5,.75,1].map(fraction=><time key={fraction} style={{left:`${fraction*100}%`}}>{date(range.from+width*fraction,{year:undefined,month:undefined,day:undefined,...(width<300000?{second:'2-digit' as const}:{})})}</time>)}</div>
    <div className="mon-activity-tracks">
      {!tracks.length&&<p className="mon-activity-empty">{data?'此时间范围尚无执行阶段记录。':'正在加载执行阶段…'}</p>}
      {tracks.map((track,index)=><div className="mon-activity-row" key={track.lane+':'+index}><span className="mon-activity-lane">{index===0||tracks[index-1]?.lane!==track.lane?track.lane:''}</span><div className="mon-activity-track">
        {track.spans.map(span=>{const left=Math.max(0,(span.startedAt-range.from)/width*100),length=Math.max(0,(Math.min(span.endedAt??now,range.to)-Math.max(span.startedAt,range.from))/width*100),label=ACTIVITY_NAMES[span.name]+(span.requestIndex?' #'+span.requestIndex:'');return <button type="button" className={'mon-activity-span '+(span.status==='running'?'running ':'')+(selectedKey===spanKey(span)?'selected':'')} key={spanKey(span)}
          style={{left:left+'%',width:length+'%',backgroundColor:color(span.resourceId)}} onClick={()=>choose(span)}
          title={`${botName(span.botId)} · ${resourceName(span.resourceId)} · ${label} · ${states[span.status]} · ${elapsed((span.endedAt??now)-span.startedAt)}`}
          aria-label={`${botName(span.botId)}，${label}，${states[span.status]}`} aria-pressed={selectedKey===spanKey(span)}>{length>10?label:''}</button>;})}
        {focus>=range.from&&focus<=range.to&&<i className="mon-activity-cursor" style={{left:(focus-range.from)/width*100+'%'}}/>}
      </div></div>)}
    </div>
    <div className="mon-activity-detail">
      <div className="mon-activity-selection"><strong>{date(focus,{second:'2-digit'})}</strong><span>相关时段内 {active.length} 个执行阶段</span><button className="mon-button" onClick={()=>onZoom(windowFrom,windowTo)}>放大此时段</button>{at!==null&&<button className="mon-button" onClick={()=>onInspect(null)}>跟随最新时刻</button>}</div>
      {current?<>
        <div className="mon-activity-path">{traceAncestors(current,all).map((span,index)=><span key={spanKey(span)}>{index>0?' → ':''}<button onClick={()=>setSelected(span)}>{ACTIVITY_NAMES[span.name]}</button></span>)}</div>
        <dl className="mon-activity-facts"><div><dt>所属实例</dt><dd>{botName(current.botId)}</dd></div><div><dt>执行位置</dt><dd>{resourceName(current.resourceId)}</dd></div><div><dt>状态 / 耗时</dt><dd>{states[current.status]} · {elapsed((current.endedAt??now)-current.startedAt)}</dd></div>
          {current.requestIndex!==undefined&&<div><dt>模型请求</dt><dd>第 {current.requestIndex} 次 · {current.firstEventMs===undefined?(current.status==='running'?'等待首个流事件':'未收到有效流事件'):'首个流事件 '+elapsed(current.firstEventMs)}</dd></div>}</dl>
        {current.count!==undefined&&<p className="mon-activity-note">{current.name==='image_render'?'生成图片':'输出数量'}：{current.count}{current.name==='image_render'?' 张':''}</p>}
        {current.kind==='model'&&<p className="mon-activity-note">这里记录本机与模型接口的交互时间；上游排队、推理和网络等待无法进一步区分。</p>}
        {current.errorCode&&<p className="field-error">{current.errorCode}</p>}
        <div className="mon-activity-links">{current.botId&&<a href={'#bot/'+encodeURIComponent(current.botId)}>查看实例会话</a>}{current.botId&&current.jobId&&<a href={'#bot/'+encodeURIComponent(current.botId)+'/plugins'}>查看插件作业</a>}</div>
        {traceError&&<ErrorBox error={traceError}/>}
        {trace&&<details className="mon-activity-trace"><summary>完整执行过程 · {trace.spans.length} 个阶段{trace.truncated?'（已截断）':''}</summary><ol>{trace.spans.map(span=><li key={spanKey(span)}><button onClick={()=>choose(span)}>{ACTIVITY_NAMES[span.name]}{span.requestIndex?' #'+span.requestIndex:''}</button><span>{states[span.status]} · {elapsed((span.endedAt??now)-span.startedAt)}</span><time>{date(span.startedAt,{year:undefined,month:undefined,day:undefined,second:'2-digit'})}</time></li>)}</ol></details>}
      </>:<p className="mon-activity-note">{active.length?'点击上方阶段，展开所属任务和完整过程。':'选中时刻没有记录到活动。已有资源曲线可继续查看；阶段记录从本版本开始采集。'}</p>}
      <h3>进程证据 <small>{date(windowFrom,{year:undefined,month:undefined,day:undefined,second:'2-digit'})} — {date(windowTo,{year:undefined,month:undefined,day:undefined,second:'2-digit'})}</small></h3>
      {!evidence.length?<p className="mon-activity-note">此窗口没有关联的进程采样。同期活动只说明时间重叠；短任务、历史数据或采样缺失均不会推定为零消耗。</p>:<div className="mon-process-list">{evidence.map(({span,sample})=><article key={spanKey(span)}><header><button onClick={()=>setSelected(span)}>{ACTIVITY_NAMES[span.name]}</button><span>{resourceName(sample.resourceId)}{sample.resourceId!==sample.botId?' · '+botName(sample.botId):''}</span><strong>{sample.cpu===null?'未采到有效计数':sample.cpu.toFixed(1)+'% CPU'}</strong></header>
        <p>{sample.coverage==='sampled'?(sample.scope==='self'?'仅此主进程，不含子进程':'采样到的进程树'):'采样不完整'} · {date(sample.time,{year:undefined,month:undefined,day:undefined,second:'2-digit'})} · 窗口 {elapsed(sample.intervalMs)} · 100% = 一个核心</p>
        {!!sample.processes.length&&<ul>{sample.processes.map(process=><li key={process.pid+':'+process.startTime}>{programs[process.program]} · PID {process.pid}<span>{process.cpu.toFixed(1)}%</span></li>)}</ul>}</article>)}</div>}
      <p className="mon-activity-note">每个阶段展示相关时段内最高一次进程采样，包含选中指标分桶及前 5 秒。进程与容器的采样窗口分别展示；共享进程和未关联开销保留在容器总量中。{data?.droppedProcessSamples?` 累计有 ${data.droppedProcessSamples} 条进程采样因缓冲区限制被丢弃。`:''}</p>
    </div>
  </section>;
}
