import type { ManagedIdentity } from './managed-worker.js';
import { directFetch } from './network.js';
import { imageExtension } from './images.js';

/** Only semantic source pictures become vision input; presentation images remain display artifacts. */
export function pluginSourceImageIds(contents: unknown[]): string[] {
  const ids=new Set<string>();
  const object=(value:unknown):Record<string,unknown>|null=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
  const add=(value:unknown)=>{const image=object(value);if(image&&['content','live_preview'].includes(String(image.role))&&image.status==='ready'&&typeof image.assetId==='string'&&/^[A-Za-z0-9_-]{1,200}$/u.test(image.assetId))ids.add(image.assetId);};
  const visit=(value:unknown,depth:number)=>{
    const content=object(value);if(!content||depth>1)return;
    for(const block of Array.isArray(content.blocks)?content.blocks.slice(0,256):[]){const b=object(block);if(b?.type==='image')add(b.image);}
    const live=object(content.live);if(live?.status==='live')add(live.preview);
    if(content.original)visit(content.original,depth+1);
  };
  for(const content of contents.slice(0,16))visit(content,0);
  return [...ids].slice(0,64);
}

export function createPluginImageReader(identity:ManagedIdentity,maxBytes:number,timeoutMs:number,fetcher:typeof globalThis.fetch=directFetch) {
  return async(assetId:string,signal:AbortSignal):Promise<Buffer>=>{
    if(!/^[A-Za-z0-9_-]{1,200}$/u.test(assetId))throw new Error('图片读取失败');
    const requestSignal=AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]);
    const response=await fetcher(`${identity.url}/internal/workers/${encodeURIComponent(identity.botId)}/plugins/assets/${encodeURIComponent(assetId)}`,{
      headers:{authorization:`Bearer ${identity.token}`},signal:requestSignal,redirect:'error',
    });
    if(!response.ok||!response.body){await response.body?.cancel();throw new Error('图片读取失败');}
    const declared=response.headers.get('content-length');
    if(declared&&/^\d+$/u.test(declared)&&Number(declared)>maxBytes){await response.body.cancel();throw new Error('图片超过大小限制');}
    const chunks:Buffer[]=[];let size=0;
    for await(const chunk of response.body){requestSignal.throwIfAborted();size+=chunk.byteLength;if(size>maxBytes)throw new Error('图片超过大小限制');chunks.push(Buffer.from(chunk));}
    requestSignal.throwIfAborted();const bytes=Buffer.concat(chunks,size);imageExtension(bytes);return bytes;
  };
}
