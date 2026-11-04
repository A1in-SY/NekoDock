import type { PluginContent, PluginContentBlock, PluginContentImage } from '../../plugin-system/contracts.js';
import { apiJson, id, imageUrl, object, string, timestamp } from './api.js';
import { BilibiliError } from './errors.js';
import { normalizeBilibiliResource } from './recognize.js';
import type { BilibiliResource } from './types.js';

const MAX_BLOCKS = 100, MAX_TEXT = 12000;
type Span = NonNullable<Extract<PluginContentBlock, {type:'paragraph'}>['spans']>[number];

export function contentImage(value: unknown, imageId: string, role: PluginContentImage['role'] = 'content'): PluginContentImage | undefined {
  const v = object(value), url = imageUrl(v.src ?? v.url ?? value); if (!url) return;
  const width = Number(v.width), height = Number(v.height);
  return { id: imageId, url, role, status: 'pending',
    ...(Number.isSafeInteger(width) && width > 0 ? { width } : {}), ...(Number.isSafeInteger(height) && height > 0 ? { height } : {}) };
}

function richSpans(nodes: unknown): Span[] {
  if (!Array.isArray(nodes)) return [];
  return nodes.slice(0, 500).flatMap(value => {
    const n = object(value), emoji = object(n.emoji), text = string(n.text || n.orig_text || emoji.text);
    if (!text) return [];
    const url = imageUrl(emoji.icon_url);
    return [{ type: url && n.type === 'RICH_TEXT_NODE_TYPE_EMOJI' ? 'emoji' as const : 'text' as const, text, ...(url ? { url } : {}) }];
  });
}

function paragraph(text: unknown, nodes?: unknown): Extract<PluginContentBlock, {type:'paragraph'}> | undefined {
  const spans = richSpans(nodes), full = spans.length ? spans.map(item => item.text).join('') : string(text);
  if (!full) return;
  let remaining = MAX_TEXT;
  const bounded = spans.flatMap(span => { const part = span.text.slice(0, remaining); remaining -= part.length; return part ? [{...span, text:part}] : []; });
  return { type: 'paragraph', text: full.slice(0, MAX_TEXT), ...(bounded.length ? { spans: bounded } : {}) };
}

function author(content: PluginContent, a: Record<string, any>): void {
  content.author = string(a.name, 500) || undefined;
  content.authorId = id(a.mid) || undefined;
  content.publishedAt = timestamp(a.pub_ts);
  const avatar = contentImage(a.face, `${content.resourceId}:avatar`, 'avatar');
  if (avatar) content.authorAvatar = avatar;
  // A human-readable edited label does not establish an exact edit timestamp.
  const editedAt = timestamp(a.edit_ts); if (editedAt) content.editedAt = editedAt;
}

function base(dynamicId: string, observedAt: number): PluginContent {
  return { type:'post', platform:'bilibili', resourceId:`post:${dynamicId}`, url:`https://www.bilibili.com/opus/${dynamicId}`,
    title:'哔哩哔哩动态', observedAt, blocks:[], retrieval:{status:'ready'} };
}

function partial(content:PluginContent,error='BILIBILI_CONTENT_TRUNCATED'):void {
  if(content.retrieval.status==='ready')content.retrieval={status:'partial',error};
}
function boundContent(content:PluginContent):void {
  let remaining=MAX_TEXT,imageCount=0;
  const bounded:PluginContentBlock[]=[];
  for(const block of content.blocks??[]) {
    if(bounded.length>=MAX_BLOCKS){partial(content);break;}
    if(block.type==='paragraph') {
      const text=block.text.slice(0,remaining);remaining-=text.length;
      if(text.length<block.text.length)partial(content);
      if(!text)continue;
      let spanRemaining=text.length;
      const spans=block.spans?.flatMap(span=>{const part=span.text.slice(0,spanRemaining);spanRemaining-=part.length;return part?[{...span,text:part}]:[];});
      bounded.push({...block,text,...(spans?{spans}:{})});
    }else if(block.type==='image') {
      if(imageCount++>=20){partial(content);continue;}bounded.push(block);
    }else bounded.push(block);
  }
  content.blocks=bounded;
  content.description=bounded.filter(b=>b.type==='paragraph').map(b=>b.text).join('\n').slice(0,MAX_TEXT);
}

export function parseDynamicItem(value: unknown, dynamicId: string, observedAt = Date.now()/1000, depth = 0): PluginContent {
  const item = object(value); if (!Object.keys(item).length || item.visible === false || item.type === 'DYNAMIC_TYPE_NONE') throw new BilibiliError('BILIBILI_NOT_FOUND');
  const content = base(id(item.id_str) || dynamicId, observedAt), modules = object(item.modules), dyn = object(modules.module_dynamic);
  author(content, object(modules.module_author));
  const blocks = content.blocks!, desc = object(dyn.desc), major = object(dyn.major);
  const p = paragraph(desc.text, desc.rich_text_nodes); if (p) blocks.push(p);
  if(typeof desc.text==='string'&&desc.text.length>MAX_TEXT||Array.isArray(desc.rich_text_nodes)&&(desc.rich_text_nodes.length>500||desc.rich_text_nodes.reduce((n:number,v:unknown)=>n+string(object(v).text||object(v).orig_text,MAX_TEXT+1).length,0)>MAX_TEXT))partial(content);
  const opus = object(major.opus);
  if (opus.title) content.title = string(opus.title, 500);
  if (!p) { const summary = object(opus.summary); const text = paragraph(summary.text, summary.rich_text_nodes); if (text) blocks.push(text); }
  const topic = string(object(dyn.topic).name || object(modules.module_topic).name, 200);
  if (topic && !blocks.some(b => b.type === 'paragraph' && b.text.includes(topic))) blocks.unshift({type:'paragraph', text:`#${topic}#`});
  const pictures = Array.isArray(object(major.draw).items) ? object(major.draw).items : Array.isArray(opus.pics) ? opus.pics : [];
  pictures.slice(0, 20).forEach((picture: unknown, index: number) => { const image = contentImage(picture, `${content.resourceId}:image:${index}`); if (image) blocks.push({type:'image', image}); });
  const archive = object(major.archive), video = normalizeBilibiliResource(string(archive.jump_url) || (string(archive.bvid) ? `https://www.bilibili.com/video/${archive.bvid}` : ''));
  if (video?.kind === 'video') blocks.push({type:'resource', resource:video, title:string(archive.title,500)});
  const article = object(major.article); if (article.title && !blocks.length) blocks.push({type:'paragraph',text:string(article.title,500)});
  if (item.orig && depth === 0) {
    try { content.original = parseDynamicItem(item.orig, id(object(item.orig).id_str) || dynamicId, observedAt, 1); }
    catch { content.retrieval = {status:'partial',error:'BILIBILI_ORIGINAL_UNAVAILABLE'}; }
  }
  else if(item.orig)partial(content,'BILIBILI_ORIGINAL_DEPTH_LIMIT');
  if(major.type&&!['MAJOR_TYPE_DRAW','MAJOR_TYPE_OPUS','MAJOR_TYPE_ARCHIVE','MAJOR_TYPE_ARTICLE'].includes(major.type))partial(content,'BILIBILI_CONTENT_UNSUPPORTED');
  if(major.type==='MAJOR_TYPE_ARTICLE')partial(content,'BILIBILI_FULL_TEXT_UNAVAILABLE');
  if(content.original?.retrieval.status==='partial')partial(content,'BILIBILI_ORIGINAL_PARTIAL');
  boundContent(content);
  if (content.title === '哔哩哔哩动态' && content.author) content.title = `${content.author}的动态`;
  if (pictures.length > 20) content.retrieval = {status:'partial',error:'BILIBILI_CONTENT_TRUNCATED'};
  return content;
}

export function parseOpusItem(value: unknown, dynamicId: string, observedAt = Date.now()/1000): PluginContent {
  const item = object(value); if (!Array.isArray(item.modules)) throw new BilibiliError('BILIBILI_RESPONSE_INVALID');
  const content = base(id(item.id_str) || dynamicId, observedAt), blocks = content.blocks!;
  if(item.modules.length>100)partial(content);
  for (const raw of item.modules.slice(0, 100)) {
    const m = object(raw);
    if (m.module_author) author(content, object(m.module_author));
    if (object(m.module_title).text) content.title = string(m.module_title.text,500);
    const paragraphs = object(m.module_content).paragraphs;
    if (!Array.isArray(paragraphs)) continue;
    if(paragraphs.length>MAX_BLOCKS)partial(content);
    for (const rawParagraph of paragraphs.slice(0, MAX_BLOCKS)) {
      const p = object(rawParagraph), nodes = object(p.text ?? p.heading).nodes;
      if (Array.isArray(nodes)) {
        if(nodes.length>500)partial(content);
        const spans: Span[] = nodes.slice(0,500).flatMap(raw => {
          const node = object(raw);
          if(typeof object(node.word).words==='string'&&object(node.word).words.length>MAX_TEXT||typeof object(node.rich).text==='string'&&object(node.rich).text.length>MAX_TEXT)partial(content);
          if (node.word) return [{type:'text' as const,text:string(object(node.word).words)}];
          if (node.rich) return richSpans([node.rich]);
          if (node.formula) return [{type:'text' as const,text:string(object(node.formula).latex || object(node.formula).text)}];
          if (node.user) return [{type:'text' as const,text:'@'+string(object(node.user).name)}];
          partial(content,'BILIBILI_CONTENT_UNSUPPORTED');return [];
        });
        const fullText=spans.map(s=>s.text).join('');if(fullText.length>MAX_TEXT)partial(content);
        const text = fullText.slice(0,MAX_TEXT);
        if (text) blocks.push({type:'paragraph',text,spans});
      }
      const pics = object(p.pic).pics;
      if(Array.isArray(pics)&&pics.length>20)partial(content);
      if (Array.isArray(pics)) for (const pic of pics.slice(0,20)) {
        const image = contentImage(pic, `${content.resourceId}:image:${blocks.length}`); if (image) blocks.push({type:'image',image});
      }
      if(!Array.isArray(nodes)&&!Array.isArray(pics)&&p.para_type!==3)partial(content,'BILIBILI_CONTENT_UNSUPPORTED');
    }
  }
  boundContent(content);
  if (content.title === '哔哩哔哩动态' && content.author) content.title = `${content.author}的动态`;
  return content;
}

export async function resolveDynamic(resource:BilibiliResource,fetcher:typeof globalThis.fetch,signal:AbortSignal,cookie?:string):Promise<PluginContent> {
  const dynamicId = resource.id.replace(/^post:/u,''); if (!/^\d{1,30}$/u.test(dynamicId)) throw new BilibiliError('BILIBILI_INVALID_URL');
  const observedAt = Date.now()/1000;
  const data = await apiJson(`https://api.bilibili.com/x/polymer/web-dynamic/v1/detail?id=${dynamicId}`,fetcher,signal,cookie);
  const content = parseDynamicItem(data.item,dynamicId,observedAt), item = object(data.item);
  const major = object(object(object(item.modules).module_dynamic).major);
  if(item.type==='DYNAMIC_TYPE_FORWARD'&&content.original) {
    const original=object(item.orig),originalId=id(original.id_str),originalMajor=object(object(object(original.modules).module_dynamic).major);
    if(originalId&&(originalMajor.type==='MAJOR_TYPE_OPUS'||!originalMajor.type||object(originalMajor.opus).fold_action)) {
      try { content.original=parseOpusItem((await apiJson(`https://api.bilibili.com/x/polymer/web-dynamic/v1/opus/detail?id=${originalId}`,fetcher,signal,cookie)).item,originalId,observedAt); }
      catch { signal.throwIfAborted();partial(content.original,'BILIBILI_FULL_TEXT_UNAVAILABLE');partial(content,'BILIBILI_ORIGINAL_PARTIAL'); }
    }
  }
  if (item.type !== 'DYNAMIC_TYPE_FORWARD' && (major.type === 'MAJOR_TYPE_OPUS' || !major.type || object(major.opus).fold_action || !content.blocks?.length)) {
    try { return parseOpusItem((await apiJson(`https://api.bilibili.com/x/polymer/web-dynamic/v1/opus/detail?id=${dynamicId}`,fetcher,signal,cookie)).item,dynamicId,observedAt); }
    catch { signal.throwIfAborted(); content.retrieval={status:'partial',error:'BILIBILI_FULL_TEXT_UNAVAILABLE'}; }
  }
  return content;
}
