import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Repository } from '../dist/repository.js';
import { persistDecisionSnapshot } from '../dist/decision-snapshot.js';
const url=process.env.DEALGUARD_ANALYTICS_TEST_DATABASE_URL;
if(process.env.GITHUB_WORKFLOW==='CI'&&!url) throw new Error('Canonical CI requires isolated PostgreSQL.');

test('assessment closure and late snapshot/recommendation writes are serialized',{skip:!url},async t=>{
  const {Client}=await import('pg');const {postgresSql}=await import('../dist/postgres.js');
  const first=new Client({connectionString:url}),second=new Client({connectionString:url});
  await first.connect();await second.connect();
  const portal=`fence-${randomUUID()}`,at=n=>new Date(Date.now()-3600000+n*1000).toISOString();
  // Stable source instants independent of the time taken by an individual query.
  const times=Array.from({length:20},(_,i)=>at(i));
  t.after(async()=>{await first.query('ROLLBACK');await second.query('ROLLBACK');
    await first.query('DELETE FROM dealguard.tenants WHERE portal_id=$1',[portal]);await first.end();await second.end();});
  await first.query(`INSERT INTO dealguard.tenants(portal_id,app_id,access_token_cipher,access_token_iv,refresh_token_cipher,refresh_token_iv,
    token_expires_at,settings_json,installed_at,updated_at,next_scan_at) VALUES($1,'fixture','fixture','fixture','fixture','fixture',$2,'{}',$2,$2,$2)`,[portal,times[0]]);
  const envFor=client=>({DB:{prepare(sql){return {bind(...params){const run=()=>client.query(postgresSql.placeholders(postgresSql.qualifyRelations(sql)),params);return {
    async first(){return (await run()).rows[0]??null;},async all(){return {results:(await run()).rows};},
    async run(){const r=await run();return {success:true,results:r.rows,meta:{changes:r.rowCount}};}
  };}};}}});
  const env=envFor(first),repo=new Repository(env);
  const assessment=(n,closed=false)=>({dealId:'1',dealName:'Fixture',score:80,grade:'B',status:'ready',issues:[],readinessSummary:'Fixture',
    pipelineLabel:'Sales',stageLabel:closed?'Closed':'Open',isClosed:closed,isWon:false,handoffEligible:false,assessedAt:times[n]});
  const payload=n=>({...assessment(n),intelligence:{dealBrief:{generatedAt:times[n+1],status:'on_track',attentionScore:20,
    confidence:'high',coverage:{percent:100},freshness:{status:'fresh'},risks:[],nextAction:null}}});
  const saved=async()=> (await first.query('SELECT * FROM dealguard.deal_decision_snapshots WHERE portal_id=$1',[portal])).rows;
  const rec=(id,status,n)=>first.query(`INSERT INTO dealguard.recommendation_instances(id,portal_id,deal_id,recommendation_fingerprint,
    recommendation_code,recommendation_label,recommendation_text,recommendation_dimension,priority,owner_role,rationale,methodology,status,
    presented_at,last_presented_at,baseline_assessment_at,baseline_snapshot_generated_at,created_at,updated_at)
    VALUES($1,$2,'1',$1,'test','Fixture','Fixture','readiness','high','deal_owner','Fixture','test',$3,$4,$4,$4,$5,$4,$4) RETURNING id`,
    [id,portal,status,times[n],times[n+1]]);
  await t.test('matching open snapshot accepts active baseline instances',async()=>{
    await repo.saveAssessment(portal,assessment(1));assert.equal(await persistDecisionSnapshot(env,portal,'1',payload(1)),true);
    assert.equal((await rec(randomUUID(),'presented',1)).rowCount,1);
    assert.equal((await rec(randomUUID(),'accepted',1)).rowCount,1);
  });
  await t.test('closure removes the snapshot and records terminal events in the same transaction',async()=>{
    await repo.saveAssessment(portal,assessment(3,true));assert.equal((await saved()).length,0);
    const rows=(await first.query('SELECT status FROM dealguard.recommendation_instances WHERE portal_id=$1 ORDER BY status',[portal])).rows;
    assert.deepEqual(rows.map(r=>r.status),['expired','superseded']);
    assert.equal((await first.query('SELECT count(*) FROM dealguard.recommendation_events WHERE portal_id=$1',[portal])).rows[0].count,'2');
  });
  await t.test('repeated closure does not duplicate terminal events',async()=>{
    await persistDecisionSnapshot(env,portal,'1',assessment(3,true));
    await persistDecisionSnapshot(env,portal,'1',assessment(3,true));
    assert.equal((await first.query('SELECT count(*) FROM dealguard.recommendation_events WHERE portal_id=$1',[portal])).rows[0].count,'2');
  });
  await t.test('a late closed payload cannot erase a subsequently reopened deal brief',async()=>{
    await repo.saveAssessment(portal,assessment(5));await persistDecisionSnapshot(env,portal,'1',payload(5));
    await persistDecisionSnapshot(env,portal,'1',assessment(3,true));
    assert.equal((await saved())[0].assessment_at,times[5]);
  });
  await t.test('active recommendations cannot be recreated from an old closure episode',async()=>{
    assert.equal((await rec(randomUUID(),'presented',1)).rowCount,0);
    assert.equal((await rec(randomUUID(),'presented',5)).rowCount,1);
  });
  await t.test('new accepted assessment invalidates the former brief even before enrichment runs',async()=>{
    await repo.saveAssessment(portal,assessment(7));assert.equal((await saved()).length,0);
  });
  await t.test('a snapshot waiting on a concurrent close cannot revive active evidence',async()=>{
    await first.query('BEGIN');await repo.saveAssessment(portal,assessment(9,true));
    const pending=persistDecisionSnapshot(envFor(second),portal,'1',payload(7));
    const early=await Promise.race([pending.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),100))]);
    assert.equal(early,false,'The snapshot must wait for the parent assessment lock.');
    await first.query('COMMIT');assert.equal(await pending,false);assert.equal((await saved()).length,0);
  });
  await t.test('a close waiting on an accepted snapshot removes it after acquiring the same parent lock',async()=>{
    await repo.saveAssessment(portal,assessment(11));
    await first.query('BEGIN');assert.equal(await persistDecisionSnapshot(env,portal,'1',payload(11)),true);
    const close=new Repository(envFor(second)).saveAssessment(portal,assessment(13,true));
    const early=await Promise.race([close.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),100))]);
    assert.equal(early,false);await first.query('COMMIT');assert.equal(await close,true);assert.equal((await saved()).length,0);
  });
  await t.test('rolling back closure restores assessment, snapshot and recommendation state together',async()=>{
    await repo.saveAssessment(portal,assessment(15));await persistDecisionSnapshot(env,portal,'1',payload(15));
    const id=randomUUID();await rec(id,'accepted',15);
    const countBefore=(await first.query('SELECT count(*) FROM dealguard.recommendation_events WHERE portal_id=$1',[portal])).rows[0].count;
    await first.query('BEGIN');await repo.saveAssessment(portal,assessment(17,true));await first.query('ROLLBACK');
    assert.equal((await saved()).length,1);
    assert.equal((await first.query('SELECT status FROM dealguard.recommendation_instances WHERE id=$1',[id])).rows[0].status,'accepted');
    assert.equal((await first.query('SELECT count(*) FROM dealguard.recommendation_events WHERE portal_id=$1',[portal])).rows[0].count,countBefore);
  });
});
