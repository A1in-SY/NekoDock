import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ConsoleAuth } from './auth.js';
import type { ConsoleDatabase } from './database.js';
import type { DockerClient } from './docker.js';
import { SECRET_FIELDS } from './contracts.js';
import { formatLogTime } from '../logging.js';

export interface DockerLogLine { time:string; stream:'stdout'|'stderr'; message:string; }
export interface DockerLogSnapshot { sourceId:string; lines:DockerLogLine[]; truncated:boolean; }
export interface LogLine extends DockerLogLine { id:string; level:'info'|'warn'|'error'|'debug'|'unknown'; }
export interface LogSnapshot { sourceId:string; lines:LogLine[]; truncated:boolean; }

/** Docker's non-TTY log response is an 8-byte header followed by a binary payload.
 * Each stream has its own UTF-8 decoder because both headers and codepoints may
 * cross HTTP chunks or Docker frames. Retained data and individual lines are bounded. */
export class DockerLogDecoder {
 private bytes:Buffer=Buffer.alloc(0);
 private remaining=0;
 private stream:1|2=1;
 private rows:DockerLogLine[]=[];
 private states={1:{decoder:new StringDecoder('utf8'),pending:'',clipped:false},2:{decoder:new StringDecoder('utf8'),pending:'',clipped:false}};
 truncated=false;
 constructor(private readonly maxLines=501,private readonly maxLineChars=4096){}
 write(chunk:Buffer):void {
  this.bytes=this.bytes.length?Buffer.concat([this.bytes,chunk]):chunk;
  while(this.bytes.length){
   if(!this.remaining){
    if(this.bytes.length<8)return;
    const header=this.bytes.subarray(0,8);
    if(![1,2].includes(header[0]!)||header[1]!==0||header[2]!==0||header[3]!==0)throw new Error('Docker 日志帧无效');
    this.stream=header[0] as 1|2;this.remaining=header.readUInt32BE(4);this.bytes=this.bytes.subarray(8);
    if(this.remaining>2*1024*1024)throw new Error('Docker 日志帧超过限制');
    if(!this.remaining)continue;
   }
   const length=Math.min(this.remaining,this.bytes.length);
   this.consume(this.stream,this.states[this.stream].decoder.write(this.bytes.subarray(0,length)));
   this.bytes=this.bytes.subarray(length);this.remaining-=length;
  }
 }
 private consume(stream:1|2,text:string):void {
  const state=this.states[stream];
  for(const part of text.split(/(?<=\n)/u)){
   const newline=part.endsWith('\n');
   if(!state.clipped){
    state.pending+=part;
    if(state.pending.length>this.maxLineChars){state.pending=state.pending.slice(0,this.maxLineChars);state.clipped=true;this.truncated=true;}
   }
   if(newline){this.row(stream,state.pending,state.clipped);state.pending='';state.clipped=false;}
  }
 }
 private row(stream:1|2,text:string,clipped:boolean):void {
  const match=/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)) (.*)$/su.exec(text.replace(/[\r\n]+$/u,''));
  if(!match||!Number.isFinite(Date.parse(match[1]!)))return;
  this.rows.push({time:formatLogTime(new Date(match[1]!)),stream:stream===1?'stdout':'stderr',message:match[2]!+(clipped?' …':'')});
  if(this.rows.length>this.maxLines){this.rows.shift();this.truncated=true;}
 }
 finish():{lines:DockerLogLine[];truncated:boolean}{
  if(this.remaining||this.bytes.length)throw new Error('Docker 日志帧不完整');
  for(const stream of [1,2] as const){const state=this.states[stream];this.consume(stream,state.decoder.end());if(state.pending)this.row(stream,state.pending,state.clipped);}
  return {lines:this.rows.sort((a,b)=>Date.parse(a.time)-Date.parse(b.time)),truncated:this.truncated};
 }
}

// Only application metadata is shown here; raw Agent events, configuration dumps,
// chat content, tool arguments/results and stack traces are not log-page data.
const metadataFields=new Set(('botId revision action port through_seq count message_count reply_allowed resumed session_ref run_id stage reason failure duration_ms pid exit_code exit_signal stderr_bytes '+
 'attached_count failure_count text_count image_count segmented_count input_tokens cached_input_tokens output_tokens total_tokens type tool tool_ref tool_type tool_count status '+
 'request_ref run_ref start_index end_index delivery_id part_index reply_index message_index message_ref sender_ref message_seq trigger mentioned target_type inserted busy '+
 'bytes image_index direction source_type provider text_chars voice model probability selected enabled timeout_ms retry_ms waiter_count pending_count echo segment_count '+
 'error_code retcode code has_session cursor batch_size reply_count command_id kind result replayed draining signal connected sent_count attempted_count skipped_count '+
 'web_search_provider tts_provider target random_reply_probability queue_size processing item_hash item_type server server_hash tool_hash http_status source_count '+
 'next_reply_index total has_reply pending_command part_count delivery_status close_code ready_state operation api accepted_requests item_ref aborted mode timeout confirmation_only reconnecting').split(' '));
function safeMessage(raw:string,secrets:readonly string[]):{message:string;level:LogLine['level']}|null {
 const app=/^\d{4}-\d\d-\d\dT\S+ (INFO|WARN|ERROR|DEBUG) ([a-z][a-z0-9_.-]{0,100})(?: (.*))?$/u.exec(raw);
 let message:string,level:LogLine['level'];
 if(app){
  level=app[1]!.toLowerCase() as LogLine['level'];message=app[2]!;
  const fields=app[3]??'';
  for(const field of fields.matchAll(/(?:^| )([a-zA-Z][a-zA-Z0-9_]*)=("(?:[^"\\]|\\.)*"|true|false|null|-?\d+(?:\.\d+)?)(?= |$)/gu)){
   const key=field[1]!;
   if(!metadataFields.has(key))continue;
   let value=field[2]!;
   // Provider failures can echo user input. Agent diagnostics expose codes, never provider prose.
   if(app[2]!.startsWith('agent.')&&['reason','failure','result'].includes(key)){
    let decoded:unknown;try{decoded=JSON.parse(value);}catch{continue;}
    const code=typeof decoded==='string'?/^(PI_[A-Z0-9_]{1,60})(?::|\s|$)/u.exec(decoded)?.[1]:undefined;
    if(!code)continue;
    value=JSON.stringify(code);
   }
   message+=` ${key}=${value}`;
  }
 }else if(/^\(node:\d+\) (?:ExperimentalWarning: SQLite is an experimental feature|DeprecationWarning:)/u.test(raw)){
  // Node warning details can contain arbitrary paths/values. The warning class is sufficient.
  message=raw.includes('ExperimentalWarning:')?'Node ExperimentalWarning: SQLite is an experimental feature':'Node DeprecationWarning';level='warn';
 }else if(/^\d{4}-\d\d-\d\dT\S+ ERROR (?:NapCat WebSocket authentication failed; reconnecting|消息落库失败，停止实例；检查数据卷的可写权限和剩余空间|启动失败)$/u.test(raw)){
  message=raw.replace(/^\S+ ERROR /u,'');level='error';
 }else return null;
 for(const secret of secrets)if(secret)message=message.replaceAll(secret,'[redacted]').replaceAll(JSON.stringify(secret).slice(1,-1),'[redacted]');
 message=message.replace(/\b(?:sk-|th-)[a-zA-Z0-9_-]{12,}/gu,'[redacted]')
  .replace(/\b(?:Bearer|Basic)\s+[a-zA-Z0-9+/_=.-]+/giu,'[redacted]')
  .replace(/https?:\/\/[^\s"\\]+/giu,'[url]')
  .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u001b]/gu,'');
 return {message,level};
}
export function sanitizeLogSnapshot(snapshot:DockerLogSnapshot,secrets:readonly string[]):LogSnapshot {
 const lines:LogLine[]=[];const duplicates=new Map<string,number>();let size=0,truncated=snapshot.truncated;
 for(const line of snapshot.lines){
  const safe=safeMessage(line.message,secrets);if(!safe)continue;
  const key=createHash('sha256').update(`${snapshot.sourceId}\0${line.time}\0${line.stream}\0${line.message}`).digest('hex').slice(0,24);
  const occurrence=duplicates.get(key)??0;duplicates.set(key,occurrence+1);
  lines.push({...line,...safe,id:`${key}-${occurrence}`});
 }
 while(lines.length>500){lines.shift();truncated=true;}
 for(let index=lines.length-1;index>=0;index--){size+=Buffer.byteLength(JSON.stringify(lines[index]));if(size>256*1024){lines.splice(0,index+1);truncated=true;break;}}
 return {sourceId:snapshot.sourceId,lines,truncated};
}

/** One cancellable, non-overlapping bounded poll per open log page. No logs are stored in the DB. */
export class LogStreams {
 private clients=new Set<{token:unknown;stop:()=>void}>();
 constructor(private readonly db:ConsoleDatabase,private readonly auth:ConsoleAuth,private readonly docker:DockerClient,private readonly interval=2000){}
 open(req:FastifyRequest,reply:FastifyReply,botId?:string):void {
  reply.hijack();const response=reply.raw;const token=req.cookies.console_session;
  response.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no','X-Content-Type-Options':'nosniff'});
  let stopped=false,timer:NodeJS.Timeout|undefined,lastSnapshot='',lastStatus='',polls=0;
  const controller=new AbortController();const knownSecrets=new Set<string>();
  const stop=()=>{if(stopped)return;stopped=true;if(timer)clearTimeout(timer);controller.abort();this.clients.delete(client);if(!response.destroyed)response.end();};
  const client={token,stop};this.clients.add(client);response.once('close',stop);
  const rememberSecrets=()=>{for(const bot of this.db.listBots()){knownSecrets.add(bot.workerToken);for(const field of SECRET_FIELDS)if(bot.config[field])knownSecrets.add(bot.config[field]!);}};
  const write=(event:string,value:unknown)=>{
   if(stopped||response.destroyed)return;
   if(response.writableLength>512*1024){response.destroy();stop();return;}
   response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
  };
  const status=(state:'connected'|'unavailable',message?:string)=>{const next=JSON.stringify({state,...(message?{message}:{})});if(next!==lastStatus){lastStatus=next;write('status',JSON.parse(next));}};
  const poll=async()=>{
   if(stopped)return;
   if(!this.auth.valid(token)){stop();return;}
   try{
    // Refresh on every poll, including key updates while this page remains open.
    rememberSecrets();
    const snapshot=botId?await this.docker.logs(botId,controller.signal):await this.docker.consoleLogs(controller.signal);
    if(stopped||!this.auth.valid(token)){stop();return;}
    rememberSecrets();
    const safe=sanitizeLogSnapshot(snapshot,[...knownSecrets].sort((a,b)=>b.length-a.length));const next=JSON.stringify(safe);
    status('connected');if(next!==lastSnapshot){lastSnapshot=next;write('logs',safe);}
   }catch{
    // The client clears its visible snapshot when the source is unavailable.
    // A successful retry must republish even if this container has no new lines.
    lastSnapshot='';
    if(!stopped)status('unavailable',botId?'实例日志暂不可用，正在重新连接':'控制台日志暂不可用，正在重新连接');
   }finally{
    if(!stopped){if(++polls%7===0)response.write(': heartbeat\n\n');timer=setTimeout(()=>void poll(),this.interval);timer.unref();}
   }
  };
  void poll();
 }
 closeSession(token:unknown):void {for(const client of this.clients)if(client.token===token)client.stop();}
 close():void {for(const client of this.clients)client.stop();}
}
