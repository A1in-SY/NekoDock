import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const image=process.env.ACTIVITY_E2E_IMAGE;
test('isolated Linux image distinguishes real browser and Pillow CPU in parallel and a simulated provider wait', {skip:!image,timeout:60000},async()=>{
  const name='nekodock-activity-probe-'+randomUUID();
  const script=readFileSync(new URL('../../test/fixtures/activity-container-probe.mjs',import.meta.url),'utf8');
  const child=spawn('docker',['run','--interactive','--rm','--init','--name',name,'--network','none','--read-only','--memory','1536m','--pids-limit','256',
    '--cap-drop','ALL','--security-opt','no-new-privileges','--tmpfs','/tmp:rw,nosuid,size=256m,uid=1000,gid=1000',
    '--tmpfs','/data:rw,nosuid,size=16m,uid=1000,gid=1000','--env','HOME=/tmp/home','--entrypoint','node',image!,'--input-type=module','-'],{stdio:['pipe','pipe','pipe'],signal:AbortSignal.timeout(55000)});
  let output='';child.stdout.on('data',bytes=>{output+=bytes});child.stderr.on('data',bytes=>{output+=bytes});
  try{
    const exit=new Promise<number|null>((resolve,reject)=>{child.once('close',resolve);child.once('error',reject);});child.stdin.end(script);
    assert.equal(await exit,0,output);
    const result=/ACTIVITY_PROBE_RESULT (.+)/u.exec(output)?.[1];assert.ok(result,output);assert.equal(JSON.parse(result).parallelIsolation,true);
  }finally{spawnSync('docker',['stop','--time','3',name],{stdio:'ignore',timeout:10000});}
});
