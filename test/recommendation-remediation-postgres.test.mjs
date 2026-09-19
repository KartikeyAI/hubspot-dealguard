import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, databaseUrl } from './helpers/postgres-fixture.mjs';
import { createRecommendationRemediation } from '../dist/recommendation-remediation.js';
import { transitionRecommendation, listDealRecommendations } from '../dist/recommendation-lifecycle.js';
import { listRemediationCases, remediationSummary, transitionRemediationCase } from '../dist/remediation.js';
import { addRemediationComment, addRemediationEvidence, reviewRemediationEvidence, configureRemediationControls, remediationDetail } from '../dist/remediation-enterprise.js';
import { expirePresentedRecommendations } from '../dist/recommendation-outcome-storage.js';
const identity=portal=>({portalId:portal,userId:'401',userEmail:'manager@example.test'});
const delay=ms=>new Promise(r=>setTimeout(r,ms));

test('closed-loop recommendation/case operations use scoped production services and atomic PostgreSQL functions',{skip:!databaseUrl},async t=>{
 const f=await fixture(t,'workloop'),{first,second,env,portal,other,at}=f;
 const user=identity(portal);
 await first.query(`INSERT INTO enterprise_role_assignments(id,portal_id,user_id,user_email,role,pipeline_ids_json,owner_ids_json,team_ids_json,region_codes_json,created_at,updated_at)
  VALUES($1,$2,'401','manager@example.test','revops_manager','["p1"]','["101","102"]','["t1"]','["r1"]',$3,$3)`,[crypto.randomUUID(),portal,at(0)]);
 const submitter={...user,userId:'402',userEmail:'remediator@example.test'};
 const reviewer={...user,userId:'403',userEmail:'reviewer@example.test'};
 for(const [actor,role] of [[submitter,'remediation_manager'],[reviewer,'reviewer']]) {
  await first.query(`INSERT INTO enterprise_role_assignments(id,portal_id,user_id,user_email,role,pipeline_ids_json,owner_ids_json,team_ids_json,region_codes_json,created_at,updated_at)
   VALUES($1,$2,$3,$4,$5,'["p1"]','["101","102"]','["t1"]','["r1"]',$6,$6)`,[crypto.randomUUID(),portal,actor.userId,actor.userEmail,role,at(0)]);
 }
 async function seed(deal,owner='101',tenant=portal,source=at(10)) {
  await first.query(`INSERT INTO deal_assessments(portal_id,deal_id,deal_name,pipeline_label,stage_label,score,grade,status,readiness_summary,issues_json,is_closed,is_won,assessed_at)
   VALUES($1,$2,'Deal','Pipeline','Stage',80,'B','at_risk','Summary','[]',0,0,$3)`,[tenant,deal,source]);
  await first.query(`INSERT INTO assessment_history(id,portal_id,deal_id,score,grade,status,issue_codes_json,issue_count,pipeline_id,pipeline_label,stage_label,owner_id,team_id,region_code,is_closed,is_won,trigger_type,assessed_at)
   VALUES($1,$2,$3,80,'B','at_risk','[]',0,'p1','Pipeline','Stage',$4,'t1','r1',0,0,'test',$5)`,[crypto.randomUUID(),tenant,deal,owner,source]);
  await first.query(`INSERT INTO deal_decision_snapshots(portal_id,deal_id,assessment_at,generated_at,methodology,brief_status,attention_score,confidence,coverage_percent,freshness_status,created_at,updated_at,next_action_code)
   VALUES($1,$2,$3,$4,'deterministic_evidence_synthesis','watch',50,'medium',100,'fresh',$4,$4,'readiness_next_step')`,[tenant,deal,source,at(11)]);
  return source;
 }
 async function rec(deal,tenant=portal,source=at(10),code='readiness_next_step',owner='101') {
  const id=crypto.randomUUID();
  await first.query(`INSERT INTO recommendation_instances(id,portal_id,deal_id,recommendation_fingerprint,recommendation_code,recommendation_label,recommendation_text,recommendation_dimension,priority,owner_role,due_at,rationale,methodology,status,
   baseline_assessment_at,baseline_snapshot_generated_at,baseline_pipeline_id,baseline_owner_id,baseline_team_id,baseline_region_code,presented_at,last_presented_at,created_at,updated_at)
   VALUES($1,$2,$3,$1,$4,'Define next step','Agree and record the next step.','readiness','high','deal_owner',$5,'Missing next step','deterministic_evidence_synthesis','presented',$6,$7,'p1',$8,'t1','r1',$7,$7,$7,$7)`,
   [id,tenant,deal,code,new Date(Date.now()+86400000).toISOString(),source,at(11),owner]);return id;
 }
 const d=crypto.randomUUID();await seed(d);const r=await rec(d),body={confirm:true,ownerId:'101',dueAt:new Date(Date.now()+3600000).toISOString(),expectedRevision:'0'};
 let caseId;
 await t.test('conversion accepts the recommendation and atomically links one owned case',async()=>{
  const value=await createRecommendationRemediation(env,user,r,body);caseId=value.caseId;
  assert.equal(value.createdCase,true);assert.equal(value.recommendation.status,'accepted');assert.equal(value.recommendation.remediation.caseId,caseId);
  assert.equal(value.recommendation.remediation.ownerId,'101');
  const count=await first.query("SELECT COUNT(*)::int n FROM audit_events WHERE portal_id=$1 AND action='recommendation.remediation_linked'",[portal]);assert.equal(count.rows[0].n,1);
 });
 await t.test('an exact retry preserves the case and emits no duplicate link audit',async()=>{
  const before=(await first.query('SELECT * FROM remediation_cases WHERE portal_id=$1 AND id=$2',[portal,caseId])).rows[0];
  const value=await createRecommendationRemediation(env,user,r,body);assert.equal(value.alreadyLinked,true);
  assert.deepEqual((await first.query('SELECT * FROM remediation_cases WHERE portal_id=$1 AND id=$2',[portal,caseId])).rows[0],before);
  assert.equal((await first.query("SELECT COUNT(*)::int n FROM audit_events WHERE portal_id=$1 AND action='recommendation.remediation_linked'",[portal])).rows[0].n,1);
  await assert.rejects(createRecommendationRemediation(env,user,r,{...body,ownerId:'102'}),e=>e.status===409);
 });
 await t.test('recommendation completion is atomic and does not resolve the linked case',async()=>{
  const a=await transitionRecommendation(env,user,r,'complete',{});const b=await transitionRecommendation(env,user,r,'complete',{});
  assert.equal(a.completedAt,b.completedAt);assert.equal(b.remediation.status,'open');
  assert.equal((await first.query("SELECT COUNT(*)::int n FROM recommendation_events WHERE recommendation_id=$1 AND event_type='completed'",[r])).rows[0].n,1);
  assert.equal((await first.query('SELECT evaluation_status FROM recommendation_outcomes WHERE recommendation_id=$1',[r])).rows[0].evaluation_status,'pending');
 });
 await t.test('evidence, acknowledgement, comments, resolution and retries preserve separate case state',async()=>{
  await configureRemediationControls(env,user,caseId,{evidenceRequired:true,acknowledgementRequired:true});
  await assert.rejects(transitionRemediationCase(env,user,caseId,'resolve',{note:'Done'}),e=>e.status===409);
  await addRemediationComment(env,user,caseId,'We agreed the next step.');
  await assert.rejects(addRemediationEvidence(env,user,caseId,{type:'text',label:'Denied',value:'Not permitted'}),e=>e.status===403);
  await addRemediationEvidence(env,submitter,caseId,{type:'text',label:'Confirmation',value:'Signed-off next step recorded.'});
  await assert.rejects(reviewRemediationEvidence(env,submitter,caseId,'accepted','Not permitted'),e=>e.status===403);
  await reviewRemediationEvidence(env,reviewer,caseId,'accepted','Verified');
  await assert.rejects(transitionRemediationCase(env,user,caseId,'resolve',{note:'Done'}),e=>e.status===409);
  const ack=await transitionRemediationCase(env,user,caseId,'acknowledge',{});
  const again=await transitionRemediationCase(env,user,caseId,'acknowledge',{});assert.equal(ack.acknowledgedAt,again.acknowledgedAt);
  const resolved=await transitionRemediationCase(env,user,caseId,'resolve',{note:'Evidence verified.'});
  const retried=await transitionRemediationCase(env,user,caseId,'resolve',{note:'Evidence verified.'});assert.equal(resolved.resolvedAt,retried.resolvedAt);
  const detail=await remediationDetail(env,user,caseId);assert.equal(detail.linkedRecommendations[0].recommendation_id,r);assert.equal(detail.comments.length,1);
  assert.equal((await first.query("SELECT COUNT(*)::int n FROM remediation_events WHERE case_id=$1 AND action='resolve'",[caseId])).rows[0].n,1);
 });
 await t.test('reusing an active case never silently overwrites its chosen owner or deadline',async()=>{
  await transitionRemediationCase(env,user,caseId,'reopen',{});
  const r2=await rec(d,portal,at(10),'readiness_next_step');
  const linked=await createRecommendationRemediation(env,user,r2,{...body,ownerId:'102',dueAt:new Date(Date.now()+7200000).toISOString()});
  assert.equal(linked.createdCase,false);assert.equal(linked.caseId,caseId);
  assert.equal(linked.recommendation.remediation.ownerId,'101');assert.equal(linked.recommendation.remediation.dueAt,body.dueAt);
 });
 await t.test('scope belongs to the CRM deal, not the case assignee; all four dimensions constrain collections',async()=>{
  const hidden=crypto.randomUUID();await seed(hidden,'999');
  await first.query(`INSERT INTO remediation_cases(id,portal_id,deal_id,issue_code,title,description,severity,status,priority,owner_id,source,created_at,updated_at)
   VALUES($1,$2,$3,'x','Hidden','Details','warning','open','high','101','manual',$4,$4)`,[crypto.randomUUID(),portal,hidden,at(20)]);
  const list=await listRemediationCases(env,user,new URL('https://example.test'));assert.equal(list.length,1);assert.equal(list[0].id,caseId);
  const sum=await remediationSummary(env,user);assert.equal(sum.open,1);assert.equal(sum.averageResolutionHours,null);
  const id=(await first.query('SELECT id FROM remediation_cases WHERE portal_id=$1 AND deal_id=$2',[portal,hidden])).rows[0].id;
  await assert.rejects(remediationDetail(env,user,id),e=>e.status===403);
  await assert.rejects(addRemediationComment(env,user,id,'Not allowed'),e=>e.status===403);
 });
 await t.test('reassignment blocks later actions and stale assessment compare-and-swap blocks SQL mutation',async()=>{
  const shifted=crypto.randomUUID();const source=await seed(shifted);const rr=await rec(shifted);
  await first.query('UPDATE deal_assessments SET assessed_at=$3 WHERE portal_id=$1 AND deal_id=$2',[portal,shifted,at(30)]);
  await first.query(`INSERT INTO assessment_history(id,portal_id,deal_id,score,grade,status,issue_codes_json,issue_count,pipeline_id,pipeline_label,stage_label,owner_id,team_id,region_code,is_closed,is_won,trigger_type,assessed_at)
   VALUES($1,$2,$3,80,'B','at_risk','[]',0,'p1','Pipeline','Stage','999','t1','r1',0,0,'test',$4)`,[crypto.randomUUID(),portal,shifted,at(30)]);
  await assert.rejects(transitionRecommendation(env,user,rr,'accept',{}),e=>e.status===403);
  const raw=await first.query('SELECT transition_recommendation_work($1,$2,$3,$4,\'accept\',\'401\',\'manager@example.test\',NULL) result',[portal,shifted,rr,source]);assert.equal(raw.rows[0].result.error,'record_changed');
 });
 await t.test('concurrent repeated conversion serializes and creates one link, case and acceptance event',async()=>{
  const dd=crypto.randomUUID();const source=await seed(dd);const rr=await rec(dd);const params=[portal,dd,rr,source,'0','101',body.dueAt,'a'.repeat(64),'401','manager@example.test'];
  await first.query('BEGIN');const a=await first.query('SELECT link_recommendation_remediation($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) result',params);
  let done=false;const b=second.query('SELECT link_recommendation_remediation($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) result',params).then(v=>{done=true;return v;});
  await delay(30);assert.equal(done,false);await first.query('COMMIT');const retry=await b;
  assert.equal(a.rows[0].result.caseId,retry.rows[0].result.caseId);assert.equal(retry.rows[0].result.alreadyLinked,true);
  assert.equal((await first.query("SELECT COUNT(*)::int n FROM recommendation_events WHERE recommendation_id=$1 AND event_type='accepted'",[rr])).rows[0].n,1);
 });
 await t.test('rollback reverses case, link, acceptance event, audit and recommendation status together',async()=>{
  const dd=crypto.randomUUID();const source=await seed(dd);const rr=await rec(dd);
  await first.query('BEGIN');await first.query('SELECT link_recommendation_remediation($1,$2,$3,$4,\'0\',\'101\',$5,$6,\'401\',\'manager@example.test\')',[portal,dd,rr,source,body.dueAt,'b'.repeat(64)]);await first.query('ROLLBACK');
  assert.equal((await first.query('SELECT status FROM recommendation_instances WHERE id=$1',[rr])).rows[0].status,'presented');
  assert.equal((await first.query('SELECT COUNT(*)::int n FROM recommendation_remediation_links WHERE recommendation_id=$1',[rr])).rows[0].n,0);
  assert.equal((await first.query('SELECT COUNT(*)::int n FROM remediation_cases WHERE portal_id=$1 AND deal_id=$2',[portal,dd])).rows[0].n,0);
 });
 await t.test('revision checks survive same-millisecond edits and reject stale reviewed definitions',async()=>{
  const dd=crypto.randomUUID();await seed(dd);const rr=await rec(dd);
  await first.query("UPDATE recommendation_instances SET recommendation_text='Revised action' WHERE id=$1",[rr]);
  await assert.rejects(createRecommendationRemediation(env,user,rr,body),e=>e.status===409);
  const value=await createRecommendationRemediation(env,user,rr,{...body,expectedRevision:'1'});assert.equal(value.createdCase,true);
 });
 await t.test('expiration cannot revert an accepted recommendation or duplicate its terminal event',async()=>{
  const dd=crypto.randomUUID();await seed(dd);const rr=await rec(dd);
  await first.query("UPDATE recommendation_instances SET due_at=$2 WHERE id=$1",[rr,at(40)]);
  await Promise.all([expirePresentedRecommendations(env,portal,dd),expirePresentedRecommendations(f.envFor(second),portal,dd)]);
  assert.equal((await first.query("SELECT COUNT(*)::int n FROM recommendation_events WHERE recommendation_id=$1 AND event_type='expired'",[rr])).rows[0].n,1);
  assert.equal((await first.query('SELECT status FROM recommendation_instances WHERE id=$1',[r])).rows[0].status,'completed');
 });
 await t.test('cross-tenant IDs and cross-deal link constraints fail without leaking case details',async()=>{
  const dd=crypto.randomUUID();await seed(dd,'101',other);const rr=await rec(dd,other);
  await assert.rejects(createRecommendationRemediation(env,user,rr,body),e=>e.status===404);
  const list=await listDealRecommendations(env,user,d,new URL('https://example.test'));assert.ok(list.recommendations.every(item=>item.dealId===d));
  await assert.rejects(first.query(`INSERT INTO recommendation_remediation_links(portal_id,recommendation_id,deal_id,case_id,request_fingerprint,created_at)
   VALUES($1,$2,$3,$4,$5,$6)`,[portal,rr,dd,caseId,'c'.repeat(64),at(20)]),e=>e.code==='23503');
 });
});
