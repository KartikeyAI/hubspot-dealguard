import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, databaseUrl } from './helpers/postgres-fixture.mjs';
import { recordUsageAtomic, retryAtomicUsageReports } from '../dist/billing-usage.js';
import { getBillingStatus, setManualSubscription } from '../dist/billing.js';
import { processDodoWebhookOrdered } from '../dist/dodo-webhook.js';

const latch = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const pause = ms => new Promise(r => setTimeout(r, ms));
function intercept(env, hook) {
  return { ...env, DB: { ...env.DB, prepare(sql) {
    const original = env.DB.prepare(sql);
    const wrapped = {
      bind(...values) { original.bind(...values); return wrapped; },
      async first(...args) { const result = await original.first(...args); await hook(sql, result, 'first'); return result; },
      async all(...args) { const result = await original.all(...args); await hook(sql, result, 'all'); return result; },
      async run(...args) { const result = await original.run(...args); await hook(sql, result, 'run'); return result; },
    };
    return wrapped;
  } } };
}

test('commercial usage uses serialized PostgreSQL caps and semantic idempotency', { skip: !databaseUrl, timeout: 30000 }, async t => {
  const f = await fixture(t, 'billing-usage');
  async function setup(mode = 'capped', overage = false, included = 10, hard = 20) {
    await f.first.query('DELETE FROM billing_usage_events WHERE portal_id=$1', [f.portal]);
    await f.first.query('DELETE FROM billing_usage_counters WHERE portal_id=$1', [f.portal]);
    await setManualSubscription(f.env, f.portal, 'growth', null, { usageMode: mode, overageEnabled: overage });
    for (const metric of ['event_overage','active_deal_overage','retention_gb_month']) {
      await f.first.query(`INSERT INTO billing_allowances(portal_id,metric,included_quantity,hard_limit,overage_enabled,updated_at)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(portal_id,metric) DO UPDATE SET
        included_quantity=excluded.included_quantity,hard_limit=excluded.hard_limit,overage_enabled=excluded.overage_enabled`,
      [f.portal,metric,included,hard,Number(overage),f.at(0)]);
    }
  }
  await t.test('concurrent requests cannot overspend an already initialized sum counter', async () => {
    await setup();
    await recordUsageAtomic(f.env, f.portal, 'event_overage', 0, 'initialize');
    const inserted = latch(), release = latch(); let held = false;
    const slow = intercept(f.env, async (sql, result, method) => {
      if (!held && method === 'run' && /INSERT INTO billing_usage_events/.test(sql) && result.meta?.changes) {
        held = true; inserted.resolve(); await release.promise;
      }
    });
    const a = recordUsageAtomic(slow, f.portal, 'event_overage', 7, 'sum-first');
    await inserted.promise;
    let finished = false;
    const b = recordUsageAtomic(f.envFor(f.second), f.portal, 'event_overage', 7, 'sum-second')
      .then(v => ({value:v}), error => ({error})).finally(() => { finished = true; });
    try { await pause(80); assert.equal(finished, false, 'second transaction must wait on the counter'); }
    finally { release.resolve(); }
    assert.equal((await a).recorded, true);
    assert.equal((await b).error?.code, 'usage_limit_reached');
    assert.equal(Number((await f.first.query('SELECT consumed_quantity FROM billing_usage_counters WHERE portal_id=$1', [f.portal])).rows[0].consumed_quantity), 7);
  });
  await t.test('simultaneous first-ever reservations also respect the cap', async () => {
    await setup();
    const results = await Promise.allSettled([recordUsageAtomic(f.env,f.portal,'event_overage',8,'first-a'),
      recordUsageAtomic(f.envFor(f.second),f.portal,'event_overage',8,'first-b')]);
    assert.equal(results.filter(r => r.status==='fulfilled').length, 1);
    assert.equal(results.find(r => r.status==='rejected').reason.code, 'usage_limit_reached');
  });
  await t.test('concurrent gauge reports retain one high-water total and exact deltas', async () => {
    await setup('capped',false,100,100);
    await Promise.all([recordUsageAtomic(f.env,f.portal,'active_deal_overage',8,'gauge-a'),
      recordUsageAtomic(f.envFor(f.second),f.portal,'active_deal_overage',10,'gauge-b')]);
    const r=(await f.first.query(`SELECT SUM(quantity) AS quantity FROM billing_usage_events WHERE portal_id=$1`,[f.portal])).rows[0];
    assert.equal(Number(r.quantity),10);
    assert.equal((await getBillingStatus(f.env,f.portal)).allowances.find(a=>a.metric==='active_deal_overage').consumedQuantity,10);
  });
  await t.test('same request replay never increments a counter twice', async () => {
    await setup();
    assert.equal((await recordUsageAtomic(f.env,f.portal,'event_overage',3,'same')).recorded,true);
    assert.equal((await recordUsageAtomic(f.env,f.portal,'event_overage',3,'same')).recorded,false);
    assert.equal(Number((await f.first.query('SELECT consumed_quantity FROM billing_usage_counters WHERE portal_id=$1',[f.portal])).rows[0].consumed_quantity),3);
  });
  await t.test('reusing a key for a changed quantity or metric is an explicit conflict', async () => {
    await setup(); await recordUsageAtomic(f.env,f.portal,'event_overage',3,'conflict');
    await assert.rejects(recordUsageAtomic(f.env,f.portal,'event_overage',4,'conflict'),{code:'usage_idempotency_conflict'});
    await assert.rejects(recordUsageAtomic(f.env,f.portal,'active_deal_overage',3,'conflict'),{code:'usage_idempotency_conflict'});
  });
  await t.test('different tenants can use the same request key', async () => {
    await setup();
    const a=await recordUsageAtomic(f.env,f.portal,'event_overage',1,'shared');
    const b=await recordUsageAtomic(f.env,f.other,'event_overage',1,'shared');
    assert.equal(a.recorded&&b.recorded,true);
  });
  await t.test('overage consent does not bypass an explicit hard maximum', async () => {
    await setup('metered',true,10,20);
    await recordUsageAtomic(f.env,f.portal,'event_overage',15,'above-included');
    await assert.rejects(recordUsageAtomic(f.env,f.portal,'event_overage',6,'above-hard'),{code:'usage_limit_reached'});
  });
  await t.test('capped usage stops at the included quantity without overage consent', async () => {
    await setup('capped',false,10,20);
    await assert.rejects(recordUsageAtomic(f.env,f.portal,'event_overage',11,'not-consented'),{code:'usage_limit_reached'});
  });
  await t.test('fractional gauge values preserve their measured high-water value', async () => {
    await setup('capped',false,1,1);
    await recordUsageAtomic(f.env,f.portal,'retention_gb_month',0.25,'quarter');
    await recordUsageAtomic(f.env,f.portal,'retention_gb_month',0.5,'half');
    await recordUsageAtomic(f.env,f.portal,'retention_gb_month',0.25,'quarter-again');
    assert.equal((await getBillingStatus(f.env,f.portal)).allowances.find(a=>a.metric==='retention_gb_month').consumedQuantity,0.5);
  });
  await t.test('late transaction failure rolls back both event and counter', async () => {
    await setup();
    const broken = intercept(f.env, async (sql, _result, method) => {
      if (method==='run' && /consumed_quantity = billing_usage_counters/.test(sql)) throw new Error('injected local rollback');
    });
    await assert.rejects(recordUsageAtomic(broken,f.portal,'event_overage',3,'rollback'),/injected local rollback/);
    assert.equal(Number((await f.first.query('SELECT COUNT(*) n FROM billing_usage_events WHERE portal_id=$1',[f.portal])).rows[0].n),0);
    assert.equal(Number((await f.first.query('SELECT COUNT(*) n FROM billing_usage_counters WHERE portal_id=$1',[f.portal])).rows[0].n),0);
  });
  await t.test('oversized keys and invalid metrics fail rather than truncate or coerce', async () => {
    await assert.rejects(recordUsageAtomic(f.env,f.portal,'event_overage',1,'x'.repeat(256)),{code:'usage_idempotency_required'});
    await assert.rejects(recordUsageAtomic(f.env,f.portal,'unknown',1,'unknown'),{code:'usage_metric_invalid'});
    for(const q of [-1,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]) await assert.rejects(recordUsageAtomic(f.env,f.portal,'event_overage',q,'bad'),{code:'usage_quantity_invalid'});
  });
  await t.test('new events persist a nontruncated provider ID before sending anything', async () => {
    await setup(); await recordUsageAtomic(f.env,f.portal,'event_overage',1,'x'.repeat(255));
    const row=(await f.first.query('SELECT id,provider_event_id FROM billing_usage_events WHERE portal_id=$1',[f.portal])).rows[0];
    assert.equal(row.provider_event_id,`dg_usage_${row.id}`);
  });
});

test('Dodo subscription processing serializes accepted state and rejects unsafe correlation', {skip:!databaseUrl,timeout:30000}, async t=>{
  const events=[]; let f;
  t.after(async()=>{ await f.first.query("DELETE FROM billing_events WHERE provider='dodo' AND provider_event_id=ANY($1::text[])",[events]); });
  f=await fixture(t,'billing-hooks');
  const numeric=String(BigInt(Date.now())*10000n+BigInt(Math.floor(Math.random()*10000)));
  await f.first.query('UPDATE tenants SET portal_id=$1 WHERE portal_id=$2',[numeric,f.portal]);
  f.portalIds[0]=numeric; f.portal=numeric;
  const cfg={ DODO_GROWTH_MONTHLY_PRODUCT_ID:'growth-month',DODO_GROWTH_YEARLY_PRODUCT_ID:'growth-year',
    DODO_ENTERPRISE_MONTHLY_PRODUCT_ID:'enterprise-month',DODO_ENTERPRISE_YEARLY_PRODUCT_ID:'enterprise-year' };
  const env={...f.env,...cfg};
  const body=(stamp=f.at(20),status='active',extra={})=>JSON.stringify({type:'subscription.updated',timestamp:stamp,data:{
    subscription_id:`sub-${f.portal}`,customer:{customer_id:`cust-${f.portal}`},product_id:'growth-month',status,
    previous_billing_date:f.at(0),next_billing_date:new Date(Date.now()+86400000).toISOString(),metadata:{portal_id:f.portal},...extra}});
  const eventId=()=>{const id=crypto.randomUUID();events.push(id);return id;};
  const send=(raw,instance=env,id=eventId())=>processDodoWebhookOrdered(instance,raw,id);
  const reset=()=>f.first.query('DELETE FROM subscriptions_v2 WHERE portal_id=$1',[f.portal]);
  const state=async()=> (await f.first.query('SELECT * FROM subscriptions_v2 WHERE portal_id=$1',[f.portal])).rows[0];
  await t.test('all four configured products, not metadata tier/interval, determine entitlement',async()=>{
    for(const [product,tier,interval] of [['growth-month','growth','month'],['growth-year','growth','year'],
      ['enterprise-month','enterprise','month'],['enterprise-year','enterprise','year']]){
      await reset();await send(body(f.at(20),'active',{product_id:product,metadata:{portal_id:f.portal,tier:'free',interval:'month'}}));
      assert.equal((await state()).tier,tier);assert.equal((await state()).billing_interval,interval);
    }
  });
  await t.test('duplicate delivery commits exactly one subscription audit',async()=>{
    await reset();const id=eventId(),raw=body();
    await Promise.all([send(raw,env,id),send(raw,{...f.envFor(f.second),...cfg},id)]);
    const count=(await f.first.query(`SELECT COUNT(*) n FROM audit_events WHERE portal_id=$1 AND metadata_json::jsonb->>'webhookId'=$2`,[f.portal,id])).rows[0];
    assert.equal(Number(count.n),1);
    assert.equal((await state()).last_provider_event_id,id);
  });
  await t.test('a stale preread cannot reactivate a concurrently cancelled subscription',async()=>{
    await reset();await send(body(f.at(10)));
    const read=latch(),release=latch();let paused=false;
    const slow=intercept(env,async(sql,_result,method)=>{
      if(!paused && method==='first' && /AS state_token/.test(sql)){paused=true;read.resolve();await release.promise;}
    });
    const oldId=eventId(),old=send(body(f.at(15),'active'),slow,oldId);
    await read.promise;
    try { await send(body(f.at(30),'cancelled'),{...f.envFor(f.second),...cfg}); }
    finally { release.resolve(); }
    await old;
    assert.equal((await state()).status,'cancelled');
    assert.equal((await f.first.query('SELECT plan FROM tenants WHERE portal_id=$1',[f.portal])).rows[0].plan,'free');
    assert.equal((await f.first.query('SELECT status FROM billing_events WHERE provider_event_id=$1',[oldId])).rows[0].status,'ignored');
  });
  await t.test('newer events retry the current snapshot instead of losing concurrent changes',async()=>{
    await reset();await send(body(f.at(10)));
    const read=latch(),release=latch();let paused=false;
    const slow=intercept(env,async(sql,_result,method)=>{if(!paused&&method==='first'&&/AS state_token/.test(sql)){paused=true;read.resolve();await release.promise;}});
    const latest=send(body(f.at(40),'active',{product_id:'enterprise-year'}),slow);
    await read.promise;
    try { await send(body(f.at(30),'on_hold'),{...f.envFor(f.second),...cfg}); } finally { release.resolve(); }
    await latest;assert.equal((await state()).tier,'enterprise');assert.equal((await state()).status,'active');
  });
  await t.test('failure after tenant update rolls back subscription, entitlement and success audit together',async()=>{
    await reset();await send(body(f.at(10)));
    const before=await state(),id=eventId();
    const broken=intercept(env,async(sql,_result,method)=>{if(method==='run' && /INSERT INTO audit_events/.test(sql)) throw new Error('injected local audit failure');});
    await assert.rejects(send(body(f.at(30),'cancelled'),broken,id),/injected local audit failure/);
    assert.deepEqual(await state(),before);
    assert.equal((await f.first.query('SELECT plan FROM tenants WHERE portal_id=$1',[f.portal])).rows[0].plan,'growth');
    assert.equal(Number((await f.first.query(`SELECT COUNT(*) n FROM audit_events WHERE portal_id=$1 AND metadata_json::jsonb->>'webhookId'=$2`,[f.portal,id])).rows[0].n),0);
    await send(body(f.at(30),'cancelled'),env,id);assert.equal((await state()).status,'cancelled');
  });
  await t.test('repeated delinquency cannot extend an expired grace period',async()=>{
    await reset();const start=new Date(Date.now()-10*86400000).toISOString();
    await send(body(start,'on_hold'));const grace=(await state()).grace_ends_at;
    await send(body(f.at(40),'on_hold'));assert.equal((await state()).grace_ends_at,grace);
    assert.equal((await f.first.query('SELECT plan FROM tenants WHERE portal_id=$1',[f.portal])).rows[0].plan,'free');
  });
  await t.test('a genuine recovery then a new delinquency starts a new observed clock',async()=>{
    await reset();await send(body(f.at(10),'on_hold'));const old=(await state()).grace_ends_at;
    await send(body(f.at(20),'active'));await send(body(f.at(30),'on_hold'));
    assert.ok(Date.parse((await state()).grace_ends_at)>Date.parse(old));
  });
  await t.test('conflicting metadata cannot move a subscription to a different tenant',async()=>{
    await reset();await send(body());
    await assert.rejects(send(body(f.at(30),'active',{metadata:{portal_id:'99999999999999'}})),{code:'billing_identity_conflict'});
    assert.equal((await state()).tier,'growth');
  });
  await t.test('a different subscription cannot cancel the active binding',async()=>{
    await reset();await send(body());
    await send(body(f.at(30),'cancelled',{subscription_id:'old-unrelated-subscription'}));
    assert.equal((await state()).status,'active');
  });
  await t.test('a newer resubscription cannot inherit the previous cancelled period or overage',async()=>{
    await reset();await send(body(f.at(10),'cancelled',{cancel_at_period_end:true,
      trial_ends_at:f.at(0),metadata:{portal_id:f.portal,usage_mode:'metered',overage_enabled:'true'}}));
    const raw=JSON.parse(body(f.at(30),'active',{subscription_id:'new-'+f.portal}));
    delete raw.data.previous_billing_date;delete raw.data.next_billing_date;
    await send(JSON.stringify(raw));const row=await state();
    assert.equal(row.provider_subscription_id,'new-'+f.portal);assert.equal(row.cancel_at_period_end,0);
    assert.equal(row.current_period_start,null);assert.equal(row.current_period_end,null);
    assert.equal(row.trial_ends_at,null);assert.equal(row.usage_mode,'capped');assert.equal(row.overage_enabled,0);
  });
  await t.test('an unknown product cannot acquire Enterprise through metadata',async()=>{
    await reset();await assert.rejects(send(body(f.at(20),'active',{product_id:'unmapped',metadata:{portal_id:f.portal,tier:'enterprise'}})),{code:'billing_product_unmapped'});
    assert.equal(await state(),undefined);
  });
  await t.test('a provider webhook does not overwrite a manual contract',async()=>{
    await reset();await setManualSubscription(env,f.portal,'enterprise',null);await send(body());
    assert.equal((await state()).provider,'manual');assert.equal((await state()).tier,'enterprise');
  });
  await t.test('payment events and unknown subscription events cannot change the plan',async()=>{
    await reset();await send(body());
    for(const type of ['payment.failed','subscription.unknown_future_event']){const raw=JSON.parse(body(f.at(30),'cancelled'));raw.type=type;await send(JSON.stringify(raw));}
    assert.equal((await state()).status,'active');
  });
  await t.test('invalid envelope and future source clocks are rejected',async()=>{
    for(const raw of ['null','[]','{bad',body(new Date(Date.now()+3600000).toISOString())]) await assert.rejects(send(raw));
  });
});


test('usage provider transport preserves durable identity and numeric aggregation', {skip:!databaseUrl,timeout:30000},async t=>{
  const f=await fixture(t,'billing-transport');
  const env={...f.env,DODO_ENVIRONMENT:'test',DODO_API_KEY:'fixture-only-not-a-secret',
    DODO_EVENT_OVERAGE_EVENT_NAME:'fixture_event',DODO_ACTIVE_DEAL_EVENT_NAME:'fixture_gauge'};
  async function setup(){
    await f.first.query('DELETE FROM billing_usage_events WHERE portal_id=$1',[f.portal]);
    await f.first.query('DELETE FROM billing_usage_counters WHERE portal_id=$1',[f.portal]);
    await setManualSubscription(env,f.portal,'enterprise',null,{usageMode:'metered',overageEnabled:true});
    await f.first.query("UPDATE subscriptions_v2 SET provider='dodo',provider_customer_id=$2,provider_subscription_id=$3 WHERE portal_id=$1",
      [f.portal,'customer-'+f.portal,'subscription-'+f.portal]);
  }
  const read=async()=> (await f.first.query('SELECT * FROM billing_usage_events WHERE portal_id=$1 ORDER BY created_at,id',[f.portal])).rows;
  function mock(t,handler){t.mock.method(globalThis,'fetch',async(url,init)=>{
    assert.equal(url,'https://test.dodopayments.com/events/ingest');
    assert.equal(init.method,'POST');assert.equal(init.redirect,'error');assert.ok(init.signal instanceof AbortSignal);
    return handler(JSON.parse(init.body).events[0]);
  });}
  await t.test('sum and gauge requests carry numeric, reserved metadata',async t=>{
    await setup();const requests=[];
    mock(t,event=>{requests.push(event);return Response.json({ingested_count:1});});
    assert.deepEqual(await recordUsageAtomic(env,f.portal,'event_overage',4,'sum',{portal_id:'not-the-tenant',quantity:999,measured:2.5}),{recorded:true,reported:true});
    await recordUsageAtomic(env,f.portal,'active_deal_overage',8,'gauge-high');
    await recordUsageAtomic(env,f.portal,'active_deal_overage',5,'gauge-lower');
    assert.deepEqual(requests.map(e=>e.metadata.quantity),[4,8,5]);
    assert.equal(requests[0].metadata.portal_id,f.portal);assert.equal(requests[0].metadata.measured,2.5);
    assert.ok(requests.every(e=>e.event_id.startsWith('dg_usage_')&&e.customer_id==='customer-'+f.portal));
    assert.ok((await read()).every(r=>r.status==='reported'));
    assert.equal((await getBillingStatus(env,f.portal)).allowances.find(a=>a.metric==='active_deal_overage').consumedQuantity,8);
  });
  await t.test('a failed provider request and its retry keep exactly the same event identity and clock',async t=>{
    await setup();const requests=[];
    mock(t,event=>{requests.push(event);return requests.length===1?new Response('fixture unavailable',{status:503}):Response.json({ingested_count:1});});
    await assert.rejects(recordUsageAtomic(env,f.portal,'event_overage',3,'x'.repeat(255)),{code:'dodo_usage_report_failed'});
    assert.equal((await read())[0].status,'pending');
    await retryAtomicUsageReports(env);
    assert.equal(requests.length,2);assert.deepEqual(requests[1],requests[0]);
    assert.equal((await read())[0].status,'reported');
    assert.equal(Number((await f.first.query('SELECT consumed_quantity FROM billing_usage_counters WHERE portal_id=$1',[f.portal])).rows[0].consumed_quantity),3);
  });
  await t.test('separate long idempotency keys cannot collide at the provider',async t=>{
    await setup();const ids=[];mock(t,event=>{ids.push(event.event_id);return Response.json({ingested_count:1});});
    for(const tail of ['a','b'])await recordUsageAtomic(env,f.portal,'event_overage',1,'x'.repeat(254)+tail);
    assert.equal(new Set(ids).size,2);
  });
  await t.test('an unacknowledged response does not mark usage reported',async t=>{
    await setup();mock(t,()=>Response.json({ingested_count:0}));
    await assert.rejects(recordUsageAtomic(env,f.portal,'event_overage',1,'unacknowledged'),{code:'dodo_usage_not_ingested'});
    assert.equal((await read())[0].status,'pending');
  });
  await t.test('expired subscription cannot send pending usage to the provider',async t=>{
    await setup();mock(t,()=>new Response('',{status:503}));
    await assert.rejects(recordUsageAtomic(env,f.portal,'event_overage',1,'expired'));
    await f.first.query("UPDATE subscriptions_v2 SET status='expired' WHERE portal_id=$1",[f.portal]);
    const spy=globalThis.fetch.mock;const before=spy.callCount();await retryAtomicUsageReports(env);
    assert.equal(spy.callCount(),before);assert.equal((await read())[0].status,'pending');
  });
});
