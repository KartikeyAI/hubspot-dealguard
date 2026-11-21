import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { fixture,databaseUrl } from './helpers/postgres-fixture.mjs';
import { Repository } from '../dist/repository.js';
import { finalizePortalDeletion,resumePendingPortalDeletions,verifiedPortalDeletionReceipt } from '../dist/data-deletion.js';
import { createSignedObjectUpload,putObject } from '../dist/object-storage.js';

async function setup(t){
 const f=await fixture(t,'erase-retry'),portal=String(Date.now())+String(Math.floor(Math.random()*1000)).padStart(3,'0');f.portalIds.push(portal);
 await f.first.query(`INSERT INTO tenants(portal_id,app_id,access_token_cipher,access_token_iv,refresh_token_cipher,refresh_token_iv,token_expires_at,settings_json,installed_at,updated_at,next_scan_at,commercial_tier,trial_ends_at,installer_email)
  SELECT $1,'1','fixture','fixture','fixture','fixture',token_expires_at,settings_json,installed_at,updated_at,next_scan_at,commercial_tier,trial_ends_at,'installer@example.test' FROM tenants WHERE portal_id=$2`,[portal,f.portal]);
 await f.first.query("INSERT INTO enterprise_role_assignments(id,portal_id,user_id,role,created_at,updated_at)VALUES($1,$2,'7','administrator',$3,$3)",[randomUUID(),portal,f.at(0)]);
 await f.first.query(`INSERT INTO deal_assessments(portal_id,deal_id,deal_name,pipeline_label,stage_label,score,grade,status,issues_json,readiness_summary,is_closed,is_won,assessed_at)
  VALUES($1,'101','Preserved until complete','Pipeline','Stage',55,'D','at_risk','[]','Recorded',0,0,$2)`,[portal,f.at(0)]);
 const actor={portalId:portal,userId:'7',userEmail:'installer@example.test',appId:'1'};
 const storage={TIGRIS_ENDPOINT:'https://objects.example.test',TIGRIS_BUCKET:'fixture',TIGRIS_ACCESS_KEY_ID:'fixture-key',TIGRIS_SECRET_ACCESS_KEY:'fixture-secret'};
 const env={...f.env,...storage},envFor=c=>({...f.envFor(c),...storage});
 const row=async()=>(await f.first.query('SELECT * FROM tenants WHERE portal_id=$1',[portal])).rows[0]??null;
 const due=()=>f.first.query("UPDATE tenants SET deletion_next_attempt_at=clock_timestamp()-INTERVAL '1 second' WHERE portal_id=$1",[portal]);
 const mature=()=>f.first.query("UPDATE tenants SET deletion_requested_at=clock_timestamp()-INTERVAL '17 minutes',deletion_next_attempt_at=clock_timestamp()-INTERVAL '1 second' WHERE portal_id=$1",[portal]);
 return {...f,portal,actor,env,envFor,repo:new Repository(env),row,due,mature};
}
function storageMock(t,portal,initial=[],before){
 const objects=new Set(initial),calls=[];const saved=globalThis.fetch;
 globalThis.fetch=async(url,options)=>{
  const endpoint=new URL(url);assert.equal(endpoint.hostname,'objects.example.test');assert.equal(options.redirect,'error');assert(options.signal instanceof AbortSignal);
  calls.push({method:options.method,url:endpoint,body:options.body});
  const response=await before?.({url:endpoint,options,calls,objects});if(response)return response;
  if(options.method==='GET'){
   assert.equal(endpoint.searchParams.get('prefix'),`portals/${portal}/`);assert.equal(endpoint.searchParams.get('max-keys'),'200');
   const keys=[...objects].slice(0,200);
   return new Response(`<ListBucketResult><EncodingType>url</EncodingType><KeyCount>${keys.length}</KeyCount><IsTruncated>${objects.size>keys.length}</IsTruncated>${keys.map(k=>`<Contents><Key>${encodeURIComponent(k)}</Key></Contents>`).join('')}</ListBucketResult>`);
  }
  assert.equal(options.method,'POST');assert.equal(options.headers.get('content-md5'),createHash('md5').update(options.body).digest('base64'));
  assert.equal(Number(options.headers.get('content-length')),new TextEncoder().encode(options.body).byteLength);
  const entities={'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"};
  const keys=[...options.body.matchAll(/<Key>([^<]*)<\/Key>/g)].map(m=>m[1].replace(/&(amp|lt|gt|quot|apos);/g,x=>entities[x]));
  assert(keys.length>0&&keys.length<=200);for(const key of keys){assert(key.startsWith(`portals/${portal}/`));objects.delete(key);}
  return new Response('<DeleteResult/>');
 };
 t.after(()=>{globalThis.fetch=saved;});return {objects,calls};
}
const pendingCount=async f=>(await f.first.query('SELECT count(*)::int n FROM deal_assessments WHERE portal_id=$1',[f.portal])).rows[0].n;

test('authorized erasure resumes safely after transient failures without reopening installation',{skip:!databaseUrl},async t=>{
 await t.test('storage failure returns pending, backs off, then automatically erases the same authorized intent',async t=>{
  const f=await setup(t);await f.repo.softDeletePortal(f.actor);await f.mature();let fail=true;
  const remote=storageMock(t,f.portal,[`portals/${f.portal}/evidence/one & 二.txt`],()=>fail?new Response('provider credential detail must not persist',{status:503}):undefined);
  const result=await finalizePortalDeletion(f.env,f.actor);assert.equal(result.status,'pending');assert.equal(result.reason,'storage_retryable');
  const state=await f.row();assert.equal(state.status,'deleted');assert.equal(state.access_token_cipher,'');assert.equal(state.deletion_attempts,1);assert.equal(state.deletion_lease_token,null);
  assert(Date.parse(result.retryAt)>Date.now()+20_000);assert.equal(await pendingCount(f),1);
  assert.equal(JSON.stringify(state).includes('provider credential detail'),false);assert.equal(await verifiedPortalDeletionReceipt(f.env,f.portal),null);
  assert.deepEqual(await resumePendingPortalDeletions(f.env,1,f.portal),{attempted:0,completed:0});assert.equal(remote.calls.length,1);
  fail=false;await f.due();assert.deepEqual(await resumePendingPortalDeletions(f.env,1,f.portal),{attempted:1,completed:1});
  assert.equal(await f.row(),null);assert.equal(await pendingCount(f),0);assert.equal(remote.objects.size,0);assert(await verifiedPortalDeletionReceipt(f.env,f.portal));
 });
 await t.test('completion waits for existing upload URLs to expire and sweeps any late object before finalization',async t=>{
  const f=await setup(t),key=`portals/${f.portal}/evidence/late.txt`;await f.repo.softDeletePortal(f.actor);
  const remote=storageMock(t,f.portal);const result=await finalizePortalDeletion(f.env,f.actor);
  assert.equal(result.status,'pending');assert.equal(result.reason,'upload_window');assert(Date.parse(result.retryAt)>Date.now()+15*60_000);
  await assert.rejects(createSignedObjectUpload(f.env,{key,contentType:'text/plain',contentLength:4,sha256:'a'.repeat(64)}),{code:'installation_inactive'});
  await assert.rejects(putObject(f.env,{key,body:'late',contentType:'text/plain',sha256:'a'.repeat(64)}),{code:'installation_inactive'});
  assert.equal(remote.calls.length,1);remote.objects.add(key);await f.mature();
  assert.deepEqual(await resumePendingPortalDeletions(f.env,1,f.portal),{attempted:1,completed:1});assert.equal(remote.objects.size,0);assert.equal(await f.row(),null);
 });
 await t.test('configured or active legal holds block admission before tokens, observations or consent are changed',async t=>{
  for(const mode of ['configured','active']){
   const f=await setup(t);await f.first.query("SELECT dealguard.set_intelligence_consent($1,'outcomes',true,0,'7')",[f.portal]);
   await f.first.query("INSERT INTO outcome_datasets(portal_id,id,consent_revision,fingerprint,manifest,samples)VALUES($1,$2,1,$3,'{}','[]')",[f.portal,randomUUID(),'a'.repeat(64)]);
   if(mode==='configured')await f.first.query("INSERT INTO compliance_settings(portal_id,legal_hold_enabled,updated_at)VALUES($1,1,$2)",[f.portal,f.at(0)]);
   else await f.first.query("INSERT INTO legal_holds(id,portal_id,name,reason,scope_json,status,created_at)VALUES($1,$2,'Held','Held','{}','active',$3)",[randomUUID(),f.portal,f.at(0)]);
   await assert.rejects(f.repo.softDeletePortal(f.actor),{code:'deletion_legal_hold'});
   const row=await f.row();assert.equal(row.status,'active');assert.equal(row.deletion_requested_at,null);assert.equal(row.access_token_cipher,'fixture');assert.equal(await pendingCount(f),1);
   assert.equal((await f.first.query("SELECT enabled FROM intelligence_consents WHERE portal_id=$1 AND capability='outcomes'",[f.portal])).rows[0].enabled,true);
   assert.equal((await f.first.query('SELECT count(*)::int n FROM outcome_datasets WHERE portal_id=$1',[f.portal])).rows[0].n,1);
   assert.equal((await f.first.query("SELECT count(*)::int n FROM audit_events WHERE portal_id=$1 AND action='data.deletion_requested'",[f.portal])).rows[0].n,0);
  }
 });
 await t.test('a hold placed after admission pauses work without provider calls and resumes only after release',async t=>{
  const f=await setup(t);await f.repo.softDeletePortal(f.actor);await f.mature();
  await f.first.query("INSERT INTO compliance_settings(portal_id,legal_hold_enabled,updated_at)VALUES($1,1,$2)",[f.portal,f.at(0)]);
  const remote=storageMock(t,f.portal,[`portals/${f.portal}/evidence/held.txt`]);const result=await finalizePortalDeletion(f.env,f.actor);
  assert.equal(result.status,'held');assert.equal(result.reason,'legal_hold');assert.equal(remote.calls.length,0);assert.equal(await pendingCount(f),1);
  await f.first.query('UPDATE compliance_settings SET legal_hold_enabled=0 WHERE portal_id=$1',[f.portal]);await f.due();
  assert.deepEqual(await resumePendingPortalDeletions(f.env,1,f.portal),{attempted:1,completed:1});assert.equal(remote.objects.size,0);
 });
 await t.test('a hold appearing during listing stops the next destructive storage batch',async t=>{
  const f=await setup(t);await f.repo.softDeletePortal(f.actor);await f.mature();let placed=false;
  const remote=storageMock(t,f.portal,[`portals/${f.portal}/evidence/held.txt`],async({options})=>{
   if(!placed&&options.method==='GET'){placed=true;await f.second.query("INSERT INTO legal_holds(id,portal_id,name,reason,scope_json,status,created_at)VALUES($1,$2,'Held','Held','{}','active',$3)",[randomUUID(),f.portal,f.at(0)]);}
  });
  const result=await finalizePortalDeletion(f.env,f.actor);assert.equal(result.status,'held');assert.equal(remote.calls.filter(c=>c.method==='POST').length,0);
  assert.equal(remote.objects.size,1);assert.equal(await pendingCount(f),1);assert.equal((await f.row()).deletion_last_error,'legal_hold');
 });
 await t.test('only one concurrent sender can operate on a tenant deletion lease',async t=>{
  const f=await setup(t);await f.repo.softDeletePortal(f.actor);await f.mature();let entered,release;
  const started=new Promise(r=>{entered=r;}),gate=new Promise(r=>{release=r;});
  const remote=storageMock(t,f.portal,[],async()=>{entered();await gate;});
  const first=finalizePortalDeletion(f.env,f.actor);await started;
  const second=await finalizePortalDeletion(f.envFor(f.second),f.actor);assert.equal(second.status,'pending');assert.equal(remote.calls.length,1);
  release();assert.equal((await first).status,'completed');assert.equal(remote.calls.length,1);
 });
 await t.test('expired leases can be recovered but an earlier sender cannot defer or finalize the new claim',async t=>{
  const f=await setup(t);await f.repo.softDeletePortal(f.actor);await f.mature();
  const old=(await f.first.query("SELECT dealguard.claim_portal_deletion($1,'old') AS claim",[f.portal])).rows[0].claim;
  await f.first.query("UPDATE tenants SET deletion_lease_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE portal_id=$1",[f.portal]);
  const current=(await f.second.query("SELECT dealguard.claim_portal_deletion($1,'current') AS claim",[f.portal])).rows[0].claim;assert(current);
  assert.equal((await f.first.query('SELECT dealguard.portal_deletion_guard($1,$2,$3) AS state',[f.portal,old.epoch,'old'])).rows[0].state,'source_changed');
  assert.equal((await f.first.query("SELECT dealguard.defer_portal_deletion($1,$2,'old','storage_retryable') AS changed",[f.portal,old.epoch])).rows[0].changed,false);
  assert.equal((await f.first.query("SELECT dealguard.finalize_portal_deletion($1,$2,'old') AS completed",[f.portal,old.epoch])).rows[0].completed,false);
  assert.equal((await f.row()).deletion_lease_token,'current');assert.equal(await pendingCount(f),1);
  await f.first.query("UPDATE tenants SET deletion_lease_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE portal_id=$1",[f.portal]);storageMock(t,f.portal);
  assert.deepEqual(await resumePendingPortalDeletions(f.env,1,f.portal),{attempted:1,completed:1});
 });
 await t.test('per-key errors inside HTTP 200 cannot produce a false completion receipt',async t=>{
  const f=await setup(t);await f.repo.softDeletePortal(f.actor);await f.mature();let partial=true;
  const remote=storageMock(t,f.portal,[`portals/${f.portal}/evidence/failure.txt`],({options})=>partial&&options.method==='POST'?new Response('<DeleteResult><Error><Code>AccessDenied</Code><Message>private provider detail</Message></Error></DeleteResult>'):undefined);
  const result=await finalizePortalDeletion(f.env,f.actor);assert.equal(result.status,'pending');assert.equal(result.reason,'storage_invalid_response');assert.equal(remote.objects.size,1);
  assert.equal(await verifiedPortalDeletionReceipt(f.env,f.portal),null);assert.equal(JSON.stringify(await f.row()).includes('private provider detail'),false);
  partial=false;await f.due();assert.deepEqual(await resumePendingPortalDeletions(f.env,1,f.portal),{attempted:1,completed:1});
 });
 await t.test('a changed installation epoch cannot be erased by an earlier deletion claim',async t=>{
  const f=await setup(t);await f.repo.softDeletePortal(f.actor);await f.mature();
  const old=(await f.first.query("SELECT dealguard.claim_portal_deletion($1,'old-source') AS claim",[f.portal])).rows[0].claim;
  await f.first.query("UPDATE tenants SET status='disconnected' WHERE portal_id=$1",[f.portal]);
  const remote=storageMock(t,f.portal,[`portals/${f.portal}/evidence/preserve.txt`]);
  assert.deepEqual(await resumePendingPortalDeletions(f.env,1,f.portal),{attempted:0,completed:0});assert.equal(remote.calls.length,0);
  assert.equal((await f.first.query('SELECT dealguard.portal_deletion_guard($1,$2,$3) AS state',[f.portal,old.epoch,'old-source'])).rows[0].state,'source_changed');
  assert.equal((await f.first.query('SELECT dealguard.finalize_portal_deletion($1,$2,$3) AS completed',[f.portal,old.epoch,'old-source'])).rows[0].completed,false);
  assert.equal(await pendingCount(f),1);assert.equal(remote.objects.size,1);
 });
 await t.test('malformed listings and another tenant prefix stop before any destructive call',async t=>{
  const f=await setup(t);await f.repo.softDeletePortal(f.actor);await f.mature();let body='{}';
  const remote=storageMock(t,f.portal,[],()=>new Response(body));
  assert.equal((await finalizePortalDeletion(f.env,f.actor)).reason,'storage_invalid_response');
  body='<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>';await f.due();
  assert.equal((await finalizePortalDeletion(f.env,f.actor)).reason,'storage_invalid_response');
  body='<ListBucketResult><IsTruncated>false</IsTruncated><KeyCount>1</KeyCount><Contents><Key>portals/999/other.txt</Key></Contents></ListBucketResult>';await f.due();
  assert.equal((await finalizePortalDeletion(f.env,f.actor)).reason,'storage_invalid_response');assert(remote.calls.every(c=>c.method==='GET'));
  assert.equal(await pendingCount(f),1);assert.equal(await verifiedPortalDeletionReceipt(f.env,f.portal),null);
 });
 await t.test('one bounded pass leaves durable progress and later maintenance drains the remaining prefix',async t=>{
  const f=await setup(t);await f.repo.softDeletePortal(f.actor);await f.mature();
  const remote=storageMock(t,f.portal,Array.from({length:700},(_,i)=>`portals/${f.portal}/evidence/${i}.txt`));
  const first=await finalizePortalDeletion(f.env,f.actor);assert.equal(first.status,'pending');assert.equal(first.reason,'more_objects');assert.equal(remote.calls.length,6);assert.equal(remote.objects.size,100);
  await f.due();assert.deepEqual(await resumePendingPortalDeletions(f.env,1,f.portal),{attempted:1,completed:1});assert.equal(remote.objects.size,0);assert.equal(remote.calls.length,9);
 });
 await t.test('receipt verification rejects an older window and a replacement installation',async t=>{
  const f=await setup(t);await f.repo.softDeletePortal(f.actor);await f.mature();storageMock(t,f.portal);
  const complete=await finalizePortalDeletion(f.env,f.actor);assert.equal(complete.status,'completed');assert(await verifiedPortalDeletionReceipt(f.env,f.portal));
  assert.equal(await verifiedPortalDeletionReceipt(f.env,f.portal,new Date(Date.parse(complete.completedAt)+1000).toISOString()),null);
  await f.first.query(`INSERT INTO tenants(portal_id,app_id,access_token_cipher,access_token_iv,refresh_token_cipher,refresh_token_iv,token_expires_at,settings_json,installed_at,updated_at,next_scan_at)
   SELECT $1,app_id,access_token_cipher,access_token_iv,refresh_token_cipher,refresh_token_iv,token_expires_at,settings_json,installed_at,updated_at,next_scan_at FROM tenants WHERE portal_id=$2`,[f.portal,f.other]);
  assert.equal(await verifiedPortalDeletionReceipt(f.env,f.portal),null);
 });
});
