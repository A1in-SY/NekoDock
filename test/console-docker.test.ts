import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DockerClient } from '../src/console/docker.js';
import { piEnvironment } from '../src/pi.js';
test('model subprocess cannot inherit management control credentials',()=>{
 const fields=['WORKER_TOKEN','CONSOLE_URL','BOT_INSTANCE_ID'];const previous=fields.map(key=>process.env[key]);
 try{for(const key of fields)process.env[key]='private-control-plane';const env=piEnvironment();for(const key of fields)assert.equal(env[key],undefined);}finally{fields.forEach((key,i)=>previous[i]===undefined?delete process.env[key]:process.env[key]=previous[i]);}
});
test('Docker media proxy is restricted to labeled bot regular files and validates format',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'console-docker-'));const socketPath=join(dir,'docker.sock');
 const id='test-id',name=`napcat-managed-${id}`,filename=`${'a'.repeat(64)}.png`,bytes=Buffer.from([137,80,78,71,13,10,26,10,0]);
 let type='0';let mimeValid=true;let label=id;
 const server=createServer((req,res)=>{
  if(req.url===`/containers/${name}/json`){res.setHeader('content-type','application/json');res.end(JSON.stringify({Id:'123',State:{Running:true},Config:{Labels:{'io.napcat.console.bot':label}}}));return;}
  if(req.url?.startsWith(`/containers/${name}/archive?`)){
   const header=Buffer.alloc(512);header.write(filename);header.write(bytes.length.toString(8).padStart(11,'0'),124);header.write(type,156);
   res.end(Buffer.concat([header,mimeValid?bytes:Buffer.alloc(bytes.length),Buffer.alloc(1024)]));return;
  }res.statusCode=404;res.end('{}');
 });
 await new Promise<void>(resolve=>server.listen(socketPath,resolve));const docker=new DockerClient({socketPath,image:'unused',network:'unused',consoleUrl:'unused'});
 try{
  await assert.rejects(docker.media(id,'/etc/passwd'),/路径/);const media=await docker.media(id,`/data/console-media/${filename}`);assert.equal(media.mime,'image/png');assert.deepEqual(media.bytes,bytes);
  type='2';await assert.rejects(docker.media(id,`/data/console-media/${filename}`),/普通文件/);
  type='0';mimeValid=false;await assert.rejects(docker.media(id,`/data/console-media/${filename}`),/格式/);
  label='someone-else';await assert.rejects(docker.media(id,`/data/console-media/${filename}`),/不属于/);
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});}
});
