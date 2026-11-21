import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, databaseUrl } from './helpers/postgres-fixture.mjs';
import { signedUiRequest } from './helpers/signed-ui-request.mjs';
import { route } from '../dist/routes-v17.js';

const root = '/api/v1/enterprise/roles/bootstrap', secret = 'synthetic-bootstrap-signing-secret';
const ctx = { waitUntil() { throw new Error('Administrator setup must not enqueue work.'); } };
const proposalBody = (nomineeUserId='8', nomineeEmail='nominee@example.test') => ({ action:'propose', nomineeUserId, nomineeEmail, confirmation:'PROPOSE_INITIAL_ADMINISTRATORS' });
const decisionBody = (proposal, action='accept') => ({ action, proposalId:proposal.id, payloadHash:proposal.payloadHash,
  confirmation:action==='accept'?'ACCEPT_INITIAL_ADMINISTRATORS':'REJECT_INITIAL_ADMINISTRATORS' });

async function setup(t) {
  const f = await fixture(t,'bootstrap');
  const portal = String(Date.now()) + String(Math.floor(Math.random()*100000000)).padStart(8,'0');
  f.portalIds.push(portal);
  await f.first.query(`INSERT INTO tenants(portal_id,app_id,access_token_cipher,access_token_iv,refresh_token_cipher,refresh_token_iv,
    token_expires_at,settings_json,installed_at,updated_at,next_scan_at,commercial_tier,trial_ends_at,installer_email)
    SELECT $1,'1','unused','unused','unused','unused',token_expires_at,settings_json,installed_at,updated_at,next_scan_at,
      commercial_tier,trial_ends_at,'installer@example.test' FROM tenants WHERE portal_id=$2`, [portal,f.portal]);
  const actors = { requester:{portalId:portal,userId:'7',userEmail:'installer@example.test',appId:'1'},
    nominee:{portalId:portal,userId:'8',userEmail:'nominee@example.test',appId:'1'},
    other:{portalId:portal,userId:'9',userEmail:'other@example.test',appId:'1'} };
  const env = { ...f.env,HUBSPOT_CLIENT_SECRET:secret,HUBSPOT_APP_ID:'1' };
  const call = async (actor=actors.requester,value,environment=env,path=root) => {
    const response = await route(signedUiRequest(secret,actor,path,value===undefined?'GET':'POST',value),environment,ctx);
    return { status:response.status, value:await response.json() };
  };
  const propose = async () => (await call(actors.requester,proposalBody())).value.proposal;
  const roles = async () => (await f.first.query('SELECT * FROM enterprise_role_assignments WHERE portal_id=$1 ORDER BY user_id',[portal])).rows;
  const approvals = async () => (await f.first.query("SELECT * FROM change_approval_requests WHERE portal_id=$1 AND change_type='role.bootstrap' ORDER BY requested_at",[portal])).rows;
  const audits = async () => (await f.first.query("SELECT * FROM audit_events WHERE portal_id=$1 AND action LIKE 'enterprise_role.bootstrap_%' ORDER BY created_at,id",[portal])).rows;
  const addEnterprise = async (userId,email,role='viewer',scope='[]') => f.first.query(`INSERT INTO enterprise_role_assignments(id,portal_id,user_id,user_email,role,owner_ids_json,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$7)`,[randomUUID(),portal,userId,email,role,scope,f.at(0)]);
  const addLegacy = async (userId,email,role='viewer',scope='{}') => f.first.query(`INSERT INTO governance_roles(id,portal_id,user_id,user_email,role,scope_json,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$7)`,[randomUUID(),portal,userId,email,role,scope,f.at(0)]);
  return {...f,portal,actors,env,call,propose,roles,approvals,audits,addEnterprise,addLegacy};
}

function signalMutation(env) {
  let entered; const called = new Promise(resolve => { entered=resolve; });
  return { called,env:{...env,DB:{...env.DB,prepare(sql) {
    const statement=env.DB.prepare(sql),first=statement.first;
    if(sql.includes('mutate_enterprise_role_bootstrap'))statement.first=async()=>{entered();return first();};
    return statement;
  }}} };
}

test('signed two-identity initial enterprise administration is exact, private and atomic',{skip:!databaseUrl},async t=>{
  await t.test('a proposal grants nothing; only its independently signed nominee applies the fixed administrator pair',async t=>{
    const f=await setup(t),initial=(await f.call()).value;
    assert.deepEqual(initial,{initialized:false,viewer:'requester',canPropose:true,proposal:null});
    const proposed=await f.call(f.actors.requester,proposalBody());assert.equal(proposed.status,201);
    const p=proposed.value.proposal;assert.equal(proposed.value.outcome,'proposed');assert.match(p.payloadHash,/^[a-f0-9]{64}$/);
    assert.deepEqual(p.requester,{userId:'7',userEmail:'installer@example.test'});assert.deepEqual(p.nominee,{userId:'8',userEmail:'nominee@example.test'});
    assert.equal(p.canAccept,false);assert.equal(p.canReject,true);assert.equal(p.role,'administrator');assert.deepEqual(p.permissions,[]);
    assert.deepEqual(p.scope,{pipelineIds:[],teamIds:[],ownerIds:[],regionCodes:[]});
    assert.equal((await f.roles()).length,0);assert.equal((await f.approvals())[0].status,'pending');assert.equal((await f.audits()).length,1);
    await assert.rejects(f.call(f.actors.requester,decisionBody(p)),{code:'enterprise_bootstrap_nominee_required'});
    const invited=(await f.call(f.actors.nominee)).value;assert.equal(invited.viewer,'nominee');assert.equal(invited.proposal.canAccept,true);
    const accepted=await f.call(f.actors.nominee,decisionBody(invited.proposal));assert.equal(accepted.value.outcome,'applied');
    const roles=await f.roles();assert.deepEqual(roles.map(r=>r.user_id),['7','8']);
    for(const r of roles){assert.equal(r.role,'administrator');for(const k of ['permissions_json','pipeline_ids_json','owner_ids_json','team_ids_json','region_codes_json'])assert.equal(r[k],'[]');}
    const approval=(await f.approvals())[0];assert.equal(approval.status,'applied');assert.equal(approval.requested_by_user_id,'7');assert.equal(approval.decided_by_user_id,'8');assert(approval.applied_at);
    const execution=(await f.first.query('SELECT status,applied_by_user_id FROM change_approval_executions WHERE approval_id=$1',[p.id])).rows[0];
    assert.deepEqual(execution,{status:'completed',applied_by_user_id:'8'});assert.equal((await f.audits()).length,2);
    assert.deepEqual((await f.call()).value,{initialized:true,viewer:'unavailable',canPropose:false,proposal:null});
    await assert.rejects(f.call(f.actors.nominee,decisionBody(p)),{code:'enterprise_bootstrap_initialized'});
    assert.equal((await f.roles()).length,2);
  });

  await t.test('only exact requester or nominee identities receive proposal details',async t=>{
    const f=await setup(t),p=await f.propose();
    for(const actor of [f.actors.other,{...f.actors.nominee,userEmail:'different@example.test'},
      {...f.actors.other,userEmail:f.actors.nominee.userEmail},{...f.actors.other,userEmail:f.actors.requester.userEmail}]){
      const status=(await f.call(actor)).value;assert.equal(status.proposal,null);assert.equal(status.viewer,'unavailable');
      assert.equal(JSON.stringify(status).includes(p.id),false);assert.equal(JSON.stringify(status).includes(p.payloadHash),false);
      await assert.rejects(f.call(actor,decisionBody(p)),{code:'enterprise_bootstrap_nominee_required'});
    }
    assert.equal((await f.roles()).length,0);
  });

  await t.test('authentication binds the exact URL and body, and malformed or arbitrary grant bodies never create a proposal',async t=>{
    const f=await setup(t);
    await assert.rejects(route(new Request('https://example.test'+root),f.env,ctx),{status:401});
    const signed=signedUiRequest(secret,f.actors.requester,root,'POST',proposalBody());
    await assert.rejects(route(new Request(signed.url,{method:'POST',headers:signed.headers,body:JSON.stringify(proposalBody('9','other@example.test'))}),f.env,ctx),{code:'invalid_signature'});
    await assert.rejects(f.call({...f.actors.requester,userEmail:null},proposalBody()),{code:'enterprise_bootstrap_identity_required'});
    for(const body of [{...proposalBody(),role:'administrator'},{...proposalBody(),scope:{ownerIds:[]}},
      {...proposalBody(),permissions:['*']},{...proposalBody(),confirmation:'yes'},{...proposalBody(),nomineeUserId:8},
      {...proposalBody(),nomineeEmail:'not-an-email'},{...proposalBody(),nomineeUserId:'08'}]){
      await assert.rejects(f.call(f.actors.requester,body),{code:'enterprise_bootstrap_input_invalid'});
    }
    await assert.rejects(f.call(f.actors.requester,proposalBody('7','different@example.test')),{code:'enterprise_bootstrap_distinct_identity_required'});
    await assert.rejects(f.call(f.actors.requester,proposalBody('8','INSTALLER@example.test')),{code:'enterprise_bootstrap_distinct_identity_required'});
    await assert.rejects(f.call(f.actors.nominee,proposalBody('7','installer@example.test')),{code:'enterprise_bootstrap_requester_required'});
    assert.equal((await f.approvals()).length,0);assert.equal((await f.roles()).length,0);
  });

  await t.test('the exact hash is required and accepting cannot append another role or grant',async t=>{
    const f=await setup(t),p=await f.propose();
    await assert.rejects(f.call(f.actors.nominee,{...decisionBody(p),payloadHash:'0'.repeat(64)}),{code:'enterprise_bootstrap_payload_changed'});
    for(const extra of [{role:'viewer'},{permissions:['*']},{nomineeUserId:'9'},{scope:{ownerIds:['1']}},{approvalId:'another'}])
      await assert.rejects(f.call(f.actors.nominee,{...decisionBody(p),...extra}),{code:'enterprise_bootstrap_input_invalid'});
    assert.equal((await f.roles()).length,0);assert.equal((await f.approvals())[0].status,'pending');
  });

  await t.test('requester withdrawal and nominee rejection create no roles and permit a new reviewed proposal',async t=>{
    const f=await setup(t);
    for(const actor of [f.actors.requester,f.actors.nominee]){
      const p=await f.propose();const rejected=await f.call(actor,decisionBody(p,'reject'));assert.equal(rejected.value.outcome,'rejected');
      await assert.rejects(f.call(f.actors.nominee,decisionBody(p)),{code:'enterprise_bootstrap_unavailable'});
      assert.equal((await f.roles()).length,0);assert.equal((await f.call()).value.canPropose,true);
    }
    assert.deepEqual((await f.approvals()).map(r=>r.status),['rejected','rejected']);
  });

  await t.test('a sole stable legacy administrator can migrate with an exactly bound legacy viewer',async t=>{
    const f=await setup(t);
    await f.first.query("UPDATE tenants SET installer_email='original-installer@example.test' WHERE portal_id=$1",[f.portal]);
    await f.addLegacy('7','installer@example.test','admin');await f.addLegacy('8','nominee@example.test','viewer');
    assert.equal((await f.call()).value.canPropose,true);
    const p=await f.propose();const stored=JSON.parse((await f.approvals())[0].requested_payload_json);
    assert.equal(stored.installationInstallerEmail,'original-installer@example.test');assert.equal(stored.requester.userId,'7');
    await f.call(f.actors.nominee,decisionBody(p));assert.deepEqual((await f.roles()).map(r=>r.user_id),['7','8']);
    assert.equal(Number((await f.first.query('SELECT COUNT(*) AS n FROM governance_roles WHERE portal_id=$1',[f.portal])).rows[0].n),2);
  });

  await t.test('existing enterprise administration, multiple legacy admins, and restricted legacy authority close setup',async t=>{
    for(const mode of ['enterprise','two-legacy','scoped-legacy','email-only-legacy']){
      const f=await setup(t);
      if(mode==='enterprise')await f.addEnterprise('9','other@example.test','administrator');
      if(mode==='two-legacy'){await f.addLegacy('7','installer@example.test','admin');await f.addLegacy('9','other@example.test','admin');}
      if(mode==='scoped-legacy')await f.addLegacy('7','installer@example.test','admin','{"ownerIds":["1"]}');
      if(mode==='email-only-legacy')await f.addLegacy(null,'installer@example.test','admin');
      const state=(await f.call()).value;assert.equal(state.canPropose,false);assert.equal(state.proposal,null);
      await assert.rejects(f.call(f.actors.requester,proposalBody()),{code:mode==='enterprise'?'enterprise_bootstrap_initialized':'enterprise_bootstrap_requester_required'});
      assert.equal((await f.approvals()).length,0);
    }
  });

  await t.test('explicit or ambiguous bindings cannot be overwritten by the setup path',async t=>{
    for(const mode of ['requester-enterprise','nominee-enterprise','reused-email','ambiguous-legacy']){
      const f=await setup(t);
      if(mode==='requester-enterprise')await f.addEnterprise('7','installer@example.test');
      if(mode==='nominee-enterprise')await f.addEnterprise('8','nominee@example.test');
      if(mode==='reused-email')await f.addLegacy('9','nominee@example.test');
      if(mode==='ambiguous-legacy'){await f.addLegacy('8','nominee@example.test');await f.addLegacy('9','NOMINEE@example.test');}
      await assert.rejects(f.call(f.actors.requester,proposalBody()),{code:mode==='requester-enterprise'?'enterprise_bootstrap_requester_required':'enterprise_bootstrap_binding_conflict'});
      assert.equal((await f.approvals()).length,0);
    }
  });

  await t.test('cross-portal proposal IDs are unavailable even to the same signed user identity',async t=>{
    const f=await setup(t),other=await setup(t),p=await f.propose();
    const foreignActor={...f.actors.nominee,portalId:other.portal};
    assert.equal((await other.call(foreignActor)).value.proposal,null);
    await assert.rejects(other.call(foreignActor,decisionBody(p)),{code:'enterprise_bootstrap_unavailable'});
    assert.equal((await f.roles()).length,0);assert.equal((await other.roles()).length,0);
  });

  await t.test('expiry, installation epoch, installer changes, changed assignments and tampered payload invalidate a pending proposal',async t=>{
    for(const change of ['expiry','epoch','installer','nominee-assigned','requester-assigned','payload']){
      const f=await setup(t),p=await f.propose();
      if(change==='expiry')await f.first.query("UPDATE change_approval_requests SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=$1",[p.id]);
      if(change==='epoch')await f.first.query('UPDATE tenants SET authorization_epoch_at=clock_timestamp() WHERE portal_id=$1',[f.portal]);
      if(change==='installer')await f.first.query("UPDATE tenants SET installer_email='replacement@example.test' WHERE portal_id=$1",[f.portal]);
      if(change==='nominee-assigned')await f.addEnterprise('8','nominee@example.test');
      if(change==='requester-assigned')await f.addEnterprise('7','installer@example.test');
      if(change==='payload')await f.first.query("UPDATE change_approval_requests SET requested_payload_json=jsonb_set(requested_payload_json::jsonb,'{role}','\"viewer\"')::text WHERE id=$1",[p.id]);
      assert.equal((await f.call(f.actors.nominee)).value.proposal,null);
      await assert.rejects(f.call(f.actors.nominee,decisionBody(p)),{code:'enterprise_bootstrap_unavailable'});
      assert.equal((await f.approvals())[0].status,'pending');
      assert.equal((await f.roles()).filter(r=>r.role==='administrator').length,0);
    }
  });

  await t.test('disconnect/reinstall invalidates old setup and a new explicit proposal uses the new epoch',async t=>{
    const f=await setup(t),old=await f.propose();
    await f.first.query("UPDATE tenants SET status='disconnected' WHERE portal_id=$1",[f.portal]);
    await assert.rejects(f.call(f.actors.nominee,decisionBody(old)),{code:'installation_inactive'});
    await f.first.query("UPDATE tenants SET status='active' WHERE portal_id=$1",[f.portal]);
    await assert.rejects(f.call(f.actors.nominee,decisionBody(old)),{code:'enterprise_bootstrap_unavailable'});
    const current=await f.propose();assert.notEqual(current.id,old.id);assert.notEqual(current.payloadHash,old.payloadHash);
    await f.call(f.actors.nominee,decisionBody(current));
    assert.deepEqual((await f.approvals()).map(r=>r.status),['cancelled','applied']);
  });

  await t.test('concurrent nominations serialize to one pending proposal and no assignments',async t=>{
    const f=await setup(t),secondEnv={...f.env,...f.envFor(f.second)};
    const results=await Promise.allSettled([f.call(f.actors.requester,proposalBody()),
      f.call(f.actors.requester,proposalBody('9','other@example.test'),secondEnv)]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    const denied=results.find(r=>r.status==='rejected');assert.equal(denied.reason.code,'enterprise_bootstrap_pending');
    assert.equal((await f.approvals()).length,1);assert.equal((await f.roles()).length,0);assert.equal((await f.audits()).length,1);
  });

  await t.test('concurrent acceptance applies exactly one complete pair and one approval execution',async t=>{
    const f=await setup(t),p=await f.propose(),secondEnv={...f.env,...f.envFor(f.second)};
    const results=await Promise.allSettled([f.call(f.actors.nominee,decisionBody(p)),f.call(f.actors.nominee,decisionBody(p),secondEnv)]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(results.find(r=>r.status==='rejected').reason.code,'enterprise_bootstrap_initialized');
    assert.equal((await f.roles()).length,2);assert.equal((await f.audits()).length,2);
    assert.equal(Number((await f.first.query('SELECT COUNT(*) AS n FROM change_approval_executions WHERE portal_id=$1',[f.portal])).rows[0].n),1);
  });

  await t.test('acceptance waiting on a tenant lock rechecks a concurrent installation epoch change',async t=>{
    const f=await setup(t),p=await f.propose();
    await f.first.query('BEGIN');await f.first.query('SELECT 1 FROM tenants WHERE portal_id=$1 FOR UPDATE',[f.portal]);
    const pending=signalMutation({...f.env,...f.envFor(f.second)}),accept=f.call(f.actors.nominee,decisionBody(p),pending.env);
    await pending.called;
    await f.first.query('UPDATE tenants SET authorization_epoch_at=clock_timestamp() WHERE portal_id=$1',[f.portal]);await f.first.query('COMMIT');
    await assert.rejects(accept,{code:'enterprise_bootstrap_unavailable'});assert.equal((await f.roles()).length,0);
  });

  await t.test('failure while writing the application audit rolls back both grants and approval settlement',async t=>{
    const f=await setup(t),p=await f.propose(),name='fail_bootstrap_'+randomUUID().replaceAll('-','');
    await f.first.query(`CREATE FUNCTION dealguard.${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.portal_id='${f.portal}' AND NEW.action='enterprise_role.bootstrap_applied' THEN RAISE EXCEPTION 'fixture bootstrap audit failure'; END IF; RETURN NEW; END $$`);
    await f.first.query(`CREATE TRIGGER ${name} BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION dealguard.${name}()`);
    try {
      await assert.rejects(f.call(f.actors.nominee,decisionBody(p)),/fixture bootstrap audit failure/);
      assert.equal((await f.roles()).length,0);assert.equal((await f.approvals())[0].status,'pending');assert.equal((await f.audits()).length,1);
      assert.equal(Number((await f.first.query('SELECT COUNT(*) AS n FROM change_approval_executions WHERE portal_id=$1',[f.portal])).rows[0].n),0);
    } finally {
      await f.first.query(`DROP TRIGGER IF EXISTS ${name} ON audit_events`);await f.first.query(`DROP FUNCTION IF EXISTS dealguard.${name}()`);
    }
  });
});
