import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { recoverIncomingImages } from '../src/incoming-image-recovery.js';

test('legacy recovery restores explicit image indexes and ignores tool messages and incomplete records', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'image-recovery-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = '/data/workspace/.qq-images/' + 'a'.repeat(64) + '.png';
  const text = JSON.stringify({ messages: [{ messageId: 'message-example', images: [{ error: 'unavailable' }, { path }] }] });
  const file = join(dir, 'session.jsonl');
  await writeFile(file, [
    { type: 'message', message: { role: 'toolResult', content: [{ type: 'text', text }] } },
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text }] } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text }] } },
  ].map(value => JSON.stringify(value)).join('\n') + '\n{"type":"message",');
  const calls: unknown[] = [];
  assert.equal(await recoverIncomingImages(file, new AbortController().signal, async (...args) => {
    calls.push(args.slice(0, 3)); return true;
  }), 1);
  assert.deepEqual(calls, [['message-example', 1, path]]);
});

test('legacy recovery leaves plugin pictures in their separate durable attachment namespace',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'image-recovery-plugin-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const path='/data/workspace/.qq-images/'+'b'.repeat(64)+'.png';
  const file=join(dir,'session.jsonl');
  await writeFile(file,JSON.stringify({type:'message',message:{role:'user',content:[{type:'text',text:JSON.stringify({messages:[{messageId:'source',images:[
    {attachmentId:'plugin:example',origin:'plugin',path},{attachmentId:'native',path},
  ]}]})}]}}));
  const calls:unknown[]=[];
  assert.equal(await recoverIncomingImages(file,new AbortController().signal,async(...args)=>{calls.push(args.slice(0,3));return true;}),1);
  assert.deepEqual(calls,[['source',1,path]]);
});
