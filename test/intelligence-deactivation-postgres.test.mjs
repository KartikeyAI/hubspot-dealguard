import test from'node:test';import assert from'node:assert/strict';import{randomUUID}from'node:crypto';import{fixture,databaseUrl}from'./helpers/postgres-fixture.mjs';
test('deactivation revokes optional consent and does not silently reactivate it on reinstall',{skip:!databaseUrl},async t=>{
 const{first,portal,other}=await fixture(t,'consent-uninstall');
 async function seed(p){for(const capability of ['outcomes','ai'])await first.query("SELECT dealguard.set_intelligence_consent($1,$2,true,0,'7')",[p,capability]);
 await first.query('INSERT INTO breeze_settings(portal_id,enabled,revision)VALUES($1,true,1)',[p]);
 await first.query("INSERT INTO outcome_datasets(portal_id,id,consent_revision,fingerprint,manifest,samples)VALUES($1,$2,1,$3,'{}','[]')",[p,randomUUID(),'a'.repeat(64)]);
 await first.query(`INSERT INTO ai_runs(portal_id,request_key,actor_id,deal_id,purpose,fingerprint,model_key,consent_revision,assessment_at,state,lease_token,lease_expires_at,request_day,reserved_micro,response_cipher,response_iv,cache_expires_at)
 VALUES($1,'test-request','7','101','risk','test','model',1,'2026-09-01T00:00:00Z','completed','token',NOW(),CURRENT_DATE,1,'encrypted-test-payload','test-iv',NOW()+INTERVAL '15 minutes')`,[p]);}
 await seed(portal);await seed(other);
 await t.test('inactive installation clears non-held optional data and advances every consent revision',async()=>{
 await first.query("UPDATE tenants SET status='disconnected' WHERE portal_id=$1",[portal]);
 assert((await first.query('SELECT enabled,revision FROM intelligence_consents WHERE portal_id=$1',[portal])).rows.every(r=>!r.enabled&&r.revision===2));
 assert.equal((await first.query('SELECT enabled FROM breeze_settings WHERE portal_id=$1',[portal])).rows[0].enabled,false);
 assert.equal((await first.query('SELECT COUNT(*)::int n FROM outcome_datasets WHERE portal_id=$1',[portal])).rows[0].n,0);
 assert.equal((await first.query('SELECT response_cipher FROM ai_runs WHERE portal_id=$1',[portal])).rows[0].response_cipher,null);
 });
 await t.test('reactivation preserves disabled consent and cannot resurrect prior authorization',async()=>{
 await first.query("UPDATE tenants SET status='active' WHERE portal_id=$1",[portal]);assert((await first.query('SELECT enabled FROM intelligence_consents WHERE portal_id=$1',[portal])).rows.every(r=>!r.enabled));
 assert.equal((await first.query('SELECT enabled FROM breeze_settings WHERE portal_id=$1',[portal])).rows[0].enabled,false);
 });
 await t.test('legal hold retains evidence but still revokes access',async()=>{
 const hold=randomUUID();await first.query("INSERT INTO legal_holds(id,portal_id,name,reason,scope_json,status,created_at)VALUES($1,$2,'Test','Test','{}','active','2026-09-01T00:00:00Z')",[hold,other]);
 await first.query("UPDATE tenants SET status='disconnected' WHERE portal_id=$1",[other]);
 assert.equal((await first.query('SELECT COUNT(*)::int n FROM outcome_datasets WHERE portal_id=$1',[other])).rows[0].n,1);
 assert((await first.query('SELECT response_cipher FROM ai_runs WHERE portal_id=$1',[other])).rows[0].response_cipher);
 assert((await first.query('SELECT enabled FROM intelligence_consents WHERE portal_id=$1',[other])).rows.every(r=>!r.enabled));
 });
});
