import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, databaseUrl } from './helpers/postgres-fixture.mjs';
import { resolveAssessmentCases } from '../dist/remediation-auto-resolution.js';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
test('automatic resolution respects current source, evidence requirements and transaction boundaries',{skip:!databaseUrl},async t=>{
 const f=await fixture(t,'autoresolve'),{first,second,env,portal,other,at}=f;
 const d=crypto.randomUUID();
 await first.query(`INSERT INTO deal_assessments(portal_id,deal_id,deal_name,pipeline_label,stage_label,score,grade,status,readiness_summary,issues_json,is_closed,is_won,assessed_at)
  VALUES($1,$2,'Deal','Pipeline','Stage',80,'B','ready','Summary','[]',0,0,$3)`,[portal,d,at(10)]);
 const create=async(options={})=>{const id=crypto.randomUUID();await first.query(`INSERT INTO remediation_cases(id,portal_id,deal_id,issue_code,title,description,severity,status,priority,source,created_at,updated_at,evidence_required,evidence_status,acknowledgement_required,acknowledged_at)
  VALUES($1,$2,$3,$1,'Resolve issue','Required evidence','warning','open','high',$4,$5,$5,$6,$7,$8,$9)`,[id,portal,d,options.source??'assessment',at(0),options.evidenceRequired??0,options.evidenceStatus??'not_required',options.ackRequired??0,options.ackAt??null]);return id;};
 const state=async id=>(await first.query('SELECT * FROM remediation_cases WHERE portal_id=$1 AND id=$2',[portal,id])).rows[0];
 const id=await create({evidenceRequired:1,evidenceStatus:'missing',ackRequired:1});
 await t.test('missing evidence and missing acknowledgement independently block automatic resolution',async()=>{
  assert.equal(await resolveAssessmentCases(env,portal,d,at(10)),0);
  await first.query("UPDATE remediation_cases SET evidence_status='accepted' WHERE id=$1",[id]);
  assert.equal(await resolveAssessmentCases(env,portal,d,at(10)),0);
  await first.query('UPDATE remediation_cases SET acknowledged_at=$2 WHERE id=$1',[id,at(2)]);
  assert.equal(await resolveAssessmentCases(env,portal,d,at(10)),1);assert.equal((await state(id)).status,'resolved');
 });
 await t.test('exact retries do not duplicate resolution, audit or outbox events',async()=>{
  const before=await state(id);assert.equal(await resolveAssessmentCases(env,portal,d,at(10)),0);assert.deepEqual(await state(id),before);
  for(const [table,where] of [['remediation_events',"action='auto_resolved'"],['audit_events',"action='remediation.auto_resolved'"],['outbox_events',"event_type='remediation.auto_resolved'"]])
   assert.equal((await first.query(`SELECT COUNT(*)::int n FROM ${table} WHERE portal_id=$1 AND ${where}`,[portal])).rows[0].n,1);
 });
 await t.test('reopening cannot be auto-resolved from the same observation',async()=>{
  await first.query("UPDATE remediation_cases SET status='open',resolved_at=NULL WHERE id=$1",[id]);
  assert.equal(await resolveAssessmentCases(env,portal,d,at(10)),0);
  await first.query('UPDATE deal_assessments SET assessed_at=$3 WHERE portal_id=$1 AND deal_id=$2',[portal,d,at(20)]);
  assert.equal(await resolveAssessmentCases(env,portal,d,at(20)),1);
 });
 await t.test('manual cases are never resolved by automatic issue disappearance',async()=>{
  const manual=await create({source:'manual'});assert.equal(await resolveAssessmentCases(env,portal,d,at(20)),0);assert.equal((await state(manual)).status,'open');
 });
 await t.test('caller timestamp, tenant and malformed issue evidence cannot authorize a resolution',async()=>{
  const pending=await create();
  assert.equal(await resolveAssessmentCases(env,other,d,at(20)),0);assert.equal(await resolveAssessmentCases(env,portal,d,at(10)),0);
  for(const [i,issues] of [[30,'{}'],[40,'[{}]'],[50,'invalid']]) {
   await first.query('UPDATE deal_assessments SET assessed_at=$3,issues_json=$4 WHERE portal_id=$1 AND deal_id=$2',[portal,d,at(i),issues]);
   assert.equal(await resolveAssessmentCases(env,portal,d,at(i)),0);assert.equal((await state(pending)).status,'open');
  }
  await first.query('UPDATE deal_assessments SET assessed_at=$3,issues_json=$4 WHERE portal_id=$1 AND deal_id=$2',[portal,d,at(60),JSON.stringify([{code:pending}])]);
  assert.equal(await resolveAssessmentCases(env,portal,d,at(60)),0);
 });
 await t.test('concurrent resolution waits for the current assessment and commits once',async()=>{
  await first.query("UPDATE deal_assessments SET assessed_at=$3,issues_json='[]' WHERE portal_id=$1 AND deal_id=$2",[portal,d,at(70)]);
  await first.query('BEGIN');assert.equal(await resolveAssessmentCases(env,portal,d,at(70)),1);
  let done=false;const pending=resolveAssessmentCases(f.envFor(second),portal,d,at(70)).then(v=>{done=true;return v;});
  await delay(30);assert.equal(done,false);await first.query('COMMIT');assert.equal(await pending,0);
 });
 await t.test('rollback restores the case and removes audit/outbox/event writes together',async()=>{
  const rollback=await create();const before=(await first.query('SELECT COUNT(*)::int n FROM outbox_events WHERE portal_id=$1',[portal])).rows[0].n;
  await first.query('BEGIN');assert.equal(await resolveAssessmentCases(env,portal,d,at(70)),1);await first.query('ROLLBACK');
  assert.equal((await state(rollback)).status,'open');assert.equal((await first.query('SELECT COUNT(*)::int n FROM outbox_events WHERE portal_id=$1',[portal])).rows[0].n,before);
 });
});
