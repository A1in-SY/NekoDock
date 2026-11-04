import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {bilibiliResources,normalizeBilibiliResource} from '../src/plugins/bilibili/recognize.js';
import {parseDynamicItem,parseOpusItem,resolveDynamic} from '../src/plugins/bilibili/dynamic.js';
import {resolveLive} from '../src/plugins/bilibili/live.js';
import {BILIBILI_DEFAULTS,validateBilibiliConfig} from '../src/plugins/bilibili/config.js';
import {validatePluginContent,contentText} from '../src/plugins/bilibili/content.js';
import {executeBilibiliJob} from '../src/plugins/bilibili/runner.js';
import {preparePresentation,type BilibiliRun} from '../src/plugins/bilibili/presentation.js';
import {contentPlugin} from '../src/plugin-system/registry.js';
import type {PluginContent,PluginRunnerJob} from '../src/plugin-system/contracts.js';

const resource=normalizeBilibiliResource('https://www.bilibili.com/opus/100001')!;
const signal=()=>new AbortController().signal;
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1sAAAAASUVORK5CYII=','base64');
const api=(data:unknown)=>new Response(JSON.stringify({code:0,data}));
function item(id='100001',text='Synthetic paragraph.'){return {id_str:id,type:'DYNAMIC_TYPE_WORD',modules:{module_author:{mid:'2001',name:'Synthetic author',pub_ts:1700000000,face:'https://i0.hdslb.com/bfs/face/avatar.jpg'},module_dynamic:{desc:{text}}}};}
const content=():PluginContent=>({type:'post',platform:'bilibili',resourceId:resource.id,url:resource.url,title:'Synthetic post',author:'Synthetic author',publishedAt:1700000000,blocks:[{type:'paragraph',text:'First paragraph\nSecond paragraph'},{type:'image',image:{id:'photo-one',url:'https://i0.hdslb.com/bfs/new_dyn/photo.png',role:'content',status:'pending'}}],retrieval:{status:'ready'}});
const job=():PluginRunnerJob&{config:typeof BILIBILI_DEFAULTS;resource:typeof resource}=>({id:'synthetic-job',lease:'synthetic-lease',botId:'synthetic-bot',pluginId:'bilibili',operation:'prepare',resource,config:{...BILIBILI_DEFAULTS},networkProxy:{enabled:false,url:'',noProxy:'',forTools:true},expiresAt:Date.now()+60000,content:content(),presentation:{mode:'original',provideContext:true}});
const inspect:BilibiliRun=async()=>JSON.stringify({width:1,height:1});
async function directory(t:{after(fn:()=>Promise<void>):void}){const root=await mkdtemp(join(tmpdir(),'nekodock-bili-unit-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}

test('Bilibili links classify dynamic, opus, live and unresolved short resources',async()=>{
 const pairs=[['https://t.bilibili.com/12345678901234567890?from=copy','post:12345678901234567890'],['https://www.bilibili.com/opus/100001?share=copy','post:100001'],['https://m.bilibili.com/opus/100001','post:100001'],['https://live.bilibili.com/123?live_from=copy','live:123'],['https://live.bilibili.com/h5/123','live:123'],['https://live.m.bilibili.com/h5/123','live:123'],['https://b23.tv/AbCd','short:AbCd']];
 for(const [url,id]of pairs){assert.equal(normalizeBilibiliResource(url!)?.id,id);assert.equal(bilibiliResources({message:[{type:'text',data:{text:url}}]})[0]?.id,id);}
 for(const url of ['https://t.bilibili.com.evil.test/123','https://live.bilibili.com:8443/123','https://user:pass@www.bilibili.com/opus/123','https://www.bilibili.com/opus/not-a-number'])assert.equal(normalizeBilibiliResource(url),null);
 const list=bilibiliResources({message:[{type:'json',data:{data:{meta:{detail_1:{qqdocurl:'https://t.bilibili.com/100001'}}}}},{type:'text',data:{text:'https://www.bilibili.com/opus/100001'}}]});assert.equal(list.length,1);
});

test('old Bilibili configurations gain bounded new defaults and reject unknown display modes',()=>{
 const old=Object.fromEntries(Object.entries(BILIBILI_DEFAULTS).filter(([key])=>!key.startsWith('dynamic')&&!key.startsWith('live')));
 const settings=validateBilibiliConfig(old);assert.equal(settings.dynamicEnhance,true);assert.equal(settings.liveDisplay,'off');assert.equal(settings.autoVideo,false);
 assert.throws(()=>validateBilibiliConfig({dynamicDisplay:'screenshot-any-url'}));
});

test('forwarded dynamic keeps two authors, topics, image order and one original level',()=>{
 const original={...item('100002','Original words'),type:'DYNAMIC_TYPE_DRAW',orig:item('100003','Nested original')};
 Object.assign(original.modules.module_dynamic,{topic:{name:'Synthetic topic'},major:{draw:{items:[{src:'https://i0.hdslb.com/bfs/new_dyn/a.jpg',width:100,height:200},{src:'https://evil.test/b.jpg'}]}}});
 const outer={...item('100001','Forwarder words'),type:'DYNAMIC_TYPE_FORWARD',orig:original};
 const parsed=parseDynamicItem(outer,'100001',1700000100);assert.equal(parsed.author,'Synthetic author');assert.equal(parsed.description,'Forwarder words');assert.equal(parsed.original?.description,'#Synthetic topic#\nOriginal words');assert.equal(parsed.original?.original,undefined);
 assert.equal(parsed.original?.blocks?.filter(block=>block.type==='image').length,1);assert.equal(parsed.original?.blocks?.at(-1)?.type,'image');
 assert.match(contentText(parsed),/转发自 Synthetic author/u);
});

test('Opus paragraphs retain title, unicode, custom emoji and image sequence',()=>{
 const parsed=parseOpusItem({id_str:'100001',modules:[{module_title:{text:'Synthetic title'}},{module_author:{mid:'2001',name:'Synthetic author',pub_ts:'1700000000'}},{module_content:{paragraphs:[{text:{nodes:[{word:{words:'Line one\n👂👂'}},{rich:{type:'RICH_TEXT_NODE_TYPE_EMOJI',text:'[Synthetic emoji]',emoji:{icon_url:'https://i0.hdslb.com/bfs/garb/emoji.png'}}}]}},{pic:{pics:[{url:'http://i0.hdslb.com/bfs/new_dyn/photo.png',width:100,height:200}]}}]}}]},'100001');
 assert.equal(parsed.title,'Synthetic title');assert.equal(parsed.blocks?.[0]?.type,'paragraph');assert.equal(parsed.blocks?.[1]?.type,'image');
 const p=parsed.blocks?.[0];assert.ok(p?.type==='paragraph');assert.equal(p.spans?.[1]?.type,'emoji');assert.equal(p.text,'Line one\n👂👂[Synthetic emoji]');
 const normalized=validatePluginContent(parsed,resource);assert.equal(normalized.blocks?.length,2);assert.equal(normalized.publishedAt,1700000000);
});

test('metadata validation strips unexpected fields and rejects resource identity changes',()=>{
 const source=content();const parsed=validatePluginContent({...source,unknown:'not included',blocks:[...(source.blocks??[]),{type:'image',image:{id:'bad',role:'content',url:'http://127.0.0.1/image.png'}}]},resource);
 assert.equal('unknown'in parsed,false);assert.equal(parsed.blocks?.length,2);
 assert.throws(()=>validatePluginContent({...source,resourceId:'post:wrong'},resource));
});

test('Opus enrichment uses full detail for a text-only post and preserves its title',async()=>{
 const calls:string[]=[];
 const parsed=await resolveDynamic(resource,async input=>{const url=String(input);calls.push(url);return url.includes('/opus/detail')?api({item:{id_str:'100001',modules:[{module_title:{text:'Full title'}},{module_content:{paragraphs:[{text:{nodes:[{word:{words:'Full paragraph'}}]}}]}}]}}):api({item:item()});},signal());
 assert.equal(parsed.title,'Full title');assert.equal(parsed.description,'Full paragraph');assert.equal(calls.length,2);
});

test('failed full-text request retains retrieved dynamic content as partial',async()=>{
 const parsed=await resolveDynamic(resource,async input=>String(input).includes('/opus/detail')?new Response(JSON.stringify({code:-101})):api({item:item()}),signal());
 assert.equal(parsed.retrieval.status,'partial');assert.equal(parsed.description,'Synthetic paragraph.');
});

test('live metadata canonicalizes a short room, separates cover and preview, and keeps observation time',async()=>{
 const r=normalizeBilibiliResource('https://live.bilibili.com/1')!;const calls:string[]=[];
 const parsed=await resolveLive(r,async(input,options)=>{calls.push(String(input));assert.equal(new Headers(options?.headers).get('cookie'),'SESSDATA=synthetic');return String(input).includes('/Master/')?api({info:{uname:'Synthetic anchor',face:'https://i0.hdslb.com/bfs/face/avatar.jpg'}}):api({room_id:900001,short_id:1,uid:2001,title:'Synthetic live',live_status:1,live_time:'2026-01-01 12:00:00',area_name:'Synthetic area',parent_area_name:'Synthetic category',user_cover:'https://i0.hdslb.com/bfs/live/cover.jpg',keyframe:'https://i0.hdslb.com/bfs/live-key-frame/current.jpg'});},signal(),'SESSDATA=synthetic');
 assert.equal(parsed.resourceId,'live:900001');assert.equal(parsed.author,'Synthetic anchor');assert.equal(parsed.live?.preview?.role,'live_preview');assert.equal(parsed.live?.cover?.role,'cover');assert.equal(parsed.live?.startedAt,Date.parse('2026-01-01T12:00:00+08:00')/1000);assert.ok(parsed.observedAt);assert.equal(calls.length,2);
});

test('offline live metadata ignores a stale keyframe and missing author stays partial',async()=>{
 const r=normalizeBilibiliResource('https://live.bilibili.com/1')!;
 const parsed=await resolveLive(r,async input=>String(input).includes('/Master/')?new Response(JSON.stringify({code:-352})):api({room_id:900001,uid:2001,title:'Offline room',live_status:0,live_time:'0000-00-00 00:00:00',keyframe:'https://i0.hdslb.com/bfs/live-key-frame/old.jpg'}),signal());
 assert.equal(parsed.live?.status,'offline');assert.equal(parsed.live?.preview,undefined);assert.equal(parsed.live?.startedAt,undefined);assert.equal(parsed.retrieval.status,'partial');
});

test('display policy is independent of contextual enhancement, and info does not add automatic images',()=>{
 const plugin=contentPlugin('bilibili'),settings={...BILIBILI_DEFAULTS,dynamicEnhance:false,dynamicDisplay:'card' as const};
 const next=plugin.afterResolve('share',resource,settings,content());assert.equal(next.provideContext,false);assert.deepEqual(next.prepare,{mode:'card',provideContext:false});
 const info=plugin.afterResolve('info',resource,settings,content());assert.match(info.replyText??'',/Synthetic post/u);assert.equal(info.prepare?.mode,'none');
 const download=plugin.afterResolve('download',resource,settings,content());assert.equal(download.prepare,undefined);assert.match(download.replyText??'',/仅支持视频/u);
});

test('short shares classify after redirects before invoking a metadata API',async t=>{
 const root=await directory(t),short=normalizeBilibiliResource('https://b23.tv/AbCd')!;let extractor=false;
 const execution=await executeBilibiliJob({...job(),resource:short,operation:'resolve'},root,signal(),{fetch:async input=>String(input).includes('b23.tv')?new Response(null,{status:302,headers:{location:'https://t.bilibili.com/100001'}}):String(input).includes('/opus/detail')?new Response(JSON.stringify({code:-101})):api({item:item()}),run:async()=>{extractor=true;throw new Error('unexpected extractor');}});
 assert.equal(execution.content?.type,'post');assert.equal(extractor,false);await execution.cleanup();
});

test('original presentation caches source images without leaking Cookie and gives each output a role',async t=>{
 const root=await directory(t);let seen=false;
 const prepared=await preparePresentation(job(),root,async(_input,options)=>{seen=true;assert.equal(new Headers(options?.headers).get('cookie'),null);assert.equal(options?.redirect,'error');return new Response(png,{headers:{'last-modified':'Thu, 01 Jan 2026 00:00:00 GMT'}});},inspect,{},signal());
 assert.equal(seen,true);assert.equal(prepared.files?.length,1);assert.equal(prepared.outputs?.[0]?.kind,'reply');assert.equal(prepared.outputs?.[1]?.assetRole,'content');
 const b=prepared.content?.blocks?.[1];assert.ok(b?.type==='image');assert.equal(b.image.assetKey,'source-0');assert.equal(b.image.status,'ready');assert.ok(b.image.fetchedAt);assert.equal(b.image.imageLastModified,'Thu, 01 Jan 2026 00:00:00 GMT');
});

test('image failure does not fail the text result or falsely report a sent image',async t=>{
 const root=await directory(t);
 const prepared=await preparePresentation(job(),root,async()=>new Response('missing',{status:404}),inspect,{},signal());
 assert.equal(prepared.content?.retrieval.status,'partial');assert.equal(prepared.files?.length,0);assert.equal(prepared.outputs?.length,1);assert.match(prepared.outputs?.[0]?.text??'',/部分图片/u);
});

test('card rendering failure falls back to original content while a successful card is presentation-only',async t=>{
 const root=await directory(t),j=job();j.presentation={mode:'card',provideContext:true};
 const fallback=await preparePresentation(j,root,async()=>new Response(png),async(_command,args)=>{if(args[1]==='render')throw new Error('renderer failed');return '{"width":1,"height":1}';},{},signal());
 assert.equal(fallback.content?.retrieval.error,'BILIBILI_PRESENTATION_FALLBACK');assert.equal(fallback.outputs?.[0]?.kind,'reply');
 const success=await preparePresentation(j,root,async()=>new Response(png),async(_command,args)=>{if(args[1]==='render'){await writeFile(join(root,'card-0.png'),png);return '{"files":["card-0.png"]}';}return '{"width":1,"height":1}';},{},signal());
 assert.deepEqual(success.outputs,[{kind:'image',assetKey:'card-0',assetRole:'presentation'}]);assert.equal(success.files?.at(-1)?.role,'presentation');
});

test('context-only preparation skips decorations and enforces the original image count',async t=>{
 const root=await directory(t),j=job();j.presentation={mode:'none',provideContext:true};j.content=content();
 j.content.authorAvatar={id:'avatar',url:'https://i0.hdslb.com/bfs/face/a.png',role:'avatar'};
 for(let i=0;i<6;i++)j.content.blocks!.push({type:'image',image:{id:'extra-'+i,url:`https://i0.hdslb.com/bfs/new_dyn/${i}.png`,role:'content'}});
 const fetched:string[]=[];const prepared=await preparePresentation(j,root,async input=>{fetched.push(String(input));return new Response(png);},inspect,{},signal());
 assert.equal(fetched.length,4);assert.ok(fetched.every(url=>!url.includes('/face/')));assert.equal(prepared.outputs,undefined);assert.equal(prepared.content?.retrieval.status,'partial');
});

test('cancelled preparation does not fetch or launch a subprocess',async t=>{
 const root=await directory(t),controller=new AbortController();controller.abort();
 await assert.rejects(preparePresentation(job(),root,async()=>assert.fail('Unexpected network'),async()=>assert.fail('Unexpected subprocess'),{},controller.signal));
});

const pillow=spawnSync('python3',['-c','import PIL'],{stdio:'ignore'}).status===0;
test('actual Pillow renderer produces a bounded card using one shared text baseline',{skip:!pillow},async t=>{
 const root=await directory(t),c=content();c.blocks=[{type:'paragraph',text:'测试基线，标点应位于文字下方。\nUnicode 👂 与换行。'}];
 const request=join(root,'render.json');await writeFile(request,JSON.stringify({content:c,paths:{},maxPages:3}));
 const child=spawnSync('python3',['src/plugins/bilibili/render/card.py','render',request],{encoding:'utf8'});assert.equal(child.status,0,child.stderr);const result=JSON.parse(child.stdout);assert.deepEqual(result.files,['card-0.png']);
 const header=await readFile(join(root,result.files[0]));assert.equal(header.toString('hex',0,8),'89504e470d0a1a0a');
 assert.equal(header.readUInt32BE(16),1080);assert.ok(header.readUInt32BE(20)<6000);
});

test('truncated or unsupported post data stays explicitly partial',()=>{
 const oversized=Array.from({length:120},()=>({text:{nodes:[{word:{words:'Synthetic paragraph.'}}]}}));
 const opus=parseOpusItem({id_str:'100001',modules:[{module_content:{paragraphs:oversized}}]},'100001');assert.equal(opus.retrieval.status,'partial');assert.ok((opus.blocks?.length??0)<=100);
 const text=parseOpusItem({id_str:'100001',modules:[{module_content:{paragraphs:[{text:{nodes:[{word:{words:'x'.repeat(13000)}}]}}]}}]},'100001');assert.equal(text.retrieval.status,'partial');assert.equal(text.description?.length,12000);
 const unsupported=parseOpusItem({id_str:'100001',modules:[{module_content:{paragraphs:[{para_type:99,unsupported:{content:'not understood'}}]}}]},'100001');assert.equal(unsupported.retrieval.error,'BILIBILI_CONTENT_UNSUPPORTED');
});

test('a forwarded folded Opus obtains one full original, otherwise reports its missing full text',async()=>{
 const original={...item('100002','Original summary'),modules:{...item().modules,module_dynamic:{major:{type:'MAJOR_TYPE_OPUS',opus:{summary:{text:'Original summary'}}}}}};
 let calls=0;const parsed=await resolveDynamic(resource,async input=>{calls++;return String(input).includes('opus/detail?id=100002')?api({item:{id_str:'100002',modules:[{module_content:{paragraphs:[{text:{nodes:[{word:{words:'Full original'}}]}}]}}]}}):api({item:{...item(),type:'DYNAMIC_TYPE_FORWARD',orig:original}});},signal());
 assert.equal(calls,2);assert.equal(parsed.original?.description,'Full original');
 const partial=await resolveDynamic(resource,async input=>String(input).includes('/opus/detail')?new Response(JSON.stringify({code:-101})):api({item:{...item(),type:'DYNAMIC_TYPE_FORWARD',orig:original}}),signal());
 assert.equal(partial.retrieval.status,'partial');assert.equal(partial.original?.retrieval.status,'partial');
});

test('a disabled resource reached through a short share does not fetch metadata',async t=>{
 const root=await directory(t);let calls=0;
 const result=await executeBilibiliJob({...job(),operation:'resolve',command:'share',resource:normalizeBilibiliResource('https://b23.tv/AbCd')!,config:{...BILIBILI_DEFAULTS,liveEnhance:false,liveDisplay:'off'}},root,signal(),{fetch:async()=>{calls++;return new Response(null,{status:302,headers:{location:'https://live.bilibili.com/123'}});},run:async()=>assert.fail('Unexpected subprocess')});
 assert.equal(calls,1);assert.equal(result.content?.type,'live');assert.equal(result.content?.live,undefined);assert.doesNotThrow(()=>validatePluginContent(result.content,resource));await result.cleanup();
});

test('an instance image byte limit skips oversized image without losing text',async t=>{
 const root=await directory(t),j={...job(),imageMaxBytes:16};
 const prepared=await preparePresentation(j,root,async()=>new Response(png,{headers:{'content-length':String(png.length)}}),async()=>assert.fail('Oversized image must not decode'),{},signal());
 assert.equal(prepared.content?.retrieval.status,'partial');assert.equal(prepared.files?.length,0);assert.equal(prepared.outputs?.[0]?.kind,'reply');
});

test('Pillow renderer supports inline custom emoji assets without falling back',{skip:!pillow},async t=>{
 const root=await directory(t),path=join(root,'emoji.png');await writeFile(path,png);const c=content();c.blocks=[{type:'paragraph',text:'标点，[Synthetic emoji]',spans:[{type:'text',text:'标点，'},{type:'emoji',text:'[Synthetic emoji]',assetKey:'emoji'}]}];
 const request=join(root,'render.json');await writeFile(request,JSON.stringify({content:c,paths:{emoji:path},maxPages:3}));
 const child=spawnSync('python3',['src/plugins/bilibili/render/card.py','render',request],{encoding:'utf8'});assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout).files,['card-0.png']);
});

test('same image URL in distinct live roles has independent upload provenance',async t=>{
 const root=await directory(t),j=job(),shared='https://i0.hdslb.com/bfs/live/shared.png';j.resource=normalizeBilibiliResource('https://live.bilibili.com/123')!;
 j.content={type:'live',platform:'bilibili',resourceId:'live:123',url:j.resource.url,title:'Synthetic live',retrieval:{status:'ready'},live:{roomId:'123',status:'live',preview:{id:'preview',url:shared,role:'live_preview'},cover:{id:'cover',url:shared,role:'cover'}}};
 const result=await preparePresentation(j,root,async()=>new Response(png),inspect,{},signal());
 assert.equal(result.files?.length,2);assert.deepEqual(result.files?.map(file=>file.role),['live_preview','cover']);assert.notEqual(result.content?.live?.preview?.assetKey,result.content?.live?.cover?.assetKey);
});

test('failed decorations are attempted at most thirteen times and source photos get priority',async t=>{
 const root=await directory(t),j=job();j.presentation={mode:'card',provideContext:true};
 const spans=Array.from({length:40},(_,i)=>({type:'emoji' as const,text:`[emoji-${i}]`,url:`https://i0.hdslb.com/bfs/garb/${i}.png`}));
 j.content=content();j.content.blocks!.unshift({type:'paragraph',text:spans.map(s=>s.text).join(''),spans});
 let requests=0;const urls:string[]=[];
 const result=await preparePresentation(j,root,async input=>{requests++;urls.push(String(input));return new Response(null,{status:404});},async()=>{throw new Error('renderer unavailable');},{},signal());
 assert.equal(requests,13);assert.ok(urls[0]?.includes('/new_dyn/'));assert.equal(result.content?.retrieval.status,'partial');assert.equal(result.outputs?.[0]?.kind,'reply');
});

test('Pillow plans and inspects JPEGs using EXIF display orientation',{skip:!pillow},async t=>{
 const root=await directory(t),script='src/plugins/bilibili/render/card.py';
 const result=spawnSync('python3',['-c',String.raw`
import importlib.util,json,pathlib,sys
from PIL import Image
root=pathlib.Path(sys.argv[1])
spec=importlib.util.spec_from_file_location('renderer',sys.argv[2]);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
results=[]
for orientation in (6,8):
 path=root/f'rotated-{orientation}.jpg';exif=Image.Exif();exif[274]=orientation
 Image.new('RGB',(160,80),'#13579b').save(path,exif=exif)
 content={'type':'post','platform':'bilibili','resourceId':'post:100001','url':'https://www.bilibili.com/opus/100001','title':'Synthetic EXIF image','blocks':[{'type':'image','image':{'id':'rotated','url':'https://i0.hdslb.com/synthetic.jpg','role':'content','assetKey':'rotated'}}],'retrieval':{'status':'ready'}}
 renderer=module.Renderer({'content':content,'paths':{'rotated':str(path)}},root)
 renderer.plan();item=next(value for value in renderer.items if value['kind']=='image')
 with Image.open(path) as image:size=module.display_size(image)
 renderer.render()
 with Image.open(root/'card-0.png') as card:assert card.height<6000
 results.append({'orientation':orientation,'displaySize':size,'plannedRatio':(item['height']-20)/item['width']})
print(json.dumps(results))
`,root,script],{encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
 assert.equal(result.status,0,result.stderr);
 for(const entry of JSON.parse(result.stdout)){assert.deepEqual(entry.displaySize,[80,160]);assert.equal(entry.plannedRatio,2);}
 for(const orientation of [6,8]){const inspected=spawnSync('python3',[script,'inspect',join(root,`rotated-${orientation}.jpg`),'24000000'],{encoding:'utf8'});assert.equal(inspected.status,0,inspected.stderr);assert.deepEqual(JSON.parse(inspected.stdout),{width:80,height:160});}
});
