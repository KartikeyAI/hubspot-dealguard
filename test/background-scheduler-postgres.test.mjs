import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,databaseUrl } from './helpers/postgres-fixture.mjs';
import { Repository } from '../dist/repository.js';
import { saveAssessmentContext } from '../dist/assessment-context.js';
import { dispatchBackgroundIntelligence, finishBackgroundRun, backgroundJobsQuery } from '../dist/background-scheduler.js';

test('portal dispatch, continuation, scheduling fairness and planning context on migrated PostgreSQL',{skip:!databaseUrl},async t=>{
  const {first,second,portal,other,at,env,envFor,sent}=await fixture(t,'scheduler');
  const dbq=q=>first.query(q.sql.replaceAll('?',()=>`$${++dbq.n}`),q.params); // reset below for each query
  const readJobs=async()=>{dbq.n=0;return (await dbq(backgroundJobsQuery(portal,24))).rows.map(r=>r.deal_id);};
  for(const p of [portal,other]) await first.query('INSERT INTO background_intelligence_settings(portal_id,enabled) VALUES($1,1)',[p]);
  const own=()=>sent.filter(m=>[portal,other].includes(m.portalId));
  await t.test('concurrent dispatchers reserve each due portal once without taking an execution lease',async()=>{
    await Promise.all([dispatchBackgroundIntelligence(env),dispatchBackgroundIntelligence(envFor(second))]);
    assert.deepEqual(own().map(m=>m.portalId).sort(),[portal,other].sort());
    await dispatchBackgroundIntelligence(env);assert.equal(own().length,2);
    assert.equal((await first.query('SELECT lease_token FROM background_intelligence_settings WHERE portal_id=$1',[portal])).rows[0].lease_token,null);
  });
  await t.test('expired dispatch reservations recover lost queue messages',async()=>{
    await first.query("UPDATE background_intelligence_settings SET dispatch_expires_at=NOW()-INTERVAL '1 second' WHERE portal_id=$1",[portal]);
    await dispatchBackgroundIntelligence(env);assert.equal(own().filter(m=>m.portalId===portal).length,2);
  });
  await t.test('failed publication clears only its own dispatch reservation',async()=>{
    await first.query('UPDATE background_intelligence_settings SET dispatch_expires_at=NULL WHERE portal_id=$1',[portal]);
    const failing={...env,MAINTENANCE_QUEUE:{async send(){throw new Error('fixture');}}};
    await dispatchBackgroundIntelligence(failing);
    const row=(await first.query('SELECT dispatch_token,last_run_error FROM background_intelligence_settings WHERE portal_id=$1',[portal])).rows[0];
    assert.deepEqual(row,{dispatch_token:null,last_run_error:'background_dispatch_unavailable'});
  });
  const assessment=(id)=>({dealId:id,dealName:id,pipelineLabel:'Sales',stageLabel:'Open',score:80,grade:'B',status:'ready',issues:[],readinessSummary:'Fixture',isClosed:false,isWon:false,handoffEligible:false,assessedAt:at(0)});
  for(let i=1;i<=5;i++){
    const a=assessment(String(i));await new Repository(env).saveAssessment(portal,a);
    await saveAssessmentContext(env,portal,a,{closedate:i===4?new Date(Date.now()+86400000).toISOString():null});
    await first.query("INSERT INTO background_intelligence_jobs(portal_id,deal_id,status,available_at) VALUES($1,$2,'queued',NOW()-($3::integer * INTERVAL '1 hour'))",[portal,String(i),10-i]);
  }
  await first.query("UPDATE deal_assessments SET status='critical',assessed_at=$2 WHERE portal_id=$1 AND deal_id='5'",[portal,at(1)]);
  await t.test('oldest waiting work retains a slot alongside close-date and critical priority',async()=>{
    assert.deepEqual(await readJobs(),['1','4','5']);
    await first.query("UPDATE background_intelligence_jobs SET status='completed',completed_at=NOW(),available_at=NOW()+INTERVAL '1 day' WHERE portal_id=$1 AND deal_id='1'",[portal]);
    assert.deepEqual(await readJobs(),['2','4','5']);
  });
  await t.test('context clocks prevent an older close plan from overwriting current planning data',async()=>{
    const original=(await first.query("SELECT close_date FROM assessment_context WHERE portal_id=$1 AND deal_id='4'",[portal])).rows[0].close_date.toISOString();
    await saveAssessmentContext(env,portal,{...assessment('4'),assessedAt:at(-1)},{closedate:'2040-01-01'});
    assert.equal((await first.query("SELECT close_date FROM assessment_context WHERE portal_id=$1 AND deal_id='4'",[portal])).rows[0].close_date.toISOString(),original);
  });
  const lease=async()=>first.query("UPDATE background_intelligence_settings SET enabled=1,lease_token='owned',lease_expires_at=NOW()+INTERVAL '5 minutes' WHERE portal_id=$1",[portal]);
  await t.test('remaining work produces one delayed continuation and releases the old execution lease',async()=>{
    const messages=[];const e={...env,MAINTENANCE_QUEUE:{async send(body,options){messages.push({body,options});}}};
    await lease();await finishBackgroundRun(e,portal,'owned',null);assert.equal(messages.length,1);assert.equal(messages[0].body.portalId,portal);assert.equal(messages[0].options.delaySeconds,20);
    await finishBackgroundRun(e,portal,'owned',null);assert.equal(messages.length,1);
    const s=(await first.query('SELECT next_run_at,lease_token,dispatch_token FROM background_intelligence_settings WHERE portal_id=$1',[portal])).rows[0];
    assert.equal(s.lease_token,null);assert.ok(s.dispatch_token);assert.ok(s.next_run_at.getTime()>Date.now());
  });
  await t.test('exhausted daily budgets park the portal until the next UTC day',async()=>{
    await first.query("INSERT INTO background_intelligence_usage(portal_id,usage_date,request_count) VALUES($1,(NOW() AT TIME ZONE 'UTC')::date,1000)",[portal]);
    const n=sent.length;await lease();await finishBackgroundRun(env,portal,'owned','background_budget_exhausted');assert.equal(sent.length,n);
    const row=(await first.query("SELECT next_run_at = (((NOW() AT TIME ZONE 'UTC')::date + 1)::timestamp AT TIME ZONE 'UTC') AS midnight,dispatch_token FROM background_intelligence_settings WHERE portal_id=$1",[portal])).rows[0];
    assert.equal(row.midnight,true);assert.equal(row.dispatch_token,null);
  });
  await t.test('revoked execution lease cannot rewrite an administrator pause',async()=>{
    await first.query("UPDATE background_intelligence_settings SET enabled=0,lease_token=NULL,next_run_at=NOW()+INTERVAL '1 day' WHERE portal_id=$1",[portal]);
    await finishBackgroundRun(env,portal,'owned',null);assert.equal((await first.query('SELECT enabled FROM background_intelligence_settings WHERE portal_id=$1',[portal])).rows[0].enabled,0);
  });
});
