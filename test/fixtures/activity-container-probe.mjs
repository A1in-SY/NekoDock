import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { activity, observeChild, observeCurrentProcess, withActivityReporter } from '/app/dist/src/activity.js';
import { createPiTools } from '/app/dist/src/pi-tools.js';

const root=await mkdtemp('/tmp/activity-probe-');await mkdir('/tmp/home',{recursive:true});
const browserScript=`import {chromium} from 'playwright';
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
try{const page=await browser.newPage();await page.setContent('<canvas width="1000" height="1000"></canvas>');
await page.evaluate(async()=>{const context=document.querySelector('canvas').getContext('2d'),until=performance.now()+3000;
while(performance.now()<until){for(let i=0;i<3000;i++){context.fillStyle='rgb('+i%255+',100,160)';context.fillRect(i%1000,(i*17)%1000,100,100);}await new Promise(resolve=>setTimeout(resolve,4));}});
}finally{await browser.close();}console.log('BROWSER_OK');`;
const pythonScript=`from PIL import Image, ImageFilter
import time,sys
image=Image.effect_noise((1400,1400),50).convert('RGB')
until=time.monotonic()+3
while time.monotonic()<until: image=image.filter(ImageFilter.GaussianBlur(1))
image.save(sys.argv[1])
`;
await writeFile(root+'/browser.mjs',browserScript);await writeFile(root+'/render.py',pythonScript);
const records={browser:[],render:[],wait:[]},events=[];
const capture=(name,kind,label,action)=>withActivityReporter(event=>events.push(event),sample=>records[name].push(sample),()=>activity(kind,label,action));
const bash=createPiTools({workspace:root,targetType:'group',allowCommands:true,allowFileWrites:false},async()=>{}).find(tool=>tool.name==='bash');
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
await Promise.all([
  capture('browser','command','bash',async()=>{
    const result=await bash.execute('synthetic-browser',{command:quote(process.execPath)+' '+quote(root+'/browser.mjs')},new AbortController().signal,()=>{},{});
    assert.match(JSON.stringify(result),/BROWSER_OK/);
  }),
  capture('render','render','image_render',()=>new Promise((resolve,reject)=>{
    const child=spawn('python3',[root+'/render.py',root+'/render.png'],{stdio:'ignore'});observeChild(child);
    child.once('error',reject);child.once('close',code=>code===0?resolve():reject(new Error('Synthetic renderer failed')));
  })),
]);
await new Promise(resolve=>setTimeout(resolve,50));
await capture('wait','model','model_request',async()=>{const stop=observeCurrentProcess();try{await new Promise(resolve=>setTimeout(resolve,2200));}finally{await stop();}});
const has=(name,program)=>records[name].some(sample=>sample.processes.some(process=>process.program===program&&process.cpu>0));
assert.ok(has('browser','browser'),'Browser CPU must be observed through the real bash process tree');
assert.ok(has('render','python'),'Renderer CPU must be observed');
assert.ok(!records.browser.some(sample=>sample.processes.some(process=>process.program==='python')),'Parallel renderer must not enter browser attribution');
assert.ok(!records.render.some(sample=>sample.processes.some(process=>process.program==='browser')),'Parallel browser must not enter renderer attribution');
assert.ok(records.wait.some(sample=>sample.scope==='self'&&sample.cpu!==null),'Waiting main process must have its own counters');
assert.ok(records.wait.every(sample=>sample.cpu===null||sample.cpu<50),'A simulated remote wait must not be reported as local CPU work');
const peak=name=>Math.max(...records[name].map(sample=>sample.cpu??0));
console.log('ACTIVITY_PROBE_RESULT '+JSON.stringify({browser:true,render:true,parallelIsolation:true,wait:true,browserCpuPeak:peak('browser'),renderCpuPeak:peak('render'),waitCpuPeak:peak('wait'),samples:Object.fromEntries(Object.entries(records).map(([key,value])=>[key,value.length])),events:events.length}));
