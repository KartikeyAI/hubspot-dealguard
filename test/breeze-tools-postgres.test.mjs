import test from'node:test';import assert from'node:assert/strict';import{createHash,randomUUID,randomInt}from'node:crypto';
import{fixture,databaseUrl}from'./helpers/postgres-fixture.mjs';import{invokeBreezeTool,setBreezeAdministration,breezeAdministration,cleanupBreezeMetadata}from'../dist/breeze-tools.js';
import{changeIntelligenceConsent}from'../dist/intelligence-consent.js';
test('Breeze has separate consent, current scope, read budgets and bounded callback replay',{skip:!databaseUrl},async t=>{
 const f=await fixture(t,'breeze'),{first,second,env}=f,portal=String(1000000000000+randomInt(999999999)),source=new Date(Date.now()-3600000).toISOString();f.portalIds.push(portal);
 await first.query(`INSERT INTO tenants(portal_id,app_id,access_token_cipher,access_token_iv,refresh_token_cipher,refresh_token_iv,token_expires_at,settings_json,installed_at,updated_at,next_scan_at,commercial_tier,trial_ends_at)
 VALUES($1,'123','fixture','fixture','fixture','fixture',$2,'{}',$2,$2,$2,'enterprise',$3)`,[portal,source,new Date(Date.now()+86400000).toISOString()]);
 await first.query(`INSERT INTO enterprise_role_assignments(id,portal_id,user_id,role,created_at,updated_at)VALUES($1,$2,'7','administrator',$3,$3)`,[randomUUID(),portal,source]);
 await first.query(`INSERT INTO deal_assessments(portal_id,deal_id,deal_name,pipeline_label,stage_label,score,grade,status,readiness_summary,issues_json,is_closed,is_won,assessed_at)
 VALUES($1,'101','Private customer','Pipeline','Stage',80,'B','at_risk','Private context','[]',0,0,$2)`,[portal,source]);
 Object.assign(env,{HUBSPOT_CLIENT_SECRET:'test-secret',HUBSPOT_APP_ID:'123',DEALGUARD_BREEZE_ENABLED:'true',DEALGUARD_BREEZE_ACTION_IDS:JSON.stringify({evidence:'900','remediation-preview':'901'})});
 const actor={portalId:portal,userId:'7',userEmail:null,appId:'123'};
 function request(callback='replay',tool='evidence',dealId='101'){
  const body={callbackId:callback,origin:{portalId:portal,userId:7,actionDefinitionId:tool==='evidence'?900:901},context:{agentId:500,source:'AGENTS'},inputFields:{dealId}};
  const text=JSON.stringify(body),url='https://example.test/api/v1/breeze/'+tool;
  return new Request(url,{method:'POST',body:text,headers:{'x-hubspot-signature-version':'v2','x-hubspot-signature':createHash('sha256').update(env.HUBSPOT_CLIENT_SECRET+'POST'+url+text).digest('hex')}});
 }
 await t.test('native AI consent cannot enable Breeze and missing separate consent fails',async()=>{
  await changeIntelligenceConsent(env,actor,'ai',{enabled:true,revision:0,confirmation:'ENABLE_AI'});
  await assert.rejects(invokeBreezeTool(request(),env,'evidence'),{code:'breeze_consent_required'});assert.equal((await breezeAdministration(env,actor)).enabled,false);
  await assert.rejects(setBreezeAdministration(env,actor,{enabled:true,revision:0,dailyLimit:20,confirmation:'yes'}),{code:'breeze_confirmation_required'});
  await setBreezeAdministration(env,actor,{enabled:true,revision:0,dailyLimit:20,confirmation:'ENABLE_BREEZE'});
 });
 await t.test('tools return only string output fields and do not execute or approve work',async()=>{
  const response=await(await invokeBreezeTool(request(),env,'evidence')).json();assert.equal(typeof response.outputFields.evidence,'string');assert.equal(response.outputFields.hs_execution_state,'SUCCESS');
  const data=JSON.parse(response.outputFields.evidence);assert.equal(data.actionsExecuted,false);assert.equal(data.approved,false);assert(!JSON.stringify(data).includes('Private'));
  const preview=JSON.parse((await(await invokeBreezeTool(request('preview','remediation-preview'),env,'remediation-preview')).json()).outputFields.evidence);assert.equal(preview.previewOnly,true);assert.equal(preview.approved,false);
  assert.equal((await first.query('SELECT COUNT(*)::int n FROM remediation_cases WHERE portal_id=$1',[portal])).rows[0].n,0);
 });
 await t.test('exact retry recomputes evidence and consumes budget; callback with altered input is denied',async()=>{
  await invokeBreezeTool(request(),env,'evidence');assert.equal((await first.query('SELECT requests FROM breeze_daily_usage WHERE portal_id=$1',[portal])).rows[0].requests,3);
  await assert.rejects(invokeBreezeTool(request('replay','remediation-preview'),env,'remediation-preview'),{code:'breeze_admission_denied'});
  await first.query("UPDATE breeze_invocations SET received_at=NOW()-INTERVAL '6 minutes' WHERE portal_id=$1 AND callback_id='replay'",[portal]);
  await assert.rejects(invokeBreezeTool(request(),env,'evidence'),{code:'breeze_admission_denied'});
 });
 await t.test('current role and record scope are checked on every retry',async()=>{
  await first.query(`UPDATE enterprise_role_assignments SET role='viewer',permissions_json='["breeze.use"]',pipeline_ids_json='["not-permitted"]' WHERE portal_id=$1`,[portal]);
  await assert.rejects(invokeBreezeTool(request('scope'),env,'evidence'),{code:'record_scope_denied'});
  await first.query("UPDATE enterprise_role_assignments SET role='administrator',permissions_json='[]',pipeline_ids_json='[]' WHERE portal_id=$1",[portal]);
 });
 await t.test('revocation and a concurrent admission serialize; stale consent does not admit a read',async()=>{
  await first.query('BEGIN');await first.query("SELECT dealguard.set_breeze_settings($1,false,1,20,'7')",[portal]);
  let done=false;const pending=second.query('SELECT dealguard.admit_breeze_read($1,1,\'late\',\'7\',\'evidence\',\'101\',$2) accepted',[portal,'a'.repeat(64)]).then(r=>{done=true;return r;});
  await new Promise(r=>setTimeout(r,30));assert.equal(done,false);await first.query('COMMIT');assert.equal((await pending).rows[0].accepted,false);
  await assert.rejects(invokeBreezeTool(request('revoked'),env,'evidence'),{code:'breeze_consent_required'});
 });
 await t.test('daily budget cannot be bypassed by new callback IDs or consent toggles',async()=>{
  await setBreezeAdministration(env,actor,{enabled:true,revision:2,dailyLimit:1,confirmation:'ENABLE_BREEZE'});
  await assert.rejects(invokeBreezeTool(request('budget'),env,'evidence'),{code:'breeze_admission_denied'});
 });
 await t.test('retention purges old callback metadata but active legal holds preserve it',async()=>{
  await first.query("UPDATE breeze_invocations SET received_at=NOW()-INTERVAL '31 days' WHERE portal_id=$1",[portal]);const hold=randomUUID();
  await first.query("INSERT INTO legal_holds(id,portal_id,name,reason,scope_json,status,created_at)VALUES($1,$2,'Test','Test','{}','active',$3)",[hold,portal,source]);
  await cleanupBreezeMetadata(env);assert.equal((await first.query('SELECT COUNT(*)::int n FROM breeze_invocations WHERE portal_id=$1',[portal])).rows[0].n,2);
  await first.query("UPDATE legal_holds SET status='released' WHERE id=$1",[hold]);await cleanupBreezeMetadata(env);assert.equal((await first.query('SELECT COUNT(*)::int n FROM breeze_invocations WHERE portal_id=$1',[portal])).rows[0].n,0);
 });
});
