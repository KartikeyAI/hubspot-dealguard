import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, databaseUrl } from './helpers/postgres-fixture.mjs';
import { createRemediationCase, dispatchPendingRemediationTasks } from '../dist/remediation.js';
import { HubSpotClient } from '../dist/hubspot.js';

async function setup(t){
 const f=await fixture(t,'remediation-delivery');
 const actor={portalId:f.portal,userId:'7',userEmail:'installer@example.test',appId:null};
 await f.first.query("UPDATE tenants SET installer_email='installer@example.test' WHERE portal_id=$1",[f.portal]);
 await f.first.query("INSERT INTO enterprise_role_assignments(id,portal_id,user_id,role,created_at,updated_at)VALUES($1,$2,'7','administrator',$3,$3)",[randomUUID(),f.portal,f.at(0)]);
 await f.first.query(`INSERT INTO deal_assessments(portal_id,deal_id,deal_name,pipeline_label,stage_label,score,grade,status,issues_json,readiness_summary,is_closed,is_won,assessed_at)
  VALUES($1,'101','Recorded deal','Pipeline','Stage',55,'D','critical','[{"code":"gap","severity":"critical"}]','Summary',0,0,$2)`,[f.portal,f.at(10)]);
 await f.first.query("INSERT INTO assessment_context(portal_id,deal_id,pipeline_id,owner_id,stage_id,updated_at)VALUES($1,'101','p1','1','s1',$2)",[f.portal,f.at(10)]);
 const input={dealId:'101',issueCode:'gap',title:'Review missing evidence',description:'Complete the current evidence review.',severity:'critical',priority:'high',dueAt:f.at(20),createHubSpotTask:false};
 const state=async id=>(await f.first.query('SELECT * FROM remediation_cases WHERE portal_id=$1 AND id=$2',[f.portal,id])).rows[0];
 return {...f,actor,input,state};
}
const pause=()=>new Promise(r=>setTimeout(r,30));

test('remediation mutations are scoped, atomic and safe to replay',{skip:!databaseUrl},async t=>{
 await t.test('legacy installer privileges cannot bypass an assigned viewer or record scope',async t=>{
  const f=await setup(t);await f.first.query("UPDATE enterprise_role_assignments SET role='viewer' WHERE portal_id=$1",[f.portal]);
  await assert.rejects(createRemediationCase(f.env,f.actor,f.input),{code:'record_permission_denied'});
  await f.first.query("UPDATE enterprise_role_assignments SET role='sales_manager',owner_ids_json='[\"2\"]' WHERE portal_id=$1",[f.portal]);
  await assert.rejects(createRemediationCase(f.env,f.actor,f.input),{code:'record_scope_denied'});
  assert.equal((await f.first.query('SELECT COUNT(*)::int n FROM remediation_cases WHERE portal_id=$1',[f.portal])).rows[0].n,0);
 });
 await t.test('two simultaneous creations return one case with one event, audit and outbox intent',async t=>{
  const f=await setup(t);await f.first.query('BEGIN');const first=await createRemediationCase(f.env,f.actor,f.input);
  let done=false;const pending=createRemediationCase(f.envFor(f.second),f.actor,f.input).then(v=>{done=true;return v;});
  await pause();assert.equal(done,false);await f.first.query('COMMIT');assert.equal((await pending).id,first.id);
  for(const [table,filter] of [['remediation_cases','TRUE'],['remediation_events',"action='created'"],['audit_events',"action='remediation.created'"],['outbox_events',"event_type='remediation.created'"]]){
   assert.equal((await f.first.query(`SELECT COUNT(*)::int n FROM ${table} WHERE portal_id=$1 AND ${filter}`,[f.portal])).rows[0].n,1);
  }
 });
 await t.test('outbox failure rolls back case, event and audit together',async t=>{
  const f=await setup(t),name='reject_remediation_'+randomUUID().replaceAll('-','');
  await f.first.query(`CREATE FUNCTION pg_temp.${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.portal_id='${f.portal}' AND NEW.event_type='remediation.created' THEN RAISE EXCEPTION 'injected outbox failure'; END IF;RETURN NEW;END;$$`);
  await f.first.query(`CREATE TRIGGER ${name} BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION pg_temp.${name}()`);
  try{await assert.rejects(createRemediationCase(f.env,f.actor,f.input),/injected outbox failure/);}
  finally{await f.first.query(`DROP TRIGGER ${name} ON outbox_events`);}
  for(const table of ['remediation_cases','remediation_events','audit_events','outbox_events'])assert.equal((await f.first.query(`SELECT COUNT(*)::int n FROM ${table} WHERE portal_id=$1`,[f.portal])).rows[0].n,0);
 });
 await t.test('automatic creation requires the current open critical issue, never a stale caller payload',async t=>{
  const f=await setup(t),system={...f.actor,userId:null,userEmail:null};
  await f.first.query("UPDATE deal_assessments SET assessed_at=$2,issues_json='[]' WHERE portal_id=$1",[f.portal,f.at(30)]);
  await assert.rejects(createRemediationCase(f.env,system,{...f.input,assessmentAt:f.at(10)},'assessment'),{code:'recommendation_record_changed'});
  await assert.rejects(createRemediationCase(f.env,system,{...f.input,assessmentAt:f.at(30)},'assessment'),{code:'recommendation_record_changed'});
  assert.equal((await f.first.query('SELECT COUNT(*)::int n FROM remediation_cases WHERE portal_id=$1',[f.portal])).rows[0].n,0);
 });
 await t.test('a signed workflow can create its explicit case before the first assessment',async t=>{
  const f=await setup(t);const result=await createRemediationCase(f.env,{...f.actor,userId:null,userEmail:null},{...f.input,dealId:'202'},'workflow');
  assert.equal(result.dealId,'202');assert.equal(result.source,'workflow');assert.equal(result.hubSpotTaskDelivery.status,'not_requested');
 });
 await t.test('successful task dispatch is performed once and exact retries retain its receipt',async t=>{
  const f=await setup(t),saved=HubSpotClient.forPortal;let calls=0;
  HubSpotClient.forPortal=async()=>({async createRemediationTask(){calls++;return'456';}});t.after(()=>{HubSpotClient.forPortal=saved;});
  const first=await createRemediationCase(f.env,f.actor,{...f.input,createHubSpotTask:true});
  const second=await createRemediationCase(f.env,f.actor,{...f.input,createHubSpotTask:true});
  assert.equal(calls,1);assert.equal(first.id,second.id);assert.equal(second.hubSpotTaskId,'456');assert.equal(second.hubSpotTaskDelivery.status,'created');
  assert.equal((await f.first.query("SELECT COUNT(*)::int n FROM remediation_events WHERE portal_id=$1 AND action='hubspot_task_created'",[f.portal])).rows[0].n,1);
 });
 await t.test('an uncertain task response is retained for reconciliation and cannot be replayed',async t=>{
  const f=await setup(t),saved=HubSpotClient.forPortal;let calls=0;
  HubSpotClient.forPortal=async()=>({async createRemediationTask(){calls++;throw new Error('private-provider-response');}});t.after(()=>{HubSpotClient.forPortal=saved;});
  const first=await createRemediationCase(f.env,f.actor,{...f.input,createHubSpotTask:true});
  assert.equal(first.hubSpotTaskDelivery.status,'held');assert.equal(first.hubSpotTaskDelivery.reason,'hubspot_task_delivery_unconfirmed');
  const second=await createRemediationCase(f.env,f.actor,{...f.input,createHubSpotTask:true});await dispatchPendingRemediationTasks(f.env);
  assert.equal(calls,1);assert.equal(first.id,second.id);assert(!JSON.stringify(await f.state(first.id)).includes('private-provider-response'));
 });
 await t.test('duplicate creation cannot turn a local-only case into an external task',async t=>{
  const f=await setup(t),saved=HubSpotClient.forPortal;let calls=0;
  HubSpotClient.forPortal=async()=>({async createRemediationTask(){calls++;return'456';}});t.after(()=>{HubSpotClient.forPortal=saved;});
  const first=await createRemediationCase(f.env,f.actor,f.input);
  const second=await createRemediationCase(f.env,f.actor,{...f.input,createHubSpotTask:true});
  assert.equal(first.id,second.id);assert.equal(calls,0);assert.equal(second.hubSpotTaskDelivery.status,'not_requested');
 });
 await t.test('only one task sender can claim; late failure cannot overwrite a success',async t=>{
  const f=await setup(t),payload={issueCode:'gap',title:'Task',description:'Review',severity:'warning',priority:'high',dueAt:f.at(20),createTask:true};
  const id=(await f.first.query("SELECT dealguard.create_remediation_work($1,'101',$2,'manual',$3::jsonb,'7',NULL) AS result",[f.portal,f.at(10),JSON.stringify(payload)])).rows[0].result.caseId;
  await f.first.query('BEGIN');assert.equal((await f.first.query("SELECT dealguard.claim_remediation_task($1,'101',$2,$3,'one') AS claimed",[f.portal,id,f.at(10)])).rows[0].claimed,true);
  let done=false;const pending=f.second.query("SELECT dealguard.claim_remediation_task($1,'101',$2,$3,'two') AS claimed",[f.portal,id,f.at(10)]).then(v=>{done=true;return v;});
  await pause();assert.equal(done,false);await f.first.query('COMMIT');assert.equal((await pending).rows[0].claimed,false);
  assert.equal((await f.first.query("SELECT dealguard.finish_remediation_task($1,$2,'one','789') AS changed",[f.portal,id])).rows[0].changed,true);
  assert.equal((await f.first.query("SELECT dealguard.finish_remediation_task($1,$2,'one',NULL) AS changed",[f.portal,id])).rows[0].changed,false);
  assert.equal((await f.state(id)).hubspot_task_id,'789');
 });
 await t.test('queued automatic tasks are held when a newer assessment removes their issue',async t=>{
  const f=await setup(t),payload={issueCode:'gap',title:'Task',description:'Review',severity:'critical',priority:'high',dueAt:f.at(20),createTask:true};
  const id=(await f.first.query("SELECT dealguard.create_remediation_work($1,'101',$2,'assessment',$3::jsonb,NULL,NULL) AS result",[f.portal,f.at(10),JSON.stringify(payload)])).rows[0].result.caseId;
  await f.first.query("UPDATE deal_assessments SET assessed_at=$2,issues_json='[]' WHERE portal_id=$1",[f.portal,f.at(30)]);
  assert.equal((await f.first.query("SELECT dealguard.claim_remediation_task($1,'101',$2,$3,'task') AS claimed",[f.portal,id,f.at(30)])).rows[0].claimed,false);
  assert.equal((await f.state(id)).task_delivery_state,'held');assert.equal((await f.state(id)).task_delivery_error,'task_source_changed');
 });
 await t.test('a late success receipt resolves an uncertain send without creating another task',async t=>{
  const f=await setup(t),payload={issueCode:'gap',title:'Task',description:'Review',severity:'warning',priority:'high',dueAt:f.at(20),createTask:true};
  const id=(await f.first.query("SELECT dealguard.create_remediation_work($1,'101',$2,'manual',$3::jsonb,'7',NULL) AS result",[f.portal,f.at(10),JSON.stringify(payload)])).rows[0].result.caseId;
  await f.first.query("SELECT dealguard.claim_remediation_task($1,'101',$2,$3,'task')",[f.portal,id,f.at(10)]);
  assert.equal((await f.first.query("SELECT dealguard.finish_remediation_task($1,$2,'task',NULL) AS changed",[f.portal,id])).rows[0].changed,true);
  assert.equal((await f.first.query("SELECT dealguard.finish_remediation_task($1,$2,'task',NULL) AS changed",[f.portal,id])).rows[0].changed,false);
  assert.equal((await f.first.query("SELECT dealguard.finish_remediation_task($1,$2,'task','987') AS changed",[f.portal,id])).rows[0].changed,true);
  assert.equal((await f.state(id)).hubspot_task_id,'987');assert.equal((await f.state(id)).task_delivery_state,'created');
 });
 await t.test('a resolved case cannot produce an overdue event from a stale scanner',async t=>{
  const f=await setup(t),c=await createRemediationCase(f.env,f.actor,f.input),row=await f.state(c.id);
  await f.first.query("UPDATE remediation_cases SET status='resolved' WHERE portal_id=$1 AND id=$2",[f.portal,c.id]);
  const result=await f.first.query("SELECT dealguard.escalate_remediation_work($1,'101',$2,$3,$4) AS changed",[f.portal,c.id,f.at(10),String(row.work_revision)]);
  assert.equal(result.rows[0].changed,false);assert.equal((await f.first.query("SELECT COUNT(*)::int n FROM outbox_events WHERE portal_id=$1 AND event_type='remediation.overdue'",[f.portal])).rows[0].n,0);
 });
 await t.test('concurrent overdue transitions emit exactly one notification intent',async t=>{
  const f=await setup(t),c=await createRemediationCase(f.env,f.actor,f.input),row=await f.state(c.id),args=[f.portal,c.id,f.at(10),String(row.work_revision)];
  const sql="SELECT dealguard.escalate_remediation_work($1,'101',$2,$3,$4) AS changed";
  await f.first.query('BEGIN');assert.equal((await f.first.query(sql,args)).rows[0].changed,true);
  const pending=f.second.query(sql,args);await pause();await f.first.query('COMMIT');assert.equal((await pending).rows[0].changed,false);
  assert.equal((await f.first.query("SELECT COUNT(*)::int n FROM outbox_events WHERE portal_id=$1 AND event_type='remediation.overdue'",[f.portal])).rows[0].n,1);
 });
});
