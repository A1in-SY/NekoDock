import type { PluginDispatch } from '../../plugin-system/contracts.js';
import { pluginCommandText } from '../../plugin-system/command-parser.js';
import type { BilibiliResource } from './types.js';
const object=(v:unknown):Record<string,unknown>|null=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:null;
const scalar=(v:unknown)=>typeof v==='string'?v:typeof v==='number'?String(v):'';

export function matchBilibiliCommand(event: unknown): PluginDispatch | undefined {
  const input=pluginCommandText(event);if(!input)return;
  const match=/^\/bili\s+(info|download)(?:\s+([\s\S]*))?$/u.exec(input.text);
  if(match)return {pluginId:'bilibili',command:match[1]!,args:match[2]?.trim()??'',sourceMessageId:input.sourceMessageId,contextPolicy:'chat',executor:'console'};
}
/** Extract only user-visible shares; card internals are never interpreted as commands. */
export function bilibiliResources(event:unknown):BilibiliResource[] {
  const e=object(event);if(!e)return [];
  const text:string[]=[];
  if(typeof e.message==='string')text.push(e.message);
  else if(Array.isArray(e.message))for(const item of e.message) {
    const s=object(item),d=object(s?.data);if(!s||!d)continue;
    if(s.type==='text')text.push(scalar(d.text));
    if(s.type==='json') {
      let card=object(d.data);try {if(typeof d.data==='string')card=object(JSON.parse(d.data));}catch{}
      if(!card)continue;
      for(const item of Object.values(object(card.meta)??{})) {
        const detail=object(item);if(!detail)continue;
        const url=scalar(detail.qqdocurl)||scalar(detail.url)||scalar(detail.jumpUrl);
        if(url)text.push(url);
      }
    }
  }
  const title=Array.isArray(e.message)?e.message.map(item=>{const s=object(item),d=object(s?.data);if(s?.type!=='json')return '';let card=object(d?.data);try{if(typeof d?.data==='string')card=object(JSON.parse(d.data));}catch{};return scalar(object(object(card?.meta)?.detail_1)?.desc).slice(0,500);}).find(Boolean):undefined;
  const matches=text.join('\n').match(/https?:\/\/(?:(?:(?:www\.|m\.)?bilibili\.com\/(?:(?:zh-Hans\/)?video\/(?:BV[0-9A-Za-z]{10}|av\d+)|opus\/\d+)|t\.bilibili\.com\/\d+|(?:live|live\.m)\.bilibili\.com\/(?:h5\/)?\d+|m\.live\.bilibili\.com\/(?:h5\/)?\d+)(?:[^\s<>"'\]，。]*)?|b23\.tv\/[0-9A-Za-z]+(?:\?[^\s<>"'\]，。]*)?)|\bBV[0-9A-Za-z]{10}\b/gu)??[];
  const out=new Map<string,BilibiliResource>();
  for(const found of matches.slice(0,8)) {
    const resource=normalizeBilibiliResource(found,title);if(resource)out.set(resource.id,resource);
  }
  return [...out.values()];
}
export function normalizeBilibiliResource(input:string,title?:string):BilibiliResource|null {
  if(input.length>4096)return null;
  try {
    const u=new URL(/^BV[0-9A-Za-z]{10}$/u.test(input)?`https://www.bilibili.com/video/${input}`:input);
    if(u.username||u.password||u.port||u.protocol!=='https:'&&u.protocol!=='http:')return null;
    const host=u.hostname.toLowerCase();const part=Math.max(1,Math.min(1000,Number(u.searchParams.get('p'))||1));
    if(host==='b23.tv'&&/^\/[0-9A-Za-z]+\/?$/u.test(u.pathname))return {kind:'short',id:`short:${u.pathname.replaceAll('/','')}`,url:`https://b23.tv${u.pathname}`,...(title?{title:title.slice(0,500)}: {})};
    const post=/^\/(?:opus\/)?(\d{1,30})\/?$/u.exec(u.pathname)?.[1];
    if(post&&(host==='t.bilibili.com'||['www.bilibili.com','bilibili.com','m.bilibili.com'].includes(host)&&u.pathname.startsWith('/opus/')))return {kind:'post',id:`post:${post}`,url:`https://www.bilibili.com/opus/${post}`,...(title?{title:title.slice(0,500)}: {})};
    const room=/^\/(?:h5\/)?(\d{1,20})\/?$/u.exec(u.pathname)?.[1];
    if(room&&['live.bilibili.com','live.m.bilibili.com','m.live.bilibili.com'].includes(host))return {kind:'live',id:`live:${room}`,url:`https://live.bilibili.com/${room}`,...(title?{title:title.slice(0,500)}: {})};
    if(!['www.bilibili.com','bilibili.com','m.bilibili.com'].includes(host))return null;
    const id=/^\/(?:zh-Hans\/)?video\/(BV[0-9A-Za-z]{10}|av\d+)\/?$/u.exec(u.pathname)?.[1];if(!id)return null;
    return {kind:'video',id:`${id}:p${part}`,url:`https://www.bilibili.com/video/${id}${part>1?`?p=${part}`:''}`,part,...(title?{title:title.slice(0,500)}: {})};
  }catch{return null;}
}
