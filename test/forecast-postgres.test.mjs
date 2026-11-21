import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {fixture,databaseUrl} from './helpers/postgres-fixture.mjs';
import {canonicalAuditValue} from '../dist/audit-chain.js';import {sha256Hex} from '../dist/crypto.js';
import {changeIntelligenceConsent} from '../dist/intelligence-consent.js';
import {evaluateStoredOutcomes,processOutcomeEvaluationJobs,listOutcomeEvaluations} from '../dist/outcome-evaluation-service.js';
import {registerForecastModel,reviewForecastModel,changeForecastControls,dealForecast,forecastStatus} from '../dist/forecast-service.js';
import {refreshForecastMonitoring,cleanupForecastEvidence,observeForecastOutcomes} from '../dist/forecast-monitoring.js';
import {activeForecastQuarter,forecastWindow} from '../dist/forecast-model.js';
import {forecastPolicyFingerprint} from '../dist/forecast-evidence.js';
const expiry=()=>new Date(Date.now()+7*86400000).toISOString();
async function seed(t,prefix='forecast'){
 const f=await fixture(t,prefix),{first,portal,env}=f;env.DEALGUARD_FORECAST_ENABLED='true';
 const admin={portalId:portal,userId:'7',userEmail:'admin@example.test',appId:'fixture'},reviewer={...admin,userId:'8',userEmail:'review@example.test'};
 for(const [id,role,permissions] of [['7','administrator',[]],['8','reviewer',['forecast.approve']],['9','viewer',[]]])await first.query(`INSERT INTO enterprise_role_assignments(id,portal_id,user_id,role,permissions_json,created_at,updated_at)
  VALUES($1,$2,$3,$4,$5,$6,$6)`,[randomUUID(),portal,id,role,JSON.stringify(permissions),new Date().toISOString()]);
 const policy=randomUUID(),window=activeForecastQuarter();
 await first.query(`INSERT INTO policy_versions(id,portal_id,version_number,name,status,rules_json,checksum,created_at,updated_at)VALUES($1,$2,1,'Forecast fixture','published','{}','fixture','2024-01-01T00:00:00Z','2024-01-01T00:00:00Z')`,[policy,portal]);
 await changeIntelligenceConsent(env,admin,'outcomes',{enabled:true,revision:0,confirmation:'ENABLE_OUTCOMES'});
 const quarterBase=new Date(window.anchorAt),datasets=[];
 for(const [index,back,count] of [[0,4,220],[1,3,120],[2,2,120]]){
  const q=activeForecastQuarter(Date.UTC(quarterBase.getUTCFullYear(),quarterBase.getUTCMonth()-back*3,1)),w=forecastWindow(q.quarter);
  const dataset={manifest:{schema:'dealguard-quarter-outcomes-v1',quarter:q.quarter,anchor:w.anchorAt,horizon:w.horizonAt,pipelineId:'p',policyId:policy,policyFingerprint:await forecastPolicyFingerprint(env,portal,policy),sampleCount:count,exclusions:{}},
   samples:Array.from({length:count},(_,i)=>({dealId:`${index}-${i}`,observationAt:new Date(Date.parse(w.anchorAt)-3600000).toISOString(),labelAt:new Date(Date.parse(w.horizonAt)-3600000).toISOString(),features:[i%2?90:10,i%2?0:8,4,0],label:i%2}))};
  const id=randomUUID(),fingerprint=await sha256Hex(canonicalAuditValue(dataset));
  await first.query('SELECT dealguard.store_outcome_dataset($1,1,$2,$3,$4,$5)',[portal,id,fingerprint,JSON.stringify(dataset.manifest),JSON.stringify(dataset.samples)]);datasets.push(id);
 }
 const history=async(deal,date,score=10,issues=8,closed=0,won=0,owner='owner-a',pipeline='p',policyId=policy)=>first.query(`INSERT INTO assessment_history(id,portal_id,deal_id,score,grade,status,issue_codes_json,issue_count,pipeline_id,pipeline_label,stage_label,stage_age_days,is_closed,is_won,policy_id,owner_id,trigger_type,assessed_at)
  VALUES($1,$2,$3,$4,'B','ready','[]',$5,$6,'Pipeline','Stage',4,$7,$8,$9,$10,'record',$11)`,[randomUUID(),portal,deal,score,issues,pipeline,closed,won,policyId,owner,date]);
 for(let i=0;i<120;i++)await history(String(90000+i),new Date(Date.parse(window.anchorAt)-3600000).toISOString(),i%2?90:10,i%2?0:8);
 const assessedAt=new Date(Date.now()-60000).toISOString();
 await first.query(`INSERT INTO deal_assessments(portal_id,deal_id,deal_name,pipeline_label,stage_label,score,grade,status,issues_json,readiness_summary,is_closed,is_won,assessed_at)
  VALUES($1,'90000','Fixture','Pipeline','Stage',99,'A','ready','[]','Fixture',0,0,$2)`,[portal,assessedAt]);
 await history('90000',assessedAt,99,0);
 return {...f,admin,reviewer,policy,window,history,assessedAt,input:{trainId:datasets[0],calibrationId:datasets[1],holdoutId:datasets[2]}};
}
async function candidate(f){
 const job=await evaluateStoredOutcomes(f.env,f.admin,f.input);assert.equal(job.status,'queued');
 await processOutcomeEvaluationJobs(f.env);
 const rows=await listOutcomeEvaluations(f.env,f.admin),evaluated=rows.find(r=>r.report.status==='qualified_candidate');
 assert.ok(evaluated,JSON.stringify(rows));
 const model=await registerForecastModel(f.env,f.admin,{evaluationId:evaluated.id,expiresAt:expiry(),confirmation:'REGISTER_FORECAST_CANDIDATE'});
 return {job,evaluated,model};
}
const reviewInput=model=>({modelId:model.id,artifactFingerprint:model.artifactFingerprint,decision:'approve',evidenceSha256:'a'.repeat(64),confirmation:'APPROVE_FORECAST'});
test('qualified forecasting performs controlled evaluation, independent approval and exact-origin inference',{skip:!databaseUrl},async t=>{
 const f=await seed(t),{env,first,portal,admin,reviewer,input}=f;let job,evaluated,model;
 await t.test('interactive API queues and idempotently reuses a job without training',async()=>{
  job=await evaluateStoredOutcomes(env,admin,input);assert.equal(job.status,'queued');assert.equal((await evaluateStoredOutcomes(env,admin,input)).id,job.id);
  assert.equal((await first.query('SELECT COUNT(*)::int n FROM outcome_evaluations WHERE portal_id=$1',[portal])).rows[0].n,0);
  await assert.rejects(evaluateStoredOutcomes(env,{...admin,userId:'9'},input));
 });
 await t.test('batch worker fits retained datasets, stores reproducible model artifact and leaves forecasts off',async()=>{
  assert.deepEqual(await processOutcomeEvaluationJobs(env),{processed:1});assert.deepEqual(await processOutcomeEvaluationJobs(env),{processed:0});
  evaluated=(await listOutcomeEvaluations(env,admin)).find(r=>r.report.status==='qualified_candidate');assert.ok(evaluated);assert.equal(evaluated.report.predictionsEnabled,false);
  const j=(await first.query('SELECT * FROM outcome_evaluation_jobs WHERE portal_id=$1 AND id=$2',[portal,job.id])).rows[0];
  assert.equal(j.state,'completed');assert.equal(await sha256Hex(canonicalAuditValue(j.result_artifact)),j.result_fingerprint);
  model=await registerForecastModel(env,admin,{evaluationId:evaluated.id,expiresAt:expiry(),confirmation:'REGISTER_FORECAST_CANDIDATE'});assert.equal(model.state,'pending');
 });
 await t.test('self-approval, changed artifact, missing current monitor and cross-tenant review fail closed',async()=>{
  await assert.rejects(reviewForecastModel(env,admin,reviewInput(model)),{code:'forecast_review_denied'});
  await assert.rejects(reviewForecastModel(env,reviewer,reviewInput(model)),{code:'forecast_review_denied'});
  await assert.rejects(reviewForecastModel(env,{...reviewer,portalId:f.other},reviewInput(model)));
  await assert.rejects(first.query("UPDATE forecast_models SET artifact='{}' WHERE portal_id=$1 AND id=$2",[portal,model.id]),{code:'23514'});
  assert.deepEqual(await refreshForecastMonitoring(env),{processed:1});
  await assert.rejects(reviewForecastModel(env,reviewer,{...reviewInput(model),artifactFingerprint:'b'.repeat(64)}),{code:'forecast_review_denied'});
  assert.equal((await reviewForecastModel(env,reviewer,reviewInput(model))).state,'active');
 });
 await t.test('default-off tenant/global switches cannot be bypassed by an approved model',async()=>{
  assert.equal((await dealForecast(env,admin,'90000')).reason,'tenant_disabled');
  await changeForecastControls(env,admin,{enabled:true,revision:0,confirmation:'ENABLE_FORECASTS'});
  assert.equal((await dealForecast({...env,DEALGUARD_FORECAST_ENABLED:'false'},admin,'90000')).reason,'globally_disabled');
 });
 await t.test('estimate uses quarter-anchor score, not the latest score; cache is retained with source and consent bindings',async()=>{
  const result=await dealForecast(env,admin,'90000');assert.equal(result.status,'eligible',JSON.stringify(result));assert.ok(result.probability<.1,'anchor score10 must not be replaced with current score99');
  assert.equal(result.evidenceAt,new Date(Date.parse(f.window.anchorAt)-3600000).toISOString());assert.equal(result.estimateOrigin,'quarter_start');
  assert.equal(result.uncertainty.individualProbabilityInterval,null);assert.equal(result.uncertainty.calibrationSamples,60);
  const again=await dealForecast(env,admin,'90000');assert.equal(again.cached,true);assert.equal(again.probability,result.probability);
  assert.equal((await first.query('SELECT COUNT(*)::int n FROM forecast_predictions WHERE portal_id=$1',[portal])).rows[0].n,1);
  assert.equal((await forecastStatus(env,reviewer)).predictionsEnabled,true);
 });
 await t.test('unknown anchor, expired monitor and role revocation do not reveal cached estimates',async()=>{
  await first.query("UPDATE forecast_monitors SET expires_at=NOW()-INTERVAL '1 second' WHERE portal_id=$1",[portal]);
  assert.equal((await dealForecast(env,admin,'90000')).reason,'monitoring_evidence_unavailable');
  await first.query("UPDATE forecast_monitors SET expires_at=NOW()+INTERVAL '1 day' WHERE portal_id=$1",[portal]);
  await first.query("UPDATE enterprise_role_assignments SET permissions_json='[]' WHERE portal_id=$1 AND user_id='8'",[portal]);
  assert.equal((await dealForecast(env,admin,'90000')).reason,'no_independently_approved_model');
  await first.query(`UPDATE enterprise_role_assignments SET permissions_json='["forecast.approve"]' WHERE portal_id=$1 AND user_id='8'`,[portal]);
  await first.query(`UPDATE enterprise_role_assignments SET owner_ids_json='["outside"]' WHERE portal_id=$1 AND user_id='9'`,[portal]);
  await assert.rejects(dealForecast(env,{...admin,userId:'9'},'90000'),{code:'record_scope_denied'});
 });
 await t.test('kill switch suspends approval and re-enabling cannot resurrect it',async()=>{
  await changeForecastControls(env,admin,{enabled:false,revision:1,confirmation:'DISABLE_FORECASTS'});
  assert.equal((await dealForecast(env,admin,'90000')).reason,'tenant_disabled');
  await changeForecastControls(env,admin,{enabled:true,revision:2,confirmation:'ENABLE_FORECASTS'});
  assert.equal((await dealForecast(env,admin,'90000')).reason,'no_independently_approved_model');
  await assert.rejects(reviewForecastModel(env,reviewer,reviewInput(model)),{code:'forecast_review_denied'});
 });
});
test('monitor drift suspends an active model and consent revocation clears retained eligible data',{skip:!databaseUrl},async t=>{
 const f=await seed(t,'forecast-drift'),{env,first,portal,admin,reviewer}=f;const {model}=await candidate(f);
 await refreshForecastMonitoring(env);await reviewForecastModel(env,reviewer,reviewInput(model));await changeForecastControls(env,admin,{enabled:true,revision:0,confirmation:'ENABLE_FORECASTS'});
 assert.equal((await dealForecast(env,admin,'90000')).status,'eligible');
 await first.query("UPDATE assessment_history SET score=100,issue_count=0 WHERE portal_id=$1 AND assessed_at<$2",[portal,f.window.anchorAt]);
 await first.query("UPDATE forecast_models SET monitor_checked_at=NOW()-INTERVAL '13 hours' WHERE portal_id=$1",[portal]);
 await refreshForecastMonitoring(env);
 assert.equal((await first.query('SELECT state FROM forecast_models WHERE portal_id=$1',[portal])).rows[0].state,'suspended');
 assert.equal((await dealForecast(env,admin,'90000')).probability,null);
 await changeIntelligenceConsent(env,admin,'outcomes',{enabled:false,revision:1,confirmation:'DISABLE_OUTCOMES'});
 for(const table of ['forecast_models','forecast_cache','forecast_predictions','outcome_evaluation_jobs'])assert.equal((await first.query(`SELECT COUNT(*)::int n FROM ${table} WHERE portal_id=$1`,[portal])).rows[0].n,0);
 await cleanupForecastEvidence(env);assert.deepEqual(await observeForecastOutcomes(env),{processed:0});
});
test('evaluation lease expiry is retryable and revoked consent cancels queued work',{skip:!databaseUrl},async t=>{
 const f=await seed(t,'forecast-lease');const job=await evaluateStoredOutcomes(f.env,f.admin,f.input);
 await f.first.query("UPDATE outcome_evaluation_jobs SET state='running',attempts=1,lease_token='lost-worker',lease_expires_at=NOW()-INTERVAL '1 second' WHERE portal_id=$1 AND id=$2",[f.portal,job.id]);
 await processOutcomeEvaluationJobs(f.env);assert.equal((await f.first.query('SELECT attempts,state FROM outcome_evaluation_jobs WHERE portal_id=$1',[f.portal])).rows[0].attempts,2);
 const evaluated=(await listOutcomeEvaluations(f.env,f.admin)).find(row=>row.report.status==='qualified_candidate');assert.ok(evaluated);
 await registerForecastModel(f.env,f.admin,{evaluationId:evaluated.id,expiresAt:expiry(),confirmation:'REGISTER_FORECAST_CANDIDATE'});
 const hold=randomUUID();await f.first.query("INSERT INTO legal_holds(id,portal_id,name,reason,scope_json,status,created_at)VALUES($1,$2,'Fixture hold','Test','{}','active','2026-01-01T00:00:00Z')",[hold,f.portal]);
 await changeIntelligenceConsent(f.env,f.admin,'outcomes',{enabled:false,revision:1,confirmation:'DISABLE_OUTCOMES'});
 assert.equal((await f.first.query('SELECT COUNT(*)::int n FROM outcome_evaluation_jobs WHERE portal_id=$1',[f.portal])).rows[0].n,1);
 assert.equal((await f.first.query('SELECT COUNT(*)::int n FROM forecast_models WHERE portal_id=$1',[f.portal])).rows[0].n,1,'the legal hold really retained derived model evidence');
 assert.deepEqual(await processOutcomeEvaluationJobs(f.env),{processed:0});
 await assert.rejects(listOutcomeEvaluations(f.env,f.admin),{code:'intelligence_consent_required'});
 const status=await forecastStatus(f.env,f.admin);assert.deepEqual(status.models,[]);assert.deepEqual(status.outcomeReports,[]);assert.equal(status.predictionsEnabled,false);
});

test('a kill switch racing a cached response withholds the previously permitted probability',{skip:!databaseUrl},async t=>{
 const f=await seed(t,'forecast-race'),{env,admin,reviewer}=f;const {model}=await candidate(f);
 await refreshForecastMonitoring(env);await reviewForecastModel(env,reviewer,reviewInput(model));
 await changeForecastControls(env,admin,{enabled:true,revision:0,confirmation:'ENABLE_FORECASTS'});
 assert.equal((await dealForecast(env,admin,'90000')).status,'eligible');
 const otherConnection={...f.envFor(f.second),DEALGUARD_FORECAST_ENABLED:'true'};let raced=false;
 const racingEnv={...env,DB:{...env.DB,prepare(sql){const statement=env.DB.prepare(sql);
  if(sql.includes('SELECT probability FROM dealguard.forecast_cache')){const original=statement.first;statement.first=async()=>{
   const cached=await original();await changeForecastControls(otherConnection,admin,{enabled:false,revision:1,confirmation:'DISABLE_FORECASTS'});raced=true;return cached;
  };}return statement;
 }}};
 const result=await dealForecast(racingEnv,admin,'90000');assert.equal(raced,true);assert.equal(result.status,'unavailable');assert.equal(result.probability,null);
});

test('scheduled mature-outcome SQL observes retained predictions and excludes missing or stale labels',{skip:!databaseUrl},async t=>{
 const f=await seed(t,'forecast-observe'),{env,first,portal,history}=f;const {model}=await candidate(f);
 // A separate historical ledger fixture exercises observation SQL, not a real customer forecasting claim.
 const current=new Date(f.window.anchorAt),past=activeForecastQuarter(Date.UTC(current.getUTCFullYear(),current.getUTCMonth()-6,1));
 const labelAt=new Date(Date.parse(past.horizonAt)-3600000).toISOString();
 for(let i=0;i<122;i++){
  const deal=String(80000+i),probability=i%2?.9:.1;
  await first.query(`INSERT INTO forecast_predictions(portal_id,model_id,deal_id,quarter,anchor_at,horizon_at,evidence_at,source_fingerprint,probability,consent_revision)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1)`,[portal,model.id,deal,past.quarter,past.anchorAt,past.horizonAt,new Date(Date.parse(past.anchorAt)-3600000).toISOString(),'c'.repeat(64),probability]);
  if(i<120)await history(deal,labelAt,80,0,1,i%2);
  if(i===120)await history(deal,new Date(Date.parse(past.horizonAt)-10*86400000).toISOString(),80,0,1,1);
 }
 assert.deepEqual(await observeForecastOutcomes(env),{processed:1});
 const row=(await first.query('SELECT * FROM forecast_outcome_reports WHERE portal_id=$1',[portal])).rows[0];
 assert.equal(row.report.status,'observed');assert.equal(row.report.total,122);assert.equal(row.report.observed,120);assert.equal(row.report.excluded,2);
 assert.ok(Math.abs(row.report.metrics.brier-.01)<1e-12);assert.match(row.report.labelEvidenceFingerprint,/^[a-f0-9]{64}$/);
 assert.deepEqual(await observeForecastOutcomes(env),{processed:0});
 await assert.rejects(first.query("UPDATE forecast_outcome_reports SET report='{}' WHERE portal_id=$1",[portal]),{code:'23514'});
});
