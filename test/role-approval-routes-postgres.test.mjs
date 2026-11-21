import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture,databaseUrl } from './helpers/postgres-fixture.mjs';
import { signedUiRequest } from './helpers/signed-ui-request.mjs';
import { route } from '../dist/routes-v17.js';
import { errorResponse } from '../dist/http.js';
import { governanceContext, requireGovernancePermission } from '../dist/governance.js';

const secret='synthetic-role-flow-secret';
const root='/api/v1/enterprise';
const scope={pipelineIds:[],ownerIds:[],teamIds:[],regionCodes:[]};
const assignment={userId:'9',userEmail:'reviewer@example.test',role:'reviewer',permissions:['forecast.approve'],scope};
async function setup(t) {
  const f=await fixture(t,'signed-role'),portal=String(Date.now())+String(Math.floor(Math.random()*1000000)).padStart(6,'0');f.portalIds.push(portal);
  await f.first.query(`INSERT INTO tenants(portal_id,app_id,access_token_cipher,access_token_iv,refresh_token_cipher,refresh_token_iv,token_expires_at,settings_json,installed_at,updated_at,next_scan_at,commercial_tier,trial_ends_at,installer_email)
    SELECT $1,'1','unused','unused','unused','unused',token_expires_at,settings_json,installed_at,updated_at,next_scan_at,commercial_tier,trial_ends_at,'installer@example.test' FROM tenants WHERE portal_id=$2`,[portal,f.portal]);
  const first={portalId:portal,userId:'7',userEmail:'installer@example.test',appId:'1'},second={...first,userId:'8',userEmail:'approver@example.test'};
  for(const actor of [first,second])await f.first.query(`INSERT INTO enterprise_role_assignments(id,portal_id,user_id,user_email,role,created_at,updated_at)
    VALUES($1,$2,$3,$4,'administrator',$5,$5)`,[randomUUID(),portal,actor.userId,actor.userEmail,f.at(0)]);
  const env={...f.env,HUBSPOT_CLIENT_SECRET:secret,HUBSPOT_APP_ID:'1'};
  const invoke=async(actor,path,method='GET',value)=>{
    let response;try{response=await route(signedUiRequest(secret,actor,path,method,value),env,{waitUntil(){throw new Error('Role management must not enqueue provider work');}});}catch(error){response=errorResponse(error,'signed-role-test');}
    return {status:response.status,data:await response.json()};
  };
  return {...f,portal,firstActor:first,secondActor:second,env,invoke};
}

test('signed v17 role flow requires independent approval and applies only the exact stored payload', {skip:!databaseUrl,timeout:30000}, async t=>{
  const f=await setup(t);
  const proposed=await f.invoke(f.firstActor,`${root}/roles`,'PUT',assignment);
  assert.equal(proposed.status,409);assert.equal(proposed.data.error.code,'change_approval_created');
  const id=proposed.data.error.details.approvalId;assert.ok(id);
  assert.equal((await f.first.query("SELECT COUNT(*)::int n FROM enterprise_role_assignments WHERE portal_id=$1 AND user_id='9'",[f.portal])).rows[0].n,0);
  const pending=await f.invoke(f.firstActor,`${root}/change-approvals?status=pending`);
  assert.equal(pending.status,200);assert.equal(pending.data.approvals.find(row=>row.id===id).resourceId,'9');
  const self=await f.invoke(f.firstActor,`${root}/change-approvals/${id}/approve`,'POST',{comment:'Attempted self approval'});
  assert.equal(self.status,409);assert.equal(self.data.error.code,'change_self_approval_forbidden');
  const approved=await f.invoke(f.secondActor,`${root}/change-approvals/${id}/approve`,'POST',{comment:'Reviewed the named reviewer and its exact scope.'});
  assert.equal(approved.status,200);assert.equal(approved.data.status,'approved');
  const mismatch=await f.invoke(f.firstActor,`${root}/roles?approvalId=${id}`,'PUT',{...assignment,role:'administrator'});
  assert.equal(mismatch.status,409);assert.equal(mismatch.data.error.code,'change_approval_payload_mismatch');
  const applied=await f.invoke(f.firstActor,`${root}/roles?approvalId=${id}`,'PUT',assignment);
  assert.equal(applied.status,200);assert.equal(applied.data.ok,true);
  const row=(await f.first.query("SELECT role,permissions_json FROM enterprise_role_assignments WHERE portal_id=$1 AND user_id='9'",[f.portal])).rows[0];
  assert.equal(row.role,'reviewer');assert.deepEqual(JSON.parse(row.permissions_json),['forecast.approve']);
  const approvedRow=(await f.first.query('SELECT status,requested_by_user_id,decided_by_user_id FROM change_approval_requests WHERE portal_id=$1 AND id=$2',[f.portal,id])).rows[0];
  assert.deepEqual(approvedRow,{status:'applied',requested_by_user_id:'7',decided_by_user_id:'8'});
  assert.equal((await f.first.query('SELECT status FROM change_approval_executions WHERE portal_id=$1 AND approval_id=$2',[f.portal,id])).rows[0].status,'completed');
  const replay=await f.invoke(f.firstActor,`${root}/roles?approvalId=${id}`,'PUT',assignment);assert.equal(replay.status,409);
  assert.equal((await f.first.query("SELECT COUNT(*)::int n FROM audit_events WHERE portal_id=$1 AND action='enterprise_role.assigned'",[f.portal])).rows[0].n,1);
});

test('signed role approval rejects unapproved execution, unauthorized requests and expired review', {skip:!databaseUrl,timeout:30000}, async t=>{
  const f=await setup(t);
  const proposed=await f.invoke(f.firstActor,`${root}/roles`,'PUT',assignment),id=proposed.data.error.details.approvalId;
  const early=await f.invoke(f.firstActor,`${root}/roles?approvalId=${id}`,'PUT',assignment);assert.equal(early.status,409);
  const outsider={...f.firstActor,userId:'10',userEmail:'viewer@example.test'};
  const denied=await f.invoke(outsider,`${root}/roles`,'PUT',{...assignment,userId:'11'});assert.equal(denied.status,403);
  const decide=await f.invoke(outsider,`${root}/change-approvals/${id}/approve`,'POST',{comment:'unauthorized'});assert.equal(decide.status,403);
  await f.first.query('UPDATE change_approval_requests SET expires_at=$3 WHERE portal_id=$1 AND id=$2',[f.portal,id,f.at(0)]);
  const expired=await f.invoke(f.secondActor,`${root}/change-approvals/${id}/approve`,'POST',{comment:'Too late'});
  assert.equal(expired.status,409);assert.equal(expired.data.error.code,'change_approval_expired');
  assert.equal((await f.first.query("SELECT COUNT(*)::int n FROM enterprise_role_assignments WHERE portal_id=$1 AND user_id IN ('9','11')",[f.portal])).rows[0].n,0);
});

test('signed removal approval exposes its exact target and cannot delete a subsequently changed assignment', {skip:!databaseUrl,timeout:30000}, async t=>{
  const f=await setup(t),target=randomUUID();
  await f.first.query(`INSERT INTO enterprise_role_assignments(id,portal_id,user_id,user_email,role,permissions_json,owner_ids_json,created_at,updated_at)
    VALUES($1,$2,'9','target@example.test','reviewer','["forecast.approve"]','["21"]',$3,$3)`,[target,f.portal,f.at(0)]);
  const path=`${root}/roles/${target}`;
  const proposed=await f.invoke(f.firstActor,path,'DELETE');assert.equal(proposed.status,409);
  const id=proposed.data.error.details.approvalId;
  const listed=(await f.invoke(f.secondActor,`${root}/change-approvals`)).data.approvals.find(row=>row.id===id);
  assert.deepEqual(listed.payload,{});assert.equal(listed.targetState.id,target);assert.equal(listed.targetState.user_id,'9');
  assert.equal(listed.targetState.user_email,'target@example.test');assert.equal(listed.targetState.role,'reviewer');
  assert.deepEqual(JSON.parse(listed.targetState.permissions_json),['forecast.approve']);assert.deepEqual(JSON.parse(listed.targetState.owner_ids_json),['21']);
  assert.equal((await f.invoke(f.secondActor,`${root}/change-approvals/${id}/approve`,'POST',{comment:'Reviewed this exact scoped assignment.'})).status,200);
  await f.first.query("UPDATE enterprise_role_assignments SET owner_ids_json='[\"22\"]',updated_at=$3 WHERE portal_id=$1 AND id=$2",[f.portal,target,f.at(1)]);
  const stale=await f.invoke(f.firstActor,`${path}?approvalId=${id}`,'DELETE');assert.equal(stale.status,409);assert.equal(stale.data.error.code,'change_approval_target_changed');
  assert.equal((await f.first.query('SELECT COUNT(*)::int n FROM enterprise_role_assignments WHERE portal_id=$1 AND id=$2',[f.portal,target])).rows[0].n,1);
  const revised=await f.invoke(f.firstActor,path,'DELETE');assert.equal(revised.status,409);const revisedId=revised.data.error.details.approvalId;assert.notEqual(revisedId,id);
  assert.equal((await f.invoke(f.secondActor,`${root}/change-approvals/${revisedId}/approve`,'POST',{comment:'Reviewed the changed scope before removal.'})).status,200);
  const applied=await f.invoke(f.firstActor,`${path}?approvalId=${revisedId}`,'DELETE');assert.equal(applied.status,200);assert.equal(applied.data.ok,true);
  assert.equal((await f.first.query('SELECT COUNT(*)::int n FROM enterprise_role_assignments WHERE portal_id=$1 AND id=$2',[f.portal,target])).rows[0].n,0);
  assert.equal((await f.invoke(f.firstActor,`${path}?approvalId=${revisedId}`,'DELETE')).status,409);
});

test('signed normal role flow rechecks current reviewer authority and rejects scoped legacy administrators', {skip:!databaseUrl,timeout:30000}, async t=>{
  const f=await setup(t),legacy={...f.firstActor,userId:'10',userEmail:'legacy-scoped@example.test'};
  await f.first.query(`INSERT INTO governance_roles(id,portal_id,user_id,user_email,role,scope_json,created_at,updated_at)
    VALUES($1,$2,$3,$4,'admin','{"ownerIds":["private"]}',$5,$5)`,[randomUUID(),f.portal,legacy.userId,legacy.userEmail,f.at(0)]);
  const denied=await f.invoke(legacy,`${root}/roles`,'PUT',assignment);assert.equal(denied.status,403);
  const proposed=await f.invoke(f.firstActor,`${root}/roles`,'PUT',assignment),id=proposed.data.error.details.approvalId;
  const forbiddenReview=await f.invoke(legacy,`${root}/change-approvals/${id}/approve`,'POST',{comment:'A scoped administrator is not portal-wide.'});assert.equal(forbiddenReview.status,403);
  assert.equal((await f.invoke(f.secondActor,`${root}/change-approvals/${id}/approve`,'POST',{comment:'Reviewed the exact role request.'})).status,200);
  const forbiddenApply=await f.invoke(legacy,`${root}/roles?approvalId=${id}`,'PUT',assignment);assert.equal(forbiddenApply.status,403);
  await f.first.query("UPDATE enterprise_role_assignments SET role='viewer',updated_at=$3 WHERE portal_id=$1 AND user_id=$2",[f.portal,f.secondActor.userId,f.at(1)]);
  const revoked=await f.invoke(f.firstActor,`${root}/roles?approvalId=${id}`,'PUT',assignment);assert.equal(revoked.status,409);assert.equal(revoked.data.error.code,'change_approval_authority_changed');
  assert.equal((await f.first.query("SELECT COUNT(*)::int n FROM enterprise_role_assignments WHERE portal_id=$1 AND user_id='9'",[f.portal])).rows[0].n,0);
});

test('legacy governance scope and identity are never silently promoted to portal-wide authority', {skip:!databaseUrl,timeout:30000}, async t=>{
  const f=await setup(t),actor={...f.firstActor,userId:'10',userEmail:'legacy@example.test'},id=randomUUID();
  await f.first.query(`INSERT INTO governance_roles(id,portal_id,user_id,user_email,role,scope_json,created_at,updated_at)
    VALUES($1,$2,$3,$4,'admin','{}',$5,$5)`,[id,f.portal,actor.userId,actor.userEmail,f.at(0)]);
  assert.equal((await governanceContext(f.env,actor)).role,'admin');await requireGovernancePermission(f.env,actor,'policy.manage');
  for(const scopeJson of ['{"ownerIds":["private"]}','{"ownerIds":[]}','[]','null','not-json']) {
    await f.first.query('UPDATE governance_roles SET scope_json=$3 WHERE portal_id=$1 AND id=$2',[f.portal,id,scopeJson]);
    await assert.rejects(governanceContext(f.env,actor),error=>error.status===403&&['governance_scope_denied','governance_scope_invalid'].includes(error.code));
    await assert.rejects(requireGovernancePermission(f.env,actor,'policy.manage'),error=>error.status===403);
    const signed=await f.invoke(actor,'/api/v1/governance/me');assert.equal(signed.status,403);
  }
  // An explicit enterprise assignment remains authoritative even when an old
  // legacy record cannot be used to derive portal-wide authority.
  await f.first.query(`INSERT INTO enterprise_role_assignments(id,portal_id,user_id,user_email,role,created_at,updated_at)
    VALUES($1,$2,$3,$4,'viewer',$5,$5)`,[randomUUID(),f.portal,actor.userId,actor.userEmail,f.at(0)]);
  await requireGovernancePermission(f.env,actor,'governance.view');
  await assert.rejects(requireGovernancePermission(f.env,actor,'policy.manage'),{code:'enterprise_permission_denied'});
  await f.first.query('DELETE FROM enterprise_role_assignments WHERE portal_id=$1 AND user_id=$2',[f.portal,actor.userId]);
  await f.first.query("UPDATE governance_roles SET scope_json='{}' WHERE portal_id=$1 AND id=$2",[f.portal,id]);
  await assert.rejects(governanceContext(f.env,{...actor,userId:'11'}),{code:'governance_identity_conflict'});
  // Unbound, unique email-only legacy roles retain existing compatibility.
  await f.first.query('UPDATE governance_roles SET user_id=NULL WHERE portal_id=$1 AND id=$2',[f.portal,id]);
  assert.equal((await governanceContext(f.env,actor)).role,'admin');
  await f.first.query(`INSERT INTO governance_roles(id,portal_id,user_id,user_email,role,scope_json,created_at,updated_at)
    VALUES($1,$2,'12','LEGACY@example.test','viewer','{}',$3,$3)`,[randomUUID(),f.portal,f.at(0)]);
  await assert.rejects(governanceContext(f.env,actor),{code:'governance_identity_conflict'});
});
