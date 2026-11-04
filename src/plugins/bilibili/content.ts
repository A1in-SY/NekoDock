import type { PluginContent, PluginContentBlock, PluginContentImage } from '../../plugin-system/contracts.js';
import type { BilibiliResource } from './types.js';
import { imageUrl, object, string, timestamp } from './api.js';
import { normalizeBilibiliResource } from './recognize.js';

function image(value:unknown):PluginContentImage|undefined {
  const v=object(value),url=imageUrl(v.url);if(!url||typeof v.id!=='string'||!v.id||v.id.length>400)return;
  if(!['content','live_preview','cover','avatar','emoji'].includes(v.role))return;
  const result:PluginContentImage={id:v.id,url,role:v.role};
  for(const key of ['width','height'] as const)if(Number.isSafeInteger(v[key])&&v[key]>0&&v[key]<=100000)result[key]=v[key];
  for(const key of ['assetKey','assetId'] as const)if(typeof v[key]==='string'&&/^[A-Za-z0-9_.:-]{1,200}$/u.test(v[key]))result[key]=v[key];
  if(['ready','failed','pending'].includes(v.status))result.status=v.status;
  if(typeof v.error==='string'&&/^[A-Z][A-Z0-9_]{0,100}$/u.test(v.error))result.error=v.error;
  if(timestamp(v.fetchedAt))result.fetchedAt=timestamp(v.fetchedAt);
  if(typeof v.imageLastModified==='string'&&v.imageLastModified.length<100&&Number.isFinite(Date.parse(v.imageLastModified)))result.imageLastModified=v.imageLastModified;
  return result;
}
function blocks(value:unknown):PluginContentBlock[] {
  if(!Array.isArray(value))return [];
  let remaining=12000;const result:PluginContentBlock[]=[];
  for(const raw of value.slice(0,100)) {
    const v=object(raw);
    if(v.type==='paragraph') {
      const text=string(v.text,remaining);remaining-=text.length;if(!text)continue;
      const spans=Array.isArray(v.spans)?v.spans.slice(0,500).flatMap((raw:unknown)=>{
        const s=object(raw);if(!['text','emoji'].includes(s.type)||typeof s.text!=='string')return [];
        const span:{type:'text'|'emoji';text:string;url?:string;assetId?:string;assetKey?:string}={type:s.type,text:s.text.slice(0,12000)};
        const url=imageUrl(s.url);if(url)span.url=url;
        for(const k of ['assetId','assetKey'] as const)if(typeof s[k]==='string'&&/^[A-Za-z0-9_.:-]{1,200}$/u.test(s[k]))span[k]=s[k];
        return [span];
      }):[];
      if(spans.map((s:{text:string})=>s.text).join('')!==text)result.push({type:'paragraph',text});
      else result.push({type:'paragraph',text,...(spans.length?{spans}:{})});
    }else if(v.type==='image') {const i=image(v.image);if(i)result.push({type:'image',image:i});}
    else if(v.type==='resource') {const r=normalizeBilibiliResource(string(object(v.resource).url));if(r&&r.kind!=='short')result.push({type:'resource',resource:r,...(typeof v.title==='string'?{title:v.title.slice(0,500)}:{})});}
  }
  return result;
}
export function validatePluginContent(value:unknown,resource:BilibiliResource,depth=0):PluginContent {
  const v=object(value),canonical=normalizeBilibiliResource(string(v.url));
  if(!['video','post','live'].includes(v.type)||v.platform!=='bilibili'||!canonical||canonical.kind!==v.type||canonical.id!==v.resourceId||typeof v.title!=='string')throw new Error('插件资料无效');
  const content:PluginContent={type:v.type,platform:'bilibili',resourceId:canonical.id,url:canonical.url,title:v.title.slice(0,500),retrieval:{status:'ready'},...(v.type==='video'?{part:canonical.part??resource.part??1}:{})};
  for(const key of ['author','description','coverUrl','authorId'] as const)if(typeof v[key]==='string')content[key]=v[key].slice(0,key==='description'?12000:2048);
  for(const key of ['durationSeconds','publishedAt','observedAt','editedAt'] as const)if(typeof v[key]==='number'&&Number.isFinite(v[key])&&v[key]>=0)content[key]=v[key];
  const retrieval=object(v.retrieval);if(['ready','partial','failed'].includes(retrieval.status))content.retrieval={status:retrieval.status,...(typeof retrieval.error==='string'&&/^[A-Z][A-Z0-9_]{0,100}$/u.test(retrieval.error)?{error:retrieval.error}:{})};
  const avatar=image(v.authorAvatar);if(avatar?.role==='avatar')content.authorAvatar=avatar;
  if(v.type==='post') {
    content.blocks=blocks(v.blocks);
    if(v.original&&depth===0)content.original=validatePluginContent(v.original,resource,1);
  }
  if(v.type==='live'&&v.live!==undefined) {
    const live=object(v.live);if(typeof live.roomId!=='string'||!/^\d{1,20}$/u.test(live.roomId)||canonical.id!==`live:${live.roomId}`||!['live','offline','replay'].includes(live.status))throw new Error('插件直播资料无效');
    content.live={roomId:live.roomId,status:live.status};
    for(const key of ['shortId','area','parentArea'] as const)if(typeof live[key]==='string')content.live[key]=live[key].slice(0,200);
    if(timestamp(live.startedAt))content.live.startedAt=timestamp(live.startedAt);
    const preview=image(live.preview),cover=image(live.cover);
    if(preview?.role==='live_preview'&&live.status==='live')content.live.preview=preview;
    if(cover?.role==='cover')content.live.cover=cover;
  }
  const subtitle=object(v.subtitle);if(v.type==='video'&&['ready','absent','login_required','failed'].includes(String(subtitle.status))) {
    const segments=Array.isArray(subtitle.segments)?subtitle.segments.slice(0,1000).flatMap((value:unknown)=>{const s=object(value);return typeof s.start==='number'&&typeof s.end==='number'&&Number.isFinite(s.start)&&Number.isFinite(s.end)&&s.start>=0&&s.end>=s.start&&typeof s.text==='string'?[{start:s.start,end:s.end,text:s.text.slice(0,2000)}]:[];}):[];
    content.subtitle={status:subtitle.status,...(typeof subtitle.text==='string'?{text:subtitle.text.slice(0,12000)}:{}),...(typeof subtitle.language==='string'?{language:subtitle.language.slice(0,30)}:{}),...(typeof subtitle.automatic==='boolean'?{automatic:subtitle.automatic}:{}),...(segments.length?{segments}:{}),...(subtitle.truncated===true?{truncated:true}:{})};
  }
  return content;
}
const date=(value:number)=>new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(value*1000)+' UTC+8';
export function contentText(content:PluginContent):string {
  if(content.type==='video')return [content.title,...(content.author?[`作者：${content.author}`]:[]),...(content.durationSeconds!==undefined?[`时长：${Math.ceil(content.durationSeconds)} 秒`]:[]),content.description,content.subtitle?.status==='ready'?'已取得字幕，可在后续对话中结合字幕讨论。':content.subtitle?.status==='login_required'?'字幕需要登录权限。':'未取得可用字幕。',content.url].filter(Boolean).join('\n').slice(0,16000);
  const common=[content.title,...(content.author?[`${content.type==='live'?'主播':'作者'}：${content.author}`]:[]),...(content.publishedAt?[`发布时间：${date(content.publishedAt)}`]:[])];
  if(content.type==='live') {
    const live=content.live;
    return [...common,live?`状态：${live.status==='live'?'直播中':live.status==='replay'?'轮播中':'未开播'}`:'直播状态暂不可用',...(live?.area?[`分区：${[live.parentArea,live.area].filter(Boolean).join(' / ')}`]:[]),...(content.observedAt?[`资料获取于：${date(content.observedAt)}`]:[]),content.url].filter(Boolean).join('\n');
  }
  const body=(content.blocks??[]).map(block=>block.type==='paragraph'?block.text:block.type==='resource'?[block.title,block.resource.url].filter(Boolean).join('\n'):'').filter(Boolean).join('\n');
  return [...common,body,...(content.original?[`转发自 ${content.original.author??'原作者'}：`,contentText(content.original)]:[]),content.url].filter(Boolean).join('\n').slice(0,16000);
}
export function pluginErrorText(code:string):string {
  if(code==='BILIBILI_HTTP_412')return '哔哩哔哩拒绝了本次获取请求（412），暂时只能使用分享中已有的信息。';
  if(code==='BILIBILI_LOGIN_REQUIRED')return '这条内容需要登录权限，当前未取得所需权限。';
  if(code==='BILIBILI_NOT_FOUND')return '这条内容不存在、已删除或当前不可见。';
  if(code==='PLUGIN_JOB_EXPIRED')return '内容处理已超过有效时间。';
  return '这次未能完成内容处理，已保留原始分享信息。';
}
