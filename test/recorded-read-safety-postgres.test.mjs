import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
import { fixture, databaseUrl } from './helpers/postgres-fixture.mjs';
import { route } from '../dist/routes-v11.js';
import { recordedAssessment } from '../dist/recorded-assessment.js';
import { requireOperationalPermission } from '../dist/authorization.js';
import { buildSourceEvidence } from '../dist/source-evidence.js';
import { persistDecisionSnapshot } from '../dist/decision-snapshot.js';
import { COMMERCIAL_LINE_ITEM_SCOPE, COMMERCIAL_QUOTE_SCOPE } from '../dist/commercial-integrity-types.js';

const secret='fixture-signing-secret';
async function setup(t){
 const f=await fixture(t,'recorded-read'),portal=String(Date.now())+String(Math.floor(Math.random()*100000)).padStart(5,'0');f.portalIds.push(portal);
 await f.first.query(`INSERT INTO tenants(portal_id,app_id,access_token_cipher,access_token_iv,refresh_token_cipher,refresh_token_iv,token_expires_at,settings_json,installed_at,updated_at,next_scan_at,commercial_tier,trial_ends_at,installer_email)
  SELECT $1,'1','unused','unused','unused','unused',token_expires_at,settings_json,installed_at,updated_at,next_scan_at,commercial_tier,trial_ends_at,'installer@example.test' FROM tenants WHERE portal_id=$2`,[portal,f.portal]);
 await f.first.query("INSERT INTO enterprise_role_assignments(id,portal_id,user_id,role,created_at,updated_at)VALUES($1,$2,'7','viewer',$3,$3)",[randomUUID(),portal,f.at(0)]);
 const actor={portalId:portal,userId:'7',userEmail:'installer@example.test',appId:'1'},env={...f.env,HUBSPOT_CLIENT_SECRET:secret};
 const add=async(deal='101',at=f.at(10),owner='1')=>{
  await f.first.query(`INSERT INTO deal_assessments(portal_id,deal_id,deal_name,pipeline_label,stage_label,score,grade,status,issues_json,readiness_summary,is_closed,is_won,assessed_at)
   VALUES($1,$2,'Recorded deal','Pipeline','Stage',55,'D','at_risk','[]','Recorded assessment',0,0,$3)`,[portal,deal,at]);
  await f.first.query("INSERT INTO assessment_context(portal_id,deal_id,pipeline_id,owner_id,stage_id,updated_at)VALUES($1,$2,'p1',$3,'s1',$4)",[portal,deal,owner,at]);
 };
 const request=(path,method='GET')=>{
  const url=`https://example.test/api/v1/${path}?portalId=${portal}&userId=7&userEmail=installer%40example.test&appId=1`,timestamp=String(Date.now());
  const signature=createHmac('sha256',secret).update(method+url.replace('%40','@')+timestamp).digest('base64');
  return new Request(url,{method,headers:{'x-hubspot-signature-v3':signature,'x-hubspot-request-timestamp':timestamp}});
 };
 return {...f,portal,actor,env,add,request};
}
const ctx={waitUntil(){throw new Error('A recorded read must not enqueue work');}};

test('record reads never refresh providers or execute work',{skip:!databaseUrl},async t=>{
 await t.test('a stale viewer GET returns the same observation and performs no provider or work mutation',async t=>{
  const f=await setup(t),old=new Date(Date.now()-100*3600000).toISOString();await f.add('101',old);
  const saved=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('Provider contacted by read');};t.after(()=>{globalThis.fetch=saved;});
  const tables=['deal_assessments','assessment_history','remediation_cases','audit_events','outbox_events','billing_usage_events','recommendation_instances'];
  const counts=async()=>Promise.all(tables.map(async name=>(await f.first.query(`SELECT COUNT(*)::int n FROM ${name} WHERE portal_id=$1`,[f.portal])).rows[0].n));
  const before=await counts(),response=await route(f.request('deals/101/assessment'),f.env,ctx),value=await response.json();
  assert.equal(response.status,200);assert.equal(value.assessedAt,old);assert.equal(value.evidence.status,'stale');
  assert.equal(value.recordCapabilities.canRefresh,false);assert.equal(value.source,'recorded_assessment');
  assert.equal(calls,0);assert.deepEqual(await counts(),before);
 });
 await t.test('viewer POST refresh is denied before any provider request',async t=>{
  const f=await setup(t);await f.add();const saved=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('Provider contacted');};t.after(()=>{globalThis.fetch=saved;});
  await assert.rejects(route(f.request('deals/101/assessment','POST'),f.env,ctx),{code:'record_permission_denied'});assert.equal(calls,0);
 });
 await t.test('missing evidence advertises explicit refresh only to authorized reviewers',async t=>{
  const f=await setup(t);await assert.rejects(recordedAssessment(f.env,f.actor,'101'),e=>e.code==='assessment_unavailable'&&e.details.canRefresh===false);
  await f.first.query("UPDATE enterprise_role_assignments SET role='reviewer' WHERE portal_id=$1",[f.portal]);
  await assert.rejects(recordedAssessment(f.env,f.actor,'101'),e=>e.code==='assessment_unavailable'&&e.details.canRefresh===true);
 });
 await t.test('scoped viewers cannot read another owner or bypass through a legacy installer role',async t=>{
  const f=await setup(t);await f.add('101',f.at(10),'2');
  await f.first.query("UPDATE enterprise_role_assignments SET owner_ids_json='[\"1\"]' WHERE portal_id=$1",[f.portal]);
  await assert.rejects(recordedAssessment(f.env,f.actor,'101'),{code:'record_scope_denied'});
  await assert.rejects(requireOperationalPermission(f.env,f.actor,'settings.manage'),{code:'enterprise_permission_denied'});
  await assert.rejects(requireOperationalPermission(f.env,f.actor,'scan.run'),{code:'enterprise_permission_denied'});
 });
 await t.test('an assigned operator has only its explicit permission and correct scope',async t=>{
  const f=await setup(t);await f.first.query("UPDATE enterprise_role_assignments SET role='sales_manager',owner_ids_json='[\"1\"]' WHERE portal_id=$1",[f.portal]);
  await assert.rejects(requireOperationalPermission(f.env,f.actor,'scan.run'),{code:'enterprise_scope_denied'});
  await requireOperationalPermission(f.env,f.actor,'remediation.manage',{ownerId:'1'});
  await assert.rejects(requireOperationalPermission(f.env,f.actor,'remediation.manage',{ownerId:'2'}),{code:'enterprise_scope_denied'});
 });
 await t.test('stored brief preserves generation time and withholds stale optional source evidence',async t=>{
  const f=await setup(t),at=f.at(10);await f.add('101',at);
  const generated=new Date(Date.now()-1000).toISOString();
  const payload={dealId:'101',isClosed:false,assessedAt:at,score:55,status:'at_risk',intelligence:{
   sourceEvidence:buildSourceEvidence({readiness:at}),
   dealBrief:{generatedAt:generated,methodology:'deterministic_evidence_synthesis',status:'watch',attentionScore:45,confidence:'low',coverage:{percent:40},freshness:{status:'fresh',assessedAt:at},risks:[],nextAction:null}
  }};
  assert.equal(await persistDecisionSnapshot(f.env,f.portal,'101',payload),true);
  const before=(await f.first.query('SELECT COUNT(*)::int n FROM recommendation_events WHERE portal_id=$1',[f.portal])).rows[0].n;
  const first=await recordedAssessment(f.env,f.actor,'101');assert.equal(first.intelligence.dealBrief.generatedAt,generated);
  await recordedAssessment(f.env,f.actor,'101');assert.equal((await f.first.query('SELECT COUNT(*)::int n FROM recommendation_events WHERE portal_id=$1',[f.portal])).rows[0].n,before);
  const historyAt=new Date(Date.parse(at)-4*3600000).toISOString();
  const historical={readiness:{score:55,status:'at_risk'},momentum:{score:90,status:'strong'},sourceEvidence:buildSourceEvidence({readiness:at,history:historyAt})};
  await f.first.query('UPDATE deal_decision_snapshots SET dimensions_json=$3,risk_summary_json=$4 WHERE portal_id=$1 AND deal_id=$2',[f.portal,'101',JSON.stringify(historical),JSON.stringify([{code:'history_risk',label:'Recorded history risk',dimension:'momentum',severity:'warning'}])]);
  assert.equal((await recordedAssessment(f.env,f.actor,'101')).intelligence.dealBrief.risks[0].observedAt,historyAt);
  const dims={readiness:{score:55,status:'at_risk'},momentum:{score:90,status:'strong'},sourceEvidence:buildSourceEvidence({readiness:at,history:new Date(Date.now()-100*3600000).toISOString()})};
  await f.first.query('UPDATE deal_decision_snapshots SET dimensions_json=$3 WHERE portal_id=$1 AND deal_id=$2',[f.portal,'101',JSON.stringify(dims)]);
  assert.equal((await recordedAssessment(f.env,f.actor,'101')).intelligence,undefined);
  const commercial={readiness:{score:55,status:'at_risk'},commercial:{score:80,status:'watch'},sourceEvidence:buildSourceEvidence({readiness:at,commercial:at})};
  await f.first.query('UPDATE deal_decision_snapshots SET dimensions_json=$3 WHERE portal_id=$1 AND deal_id=$2',[f.portal,'101',JSON.stringify(commercial)]);
  await f.first.query('UPDATE tenants SET scopes_json=$2 WHERE portal_id=$1',[f.portal,JSON.stringify([COMMERCIAL_LINE_ITEM_SCOPE,COMMERCIAL_QUOTE_SCOPE])]);
  assert((await recordedAssessment(f.env,f.actor,'101')).intelligence);
  await f.first.query('UPDATE tenants SET scopes_json=$2 WHERE portal_id=$1',[f.portal,JSON.stringify([COMMERCIAL_LINE_ITEM_SCOPE])]);
  assert.equal((await recordedAssessment(f.env,f.actor,'101')).intelligence,undefined);
 });
 await t.test('legacy portal-wide reads enforce active identified permission before provider access',async t=>{
  const f=await setup(t);const saved=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('Unexpected provider');};t.after(()=>{globalThis.fetch=saved;});
  for(const path of ['settings','metadata','integrations/slack','native-sync','operations/outbox','operations/health']){
   await assert.rejects(route(f.request(path),f.env,ctx),e=>e.status===403);
  }
  await f.first.query("UPDATE enterprise_role_assignments SET owner_ids_json='[\"1\"]' WHERE portal_id=$1",[f.portal]);
  const overview=await route(f.request('enterprise/overview'),f.env,ctx);assert.equal((await overview.json()).redacted,true);
  await f.first.query("UPDATE tenants SET status='disconnected' WHERE portal_id=$1",[f.portal]);
  await assert.rejects(recordedAssessment(f.env,f.actor,'101'),{code:'installation_inactive'});assert.equal(calls,0);
 });
});
