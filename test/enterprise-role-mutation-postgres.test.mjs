import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, databaseUrl } from './helpers/postgres-fixture.mjs';
import { assignEnterpriseRole, enterpriseAccessContext, listEnterpriseRoles, removeEnterpriseRole } from '../dist/enterprise-access.js';
import { requireGovernancePermission } from '../dist/governance.js';
import { requireOperationalPermission } from '../dist/authorization.js';

const scope = () => ({pipelineIds:[],teamIds:[],ownerIds:[],regionCodes:[]});
const input = (userId, role='administrator', userEmail=null, extra={}) => ({userId,userEmail,role,permissions:[],scope:scope(),...extra});
async function setup(t, assigned=true) {
  const f=await fixture(t,'enterprise-role');
  await f.first.query("UPDATE tenants SET installer_email='installer@example.test' WHERE portal_id=$1",[f.portal]);
  const actor={portalId:f.portal,userId:'7',userEmail:'installer@example.test'};
  const add=async(userId='7',role='administrator',email=null,extra={})=>{
    const id=randomUUID();
    await f.first.query(`INSERT INTO enterprise_role_assignments(id,portal_id,user_id,user_email,role,permissions_json,pipeline_ids_json,team_ids_json,owner_ids_json,region_codes_json,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)`,[id,f.portal,userId,email,role,JSON.stringify(extra.permissions??[]),
      JSON.stringify(extra.pipelineIds??[]),JSON.stringify(extra.teamIds??[]),JSON.stringify(extra.ownerIds??[]),JSON.stringify(extra.regionCodes??[]),f.at(0)]);
    return id;
  };
  const firstId=assigned?await add('7','administrator','installer@example.test'):null;
  const rows=async()=>(await f.first.query('SELECT * FROM enterprise_role_assignments WHERE portal_id=$1 ORDER BY user_id NULLS FIRST',[f.portal])).rows;
  const audits=async()=>(await f.first.query("SELECT * FROM audit_events WHERE portal_id=$1 AND action LIKE 'enterprise_role.%' ORDER BY created_at,id",[f.portal])).rows;
  return {...f,actor,add,firstId,rows,audits};
}

// Reach the database function after the service's initial permission check, so
// lifecycle/role changes can commit while the final transaction waits on its lock.
function signalMutation(env) {
  let entered;const called=new Promise(resolve=>{entered=resolve;});
  return {called,env:{...env,DB:{...env.DB,prepare(sql){
    const statement=env.DB.prepare(sql),first=statement.first;
    if(sql.includes('mutate_enterprise_role'))statement.first=async()=>{entered();return first();};
    return statement;
  }}}};
}

test('enterprise role administration keeps atomic authority, identity and administrator invariants',{skip:!databaseUrl},async t=>{
  await t.test('initial installer setup creates a stable portal administrator without the old self-assignment deadlock',async t=>{
    const f=await setup(t,false),before=await enterpriseAccessContext(f.env,f.actor);
    assert.equal(before.bootstrap,true);assert.equal(before.explicitAssignment,false);
    await assert.rejects(assignEnterpriseRole(f.env,f.actor,input('7','viewer','installer@example.test')),{code:'enterprise_bootstrap_administrator_required'});
    assert.equal((await f.rows()).length,0);assert.equal((await f.audits()).length,0);
    await assignEnterpriseRole(f.env,f.actor,input('7','administrator','installer@example.test'));
    const current=await enterpriseAccessContext(f.env,f.actor);
    assert.equal(current.bootstrap,false);assert.equal(current.explicitAssignment,true);assert.equal(current.role,'administrator');
    const event=JSON.parse((await f.audits())[0].metadata_json);assert.equal(event.bootstrap,true);assert.equal(event.before,null);assert.equal(event.after.user_id,'7');
    await assignEnterpriseRole(f.env,f.actor,input('7','administrator','installer@example.test'));
    assert.equal((await f.rows()).length,1);
  });
  await t.test('the final administrator cannot be removed, demoted or scoped away',async t=>{
    const f=await setup(t);
    await assert.rejects(removeEnterpriseRole(f.env,f.actor,f.firstId),{code:'last_administrator_protection'});
    await assert.rejects(assignEnterpriseRole(f.env,f.actor,input('7','viewer','installer@example.test')),{code:'last_administrator_protection'});
    await assert.rejects(assignEnterpriseRole(f.env,f.actor,input('7','administrator','installer@example.test',{scope:{...scope(),ownerIds:['1']}})),{code:'last_administrator_protection'});
    assert.equal((await f.rows())[0].role,'administrator');assert.equal((await f.audits()).length,0);
    await f.add('8');await assignEnterpriseRole(f.env,f.actor,input('7','viewer','installer@example.test'));
    assert.equal((await f.rows())[0].role,'viewer');
  });
  await t.test('removing an installer assignment does not revive bootstrap after another administrator exists',async t=>{
    const f=await setup(t);await f.add('8');await removeEnterpriseRole(f.env,f.actor,f.firstId);
    const access=await enterpriseAccessContext(f.env,f.actor);assert.equal(access.role,'viewer');assert.equal(access.bootstrap,false);assert.equal(access.explicitAssignment,false);
    await assert.rejects(assignEnterpriseRole(f.env,f.actor,input('7')),{code:'enterprise_permission_denied'});
  });
  await t.test('email-only assignments bind a stable ID in place and enable explicit access only afterward',async t=>{
    const f=await setup(t),id=await f.add(null,'reviewer','reviewer@example.test');
    const reviewer={portalId:f.portal,userId:'8',userEmail:'reviewer@example.test'};
    assert.equal((await enterpriseAccessContext(f.env,reviewer)).explicitAssignment,false);
    await assignEnterpriseRole(f.env,f.actor,input('8','reviewer','REVIEWER@example.test',{permissions:['forecast.approve']}));
    const row=(await f.rows()).find(r=>r.user_id==='8');assert.equal(row.id,id);assert.equal(row.created_at,f.at(0));
    assert.equal(row.user_email,'reviewer@example.test');assert.equal((await f.rows()).length,2);
    assert.equal((await enterpriseAccessContext(f.env,reviewer)).explicitAssignment,true);
    assert.deepEqual(JSON.parse(row.permissions_json),['forecast.approve']);
  });
  await t.test('ambiguous or conflicting email and stable-ID bindings cannot be reassigned',async t=>{
    const f=await setup(t);await f.add('8','viewer','bound@example.test');
    await assert.rejects(assignEnterpriseRole(f.env,f.actor,input('9','reviewer','bound@example.test')),{code:'enterprise_role_binding_conflict'});
    await f.add(null,'viewer','email-only@example.test');
    await assert.rejects(assignEnterpriseRole(f.env,f.actor,input('8','reviewer','email-only@example.test')),{code:'enterprise_role_binding_conflict'});
    await f.add(null,'viewer','AMBIGUOUS@example.test');await f.add(null,'viewer','ambiguous@example.test');
    await assert.rejects(assignEnterpriseRole(f.env,f.actor,input('10','reviewer','ambiguous@example.test')),{code:'enterprise_role_binding_conflict'});
    assert.equal((await f.audits()).length,0);
  });
  await t.test('email reuse, explicit restrictions and scoped administrators cannot inherit installer authority',async t=>{
    const f=await setup(t,false);await f.add('8','viewer','installer@example.test');
    const reused=await enterpriseAccessContext(f.env,f.actor);assert.equal(reused.role,'viewer');assert.equal(reused.bootstrap,false);
    await assert.rejects(assignEnterpriseRole(f.env,f.actor,input('7')),{code:'enterprise_permission_denied'});
    await f.first.query('DELETE FROM enterprise_role_assignments WHERE portal_id=$1',[f.portal]);
    await f.add('7','administrator','installer@example.test',{ownerIds:['1']});
    await assert.rejects(listEnterpriseRoles(f.env,f.actor),{code:'enterprise_scope_denied'});
    await assert.rejects(assignEnterpriseRole(f.env,f.actor,input('7')),{code:'enterprise_scope_denied'});
    await f.first.query("UPDATE enterprise_role_assignments SET role='viewer',owner_ids_json='[]' WHERE portal_id=$1",[f.portal]);
    await assert.rejects(assignEnterpriseRole(f.env,f.actor,input('7')),{code:'enterprise_permission_denied'});
  });
  await t.test('legacy administrator access is compatible but does not masquerade as an explicit stable enterprise assignment',async t=>{
    const f=await setup(t,false);
    await f.first.query("INSERT INTO governance_roles(id,portal_id,user_id,role,created_at,updated_at)VALUES($1,$2,'7','admin',$3,$3)",[randomUUID(),f.portal,f.at(0)]);
    const legacy=await enterpriseAccessContext(f.env,f.actor);assert.equal(legacy.bootstrap,false);assert.equal(legacy.explicitAssignment,false);
    await assignEnterpriseRole(f.env,f.actor,input('8'));
    assert.equal((await f.rows())[0].user_id,'8');
  });
  await t.test('legacy governance routes honor explicit enterprise permissions and portal scope',async t=>{
    const f=await setup(t,false);
    await f.first.query("INSERT INTO governance_roles(id,portal_id,user_id,role,created_at,updated_at)VALUES($1,$2,'7','admin',$3,$3)",[randomUUID(),f.portal,f.at(0)]);
    await requireGovernancePermission(f.env,f.actor,'policy.manage');
    const id=await f.add('7','viewer','installer@example.test');
    await requireGovernancePermission(f.env,f.actor,'governance.view');
    for(const permission of ['policy.manage','policy.publish','role.manage','audit.export'])await assert.rejects(requireGovernancePermission(f.env,f.actor,permission),{code:'enterprise_permission_denied'});
    await f.first.query("UPDATE enterprise_role_assignments SET role='administrator',owner_ids_json='[\"1\"]' WHERE id=$1",[id]);
    await assert.rejects(requireGovernancePermission(f.env,f.actor,'policy.manage'),{code:'enterprise_scope_denied'});
    await f.first.query("UPDATE enterprise_role_assignments SET owner_ids_json='[]' WHERE id=$1",[id]);
    await requireGovernancePermission(f.env,f.actor,'policy.manage');
    await f.first.query("UPDATE tenants SET status='disconnected' WHERE portal_id=$1",[f.portal]);
    await assert.rejects(requireGovernancePermission(f.env,f.actor,'policy.manage'),{code:'installation_inactive'});
  });
  await t.test('closing installer bootstrap also closes implicit legacy operational authority',async t=>{
    const f=await setup(t,false);await requireOperationalPermission(f.env,f.actor,'settings.manage');
    await assignEnterpriseRole(f.env,f.actor,input('8'));
    await assert.rejects(requireOperationalPermission(f.env,f.actor,'settings.manage'),{code:'operation_forbidden'});
    await assert.rejects(requireGovernancePermission(f.env,f.actor,'role.manage'),{code:'governance_forbidden'});
  });
  await t.test('invalid IDs, wildcard grants and malformed scope cannot silently become broad access',async t=>{
    const f=await setup(t);
    for(const bad of [input('arbitrary'),input(' 8'),input('8'.repeat(33)),input(8),input(null,'reviewer','someone@example.test'),
      input('8','viewer',null,{permissions:['*']}),input('8','viewer',null,{permissions:['role.manage']}),input('8','viewer',null,{permissions:null}),
      input('8','viewer',null,{scope:null}),input('8','viewer',null,{scope:{...scope(),ownerIds:null}}),input('8','viewer',null,{scope:{...scope(),ownerIds:[' x']}}),
      input('8','viewer',null,{scope:{...scope(),regionCodes:['x'.repeat(129)]}}),input('8','viewer','not-an-email')]){
      await assert.rejects(assignEnterpriseRole(f.env,f.actor,bad),{code:'enterprise_role_input_invalid'});
    }
    const legacyId=await f.add('8','viewer',null,{permissions:['analytics.export','forecast.*']});
    const listed=(await listEnterpriseRoles(f.env,f.actor)).find(r=>r.id===legacyId);assert.deepEqual(listed.permissions,['analytics.export','forecast.*']);
    await assignEnterpriseRole(f.env,f.actor,input('8','viewer'));
    assert.deepEqual(JSON.parse((await f.rows()).find(r=>r.id===legacyId).permissions_json),[]);
  });
  await t.test('two concurrent administrator removals preserve one usable administrator and one audit',async t=>{
    const f=await setup(t),secondId=await f.add('8'),secondActor={...f.actor,userId:'8',userEmail:null};
    await f.first.query('BEGIN');await f.first.query('SELECT 1 FROM tenants WHERE portal_id=$1 FOR UPDATE',[f.portal]);
    const pending=signalMutation(f.envFor(f.second)),other=removeEnterpriseRole(pending.env,secondActor,secondId);await pending.called;
    await removeEnterpriseRole(f.env,f.actor,f.firstId);await f.first.query('COMMIT');
    await assert.rejects(other,{code:'last_administrator_protection'});
    assert.equal((await f.rows()).length,1);assert.equal((await f.rows())[0].user_id,'8');assert.equal((await f.audits()).length,1);
  });
  await t.test('two concurrent self-demotions cannot pass a stale administrator count',async t=>{
    const f=await setup(t);await f.add('8');
    await f.first.query('BEGIN');await f.first.query('SELECT 1 FROM tenants WHERE portal_id=$1 FOR UPDATE',[f.portal]);
    const pending=signalMutation(f.envFor(f.second)),other=assignEnterpriseRole(pending.env,{...f.actor,userId:'8',userEmail:null},input('8','viewer'));await pending.called;
    await assignEnterpriseRole(f.env,f.actor,input('7','viewer','installer@example.test'));await f.first.query('COMMIT');
    await assert.rejects(other,{code:'last_administrator_protection'});
    assert.equal((await f.rows()).filter(r=>r.role==='administrator').length,1);assert.equal((await f.audits()).length,1);
  });
  await t.test('initial bootstrap cannot create two first administrators from concurrent stale authority',async t=>{
    const f=await setup(t,false);
    await f.first.query('BEGIN');await f.first.query('SELECT 1 FROM tenants WHERE portal_id=$1 FOR UPDATE',[f.portal]);
    const pending=signalMutation(f.envFor(f.second)),other=assignEnterpriseRole(pending.env,f.actor,input('9'));await pending.called;
    await assignEnterpriseRole(f.env,f.actor,input('8'));await f.first.query('COMMIT');
    await assert.rejects(other,e=>['enterprise_permission_denied','enterprise_role_authorization_changed'].includes(e.code));
    assert.equal((await f.rows()).length,1);assert.equal((await f.audits()).length,1);
  });
  await t.test('a waiting mutation rechecks both role revocation and tenant deactivation before writing',async t=>{
    for(const change of ['role','installation']){
      const f=await setup(t);await f.add('8');
      await f.first.query('BEGIN');await f.first.query('SELECT 1 FROM tenants WHERE portal_id=$1 FOR UPDATE',[f.portal]);
      if(change==='role')await f.first.query("UPDATE enterprise_role_assignments SET role='viewer' WHERE portal_id=$1 AND user_id='7'",[f.portal]);
      else await f.first.query("UPDATE tenants SET status='disconnected' WHERE portal_id=$1",[f.portal]);
      const pending=signalMutation(f.envFor(f.second)),other=assignEnterpriseRole(pending.env,f.actor,input('9','reviewer'));await pending.called;
      await f.first.query('COMMIT');await assert.rejects(other,{code:change==='role'?'enterprise_permission_denied':'installation_inactive'});
      assert.equal((await f.rows()).some(r=>r.user_id==='9'),false);assert.equal((await f.audits()).length,0);
    }
  });
  await t.test('audit failure rolls the role change back in the same transaction',async t=>{
    const f=await setup(t),name='fail_role_audit_'+randomUUID().replaceAll('-','');
    await f.first.query(`CREATE FUNCTION dealguard.${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.portal_id='${f.portal}' AND NEW.action LIKE 'enterprise_role.%' THEN RAISE EXCEPTION 'fixture audit failure'; END IF; RETURN NEW; END $$`);
    await f.first.query(`CREATE TRIGGER ${name} BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION dealguard.${name}()`);
    try {
      await assert.rejects(assignEnterpriseRole(f.env,f.actor,input('8','reviewer')),/fixture audit failure/);
      assert.equal((await f.rows()).length,1);assert.equal((await f.audits()).length,0);
    } finally {
      await f.first.query(`DROP TRIGGER IF EXISTS ${name} ON audit_events`);await f.first.query(`DROP FUNCTION IF EXISTS dealguard.${name}()`);
    }
  });
  await t.test('listing and removal remain tenant-bound and inactive installations cannot inspect role metadata',async t=>{
    const f=await setup(t),foreignId=randomUUID();
    await f.first.query("INSERT INTO enterprise_role_assignments(id,portal_id,user_id,role,created_at,updated_at)VALUES($1,$2,'9','administrator',$3,$3)",[foreignId,f.other,f.at(0)]);
    assert.equal((await listEnterpriseRoles(f.env,f.actor)).length,1);
    await assert.rejects(removeEnterpriseRole(f.env,f.actor,foreignId),{code:'enterprise_role_not_found'});
    await f.first.query("UPDATE tenants SET status='deleted' WHERE portal_id=$1",[f.portal]);
    await assert.rejects(listEnterpriseRoles(f.env,f.actor),{code:'installation_inactive'});
  });
});
