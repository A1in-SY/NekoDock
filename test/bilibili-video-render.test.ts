import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { BILIBILI_DEFAULTS } from '../src/plugins/bilibili/config.js';
import { normalizeBilibiliResource } from '../src/plugins/bilibili/recognize.js';
import { preparePresentation, type BilibiliRun } from '../src/plugins/bilibili/presentation.js';
import { pluginSourceImageIds } from '../src/plugin-images.js';
import type { PluginContent, PluginRunnerJob } from '../src/plugin-system/contracts.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1sAAAAASUVORK5CYII=', 'base64');
const resource = normalizeBilibiliResource('https://www.bilibili.com/video/BV1xx411c7mD?p=2')!;
const signal = () => new AbortController().signal;
const content = (): PluginContent => ({ type: 'video', platform: 'bilibili', resourceId: resource.id, url: resource.url,
  title: 'Synthetic video', author: 'Synthetic author', publishedAt: 1700000000, durationSeconds: 3723, part: 2,
  description: 'Synthetic description.', blocks: [{ type: 'image', image: { id: `${resource.id}:cover`,
    url: 'https://i0.hdslb.com/bfs/archive/synthetic.png', role: 'cover', status: 'pending' } }], retrieval: { status: 'ready' } });
const job = (): PluginRunnerJob & { config: typeof BILIBILI_DEFAULTS; resource: typeof resource } => ({ id: 'synthetic-video-job',
  lease: 'synthetic-lease', botId: 'synthetic-bot', pluginId: 'bilibili', operation: 'prepare', resource,
  config: { ...BILIBILI_DEFAULTS }, networkProxy: { enabled: false, url: '', noProxy: '', forTools: true }, expiresAt: Date.now() + 60000,
  content: content(), presentation: { mode: 'card', provideContext: true } });
async function directory(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'nekodock-bili-video-render-'));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}

test('video preparation obtains a bounded cover and emits only a presentation card', async t => {
  const root = await directory(t); let fetches = 0;
  const execute: BilibiliRun = async (_command, args) => {
    if (args[1] === 'inspect') return '{"width":1,"height":1}';
    const request = JSON.parse(await readFile(args[2]!, 'utf8'));
    assert.equal(request.maxPages, 1); assert.equal(request.content.type, 'video');
    assert.equal(request.content.blocks[0].image.status, 'ready');
    await writeFile(join(root, 'card-0.png'), png); return '{"files":["card-0.png"]}';
  };
  const value = await preparePresentation(job(), root, async (input, options) => {
    fetches++; assert.equal(String(input), 'https://i0.hdslb.com/bfs/archive/synthetic.png');
    assert.equal(options?.redirect, 'error'); assert.equal(new Headers(options?.headers).get('cookie'), null);
    return new Response(png);
  }, execute, {}, signal());
  assert.equal(fetches, 1); assert.deepEqual(value.files?.map(file => file.role), ['cover', 'presentation']);
  assert.deepEqual(value.outputs, [{ kind: 'image', assetKey: 'card-0', assetRole: 'presentation' }]);
  const image = value.content?.blocks?.[0]; assert.ok(image?.type === 'image');
  assert.equal(image.image.status, 'ready'); assert.equal(image.image.assetKey, 'source-0');
  assert.deepEqual(pluginSourceImageIds([value.content]), []);
});

test('a missing video cover still renders the retrieved text as a card', async t => {
  const root = await directory(t);
  const value = await preparePresentation(job(), root, async () => new Response(null, { status: 404 }), async (_command, args) => {
    assert.equal(args[1], 'render');
    const request = JSON.parse(await readFile(args[2]!, 'utf8'));
    assert.deepEqual(request.paths, {}); assert.equal(request.content.blocks[0].image.status, 'failed');
    await writeFile(join(root, 'card-0.png'), png); return '{"files":["card-0.png"]}';
  }, {}, signal());
  assert.equal(value.content?.retrieval.status, 'partial');
  assert.deepEqual(value.outputs, [{ kind: 'image', assetKey: 'card-0', assetRole: 'presentation' }]);
});

test('video rendering failure produces bounded text without a separate cover message', async t => {
  const root = await directory(t), j = job(); j.content!.description = '长简介'.repeat(4000);
  const value = await preparePresentation(j, root, async () => new Response(png), async (_command, args) => {
    if (args[1] === 'inspect') return '{"width":1,"height":1}'; throw new Error('renderer unavailable');
  }, {}, signal());
  assert.equal(value.content?.retrieval.error, 'BILIBILI_PRESENTATION_FALLBACK');
  assert.equal(value.outputs?.length, 1); assert.equal(value.outputs?.[0]?.kind, 'reply');
  assert.match(value.outputs?.[0]?.text ?? '', /Synthetic video/u);
  assert.match(value.outputs?.[0]?.text ?? '', /…/u);
  assert.ok((value.outputs?.[0]?.text?.length ?? 0) < 1000);
});

const pillow = spawnSync('python3', ['-c', 'import PIL'], { stdio: 'ignore' }).status === 0;
test('video cards bound title and description, retain portrait ratio, and omit missing fields', { skip: !pillow }, async t => {
  const root = await directory(t);
  const result = spawnSync('python3', ['-c', String.raw`
import importlib.util,json,pathlib,sys
from PIL import Image
root=pathlib.Path(sys.argv[1]);spec=importlib.util.spec_from_file_location('renderer',sys.argv[2])
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
cover=root/'portrait.png';Image.new('RGB',(400,800),'#13579b').save(cover)
content={'type':'video','platform':'bilibili','resourceId':'BV1xx411c7mD:p2','url':'https://www.bilibili.com/video/BV1xx411c7mD?p=2',
 'title':'这是一个包含中文和 Unicode 👂 的长视频标题。'*30,'author':'非常长的作者名称\n'*100,'publishedAt':1700000000,
 'part':2,'durationSeconds':3723,'description':'简介正文，中文标点和换行都应完整排版。\n'*300,
 'blocks':[{'type':'image','image':{'assetKey':'cover','role':'cover'}}],'retrieval':{'status':'ready'}}
r=module.Renderer({'content':content,'paths':{'cover':str(cover)},'maxPages':1},root)
pages=r.plan();assert len(pages)==1
assert len([i for i in pages[0] if i['kind']=='line' and i['size']==40])==4
assert len([i for i in pages[0] if i['kind']=='line' and i['size']==30])==6
for size in (40,30):
 last=[i for i in pages[0] if i['kind']=='line' and i['size']==size][-1]
 assert last['tokens'][-1]['value']=='…'
for i in pages[0]:
 if i['kind']=='line':assert sum(t['width'] for t in i['tokens'])<=976
picture=next(i for i in pages[0] if i['kind']=='image')
assert picture['height']-20==720 and picture['width']==360
metadata=''.join(t.get('value','') for i in pages[0] if i['kind']=='line' and i['size']==25 for t in i['tokens'])
assert metadata=='时长 01:02:03 · P2'
assert module.stamp(1700000000)=='2023-11-15 06:13 UTC+8'
# Build a fresh renderer: render() computes the plan once itself.
r=module.Renderer({'content':content,'paths':{'cover':str(cover)},'maxPages':1},root)
files=r.render()
with Image.open(root/files[0]) as image:dimensions=image.size
minimal=dict(content);minimal.update(title='Only a title',description='',blocks=[],author='',part=1);minimal.pop('durationSeconds');minimal.pop('publishedAt')
m=module.Renderer({'content':minimal,'paths':{},'maxPages':1},root)
minimal_pages=m.plan()
assert len(minimal_pages)==1 and not any(i['kind']=='image' for i in minimal_pages[0])
assert not any(i['kind']=='line' and i['size']==25 for i in minimal_pages[0])
print(json.dumps({'files':files,'dimensions':dimensions,'ratio':(picture['height']-20)/picture['width']}))
`, root, 'src/plugins/bilibili/render/card.py'], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout); assert.deepEqual(value.files, ['card-0.png']);
  assert.equal(value.dimensions[0], 1080); assert.ok(value.dimensions[1] < 2400); assert.equal(value.ratio, 2);
});

test('video, post and live cards share bounded author headers and preserve circular avatar transparency', { skip: !pillow }, async t => {
  const root = await directory(t);
  const result = spawnSync('python3', ['-c', String.raw`
import importlib.util,json,pathlib,sys
from PIL import Image,ImageDraw,ImageChops
root=pathlib.Path(sys.argv[1]);spec=importlib.util.spec_from_file_location('renderer',sys.argv[2])
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
avatar=Image.new('RGBA',(76,76),'#e66b91');ImageDraw.Draw(avatar).ellipse((29,29,47,47),fill=(0,0,0,0))
avatar.save(root/'avatar.png')
headers=[];calls=[];original=module.label
def label(*args,**kwargs):
 calls.append((args[1],args[2],args[3],kwargs.get('max_width')))
 return original(*args,**kwargs)
module.shared.label=label
for kind in ('video','post','live'):
 content={'type':kind,'author':'Long author name\n'*80,'publishedAt':1700000000,
  'authorAvatar':{'assetKey':'avatar'},'live':{'roomId':'10001'}}
 renderer=module.Renderer({'content':content,'paths':{'avatar':str(root/'avatar.png')}},root)
 canvas=Image.new('RGB',(1080,235),'white');renderer.draw_author(canvas)
 assert canvas.getpixel((52,116))==(255,255,255),'Avatar corners must be clipped to a circle'
 assert canvas.getpixel((90,154))==(255,255,255),'Transparent avatar pixels must preserve the background'
 assert canvas.getpixel((90,120))==(230,107,145),'Opaque avatar pixels must retain their color'
 name=canvas.crop((147,100,1080,162))
 box=ImageChops.difference(name,Image.new('RGB',name.size,'white')).getbbox()
 assert box and box[2]<=881,'The author name must fit the shared header width'
 headers.append(name.tobytes())
 name_call,sub_call=calls[-2:]
 assert name_call==('Long author name '*79+'Long author name',147,116,881)
 assert sub_call[1:]==(147,162,881)
 assert sub_call[0]==('直播间 10001' if kind=='live' else '2023-11-15 06:13 UTC+8')
assert headers[0]==headers[1]==headers[2],'The author row must use identical placement and typography across content types'
for kind in ('video','post','live'):
 renderer=module.Renderer({'content':{'type':kind,'author':'  \n ','live':{'roomId':'10001'}}},root)
 renderer.draw_author(Image.new('RGB',(1080,235),'white'))
 assert calls[-2]==('哔哩哔哩',52,116,976),'Missing avatars and names must share the same fallback layout'
print(json.dumps({'types':3,'circularAlpha':True,'sharedAuthorRow':True}))
`, root, 'src/plugins/bilibili/render/card.py'], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { types: 3, circularAlpha: true, sharedAuthorRow: true });
});
