import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, databaseUrl } from './helpers/postgres-fixture.mjs';
import { createChangeApproval, decideChangeApproval } from '../dist/enterprise-access.js';
import { applyApprovedEnterpriseRoleChange, beginApprovedChange, completeApprovedChange, failApprovedChange } from '../dist/change-control.js';

const scope={pipelineIds:[],teamIds:[],ownerIds:[],regionCodes:[]};
const payload=(userId='20',role='viewer')=>({userId,userEmail:`user${userId}@example.test`,role,permissions:[],scope});
const roleChange=(value=payload())=>({changeType:'role.assign',resourceType:'enterprise_role',resourceId:value.userId,payload:value});
async function setup(t) {
  const f=await fixture(t,'approval-atomic');
  const actors=['7','8','9'].map(userId=>({portalId:f.portal,userId,userEmail:`user${userId}@example.test`}));
  for(const actor of actors)await f.first.query(`INSERT INTO enterprise_role_assignments(id,portal_id,user_id,user_email,role,created_at,updated_at)
    VALUES($1,$2,$3,$4,'administrator',$5,$5)`,[randomUUID(),f.portal,actor.userId,actor.userEmail,f.at(0)]);
  const request=async(change=roleChange())=>createChangeApproval(f.env,actors[0],change);
  const approve=async(change=roleChange())=>{const r=await request(change);await decideChangeApproval(f.env,actors[1],r.id,'approved','Exact change reviewed');return r.id;};
  const read=async(id)=>(await f.first.query('SELECT * FROM change_approval_requests WHERE portal_id=$1 AND id=$2',[f.portal,id])).rows[0];
  return {...f,actors,request,approve,read};
}

test('atomic approval rechecks authority, target and lease before applying',{skip:!databaseUrl,timeout:60000},async t=>{
  await t.test('concurrent approve and reject produce exactly one decision and its audit',async t=>{
    const f=await setup(t),r=await f.request();
    const results=await Promise.allSettled([decideChangeApproval(f.env,f.actors[1],r.id,'approved','accept'),
      decideChangeApproval(f.envFor(f.second),f.actors[2],r.id,'rejected','reject')]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(results.find(r=>r.status==='rejected').reason.code,'change_approval_decided');
    const audits=(await f.first.query("SELECT action FROM audit_events WHERE portal_id=$1 AND action IN ('change_approval.approved','change_approval.rejected')",[f.portal])).rows;
    assert.equal(audits.length,1);assert.equal(audits[0].action,`change_approval.${(await f.read(r.id)).status}`);
  });
  for(const mutation of ["role='viewer'","owner_ids_json='[\"restricted\"]'"]){
    await t.test(`reviewer changed before application (${mutation})`,async t=>{
      const f=await setup(t),id=await f.approve();
      await f.first.query(`UPDATE enterprise_role_assignments SET ${mutation} WHERE portal_id=$1 AND user_id='8'`,[f.portal]);
      await assert.rejects(applyApprovedEnterpriseRoleChange(f.env,f.actors[0],id,roleChange()),{code:'change_approval_authority_changed'});
      assert.equal((await f.read(id)).status,'approved');
      assert.equal((await f.first.query("SELECT COUNT(*)::int n FROM enterprise_role_assignments WHERE portal_id=$1 AND user_id='20'",[f.portal])).rows[0].n,0);
    });
  }
  await t.test('a revoked requester cannot have their old request reviewed or executed',async t=>{
    const f=await setup(t),r=await f.request();
    await f.first.query("UPDATE enterprise_role_assignments SET role='viewer' WHERE portal_id=$1 AND user_id='7'",[f.portal]);
    await assert.rejects(decideChangeApproval(f.env,f.actors[1],r.id,'approved','stale request'),{code:'change_requester_revoked'});
    const g=await setup(t),id=await g.approve();
    await g.first.query("UPDATE enterprise_role_assignments SET role='viewer' WHERE portal_id=$1 AND user_id='7'",[g.portal]);
    await assert.rejects(applyApprovedEnterpriseRoleChange(g.env,g.actors[2],id,roleChange()),{code:'change_approval_authority_changed'});
  });
  await t.test('target evidence binds removal and new assignment without altering the approved payload',async t=>{
    const f=await setup(t),value=payload('9','reviewer'),change=roleChange(value),id=await f.approve(change);
    await f.first.query("UPDATE enterprise_role_assignments SET permissions_json='[\"ai.use\"]' WHERE portal_id=$1 AND user_id='9'",[f.portal]);
    await assert.rejects(applyApprovedEnterpriseRoleChange(f.env,f.actors[0],id,change),{code:'change_approval_target_changed'});
    const revised=await f.request(change);assert.notEqual(revised.id,id,'changed target needs a new independently reviewable request');
    assert.equal((await f.read(revised.id)).target_state_json.permissions_json,'["ai.use"]');
    const absentId=await f.approve();
    await f.first.query(`INSERT INTO enterprise_role_assignments(id,portal_id,user_id,role,created_at,updated_at)
      VALUES($1,$2,'20','administrator',$3,$3)`,[randomUUID(),f.portal,f.at(0)]);
    await assert.rejects(applyApprovedEnterpriseRoleChange(f.env,f.actors[0],absentId,roleChange()),{code:'change_approval_target_changed'});
  });
  await t.test('self-demotion commits its role and completed approval together',async t=>{
    const f=await setup(t),change=roleChange(payload('7')),id=await f.approve(change);
    const result=await applyApprovedEnterpriseRoleChange(f.env,f.actors[0],id,change);assert.equal(result.ok,true);
    assert.equal((await f.read(id)).status,'applied');
    assert.equal((await f.first.query("SELECT role FROM enterprise_role_assignments WHERE portal_id=$1 AND user_id='7'",[f.portal])).rows[0].role,'viewer');
    assert.equal((await f.first.query('SELECT status FROM change_approval_executions WHERE portal_id=$1 AND approval_id=$2',[f.portal,id])).rows[0].status,'completed');
  });
  await t.test('audit failure rolls back role mutation, execution and approval completion',async t=>{
    const f=await setup(t),id=await f.approve(),suffix=randomUUID().replaceAll('-',''),name=`reject_approval_${suffix}`;
    await f.first.query(`CREATE FUNCTION dealguard.${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.portal_id='${f.portal}' AND NEW.action='change.applied' THEN RAISE EXCEPTION 'synthetic approval audit failure'; END IF; RETURN NEW; END $$`);
    await f.first.query(`CREATE TRIGGER ${name} BEFORE INSERT ON dealguard.audit_events FOR EACH ROW EXECUTE FUNCTION dealguard.${name}()`);
    try {
    await assert.rejects(applyApprovedEnterpriseRoleChange(f.env,f.actors[0],id,roleChange()),/synthetic approval audit failure/);
    assert.equal((await f.read(id)).status,'approved');
    assert.equal((await f.first.query('SELECT COUNT(*)::int n FROM change_approval_executions WHERE portal_id=$1',[f.portal])).rows[0].n,0);
    assert.equal((await f.first.query("SELECT COUNT(*)::int n FROM enterprise_role_assignments WHERE portal_id=$1 AND user_id='20'",[f.portal])).rows[0].n,0);
    } finally { await f.first.query(`DROP TRIGGER IF EXISTS ${name} ON dealguard.audit_events`);await f.first.query(`DROP FUNCTION IF EXISTS dealguard.${name}()`); }
  });
  await t.test('lease replacement fences stale success and failure acknowledgments',async t=>{
    const f=await setup(t),change={changeType:'billing.plan.change',resourceType:'subscription',resourceId:f.portal,payload:{tier:'enterprise'}},id=await f.approve(change);
    const first=await beginApprovedChange(f.env,f.actors[0],id,change);
    await f.first.query('UPDATE change_approval_executions SET lease_token=NULL WHERE portal_id=$1 AND approval_id=$2',[f.portal,id]);
    await assert.rejects(completeApprovedChange(f.env,f.actors[0],id,null),{code:'change_completion_conflict'});
    await f.first.query('UPDATE change_approval_executions SET lease_token=$3 WHERE portal_id=$1 AND approval_id=$2',[f.portal,id,first.leaseToken]);
    await assert.rejects(beginApprovedChange(f.envFor(f.second),f.actors[0],id,change),{code:'change_application_in_progress'});
    await f.first.query('UPDATE change_approval_executions SET lease_expires_at=$3 WHERE portal_id=$1 AND approval_id=$2',[f.portal,id,f.at(0)]);
    const second=await beginApprovedChange(f.envFor(f.second),f.actors[0],id,change);assert.notEqual(first.leaseToken,second.leaseToken);
    await assert.rejects(completeApprovedChange(f.env,f.actors[0],id,first.leaseToken),{code:'change_completion_conflict'});
    await failApprovedChange(f.env,f.actors[0],id,first.leaseToken,new Error('stale failure must not persist'));
    assert.equal((await f.first.query('SELECT status,lease_token FROM change_approval_executions WHERE portal_id=$1 AND approval_id=$2',[f.portal,id])).rows[0].lease_token,second.leaseToken);
    await completeApprovedChange(f.envFor(f.second),f.actors[0],id,second.leaseToken);
    assert.equal((await f.read(id)).status,'applied');
  });
  await t.test('reserved bootstrap cannot enter generic requests and cross-portal approval IDs cannot execute',async t=>{
    const f=await setup(t);
    await assert.rejects(f.request({changeType:'role.bootstrap',resourceType:'tenant',resourceId:f.portal,payload:{}}),{code:'change_request_forbidden'});
    const id=await f.approve(),g=await setup(t);
    await assert.rejects(applyApprovedEnterpriseRoleChange(g.env,g.actors[0],id,roleChange()),{code:'change_approval_not_found'});
  });
});
