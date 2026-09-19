import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { backgroundCloseDate, backgroundCoverage, backgroundJobsQuery, backgroundPortal } from '../dist/background-scheduler.js';

test('planning close dates accept explicit dates and epochs without accepting impossible calendars',()=>{
  assert.equal(backgroundCloseDate('2026-09-20'),'2026-09-20T00:00:00.000Z');
  assert.equal(backgroundCloseDate(String(Date.parse('2026-09-20T00:00:00Z'))),'2026-09-20T00:00:00.000Z');
  assert.equal(backgroundCloseDate('2026-09-20T05:30:00+05:30'),'2026-09-20T00:00:00.000Z');
  for(const value of [null,42,true,'2026-02-30','2026-09-20 10:00','1.5','1e12','999999999999999']) assert.equal(backgroundCloseDate(value),null);
});
test('coverage uses the assessment observation rather than freshly regenerated snapshot time',()=>{
  const now=Date.parse('2026-09-20T12:00:00Z');
  const row=hours=>({assessed_at:new Date(now-hours*3600000).toISOString(),assessment_at:new Date(now-hours*3600000).toISOString(),generated_at:new Date(now).toISOString(),freshness_status:'fresh'});
  assert.deepEqual(backgroundCoverage([row(24),row(24.01),row(72),row(72.01),{},row(-1)],now),
    {open_deals:6,recent_briefs:1,aging_briefs:2,stale_briefs:1,unavailable_briefs:2});
  assert.equal(backgroundCoverage(Array(10001).fill(row(0)),now),null);
});
test('internal portal and job-selection boundaries remain bounded and parameterized',()=>{
  assert.equal(backgroundPortal('123'),'123');for(const value of ['',null,' 123','1\n2','a'.repeat(101)]) assert.throws(()=>backgroundPortal(value));
  const q=backgroundJobsQuery('portal-secret-value',24);assert.deepEqual(q.params,['portal-secret-value',24]);assert.ok(!q.sql.includes('portal-secret-value'));
  assert.match(q.sql,/fairness_order = 1/);assert.match(q.sql,/close_date BETWEEN/);assert.match(q.sql,/LIMIT 3/);assert.match(q.sql,/record_is_available/);
});
test('scheduler has dispatch reservations, bounded delayed continuation and no provider calls',()=>{
  const source=readFileSync('worker/src/background-scheduler.ts','utf8');
  assert.match(source,/FOR UPDATE OF s SKIP LOCKED LIMIT 100/);assert.match(source,/dispatch_token = \?/);assert.match(source,/delaySeconds: BACKGROUND_CONTINUATION_DELAY/);
  assert.ok(!source.includes('fetch('));assert.ok(!source.includes('HubSpotClient'));
  assert.match(readFileSync('worker/src/queueing.ts','utf8'),/runBackgroundIntelligence\(env, message.portalId\)/);
});
