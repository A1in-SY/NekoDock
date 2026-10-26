import { parseArgs, parseEnv } from 'node:util';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConsoleDatabase } from './database.js';
import { settingsFromEnv } from './settings.js';
import { loadConfig } from '../config.js';
import { DockerClient } from './docker.js';
async function main(){
 const {values}=parseArgs({options:{name:{type:'string'},env:{type:'string'},persona:{type:'string'},volume:{type:'string'},'legacy-container':{type:'string'},'data-dir':{type:'string'}}});
 for(const key of ['name','env','volume','legacy-container'] as const)if(!values[key])throw new Error(`缺少 --${key}`);
 const source=parseEnv(readFileSync(resolve(values.env!),'utf8'));
 const target=loadConfig(source).target;
 const docker=new DockerClient({socketPath:process.env.DOCKER_SOCKET??'/var/run/docker.sock',image:'',network:'',consoleUrl:''});
 const old=await docker.request<{State:{Running:boolean};HostConfig:{RestartPolicy:{Name:string}};Mounts:Array<{Name?:string;Destination:string}>}>('GET',`/containers/${encodeURIComponent(values['legacy-container']!)}/json`);
 if(old.State.Running||old.HostConfig.RestartPolicy.Name!=='no')throw new Error('请先禁用旧容器自动重启并停止旧容器');
 if(!old.Mounts.some(m=>m.Name===values.volume&&m.Destination==='/data'))throw new Error('旧容器与指定数据卷不匹配');
 const directory=resolve(values['data-dir']??process.env.CONSOLE_DATA_DIR??'data/console');mkdirSync(directory,{recursive:true,mode:0o700});
 const db=new ConsoleDatabase(resolve(directory,'console.sqlite3'),resolve(directory,'master.key'));
 try{
  const existing=db.listBots().find(bot=>bot.volume===values.volume);
  if(existing){if(existing.targetType!==target.type||existing.targetId!==target.id)throw new Error('已有实例绑定与导入源不匹配');console.log(JSON.stringify({id:existing.id,name:existing.name,imported:false,reason:'already imported'}));return;}
  const persona=values.persona?readFileSync(resolve(values.persona),'utf8'):'';
  const bot=db.createBot({name:values.name!,description:'从现有实例导入',targetType:target.type,targetId:target.id,config:settingsFromEnv(source,persona),volume:values.volume!,imported:true});
  db.setSetting(`legacy.${bot.id}`,values['legacy-container']!);
  console.log(JSON.stringify({id:bot.id,name:bot.name,imported:true,desiredState:'stopped'}));
 }finally{db.close();}
}
main().catch(error=>{console.error(error instanceof Error?error.message:'导入失败');process.exitCode=1;});
