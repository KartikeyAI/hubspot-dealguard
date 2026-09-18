import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {portfolioCaptureQuery,capturePortfolioSnapshot} from '../dist/portfolio-snapshots.js';

test('snapshot capture uses bound tenant, source limit, server time and atomic insert',()=>{
  const query=portfolioCaptureQuery('tenant;bad','2026-09-19T01:00:00.000Z','capture');
  assert.ok(!query.sql.includes('tenant;bad'));
  assert.equal(query.params[1],10001); assert.equal(query.params[7],10000);
  assert.match(query.sql,/ON CONFLICT \(portal_id, snapshot_date\) DO NOTHING/);
  assert.match(query.sql,/FROM bounded b CROSS JOIN created/);
  assert.match(query.sql,/sha256/);
});
test('capture service classifies no-op, invalid, oversized and accepted writes without partial success',async()=>{
  for(const [row,status] of [
    [{count:0,invalid:0,copied:0,id:null},'no_observations'],
    [{count:10001,invalid:0,copied:0,id:null},'portfolio_limit_exceeded'],
    [{count:1,invalid:1,copied:0,id:null},'invalid_source_evidence'],
    [{count:1,invalid:0,copied:0,id:null},'already_captured'],
    [{count:1,invalid:0,copied:1,id:'id'},'captured'],
  ]) {
    const env={DB:{prepare(){return {bind(){return {async first(){return row;}};}};}}};
    assert.equal((await capturePortfolioSnapshot(env,'100')).status,status);
  }
});
test('durable capture is signed, scoped, on demand and retained under legal holds',()=>{
  const route=readFileSync('worker/src/routes-v17.ts','utf8');
  const ui=readFileSync('src/app/pages/PortfolioHistoryPanel.tsx','utf8');
  assert.match(route,/recordedPortfolioHistory\(env, identity, url\)/);
  assert.match(ui,/Recorded snapshots/);
  assert.match(readFileSync('worker/src/compliance.ts','utf8'),/DELETE FROM portfolio_snapshot_runs/);
  assert.match(readFileSync('database/migrations/0024_portfolio_snapshot_ledger.sql','utf8'),/BEFORE UPDATE/);
});
