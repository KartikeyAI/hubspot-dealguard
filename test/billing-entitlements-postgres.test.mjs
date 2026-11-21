import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, databaseUrl } from './helpers/postgres-fixture.mjs';
import { getBillingStatus, setManualSubscription } from '../dist/billing.js';
import { Repository } from '../dist/repository.js';
import { applyManualScheduledPlanChanges, scheduleManualPlanChange } from '../dist/billing-scheduler.js';
import { billingAccessFallback } from '../dist/billing-delivery-status.js';
import { routeEnterpriseApi } from '../dist/enterprise-routes.js';

test('request-time access and allowances expire together while provider records remain unchanged', {skip:!databaseUrl,timeout:30000}, async t => {
  const f=await fixture(t,'entitlement');
  const repository=new Repository(f.env);
  await setManualSubscription(f.env,f.portal,'enterprise',null,{usageMode:'metered',overageEnabled:true});
  await f.first.query(`INSERT INTO billing_allowances(portal_id,metric,included_quantity,hard_limit,overage_enabled,updated_at)
    VALUES($1,'ai_credit',999,9999,1,$2)`,[f.portal,f.at(0)]);
  assert.equal((await getBillingStatus(f.env,f.portal)).entitled,true);
  assert.equal((await repository.getTenant(f.portal)).plan,'beta_growth');
  for (const [status,end,trial,grace,cancel] of [
    ['manual',f.at(0),null,null,0], ['active',f.at(0),null,null,0],
    ['active','invalid',null,null,0], ['active',null,null,null,1],
    ['trialing',null,f.at(0),null,0], ['past_due',null,null,f.at(0),0],
  ]) {
    await f.first.query(`UPDATE subscriptions_v2 SET status=$2,current_period_end=$3,trial_ends_at=$4,grace_ends_at=$5,cancel_at_period_end=$6 WHERE portal_id=$1`,[f.portal,status,end,trial,grace,cancel]);
    const billing=await getBillingStatus(f.env,f.portal);
    assert.equal(billing.entitled,false,status);assert.equal(billing.tier,'enterprise');
    const ai=billing.allowances.find(a=>a.metric==='ai_credit');
    assert.equal(ai.includedQuantity,0);assert.equal(ai.hardLimit,0);assert.equal(ai.overageEnabled,false);
    assert.equal((await repository.getTenant(f.portal)).plan,'free');
    const raw=(await f.first.query(`SELECT t.plan,s.status FROM tenants t JOIN subscriptions_v2 s USING(portal_id) WHERE t.portal_id=$1`,[f.portal])).rows[0];
    assert.equal(raw.plan,'beta_growth');assert.equal(raw.status,status,'read must not rewrite the authoritative provider record');
  }
  await f.first.query(`DELETE FROM subscriptions_v2 WHERE portal_id=$1`,[f.portal]);
  await f.first.query(`UPDATE tenants SET trial_ends_at=$2 WHERE portal_id=$1`,[f.portal,f.at(0)]);
  assert.equal((await repository.getTenant(f.portal)).plan,'free');
  assert.equal((await getBillingStatus(f.env,f.portal)).entitled,false);
});

test('access endpoint declares actual entitlement and expired fallback preserves real scopes for core features', {skip:!databaseUrl,timeout:30000}, async t => {
  const f=await fixture(t,'access-entitlement');
  const identity={portalId:f.portal,userId:'7',userEmail:'scoped@example.test',appId:'fixture'};
  await f.first.query(`INSERT INTO enterprise_role_assignments(id,portal_id,user_id,user_email,role,pipeline_ids_json,created_at,updated_at)
    VALUES($1,$2,'7','scoped@example.test','sales_manager','["selected"]',$3,$3)`,[crypto.randomUUID(),f.portal,f.at(0)]);
  const response=await routeEnterpriseApi(new Request('https://example.test/api/v1/enterprise/access'),f.env,identity,{waitUntil(){}});
  const active=await response.json();assert.equal(active.entitled,true);assert.deepEqual(active.scope.pipelineIds,['selected']);
  await f.first.query(`UPDATE tenants SET trial_ends_at=$2 WHERE portal_id=$1`,[f.portal,f.at(0)]);
  await assert.rejects(routeEnterpriseApi(new Request('https://example.test/api/v1/enterprise/access'),f.env,identity,{waitUntil(){}}),{code:'subscription_required'});
  const expired=await billingAccessFallback(f.env,identity);
  assert.equal(expired.entitled,false);assert.equal(expired.role,'sales_manager');
  assert.ok(expired.permissions.includes('analytics.view'));assert.deepEqual(expired.scope.pipelineIds,['selected']);
});

test('manual scheduled changes retain request-time expiry and are idempotent under PostgreSQL', {skip:!databaseUrl,timeout:30000}, async t => {
  const f=await fixture(t,'schedule-entitlement');
  await setManualSubscription(f.env,f.portal,'enterprise',f.at(0));
  const identity={portalId:f.portal,userId:'7',userEmail:'billing@example.test',appId:'fixture'};
  await scheduleManualPlanChange(f.env,identity,'growth',new Date(Date.now()+3600000).toISOString());
  await f.first.query('UPDATE subscriptions_v2 SET scheduled_change_at=$2 WHERE portal_id=$1',[f.portal,f.at(0)]);
  await applyManualScheduledPlanChanges(f.env);
  await applyManualScheduledPlanChanges(f.env);
  const row=(await f.first.query(`SELECT s.tier,s.scheduled_tier,t.plan,t.commercial_tier FROM subscriptions_v2 s JOIN tenants t USING(portal_id) WHERE s.portal_id=$1`,[f.portal])).rows[0];
  assert.deepEqual(row,{tier:'growth',scheduled_tier:null,plan:'free',commercial_tier:'growth'});
  const audits=(await f.first.query(`SELECT action,COUNT(*)::integer AS count FROM audit_events WHERE portal_id=$1 AND action LIKE 'billing.manual_plan_change_%' GROUP BY action`,[f.portal])).rows;
  assert.deepEqual(Object.fromEntries(audits.map(x=>[x.action,x.count])),{'billing.manual_plan_change_scheduled':1,'billing.manual_plan_change_applied':1});
});

test('a concurrently revised manual contract cannot apply a stale inspected entitlement', {skip:!databaseUrl,timeout:30000}, async t => {
  const f=await fixture(t,'schedule-race');
  await setManualSubscription(f.env,f.portal,'enterprise',null);
  await f.first.query(`UPDATE subscriptions_v2 SET scheduled_tier='growth',scheduled_change_at=$2 WHERE portal_id=$1`,[f.portal,f.at(0)]);
  const intercepted={...f.env,DB:{...f.env.DB,prepare(sql){const stmt=f.env.DB.prepare(sql),all=stmt.all;
    stmt.all=async()=>{const result=await all();if(sql.includes('AS state_hash'))await f.second.query('UPDATE subscriptions_v2 SET current_period_end=$2 WHERE portal_id=$1',[f.portal,f.at(0)]);return result;};return stmt;}}};
  await applyManualScheduledPlanChanges(intercepted);
  let row=(await f.first.query(`SELECT tier,scheduled_tier FROM subscriptions_v2 WHERE portal_id=$1`,[f.portal])).rows[0];
  assert.deepEqual(row,{tier:'enterprise',scheduled_tier:'growth'});
  assert.equal(Number((await f.first.query(`SELECT COUNT(*) AS count FROM audit_events WHERE portal_id=$1 AND action='billing.manual_plan_change_applied'`,[f.portal])).rows[0].count),0);
  await applyManualScheduledPlanChanges(f.env);
  row=(await f.first.query(`SELECT s.tier,t.plan FROM subscriptions_v2 s JOIN tenants t USING(portal_id) WHERE s.portal_id=$1`,[f.portal])).rows[0];
  assert.deepEqual(row,{tier:'growth',plan:'free'});
});

test('scheduler audit failure rolls back the subscription and tenant update', {skip:!databaseUrl,timeout:30000}, async t => {
  const f=await fixture(t,'schedule-rollback');
  await setManualSubscription(f.env,f.portal,'enterprise',null);
  await f.first.query(`UPDATE subscriptions_v2 SET scheduled_tier='growth',scheduled_change_at=$2 WHERE portal_id=$1`,[f.portal,f.at(0)]);
  const name=`reject_schedule_${crypto.randomUUID().replaceAll('-','')}`;
  await f.first.query(`CREATE FUNCTION dealguard.${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.portal_id=TG_ARGV[0] AND NEW.action='billing.manual_plan_change_applied' THEN RAISE EXCEPTION 'fixture audit unavailable'; END IF; RETURN NEW; END $$`);
  await f.first.query(`CREATE TRIGGER ${name} BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION dealguard.${name}('${f.portal}')`);
  try {
    await assert.rejects(applyManualScheduledPlanChanges(f.env),/fixture audit unavailable/);
    const row=(await f.first.query(`SELECT s.tier,s.scheduled_tier,t.plan,t.commercial_tier FROM subscriptions_v2 s JOIN tenants t USING(portal_id) WHERE s.portal_id=$1`,[f.portal])).rows[0];
    assert.deepEqual(row,{tier:'enterprise',scheduled_tier:'growth',plan:'beta_growth',commercial_tier:'enterprise'});
  } finally {
    await f.first.query(`DROP TRIGGER ${name} ON audit_events`);
    await f.first.query(`DROP FUNCTION dealguard.${name}()`);
  }
});
