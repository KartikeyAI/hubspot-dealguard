import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { billingAccessFallback, billingDeliveryStatus, requireBillingManagement } from '../dist/billing-delivery-status.js';
import { route } from '../dist/routes-v17.js';
import { fixture, databaseUrl } from './helpers/postgres-fixture.mjs';

const uiSource = readFileSync(new URL('../src/app/pages/product-ui.ts', import.meta.url), 'utf8');
const uiCode = ts.transpileModule(uiSource, { compilerOptions: { module: ts.ModuleKind.ES2022 } }).outputText;
const { billingManagementAvailable } = await import(`data:text/javascript;base64,${Buffer.from(uiCode).toString('base64')}`);
const emptyScope = () => ({ pipelineIds: [], ownerIds: [], teamIds: [], regionCodes: [] });

test('billing UI requires a known portal-wide management permission', () => {
  for (const permission of ['*', 'billing.*', 'billing.manage']) assert.equal(billingManagementAvailable({ permissions: [permission], scope: emptyScope() }), true);
  for (const value of [null, {}, {permissions:['billing.view'],scope:emptyScope()}, {permissions:['*']}, {permissions:['*'],scope:{}}]) {
    assert.equal(billingManagementAvailable(value), false);
  }
  for (const field of Object.keys(emptyScope())) {
    for (const value of [['scoped'], null, '[]']) {
      assert.equal(billingManagementAvailable({ permissions: ['*'], scope: {...emptyScope(), [field]: value} }), false);
    }
  }
});
test('delivery endpoint is read-only and unsigned requests never reach the database', async () => {
  const env = { HUBSPOT_CLIENT_SECRET: 'synthetic-only', DB: { prepare() { throw new Error('unauthorized database access'); } } };
  for (const method of ['POST','PUT','DELETE']) assert.equal((await route(new Request('https://example.test/api/v1/billing/delivery',{method}),env,{})).status,405);
  await assert.rejects(route(new Request('https://example.test/api/v1/billing/delivery'), env, {}), error => [401,403].includes(error.status));
});
test('active App Home offers both checkout intervals and guarded read-only delivery controls', () => {
  const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  assert.match(read('src/app/pages/EnterpriseHomeV3.tsx'), /import '\.\/EnterpriseHomeV4'/);
  const home = read('src/app/pages/EnterpriseHomeV4.tsx');
  assert.match(home, /<BillingDeliveryPanel enabled=\{canManageBilling\}/);
  assert.match(home, /label: 'Monthly', value: 'month'/); assert.match(home, /label: 'Annually', value: 'year'/);
  assert.match(home, /interval: checkoutInterval/);
  assert.match(read('src/app/pages/BillingDeliveryPanel.tsx'), /method: 'GET'/);
  assert.match(read('src/app/pages/BillingDeliveryPanel.tsx'), /current === generation.current/);
  assert.equal((read('worker/src/routes-v2.ts').match(/await requireBillingManagement\(env, identity\)/g) ?? []).length, 2);
});

test('billing delivery diagnostics enforce real PostgreSQL tenant and role boundaries', {skip:!databaseUrl,timeout:30000},async t=>{
  const f = await fixture(t,'billing-status');
  const identity = { portalId: f.portal, userId: '7', userEmail: 'billing@example.test', appId: 'fixture' };
  await f.first.query(`INSERT INTO enterprise_role_assignments(id,portal_id,user_id,user_email,role,created_at,updated_at)
    VALUES($1,$2,'7','billing@example.test','billing_administrator',$3,$3)`,[crypto.randomUUID(),f.portal,f.at(0)]);
  async function seed(portal,status,reason=null) {
    const id=crypto.randomUUID();
    await f.first.query(`INSERT INTO billing_usage_events(id,portal_id,event_name,quantity,idempotency_key,status,metadata_json,occurred_at,created_at,error_message,provider_event_id)
      VALUES($1,$2,'event_overage',1,$1,$3,'{}',$4,$4,$5,'provider-private-identity')`,[id,portal,status,f.at(0),reason]);
  }
  await t.test('returns retained counts but never raw payloads or another portal',async()=>{
    await seed(f.portal,'pending');await seed(f.portal,'failed','usage_delivery_target_changed');
    await seed(f.portal,'failed','Bearer private-provider-message');await seed(f.portal,'ignored');await seed(f.portal,'reported');
    await seed(f.other,'reported');
    const data=await billingDeliveryStatus(f.env,identity);
    assert.equal(data.readOnly,true);assert.equal(data.coverage,'retained_events');
    assert.equal(data.outcomes.reduce((sum,r)=>sum+r.events,0),5);
    assert.ok(data.outcomes.some(r=>r.reason==='legacy_delivery_error'));
    assert.ok(data.outcomes.some(r=>r.reason==='usage_delivery_target_changed'));
    assert.doesNotMatch(JSON.stringify(data),/private-provider-message|provider-private-identity|metadata_json/);
  });
  await t.test('an expired plan does not hide billing diagnostics from an authorized administrator',async()=>{
    await f.first.query("UPDATE tenants SET commercial_tier='free',trial_ends_at=NULL WHERE portal_id=$1",[f.portal]);
    assert.equal((await billingDeliveryStatus(f.env,identity)).outcomes.reduce((sum,r)=>sum+r.events,0),5);
    assert.equal(billingManagementAvailable(await billingAccessFallback(f.env,identity)),true);
  });
  await t.test('a viewer cannot retrieve portal-wide billing diagnostics',async()=>{
    await f.first.query("UPDATE enterprise_role_assignments SET role='viewer' WHERE portal_id=$1",[f.portal]);
    await assert.rejects(billingDeliveryStatus(f.env,identity),{code:'enterprise_permission_denied'});
    await f.first.query("UPDATE enterprise_role_assignments SET role='billing_administrator' WHERE portal_id=$1",[f.portal]);
  });
  await t.test('all four record-scope restrictions also restrict billing administration',async()=>{
    for(const column of ['pipeline_ids_json','owner_ids_json','team_ids_json','region_codes_json']) {
      await f.first.query(`UPDATE enterprise_role_assignments SET ${column}='["restricted"]' WHERE portal_id=$1`,[f.portal]);
      await assert.rejects(requireBillingManagement(f.env,identity),{code:'enterprise_scope_denied'});
      assert.equal(billingManagementAvailable(await billingAccessFallback(f.env,identity)),false);
      await f.first.query(`UPDATE enterprise_role_assignments SET ${column}='[]' WHERE portal_id=$1`,[f.portal]);
    }
  });
  await t.test('inactive installations and unidentified callers cannot access billing controls',async()=>{
    await assert.rejects(billingDeliveryStatus(f.env,{portalId:f.portal}),{code:'billing_user_required'});
    await f.first.query("UPDATE tenants SET status='disconnected' WHERE portal_id=$1",[f.portal]);
    await assert.rejects(billingDeliveryStatus(f.env,identity),{code:'installation_inactive'});
    await f.first.query("UPDATE tenants SET status='active' WHERE portal_id=$1",[f.portal]);
  });
  await t.test('permission revocation during query prevents returning the response',async()=>{
    const wrapped={...f.env,DB:{...f.env.DB,prepare(sql){const statement=f.env.DB.prepare(sql);const raw=statement.all;
      statement.all=async()=>{const result=await raw();if(sql.includes('FROM billing_usage_events'))await f.second.query("UPDATE enterprise_role_assignments SET role='viewer' WHERE portal_id=$1",[f.portal]);return result;};return statement;}}};
    await assert.rejects(billingDeliveryStatus(wrapped,identity),{code:'enterprise_permission_denied'});
  });
});
