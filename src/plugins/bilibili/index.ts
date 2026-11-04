import type { ContentPluginDefinition, PluginManifest } from '../../plugin-system/contracts.js';
import { BILIBILI_DEFAULTS, validateBilibiliConfig } from './config.js';
import { bilibiliResources, matchBilibiliCommand, normalizeBilibiliResource } from './recognize.js';
import { contentText, pluginErrorText, validatePluginContent } from './content.js';

export default function createPlugin(manifest: PluginManifest): ContentPluginDefinition {
  return {
    kind:'content',manifest,defaults:BILIBILI_DEFAULTS,
    validateConfig:(input,current)=>validateBilibiliConfig(input,current?validateBilibiliConfig(current):undefined),
    match:bilibiliResources,command:matchBilibiliCommand,
    commandName:command=>manifest.commands.find(item=>item.name.split(/\s+/u).at(-1)===command)?.name??command,
    validateContent:(value,source)=>{const normalized=normalizeBilibiliResource(source.url);if(!normalized)throw new Error('插件链接无效');return validatePluginContent(value,normalized);},
    contentText,errorText:pluginErrorText,
    failureContent:(source,error)=>({type:source.kind==='post'?'post':source.kind==='live'?'live':'video',platform:'bilibili',resourceId:source.id,url:source.url,
      title:(source.title??(source.kind==='live'?'哔哩哔哩直播间':source.kind==='post'?'哔哩哔哩动态':'哔哩哔哩视频')).slice(0,500),...(source.part?{part:source.part}:{}),retrieval:{status:'partial',error},
      ...(source.kind==='video'?{subtitle:{status:error==='BILIBILI_LOGIN_REQUIRED'?'login_required' as const:'failed' as const}}:{})}),
    shouldProcess(config,resource){const s=validateBilibiliConfig(config);
      if(resource?.kind==='video')return s.enhance||s.autoVideo;
      if(resource?.kind==='post')return s.dynamicEnhance||s.dynamicDisplay!=='off';
      if(resource?.kind==='live')return s.liveEnhance||s.liveDisplay!=='off';
      return s.enhance||s.autoVideo||s.dynamicEnhance||s.dynamicDisplay!=='off'||s.liveEnhance||s.liveDisplay!=='off';},
    policy(config){const s=validateBilibiliConfig(config);return {timeoutSeconds:s.timeoutSeconds,waitSeconds:s.waitSeconds,maxAssetBytes:s.maxMiB*1024*1024,cacheMaxBytes:s.cacheMaxMiB*1024*1024,cacheHours:s.cacheHours};},
    summarize(source,content){const r=normalizeBilibiliResource(content?.url??source?.url??'');if(!r)return;return {id:r.id,url:r.url,...(r.part?{part:r.part}:{}),...(content?.title??source?.title?{title:(content?.title??source?.title)!.slice(0,500)}:{}),...(content?.author?{author:content.author.slice(0,500)}:{})};},
    missingResourceText:'请提供哔哩哔哩视频、动态或直播链接，或引用此前的分享。',
    afterResolve(command,source,config,content){
      const s=validateBilibiliConfig(config);
      if(content.type==='video')return {provideContext:s.enhance||command!=='share',...(command==='info'?{replyText:contentText(content)}:{}),
        ...(command==='download'||command==='share'&&s.autoVideo?content.durationSeconds!==undefined&&content.durationSeconds<=s.maxDurationSeconds?{download:{...source,kind:'video',url:content.url,id:content.resourceId,title:content.title}}:command==='download'?{replyText:content.durationSeconds===undefined?'未能确认视频时长，暂不下载。':'视频时长超过本实例配置的上限。'}:{}:{})};
      if(command==='download')return {provideContext:false,replyText:'下载指令仅支持视频；动态和直播可使用 /bili info 查询资料。'};
      const enhance=content.type==='post'?s.dynamicEnhance:s.liveEnhance,display=content.type==='post'?s.dynamicDisplay:s.liveDisplay;
      const provideContext=enhance||command==='info';
      return {provideContext,...(command==='info'?{replyText:contentText(content)}:{}),
        ...(provideContext||command==='share'&&display!=='off'?{prepare:{mode:command==='share'&&display!=='off'?display:'none' as const,provideContext}}:{})};
    },
  };
}
