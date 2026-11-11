import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import type {PluginRunnerJob} from '../src/plugin-system/contracts.js';
import {BILIBILI_DEFAULTS} from '../src/plugins/bilibili/config.js';
import {normalizeBilibiliResource} from '../src/plugins/bilibili/recognize.js';
import {executeBilibiliJob,resolveBilibiliUrl} from '../src/plugins/bilibili/runner.js';

const short='https://b23.tv/Synthetic';
const signal=()=>new AbortController().signal;
const redirect=(location:string)=>new Response(null,{status:302,headers:{location}});

test('Bilibili short links canonicalize localized BV and av videos with their selected part',async()=>{
  for(const id of ['BV0123456789','av123456']) {
    const controller=new AbortController();let calls=0;
    const result=await resolveBilibiliUrl(short,async(input,options)=>{
      calls++;assert.equal(String(input),short);assert.equal(options?.redirect,'manual');assert.equal(options?.signal,controller.signal);
      return redirect(`https://www.bilibili.com/zh-Hans/video/${id}?p=2&share_source=copy`);
    },controller.signal);
    assert.equal(result,`https://www.bilibili.com/video/${id}?p=2`);assert.equal(calls,1);
  }
});

test('Bilibili short links retain standard video, dynamic and live destinations',async()=>{
  const destinations=[
    ['https://www.bilibili.com/video/BV0123456789?p=3','https://www.bilibili.com/video/BV0123456789?p=3'],
    ['https://t.bilibili.com/100001?from=copy','https://www.bilibili.com/opus/100001'],
    ['https://www.bilibili.com/opus/100002','https://www.bilibili.com/opus/100002'],
    ['https://live.m.bilibili.com/h5/100003','https://live.bilibili.com/100003'],
  ];
  for(const [location,expected] of destinations) {
    let calls=0;
    assert.equal(await resolveBilibiliUrl(short,async()=>{calls++;return redirect(location!);},signal()),expected);
    assert.equal(calls,1);
  }
});

test('Bilibili short links follow relative redirects and validate every hop',async()=>{
  const requested:string[]=[];
  assert.equal(await resolveBilibiliUrl(short,async input=>{
    requested.push(String(input));
    return requested.length===1?redirect('/Second'):redirect('https://www.bilibili.com/zh-Hans/video/BV0123456789?p=4');
  },signal()),'https://www.bilibili.com/video/BV0123456789?p=4');
  assert.deepEqual(requested,[short,'https://b23.tv/Second']);

  const rejected=[
    'https://www.bilibili.com.evil.test/zh-Hans/video/BV0123456789',
    'https://evil.test/zh-Hans/video/BV0123456789',
    'https://127.0.0.1/video/BV0123456789',
    'ftp://www.bilibili.com/zh-Hans/video/BV0123456789',
    'https://user:password@www.bilibili.com/zh-Hans/video/BV0123456789',
    'https://www.bilibili.com:8443/zh-Hans/video/BV0123456789',
    'https://www.bilibili.com/zh-Hant/video/BV0123456789',
    'https://www.bilibili.com/arbitrary/zh-Hans/video/BV0123456789',
    'https://www.bilibili.com/zh-Hans/video/BV0123456789/extra',
    'https://www.bilibili.com/zh-Hans/opus/100001',
    'https://b23.tv/not/a/short',
  ];
  for(const location of rejected) {
    let calls=0;
    await assert.rejects(resolveBilibiliUrl(short,async()=>{
      calls++;return redirect(calls===1?'https://b23.tv/Second':location);
    },signal()),/BILIBILI_REDIRECT_REJECTED/u,location);
    assert.equal(calls,2);
  }
});

test('Bilibili short links preserve the redirect limit and failed-response errors',async()=>{
  let calls=0;
  await assert.rejects(resolveBilibiliUrl(short,async()=>{calls++;return redirect(`/Hop${calls}`);},signal()),/BILIBILI_REDIRECT_LIMIT/u);
  assert.equal(calls,5);
  for(const response of [new Response(null,{status:200}),new Response(null,{status:302})]) {
    await assert.rejects(resolveBilibiliUrl(short,async()=>response,signal()),/BILIBILI_SHORT_LINK_FAILED/u);
  }
  await assert.rejects(resolveBilibiliUrl(short,async()=>new Response(null,{status:412}),signal()),/BILIBILI_HTTP_412/u);
});

test('Bilibili localized short-link destinations reach the video extractor with a canonical URL',async t=>{
  const root=await mkdtemp(join(tmpdir(),'nekodock-bili-localized-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const resource=normalizeBilibiliResource(short)!;
  const job:PluginRunnerJob={id:'synthetic-job',lease:'synthetic-lease',botId:'synthetic-bot',pluginId:'bilibili',operation:'resolve',command:'share',resource,
    config:{...BILIBILI_DEFAULTS,subtitles:false},networkProxy:{enabled:false,url:'',noProxy:'',forTools:true},expiresAt:Date.now()+60000};
  let extracts=0;
  const execution=await executeBilibiliJob(job,root,signal(),{
    fetch:async input=>{assert.equal(String(input),short);return redirect('https://www.bilibili.com/zh-Hans/video/BV0123456789?p=2');},
    run:async(command,args)=>{
      extracts++;assert.equal(command,'yt-dlp');assert.equal(args.at(-1),'https://www.bilibili.com/video/BV0123456789?p=2');
      return JSON.stringify({title:'Synthetic video',webpage_url:'https://www.bilibili.com/video/BV0123456789',duration:30});
    },
  });
  t.after(execution.cleanup);
  assert.equal(extracts,1);assert.equal(execution.content?.type,'video');assert.equal(execution.content?.resourceId,'BV0123456789:p2');
  assert.equal(execution.content?.url,'https://www.bilibili.com/video/BV0123456789?p=2');assert.equal(execution.content?.part,2);
});
