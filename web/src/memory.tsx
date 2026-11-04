import { useCallback, useEffect, useRef, useState } from 'react';
import type { PublicBot } from '../../src/console/contracts';
import type { MemoryControl, MemoryItem } from '../../src/memory-contract';
import { api, errorText, post } from './api';
import { date, Empty, ErrorBox, Icon, Notice } from './ui';
import { memoryControlPayload, memoryDetailEvents, memoryFilteredItems, memoryJobStates, memoryListPage, memoryLocalTime, memoryRange, memoryReasons, memoryStates, type MemoryPage } from './memory-state';
import './memory.css';
const kindLabels={fact:'事实',preference:'偏好',event:'经历'};
const operationLabels={run:'立即整理',backfill:'历史回填',cancel:'取消整理',update:'修改记忆',disable:'停用记忆',retry:'继续失败作业'};

function MemoryPagination({label,listing,onPage,pageSize,onPageSize}:{
  label:string;listing:{page:number;pages:number;total:number;start:number;end:number};onPage:(page:number)=>void;
  pageSize?:number;onPageSize?:(size:number)=>void;
}) {
  return <nav className="memory-pagination" aria-label={label}>
    <span className="memory-pagination-count" aria-live="polite">共 {listing.total} 条{listing.total>0&&` · 第 ${listing.start}–${listing.end} 条`}</span>
    <div className="memory-pagination-actions">
      {onPageSize&&<label>每页<select aria-label="每页记忆条数" value={pageSize} onChange={event=>onPageSize(Number(event.target.value))}>{[12,24,48].map(size=><option key={size} value={size}>{size} 条</option>)}</select></label>}
      <button className="btn small" disabled={listing.page===1} onClick={()=>onPage(listing.page-1)} aria-label={`${label}上一页`}>上一页</button>
      <span className="memory-pagination-position">第 {listing.page} / {listing.pages} 页</span>
      <button className="btn small" disabled={listing.page===listing.pages} onClick={()=>onPage(listing.page+1)} aria-label={`${label}下一页`}>下一页</button>
    </div>
  </nav>;
}

export function Memory({bot,notify}:{bot:PublicBot;notify:(text:string,error?:boolean)=>void}) {
  const [page,setPage]=useState<MemoryPage|null>(null),[error,setError]=useState(''),[connected,setConnected]=useState(false),[pending,setPending]=useState(false);
  const [query,setQuery]=useState(''),[inactive,setInactive]=useState(false),[jobId,setJobId]=useState<string|null>(null);
  const [itemPage,setItemPage]=useState(1),[pageSize,setPageSize]=useState(12),[jobPage,setJobPage]=useState(1);
  const [restoring,setRestoring]=useState(false);
  const [editing,setEditing]=useState<MemoryItem|null>(null),[content,setContent]=useState(''),[disabling,setDisabling]=useState<MemoryItem|null>(null),[backfill,setBackfill]=useState(false);
  const [from,setFrom]=useState(()=>memoryLocalTime(Date.now()-7*86400_000)),[to,setTo]=useState(()=>memoryLocalTime(Date.now()));
  const generation=useRef(0),flight=useRef(false),dirty=useRef(false),controller=useRef<AbortController|null>(null);
  const itemsTop=useRef<HTMLDivElement|null>(null),jobsTop=useRef<HTMLElement|null>(null);
  const path=`/api/bots/${encodeURIComponent(bot.id)}/memory`;
  const refresh=useCallback(async()=>{
    if(flight.current){dirty.current=true;return;}
    flight.current=true;const current=++generation.current;const abort=new AbortController();controller.current=abort;
    try {const data=await api<MemoryPage>(path,{signal:abort.signal});if(current===generation.current){setPage(data);setError('');}}
    catch(error){if(!abort.signal.aborted&&current===generation.current)setError(errorText(error));}
    finally {flight.current=false;if(controller.current===abort)controller.current=null;if(dirty.current&&!abort.signal.aborted){dirty.current=false;queueMicrotask(()=>void refresh());}}
  },[path]);
  useEffect(()=>{void refresh();return()=>{generation.current++;controller.current?.abort();};},[refresh]);
  useEffect(()=>{
    const events=new EventSource('/api/stream');let timer:ReturnType<typeof setTimeout>|undefined;
    const change=(event:MessageEvent)=>{
      try {const value=JSON.parse(event.data) as {botIds?:string[];type?:string};if(value.type!=='connected'&&value.botIds?.length&&!value.botIds.includes(bot.id))return;}catch{/* Reconnect invalidates the snapshot. */}
      if(!timer)timer=setTimeout(()=>{timer=undefined;void refresh();},750);
    };
    events.addEventListener('change',change as EventListener);events.onopen=()=>{setConnected(true);void refresh();};events.onerror=()=>setConnected(false);
    return()=>{events.close();clearTimeout(timer);};
  },[bot.id,refresh]);
  const control=async(payload:Omit<MemoryControl,'id'>)=>{
    setPending(true);
    try {await post(path+'/controls',payload);setEditing(null);setDisabling(null);setBackfill(false);notify('操作已排队，等待实例处理');await refresh();}
    catch(error){notify(errorText(error),true);}finally{setPending(false);}
  };
  const view=page?.view;
  const items=memoryListPage(memoryFilteredItems(view?.items??[],query,inactive),itemPage,pageSize);
  const jobs=memoryListPage(view?.jobs??[],jobPage,10);
  useEffect(()=>{if(itemPage!==items.page)setItemPage(items.page);},[itemPage,items.page]);
  useEffect(()=>{if(jobPage!==jobs.page)setJobPage(jobs.page);},[jobPage,jobs.page]);
  const changeItemPage=(next:number)=>{setItemPage(next);itemsTop.current?.scrollIntoView({block:'start'});};
  const changeJobPage=(next:number)=>{setJobPage(next);setJobId(null);jobsTop.current?.scrollIntoView({block:'start'});};
  const selectedJob=view?.jobs.find(job=>job.id===jobId);
  const jobEvents=memoryDetailEvents(view,jobId);
  const outstanding=page?.controls.filter(command=>command.status==='pending')??[];
  return <div className="memory-page">
    <div className="memory-heading"><div><h2>长期记忆</h2><p>按人物保存事实、偏好和经历，在相关对话中按需回忆。</p></div><div className="heading-actions"><button className="btn" onClick={()=>void refresh()}><Icon name="refresh"/>刷新</button><button className="btn" disabled={pending||!bot.config.memoryEnabled} onClick={()=>setBackfill(true)}><Icon name="calendar"/>回填历史</button><button className="btn primary" disabled={pending||!bot.config.memoryEnabled} onClick={()=>void control({operation:'run'})}><Icon name="spark"/>现在整理</button></div></div>
    {error&&<ErrorBox error={error} retry={()=>void refresh()}/>}
    {!bot.config.memoryEnabled&&<Notice>长期记忆已关闭。可以在实例配置的“长期记忆”中启用；已有记忆继续保留。</Notice>}
    <div className="memory-overview"><span><i className={'status-dot '+(connected?'':'off')}/>{connected?'实时更新':'重新连接中'}</span><span>{view?.truncated?'已同步 ':''}{view?.items.filter(item=>item.status==='active').length??0} 条有效记忆</span><span>{view?.jobs.some(job=>job.status==='running')?'正在后台整理 · 聊天照常进行':'后台整理空闲'}</span><span>{page?.updatedAt?`同步于 ${date(page.updatedAt)}`:'等待实例同步'}</span></div>
    {view?.truncated&&<Notice>当前展示部分记忆和整理记录{view.totalItems!==undefined?`，共 ${view.totalItems} 条记忆`:''}。此处搜索仅筛选已同步的条目，完整数据仍保存在实例中。</Notice>}
    {outstanding.length>0&&<Notice>{outstanding.length} 项管理操作待处理。实例完成操作后会自动更新。</Notice>}
    <div className="memory-filters" ref={itemsTop}><div className="search-input"><Icon name="search"/><input type="search" placeholder="搜索内容、主题或用户 ID" aria-label="搜索长期记忆" value={query} onChange={event=>{setQuery(event.target.value);setItemPage(1);}}/></div><label><input type="checkbox" checked={inactive} onChange={event=>{setInactive(event.target.checked);setItemPage(1);}}/>显示已停用和被替代的记忆</label></div>
    {!items.total?<Empty title={page?'还没有匹配的记忆':'正在加载记忆…'}><p>整理器会在设定时间或会话成功压缩后运行。已有聊天可以通过“回填历史”整理。</p></Empty>:<div className="memory-grid">{items.items.map(item=><article key={item.id} className="panel memory-item"><div className="memory-item-top"><span className="code-tag">{kindLabels[item.kind]} · {item.scope==='person'?`用户 ${item.subjectUserId}`:'会话公共背景'}</span><span className={'memory-status '+item.status}>{memoryStates[item.status]}</span></div><h3>{item.topic}</h3><p className="memory-content">{item.content}</p><div className="memory-item-meta"><span>更新于 {date(item.updatedAt)}</span><span>v{item.revision}</span>{item.validTo&&<span>有效至 {date(item.validTo)}</span>}</div><details className="memory-sources"><summary>{item.sources.length} 条来源</summary>{item.sources.map((source,index)=><blockquote key={source.sourceId+index}><p>{source.quote}</p><small>{source.sourceId}</small></blockquote>)}</details><div className="memory-item-actions"><button className="btn small" disabled={pending} onClick={()=>{setRestoring(false);setEditing(item);setContent(item.content);}}>修改</button>{item.status==='disabled'&&<button className="btn small" disabled={pending} onClick={()=>{setRestoring(true);setEditing(item);setContent(item.content);}}>重新启用</button>}<button className="btn small" disabled={pending||item.status==='disabled'} onClick={()=>setDisabling(item)}>停用</button></div></article>)}</div>}
    {page&&<MemoryPagination label="记忆分页" listing={items} onPage={changeItemPage} pageSize={pageSize} onPageSize={size=>{setPageSize(size);changeItemPage(1);}}/>}
    <section className="panel memory-jobs" ref={jobsTop}><div className="section-heading"><h3>整理记录</h3><button className="btn small" disabled={pending||!view?.jobs.some(job=>job.status==='running'||job.status==='pending')} onClick={()=>void control({operation:'cancel'})}>取消整理</button></div>{!view?.jobs.length?<p className="memory-muted">还没有整理作业。</p>:jobs.items.map(job=><div key={job.id} className={'memory-job '+(jobId===job.id?'selected':'')}><button className="memory-job-select" onClick={()=>setJobId(jobId===job.id?null:job.id)}><span>{memoryReasons[job.reason]}<small>{date(job.createdAt)}</small></span><span>{memoryJobStates[job.status]}<small>进度 {job.processedSeq} / {job.throughSeq}</small></span><Icon name="down"/></button>{jobId===job.id&&<div className="memory-job-details">{selectedJob?.error&&<p className="field-error">{selectedJob.error}</p>}{selectedJob?.status==='failed'&&<button className="btn small" disabled={pending||!bot.config.memoryEnabled} onClick={()=>void control({operation:'retry',jobId:selectedJob.id})}>从已保存进度继续</button>}{!jobEvents.length?<p>暂无执行详情。</p>:jobEvents.map(event=><details key={event.seq}><summary>{date(event.time)} · {event.type==='thinking.updated'?'思考':event.type==='usage.recorded'?'Token 用量':event.type.startsWith('tool.')?'工具调用':event.type}</summary><pre>{typeof event.payload.text==='string'?event.payload.text:JSON.stringify(event.payload,null,2)}</pre></details>)}</div>}</div>)}{jobs.total>0&&<MemoryPagination label="整理记录分页" listing={jobs} onPage={changeJobPage}/>}</section>
    {!!page?.controls.length&&<section className="panel memory-controls"><h3>管理操作</h3>{page.controls.slice(0,10).map(command=><div key={command.id}><span>{operationLabels[command.operation]} · {date(command.createdAt)}</span><span>{command.status==='pending'?'待处理':command.status==='completed'?'已完成':`失败 · ${command.error??'请查看实例日志'}`}</span></div>)}</section>}
    {(editing||disabling||backfill)&&<div className="modal-backdrop" onClick={()=>{if(!pending){setEditing(null);setDisabling(null);setBackfill(false);}}}><section className="modal memory-modal" role="dialog" aria-modal="true" aria-labelledby="memory-dialog-title" onClick={event=>event.stopPropagation()}><h2 id="memory-dialog-title">{editing?(restoring?'重新启用记忆':'修改记忆'):disabling?'停用记忆':'回填历史'}</h2>{editing?<><p>{restoring?'重新启用会解除这条记忆的自动学习限制，并恢复相关对话中的召回；旧来源排除规则继续保留。':'修改会排队交给实例处理，完成后更新版本。'}</p><textarea aria-label="记忆内容" value={content} onChange={event=>setContent(event.target.value)} maxLength={4000}/></>:disabling?<><p>停止自动召回和重新学习这条记忆。原始聊天记录仍保留，当前对话中也可能已经出现过相关内容。</p><blockquote>{disabling.content}</blockquote></>:<><p>选择需要整理的原始聊天范围。后台处理不会占用主会话；时间为 UTC+08:00。</p><label>开始时间<input type="datetime-local" value={from} onChange={event=>setFrom(event.target.value)}/></label><label>结束时间<input type="datetime-local" value={to} onChange={event=>setTo(event.target.value)}/></label></>}<div className="modal-actions"><button className="btn" disabled={pending} onClick={()=>{setEditing(null);setDisabling(null);setBackfill(false);}}>取消</button><button className="btn primary" disabled={pending} onClick={()=>{try {void control(editing?memoryControlPayload('update',editing,content,restoring):disabling?memoryControlPayload('disable',disabling):{operation:'backfill',...memoryRange(from,to)});}catch(error){notify(errorText(error),true);}}}>{pending?'提交中…':'提交操作'}</button></div></section></div>}
  </div>;
}
