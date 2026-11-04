import test from 'node:test';
import assert from 'node:assert/strict';
import type { MemoryItem } from '../../src/memory-contract.ts';
import { memoryControlPayload, memoryDetailEvents, memoryFilteredItems, memoryListPage, memoryLocalTime, memoryRange } from '../src/memory-state.ts';
test('memory backfill timestamps use explicit UTC+8 and reject invalid date rollovers',()=>{
  const range=memoryRange('2026-10-01T00:00','2026-10-02T04:00');
  assert.equal(new Date(range.from).toISOString(),'2026-09-30T16:00:00.000Z');
  assert.equal(memoryLocalTime(range.to),'2026-10-02T04:00');
  assert.throws(()=>memoryRange('2026-02-31T00:00','2026-03-05T00:00'));
  assert.throws(()=>memoryRange('2026-10-02T00:00','2026-10-01T00:00'));
});
test('memory control payloads include only user-controlled mutation fields',()=>{
  const item={id:'one',revision:4,content:'old',subjectUserId:'1001'};
  assert.deepEqual(memoryControlPayload('update',item,'  new  '),{operation:'update',memoryId:'one',expectedRevision:4,content:'new'});
  assert.deepEqual(memoryControlPayload('disable',item),{operation:'disable',memoryId:'one',expectedRevision:4});
  assert.deepEqual(memoryControlPayload('update',item,'restored',true),{operation:'update',memoryId:'one',expectedRevision:4,content:'restored',restore:true});
  assert.deepEqual(memoryControlPayload('run'),{operation:'run'});
  assert.throws(()=>memoryControlPayload('update',item,''));
});

test('memory detail merges cumulative thinking and paired tools without mixing jobs',()=>{
  const events=[
    {seq:1,jobId:'one',time:1,type:'thinking.updated',payload:{itemId:'a',text:'partial'}},
    {seq:2,jobId:'two',time:2,type:'thinking.updated',payload:{itemId:'a',text:'other'}},
    {seq:3,jobId:'one',time:3,type:'thinking.updated',payload:{itemId:'a',text:'complete',status:'completed'}},
    {seq:4,jobId:'one',time:4,type:'tool.started',payload:{itemId:'b',tool:'search_memory'}},
    {seq:5,jobId:'one',time:5,type:'tool.completed',payload:{itemId:'b',status:'completed'}}
  ];
  const output=memoryDetailEvents({enabled:true,version:1,cursor:0,highWater:0,items:[],jobs:[],events},'one');
  assert.equal(output.length,2);assert.equal(output[0]!.payload.text,'complete');assert.equal(output[1]!.payload.tool,'search_memory');assert.equal(output[1]!.type,'tool.completed');
});

function memoryItem(index: number, overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id:`memory-${index}`,scope:'person',subjectUserId:`user-${index}`,kind:'preference',topic:'Music',content:`Preference ${index}`,
    occurredAt:null,validFrom:null,validTo:null,status:'active',revision:1,sources:[],createdAt:index,updatedAt:index,...overrides
  };
}

test('memory pages cover every item once and display the matching one-based range',()=>{
  const items=Array.from({length:29},(_,index)=>memoryItem(index));
  const before=items.map(item=>item.id);
  const pages=[1,2,3].map(page=>memoryListPage(items,page,12));
  assert.deepEqual(pages.flatMap(page=>page.items.map(item=>item.id)),before);
  assert.deepEqual(pages.map(({page,pages,total,start,end})=>({page,pages,total,start,end})),[
    {page:1,pages:3,total:29,start:1,end:12},
    {page:2,pages:3,total:29,start:13,end:24},
    {page:3,pages:3,total:29,start:25,end:29}
  ]);
  assert.deepEqual(items.map(item=>item.id),before,'pagination preserves the synchronized item order');
  assert.equal(memoryListPage(items,1,24).items.length,24);
  assert.equal(memoryListPage(items,1,48).pages,1);
});

test('memory filtering runs across the snapshot before page totals and slices are calculated',()=>{
  const items=Array.from({length:25},(_,index)=>memoryItem(index,{status:index%2===0?'active':'disabled'}));
  const filtered=memoryFilteredItems(items,'  MUSIC  ',false);
  const result=memoryListPage(filtered,2,12);
  assert.equal(filtered.length,13);
  assert.equal(result.total,13);
  assert.equal(result.pages,2);
  assert.deepEqual(result.items.map(item=>item.id),['memory-24']);
  assert.equal(memoryListPage(memoryFilteredItems(items,'music',true),3,12).total,25);
  assert.deepEqual(memoryFilteredItems(items,'preference 24',false).map(item=>item.id),['memory-24']);
  assert.deepEqual(memoryFilteredItems(items,'USER-23',true).map(item=>item.id),['memory-23']);
  assert.equal(memoryFilteredItems(items,'user-23',false).length,0);
  assert.equal(memoryFilteredItems(items,'   ',false).length,13);
});

test('memory refreshes clamp a stale page when the synchronized list gets shorter',()=>{
  const items=Array.from({length:25},(_,index)=>memoryItem(index));
  assert.equal(memoryListPage(items,3,12).page,3);
  const shortened=memoryListPage(items.slice(0,13),3,12);
  assert.equal(shortened.page,2);
  assert.deepEqual(shortened.items.map(item=>item.id),['memory-12']);
  const onePage=memoryListPage(items.slice(0,12),3,12);
  assert.equal(onePage.page,1);
  assert.equal(onePage.pages,1);
  assert.equal(onePage.items.length,12);
  assert.equal(memoryListPage(items,0,12).page,1);
  assert.equal(memoryListPage(items,99,12).page,3);
});

test('empty memory results retain a valid page without an invalid display range',()=>{
  assert.deepEqual(memoryListPage([],7,12),{items:[],page:1,pages:1,total:0,start:0,end:0});
  const items=[memoryItem(1),memoryItem(2,{status:'superseded'})];
  assert.deepEqual(memoryListPage(memoryFilteredItems(items,'no matching topic',true),2,12),{
    items:[],page:1,pages:1,total:0,start:0,end:0
  });
  assert.deepEqual(memoryFilteredItems(items,'',true).map(item=>item.id),['memory-1','memory-2']);
});
