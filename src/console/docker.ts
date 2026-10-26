import http from 'node:http';
import { hostname } from 'node:os';
import type { BotRecord } from './contracts.js';
import { DockerLogDecoder, type DockerLogSnapshot } from './logs.js';

export interface ContainerInfo { Id: string; State: {Running:boolean;Status:string;Error?:string}; Config:{Labels:Record<string,string>}; Mounts?:Array<{Name?:string;Destination:string}>; }
export interface DockerStats { cpu_stats?:{cpu_usage?:{total_usage?:number};system_cpu_usage?:number;online_cpus?:number;throttling_data?:unknown};precpu_stats?:{cpu_usage?:{total_usage?:number};system_cpu_usage?:number};memory_stats?:{usage?:number;stats?:{inactive_file?:number;total_inactive_file?:number}};networks?:Record<string,{rx_bytes?:number;tx_bytes?:number}>;read?:string; }
export class DockerError extends Error { constructor(public readonly status:number,message='Docker 操作失败'){super(message);} }
export class DockerClient {
  constructor(readonly options:{socketPath:string;image:string;network:string;consoleUrl:string}){}
  request<T>(method:string,path:string,body?:unknown,signal?:AbortSignal):Promise<T>{
    return new Promise((resolve,reject)=>{
      const bytes=body===undefined?undefined:Buffer.from(JSON.stringify(body));let size=0;const chunks:Buffer[]=[];
      const request=http.request({socketPath:this.options.socketPath,path,method,signal,headers:bytes?{'Content-Type':'application/json','Content-Length':bytes.length}:{}},response=>{
        response.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>4*1024*1024){request.destroy();reject(new DockerError(502,'Docker 响应超过限制'));return;}chunks.push(chunk);});
        response.on('end',()=>{const status=response.statusCode??502;if(status>=400){reject(new DockerError(status,status===404?'容器或镜像不存在':status===409?'容器状态冲突':'Docker 操作失败'));return;}try{const text=Buffer.concat(chunks).toString();resolve((text?JSON.parse(text):undefined) as T);}catch{reject(new DockerError(502,'Docker 响应格式无效'));}});
      });
      request.setTimeout(15000,()=>request.destroy(new Error('timeout')));request.on('error',()=>reject(new DockerError(503,'Docker 服务不可用')));if(bytes)request.write(bytes);request.end();
    });
  }
  name(id:string):string{if(!/^[a-zA-Z0-9_-]{1,80}$/.test(id))throw new Error('无效实例 ID');return `napcat-managed-${id}`;}
  async inspect(id:string,signal?:AbortSignal):Promise<ContainerInfo|null>{try{const c=await this.request<ContainerInfo>('GET',`/containers/${this.name(id)}/json`,undefined,signal);if(c.Config.Labels?.['io.napcat.console.bot']!==id)throw new Error('容器不属于此控制台实例');return c;}catch(e){if(e instanceof DockerError&&e.status===404)return null;throw e;}}
  async logs(id:string,signal?:AbortSignal):Promise<DockerLogSnapshot>{
    const container=await this.inspect(id,signal);if(!container)throw new DockerError(404,'实例容器不存在');
    return this.containerLogs(container,`bot:${id}`,signal);
  }
  async consoleLogs(signal?:AbortSignal):Promise<DockerLogSnapshot>{
    // The caller never supplies a container name. Resolve this process's own
    // container, then require the Compose console service label before reading.
    const container=await this.request<ContainerInfo>('GET',`/containers/${encodeURIComponent(hostname())}/json`,undefined,signal);
    if(container.Config.Labels?.['com.docker.compose.service']!=='console'||!container.Config.Labels?.['com.docker.compose.project'])throw new DockerError(403,'容器不是控制台服务');
    return this.containerLogs(container,'console',signal);
  }
  private containerLogs(container:ContainerInfo,source:string,signal?:AbortSignal):Promise<DockerLogSnapshot>{
    if(!/^[a-zA-Z0-9_-]{1,128}$/u.test(container.Id))throw new DockerError(502,'Docker 容器标识无效');
    return new Promise((resolve,reject)=>{
      const decoder=new DockerLogDecoder();let size=0,settled=false;
      const fail=(error:Error)=>{if(!settled){settled=true;reject(error);}};
      const request=http.get({socketPath:this.options.socketPath,path:`/containers/${container.Id}/logs?stdout=true&stderr=true&timestamps=true&tail=501`,signal},response=>{
        if(response.statusCode!==200){response.resume();fail(new DockerError(response.statusCode??502,'Docker 日志暂不可用'));return;}
        response.on('data',(chunk:Buffer)=>{
          if(settled)return;size+=chunk.length;
          if(size>2*1024*1024){fail(new DockerError(502,'Docker 日志超过限制'));request.destroy();return;}
          try{decoder.write(chunk);}catch{fail(new DockerError(502,'Docker 日志格式无效'));request.destroy();}
        });
        response.on('end',()=>{if(settled)return;try{const decoded=decoder.finish();settled=true;resolve({sourceId:`${source}:${container.Id}`,...decoded});}catch{fail(new DockerError(502,'Docker 日志格式无效'));}});
        response.on('error',()=>fail(new DockerError(503,'Docker 日志读取失败')));
      });
      request.setTimeout(5000,()=>request.destroy(new Error('timeout')));
      request.on('error',()=>fail(new DockerError(503,'Docker 日志读取失败')));
    });
  }
  async ensureNetwork():Promise<void>{try{await this.request('GET',`/networks/${encodeURIComponent(this.options.network)}`);}catch(e){if(!(e instanceof DockerError&&e.status===404))throw e;await this.request('POST','/networks/create',{Name:this.options.network,Driver:'bridge',Labels:{'io.napcat.console':'true'}});}}
  async create(bot:BotRecord):Promise<void>{
    await this.ensureNetwork();
    await this.request('POST','/volumes/create',{Name:bot.volume,Labels:{'io.napcat.console.bot':bot.id}});
    await this.request('POST',`/containers/create?name=${this.name(bot.id)}`,{Image:this.options.image,Env:[`BOT_INSTANCE_ID=${bot.id}`,`CONSOLE_URL=${this.options.consoleUrl}`,`WORKER_TOKEN=${bot.workerToken}`],Labels:{'io.napcat.console':'true','io.napcat.console.bot':bot.id},HostConfig:{Init:true,RestartPolicy:{Name:'unless-stopped'},Mounts:[{Type:'volume',Source:bot.volume,Target:'/data'}],NetworkMode:this.options.network,ExtraHosts:['host.docker.internal:host-gateway'],LogConfig:{Type:'json-file',Config:{'max-size':'10m','max-file':'3'}}},StopTimeout:30});
  }
  async start(id:string):Promise<void>{await this.inspect(id);await this.request('POST',`/containers/${this.name(id)}/start`);}
  async stop(id:string):Promise<void>{const c=await this.inspect(id);if(c?.State.Running)await this.request('POST',`/containers/${this.name(id)}/stop?t=10`);}
  async remove(id:string):Promise<void>{const c=await this.inspect(id);if(c?.State.Running)throw new Error('请先停止实例');if(c)await this.request('DELETE',`/containers/${this.name(id)}`);}
  async stats(id:string):Promise<DockerStats>{await this.inspect(id);return this.request('GET',`/containers/${this.name(id)}/stats?stream=false`);}
  async media(id:string,path:string):Promise<{bytes:Buffer;mime:string}>{
    if(!/^\/data\/console-media\/[a-f0-9]{64}\.(png|jpg|gif|webp|mp3)$/.test(path))throw new Error('请求的媒体路径无效');
    if(!await this.inspect(id))throw new Error('实例容器不存在');
    const archive=await new Promise<Buffer>((resolve,reject)=>{
      const chunks:Buffer[]=[];let size=0;
      const req=http.get({socketPath:this.options.socketPath,path:`/containers/${this.name(id)}/archive?path=${encodeURIComponent(path)}`},res=>{
        if(res.statusCode!==200){res.resume();reject(new DockerError(res.statusCode??502,'媒体暂不可用'));return;}
        res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>12*1024*1024){req.destroy();reject(new Error('请求的媒体超过大小限制'));return;}chunks.push(chunk);});
        res.on('end',()=>resolve(Buffer.concat(chunks)));res.on('error',()=>reject(new Error('请求的媒体读取失败')));
      });req.setTimeout(15000,()=>req.destroy());req.on('error',()=>reject(new Error('请求的媒体读取失败')));
    });
    // Docker returns a tar archive. Accept one regular file and never extract paths or symlinks.
    if(archive.length<512||![0,48].includes(archive[156]!))throw new Error('请求的媒体不是普通文件');
    const filename=archive.subarray(0,100).toString().replace(/\0.*$/s,'');
    const sizeText=archive.subarray(124,136).toString().replace(/\0.*$/s,'').trim();
    if(filename!==path.split('/').at(-1)||!/^\d+$/.test(sizeText))throw new Error('请求的媒体归档无效');
    const size=parseInt(sizeText,8);if(!Number.isSafeInteger(size)||size<=0||size>10*1024*1024||archive.length<512+size)throw new Error('请求的媒体大小无效');
    const bytes=archive.subarray(512,512+size),ext=path.split('.').at(-1)!;
    const signatures:Record<string,boolean>={png:bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),jpg:bytes[0]===255&&bytes[1]===216&&bytes[2]===255,gif:/^GIF8[79]a$/.test(bytes.subarray(0,6).toString()),webp:bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP',mp3:bytes.subarray(0,3).toString()==='ID3'||bytes[0]===255&&(bytes[1]!&224)===224};
    if(!signatures[ext])throw new Error('请求的媒体格式无效');
    return {bytes,mime:ext==='mp3'?'audio/mpeg':`image/${ext==='jpg'?'jpeg':ext}`};
  }
}
