import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { backgroundSettings, backgroundReadAllowed, backgroundBudgetQuery, backgroundRequestPolicy } from '../dist/background-intelligence.js';
import { HubSpotClient } from '../dist/hubspot.js';

const settings={portal_id:'100',version:1,enabled:1,refresh_hours:24,daily_request_limit:100};
const db=()=>({DB:{prepare(){return {bind(){return {async first(){return {request_count:1};}};}};}}});
test('background settings require explicit bounded values and reject ignored fields',()=>{
  assert.deepEqual(backgroundSettings({enabled:false,refreshHours:24,dailyRequestLimit:1000}),{enabled:false,refreshHours:24,dailyRequestLimit:1000});
  for(const value of [null,{},[],{enabled:'true',refreshHours:24,dailyRequestLimit:1000},
    {enabled:true,refreshHours:0,dailyRequestLimit:1000},{enabled:true,refreshHours:24,dailyRequestLimit:99},
    {enabled:true,refreshHours:24,dailyRequestLimit:10001},{enabled:true,refreshHours:24,dailyRequestLimit:1000,unexpected:true}])
    assert.throws(()=>backgroundSettings(value),{status:400});
});
test('background request allowlist permits read/search but blocks writes and external targets',()=>{
  for(const [path,method] of [['/crm/v3/objects/deals/1?properties=amount','GET'],['/crm/objects/2026-03/emails/search','POST'],
    ['/crm/associations/2026-03/deals/contacts/batch/read','POST'],['/oauth/v1/token','POST']]) assert.equal(backgroundReadAllowed(path,method),true);
  for(const [path,method] of [['/crm/v3/objects/deals/1','PATCH'],['/crm/v3/objects/tasks','POST'],
    ['/crm/v3/objects/deals/batch/update','POST'],['https://example.test','GET'],['/crm/v3/objects/../deals','GET'],['/oauth/v1/token','GET']])
    assert.equal(backgroundReadAllowed(path,method),false);
});
test('request reservation SQL is tenant/version/lease bound and atomic under conflict',()=>{
  const {sql,params}=backgroundBudgetQuery('tenant-value',2,'lease-value');
  assert.ok(!sql.includes('tenant-value')&&!sql.includes('lease-value'));
  assert.deepEqual(params,['tenant-value',2,'lease-value','tenant-value']);
  assert.match(sql,/ON CONFLICT/);assert.match(sql,/request_count < \(SELECT daily_request_limit/);
  assert.match(sql,/s.enabled = 1/);assert.match(sql,/t.status = 'active'/);
});
test('budget denial is terminal for a job even if an optional loader catches the error',async()=>{
  const env={DB:{prepare(){return {bind(){return {async first(){return null;}};}};}}};
  const guard=backgroundRequestPolicy(env,settings,'lease');
  await assert.rejects(guard.policy.beforeRequest('/crm/v3/objects/deals/1','GET'),{code:'background_cancelled'});
  assert.throws(()=>guard.assertHealthy(),{code:'background_cancelled'});
  await assert.rejects(guard.policy.beforeRequest('/crm/v3/objects/deals/2','GET'));
});
test('provider throttling and authorization failures stop further requests',async()=>{
  for(const status of [401,429]) {
    const guard=backgroundRequestPolicy(db(),settings,'lease');guard.policy.afterResponse(status);
    assert.throws(()=>guard.assertHealthy());
    await assert.rejects(guard.policy.beforeRequest('/crm/v3/objects/deals/1','GET'));
  }
});
test('expired job deadlines and write attempts fail before network admission',async()=>{
  const guard=backgroundRequestPolicy(db(),settings,'lease',Date.now()-61000);
  await assert.rejects(guard.policy.beforeRequest('/crm/v3/objects/deals/1','GET'),{code:'background_request_limit'});
  const blocked=backgroundRequestPolicy(db(),settings,'lease');
  await assert.rejects(blocked.policy.beforeRequest('/crm/v3/objects/deals/1','DELETE'),{code:'background_write_blocked'});
});
test('real HubSpot client invokes request policy and uses abort/redirect boundaries',async t=>{
  const original=globalThis.fetch; t.after(()=>{globalThis.fetch=original;});
  let admissions=0,calls=0;
  const policy={deadlineAt:Date.now()+10000,disableAuthRetry:true,async beforeRequest(){admissions++;}};
  const client=new HubSpotClient({}, {tenant:{portal_id:'100',token_expires_at:new Date(Date.now()+3600000).toISOString()},accessToken:'fixture-only'},policy);
  globalThis.fetch=async(url,init)=>{calls++;assert.ok(init.signal);assert.equal(init.redirect,'error');return new Response('{"results":[]}',{status:200});};
  assert.deepEqual(await client.getPipelines(),[]);assert.equal(admissions,1);assert.equal(calls,1);
  policy.beforeRequest=async()=>{throw new Error('blocked');};
  await assert.rejects(client.getPipelines(),/blocked/);assert.equal(calls,1);
});
test('background job code does not call notification, CRM write or billable event orchestration',()=>{
  const source=readFileSync('worker/src/background-intelligence.ts','utf8');
  for(const name of ['notifyAssessmentTransition','syncAssessmentIfEnabled','syncAssessmentRemediations','recordUsageAtomic','assessDealForPortal(']) assert.ok(!source.includes(name));
  assert.match(source,/buildBackgroundAssessmentEvidence/);assert.match(source,/persistDecisionSnapshot/);
  assert.match(source,/status = 'cancelled'/);assert.match(source,/lease_token = \?/);
});
