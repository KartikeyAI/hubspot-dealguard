import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {persistDecisionSnapshot} from '../dist/decision-snapshot.js';

test('closed snapshot cleanup uses the exact source version rather than unconditional deletion',async()=>{
  const calls=[];const env={DB:{prepare(sql){return {bind(...params){return {async first(){calls.push({sql,params});return {accepted:false};}};}};}}};
  const at=new Date(Date.now()-1000).toISOString();
  assert.equal(await persistDecisionSnapshot(env,'100','1',{dealId:'1',isClosed:true,assessedAt:at}),false);
  assert.equal(calls.length,1);assert.match(calls[0].sql,/reconcile_closed_deal_evidence/);assert.deepEqual(calls[0].params,['100','1',at]);
  assert.equal(await persistDecisionSnapshot(env,'100','1',{dealId:'1',isClosed:true,assessedAt:'invalid'}),false);
  assert.equal(calls.length,1);
});
test('lifecycle migration fences parent identity and records closure atomically',()=>{
  const sql=readFileSync('database/migrations/0026_decision_lifecycle_fences.sql','utf8');
  assert.match(sql,/FOR UPDATE/);assert.match(sql,/BEFORE INSERT OR UPDATE ON deal_decision_snapshots/);
  assert.match(sql,/BEFORE INSERT OR UPDATE ON recommendation_instances/);assert.match(sql,/INSERT INTO dealguard.recommendation_events/);
  assert.doesNotMatch(sql,/SECURITY DEFINER|DROP TABLE|TRUNCATE/);
  const source=readFileSync('worker/src/recommendation-observation.ts','utf8');
  assert.match(source,/RETURNING id/);assert.match(source,/if \(!inserted\) return/);
});
