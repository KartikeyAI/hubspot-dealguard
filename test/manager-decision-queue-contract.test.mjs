import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('manager queue uses latest-per-deal state and does not call HubSpot', () => {
  const source = read('worker/src/manager-decision-queue.ts');
  assert.match(source, /SELECT DISTINCT ON \(deal_id\)/);
  assert.match(source, /latest\.is_closed = 0/);
  assert.doesNotMatch(source, /HubSpotClient|api\.hubapi\.com|\/crm\//);
  assert.match(source, /deterministic_management_priority_not_win_probability/);
  assert.match(source, /percentile_within_company_currency_or_same_deal_currency_cohort/);
  assert.match(source, /LIMIT 10000/);
});


test('Neon schema qualification includes the decision snapshot relation', () => {
  const source = read('worker/src/postgres.ts');
  assert.match(source, /'deal_decision_snapshots'/);
});

test('route persists final record enrichment and exposes an enterprise GET endpoint', () => {
  const source = read('worker/src/routes-v11.ts');
  assert.match(source, /MANAGER_DECISION_QUEUE_PATH = '\/api\/v1\/enterprise\/decision-queue'/);
  assert.match(source, /requireCommercialTier\(env, identity\.portalId, 'enterprise'\)/);
  assert.match(source, /managerDecisionQueue\(env, identity, new URL\(request\.url\)\)/);
  assert.match(source, /persistDecisionSnapshot\(env, identity\.portalId, dealId, enriched\)/);
});

test('decision snapshots retain only bounded derived evidence', () => {
  const source = read('worker/src/decision-snapshot.ts');
  assert.match(source, /safeRisks/);
  assert.match(source, /dimensions/);
  assert.doesNotMatch(source, /contacts_json|emails_json|meetings_json|calls_json|quotes_json|line_items_json/);
  assert.match(source, /WHERE excluded\.assessment_at::timestamptz >= deal_decision_snapshots\.assessment_at::timestamptz/);
});

test('migration and validator establish the snapshot table and indexes', () => {
  const migration = read('database/migrations/0016_manager_decision_queue.sql');
  const validator = read('scripts/postgres-validate.mjs');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS deal_decision_snapshots/);
  assert.match(migration, /PRIMARY KEY \(portal_id, deal_id\)/);
  assert.match(migration, /idx_deal_decision_snapshots_queue/);
  assert.match(migration, /idx_deal_decision_snapshots_freshness/);
  assert.match(validator, /Expected migrations through 0019/);
  assert.match(validator, /decisionSnapshotColumnCount/);
  assert.match(validator, /decisionSnapshotIndexCount/);
});

test('focused workflow and documentation cover manager decision queue', () => {
  const workflow = read('.github/workflows/p2-decision-intelligence.yml');
  const docs = read('docs/MANAGER_DECISION_QUEUE.md');
  assert.match(workflow, /0016_manager_decision_queue\.sql/);
  assert.match(workflow, /manager-decision-queue\.test\.mjs/);
  assert.match(workflow, /manager-decision-queue-contract\.test\.mjs/);
  assert.match(docs, /GET \/api\/v1\/enterprise\/decision-queue/);
  assert.match(docs, /not a forecast, win probability, buyer-intent model, or expected-loss estimate/);
  assert.match(docs, /INR, USD, EUR, and unknown-currency values are never combined/);
});
