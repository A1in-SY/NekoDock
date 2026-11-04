/** Large forward trees already live in paginated archive revision text; avoid duplicating them on every page. */
export function historySharedContents(contents:unknown[]|undefined):{
  contents?:unknown[];
  forwardContentOmitted?:boolean;
  forwardContentNote?:string;
} {
  if(!contents?.length)return {};
  const isForward=(item:unknown)=>!!item&&typeof item==='object'&&!Array.isArray(item)&&(item as {type?:unknown}).type==='forward';
  const forwards=contents.filter(isForward);
  if(!forwards.length||Buffer.byteLength(JSON.stringify(forwards))<=4096)return {contents};
  const retained=contents.filter(item=>!isForward(item));
  return {...(retained.length?{contents:retained}:{}),forwardContentOmitted:true,
    forwardContentNote:'Large forwarded contents are preserved in archived revision text. Search the message revisions, then continue the selected source using afterSeq=seq-1, limit=1 and textOffset. Each textOffset counts characters in that source; quoted authors remain separate from the forwarder.'};
}
