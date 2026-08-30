import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('executive revenue endpoint is Enterprise-scoped, read-only and failure-isolates snapshot persistence', () => {
  const route = read('worker/src/routes-v12.ts');
  const index = read('worker/src/index.ts');
  assert.match(route, /EXECUTIVE_REVENUE_PATH = '\/api\/v1\/enterprise\/executive-revenue'/);
  assert.match(route, /request\.method !== 'GET'/);
  assert.match(route, /requireCommercialTier\(env, identity\.portalId, 'enterprise'\)/);
  assert.match(route, /ctx\.waitUntil\(result\.persist\(\)\.catch/);
  assert.match(route, /return routeV11\(request, env, ctx\)/);
  assert.match(index, /from '\.\/routes-v12\.js'/);
  assert.doesNotMatch(route, /PATCH|DELETE|PUT/);
});

test('loader uses bounded deal reads, existing permissions and no communication content', () => {
  const source = read('worker/src/executive-revenue.ts');
  const config = read('worker/src/config.ts');
  assert.match(source, /PLAN_LIMITS\[client\.plan\]\.maxDealsPerScan/);
  assert.match(source, /client\.listDeals\(maxDeals, \['hs_forecast_category'\]\)/);
  assert.match(source, /requireEnterprisePermission\(env, identity, 'analytics\.view'\)/);
  assert.match(source, /CACHE_TTL_MS = 120_000/);
  assert.match(source, /SNAPSHOT_RETENTION_DAYS = 730/);
  assert.doesNotMatch(source, /hs_email|hs_meeting|hs_call|recording_url|transcript|line_items|quotes/i);
  assert.doesNotMatch(config, /forecast[^'"\n]*\.read/i);
});

test('analysis preserves current-state, currency and non-predictive semantics', () => {
  const source = read('worker/src/executive-revenue-analysis.ts');
  const cohorts = read('worker/src/executive-revenue-cohorts.ts');
  const candidates = read('worker/src/executive-revenue-candidates.ts');
  assert.match(source, /amountNeverCombinedAcrossCurrencies: true/);
  assert.match(source, /notWinProbability: true/);
  assert.match(source, /notExpectedRevenue: true/);
  assert.match(source, /notExpectedLoss: true/);
  assert.match(cohorts, /periodPipelineCoveragePercent/);
  assert.match(candidates, /slippage_review/);
  assert.match(candidates, /pull_in_review/);
  assert.match(cohorts, /hhi/);
  assert.match(candidates, /baseline_only/);
});

test('migration and Neon adapter register the bounded executive snapshot model', () => {
  const migration = read('database/migrations/0017_executive_revenue_view.sql');
  const postgres = read('worker/src/postgres.ts');
  const validator = read('scripts/postgres-validate.mjs');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS executive_revenue_snapshots/);
  assert.match(migration, /PRIMARY KEY \(portal_id, snapshot_date, deal_id\)/);
  assert.match(migration, /FOREIGN KEY \(portal_id\) REFERENCES tenants/);
  assert.match(migration, /forecast_category TEXT/);
  assert.match(migration, /amount_in_company_currency NUMERIC/);
  assert.match(migration, /idx_executive_revenue_snapshots_period/);
  assert.match(migration, /idx_executive_revenue_snapshots_movement/);
  assert.match(migration, /idx_executive_revenue_snapshots_concentration/);
  assert.match(postgres, /'executive_revenue_snapshots'/);
  assert.match(validator, /Expected migrations through 0017/);
  assert.match(validator, /executiveSnapshotColumnCount/);
  assert.match(validator, /executiveSnapshotIndexCount/);
});

test('documentation and focused CI cover the executive revenue view', () => {
  const docs = read('docs/EXECUTIVE_REVENUE_VIEW.md');
  const workflow = read('.github/workflows/p2-decision-intelligence.yml');
  assert.match(docs, /Recorded forecast categories/);
  assert.match(docs, /It is not quota coverage/);
  assert.match(docs, /deterministic review prompts, not predictions/);
  assert.match(docs, /App Home Executive Revenue View panel is deliberately deferred/);
  assert.match(workflow, /executive-revenue-model\.ts/);
  assert.match(workflow, /executive-revenue-cohorts\.ts/);
  assert.match(workflow, /executive-revenue-candidates\.ts/);
  assert.match(workflow, /0017_executive_revenue_view\.sql/);
  assert.match(workflow, /executive-revenue\.test\.mjs/);
  assert.match(workflow, /executive-revenue-contract\.test\.mjs/);
});
