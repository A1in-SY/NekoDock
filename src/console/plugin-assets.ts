import {createHash,randomUUID,timingSafeEqual} from 'node:crypto';
import {mkdir,open,rename,lstat,unlink,readdir} from 'node:fs/promises';
import {createReadStream,constants,openSync} from 'node:fs';
import {resolve,join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import type {Readable} from 'node:stream';

interface AssetRow {id:string;bot_id:string;path:string;sha256:string;size:number;mime:string;created_at:number;expires_at:number;pinned_until:number;width:number|null;height:number|null;}
interface UploadOptions {maxBytes:number;cacheMaxBytes:number;cacheHours:number;signal?:AbortSignal;type?:'video'|'image';}
const MAX_IMAGE_PIXELS=40_000_000;
function imageFormat(bytes:Buffer):{mime:string;extension:string;width:number;height:number} {
  let mime='',extension='',width=0,height=0;
  if(bytes.length>=45&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&bytes.toString('ascii',12,16)==='IHDR'&&bytes.readUInt32BE(8)===13&&bytes.toString('ascii',bytes.length-8,bytes.length-4)==='IEND') {
    mime='image/png';extension='png';width=bytes.readUInt32BE(16);height=bytes.readUInt32BE(20);
  } else if(bytes.length>=14&&['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6))&&bytes.at(-1)===0x3b) {
    mime='image/gif';extension='gif';width=bytes.readUInt16LE(6);height=bytes.readUInt16LE(8);
  } else if(bytes.length>=12&&bytes[0]===0xff&&bytes[1]===0xd8&&bytes.at(-2)===0xff&&bytes.at(-1)===0xd9) {
    for(let offset=2;offset+3<bytes.length;) {
      if(bytes[offset]!==0xff)break;
      while(bytes[offset]===0xff)offset++;
      const marker=bytes[offset++]!;if(marker===0xda||marker===0xd9)break;
      if(marker===0x01||marker>=0xd0&&marker<=0xd7)continue;
      if(offset+2>bytes.length)break;const length=bytes.readUInt16BE(offset);
      if(length<2||offset+length>bytes.length)break;
      if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)&&length>=8) {
        mime='image/jpeg';extension='jpg';height=bytes.readUInt16BE(offset+3);width=bytes.readUInt16BE(offset+5);break;
      }
      offset+=length;
    }
  } else if(bytes.length>=30&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'&&bytes.readUInt32LE(4)+8===bytes.length) {
    const kind=bytes.toString('ascii',12,16);mime='image/webp';extension='webp';
    if(kind==='VP8X'){width=1+bytes.readUIntLE(24,3);height=1+bytes.readUIntLE(27,3);}
    else if(kind==='VP8 '&&bytes[23]===0x9d&&bytes[24]===0x01&&bytes[25]===0x2a){width=bytes.readUInt16LE(26)&0x3fff;height=bytes.readUInt16LE(28)&0x3fff;}
    else if(kind==='VP8L'&&bytes[20]===0x2f){const bits=bytes.readUInt32LE(21);width=(bits&0x3fff)+1;height=((bits>>>14)&0x3fff)+1;}
  }
  if(!width||!height||width*height>MAX_IMAGE_PIXELS)throw new Error('插件图片格式或像素大小无效');
  return {mime,extension,width,height};
}
export class ConsolePluginAssets {
  private readonly operations=new Map<string,Promise<void>>();
  constructor(private readonly db:DatabaseSync,private readonly sign:(value:string)=>string) {
    db.exec(`CREATE TABLE IF NOT EXISTS plugin_media_assets(id TEXT PRIMARY KEY,bot_id TEXT NOT NULL REFERENCES bots(id),path TEXT NOT NULL,sha256 TEXT NOT NULL,size INTEGER NOT NULL,mime TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,pinned_until INTEGER NOT NULL DEFAULT 0,UNIQUE(bot_id,sha256));`);
    const columns=db.prepare('PRAGMA table_info(plugin_media_assets)').all() as Array<{name:string}>;
    for(const name of ['width','height'])if(!columns.some(column=>column.name===name))db.exec(`ALTER TABLE plugin_media_assets ADD COLUMN ${name} INTEGER`);
  }
  private row(botId:string,id:string):AssetRow|null{return this.db.prepare('SELECT * FROM plugin_media_assets WHERE bot_id=? AND id=?').get(botId,id) as unknown as AssetRow??null;}
  info(botId:string,id:string){const row=this.row(botId,id);return row?{id:row.id,type:row.mime.startsWith('image/')?'image' as const:'video' as const,mimeType:row.mime,size:row.size,sha256:row.sha256,status:'ready' as const,...(row.width&&row.height?{width:row.width,height:row.height}:{})}:null;}
  async upload(root:string,botId:string,stream:Readable,options:UploadOptions):Promise<string> {
    if(!/^[A-Za-z0-9_-]{1,100}$/u.test(botId))throw new Error('插件媒体实例无效');
    return this.exclusive(botId,()=>this.uploadExclusive(root,botId,stream,options));
  }
  private async exclusive<T>(botId:string,operation:()=>Promise<T>):Promise<T> {
    const previous=this.operations.get(botId)??Promise.resolve();let release!:()=>void;
    const finished=new Promise<void>(resolve=>{release=resolve;});
    const tail=previous.catch(()=>{}).then(()=>finished);this.operations.set(botId,tail);
    await previous.catch(()=>{});
    try{return await operation();}finally{release();if(this.operations.get(botId)===tail)this.operations.delete(botId);}
  }
  private async uploadExclusive(root:string,botId:string,stream:Readable,options:UploadOptions):Promise<string> {
    options.signal?.throwIfAborted();await this.cleanupBot(root,botId,Date.now());
    const used=Number((this.db.prepare('SELECT COALESCE(SUM(size),0) AS size FROM plugin_media_assets WHERE bot_id=?').get(botId) as {size:number}).size);
    const directory=join(resolve(root),botId);await mkdir(directory,{recursive:true,mode:0o700});
    const temporary=join(directory,`.upload-${randomUUID()}`);const handle=await open(temporary,'wx',0o600);const digest=createHash('sha256');let size=0;let prefix=Buffer.alloc(0);
    try {
      for await(const chunk of stream) {
        options.signal?.throwIfAborted();const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=bytes.length;
        if(size>options.maxBytes)throw new Error('插件媒体超过配置的大小或缓存限额');
        if(prefix.length<16)prefix=Buffer.concat([prefix,bytes.subarray(0,16-prefix.length)]);
        digest.update(bytes);await handle.write(bytes);
      }
      await handle.sync();await handle.close();
      let format:{mime:string;extension:string;width?:number;height?:number};
      if(options.type==='image') {
        const source=await open(temporary,constants.O_RDONLY|constants.O_NOFOLLOW);let bytes:Buffer;
        try{bytes=await source.readFile();}finally{await source.close();}
        format=imageFormat(bytes);
      } else {
        if(size<12||prefix.toString('ascii',4,8)!=='ftyp')throw new Error('插件视频必须为有效 MP4 媒体');
        format={mime:'video/mp4',extension:'mp4'};
      }
      const hash=digest.digest('hex');const existing=this.db.prepare('SELECT id FROM plugin_media_assets WHERE bot_id=? AND sha256=?').get(botId,hash) as {id:string}|undefined;
      if(existing){await unlink(temporary);this.db.prepare('UPDATE plugin_media_assets SET expires_at=MAX(expires_at,?) WHERE id=?').run(Date.now()+options.cacheHours*3600_000,existing.id);return existing.id;}
      if(used+size>options.cacheMaxBytes)throw new Error('插件媒体超过配置的大小或缓存限额');
      const path=join(directory,`${hash}.${format.extension}`);await rename(temporary,path);const dir=await open(directory,'r');try{await dir.sync();}finally{await dir.close();}
      const id=randomUUID(),now=Date.now();this.db.prepare('INSERT INTO plugin_media_assets(id,bot_id,path,sha256,size,mime,created_at,expires_at,width,height) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id,botId,path,hash,size,format.mime,now,now+options.cacheHours*3600_000,format.width??null,format.height??null);
      return id;
    }catch(error){try{await handle.close();}catch{};try{await unlink(temporary);}catch{};throw error;}
  }
  signedUrl(botId:string,id:string,baseUrl:string,expires=Date.now()+600_000):string {
    const row=this.row(botId,id);if(!row||row.expires_at<Date.now()&&row.pinned_until<Date.now())throw new Error('插件媒体不存在或已过期');
    const origin=normalizeMediaBaseUrl(baseUrl);if(!origin)throw new Error('NapCat 媒体回源地址尚未配置');
    const token=this.sign(`${botId}\n${id}\n${expires}`);
    this.db.prepare('UPDATE plugin_media_assets SET pinned_until=MAX(pinned_until,?) WHERE id=?').run(expires,id);
    return `${origin}/internal/plugin-media/${encodeURIComponent(botId)}/${encodeURIComponent(id)}?expires=${expires}&signature=${token}`;
  }
  verify(botId:string,id:string,expires:unknown,signature:unknown,now=Date.now()):boolean {
    if(typeof expires!=='string'||!/^\d{13}$/u.test(expires)||Number(expires)<now||Number(expires)>now+3600_000||typeof signature!=='string'||!/^[0-9a-f]{64}$/u.test(signature))return false;
    const expected=this.sign(`${botId}\n${id}\n${expires}`);return timingSafeEqual(Buffer.from(expected,'hex'),Buffer.from(signature,'hex'))&&this.row(botId,id)!==null;
  }
  probeUrl(connectionId:string,baseUrl:string,expires=Date.now()+60_000):string {const base=normalizeMediaBaseUrl(baseUrl);if(!base)throw new Error('NapCat 媒体回源地址尚未配置');return `${base}/internal/plugin-media-probe/${encodeURIComponent(connectionId)}?expires=${expires}&signature=${this.sign(`probe\n${connectionId}\n${expires}`)}`;}
  verifyProbe(connectionId:string,expires:unknown,signature:unknown):boolean {if(typeof expires!=='string'||!/^\d{13}$/u.test(expires)||Number(expires)<Date.now()||Number(expires)>Date.now()+120_000||typeof signature!=='string'||!/^[0-9a-f]{64}$/u.test(signature))return false;return timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(this.sign(`probe\n${connectionId}\n${expires}`),'hex'));}
  verifiesUrl(botId:string,input:string,baseUrl:string):boolean {
    try {const u=new URL(input),base=normalizeMediaBaseUrl(baseUrl);const parts=u.pathname.split('/');return !!base&&u.origin===base&&parts.length===5&&parts[1]==='internal'&&parts[2]==='plugin-media'&&parts[3]===encodeURIComponent(botId)&&this.verify(botId,decodeURIComponent(parts[4]!),u.searchParams.get('expires'),u.searchParams.get('signature'));}catch{return false;}
  }
  async read(botId:string,id:string,range?:string) {
    const row=this.row(botId,id);if(!row||row.expires_at<Date.now()&&row.pinned_until<Date.now())throw new Error('插件媒体不存在或已过期');const info=await lstat(row.path);if(!info.isFile()||info.isSymbolicLink()||info.size!==row.size)throw new Error('插件媒体不可用');
    let start=0,end=row.size-1,partial=false;
    if(range!==undefined) {
      const m=/^bytes=(\d*)-(\d*)$/u.exec(range);if(!m||!m[1]&&!m[2])throw Object.assign(new Error('请求媒体范围无效'),{statusCode:416});
      if(!m[1]){const tail=Number(m[2]);if(!Number.isSafeInteger(tail)||tail<1)throw Object.assign(new Error('请求媒体范围无效'),{statusCode:416});start=Math.max(0,row.size-tail);}
      else {start=Number(m[1]);if(m[2])end=Math.min(row.size-1,Number(m[2]));}
      if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=row.size||end<start)throw Object.assign(new Error('请求媒体范围无效'),{statusCode:416});partial=true;
    }
    return {mimeType:row.mime,size:row.size,length:end-start+1,start,end,partial,stream:()=>createReadStream(row.path,{start,end,fd:openSync(row.path,constants.O_RDONLY|constants.O_NOFOLLOW),autoClose:true})};
  }
  async imageSnapshot(botId:string,id:string,maxBytes:number):Promise<string> {
    const info=this.info(botId,id);if(!info||info.type!=='image'||info.size>maxBytes)throw new Error('插件图片不存在或超过发送上限');
    const media=await this.read(botId,id);const chunks:Buffer[]=[];let size=0;
    for await(const chunk of media.stream()){const bytes=Buffer.from(chunk);size+=bytes.length;if(size>maxBytes)throw new Error('插件图片超过发送上限');chunks.push(bytes);}
    const bytes=Buffer.concat(chunks);if(bytes.length!==info.size||createHash('sha256').update(bytes).digest('hex')!==info.sha256)throw new Error('插件图片内容校验失败');
    return `base64://${bytes.toString('base64')}`;
  }
  async cleanup(root:string,now=Date.now()) {
    const bots=new Set((this.db.prepare('SELECT DISTINCT bot_id FROM plugin_media_assets').all() as Array<{bot_id:string}>).map(row=>row.bot_id));
    try{for(const directory of await readdir(root,{withFileTypes:true}))if(directory.isDirectory()&&/^[A-Za-z0-9_-]{1,100}$/u.test(directory.name))bots.add(directory.name);}catch{}
    await Promise.all([...bots].map(botId=>this.exclusive(botId,()=>this.cleanupBot(root,botId,now))));
  }
  private async cleanupBot(root:string,botId:string,now:number) {
    const rows=this.db.prepare('SELECT * FROM plugin_media_assets WHERE bot_id=? AND expires_at<? AND pinned_until<?').all(botId,now,now) as unknown as AssetRow[];
    for(const row of rows) {if(!row.path.startsWith(resolve(root)+'/'))continue;try{await unlink(row.path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')continue;}this.db.prepare('DELETE FROM plugin_media_assets WHERE id=?').run(row.id);}
    try {
      for(const file of await readdir(join(root,botId),{withFileTypes:true})) {
        if(!file.isFile()||!/^\.upload-[0-9a-f-]+$|^[0-9a-f]{64}\.(?:mp4|png|jpg|gif|webp)$/u.test(file.name))continue;
        const path=join(root,botId,file.name);if(this.db.prepare('SELECT 1 FROM plugin_media_assets WHERE path=?').get(path))continue;
        try {if((await lstat(path)).mtimeMs<now-3600_000)await unlink(path);}catch{}
      }
    }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
}
export function normalizeMediaBaseUrl(value:string):string {
  if(!value)return '';let u:URL;try{u=new URL(value);}catch{throw new Error('NapCat 媒体回源地址无效');}
  if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash||u.pathname!=='/')throw new Error('NapCat 媒体回源地址必须是不含凭据和路径的 HTTP(S) 地址');return u.origin;
}
