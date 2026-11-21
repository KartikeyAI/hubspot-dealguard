import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, databaseUrl } from './helpers/postgres-fixture.mjs';
import { Repository } from '../dist/repository.js';
import { HubSpotClient } from '../dist/hubspot.js';
import { encryptSecret, sha256Hex } from '../dist/crypto.js';
import { finalizePortalDeletion } from '../dist/data-deletion.js';
import { randomUUID } from 'node:crypto';

const key=Buffer.alloc(32,17).toString('base64');
const tokens=(name='replacement')=>({access_token:`${name}-access`,refresh_token:`${name}-refresh`,expires_in:1800,token_type:'bearer'});
async function setup(t){
 const f=await fixture(t,'oauth-refresh');
 const env={...f.env,TOKEN_ENCRYPTION_KEY:key,HUBSPOT_CLIENT_ID:'fixture-client',HUBSPOT_CLIENT_SECRET:'fixture-secret'};
 const access=await encryptSecret('original-access',key),refresh=await encryptSecret('original-refresh',key);
 await f.first.query(`UPDATE tenants SET access_token_cipher=$2,access_token_iv=$3,refresh_token_cipher=$4,refresh_token_iv=$5,token_expires_at=$6 WHERE portal_id=$1`,
  [f.portal,access.cipher,access.iv,refresh.cipher,refresh.iv,f.at(0)]);
 const repo=new Repository(env),expected=(await repo.getCredentials(f.portal)).tenant;
 return {...f,env,repo,expected};
}

test('OAuth refresh cannot resurrect or overwrite a different installation grant',{skip:!databaseUrl},async t=>{
 await t.test('successful rotation preserves the active grant and rejects a late old success or failure',async t=>{
  const f=await setup(t);assert.equal(await f.repo.updateTokens(f.portal,tokens(),f.expected),true);
  assert.equal(await f.repo.updateTokens(f.portal,tokens('old'),f.expected),false);
  assert.equal(await f.repo.markDisconnected(f.portal,'refresh_grant_rejected',f.expected),false);
  assert.equal((await f.repo.getCredentials(f.portal)).accessToken,'replacement-access');
  assert.equal((await f.first.query("SELECT COUNT(*)::int n FROM audit_events WHERE portal_id=$1 AND action='app.disconnected'",[f.portal])).rows[0].n,0);
 });
 await t.test('a delayed refresh waits for deletion and cannot change its committed state',async t=>{
  const f=await setup(t),second=new Repository({...f.envFor(f.second),TOKEN_ENCRYPTION_KEY:key});
  await f.first.query('BEGIN');await f.first.query("UPDATE tenants SET status='deleted',access_token_cipher='',refresh_token_cipher='' WHERE portal_id=$1",[f.portal]);
  let done=false;const pending=second.updateTokens(f.portal,tokens(),f.expected).then(v=>{done=true;return v;});
  await new Promise(r=>setTimeout(r,30));assert.equal(done,false);await f.first.query('COMMIT');assert.equal(await pending,false);
  const row=(await f.first.query('SELECT status,access_token_cipher,refresh_token_cipher FROM tenants WHERE portal_id=$1',[f.portal])).rows[0];
  assert.deepEqual(row,{status:'deleted',access_token_cipher:'',refresh_token_cipher:''});
 });
 await t.test('inactive installations cannot decrypt cached credentials or accept rotation',async t=>{
  const f=await setup(t);await f.first.query("UPDATE tenants SET status='disconnected' WHERE portal_id=$1",[f.portal]);
  await assert.rejects(f.repo.getCredentials(f.portal),{code:'installation_inactive'});
  assert.equal(await f.repo.updateTokens(f.portal,tokens(),f.expected),false);
 });
 await t.test('malformed token responses cannot modify the grant',async t=>{
  const f=await setup(t);for(const value of [tokens(),{...tokens(),access_token:''},{...tokens(),expires_in:NaN},{...tokens(),refresh_token:null}].slice(1)){
   await assert.rejects(f.repo.updateTokens(f.portal,value,f.expected),{code:'oauth_refresh_invalid'});
  }
  assert.equal((await f.repo.getCredentials(f.portal)).accessToken,'original-access');
 });
 await t.test('OAuth response reads are bounded and provider redirects are disabled',async t=>{
  const f=await setup(t),saved=globalThis.fetch;t.after(()=>{globalThis.fetch=saved;});
  globalThis.fetch=async(_url,init)=>{assert.equal(init.redirect,'error');assert(init.signal instanceof AbortSignal);return new Response(' '.repeat(65_537),{status:200});};
  await assert.rejects((await HubSpotClient.forPortal(f.env,f.portal)).getPipelines(),{code:'oauth_response_invalid'});
  await assert.rejects(HubSpotClient.exchangeCode({...f.env,APP_BASE_URL:'https://example.test'},'fixture-code'),{code:'oauth_response_invalid'});
  assert.equal((await f.repo.getCredentials(f.portal)).accessToken,'original-access');
 });
 await t.test('transient token service failures preserve optional consent',async t=>{
  const f=await setup(t);await f.first.query("SELECT dealguard.set_intelligence_consent($1,'ai',true,0,'7')",[f.portal]);
  const saved=globalThis.fetch;t.after(()=>{globalThis.fetch=saved;});
  for(const status of [429,500,503]){
   globalThis.fetch=async()=>new Response('{}',{status});
   const client=await HubSpotClient.forPortal(f.env,f.portal);
   await assert.rejects(client.getPipelines(),{code:'hubspot_rate_limited'});
  }
  assert.equal((await f.first.query('SELECT status FROM tenants WHERE portal_id=$1',[f.portal])).rows[0].status,'active');
  assert.deepEqual((await f.first.query("SELECT enabled,revision FROM intelligence_consents WHERE portal_id=$1 AND capability='ai'",[f.portal])).rows[0],{enabled:true,revision:1});
 });
 await t.test('terminal rejection revokes only the exact active grant once',async t=>{
  const f=await setup(t);await f.first.query("SELECT dealguard.set_intelligence_consent($1,'ai',true,0,'7')",[f.portal]);
  const saved=globalThis.fetch;t.after(()=>{globalThis.fetch=saved;});
  globalThis.fetch=async()=>new Response(JSON.stringify({error:'invalid_grant'}),{status:400});
  await assert.rejects((await HubSpotClient.forPortal(f.env,f.portal)).getPipelines(),{code:'hubspot_reauthorization_required'});
  assert.equal(await f.repo.markDisconnected(f.portal,'refresh_grant_rejected',f.expected),false);
  assert.deepEqual((await f.first.query("SELECT enabled,revision FROM intelligence_consents WHERE portal_id=$1 AND capability='ai'",[f.portal])).rows[0],{enabled:false,revision:2});
 });
 await t.test('provider response after uninstall cannot authorize a follow-up CRM request',async t=>{
  const f=await setup(t),saved=globalThis.fetch;t.after(()=>{globalThis.fetch=saved;});
  let release,started;const ready=new Promise(r=>{started=r;}),response=new Promise(r=>{release=r;});let calls=0;
  globalThis.fetch=async()=>{calls++;started();return response;};
  const client=await HubSpotClient.forPortal(f.env,f.portal);
  const pending=client.getPipelines().then(v=>({value:v}),error=>({error}));await ready;
  await f.second.query("UPDATE tenants SET status='deleted' WHERE portal_id=$1",[f.portal]);
  release(new Response(JSON.stringify(tokens()),{status:200}));
  assert.equal((await pending).error.code,'installation_not_found');assert.equal(calls,1);
  assert.equal((await f.first.query('SELECT status FROM tenants WHERE portal_id=$1',[f.portal])).rows[0].status,'deleted');
 });
 await t.test('a failed old refresh cannot disconnect a newer grant or send the old credential',async t=>{
  const f=await setup(t),saved=globalThis.fetch;t.after(()=>{globalThis.fetch=saved;});
  let release,started;const ready=new Promise(r=>{started=r;}),response=new Promise(r=>{release=r;});const auth=[];
  globalThis.fetch=async(url,init)=>{if(String(url).endsWith('/oauth/v1/token')){started();return response;}auth.push(init.headers.authorization);return new Response('{"results":[]}',{status:200});};
  const pending=(await HubSpotClient.forPortal(f.env,f.portal)).getPipelines();await ready;
  assert.equal(await f.repo.updateTokens(f.portal,tokens('reinstalled'),f.expected),true);
  release(new Response('{"status":"BAD_REFRESH_TOKEN"}',{status:400}));assert.deepEqual(await pending,[]);
  assert.deepEqual(auth,['Bearer reinstalled-access']);assert.equal((await f.repo.getCredentials(f.portal)).tenant.status,'active');
 });
 await t.test('callback UPSERT waits for deactivation and rejects the authorization that began before it',async t=>{
  const f=await setup(t),portal=String(Date.now())+String(Math.floor(Math.random()*1000)).padStart(3,'0');f.portalIds.push(portal);
  const info={hub_id:Number(portal),app_id:1,scopes:[],user:'fixture@example.test',hub_domain:'example.test'};
  await f.repo.upsertTenant(tokens('initial'),info,new Date(Date.now()-2000).toISOString());
  const state=randomUUID();await f.repo.createOAuthState(state,null);const authorization=await f.repo.consumeOAuthState(state);
  await f.first.query('BEGIN');await f.first.query("UPDATE tenants SET status='disconnected' WHERE portal_id=$1",[portal]);
  let done=false;const second=new Repository({...f.envFor(f.second),TOKEN_ENCRYPTION_KEY:key});
  const pending=second.upsertTenant(tokens('stale'),info,authorization.issuedAt).then(value=>({value}),error=>({error})).then(result=>{done=true;return result;});
  await new Promise(r=>setTimeout(r,30));assert.equal(done,false);await f.first.query('COMMIT');
  assert.equal((await pending).error.code,'oauth_authorization_superseded');
  assert.equal((await f.first.query('SELECT status FROM tenants WHERE portal_id=$1',[portal])).rows[0].status,'disconnected');
  await new Promise(r=>setTimeout(r,5));const newState=randomUUID();await f.repo.createOAuthState(newState,null);const newAuthorization=await f.repo.consumeOAuthState(newState);
  await f.repo.upsertTenant(tokens('intentional-reinstall'),info,newAuthorization.issuedAt);
  assert.equal((await f.repo.getCredentials(portal)).accessToken,'intentional-reinstall-access');
  await assert.rejects(f.repo.upsertTenant(tokens('late-old-callback'),info,authorization.issuedAt),{code:'oauth_authorization_superseded'});
  assert.equal((await f.repo.getCredentials(portal)).accessToken,'intentional-reinstall-access');
 });
 await t.test('permanent erasure retains only the hashed receipt and blocks old callbacks while allowing a genuinely new reinstall',async t=>{
  const f=await setup(t),portal=String(Date.now())+String(Math.floor(Math.random()*1000)).padStart(3,'0');f.portalIds.push(portal);
  const info={hub_id:Number(portal),app_id:1,scopes:[],user:'fixture@example.test',hub_domain:'example.test'};
  const actor={portalId:portal,userId:'7',userEmail:'fixture@example.test',appId:'1'};
  await f.repo.upsertTenant(tokens('initial'),info,new Date(Date.now()-2000).toISOString());
  await f.first.query("INSERT INTO enterprise_role_assignments(id,portal_id,user_id,role,created_at,updated_at)VALUES($1,$2,'7','administrator',$3,$3)",[randomUUID(),portal,f.at(0)]);
  const state=randomUUID();await f.repo.createOAuthState(state,null);const old=await f.repo.consumeOAuthState(state);
  await f.repo.softDeletePortal(actor);
  await f.first.query("UPDATE tenants SET deletion_requested_at=clock_timestamp()-INTERVAL '17 minutes' WHERE portal_id=$1",[portal]);
  await new Promise(r=>setTimeout(r,5));const during=randomUUID();await f.repo.createOAuthState(during,null);const duringDeletion=await f.repo.consumeOAuthState(during);
  await assert.rejects(f.repo.upsertTenant(tokens('while-deleting'),info,duringDeletion.issuedAt),{code:'oauth_authorization_superseded'});
  const saved=globalThis.fetch;t.after(()=>{globalThis.fetch=saved;});let lists=0;
  globalThis.fetch=async(url,options)=>{assert.equal(new URL(url).hostname,'objects.example.test');assert.equal(options.method,'GET');lists++;return new Response('<ListBucketResult><KeyCount>0</KeyCount><IsTruncated>false</IsTruncated></ListBucketResult>');};
  const deletionEnv={...f.env,TIGRIS_ENDPOINT:'https://objects.example.test',TIGRIS_BUCKET:'fixture',TIGRIS_ACCESS_KEY_ID:'fixture-key',TIGRIS_SECRET_ACCESS_KEY:'fixture-secret'};
  await finalizePortalDeletion(deletionEnv,actor);assert.equal(lists,1);
  assert.equal((await f.first.query('SELECT count(*)::int n FROM tenants WHERE portal_id=$1',[portal])).rows[0].n,0);
  assert.equal((await f.first.query('SELECT count(*)::int n FROM enterprise_role_assignments WHERE portal_id=$1',[portal])).rows[0].n,0);
  assert.equal((await f.first.query('SELECT count(*)::int n FROM audit_events WHERE portal_id=$1',[portal])).rows[0].n,0);
  const receiptId=await sha256Hex(`dealguard-deleted:${portal}`),receipt=(await f.first.query("SELECT portal_id,user_id,user_email,metadata_json FROM audit_events WHERE portal_id=$1 AND action='data.deleted'",[receiptId])).rows;
  assert.deepEqual(receipt,[{portal_id:receiptId,user_id:null,user_email:null,metadata_json:'{}'}]);
  for(const issuedAt of [old.issuedAt,duringDeletion.issuedAt])await assert.rejects(f.repo.upsertTenant(tokens('delayed'),info,issuedAt),{code:'oauth_authorization_superseded'});
  assert.equal((await f.first.query('SELECT count(*)::int n FROM tenants WHERE portal_id=$1',[portal])).rows[0].n,0);
  await new Promise(r=>setTimeout(r,5));const next=randomUUID();await f.repo.createOAuthState(next,null);const current=await f.repo.consumeOAuthState(next);
  await f.repo.upsertTenant(tokens('after-erasure'),info,current.issuedAt);
  assert.equal((await f.repo.getCredentials(portal)).accessToken,'after-erasure-access');
 });
 await t.test('a callback waiting on actual permanent deletion rereads its newly committed receipt before INSERT',async t=>{
  const f=await setup(t),portal=String(Date.now())+String(Math.floor(Math.random()*1000)).padStart(3,'0');f.portalIds.push(portal);
  const info={hub_id:Number(portal),app_id:1,scopes:[],user:'fixture@example.test',hub_domain:'example.test'};
  const actor={portalId:portal,userId:'7',userEmail:'fixture@example.test',appId:'1'};
  await f.repo.upsertTenant(tokens('initial'),info,new Date(Date.now()-2000).toISOString());
  const state=randomUUID();await f.repo.createOAuthState(state,null);const old=await f.repo.consumeOAuthState(state);
  await f.repo.softDeletePortal(actor);
  await f.first.query("UPDATE tenants SET deletion_requested_at=clock_timestamp()-INTERVAL '17 minutes' WHERE portal_id=$1",[portal]);
  const saved=globalThis.fetch;t.after(()=>{globalThis.fetch=saved;});globalThis.fetch=async()=>new Response('<ListBucketResult><KeyCount>0</KeyCount><IsTruncated>false</IsTruncated></ListBucketResult>');
  await f.first.query('BEGIN');
  await finalizePortalDeletion({...f.env,TIGRIS_ENDPOINT:'https://objects.example.test',TIGRIS_BUCKET:'fixture',TIGRIS_ACCESS_KEY_ID:'fixture-key',TIGRIS_SECRET_ACCESS_KEY:'fixture-secret'},actor);
  const second=new Repository({...f.envFor(f.second),TOKEN_ENCRYPTION_KEY:key});let done=false;
  const pending=second.upsertTenant(tokens('stale'),info,old.issuedAt).then(value=>({value}),error=>({error})).then(result=>{done=true;return result;});
  await new Promise(r=>setTimeout(r,30));assert.equal(done,false);await f.first.query('COMMIT');
  assert.equal((await pending).error.code,'oauth_authorization_superseded');
  assert.equal((await f.first.query('SELECT count(*)::int n FROM tenants WHERE portal_id=$1',[portal])).rows[0].n,0);
  await new Promise(r=>setTimeout(r,5));const next=randomUUID();await f.repo.createOAuthState(next,null);const current=await f.repo.consumeOAuthState(next);
  await f.repo.upsertTenant(tokens('fresh'),info,current.issuedAt);assert.equal((await f.repo.getCredentials(portal)).accessToken,'fresh-access');
 });
 await t.test('ordinary token rotation does not invalidate a newly initiated reconnect',async t=>{
  const f=await setup(t),portal=String(Date.now())+String(Math.floor(Math.random()*1000)).padStart(3,'0');f.portalIds.push(portal);
  const info={hub_id:Number(portal),app_id:1,scopes:[],user:'fixture@example.test',hub_domain:'example.test'};
  await f.repo.upsertTenant(tokens('initial'),info,new Date(Date.now()-2000).toISOString());
  const state=randomUUID();await f.repo.createOAuthState(state,null);const authorization=await f.repo.consumeOAuthState(state);
  const expected=(await f.repo.getCredentials(portal)).tenant;await new Promise(r=>setTimeout(r,5));
  await f.repo.updateTokens(portal,tokens('rotation'),expected);
  await f.repo.upsertTenant(tokens('reconnect'),info,authorization.issuedAt);
  assert.equal((await f.repo.getCredentials(portal)).accessToken,'reconnect-access');
 });
});
