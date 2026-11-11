import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,writeFile,chmod,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const image=process.env.PLUGIN_RUNNER_E2E_IMAGE;
const execute=promisify(execFile);
const bootstrap=String.raw`
import importlib.util,json,pathlib,subprocess,sys
from PIL import Image,ImageDraw,ImageChops
root=pathlib.Path('/output')
fixture=json.loads(pathlib.Path('/fixtures/data.json').read_text())
for name,color,size in [('portrait.png','#13579b',(400,800)),('preview.png','#2468ac',(640,360)),('emoji.png','#e76693',(40,40)),('avatar.png','#83c8b4',(100,100))]:
 Image.new('RGB',size,color).save(root/name)
script='/app/dist/src/plugins/bilibili/render/card.py'
spec=importlib.util.spec_from_file_location('renderer',script);renderer=importlib.util.module_from_spec(spec);spec.loader.exec_module(renderer)
alpha_avatar=Image.new('RGBA',(76,76),'#e66b91');ImageDraw.Draw(alpha_avatar).ellipse((29,29,47,47),fill=(0,0,0,0));alpha_avatar.save(root/'avatar-alpha.png')
author_rows=[]
for kind in ('video','post','live'):
 content={'type':kind,'author':'Synthetic long author\n'*80,'publishedAt':1700000000,'authorAvatar':{'assetKey':'alpha'},'live':{'roomId':'10001'}}
 canvas=Image.new('RGB',(1080,235),'white');renderer.Renderer({'content':content,'paths':{'alpha':str(root/'avatar-alpha.png')}},root).draw_author(canvas)
 assert canvas.getpixel((52,116))==(255,255,255)
 assert canvas.getpixel((90,154))==(255,255,255)
 assert canvas.getpixel((90,120))==(230,107,145)
 name=canvas.crop((147,100,1080,162));box=ImageChops.difference(name,Image.new('RGB',name.size,'white')).getbbox()
 assert box and box[2]<=881
 author_rows.append(name.tobytes())
assert author_rows[0]==author_rows[1]==author_rows[2]
paths={key:str(root/name) for key,name in fixture['paths'].items()}
results=[]
for index,content in enumerate(fixture['contents']):
 source=root/f'request-{index}.json'
 source.write_text(json.dumps({'content':content,'paths':paths,'maxPages':3}))
 completed=subprocess.run([sys.executable,script,'render',str(source)],capture_output=True,text=True)
 if completed.returncode:raise RuntimeError(completed.stderr)
 files=json.loads(completed.stdout)['files'];pages=[]
 for name in files:
  with Image.open(root/name) as im:
   im.load();width,height=im.size
   ratio=None
   if index in (0,4):
    channels=im.convert('RGB').split();mask=None
    for channel,target in zip(channels,(19,87,155)):
     match=channel.point(lambda value:255 if value==target else 0)
     mask=match if mask is None else ImageChops.multiply(mask,match)
    box=mask.getbbox()
    if box:ratio=(box[3]-box[1])/(box[2]-box[0])
   pages.append({'width':width,'height':height,'ratio':ratio,'format':im.format})
 results.append({'pages':pages})
Image.new('1',(5000,5000)).save(root/'too-large.png')
large=subprocess.run([sys.executable,script,'inspect',str(root/'too-large.png'),'24000000'],capture_output=True,text=True)
long=dict(fixture['contents'][1]);long['blocks']=[{'type':'paragraph','text':'bounded paragraph\n'*700}]
source=root/'too-long.json';source.write_text(json.dumps({'content':long,'paths':paths,'maxPages':3}))
limit=subprocess.run([sys.executable,script,'render',str(source)],capture_output=True,text=True)
exif_checks=[]
for orientation in (6,8):
 path=root/f'rotated-{orientation}.jpg';exif=Image.Exif();exif[274]=orientation
 Image.new('RGB',(160,80),'#13579b').save(path,exif=exif)
 inspected=subprocess.run([sys.executable,script,'inspect',str(path),'24000000'],capture_output=True,text=True)
 if inspected.returncode:raise RuntimeError(inspected.stderr)
 post=dict(fixture['contents'][1]);post['blocks']=[{'type':'image','image':{'id':'rotated','assetKey':'rotated'}}]
 source=root/f'exif-{orientation}.json';source.write_text(json.dumps({'content':post,'paths':{'rotated':str(path)},'maxPages':3}))
 rendered=subprocess.run([sys.executable,script,'render',str(source)],capture_output=True,text=True)
 if rendered.returncode:raise RuntimeError(rendered.stderr)
 with Image.open(path) as photo:target=photo.convert('RGB').getpixel((0,0))
 with Image.open(root/json.loads(rendered.stdout)['files'][0]) as card:
  mask=None
  for channel,color in zip(card.convert('RGB').split(),target):
   match=channel.point(lambda value:255 if value==color else 0)
   mask=match if mask is None else ImageChops.multiply(mask,match)
  box=mask.getbbox();ratio=(box[3]-box[1])/(box[2]-box[0]) if box else None
 exif_checks.append({'display':json.loads(inspected.stdout),'ratio':ratio})
print(json.dumps({'results':results,'oversizedRejected':large.returncode!=0,'pageLimitRejected':limit.returncode!=0,'exifChecks':exif_checks,'sharedAuthorHeader':True,'circularAvatarAlpha':True}))
`;

test('isolated plugin image renders synthetic posts, live previews and video cards with bounded dimensions',{skip:!image,timeout:90000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'nekodock-bili-render-e2e-')),fixture=join(root,'fixture'),output=join(root,'output'),name='nekodock-render-test-'+randomUUID();
 await mkdir(fixture);await mkdir(output);await chmod(output,0o777);
 t.after(async()=>{await execute('docker',['rm','-f',name]).catch(()=>{});await rm(root,{recursive:true,force:true});});
 const author={author:'Synthetic author',publishedAt:1700000000,authorAvatar:{id:'avatar',url:'https://i0.hdslb.com/bfs/face/synthetic.png',role:'avatar',assetKey:'avatar',status:'ready'}};
 const base={type:'post',platform:'bilibili',resourceId:'post:100001',url:'https://www.bilibili.com/opus/100001',title:'Synthetic post',...author,retrieval:{status:'ready'}};
 const data={paths:{portrait:'portrait.png',preview:'preview.png',emoji:'emoji.png',avatar:'avatar.png'},contents:[
  {...base,blocks:[{type:'paragraph',text:'Forwarder words，完整保留。'}],original:{...base,resourceId:'post:100002',url:'https://www.bilibili.com/opus/100002',author:'Original author',blocks:[{type:'image',image:{id:'portrait',url:'https://i0.hdslb.com/bfs/new_dyn/synthetic.png',role:'content',assetKey:'portrait',status:'ready'}}]}},
  {...base,title:'Unicode and custom emoji',blocks:[{type:'paragraph',text:'中文标点，👂 👍🏽 👨‍👩‍👧‍👦 🇨🇳 1️⃣\n[Custom emoji]',spans:[{type:'text',text:'中文标点，👂 👍🏽 👨‍👩‍👧‍👦 🇨🇳 1️⃣\n'},{type:'emoji',text:'[Custom emoji]',assetKey:'emoji'}]}]},
  {...base,type:'live',resourceId:'live:100003',url:'https://live.bilibili.com/100003',title:'Synthetic live room',observedAt:1700000100,live:{roomId:'100003',status:'live',area:'Synthetic area',parentArea:'Synthetic category',preview:{id:'preview',url:'https://i0.hdslb.com/bfs/live-key-frame/synthetic.png',role:'live_preview',assetKey:'preview',status:'ready',fetchedAt:1700000101,imageLastModified:'Tue, 14 Nov 2023 22:13:20 GMT'}}},
  {...base,type:'video',resourceId:'BV1xx411c7mD:p2',url:'https://www.bilibili.com/video/BV1xx411c7mD?p=2',title:'视频封面与基本资料 👂',durationSeconds:3723,part:2,description:'简介文字，保持自然换行。',blocks:[{type:'image',image:{id:'video-cover',url:'https://i0.hdslb.com/bfs/archive/synthetic.png',role:'cover',assetKey:'preview',status:'ready'}}]},
  {...base,type:'video',resourceId:'BV1xx411c7mD:p1',url:'https://www.bilibili.com/video/BV1xx411c7mD',title:'长视频标题，包含中文标点和 Unicode 👂。'.repeat(20),author:'Very long author name '.repeat(50),durationSeconds:222,part:1,description:'长简介正文\n'.repeat(1000),blocks:[{type:'image',image:{id:'video-portrait',url:'https://i0.hdslb.com/bfs/archive/portrait.png',role:'cover',assetKey:'portrait',status:'ready'}}]},
 ]};
 await writeFile(join(fixture,'data.json'),JSON.stringify(data),{mode:0o644});
 const {stdout}=await execute('docker',['run','--rm','--name',name,'--network','none','--cpus','1','--memory','384m','--mount',`type=bind,src=${fixture},dst=/fixtures,readonly`,'--mount',`type=bind,src=${output},dst=/output`,'--entrypoint','python3',image!,'-c',bootstrap],{timeout:85000,maxBuffer:1024*1024});
 const value=JSON.parse(stdout) as {results:Array<{pages:Array<{width:number;height:number;ratio:number|null;format:string}>}>;oversizedRejected:boolean;pageLimitRejected:boolean;exifChecks:Array<{display:{width:number;height:number};ratio:number|null}>;sharedAuthorHeader:boolean;circularAvatarAlpha:boolean};
 assert.equal(value.results.length,5);
 for(const result of value.results){assert.ok(result.pages.length>=1&&result.pages.length<=3);for(const page of result.pages){assert.equal(page.width,1080);assert.ok(page.height>200&&page.height<=6000);assert.equal(page.format,'PNG');}}
 assert.ok(Math.abs(value.results[0]!.pages[0]!.ratio!-2)<0.02,'Portrait aspect ratio must be preserved');
 for(const result of value.results.slice(3)){assert.equal(result.pages.length,1);assert.ok(result.pages[0]!.height<2400);}
 assert.ok(Math.abs(value.results[4]!.pages[0]!.ratio!-2)<0.02,'Video portrait cover must retain its complete aspect ratio');
 assert.equal(value.oversizedRejected,true);assert.equal(value.pageLimitRejected,true);
 assert.equal(value.sharedAuthorHeader,true);assert.equal(value.circularAvatarAlpha,true);
 assert.equal(value.exifChecks.length,2);
 for(const check of value.exifChecks){assert.deepEqual(check.display,{width:80,height:160});assert.ok(check.ratio&&Math.abs(check.ratio-2)<0.02);}
});
