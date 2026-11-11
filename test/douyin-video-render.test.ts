import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const pillow = spawnSync('python3', ['-c', 'import PIL'], { stdio: 'ignore' }).status === 0;
const image = process.env.PLUGIN_RUNNER_E2E_IMAGE;
const execute = promisify(execFile);
const checks = String.raw`
import importlib.util,json,pathlib,subprocess,sys
from PIL import Image,ImageDraw,ImageChops
root=pathlib.Path(sys.argv[1]);script=pathlib.Path(sys.argv[2])
spec=importlib.util.spec_from_file_location('douyin_renderer',script)
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
bili_script=script.parents[2]/'bilibili'/'render'/'card.py'
spec=importlib.util.spec_from_file_location('bilibili_renderer',bili_script)
bili=importlib.util.module_from_spec(spec);spec.loader.exec_module(bili)
cover=root/'cover.png';Image.new('RGB',(400,800),'#13579b').save(cover)
avatar=root/'avatar.png';photo=Image.new('RGBA',(76,76),'#e66b91');ImageDraw.Draw(photo).ellipse((29,29,47,47),fill=(0,0,0,0));photo.save(avatar)
base={'type':'video','platform':'douyin','resourceId':'video:100001','url':'https://www.douyin.com/video/100001',
 'title':'发布文案 👂 👍🏽 👨‍👩‍👧‍👦 🇨🇳','description':'发布文案 👂 👍🏽 👨‍👩‍👧‍👦 🇨🇳',
 'author':'Synthetic 作者','publishedAt':1700000000,'durationSeconds':42.1,'part':2,
 'authorAvatar':{'role':'avatar','assetKey':'avatar'},
 'blocks':[{'type':'image','image':{'role':'cover','assetKey':'cover'}}],'retrieval':{'status':'ready'}}
paths={'cover':str(cover),'avatar':str(avatar)}
request={'content':base,'paths':paths,'maxPages':3}
renderer=module.Renderer(request,root);pages=renderer.plan();items=pages[0]
assert len(pages)==1 and renderer.max_pages==1
caption=''.join(t.get('value','') for i in items if i['kind']=='line' and i['size']==34 for t in i['tokens'])
assert caption==base['description'],'Caption must appear once even when title equals description'
assert not any(i['kind']=='line' and i['size'] in (30,40) for i in items)
picture=next(i for i in items if i['kind']=='image');assert picture['width']==440 and picture['height']-20==880
metadata=''.join(t.get('value','') for i in items if i['kind']=='line' and i['size']==25 for t in i['tokens'])
assert metadata=='时长 00:43','Douyin has no Bilibili part label'
long={**base,'title':'A shortened title','description':'这是完整发布文案，保留 Unicode 👍🏽 和换行。\n'*1000,'author':'非常长的作者🐻\n'*60}
long_renderer=module.Renderer({**request,'content':long},root);long_items=long_renderer.plan()[0]
lines=[i for i in long_items if i['kind']=='line' and i['size']==34]
assert len(lines)==8 and lines[-1]['tokens'][-1]['value']=='…'
for line in lines:assert sum(t['width'] for t in line['tokens'])<=976
assert 'A shortened title' not in ''.join(t.get('value','') for i in lines for t in i['tokens'])
# Plain author headers share the exact typography, coordinates and alpha handling.
author_rows=[]
for model in (module,bili):
 canvas=Image.new('RGB',(1080,235),'white');model.Renderer(request,root).draw_author(canvas)
 assert canvas.getpixel((52,116))==(255,255,255)
 assert canvas.getpixel((90,154))==(255,255,255)
 assert canvas.getpixel((90,120))==(230,107,145)
 author_rows.append(canvas.tobytes())
assert author_rows[0]==author_rows[1]
# Emoji names are bounded and use a color glyph when the installed font supports it.
canvas=Image.new('RGB',(1080,235),'white');module.Renderer({**request,'content':long},root).draw_author(canvas)
name=canvas.crop((147,100,1080,162));box=ImageChops.difference(name,Image.new('RGB',name.size,'white')).getbbox()
assert box and box[2]<=881
if module.shared.emoji_picture('🐻',34):
 emoji_canvas=Image.new('RGB',(1080,235),'white')
 module.Renderer({**request,'content':{**base,'author':'🐻'}},root).draw_author(emoji_canvas)
 colors=emoji_canvas.crop((147,116,190,162)).getdata()
 assert any(max(rgb)-min(rgb)>40 for rgb in colors),'Author emoji must be colored rather than a missing glyph'
# Missing optional fields still produce one text card with no false image or duration.
minimal={**base,'title':'Only a caption','description':'','author':'','blocks':[]}
for key in ('authorAvatar','publishedAt','durationSeconds'):minimal.pop(key,None)
minimal_request={'content':minimal,'paths':{},'maxPages':3}
minimal_items=module.Renderer(minimal_request,root).plan()[0]
assert not any(i['kind']=='image' or i['kind']=='line' and i['size']==25 for i in minimal_items)
fallback=Image.new('RGB',(1080,235),'white');module.Renderer(minimal_request,root).draw_author(fallback)
expected=Image.new('RGB',(1080,235),'white');module.shared.label(expected,'抖音',52,116,32,module.shared.INK,True,max_width=976)
assert fallback.tobytes()==expected.tobytes()
# The production CLI writes a single PNG within the request's directory.
source=root/'render.json';source.write_text(json.dumps(request))
completed=subprocess.run([sys.executable,str(script),'render',str(source)],capture_output=True,text=True)
assert completed.returncode==0,completed.stderr
files=json.loads(completed.stdout)['files'];assert files==['card-0.png']
with Image.open(root/files[0]) as card:
 assert card.format=='PNG' and card.width==1080 and card.height<2100
 assert card.getpixel((0,0))==(41,43,53) and card.getpixel((940,0))==(37,212,223) and card.getpixel((1040,0))==(254,44,85)
 dimensions=card.size
 # The whole portrait remains visible; both top and bottom corners of its color area exist.
 rgb=card.convert('RGB');mask=None
 for channel,target in zip(rgb.split(),(19,87,155)):
  match=channel.point(lambda value:255 if value==target else 0)
  mask=match if mask is None else ImageChops.multiply(mask,match)
 box=mask.getbbox();assert box and abs((box[3]-box[1])/(box[2]-box[0])-2)<0.02
# Asset traversal and links outside the job directory are rejected before decoding.
for key,path in [('outside',root.parent/'outside.png'),('symlink',root/'linked.png')]:
 if key=='symlink':path.symlink_to(cover)
 bad={**request,'paths':{**paths,'cover':str(path)}}
 try:module.Renderer(bad,root).plan();raise AssertionError('An unsafe local path was accepted')
 except ValueError as error:assert str(error)=='DOUYIN_IMAGE_PATH_REJECTED'
# CLI identity, byte, image-format and pixel checks remain effective.
for invalid in ({**base,'platform':'other'},{**base,'type':'post'}):
 try:module.Renderer({**request,'content':invalid},root).plan();raise AssertionError('Wrong content identity was accepted')
 except ValueError as error:assert str(error)=='DOUYIN_RENDER_INVALID'
large=root/'oversized.png';Image.new('1',(5000,5000)).save(large)
failed=subprocess.run([sys.executable,str(script),'inspect',str(large),'24000000'],capture_output=True,text=True)
assert failed.returncode!=0
bad=root/'bad.img';bad.write_bytes(b'not an image')
failed=subprocess.run([sys.executable,str(script),'inspect',str(bad),'24000000'],capture_output=True,text=True)
assert failed.returncode!=0
exif=root/'rotated.jpg';orientation=Image.Exif();orientation[274]=6
Image.new('RGB',(160,80),'#13579b').save(exif,exif=orientation)
completed=subprocess.run([sys.executable,str(script),'inspect',str(exif),'24000000'],capture_output=True,text=True)
assert completed.returncode==0 and json.loads(completed.stdout)=={'width':80,'height':160}
print(json.dumps({'singleCaption':True,'boundedLines':8,'coverHeight':880,'sharedAuthorHeader':True,'unsafePathsRejected':True,'files':files,'dimensions':dimensions}))
`;

function verify(stdout: string) {
  const result = JSON.parse(stdout);
  assert.equal(result.singleCaption, true);
  assert.equal(result.boundedLines, 8);
  assert.equal(result.coverHeight, 880);
  assert.equal(result.sharedAuthorHeader, true);
  assert.equal(result.unsafePathsRejected, true);
  assert.deepEqual(result.files, ['card-0.png']);
  assert.equal(result.dimensions[0], 1080);
  assert.ok(result.dimensions[1] < 2100);
}

test('Douyin Pillow cards keep one bounded caption, the full cover and the shared author header', { skip: !pillow }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'nekodock-douyin-render-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = spawnSync('python3', ['-c', checks, root, 'src/plugins/douyin/render/card.py'], {
    encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  verify(result.stdout);
});

test('isolated plugin image renders Douyin cards with shared fonts, alpha, EXIF and asset limits', {
  skip: !image, timeout: 60_000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'nekodock-douyin-render-image-'));
  const name = 'nekodock-douyin-render-test-' + randomUUID();
  await chmod(root, 0o777);
  t.after(async () => { await execute('docker', ['rm', '-f', name]).catch(() => {}); await rm(root, { recursive: true, force: true }); });
  const { stdout } = await execute('docker', ['run', '--rm', '--name', name, '--network', 'none', '--cpus', '1', '--memory', '384m',
    '--pids-limit', '128', '--mount', `type=bind,src=${root},dst=/output`, '--entrypoint', 'python3', image!,
    '-c', checks, '/output', '/app/dist/src/plugins/douyin/render/card.py'], { timeout: 55_000, maxBuffer: 1024 * 1024 });
  verify(stdout);
});
