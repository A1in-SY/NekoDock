import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

const image=process.env.PLUGIN_RUNNER_E2E_IMAGE;
const execute=promisify(execFile);
const bootstrap=String.raw`
import {executeHeyboxJob} from '/app/dist/src/plugins/heybox/runner.js';
import {execFileSync} from 'node:child_process';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAFElEQVR4nGPUaLrEwMDAxAAGUAoAG94BgqFCKSEAAAAASUVORK5CYII=','base64');
const resource={kind:'game',id:'game:pc:123456',url:'https://www.xiaoheihe.cn/app/topic/game/pc/123456'};
const config={enhance:true,autoCard:true,showPrices:true};
const job={id:'synthetic-job',lease:'synthetic-lease',botId:'synthetic-bot',pluginId:'heybox',operation:'resolve',resource,config,
 networkProxy:{enabled:false,url:'',noProxy:'',forTools:true},expiresAt:Date.now()+60000};
let requests=0;
const fetcher=async input=>{
 requests++;const url=new URL(input);
 if(url.hostname==='api.xiaoheihe.cn')return Response.json({status:'ok',result:{appid:123456,game_type:'pc',platf:'epic',name:'示例游戏 🎮 中文标点，换行排版。',name_en:'Example Adventure',
  image:'https://cdn.max-c.com/synthetic-cover.png',score:'8.5',comment_stats:{score_comment:1234},platforms_list:[{appid:123456,platf:'epic',game_type:'pc',name:'Epic'}],
  price:{current:'25',initial:'50',discount:50,region_name:'中国',lowest_price:'20'},heybox_price:{cost_coin:23000,coupon_info:{final_price:'22',coupon_desc:'需领券',sub_title:'示例条件'}},
  about_the_game:'这是实际排版验证用的合成游戏简介。中文和 English mixed text。'.repeat(15),release_date:'2030-01-01',is_free:false}});
 if(url.hostname==='cdn.max-c.com')return new Response(png,{headers:{'content-type':'image/png'}});
 throw Error('Unexpected fixture request');
};
const signal=new AbortController().signal;
const resolved=await executeHeyboxJob(job,'/output',signal,{fetch:fetcher});
const content=resolved.content;await resolved.cleanup();
const result=await executeHeyboxJob({...job,operation:'prepare',content,presentation:{mode:'card',provideContext:true}},'/output',signal,{fetch:fetcher});
try{
 const card=result.files?.find(file=>file.role==='presentation');if(!card)throw Error('Rendering unexpectedly fell back to text');
 const inspect=JSON.parse(execFileSync('python3',['-c','import json,sys;from PIL import Image;im=Image.open(sys.argv[1]);im.load();print(json.dumps({"width":im.width,"height":im.height,"format":im.format}))',card.path],{encoding:'utf8'}));
 console.log(JSON.stringify({requests,outputKinds:result.outputs.map(output=>output.kind),roles:result.files.map(file=>file.role),retrieval:result.content.retrieval.status,inspect}));
}finally{await result.cleanup();}
`;

test('isolated plugin image renders a complete synthetic game card through the actual Runner and Pillow',{skip:!image,timeout:60000},async t=>{
 const output=await mkdtemp(join(tmpdir(),'nekodock-game-render-')),name='nekodock-game-render-'+randomUUID();
 await chmod(output,0o777);
 t.after(async()=>{await execute('docker',['rm','-f',name]).catch(()=>{});await rm(output,{recursive:true,force:true});});
 const {stdout}=await execute('docker',['run','--rm','--name',name,'--network','none','--cpus','1','--memory','384m',
  '--mount',`type=bind,src=${output},dst=/output`,'--entrypoint','node',image!,'--input-type=module','-e',bootstrap],{timeout:55000,maxBuffer:1024*1024});
 const result=JSON.parse(stdout);
 assert.equal(result.requests,2);assert.deepEqual(result.outputKinds,['image']);assert.deepEqual(result.roles,['cover','presentation']);
 assert.equal(result.retrieval,'ready');assert.equal(result.inspect.format,'PNG');assert.equal(result.inspect.width,1080);
 assert.ok(result.inspect.height>600&&result.inspect.height<=6000);
});

const postBootstrap=String.raw`
import {executeHeyboxJob} from '/app/dist/src/plugins/heybox/runner.js';
import {execFileSync} from 'node:child_process';
const tall=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAFElEQVR4nGPUaLrEwMDAxAAGUAoAG94BgqFCKSEAAAAASUVORK5CYII=','base64');
const wide=execFileSync('python3',['-c','from PIL import Image;import io,sys;s=io.BytesIO();Image.new("RGB",(2,1),"#275c61").save(s,format="PNG");sys.stdout.buffer.write(s.getvalue())']);
const resource={kind:'post',id:'post:synthetic-share',url:'https://www.xiaoheihe.cn/app/bbs/link/synthetic-share'};
const job={id:'synthetic-post-job',lease:'synthetic-lease',botId:'synthetic-bot',pluginId:'heybox',operation:'resolve',resource,config:{},
 networkProxy:{enabled:false,url:'',noProxy:'',forTools:true},expiresAt:Date.now()+60000};
let requests=0;
const fetcher=async input=>{
 requests++;const url=new URL(input);
 if(url.hostname==='api.xiaoheihe.cn')return Response.json({status:'ok',result:{link:{linkid:123456,title:'合成图文攻略',user:{username:'合成作者'},create_at:1700000000,
 text:JSON.stringify([{type:'text',text:'合成正文。'},...Array.from({length:12},(_,i)=>({type:'img',url:'https://cdn.max-c.com/synthetic-'+i+'.png'}))])}}});
 if(url.hostname==='cdn.max-c.com')return new Response(url.pathname==='/synthetic-0.png'?wide:tall);
 throw Error('Unexpected fixture request');
};
const signal=new AbortController().signal;
const resolved=await executeHeyboxJob(job,'/output',signal,{fetch:fetcher});const content=resolved.content;await resolved.cleanup();
const result=await executeHeyboxJob({...job,operation:'prepare',resource:{kind:'post',id:content.resourceId,url:content.url},content,presentation:{mode:'card',provideContext:true}},'/output',signal,{fetch:fetcher});
try {
 const cards=result.files.filter(file=>file.role==='presentation');
 const sizes=cards.map(card=>JSON.parse(execFileSync('python3',['-c','import json,sys;from PIL import Image;im=Image.open(sys.argv[1]);im.load();print(json.dumps({"width":im.width,"height":im.height,"format":im.format}))',card.path],{encoding:'utf8'})));
 console.log(JSON.stringify({requests,retrieval:result.content.retrieval.status,sourceCount:result.files.filter(file=>file.role==='content').length,outputs:result.outputs.map(output=>output.kind),sizes}));
} finally {await result.cleanup();}
`;

test('isolated plugin image resolves and renders twelve post images into four pages',{skip:!image,timeout:60000},async t=>{
 const output=await mkdtemp(join(tmpdir(),'nekodock-post-render-')),name='nekodock-post-render-'+randomUUID();await chmod(output,0o777);
 t.after(async()=>{await execute('docker',['rm','-f',name]).catch(()=>{});await rm(output,{recursive:true,force:true});});
 const {stdout}=await execute('docker',['run','--rm','--name',name,'--network','none','--cpus','1','--memory','384m',
  '--mount',`type=bind,src=${output},dst=/output`,'--entrypoint','node',image!,'--input-type=module','-e',postBootstrap],{timeout:55000,maxBuffer:1024*1024});
 const result=JSON.parse(stdout);assert.equal(result.requests,13);assert.equal(result.retrieval,'ready');assert.equal(result.sourceCount,12);
 assert.deepEqual(result.outputs,['image','image','image','image']);assert.equal(result.sizes.length,4);
 for(const size of result.sizes){assert.equal(size.width,1080);assert.equal(size.format,'PNG');assert.ok(size.height<=5250);}
});
