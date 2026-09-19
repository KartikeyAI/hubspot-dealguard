import test from'node:test';import assert from'node:assert/strict';import{randomUUID}from'node:crypto';
import{fixture,databaseUrl}from'./helpers/postgres-fixture.mjs';import{purgeOperationalReceipts}from'../dist/maintenance.js';
test('receipt retention respects configured and active holds on migrated PostgreSQL',{skip:!databaseUrl},async t=>{
 const{first,portal,other,at,env}=await fixture(t,'receipt-holds');const old=new Date(Date.now()-40*86400000).toISOString();
 const seed=async()=>{for(const p of[portal,other])await first.query(`INSERT INTO inbound_events(event_key,portal_id,event_type,object_id,status,occurred_at,created_at)
 VALUES($1,$2,'test','1','processed',$3,$3)`,[randomUUID(),p,old]);};
 await seed();await first.query('INSERT INTO compliance_settings(portal_id,legal_hold_enabled,updated_at)VALUES($1,1,$2)',[portal,at(0)]);
 await purgeOperationalReceipts(env);assert.equal((await first.query('SELECT count(*) FROM inbound_events WHERE portal_id=$1',[portal])).rows[0].count,'1');assert.equal((await first.query('SELECT count(*) FROM inbound_events WHERE portal_id=$1',[other])).rows[0].count,'0');
 await first.query('UPDATE compliance_settings SET legal_hold_enabled=0 WHERE portal_id=$1',[portal]);
 await first.query("INSERT INTO legal_holds(id,portal_id,name,reason,scope_json,status,created_at)VALUES($1,$2,'test','test','{}','active',$3)",[randomUUID(),portal,at(0)]);
 await purgeOperationalReceipts(env);assert.equal((await first.query('SELECT count(*) FROM inbound_events WHERE portal_id=$1',[portal])).rows[0].count,'1');
 await first.query("UPDATE legal_holds SET status='released' WHERE portal_id=$1",[portal]);await purgeOperationalReceipts(env);assert.equal((await first.query('SELECT count(*) FROM inbound_events WHERE portal_id=$1',[portal])).rows[0].count,'0');
});
