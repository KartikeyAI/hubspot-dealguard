import test from 'node:test';
import assert from 'node:assert/strict';
import { managerQueueOptions, buildManagerDecisionQueue, managerDecisionQueue } from '../dist/manager-decision-queue.js';
const at = new Date().toISOString();
const row = id => ({ deal_id:id,deal_name:`Account ${id}`,score:80,status:'ready',issue_count:0,
  assessed_at:at,issues_json:'[]',deal_amount:100,deal_currency_code:'USD',stage_age_days:0 });

test('queue controls reject duplicate, overlong and invalid values', () => {
  for (const value of ['limit=0','limit=101','limit=1.5','offset=-1','band=nope','q=a&q=b','band=review&band=act_now','evidenceMode=unknown',`q=${'x'.repeat(121)}`]) {
    assert.throws(() => managerQueueOptions(new URLSearchParams(value)), { status:400 });
  }
  assert.deepEqual(managerQueueOptions(new URLSearchParams('limit=10&offset=20&q=Acme')), {
    limit:10,offset:20,query:'Acme',band:null,evidenceMode:null,
  });
});
test('pagination preserves stable ranking and disjoint pages while search narrows results', () => {
  const rows = ['c','b','a','d'].map(row);
  const first=buildManagerDecisionQueue('1',rows,{limit:2}), second=buildManagerDecisionQueue('1',rows,{limit:2,offset:2});
  assert.deepEqual(first.items.map(r=>r.dealId),['a','b']);
  assert.deepEqual(second.items.map(r=>r.dealId),['c','d']);
  assert.equal(first.pagination.nextOffset,2);assert.equal(second.pagination.nextOffset,null);
  const found=buildManagerDecisionQueue('1',rows,{query:'ACCOUNT D'});
  assert.deepEqual(found.items.map(r=>r.dealId),['d']);assert.equal(found.summary.totalOpenDeals,4);
});
test('currency-like prefixes and malformed arrays do not become trusted evidence', () => {
  const value=buildManagerDecisionQueue('1',[{...row('a'),deal_currency_code:'USDT',issues_json:'{}',risk_summary_json:'null'}]);
  assert.equal(value.items[0].amount.comparable,false);
});
test('scoped manager collection intersects all dimensions and refuses oversized results', async () => {
  const calls=[]; let sourceRows=[row('a')];
  const env={DB:{prepare(sql){return {bind(...params){return {
    async first(){return {role:'sales_manager',permissions_json:'[]',pipeline_ids_json:'["p1","p2"]',owner_ids_json:'["a","b"]',team_ids_json:'["t"]',region_codes_json:'[]'};},
    async all(){calls.push({sql,params});return {results:sourceRows};}
  };}};}}};
  const identity={portalId:'100',userId:'u',userEmail:null};
  await managerDecisionQueue(env,identity,new URL('https://example.test/queue?limit=10'));
  assert.ok(calls[0].params.includes('p1') && calls[0].params.includes('p2'));
  assert.match(calls[0].sql,/latest.owner_id IN/);assert.match(calls[0].sql,/LIMIT 10001/);
  await assert.rejects(managerDecisionQueue(env,identity,new URL('https://example.test/queue?ownerId=c')), {status:403});
  assert.equal(calls.length,1);
  sourceRows=Array.from({length:10001},(_,i)=>row(String(i)));
  await assert.rejects(managerDecisionQueue(env,identity,new URL('https://example.test/queue')),{code:'decision_queue_capacity_exceeded'});
});
