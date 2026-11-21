import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID}from'node:crypto';
import {fixture,databaseUrl}from'./helpers/postgres-fixture.mjs';
import {buildOutcomeDataset,listOutcomeDatasets}from'../dist/outcome-data.js';
import {changeIntelligenceConsent,requireIntelligenceConsent,cleanupOutcomeEvidence}from'../dist/intelligence-consent.js';
import {canonicalAuditValue}from'../dist/audit-chain.js';import{sha256Hex}from'../dist/crypto.js';
import {evaluateStoredOutcomes}from'../dist/outcome-evaluation-service.js';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
test('outcome storage enforces consent, tenant binding, immutable provenance and actual history SQL',{skip:!databaseUrl},async t=>{
 const f=await fixture(t,'outcome'),{first,second,env,portal,other}=f,actor={portalId:portal,userId:'7',userEmail:'admin@example.test',appId:'fixture'};
 await first.query(`INSERT INTO enterprise_role_assignments(id,portal_id,user_id,role,created_at,updated_at)VALUES($1,$2,'7','administrator','2025-01-01T00:00:00Z','2025-01-01T00:00:00Z')`,[randomUUID(),portal]);
 const policy=randomUUID();await first.query(`INSERT INTO policy_versions(id,portal_id,version_number,name,status,rules_json,checksum,created_at,updated_at)
 VALUES($1,$2,1,'Test','published','{}','test','2025-01-01T00:00:00Z','2025-01-01T00:00:00Z')`,[policy,portal]);
 const history=async(deal,date,closed=0,won=0,pipeline='p')=>first.query(`INSERT INTO assessment_history(id,portal_id,deal_id,score,grade,status,issue_codes_json,issue_count,pipeline_id,pipeline_label,stage_label,stage_age_days,is_closed,is_won,policy_id,trigger_type,assessed_at)
 VALUES($1,$2,$3,80,'B','ready','[]',0,$4,'Pipeline','Stage',4,$5,$6,$7,'record',$8)`,[randomUUID(),portal,deal,pipeline,closed,won,policy,date]);
 for(const deal of ['good','missing','archived','changed'])await history(deal,'2026-03-31T12:00:00Z');
 await history('good','2026-06-30T12:00:00Z',1,1);await history('archived','2026-06-30T12:00:00Z',1,1);await history('changed','2026-06-30T12:00:00Z',1,1,'outside');
 await first.query(`SELECT dealguard.verify_deal_record_state($1,'archived','archived','2026-05-01T00:00:00Z','webhook')`,[portal]);
 const input={quarter:'2026-Q2',pipelineId:'p',policyId:policy};let dataset;
 await t.test('consent defaults off and requires signed portal-wide administrator with exact confirmation',async()=>{
  await assert.rejects(buildOutcomeDataset(env,actor,input),{code:'intelligence_consent_required'});
  await assert.rejects(changeIntelligenceConsent(env,actor,'outcomes',{enabled:true,revision:0,confirmation:'yes'}),{code:'consent_confirmation_required'});
  await assert.rejects(changeIntelligenceConsent(env,{...actor,portalId:other},'outcomes',{enabled:true,revision:0,confirmation:'ENABLE_OUTCOMES'}));
  assert.deepEqual(await changeIntelligenceConsent(env,actor,'outcomes',{enabled:true,revision:0,confirmation:'ENABLE_OUTCOMES'}),{enabled:true,revision:1});
 });
 await t.test('real history builder excludes missing label, archived record and changed pipeline',async()=>{
  dataset=await buildOutcomeDataset(env,actor,input);assert.equal(dataset.manifest.sampleCount,1);assert.equal(dataset.predictionsEnabled,false);
  const row=(await first.query('SELECT * FROM outcome_datasets WHERE portal_id=$1 AND id=$2',[portal,dataset.id])).rows[0];assert.equal(row.samples[0].dealId,'good');
  assert.equal(await sha256Hex(canonicalAuditValue({manifest:row.manifest,samples:row.samples})),dataset.fingerprint);
  assert.equal((await buildOutcomeDataset(env,actor,input)).id,dataset.id);
 });
 await t.test('datasets are immutable and administrative listing does not expose raw samples',async()=>{
  await assert.rejects(first.query("UPDATE outcome_datasets SET samples='[]' WHERE portal_id=$1",[portal]),{code:'23514'});
  const list=await listOutcomeDatasets(env,actor);assert.equal(list.length,1);assert.equal(list[0].samples,undefined);
  await assert.rejects(evaluateStoredOutcomes(env,{...actor,portalId:other},{trainId:dataset.id,calibrationId:'no',holdoutId:'none'}));
 });
 await t.test('stale consent revisions fail and cross-tenant store cannot inherit consent',async()=>{
  await assert.rejects(changeIntelligenceConsent(env,actor,'outcomes',{enabled:false,revision:0,confirmation:'DISABLE_OUTCOMES'}),{code:'consent_changed'});
  const row=await second.query("SELECT dealguard.store_outcome_dataset($1,1,$2,$3,'{}','[]') AS id",[other,randomUUID(),'a'.repeat(64)]);assert.equal(row.rows[0].id,null);
 });
 await t.test('revocation and concurrent store serialize so revoked consent cannot commit data',async()=>{
  await first.query('BEGIN');await first.query("SELECT dealguard.set_intelligence_consent($1,'outcomes',false,1,'7')",[portal]);
  let done=false;const pending=second.query("SELECT dealguard.store_outcome_dataset($1,1,$2,$3,'{}','[]') AS id",[portal,randomUUID(),'b'.repeat(64)]).then(r=>{done=true;return r;});
  await delay(30);assert.equal(done,false);await first.query('COMMIT');assert.equal((await pending).rows[0].id,null);
  assert.equal((await first.query('SELECT COUNT(*)::int n FROM outcome_datasets WHERE portal_id=$1',[portal])).rows[0].n,0);
 });
 await t.test('legal hold preserves revoked data without granting access and release permits cleanup',async()=>{
  await changeIntelligenceConsent(env,actor,'outcomes',{enabled:true,revision:2,confirmation:'ENABLE_OUTCOMES'});await buildOutcomeDataset(env,actor,input);
  const hold=randomUUID();await first.query("INSERT INTO legal_holds(id,portal_id,name,reason,scope_json,status,created_at)VALUES($1,$2,'Hold','Test','{}','active','2026-09-01T00:00:00Z')",[hold,portal]);
  await changeIntelligenceConsent(env,actor,'outcomes',{enabled:false,revision:3,confirmation:'DISABLE_OUTCOMES'});await assert.rejects(requireIntelligenceConsent(env,portal,'outcomes'));
  await cleanupOutcomeEvidence(env);assert.equal((await first.query('SELECT COUNT(*)::int n FROM outcome_datasets WHERE portal_id=$1',[portal])).rows[0].n,1);
  await first.query("UPDATE legal_holds SET status='released' WHERE id=$1",[hold]);await cleanupOutcomeEvidence(env);assert.equal((await first.query('SELECT COUNT(*)::int n FROM outcome_datasets WHERE portal_id=$1',[portal])).rows[0].n,0);
 });
});
