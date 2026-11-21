import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, databaseUrl } from './helpers/postgres-fixture.mjs';
import { dashboardForIdentity } from '../dist/dashboard-access.js';
import { onboardingStatus } from '../dist/onboarding.js';
import { REQUIRED_HUBSPOT_SCOPES } from '../dist/config.js';
import { aiAdministration } from '../dist/ai-assistance.js';
import { breezeAdministration } from '../dist/breeze-tools.js';
import { changeIntelligenceConsent } from '../dist/intelligence-consent.js';
const url = value => new URL('https://example.test/api/v1/dashboard'+(value?'?'+value:''));
async function setup(t) {
 const f=await fixture(t,'dashboard-onboarding');const actor={portalId:f.portal,userId:'7',userEmail:'private-admin@example.test',appId:'fixture'};
 await f.first.query("INSERT INTO enterprise_role_assignments(id,portal_id,user_id,role,created_at,updated_at)VALUES($1,$2,'7','administrator',$3,$3)",[randomUUID(),f.portal,f.at(0)]);
 await f.first.query('UPDATE tenants SET scopes_json=$2 WHERE portal_id=$1',[f.portal,JSON.stringify(REQUIRED_HUBSPOT_SCOPES)]);
 const add=async(deal,owner='1',pipeline='p1',extra={})=>{
   const r={portal:f.portal,closed:0,won:0,score:50,time:f.at(1),issue:'visible_gap',...extra};
   await f.first.query(`INSERT INTO deal_assessments(portal_id,deal_id,deal_name,pipeline_label,stage_label,score,grade,status,issues_json,readiness_summary,is_closed,is_won,assessed_at)
    VALUES($1,$2,$2,'Pipeline','Stage',$3,'D','at_risk',$4,'Review recorded evidence',$5,$6,$7)`,[r.portal,deal,r.score,JSON.stringify([{code:r.issue,label:r.issue},{code:r.issue,label:r.issue}]),r.closed,r.won,r.time]);
   await f.first.query(`INSERT INTO assessment_context(portal_id,deal_id,pipeline_id,owner_id,stage_id,updated_at)VALUES($1,$2,$3,$4,'s1',$5)`,[r.portal,deal,pipeline,owner,r.time]);
   await f.first.query(`INSERT INTO assessment_history(id,portal_id,deal_id,score,grade,status,issue_codes_json,issue_count,pipeline_id,pipeline_label,stage_id,stage_label,owner_id,team_id,region_code,is_closed,is_won,trigger_type,assessed_at)
     VALUES($1,$2,$3,$4,'D','at_risk','[]',1,$5,'Pipeline','s1','Stage',$6,'team1','IN',$7,$8,'test',$9)`,[randomUUID(),r.portal,deal,r.score,pipeline,owner,r.closed,r.won,r.time]);
 };
 return {...f,actor,add};
}
test('main Home dashboard and setup reporting enforce recorded collection access',{skip:!databaseUrl},async t=>{
 await t.test('scoped users receive only permitted records and no portal-wide scan counts',async t=>{
  const f=await setup(t);await f.add('101');await f.add('102','2');await f.add('103','3','p1',{issue:'FORBIDDEN_OWNER'});await f.add('104','1','p2',{issue:'FORBIDDEN_PIPELINE'});await f.add('201','1','p1',{portal:f.other,issue:'FORBIDDEN_TENANT'});
  await f.first.query("UPDATE enterprise_role_assignments SET role='sales_manager',pipeline_ids_json='[\"p1\"]',owner_ids_json='[\"1\",\"2\"]',team_ids_json='[\"team1\"]',region_codes_json='[\"IN\"]' WHERE portal_id=$1",[f.portal]);
  await f.first.query("INSERT INTO scan_runs(id,portal_id,trigger_type,status,started_at,scanned_count)VALUES($1,$2,'manual','completed',$3,9999)",[randomUUID(),f.portal,f.at(2)]);
  const r=await dashboardForIdentity(f.env,f.actor,url());assert.equal(r.totalDeals,2);assert.equal(r.averageScore,50);assert.equal(r.latestScan,null);assert.equal(r.scanMetadataRestricted,true);
  assert.equal(r.topIssues[0].count,2);assert.deepEqual(r.problemDeals.map(d=>d.dealId),['101','102']);assert(!JSON.stringify(r).includes('FORBIDDEN'));
  await assert.rejects(dashboardForIdentity(f.env,f.actor,url('ownerId=3')),{code:'analytics_scope_denied'});
 });
 await t.test('a later scan does not erase unchanged older open assessments',async t=>{
  const f=await setup(t);await f.add('101');await f.first.query("INSERT INTO scan_runs(id,portal_id,trigger_type,status,started_at,scanned_count)VALUES($1,$2,'manual','completed',$3,0)",[randomUUID(),f.portal,f.at(20)]);
  const r=await dashboardForIdentity(f.env,f.actor,url());assert.equal(r.totalDeals,1);assert.equal(r.latestScan.scannedCount,0);
 });
 await t.test('empty samples have no readiness average, while measured zero remains zero',async t=>{
  const f=await setup(t);const empty=await dashboardForIdentity(f.env,f.actor,url());assert.equal(empty.averageScore,null);assert.equal(empty.totalDeals,0);
  await f.add('101','1','p1',{score:0});assert.equal((await dashboardForIdentity(f.env,f.actor,url())).averageScore,0);
 });
 await t.test('closed and archived deals leave open counts; won handoffs remain separate',async t=>{
  const f=await setup(t);await f.add('101');await f.add('102','1','p1',{closed:1,won:1});await f.add('103','1','p1',{closed:1,won:0});
  const r=await dashboardForIdentity(f.env,f.actor,url());assert.equal(r.totalDeals,1);assert.equal(r.incompleteHandoffs,1);assert.equal(r.problemDeals.length,1);
  await f.first.query("SELECT dealguard.verify_deal_record_state($1,'101','archived',$2,'webhook')",[f.portal,new Date().toISOString()]);
  assert.equal((await dashboardForIdentity(f.env,f.actor,url())).totalDeals,0);
 });
 await t.test('a newly recorded assignment cannot be authorized by an older context',async t=>{
  const f=await setup(t);await f.add('101');await f.first.query("UPDATE enterprise_role_assignments SET role='sales_manager',owner_ids_json='[\"1\"]' WHERE portal_id=$1",[f.portal]);
  await f.first.query('UPDATE deal_assessments SET assessed_at=$2 WHERE portal_id=$1',[f.portal,f.at(30)]);
  assert.equal((await dashboardForIdentity(f.env,f.actor,url())).totalDeals,0);
 });
 await t.test('malformed issues withhold issue ranking instead of silently undercounting',async t=>{
  const f=await setup(t);await f.add('101');await f.first.query("UPDATE deal_assessments SET issues_json='invalid',assessed_at=$2 WHERE portal_id=$1",[f.portal,f.at(30)]);
  const r=await dashboardForIdentity(f.env,f.actor,url());assert.equal(r.totalDeals,1);assert.equal(r.issueCoverageComplete,false);assert.deepEqual(r.topIssues,[]);
 });
 await t.test('identity, active installation and bounded single filters are required',async t=>{
  const f=await setup(t);await assert.rejects(dashboardForIdentity(f.env,{...f.actor,userId:null,userEmail:null},url()),{code:'record_user_required'});
  await assert.rejects(dashboardForIdentity(f.env,f.actor,url('ownerId=1&ownerId=2')),{code:'analytics_filter_invalid'});
  await f.first.query("UPDATE tenants SET status='disconnected' WHERE portal_id=$1",[f.portal]);await assert.rejects(dashboardForIdentity(f.env,f.actor,url()),{code:'installation_inactive'});
 });
 await t.test('setup report is read-only, optional sources do not block the CRM core, and live acceptance remains unverified',async t=>{
  const f=await setup(t);const before=(await f.first.query('SELECT COUNT(*)::int n FROM audit_events WHERE portal_id=$1',[f.portal])).rows[0].n;
  const r=await onboardingStatus(f.env,f.actor);assert.equal(r.noActionsExecuted,true);assert.equal(r.liveAcceptanceVerified,false);assert.deepEqual(r.missingRequiredScopes,[]);
  assert.equal(r.optionalCommercial.quotesAuthorized,false);assert.equal(r.nextStep,'first_scan');assert.equal(r.billing.effectiveTier,'enterprise');assert.equal(r.limits.dealsPerScan,10000);
  assert.equal((await f.first.query('SELECT COUNT(*)::int n FROM audit_events WHERE portal_id=$1',[f.portal])).rows[0].n,before);assert(!JSON.stringify(r).includes('private-admin'));
 });
 await t.test('setup fails closed for non-administrators, missing scope data, and invalid configuration',async t=>{
  const f=await setup(t);await f.first.query("UPDATE tenants SET scopes_json='{}',settings_json='null' WHERE portal_id=$1",[f.portal]);
  const r=await onboardingStatus(f.env,f.actor);assert.equal(r.scopeProvenance,'unavailable');assert.equal(r.missingRequiredScopes.length,REQUIRED_HUBSPOT_SCOPES.length);assert.equal(r.checks.find(c=>c.code==='configuration').state,'action_required');
  await f.first.query("UPDATE enterprise_role_assignments SET role='viewer' WHERE portal_id=$1",[f.portal]);await assert.rejects(onboardingStatus(f.env,f.actor),e=>e.status===403);
 });
 await t.test('expired subscriptions still expose consent administration and allow revocation',async t=>{
  const f=await setup(t);await changeIntelligenceConsent(f.env,f.actor,'ai',{enabled:true,revision:0,confirmation:'ENABLE_AI'});
  await f.first.query('UPDATE tenants SET trial_ends_at=$2 WHERE portal_id=$1',[f.portal,f.at(0)]);
  const r=await onboardingStatus(f.env,f.actor);assert.equal(r.billing.effectiveTier,'free');assert.equal(r.limits.dealsPerScan,250);
  assert.equal((await aiAdministration(f.env,f.actor)).consent.enabled,true);assert.equal((await breezeAdministration(f.env,f.actor)).enabled,false);
  assert.equal((await changeIntelligenceConsent(f.env,f.actor,'ai',{enabled:false,revision:1,confirmation:'DISABLE_AI'})).enabled,false);
 });
});
