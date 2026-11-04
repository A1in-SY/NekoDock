import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { imageExtension } from './images.js';
import { isMp3Snapshot } from './audio.js';
import type { ChatAsset } from './chat-context-contract.js';

/** Retain confirmed outgoing media in the bot workspace for later context and file tools. */
export async function saveChatAsset(workspace: string, snapshot: string, type: 'image'|'voice'): Promise<ChatAsset> {
  if(!snapshot.startsWith('base64://') || type==='voice'&&!isMp3Snapshot(snapshot))throw new Error('Invalid chat media snapshot.');
  const bytes=Buffer.from(snapshot.slice(9),'base64');
  if(!bytes.length || bytes.length>20*1024*1024)throw new Error('Chat media exceeds its size limit.');
  const extension=type==='image'?imageExtension(bytes):'mp3';
  const hash=createHash('sha256').update(bytes).digest('hex');
  const directory=resolve(workspace,'.chat-media');
  await mkdir(directory,{recursive:true,mode:0o700});
  if((await lstat(directory)).isSymbolicLink())throw new Error('Invalid chat media directory.');
  const path=join(directory,`${hash}.${extension}`),temporary=join(directory,`${randomUUID()}.tmp`);
  try {
    const handle=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try {await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
    await rename(temporary,path);
    const parent=await open(directory,constants.O_RDONLY);try{await parent.sync();}finally{await parent.close();}
  } finally {await rm(temporary,{force:true});}
  return {id:`sha256:${hash}`,type,path,status:'ready',mimeType:type==='voice'?'audio/mpeg':extension==='jpg'?'image/jpeg':`image/${extension}`};
}
