import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { backgroundBudgetQuery, runBackgroundIntelligence, saveBackgroundIntelligenceSettings, backgroundIntelligenceStatus } from '../dist/background-intelligence.js';
import { HubSpotClient } from '../dist/hubspot.js';
import { Repository } from '../dist/repository.js';
import { DEFAULT_SETTINGS } from '../dist/config.js';
const url=process.env.DEALGUARD_ANALYTICS_TEST_DATABASE_URL;
if(process.env.GITHUB_WORKFLOW==='CI'&&!url) throw new Error('Canonical CI requires isolated PostgreSQL.');

test('background budgets, cancellation, concurrency and actual worker composition on migrated PostgreSQL',{skip:!url},async t=>{
  const {Client}=await import('pg');const {postgresSql}=await import('../dist/postgres.js');
  const first=new Client({connectionString:url}),second=new Client({connectionString:url});
  await first.connect();await second.connect();
  const portal=`background-${randomUUID()}`, other=`background-${randomUUID()}`;
  const originalFetch=globalThis.fetch,originalClient=HubSpotClient.forPortal;
  t.after(async()=>{
    globalThis.fetch=originalFetch;HubSpotClient.forPortal=originalClient;
    await first.query('DELETE FROM dealguard.tenants WHERE portal_id=ANY($1::text[])',[[portal,other]]);
    await first.end();await second.end();
  });
  for(const c of [first,second]) await c.query('SET search_path TO dealguard,public');
  const at=new Date(Date.now()-3600000).toISOString(),future=new Date(Date.now()+86400000).toISOString();
  for(const id of [portal,other]) await first.query(`INSERT INTO tenants (portal_id,app_id,access_token_cipher,access_token_iv,
    refresh_token_cipher,refresh_token_iv,token_expires_at,settings_json,installed_at,updated_at,next_scan_at,commercial_tier,trial_ends_at)
    VALUES ($1,'fixture','fixture','fixture','fixture','fixture',$2,$3,$2,$2,$2,'enterprise',$4)`,[id,at,JSON.stringify(DEFAULT_SETTINGS),future]);
  await first.query(`INSERT INTO background_intelligence_settings(portal_id,enabled,lease_token,lease_expires_at)
    VALUES ($1,1,'lease',NOW()+INTERVAL '1 hour')`,[portal]);
  const execute=(client,query)=>client.query(postgresSql.placeholders(postgresSql.qualifyRelations(query.sql)),query.params);
  const reserve=()=>backgroundBudgetQuery(portal,1,'lease');
  const env={DB:{prepare(sql){const statement={bind(...params){const run=()=>execute(first,{sql,params});return {
    async first(){return (await run()).rows[0]??null;},async all(){return {results:(await run()).rows};},async run(){return {success:true,results:(await run()).rows};}
  };}};return {...statement,all:()=>statement.bind().all(),first:()=>statement.bind().first(),run:()=>statement.bind().run()};}}};
  const actor={portalId:portal,userId:'admin',userEmail:'admin@example.test'};
  await first.query(`INSERT INTO enterprise_role_assignments(id,portal_id,user_id,role,created_at,updated_at)
    VALUES ($1,$2,'admin','administrator',$3,$3)`,[randomUUID(),portal,at]);
  await t.test('two concurrent sessions cannot reserve past the portal budget',async()=>{
    await first.query('UPDATE background_intelligence_settings SET daily_request_limit=100 WHERE portal_id=$1',[portal]);
    const results=await Promise.all(Array.from({length:130},(_,i)=>execute(i%2?first:second,reserve())));
    assert.equal(results.filter(r=>r.rows.length===1).length,100);
    assert.equal((await first.query('SELECT request_count FROM background_intelligence_usage WHERE portal_id=$1',[portal])).rows[0].request_count,100);
  });
  await t.test('wrong portal, version or lease cannot reserve requests',async()=>{
    for(const args of [[other,1,'lease'],[portal,2,'lease'],[portal,1,'other']])
      assert.equal((await execute(first,backgroundBudgetQuery(...args))).rows.length,0);
  });
  await t.test('expired and revoked leases prevent admission',async()=>{
    await first.query("UPDATE background_intelligence_settings SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE portal_id=$1",[portal]);
    assert.equal((await execute(first,reserve())).rows.length,0);
    await first.query("UPDATE background_intelligence_settings SET enabled=0,lease_expires_at=NOW()+INTERVAL '1 hour' WHERE portal_id=$1",[portal]);
    assert.equal((await execute(first,reserve())).rows.length,0);
  });
  await t.test('portal-wide administrator can configure; scoped managers cannot',async()=>{
    const saved=await saveBackgroundIntelligenceSettings(env,actor,{enabled:true,refreshHours:24,dailyRequestLimit:1000});
    assert.equal(saved.settings.enabled,true);
    await first.query(`INSERT INTO enterprise_role_assignments(id,portal_id,user_id,role,pipeline_ids_json,created_at,updated_at)
      VALUES ($1,$2,'scoped','revops_manager','["p"]',$3,$3)`,[randomUUID(),portal,at]);
    await assert.rejects(backgroundIntelligenceStatus(env,{...actor,userId:'scoped'}),{status:403});
  });
  const repository=new Repository(env);
  await repository.saveAssessment(portal,{dealId:'1',dealName:'Fixture deal',pipelineLabel:'Sales',stageLabel:'Open',pipelineId:'p',stageId:'s',
    score:80,grade:'B',status:'ready',issues:[],readinessSummary:'Fixture',isClosed:false,isWon:false,handoffEligible:false,assessedAt:at});
  let calls=0;
  HubSpotClient.forPortal=async(e,id,policy)=>{
    assert.equal(id,portal);assert.ok(policy,'Background must use the guarded real client.');
    return new HubSpotClient(e,{tenant:{portal_id:portal,token_expires_at:future,plan:'enterprise'},accessToken:'test-only',refreshToken:'test-only',settings:DEFAULT_SETTINGS},policy);
  };
  globalThis.fetch=async(input,init)=>{
    calls++; const path=new URL(String(input)).pathname;
    assert.equal(new URL(String(input)).origin,'https://api.hubapi.com');
    assert.ok(!['PATCH','DELETE','PUT'].includes(init.method));
    assert.equal(init.redirect,'error'); assert.ok(init.signal);
    const properties={dealname:'Fixture deal',pipeline:'p',dealstage:'s',amount:'100',amount_in_home_currency:'100',deal_currency_code:'USD',hubspot_owner_id:'admin'};
    let body={results:[]};
    if(path.includes('pipelines')) body={results:[{id:'p',label:'Sales',stages:[{id:'s',label:'Open',displayOrder:1,metadata:{isClosed:false,probability:'0.2'}}]}]};
    else if(path==='/crm/v3/objects/deals/1'||path==='/crm/objects/2026-03/deals/1') body={id:'1',properties,associations:{contacts:{results:[]},companies:{results:[]}},propertiesWithHistory:{}};
    return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});
  };
  await t.test('a never-opened deal receives a real composed assessment and snapshot via guarded fixture HTTP',async()=>{
    await runBackgroundIntelligence(env);
    const job=(await first.query('SELECT * FROM background_intelligence_jobs WHERE portal_id=$1',[portal])).rows[0];
    assert.equal(job.status,'completed');assert.ok(job.request_count>0&&job.request_count<=40);
    assert.ok(calls>0);assert.ok((await first.query('SELECT * FROM deal_decision_snapshots WHERE portal_id=$1',[portal])).rows.length===1);
    assert.equal((await first.query('SELECT count(*) FROM notification_events WHERE portal_id=$1',[portal])).rows[0].count,'0');
    assert.equal((await first.query('SELECT count(*) FROM outbox_events WHERE portal_id=$1',[portal])).rows[0].count,'0');
  });
  await t.test('an immediate duplicate maintenance message does not re-enrich or spend budget',async()=>{
    const before=calls;await runBackgroundIntelligence(env);assert.equal(calls,before);
  });
  await t.test('pause cancels pending work and prevents provider calls',async()=>{
    await first.query("UPDATE background_intelligence_jobs SET status='queued',available_at=NOW() WHERE portal_id=$1",[portal]);
    await saveBackgroundIntelligenceSettings(env,actor,{enabled:false,refreshHours:24,dailyRequestLimit:1000});
    const before=calls;await runBackgroundIntelligence(env);assert.equal(calls,before);
    assert.equal((await first.query('SELECT status FROM background_intelligence_jobs WHERE portal_id=$1',[portal])).rows[0].status,'cancelled');
  });
});
