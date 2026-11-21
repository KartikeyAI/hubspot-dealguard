import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, databaseUrl } from './helpers/postgres-fixture.mjs';
import { normalizeEnterpriseRoleAssignment } from '../dist/enterprise-access.js';

const scope=()=>({pipelineIds:[],ownerIds:[],teamIds:[],regionCodes:[]});
async function setup(t,payload) {
  const f=await fixture(t,'approval-normalization'),id=randomUUID();
  for(const user of ['7','8'])await f.first.query(`INSERT INTO enterprise_role_assignments(id,portal_id,user_id,user_email,role,created_at,updated_at)
    VALUES($1,$2,$3,$4,'administrator',$5,$5)`,[randomUUID(),f.portal,user,user+'@example.test',f.at(0)]);
  const requested=(await f.first.query(`SELECT dealguard.request_controlled_change($1,'7','7@example.test',$2,'role.assign','enterprise_role',$3,$4::jsonb,clock_timestamp()+INTERVAL '1 hour') AS result`,
    [f.portal,id,payload.userId,JSON.stringify(payload)])).rows[0].result;
  assert.equal(requested.status,'pending');
  const reviewed=(await f.first.query(`SELECT dealguard.decide_controlled_change($1,'8','8@example.test',$2,'approved','Reviewed exact payload') AS result`,[f.portal,id])).rows[0].result;
  assert.equal(reviewed.status,'approved');
  const apply=async(normalized,expected=payload,type='role.assign')=>(await f.first.query(`SELECT dealguard.apply_approved_enterprise_role($1,'7','7@example.test',$2,$3,$4,$5::jsonb,$6::jsonb,$7) AS result`,
    [f.portal,id,type,payload.userId,JSON.stringify(expected),JSON.stringify(normalized),randomUUID()])).rows[0].result;
  return {...f,id,apply};
}

test('SQL role approval cannot apply a caller-normalized grant that differs from the approved payload',{skip:!databaseUrl},async t=>{
  const payload={userId:'9',userEmail:'target@example.test',role:'viewer',permissions:['ai.use'],scope:{...scope(),ownerIds:['east']}};
  const f=await setup(t,payload),normalized=normalizeEnterpriseRoleAssignment(payload);
  for(const changed of [{...normalized,role:'administrator'},{...normalized,userId:'10'},
    {...normalized,userEmail:'other@example.test'},{...normalized,permissions:['ai.use','forecast.approve']},
    {...normalized,permissions:[]},{...normalized,scope:scope()},{...normalized,scope:{...scope(),ownerIds:['west']}},
    {...normalized,unexpected:'unapproved'}]){
    assert.deepEqual(await f.apply(changed),{error:'change_approval_payload_mismatch'});
  }
  assert.deepEqual(await f.apply(normalized,payload,null),{error:'change_approval_fields_required'});
  assert.equal(Number((await f.first.query('SELECT count(*) AS n FROM enterprise_role_assignments WHERE portal_id=$1',[f.portal])).rows[0].n),2);
  assert.equal(Number((await f.first.query('SELECT count(*) AS n FROM change_approval_executions WHERE portal_id=$1',[f.portal])).rows[0].n),0);
  assert.equal((await f.first.query('SELECT status FROM change_approval_requests WHERE id=$1',[f.id])).rows[0].status,'approved');
  assert.equal((await f.apply(normalized)).ok,true);
  const actual=(await f.first.query("SELECT role,user_email,permissions_json,owner_ids_json FROM enterprise_role_assignments WHERE portal_id=$1 AND user_id='9'",[f.portal])).rows[0];
  assert.deepEqual(actual,{role:'viewer',user_email:'target@example.test',permissions_json:'["ai.use"]',owner_ids_json:'["east"]'});
});

test('SQL binding preserves the permitted email normalization and first-occurrence scope/permission deduplication',{skip:!databaseUrl},async t=>{
  const payload={userId:'9',userEmail:'  TARGET@EXAMPLE.TEST  ',role:'reviewer',permissions:['ai.use','ai.use'],
    scope:{...scope(),ownerIds:['east','east','west']}};
  const f=await setup(t,payload),normalized=normalizeEnterpriseRoleAssignment(payload);
  const sqlNormalized=(await f.first.query('SELECT dealguard.normalize_controlled_role_assignment($1::jsonb) AS value',[JSON.stringify(payload)])).rows[0].value;
  assert.deepEqual(sqlNormalized,normalized);assert.equal((await f.apply(normalized)).ok,true);
  const actual=(await f.first.query("SELECT user_email,permissions_json,owner_ids_json FROM enterprise_role_assignments WHERE portal_id=$1 AND user_id='9'",[f.portal])).rows[0];
  assert.deepEqual(actual,{user_email:'target@example.test',permissions_json:'["ai.use"]',owner_ids_json:'["east", "west"]'});
});
