import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { type PluginSettings, type PluginResource, type PluginContent, type PluginDispatch, type PluginId, type PlatformPluginId, type PluginInstanceView, type PluginJobView, type PluginResult, type PluginRunnerJob, type PluginRunnerResult, type PluginSync, type PluginPresentation, type PluginOutput } from '../plugin-contract.js';
import { PLUGIN_MANIFESTS, contentPlugin, contentPlugins, controlCommand } from '../plugin-system/registry.js';
import type { BotRecord } from './contracts.js';
import type { ConsoleEvent } from './contracts.js';
import type { NapcatSendResult } from '../transport-protocol.js';

interface Host {requireBot(id:string):BotRecord;encrypt(value:unknown):string;decrypt(value:string):unknown;transaction<T>(fn:()=>T):T;change(id:string,type:string):void;}
interface JobRow {id:string;bot_id:string;plugin_id:PlatformPluginId;source_message_id:string;conversation_id:string|null;operation:'resolve'|'download'|'prepare';resource_key:string;resource_cipher:string;content_cipher?:string|null;presentation_cipher?:string|null;finished_at?:number|null;config_revision:number;command_kind:string;automatic:number;state:string;attempts:number;lease:string|null;lease_until:number;created_at:number;expires_at:number;next_attempt:number;error:string|null;uploaded_asset_id?:string|null;}
interface ResultRow {id:string;bot_id:string;plugin_id:PlatformPluginId;source_message_id:string;conversation_id:string|null;payload_cipher:string;acknowledged_at:number|null;created_at:number;}
const object=(v:unknown):Record<string,unknown>|null=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:null;
const identifier=(v:unknown)=>typeof v==='string'&&v.length>0&&v.length<=200?v:typeof v==='number'&&Number.isSafeInteger(v)?String(v):null;
const safeCode=(v:unknown)=>typeof v==='string'&&/^[A-Z][A-Z0-9_]{0,100}$/u.test(v)?v:'PLUGIN_OPERATION_FAILED';
export const PLUGIN_QUEUE_LIMITS={jobs:1000,sourceBytes:4*1024*1024} as const;

/** Plugin state uses the Console transaction, while only Workers assign chat ownership. */
export class ConsolePlugins {
  constructor(private readonly db:DatabaseSync,private readonly host:Host) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS plugin_configs(bot_id TEXT NOT NULL REFERENCES bots(id),plugin_id TEXT NOT NULL,enabled INTEGER NOT NULL,revision INTEGER NOT NULL,config_cipher TEXT NOT NULL,PRIMARY KEY(bot_id,plugin_id));
      CREATE TABLE IF NOT EXISTS plugin_dispatches(bot_id TEXT NOT NULL REFERENCES bots(id),message_id TEXT NOT NULL,dispatch_json TEXT NOT NULL,PRIMARY KEY(bot_id,message_id));
      CREATE TABLE IF NOT EXISTS plugin_bindings(bot_id TEXT NOT NULL REFERENCES bots(id),message_id TEXT NOT NULL,conversation_id TEXT NOT NULL,PRIMARY KEY(bot_id,message_id));
      CREATE TABLE IF NOT EXISTS plugin_jobs(id TEXT PRIMARY KEY,bot_id TEXT NOT NULL REFERENCES bots(id),plugin_id TEXT NOT NULL,source_message_id TEXT NOT NULL,conversation_id TEXT,operation TEXT NOT NULL,resource_key TEXT NOT NULL,resource_cipher TEXT NOT NULL,content_cipher TEXT,config_revision INTEGER NOT NULL,command_kind TEXT NOT NULL,automatic INTEGER NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,lease TEXT,lease_until INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,next_attempt INTEGER NOT NULL DEFAULT 0,error TEXT,UNIQUE(bot_id,plugin_id,source_message_id,operation,resource_key));
      CREATE INDEX IF NOT EXISTS plugin_job_queue ON plugin_jobs(state,next_attempt,created_at);
      CREATE TABLE IF NOT EXISTS plugin_results(id TEXT PRIMARY KEY,bot_id TEXT NOT NULL REFERENCES bots(id),plugin_id TEXT NOT NULL,source_message_id TEXT NOT NULL,conversation_id TEXT,payload_cipher TEXT NOT NULL,acknowledged_at INTEGER,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS plugin_content_versions(bot_id TEXT NOT NULL REFERENCES bots(id),source_message_id TEXT NOT NULL,plugin_id TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(bot_id,source_message_id,plugin_id));
      CREATE INDEX IF NOT EXISTS plugin_result_pending ON plugin_results(bot_id,acknowledged_at,created_at);
    `);
    const columns=db.prepare('PRAGMA table_info(plugin_jobs)').all() as Array<{name:string}>;
    if(!columns.some(column=>column.name==='uploaded_asset_id'))db.exec('ALTER TABLE plugin_jobs ADD COLUMN uploaded_asset_id TEXT');
    if(!columns.some(column=>column.name==='resource_key')||!columns.some(column=>column.name==='plugin_id')) {
      db.exec('ALTER TABLE plugin_jobs RENAME TO plugin_jobs_before_resources');
      db.exec(`CREATE TABLE plugin_jobs(id TEXT PRIMARY KEY,bot_id TEXT NOT NULL REFERENCES bots(id),plugin_id TEXT NOT NULL,source_message_id TEXT NOT NULL,conversation_id TEXT,operation TEXT NOT NULL,resource_key TEXT NOT NULL,resource_cipher TEXT NOT NULL,content_cipher TEXT,config_revision INTEGER NOT NULL,command_kind TEXT NOT NULL,automatic INTEGER NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,lease TEXT,lease_until INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,next_attempt INTEGER NOT NULL DEFAULT 0,error TEXT,uploaded_asset_id TEXT,UNIQUE(bot_id,plugin_id,source_message_id,operation,resource_key));`);
      for(const row of db.prepare('SELECT * FROM plugin_jobs_before_resources').all() as unknown as JobRow[]) {
        const resource=this.host.decrypt(row.resource_cipher) as PluginResource|null;
        db.prepare('INSERT INTO plugin_jobs(id,bot_id,plugin_id,source_message_id,conversation_id,operation,resource_key,resource_cipher,content_cipher,config_revision,command_kind,automatic,state,attempts,lease,lease_until,created_at,expires_at,next_attempt,error,uploaded_asset_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(row.id,row.bot_id,row.plugin_id??'bilibili',row.source_message_id,row.conversation_id,row.operation,row.resource_key??resource?.id??'none',row.resource_cipher,row.content_cipher??null,row.config_revision,row.command_kind,row.automatic,row.state,row.attempts,row.lease,row.lease_until,row.created_at,row.expires_at,row.next_attempt,row.error,row.uploaded_asset_id??null);
      }
      db.exec('DROP TABLE plugin_jobs_before_resources; CREATE INDEX plugin_job_queue ON plugin_jobs(state,next_attempt,created_at);');
    }
    else if(!columns.some(column=>column.name==='content_cipher'))db.exec('ALTER TABLE plugin_jobs ADD COLUMN content_cipher TEXT');
    const jobColumns=db.prepare('PRAGMA table_info(plugin_jobs)').all() as Array<{name:string}>;
    for(const name of ['presentation_cipher','finished_at'])if(!jobColumns.some(column=>column.name===name))db.exec(`ALTER TABLE plugin_jobs ADD COLUMN ${name} ${name==='finished_at'?'INTEGER':'TEXT'}`);
    db.exec('CREATE TABLE IF NOT EXISTS plugin_job_assets(job_id TEXT NOT NULL REFERENCES plugin_jobs(id),asset_key TEXT NOT NULL,asset_id TEXT NOT NULL,type TEXT NOT NULL,role TEXT NOT NULL,lease TEXT NOT NULL,PRIMARY KEY(job_id,asset_key));');
    const resultColumns=db.prepare('PRAGMA table_info(plugin_results)').all() as Array<{name:string}>;
    if(!resultColumns.some(column=>column.name==='plugin_id'))db.exec("ALTER TABLE plugin_results ADD COLUMN plugin_id TEXT NOT NULL DEFAULT 'bilibili'");
    for(const [name,type] of [['job_id','TEXT'],['output_group','TEXT'],['output_index','INTEGER']])if(!resultColumns.some(column=>column.name===name))db.exec(`ALTER TABLE plugin_results ADD COLUMN ${name} ${type}`);
    db.exec('CREATE INDEX IF NOT EXISTS plugin_result_group ON plugin_results(bot_id,output_group,output_index);');
  }
  catalog(){return PLUGIN_MANIFESTS;}
  private config(botId:string,pluginId:string):{enabled:boolean;revision:number;settings:PluginSettings} {
    this.host.requireBot(botId);
    const row=this.db.prepare("SELECT enabled,revision,config_cipher FROM plugin_configs WHERE bot_id=? AND plugin_id=?").get(botId,pluginId) as {enabled:number;revision:number;config_cipher:string}|undefined;
    const definition=contentPlugin(pluginId);
    return row?{enabled:!!row.enabled,revision:row.revision,settings:definition.validateConfig(this.host.decrypt(row.config_cipher))}:{enabled:false,revision:0,settings:{...definition.defaults}};
  }
  list(botId:string):PluginInstanceView[]{return PLUGIN_MANIFESTS.map(m=>this.view(botId,m.id));}
  view(botId:string,pluginId:string):PluginInstanceView {
    this.host.requireBot(botId);const manifest=PLUGIN_MANIFESTS.find(p=>p.id===pluginId);if(!manifest)throw new Error('插件不存在');
    const conf=pluginId==='core'?{enabled:true,revision:1,settings:{}}:this.config(botId,pluginId);
    const settings={...conf.settings} as Record<string,unknown>,configuredSecrets:Record<string,boolean>={};
    for(const [key,field] of Object.entries(manifest.configSchema?.properties??{}))if(field.secret){configuredSecrets[key]=typeof settings[key]==='string'&&!!settings[key];delete settings[key];}
    return {id:manifest.id,pluginId:manifest.id,enabled:conf.enabled,revision:conf.revision,config:settings,settings,cookieConfigured:!!configuredSecrets.cookie,configuredSecrets,manifest,jobs:this.jobs(botId,50,manifest.id)};
  }
  update(botId:string,pluginId:string,input:unknown):PluginInstanceView {
    const body=object(input);if(!body)throw new Error('插件配置必须为对象');
    for(const key of Object.keys(body))if(!['expectedRevision','enabled','config','settings'].includes(key))throw new Error('插件配置包含未知项目');
    if(pluginId==='core') {if(body.enabled===false)throw new Error('内置插件不可关闭');if(body.config!==undefined||body.settings!==undefined)throw new Error('内置插件没有可修改配置');return this.view(botId,pluginId);}
    contentPlugin(pluginId);
    return this.host.transaction(()=>{
      const current=this.config(botId,pluginId);if(body.expectedRevision!==current.revision)throw new Error('插件配置版本冲突，请刷新后重试');
      const enabled=body.enabled??current.enabled;if(typeof enabled!=='boolean')throw new Error('插件开关必须为布尔值');
      const settings=contentPlugin(pluginId).validateConfig(body.config??body.settings??{},current.settings);
      const revision=current.revision+1;
      this.db.prepare("INSERT INTO plugin_configs(bot_id,plugin_id,enabled,revision,config_cipher) VALUES (?,?,?,?,?) ON CONFLICT(bot_id,plugin_id) DO UPDATE SET enabled=excluded.enabled,revision=excluded.revision,config_cipher=excluded.config_cipher").run(botId,pluginId,enabled?1:0,revision,this.host.encrypt(settings));
      // Old credential/config snapshots never gain permission to send under a new revision.
      this.db.prepare("UPDATE plugin_jobs SET state='cancelled',error='PLUGIN_CONFIGURATION_CHANGED' WHERE bot_id=? AND plugin_id=? AND state IN ('queued','running')").run(botId,pluginId);
      this.cancelUnsent(botId,'PLUGIN_CONFIGURATION_CHANGED',undefined,pluginId);this.host.change(botId,'plugin.updated');
      return this.view(botId,pluginId);
    });
  }
  commands(botId:string) {return PLUGIN_MANIFESTS.filter(p=>p.required||this.config(botId,p.id).enabled).flatMap(p=>p.commands);}
  jobs(botId:string,limit=50,pluginId?:PluginId):PluginJobView[] {
    this.host.requireBot(botId);
    const count=Math.min(100,Math.max(1,Number.isSafeInteger(limit)?limit:50));
    const parameters=pluginId===undefined?[botId,count]:[botId,pluginId,count];
    const rows=this.db.prepare(`SELECT * FROM plugin_jobs WHERE bot_id=?${pluginId===undefined?'':' AND plugin_id=?'} ORDER BY created_at DESC,id DESC LIMIT ?`).all(...parameters) as unknown as JobRow[];
    return rows.map(row=>this.jobView(row));
  }
  private jobView(row:JobRow):PluginJobView {
    const resource=this.host.decrypt(row.resource_cipher) as PluginResource|null;
    const results=(this.db.prepare('SELECT * FROM plugin_results WHERE bot_id=? AND plugin_id=? AND (id IN (?,?,?) OR job_id=?) ORDER BY created_at,output_index,id').all(row.bot_id,row.plugin_id,`enrichment:${row.id}`,`reply:${row.id}`,`video:${row.id}`,row.id) as unknown as ResultRow[])
      .map(result=>({createdAt:result.created_at,value:this.host.decrypt(result.payload_cipher) as PluginResult}));
    const content=results.find(result=>result.value.content)?.value.content
      ??(row.content_cipher?this.host.decrypt(row.content_cipher) as PluginContent:undefined);
    const definition=contentPlugins.find(plugin=>plugin.manifest.id===row.plugin_id);
    const summary=definition?.summarize(resource,content);
    const deliveries:PluginJobView['deliveries']=[];
    for(const {value:result} of results) {
      if(result.kind==='enrichment')continue;
      const gateway=result.deliveryId?this.db.prepare('SELECT state,result_cipher FROM napcat_deliveries WHERE bot_id=? AND delivery_id=?').get(row.bot_id,result.deliveryId) as {state:string;result_cipher:string|null}|undefined:undefined;
      const receipt=gateway?.result_cipher?this.host.decrypt(gateway.result_cipher) as NapcatSendResult:undefined;
      const status:PluginJobView['deliveries'][number]['status']=receipt?receipt.ok?'acknowledged':receipt.deliveryStatus
        :gateway?.state==='started'?'sending':gateway?.state==='unconfirmed'?'unconfirmed':result.delivery?.status??'pending';
      const messageId=identifier(receipt?.ok?receipt.messageId:result.delivery?.messageId);
      const code=receipt&&!receipt.ok?receipt.code:result.delivery?.code;
      deliveries.push({kind:result.kind,status,...(messageId?{messageId}:{}),...(code?{code:safeCode(code)}:{})});
    }
    const finishedAt=row.finished_at??((row.state==='completed'||row.state==='failed')&&results.length?Math.max(...results.map(result=>result.createdAt)):undefined);
    return {id:row.id,pluginId:row.plugin_id,sourceMessageId:row.source_message_id,...(row.conversation_id?{conversationId:row.conversation_id}:{}),
      operation:row.operation,state:row.state,createdAt:row.created_at,attempts:row.attempts,automatic:!!row.automatic,command:row.command_kind,...(definition?.commandName?{commandName:definition.commandName(row.command_kind)}:{}),
      ...(summary?{resource:summary}:{}),
      ...(finishedAt===undefined?{}:{finishedAt,durationMs:Math.max(0,finishedAt-row.created_at)}),...(row.error?{error:safeCode(row.error)}:{}),deliveries};
  }
  dispatch(botId:string,messageId:string):PluginDispatch|undefined {const row=this.db.prepare('SELECT dispatch_json FROM plugin_dispatches WHERE bot_id=? AND message_id=?').get(botId,messageId) as {dispatch_json:string}|undefined;return row?JSON.parse(row.dispatch_json) as PluginDispatch:undefined;}
  observe(botId:string,event:ConsoleEvent):void {
    if(!event.conversationId)return;
    const ids=event.type==='conversation.messages_moved'&&Array.isArray(event.payload.messageIds)?event.payload.messageIds
      :event.type==='message.received'||event.type==='incoming'?[event.payload.messageId]:[];
    for(const value of ids) {
      const messageId=identifier(value);if(!messageId)continue;
      this.db.prepare('INSERT INTO plugin_bindings(bot_id,message_id,conversation_id) VALUES (?,?,?) ON CONFLICT(bot_id,message_id) DO UPDATE SET conversation_id=excluded.conversation_id').run(botId,messageId,event.conversationId);
      this.db.prepare('UPDATE plugin_jobs SET conversation_id=? WHERE bot_id=? AND source_message_id=?').run(event.conversationId,botId,messageId);
      this.db.prepare('UPDATE plugin_results SET conversation_id=? WHERE bot_id=? AND source_message_id=?').run(event.conversationId,botId,messageId);
    }
    if(event.type==='conversation.started') {
      this.db.prepare("UPDATE plugin_jobs SET state='cancelled',error='PLUGIN_CONVERSATION_CHANGED' WHERE bot_id=? AND conversation_id IS NOT NULL AND conversation_id<>? AND state IN ('queued','running')").run(botId,event.conversationId);
      this.cancelUnsent(botId,'PLUGIN_CONVERSATION_CHANGED',event.conversationId);
    }
  }
  /** Called inside the durable inbound transaction; never performs network work. */
  register(botId:string,event:unknown,now=Date.now()):void {
    const e=object(event);const messageId=identifier(e?.message_id);if(!e||!messageId)return;
    if(this.db.prepare('SELECT 1 FROM plugin_dispatches WHERE bot_id=? AND message_id=?').get(botId,messageId))return;
    const core=controlCommand(event);
    if(core){this.saveDispatch(botId,core);return;}
    const command=contentPlugins.map(definition=>definition.command(event)).find(dispatch=>dispatch&&this.config(botId,dispatch.pluginId).enabled);
    for(const definition of contentPlugins) {
    const pluginId=definition.manifest.id;const conf=this.config(botId,pluginId);if(!conf.enabled)continue;
    if(command&&command.pluginId!==pluginId)continue;
    const dispatch=definition.command(event);let resources=definition.match(event);
    if(dispatch?.pluginId===pluginId) {
      resources=definition.match({message:[{type:'text',data:{text:dispatch.args}}]});
      if(!resources.length&&Array.isArray(e.message)) {
        const reference=e.message.find(x=>object(x)?.type==='reply');const ref=identifier(object(object(reference)?.data)?.id);
        if(ref) {
          const previous=this.db.prepare('SELECT resource_cipher FROM plugin_jobs WHERE bot_id=? AND plugin_id=? AND source_message_id=? ORDER BY created_at LIMIT 1').get(botId,pluginId,ref) as {resource_cipher:string}|undefined;
          if(previous){const resource=this.host.decrypt(previous.resource_cipher) as PluginResource|null;if(resource)resources=[resource];}
          if(!resources.length) {
            const saved=this.db.prepare("SELECT payload FROM event_projection WHERE bot_id=? AND type IN ('message.received','incoming') AND json_extract(payload,'$.messageId')=? ORDER BY worker_seq DESC LIMIT 1").get(botId,ref) as {payload:string}|undefined;
            if(saved)try {
              const text=JSON.parse(saved.payload).text;
              if(typeof text==='string') {
                let card:unknown;if(text.startsWith('[JSON ')&&text.endsWith(']'))try{card=JSON.parse(text.slice(6,-1));}catch{}
                resources=definition.match({message:[card?{type:'json',data:{data:card}}:{type:'text',data:{text}}]});
              }
            }catch{}
          }
        }
      }
      const jobId=this.enqueue(botId,pluginId,messageId,resources[0],dispatch.command,false,conf.revision,now);
      this.saveDispatch(botId,{...dispatch,jobId});
      if(!jobId||!resources.length){const replyId=jobId??randomUUID();this.result(botId,messageId,`reply:${replyId}`,{pluginId,kind:'reply',text:jobId?definition.missingResourceText:'当前插件处理队列已满，请稍后再试。',deliveryId:`plugin:${replyId}:reply`,automatic:false},now);}
    } else if(definition.shouldProcess(conf.settings)) {
      for(const resource of resources)if(definition.shouldProcess(conf.settings,resource))this.enqueue(botId,pluginId,messageId,resource,'share',true,conf.revision,now);
    }
    }
  }
  private saveDispatch(botId:string,dispatch:PluginDispatch){this.db.prepare('INSERT OR IGNORE INTO plugin_dispatches(bot_id,message_id,dispatch_json) VALUES (?,?,?)').run(botId,dispatch.sourceMessageId,JSON.stringify(dispatch));}
  private enqueue(botId:string,pluginId:PlatformPluginId,messageId:string,resource:PluginResource|undefined,command:string,automatic:boolean,revision:number,now:number):string|undefined {
    const existing=this.db.prepare("SELECT id FROM plugin_jobs WHERE bot_id=? AND plugin_id=? AND source_message_id=? AND operation='resolve' AND resource_key=?").get(botId,pluginId,messageId,resource?.id??'none') as {id:string}|undefined;if(existing)return existing.id;
    const sourceCipher=this.host.encrypt(resource??null);
    const queue=this.db.prepare("SELECT COUNT(*) AS count,COALESCE(SUM(length(resource_cipher)+COALESCE(length(content_cipher),0)),0) AS bytes FROM plugin_jobs WHERE bot_id=? AND state IN ('queued','running')").get(botId) as {count:number;bytes:number};
    if(queue.count>=PLUGIN_QUEUE_LIMITS.jobs||queue.bytes+sourceCipher.length>PLUGIN_QUEUE_LIMITS.sourceBytes){this.host.change(botId,'plugin.queue_full');return;}
    const id=randomUUID();this.db.prepare("INSERT INTO plugin_jobs(id,bot_id,plugin_id,source_message_id,operation,resource_key,resource_cipher,config_revision,command_kind,automatic,state,created_at,expires_at) VALUES (?,?,?,?,'resolve',?,?,?,?,?,?,?,?)")
      .run(id,botId,pluginId,messageId,resource?.id??'none',sourceCipher,revision,command,automatic?1:0,resource?'queued':'completed',now,now+600_000);
    this.host.change(botId,'plugin.job');return id;
  }
  sync(botId:string,input:unknown):{accepted:true} {
    const body=object(input);if(!body)throw new Error('插件同步请求无效');
    const sync=body as unknown as PluginSync;
    if(sync.bindings!==undefined&&(!Array.isArray(sync.bindings)||sync.bindings.length>1000))throw new Error('插件消息绑定无效');
    if(sync.acknowledgements!==undefined&&(!Array.isArray(sync.acknowledgements)||sync.acknowledgements.length>1000))throw new Error('插件确认列表无效');
    return this.host.transaction(()=>{
      this.host.requireBot(botId);
      for(const binding of sync.bindings??[]) {
        if(!identifier(binding.messageId)||!identifier(binding.conversationId))throw new Error('插件消息绑定无效');
        const known=this.db.prepare("SELECT 1 FROM plugin_jobs WHERE bot_id=? AND source_message_id=? UNION ALL SELECT 1 FROM plugin_results WHERE bot_id=? AND source_message_id=? LIMIT 1").get(botId,binding.messageId,botId,binding.messageId);if(!known)continue;
        const old=this.db.prepare('SELECT conversation_id FROM plugin_bindings WHERE bot_id=? AND message_id=?').get(botId,binding.messageId) as {conversation_id:string}|undefined;
        if(old&&old.conversation_id!==binding.conversationId)throw new Error('插件消息所属会话已确定');
        this.db.prepare('INSERT OR IGNORE INTO plugin_bindings(bot_id,message_id,conversation_id) VALUES (?,?,?)').run(botId,binding.messageId,binding.conversationId);
        this.db.prepare('UPDATE plugin_jobs SET conversation_id=? WHERE bot_id=? AND source_message_id=? AND conversation_id IS NULL').run(binding.conversationId,botId,binding.messageId);
        this.db.prepare('UPDATE plugin_results SET conversation_id=? WHERE bot_id=? AND source_message_id=? AND conversation_id IS NULL').run(binding.conversationId,botId,binding.messageId);
      }
      if(sync.conversationId!==undefined) {
        if(!identifier(sync.conversationId))throw new Error('插件当前会话无效');
        // Sync may overtake the durable migration events. Only conversation.started
        // invalidates old work, after all queued message ownership has been moved.
      }
      for(const id of sync.acknowledgements??[]) {
        if(!identifier(id))throw new Error('插件结果确认无效');
        const row=this.db.prepare('SELECT * FROM plugin_results WHERE bot_id=? AND id=?').get(botId,id) as unknown as ResultRow|undefined;
        if(!row)continue;const result=this.decodeResult(row);
        if(result.kind!=='enrichment'&&!result.delivery)throw new Error('插件回复尚未完成投递');
        this.db.prepare('UPDATE plugin_results SET acknowledged_at=COALESCE(acknowledged_at,?) WHERE bot_id=? AND id=?').run(Date.now(),botId,id);
      }
      return {accepted:true as const};
    });
  }
  snapshot(botId:string):{results:PluginResult[];commands:ReturnType<ConsolePlugins['commands']>;bindingsRequired:string[];pendingBindings:string[];pendingSources:string[];waitSeconds:number} {
    const bot=this.host.requireBot(botId);const enabledConfigs=contentPlugins.map(plugin=>({plugin,config:this.config(botId,plugin.manifest.id)})).filter(item=>item.config.enabled);
    const results=bot.desiredState==='running'?(this.db.prepare('SELECT * FROM plugin_results WHERE bot_id=? AND conversation_id IS NOT NULL AND acknowledged_at IS NULL ORDER BY created_at,id LIMIT 100').all(botId) as unknown as ResultRow[]).map(r=>this.decodeResult(r)):[];
    for(let index=0;index<results.length;index++) {const result=results[index]!;if(result.kind!=='enrichment'&&!result.delivery&&result.expiresAt!==undefined&&result.expiresAt<Date.now()){this.cancel(botId,result.id,'PLUGIN_SEND_EXPIRED');results[index]=this.getResult(botId,result.id)!;}}
    const bindingsRequired=(this.db.prepare('SELECT source_message_id FROM plugin_jobs WHERE bot_id=? AND conversation_id IS NULL UNION SELECT source_message_id FROM plugin_results WHERE bot_id=? AND conversation_id IS NULL LIMIT 1000').all(botId,botId) as Array<{source_message_id:string}>).map(r=>r.source_message_id);
    const pendingSources=(this.db.prepare("SELECT DISTINCT source_message_id FROM plugin_jobs WHERE bot_id=? AND operation='resolve' AND state IN ('queued','running') ORDER BY created_at LIMIT 1000").all(botId) as Array<{source_message_id:string}>).map(r=>r.source_message_id);
    return {results:results.filter(result=>result.kind==='enrichment'||result.delivery||this.groupReady(botId,result)),commands:this.commands(botId),bindingsRequired,pendingBindings:bindingsRequired,pendingSources,waitSeconds:Math.max(0,...enabledConfigs.map(({plugin,config})=>plugin.policy(config.settings).waitSeconds))};
  }
  claim(now=Date.now()):PluginRunnerJob|null {
    return this.host.transaction(()=>{
      const interrupted=this.db.prepare("SELECT * FROM plugin_jobs WHERE state='running' AND lease_until<?").all(now) as unknown as JobRow[];
      for(const row of interrupted)if(row.attempts>=3)this.fail(row,'PLUGIN_RUNNER_INTERRUPTED',now);else this.db.prepare("UPDATE plugin_jobs SET state='queued',lease=NULL,error='PLUGIN_RUNNER_INTERRUPTED' WHERE id=?").run(row.id);
      const active=this.db.prepare("SELECT operation,COUNT(*) AS count FROM plugin_jobs WHERE state='running' AND lease_until>=? GROUP BY operation").all(now) as Array<{operation:string;count:number}>;
      const rows=this.db.prepare("SELECT * FROM plugin_jobs WHERE state='queued' AND next_attempt<=? ORDER BY created_at,id LIMIT 100").all(now) as unknown as JobRow[];
      for(const row of rows) {
        if(active.some(item=>item.operation===row.operation&&item.count>=1))continue;
        const bot=this.host.requireBot(row.bot_id),conf=this.config(row.bot_id,row.plugin_id);
        if(bot.desiredState!=='running'||!conf.enabled||row.config_revision!==conf.revision) {this.db.prepare("UPDATE plugin_jobs SET state='cancelled',error='PLUGIN_DISABLED' WHERE id=?").run(row.id);continue;}
        if(row.operation!=='resolve'&&!row.conversation_id)continue;
        if(row.expires_at<=now) {this.fail(row,'PLUGIN_JOB_EXPIRED',now);continue;}
        const lease=randomBytes(24).toString('hex'),leaseUntil=now+(contentPlugin(row.plugin_id).policy(conf.settings).timeoutSeconds+30)*1000;
        this.db.prepare("UPDATE plugin_jobs SET state='running',lease=?,lease_until=?,attempts=attempts+1 WHERE id=? AND state='queued'").run(lease,leaseUntil,row.id);
        const previous=this.db.prepare("SELECT payload_cipher FROM plugin_results WHERE bot_id=? AND plugin_id=? AND source_message_id=? AND id LIKE 'enrichment:%' ORDER BY created_at DESC LIMIT 1").get(row.bot_id,row.plugin_id,row.source_message_id) as {payload_cipher:string}|undefined;
        const content=row.content_cipher?this.host.decrypt(row.content_cipher) as PluginContent:previous?(this.host.decrypt(previous.payload_cipher) as PluginResult).content:undefined;
        return {id:row.id,lease,botId:row.bot_id,pluginId:row.plugin_id,operation:row.operation,resource:this.host.decrypt(row.resource_cipher) as PluginResource,config:conf.settings,
          networkProxy:{enabled:bot.config.proxyEnabled,url:bot.config.proxyUrl,username:bot.config.proxyUsername,password:bot.config.proxyPassword,noProxy:bot.config.proxyNoProxy,forTools:true},imageMaxBytes:Math.min(bot.config.imageMaxMiB*1024*1024,16*1024*1024),command:row.command_kind,...(row.presentation_cipher?{presentation:this.host.decrypt(row.presentation_cipher) as PluginPresentation}:{}),...(content?{content}:{}),expiresAt:leaseUntil};
      }
      return null;
    });
  }
  leased(jobId:string,lease:string,now=Date.now()):{row:JobRow;job:PluginRunnerJob} {
    const row=this.db.prepare('SELECT * FROM plugin_jobs WHERE id=?').get(jobId) as unknown as JobRow|undefined;
    if(!row||row.state!=='running'||row.lease!==lease||row.lease_until<now)throw new Error('插件作业租约已失效');
    const bot=this.host.requireBot(row.bot_id),conf=this.config(row.bot_id,row.plugin_id);if(!conf.enabled||bot.desiredState!=='running'||conf.revision!==row.config_revision)throw new Error('插件作业已取消');
    const previous=this.db.prepare("SELECT payload_cipher FROM plugin_results WHERE bot_id=? AND plugin_id=? AND source_message_id=? AND id LIKE 'enrichment:%' ORDER BY created_at DESC LIMIT 1").get(row.bot_id,row.plugin_id,row.source_message_id) as {payload_cipher:string}|undefined;
    const content=row.content_cipher?this.host.decrypt(row.content_cipher) as PluginContent:previous?(this.host.decrypt(previous.payload_cipher) as PluginResult).content:undefined;
    return {row,job:{id:row.id,lease,botId:row.bot_id,pluginId:row.plugin_id,operation:row.operation,resource:this.host.decrypt(row.resource_cipher) as PluginResource,config:conf.settings,networkProxy:{enabled:bot.config.proxyEnabled,url:bot.config.proxyUrl,username:bot.config.proxyUsername,password:bot.config.proxyPassword,noProxy:bot.config.proxyNoProxy,forTools:true},imageMaxBytes:Math.min(bot.config.imageMaxMiB*1024*1024,16*1024*1024),command:row.command_kind,...(row.presentation_cipher?{presentation:this.host.decrypt(row.presentation_cipher) as PluginPresentation}:{}),...(content?{content}:{}),expiresAt:row.lease_until}};
  }
  attachAsset(jobId:string,lease:string,assetId:string,key='video',type:'video'|'image'='video',role=type==='video'?'video':'content'):void {
    const {row}=this.leased(jobId,lease);
    if(row.operation!=='download'&&row.operation!=='prepare'||!['image','video'].includes(type)||!['video','content','live_preview','cover','avatar','emoji','presentation'].includes(role)||!/^[A-Za-z0-9_-]{1,100}$/u.test(key))throw new Error('插件媒体资产与作业不匹配');
    const asset=this.db.prepare('SELECT mime FROM plugin_media_assets WHERE id=? AND bot_id=?').get(assetId,row.bot_id) as {mime:string}|undefined;
    if(!asset||(type==='image')!==asset.mime.startsWith('image/')||row.operation==='prepare'&&type!=='image')throw new Error('插件媒体资产与作业不匹配');
    const existing=this.db.prepare('SELECT COUNT(*) AS count FROM plugin_job_assets WHERE job_id=?').get(jobId) as {count:number};
    if(existing.count>=32&&!this.db.prepare('SELECT 1 FROM plugin_job_assets WHERE job_id=? AND asset_key=?').get(jobId,key))throw new Error('插件媒体数量超过上限');
    this.db.prepare('INSERT INTO plugin_job_assets(job_id,asset_key,asset_id,type,role,lease) VALUES (?,?,?,?,?,?) ON CONFLICT(job_id,asset_key) DO UPDATE SET asset_id=excluded.asset_id,type=excluded.type,role=excluded.role,lease=excluded.lease').run(jobId,key,assetId,type,role,lease);
    if(row.operation==='download')this.db.prepare('UPDATE plugin_jobs SET uploaded_asset_id=? WHERE id=?').run(assetId,jobId);
  }
  private contentAsset(row:JobRow,id:string,role?:string):{type:string;role:string}|undefined {
    return this.db.prepare(`SELECT assets.type,assets.role FROM plugin_job_assets assets JOIN plugin_jobs jobs ON jobs.id=assets.job_id
      JOIN plugin_media_assets media ON media.id=assets.asset_id AND media.bot_id=jobs.bot_id
      WHERE assets.asset_id=? AND jobs.bot_id=? AND jobs.plugin_id=? AND jobs.source_message_id=?
      AND assets.role<>'presentation' ${role===undefined?'':'AND assets.role=?'}
      AND ((jobs.id=? AND assets.lease=?) OR (jobs.id<>? AND jobs.state='completed')) LIMIT 1`).get(id,row.bot_id,row.plugin_id,row.source_message_id,...(role===undefined?[]:[role]),row.id,row.lease,row.id) as {type:string;role:string}|undefined;
  }
  private validateContentAssets(row:JobRow,content:PluginContent):void {
    const visit=(value:unknown,depth=0):void=>{
      if(depth>20)throw new Error('插件资料嵌套过深');
      if(Array.isArray(value)){if(value.length>1000)throw new Error('插件资料超过上限');for(const item of value)visit(item,depth+1);return;}
      const item=object(value);if(!item)return;
      if(item.assetKey!==undefined)throw new Error('插件资料含未上传的媒体引用');
      if(item.assetId!==undefined) {
        const asset=typeof item.assetId==='string'?this.contentAsset(row,item.assetId,typeof item.role==='string'?item.role:undefined):undefined;
        if(!asset||asset.type!=='image'||asset.role==='presentation'||typeof item.role==='string'&&asset.role!==item.role)throw new Error('插件资料媒体不属于本次来源');
      }
      for(const child of Object.values(item))visit(child,depth+1);
    };
    if(Buffer.byteLength(JSON.stringify(content))>1024*1024)throw new Error('插件资料超过上限');
    visit(content);
  }
  private validateOutputs(row:JobRow,value:unknown):PluginOutput[] {
    if(!Array.isArray(value)||value.length>16)throw new Error('插件展示产物数量无效');
    return value.map(value=>{
      const item=object(value);if(!item||!['reply','image'].includes(String(item.kind))||Object.keys(item).some(key=>!['kind','text','assetId','assetRole'].includes(key)))throw new Error('插件展示产物无效');
      if(item.kind==='reply') {
        if(typeof item.text!=='string'||!item.text.trim()||item.text.length>64000||item.assetId!==undefined)throw new Error('插件文字产物无效');
        return {kind:'reply',text:item.text};
      }
      const matches=typeof item.assetId==='string'?this.db.prepare('SELECT assets.type,assets.role FROM plugin_job_assets assets JOIN plugin_media_assets media ON media.id=assets.asset_id WHERE assets.job_id=? AND assets.asset_id=? AND assets.lease=? AND media.bot_id=?').all(row.id,item.assetId,row.lease,row.bot_id) as unknown as Array<{type:string;role:string}>:[];
      const roles=[...new Set(matches.map(value=>value.role))];
      const asset=matches.find(value=>value.role===item.assetRole)??(roles.length===1?matches[0]:undefined);
      if(!asset||asset.type!=='image'||item.text!==undefined)throw new Error('插件图片产物不属于本次上传');
      return {kind:'image',assetId:item.assetId as string,assetRole:asset.role};
    });
  }
  complete(jobId:string,lease:string,value:PluginRunnerResult,now=Date.now()):{accepted:boolean} {
    return this.host.transaction(()=>{
      let row:JobRow,job:PluginRunnerJob;try{({row,job}=this.leased(jobId,lease,now));}catch{return {accepted:false};}
      if(value.error) {
        const code=safeCode(value.error);
        if(value.retryable&&row.attempts<3&&now+3000<row.expires_at){this.db.prepare("UPDATE plugin_jobs SET state='queued',lease=NULL,next_attempt=?,error=? WHERE id=?").run(now+3000,code,row.id);return {accepted:true};}
        this.fail(row,code,now);return {accepted:true};
      }
      if(row.operation==='resolve') {
        const definition=contentPlugin(row.plugin_id),content=definition.validateContent(value.content,job.resource);
        this.validateContentAssets(row,content);
        const earlier=this.db.prepare("SELECT content_cipher FROM plugin_jobs WHERE bot_id=? AND plugin_id=? AND source_message_id=? AND operation='resolve' AND state='completed' AND id<>? AND content_cipher IS NOT NULL").all(row.bot_id,row.plugin_id,row.source_message_id,row.id) as Array<{content_cipher:string}>;
        this.db.prepare('UPDATE plugin_jobs SET content_cipher=? WHERE id=?').run(this.host.encrypt(content),row.id);
        if(earlier.some(previous=>(this.host.decrypt(previous.content_cipher) as PluginContent).resourceId===content.resourceId)) {
          this.db.prepare("UPDATE plugin_jobs SET state='completed',lease=NULL,error=NULL,finished_at=? WHERE id=?").run(now,row.id);this.host.change(row.bot_id,'plugin.result');return {accepted:true};
        }
        const next=definition.afterResolve(row.command_kind,job.resource,job.config,content);
        if(next.provideContext)this.result(row.bot_id,row.source_message_id,`enrichment:${row.id}`,{pluginId:row.plugin_id,kind:'enrichment',content},now);
        if(next.replyText)this.result(row.bot_id,row.source_message_id,`reply:${row.id}`,{pluginId:row.plugin_id,kind:'reply',text:next.replyText,deliveryId:`plugin:${row.id}:reply`,automatic:false},now);
        const followups:Array<{operation:'download'|'prepare';resource:PluginResource;presentation?:PluginPresentation}>=[];
        if(next.download)followups.push({operation:'download',resource:next.download});
        if(next.prepare)followups.push({operation:'prepare',resource:{...job.resource,kind:content.type,id:content.resourceId,url:content.url,title:content.title},presentation:next.prepare});
        for(const followup of followups) {
          const resourceCipher=this.host.encrypt(followup.resource),contentCipher=this.host.encrypt(content);
          const queue=this.db.prepare("SELECT COUNT(*) AS count,COALESCE(SUM(length(resource_cipher)+COALESCE(length(content_cipher),0)),0) AS bytes FROM plugin_jobs WHERE bot_id=? AND state IN ('queued','running') AND id<>?").get(row.bot_id,row.id) as {count:number;bytes:number};
          if(queue.count>=PLUGIN_QUEUE_LIMITS.jobs||queue.bytes+resourceCipher.length+contentCipher.length>PLUGIN_QUEUE_LIMITS.sourceBytes) {
            if(!row.automatic)this.result(row.bot_id,row.source_message_id,`reply:${row.id}`,{pluginId:row.plugin_id,kind:'reply',text:'当前插件处理队列已满，请稍后再试。',deliveryId:`plugin:${row.id}:reply`,automatic:false},now);
          } else {
          this.db.prepare("INSERT OR IGNORE INTO plugin_jobs(id,bot_id,plugin_id,source_message_id,conversation_id,operation,resource_key,resource_cipher,content_cipher,config_revision,command_kind,automatic,state,created_at,expires_at,presentation_cipher) VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'queued',?,?,?)")
            .run(randomUUID(),row.bot_id,row.plugin_id,row.source_message_id,row.conversation_id,followup.operation,followup.resource.id,resourceCipher,contentCipher,row.config_revision,row.command_kind,row.automatic,now,row.expires_at,followup.presentation?this.host.encrypt(followup.presentation):null);
          }
        }
      } else if(row.operation==='download') {
        if(typeof value.assetId!=='string'||row.uploaded_asset_id!==value.assetId)throw new Error('插件下载缺少本作业已上传的媒体资产');
        this.result(row.bot_id,row.source_message_id,`video:${row.id}`,{pluginId:row.plugin_id,kind:'video',assetId:value.assetId,deliveryId:`plugin:${row.id}:video`,automatic:!!row.automatic,expiresAt:row.expires_at,...(job.content?{content:job.content}:{})},now);
      } else {
        if(!job.presentation||!job.content)throw new Error('插件展示任务缺少资料');
        const content=contentPlugin(row.plugin_id).validateContent(value.content,job.resource);
        this.validateContentAssets(row,content);
        const outputs=this.validateOutputs(row,value.outputs??[]);
        if(job.presentation.mode==='none'&&outputs.length)throw new Error('插件资料任务不能发送展示内容');
        this.db.prepare('UPDATE plugin_jobs SET content_cipher=? WHERE id=?').run(this.host.encrypt(content),row.id);
        if(job.presentation.provideContext)this.result(row.bot_id,row.source_message_id,`enrichment:${row.id}`,{pluginId:row.plugin_id,kind:'enrichment',content},now);
        for(let index=0;index<outputs.length;index++) {
          const output=outputs[index]!;
          this.result(row.bot_id,row.source_message_id,`output:${row.id}:${String(index).padStart(3,'0')}`,{pluginId:row.plugin_id,kind:output.kind,...(output.text?{text:output.text}:{}),...(output.assetId?{assetId:output.assetId}:{}),...(output.assetRole?{assetRole:output.assetRole}:{}),groupId:row.id,partIndex:index,deliveryId:`plugin:${row.id}:part:${index}`,automatic:!!row.automatic,expiresAt:row.expires_at,content},now);
        }
      }
      this.db.prepare("UPDATE plugin_jobs SET state='completed',lease=NULL,error=NULL,finished_at=? WHERE id=?").run(now,row.id);
      this.host.change(row.bot_id,'plugin.result');return {accepted:true};
    });
  }
  private fail(row:JobRow,error:string,now:number) {
    this.db.prepare("UPDATE plugin_jobs SET state='failed',error=?,lease=NULL,finished_at=? WHERE id=?").run(error,now,row.id);
    if(row.operation==='prepare'&&row.presentation_cipher&&row.content_cipher) {
      const presentation=this.host.decrypt(row.presentation_cipher) as PluginPresentation;
      if(presentation.provideContext) {
        const content=this.host.decrypt(row.content_cipher) as PluginContent;
        const mark=(value:unknown):void=>{
          if(!value||typeof value!=='object')return;
          if(Array.isArray(value)){for(const item of value)mark(item);return;}
          const item=value as Record<string,unknown>;
          if(typeof item.role==='string'&&typeof item.url==='string'&&item.status==='pending') {
            item.status='failed';item.error=error;delete item.assetKey;
          }
          for(const child of Object.values(item))mark(child);
        };
        mark(content);content.retrieval={status:'partial',error};
        this.result(row.bot_id,row.source_message_id,`enrichment:${row.id}`,{pluginId:row.plugin_id,kind:'enrichment',content},now);
      }
    }
    if(row.operation==='resolve') {
      const resource=this.host.decrypt(row.resource_cipher) as PluginResource,definition=contentPlugin(row.plugin_id),content=definition.failureContent(resource,error);
      if(definition.afterResolve(row.command_kind,resource,this.config(row.bot_id,row.plugin_id).settings,content).provideContext)this.result(row.bot_id,row.source_message_id,`enrichment:${row.id}`,{pluginId:row.plugin_id,kind:'enrichment',content},now);
    }
    if(!row.automatic)this.result(row.bot_id,row.source_message_id,`reply:${row.id}`,{pluginId:row.plugin_id,kind:'reply',text:contentPlugin(row.plugin_id).errorText(error),deliveryId:`plugin:${row.id}:reply`,automatic:false},now);
    this.host.change(row.bot_id,'plugin.failed');
  }
  private result(botId:string,messageId:string,id:string,body:Partial<PluginResult>,now:number) {
    if(this.db.prepare('SELECT 1 FROM plugin_results WHERE id=?').get(id))return;
    const binding=this.db.prepare('SELECT conversation_id FROM plugin_bindings WHERE bot_id=? AND message_id=?').get(botId,messageId) as {conversation_id:string}|undefined;
    const pluginId=body.pluginId;if(!pluginId)throw new Error('插件结果缺少来源标识');
    const revision=body.kind==='enrichment'?Number(this.db.prepare("INSERT INTO plugin_content_versions(bot_id,source_message_id,plugin_id,revision) VALUES (?,?,?,1) ON CONFLICT(bot_id,source_message_id,plugin_id) DO UPDATE SET revision=revision+1 RETURNING revision").get(botId,messageId,pluginId)?.revision??1):1;
    const contents=new Map<string,PluginContent>();
    if(body.kind==='enrichment'&&body.content) {
      const previous=this.db.prepare("SELECT payload_cipher FROM plugin_results WHERE bot_id=? AND plugin_id=? AND source_message_id=? AND id LIKE 'enrichment:%' ORDER BY created_at,id").all(botId,pluginId,messageId) as Array<{payload_cipher:string}>;
      const published=previous.map(row=>this.host.decrypt(row.payload_cipher) as PluginResult).sort((a,b)=>a.revision-b.revision);
      for(const value of published)for(const content of value.contents??(value.content?[value.content]:[]))contents.set(content.resourceId,content);
      contents.set(body.content.resourceId,body.content);
    }
    const payload={id,pluginId,sourceMessageId:messageId,revision,sourceRevision:revision,...(body.kind!=='enrichment'?{expiresAt:now+600_000}:{}),...body,...(body.kind==='reply'?{replyTo:messageId}:body.kind==='video'||body.kind==='image'?{replyTo:null}:{}),...(contents.size?{contents:[...contents.values()]}:{})};
    this.db.prepare('INSERT OR IGNORE INTO plugin_results(id,bot_id,plugin_id,source_message_id,conversation_id,payload_cipher,created_at,job_id,output_group,output_index) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id,botId,pluginId,messageId,binding?.conversation_id??null,this.host.encrypt(payload),now,body.groupId??null,body.groupId??null,body.partIndex??null);
  }
  private decodeResult(row:ResultRow):PluginResult {return {...this.host.decrypt(row.payload_cipher) as PluginResult,conversationId:row.conversation_id!};}
  getResult(botId:string,id:string):PluginResult|null {const row=this.db.prepare('SELECT * FROM plugin_results WHERE bot_id=? AND id=?').get(botId,id) as unknown as ResultRow|undefined;return row&&row.conversation_id?this.decodeResult(row):null;}
  private groupReady(botId:string,result:PluginResult):boolean {
    if(!result.groupId||result.partIndex===undefined||result.partIndex===0)return true;
    const rows=this.db.prepare('SELECT * FROM plugin_results WHERE bot_id=? AND output_group=? AND output_index<? ORDER BY output_index').all(botId,result.groupId,result.partIndex) as unknown as ResultRow[];
    if(rows.length!==result.partIndex)return false;
    for(const row of rows) {
      let previous=this.decodeResult(row);
      if(!previous.delivery&&previous.deliveryId) {
        const attempt=this.db.prepare('SELECT state,result_cipher FROM napcat_deliveries WHERE bot_id=? AND delivery_id=?').get(botId,previous.deliveryId) as {state:string;result_cipher:string|null}|undefined;
        if(attempt?.result_cipher)this.finishSend(botId,previous.id,this.host.decrypt(attempt.result_cipher) as NapcatSendResult);
        else if(attempt?.state==='unconfirmed')this.finishSend(botId,previous.id,{ok:false,code:'NAPCAT_SEND_UNCONFIRMED',deliveryStatus:'unconfirmed'});
        previous=this.getResult(botId,previous.id)!;
      }
      if(previous.delivery?.status!=='acknowledged')return false;
    }
    return true;
  }
  authorizeSend(botId:string,id:string,now=Date.now()):PluginResult {
    const result=this.getResult(botId,id);if(!result||result.kind==='enrichment')throw new Error('插件回复不存在');
    if(result.delivery)return result;
    if(!this.groupReady(botId,result))throw new Error('插件前序产物尚未确认发送');
    const bot=this.host.requireBot(botId);if(bot.desiredState!=='running'||!this.config(botId,result.pluginId).enabled)throw new Error('插件或实例已停止');
    if(result.expiresAt!==undefined&&result.expiresAt<now) {this.finishSend(botId,id,{ok:false,code:'PLUGIN_SEND_EXPIRED',deliveryStatus:'failed'});throw new Error('插件自动发送已过期');}
    const attempted=this.db.prepare('SELECT 1 FROM napcat_deliveries WHERE bot_id=? AND delivery_id=?').get(botId,result.deliveryId??'');
    if(!attempted) {
      const replyTo=result.kind==='video'||result.kind==='image'?null:result.sourceMessageId;
      if(result.replyTo!==replyTo) {
        result.replyTo=replyTo;
        this.db.prepare('UPDATE plugin_results SET payload_cipher=? WHERE bot_id=? AND id=?').run(this.host.encrypt(result),botId,id);
      }
    }
    return result;
  }
  finishSend(botId:string,id:string,delivery:NapcatSendResult):void {
    const result=this.getResult(botId,id);if(!result||result.delivery)return;
    result.delivery=delivery.ok?{status:'acknowledged',...(delivery.messageId?{messageId:delivery.messageId}:{})}:{status:delivery.deliveryStatus,code:delivery.code};
    this.db.prepare('UPDATE plugin_results SET payload_cipher=? WHERE bot_id=? AND id=?').run(this.host.encrypt(result),botId,id);this.host.change(botId,'plugin.delivery');
    if(!delivery.ok&&result.groupId&&result.partIndex!==undefined) {
      const later=this.db.prepare('SELECT * FROM plugin_results WHERE bot_id=? AND output_group=? AND output_index>?').all(botId,result.groupId,result.partIndex) as unknown as ResultRow[];
      for(const row of later) {
        const pending=this.decodeResult(row);if(pending.delivery)continue;
        if(this.db.prepare('SELECT 1 FROM napcat_deliveries WHERE bot_id=? AND delivery_id=?').get(botId,pending.deliveryId??''))continue;
        pending.delivery={status:'failed',code:'PLUGIN_PREVIOUS_OUTPUT_FAILED'};
        this.db.prepare('UPDATE plugin_results SET payload_cipher=? WHERE bot_id=? AND id=?').run(this.host.encrypt(pending),botId,row.id);
      }
    }
  }
  cancel(botId:string,id:string,code='PLUGIN_CONVERSATION_CHANGED'):{cancelled:boolean;delivery?:PluginResult['delivery']} {
    const result=this.getResult(botId,id);if(!result||result.kind==='enrichment')throw new Error('插件回复不存在');
    if(result.delivery)return {cancelled:result.delivery.status==='failed',delivery:result.delivery};
    const attempted=this.db.prepare('SELECT state,result_cipher FROM napcat_deliveries WHERE bot_id=? AND delivery_id=?').get(botId,result.deliveryId??'') as {state:string;result_cipher:string|null}|undefined;
    if(attempted?.state==='started')return {cancelled:false};
    if(attempted?.result_cipher) {
      const delivery=this.host.decrypt(attempted.result_cipher) as NapcatSendResult;this.finishSend(botId,id,delivery);return {cancelled:false,delivery:this.getResult(botId,id)?.delivery};
    }
    if(attempted?.state==='unconfirmed') {this.finishSend(botId,id,{ok:false,code:'NAPCAT_SEND_UNCONFIRMED',deliveryStatus:'unconfirmed'});return {cancelled:false,delivery:this.getResult(botId,id)?.delivery};}
    this.finishSend(botId,id,{ok:false,code:safeCode(code),deliveryStatus:'failed'});return {cancelled:true,delivery:this.getResult(botId,id)?.delivery};
  }
  private cancelUnsent(botId:string,code:string,currentConversation?:string,pluginId?:string) {
    const rows=this.db.prepare('SELECT * FROM plugin_results WHERE bot_id=? AND acknowledged_at IS NULL').all(botId) as unknown as ResultRow[];
    for(const row of rows) {const result=this.decodeResult(row);if(pluginId&&result.pluginId!==pluginId||result.kind==='enrichment'||result.delivery||currentConversation&&row.conversation_id===currentConversation)continue;if(!row.conversation_id){result.delivery={status:'failed',code};this.db.prepare('UPDATE plugin_results SET payload_cipher=? WHERE id=?').run(this.host.encrypt(result),row.id);}else this.cancel(botId,row.id,code);}
  }
}
