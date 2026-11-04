import type { PluginContent } from '../../plugin-system/contracts.js';
import { apiJson, id, object, string, timestamp } from './api.js';
import { contentImage } from './dynamic.js';
import { BilibiliError } from './errors.js';
import type { BilibiliResource } from './types.js';

export async function resolveLive(resource:BilibiliResource,fetcher:typeof globalThis.fetch,signal:AbortSignal,cookie?:string):Promise<PluginContent> {
  const requested=resource.id.replace(/^live:/u,''); if(!/^\d{1,20}$/u.test(requested))throw new BilibiliError('BILIBILI_INVALID_URL');
  const observedAt=Date.now()/1000;
  const room=await apiJson(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${requested}`,fetcher,signal,cookie);
  const roomId=id(room.room_id),uid=id(room.uid);if(!roomId||!uid)throw new BilibiliError('BILIBILI_RESPONSE_INVALID');
  if(![0,1,2].includes(room.live_status))throw new BilibiliError('BILIBILI_RESPONSE_INVALID');
  const content:PluginContent={type:'live',platform:'bilibili',resourceId:`live:${roomId}`,url:`https://live.bilibili.com/${roomId}`,
    title:string(room.title,500)||'哔哩哔哩直播间',authorId:uid,observedAt,retrieval:{status:'ready'},
    description:string(room.description).replace(/<[^>]*>/gu,'').replace(/&nbsp;/gu,' ').slice(0,4000),
    live:{roomId,...(id(room.short_id)&&Number(room.short_id)>0?{shortId:id(room.short_id)}:{}),status:room.live_status===1?'live':room.live_status===2?'replay':'offline',
      area:string(room.area_name,200),parentArea:string(room.parent_area_name,200)}};
  const start=typeof room.live_time==='string'&&/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/u.test(room.live_time)?Date.parse(room.live_time.replace(' ','T')+'+08:00')/1000:timestamp(room.live_time);
  if(start&&Number.isFinite(start)&&start>0&&content.live!.status!=='offline')content.live!.startedAt=start;
  const cover=contentImage(room.user_cover,`${content.resourceId}:cover`,'cover');if(cover){content.live!.cover=cover;content.coverUrl=cover.url;}
  if(content.live!.status==='live') {
    const preview=contentImage(room.keyframe,`${content.resourceId}:preview`,'live_preview');if(preview)content.live!.preview=preview;
  }
  try {
    const data=await apiJson(`https://api.live.bilibili.com/live_user/v1/Master/info?uid=${uid}`,fetcher,signal,cookie),info=object(data.info);
    content.author=string(info.uname,500)||undefined;
    const avatar=contentImage(info.face,`${content.resourceId}:avatar`,'avatar');if(avatar)content.authorAvatar=avatar;
  }catch{signal.throwIfAborted();content.retrieval={status:'partial',error:'BILIBILI_AUTHOR_UNAVAILABLE'};}
  return content;
}
