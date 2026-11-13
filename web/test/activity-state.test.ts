import test from 'node:test';
import assert from 'node:assert/strict';
import { activeActivities, activityTracks, nearbyProcesses, traceAncestors } from '../src/activity-state.ts';
import type { ActivitySpan, ObservedProcessSample } from '../../src/activity-contract.ts';
const span=(id:string,patch:Partial<ActivitySpan>={}):ActivitySpan=>({id,traceId:'reply-a',kind:'render',name:'image_render',startedAt:1000,time:2000,endedAt:2000,status:'completed',resourceId:'runner',botId:'first',...patch});
test('parallel work receives separate tracks while sequential stages share a track',()=>{
  const rows=activityTracks([span('a'),span('b',{startedAt:1200,endedAt:1800}),span('c',{startedAt:2200,endedAt:2500})],0,3000,3000);
  assert.equal(rows.length,2);assert.deepEqual(rows[0]!.spans.map(s=>s.id),['a','c']);assert.deepEqual(rows[1]!.spans.map(s=>s.id),['b']);
});
test('evidence matches instance and resource and selects the closest sample without inventing a zero',()=>{
  const sample=(id:string,time:number,botId='first'):ObservedProcessSample=>({id,spanId:'a',resourceId:'runner',botId,time,intervalMs:1000,cpu:null,coverage:'partial',processes:[]});
  const rows=nearbyProcesses([sample('old',1000),sample('closest',1900),sample('another-instance',2000,'second'),sample('too-old',-10000)],2000,[span('a')]);
  assert.equal(rows.length,1);assert.equal(rows[0]!.sample.id,'closest');assert.equal(rows[0]!.sample.cpu,null);
});
test('trace traversal stays in the same instance and terminates cycles',()=>{
  const child=span('child',{parentId:'parent'}),parent=span('parent',{parentId:'child'});
  assert.deepEqual(traceAncestors(child,[child,parent,span('parent',{botId:'second'})]).map(s=>s.id),['parent','child']);
});
test('simultaneous phase counts do not count enclosing tasks as additional work',()=>{
  const rows=[span('root'),span('agent',{parentId:'root'}),span('tool',{parentId:'agent'}),span('send',{kind:'send',parentId:'root'}),span('another',{botId:'second'})];
  assert.deepEqual(activeActivities(rows,1500).map(s=>s.id),['tool','send','another']);
});
test('an aggregated metric bucket inspects its entire interval and reports per-phase peak samples',()=>{
  const point=(id:string,time:number,cpu:number):ObservedProcessSample=>({id,spanId:'a',resourceId:'runner',botId:'first',time,intervalMs:1000,cpu,coverage:'sampled',processes:[]});
  const rows=nearbyProcesses([point('before',9000,12),point('bucket-peak',24000,150),point('outside',26000,200)],10000,[span('a',{startedAt:9000,endedAt:25000})],15000);
  assert.equal(rows[0]!.sample.id,'bucket-peak');assert.equal(activeActivities([span('b',{startedAt:18000,endedAt:23000})],5000,25000).length,1);
});
