import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recoverMemoryCompactions } from '../src/memory-compaction-recovery.js';

test('recovery reads persisted checkpoints without replaying chat or incomplete trailing records', async () => {
  const directory=mkdtempSync(join(tmpdir(),'memory-checkpoint-'));const file=join(directory,'session.jsonl');
  const rows=[{type:'session',id:'session'},{type:'message',id:'message',message:{content:'unrelated chat'}},{type:'compaction',id:'checkpoint-1',summary:'verified checkpoint'},{type:'compaction',id:'checkpoint-2',summary:'next checkpoint'}];
  writeFileSync(file,rows.map(row=>JSON.stringify(row)).join('\n')+'\n{"type":"compaction",');
  try{const found:Array<{session:string;entryId:string}>=[];await recoverMemoryCompactions(file,new AbortController().signal,info=>found.push(info));assert.deepEqual(found.map(info=>info.entryId),['checkpoint-1','checkpoint-2']);assert.ok(found.every(info=>info.session===file));}
  finally{rmSync(directory,{recursive:true,force:true});}
});
