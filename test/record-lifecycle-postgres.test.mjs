import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture,databaseUrl } from './helpers/postgres-fixture.mjs';
import { verifyRecordState,assertRecordAvailable } from '../dist/record-lifecycle.js';
import { Repository } from '../dist/repository.js';
import { persistDecisionSnapshot } from '../dist/decision-snapshot.js';
import { HubSpotClient } from '../dist/hubspot.js';
import { DEFAULT_SETTINGS } from '../dist/config.js';

test('verified archive/restore state preserves history and fences active evidence',{skip:!databaseUrl},async t=>{
  const {first,second,portal,other,at,env,envFor}=await fixture(t,'archive'),repo=new Repository(env);
  const assessment=(n,won=false)=>({dealId:'1',dealName:'Fixture',pipelineLabel:'Sales',stageLabel:won?'Won':'Open',score:80,grade:'B',status:'ready',issues:[],readinessSummary:'Fixture',isClosed:won,isWon:won,handoffEligible:won,assessedAt:at(n)});
  const payload=n=>({...assessment(n),intelligence:{dealBrief:{generatedAt:at(n+1),status:'on_track',attentionScore:20,confidence:'high',coverage:{percent:100},freshness:{status:'fresh'},risks:[],nextAction:null}}});
  const available=()=>assertRecordAvailable(env,portal,'1');
  await t.test('unseen records retain legacy availability, without fabricating an archive',async()=>{await available();await repo.saveAssessment(portal,assessment(1));await persistDecisionSnapshot(env,portal,'1',payload(1));});
  await t.test('archive cancels active recommendations and brief but retains the original assessment',async()=>{
    const id=randomUUID();await first.query(`INSERT INTO recommendation_instances(id,portal_id,deal_id,recommendation_fingerprint,recommendation_code,recommendation_label,
      recommendation_text,recommendation_dimension,priority,owner_role,rationale,methodology,status,presented_at,last_presented_at,
      baseline_assessment_at,baseline_snapshot_generated_at,created_at,updated_at)
      VALUES($1,$2,'1',$1,'test','Fixture','Fixture','readiness','high','deal_owner','Fixture','test','accepted',$3,$3,$3,$4,$3,$3)`,[id,portal,at(1),at(2)]);
    assert.equal(await verifyRecordState(env,portal,'1','archived',at(3),'webhook'),true);
    await assert.rejects(available(),{code:'deal_archived'});
    assert.equal(await repo.getAssessment(portal,'1'),null);
    const raw=(await first.query('SELECT is_closed,is_won,assessed_at FROM deal_assessments WHERE portal_id=$1',[portal])).rows[0];
    assert.deepEqual(raw,{is_closed:0,is_won:0,assessed_at:at(1)});
    assert.equal((await first.query('SELECT count(*) FROM deal_decision_snapshots WHERE portal_id=$1',[portal])).rows[0].count,'0');
    assert.equal((await first.query('SELECT terminal_reason FROM recommendation_instances WHERE id=$1',[id])).rows[0].terminal_reason,'deal_archived');
  });
  await t.test('a late open assessment cannot resurrect an archived deal',async()=>{
    assert.equal(await repo.saveAssessment(portal,assessment(4)),false);
    assert.equal(await persistDecisionSnapshot(env,portal,'1',payload(1)),false);
  });
  await t.test('stale and duplicate verification cannot undo newer archive evidence',async()=>{
    assert.equal(await verifyRecordState(env,portal,'1','active',at(2),'record_read'),false);
    assert.equal(await verifyRecordState(env,portal,'1','archived',at(3),'webhook'),false);await assert.rejects(available());
  });
  await t.test('verified restore permits a new assessment without reactivating prior recommendations',async()=>{
    assert.equal(await verifyRecordState(env,portal,'1','active',at(5),'webhook'),true);await available();
    assert.equal(await repo.saveAssessment(portal,assessment(6)),true);
    assert.equal((await first.query("SELECT count(*) FROM recommendation_instances WHERE portal_id=$1 AND status='accepted'",[portal])).rows[0].count,'0');
    const rows=await first.query('SELECT dealguard.record_was_available($1,\'1\',$2::timestamptz) AS before,dealguard.record_was_available($1,\'1\',$3::timestamptz) AS during,dealguard.record_was_available($1,\'1\',$4::timestamptz) AS after',[portal,at(2),at(4),at(6)]);
    assert.deepEqual(rows.rows[0],{before:true,during:false,after:true});
  });
  await t.test('same deal IDs in separate portals never share tombstones',async()=>{
    await new Repository(env).saveAssessment(other,assessment(6));await assertRecordAvailable(env,other,'1');
    await verifyRecordState(env,portal,'1','archived',at(7),'webhook');await assertRecordAvailable(env,other,'1');
  });
  await t.test('archiving a won deal ends the handoff clock without deleting its cycle',async()=>{
    await verifyRecordState(env,portal,'1','active',at(8),'webhook');await repo.saveAssessment(portal,assessment(9,true));
    await verifyRecordState(env,portal,'1','archived',at(10),'webhook');
    const cycle=(await first.query('SELECT status,end_reason FROM handoff_cycles WHERE portal_id=$1',[portal])).rows[0];
    assert.deepEqual(cycle,{status:'cancelled',end_reason:'deal_archived'});
  });
  await t.test('a snapshot waiting for archive cannot survive after archive commits',async()=>{
    await verifyRecordState(env,portal,'1','active',at(11),'webhook');await repo.saveAssessment(portal,assessment(12));
    await first.query('BEGIN');await verifyRecordState(env,portal,'1','archived',at(14),'webhook');
    const wait=persistDecisionSnapshot(envFor(second),portal,'1',payload(12));
    assert.equal(await Promise.race([wait.then(()=>true),new Promise(r=>setTimeout(()=>r(false),100))]),false);
    await first.query('COMMIT');assert.equal(await wait,false);
  });
  await t.test('an assessment waiting for archive cannot re-enter current state',async()=>{
    await verifyRecordState(env,portal,'1','active',at(15),'webhook');
    await first.query('BEGIN');await verifyRecordState(env,portal,'1','archived',at(16),'webhook');
    const wait=new Repository(envFor(second)).saveAssessment(portal,assessment(17));
    assert.equal(await Promise.race([wait.then(()=>true),new Promise(r=>setTimeout(()=>r(false),100))]),false);
    await first.query('COMMIT');assert.equal(await wait,false);
  });
  await t.test('rollback restores the state and active evidence together',async()=>{
    await verifyRecordState(env,portal,'1','active',at(18),'webhook');await repo.saveAssessment(portal,assessment(19));await persistDecisionSnapshot(env,portal,'1',payload(19));
    await first.query('BEGIN');await verifyRecordState(env,portal,'1','archived',at(21),'webhook');await first.query('ROLLBACK');await available();
    assert.equal((await first.query('SELECT count(*) FROM deal_decision_snapshots WHERE portal_id=$1',[portal])).rows[0].count,'1');
  });
  await t.test('real HubSpot client requires affirmative flags, and 404 is not deletion evidence',async()=>{
    const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
    const c=new HubSpotClient(env,{tenant:{portal_id:portal,token_expires_at:new Date(Date.now()+86400000).toISOString()},accessToken:'test-only',settings:DEFAULT_SETTINGS});
    globalThis.fetch=async input=>new Response(JSON.stringify({id:'2',archived:true,properties:{}}),{status:200});
    assert.equal(await c.reconcileDealLifecycle('2'),'archived');
    globalThis.fetch=async()=>new Response('{}',{status:404});
    await assert.rejects(c.reconcileDealLifecycle('3'),{code:'hubspot_record_not_found'});await assertRecordAvailable(env,portal,'3');
    globalThis.fetch=async()=>new Response(JSON.stringify({id:'4',properties:{}}),{status:200});
    await assert.rejects(c.reconcileDealLifecycle('4'),{code:'record_state_unverified'});
  });
});
