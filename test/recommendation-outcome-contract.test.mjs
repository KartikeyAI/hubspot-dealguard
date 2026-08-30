import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('Deal Brief persistence observes recommendations without breaking record responses', () => {
  const source = read('worker/src/decision-snapshot.ts');
  assert.match(source, /observeRecommendationSnapshot/);
  assert.match(source, /closeRecommendationsForDeal/);
  assert.match(source, /recommendation_snapshot_observation/);
  assert.match(source, /\.catch\(\(error\) =>/);
  assert.match(source, /return true/);
});

test('recommendation APIs are Enterprise-scoped, permission-aware and CRM-read-free', () => {
  const route = read('worker/src/routes-v13.ts');
  const lifecycle = read('worker/src/recommendation-lifecycle.ts');
  const observation = read('worker/src/recommendation-observation.ts');
  const index = read('worker/src/index.ts');
  assert.match(route, /OUTCOME_ANALYTICS_PATH = '\/api\/v1\/enterprise\/recommendation-outcomes'/);
  assert.match(route, /dealRecommendationsPath/);
  assert.match(route, /accept\|complete\|dismiss/);
  assert.match(route, /requireCommercialTier\(env, identity\.portalId, 'enterprise'\)/);
  assert.match(lifecycle, /requireEnterprisePermission\(env, identity, 'remediation\.view'/);
  assert.match(lifecycle, /requireEnterprisePermission\(env, identity, 'remediation\.manage'/);
  assert.match(lifecycle, /requireEnterprisePermission\(env, identity, 'analytics\.view'/);
  assert.doesNotMatch(`${lifecycle}\n${observation}`, /HubSpotClient|api\.hubapi\.com|\/crm\//);
  assert.match(index, /from '\.\/routes-v13\.js'/);
});

test('lifecycle semantics distinguish expiry, accepted overdue work and terminal states', () => {
  const storage = read('worker/src/recommendation-outcome-storage.ts');
  const lifecycle = read('worker/src/recommendation-lifecycle.ts');
  const observation = read('worker/src/recommendation-observation.ts');
  const migration = read('database/migrations/0018_recommendation_outcomes.sql');
  assert.match(storage, /status = 'presented' AND due_at IS NOT NULL/);
  assert.doesNotMatch(storage, /status IN \('presented', 'accepted'\) AND due_at/);
  assert.match(storage, /row\.status === 'accepted' && Boolean\(dueAt/);
  assert.match(lifecycle, /automaticallyAcceptedOnCompletion: true/);
  assert.match(lifecycle, /dismissal_reason_required/);
  assert.match(observation, /status IN \('presented', 'accepted'\)/);
  assert.match(migration, /preserve_accepted_recommendation_definition/);
  assert.match(migration, /OLD\.status = 'accepted' AND NEW\.status = 'accepted'/);
  assert.match(migration, /NEW\.due_at := OLD\.due_at/);
  assert.match(migration, /NEW\.last_presented_at := OLD\.last_presented_at/);
  assert.match(migration, /'presented', 'accepted', 'completed', 'dismissed', 'expired', 'superseded'/);
  assert.match(migration, /event_type IN \('presented', 'accepted', 'completed', 'dismissed', 'expired', 'superseded', 'outcome_observed'\)/);
});

test('outcome measurement is observational, bounded and non-causal', () => {
  const model = read('worker/src/recommendation-outcome-model.ts');
  const observation = read('worker/src/recommendation-observation.ts');
  const lifecycle = read('worker/src/recommendation-lifecycle.ts');
  const migration = read('database/migrations/0018_recommendation_outcomes.sql');
  assert.match(model, /causalAttribution: false/);
  assert.match(model, /observed association/);
  assert.match(model, /if \(positive > 0 && negative > 0\) return 'mixed'/);
  assert.match(observation, /OBSERVATION_WINDOW_MS = 90/);
  assert.match(observation, /MIN_OBSERVATION_DELAY_MS = 60_000/);
  assert.match(observation, /first_observed_at = COALESCE/);
  assert.match(lifecycle, /completionDoesNotProveImpact: true/);
  assert.match(lifecycle, /missingEvidenceDoesNotMeanFailure: true/);
  assert.match(migration, /causal_attribution INTEGER NOT NULL DEFAULT 0 CHECK \(causal_attribution = 0\)/);
  assert.match(migration, /evaluation_status IN \('pending', 'observed', 'insufficient_evidence'\)/);
});

test('schema, Neon registry and validator cover all recommendation outcome relations', () => {
  const migration = read('database/migrations/0018_recommendation_outcomes.sql');
  const postgres = read('worker/src/postgres.ts');
  const validator = read('scripts/postgres-validate.mjs');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS recommendation_instances/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS recommendation_events/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS recommendation_outcomes/);
  assert.match(migration, /UNIQUE \(portal_id, deal_id, recommendation_fingerprint, baseline_assessment_at\)/);
  assert.match(postgres, /'recommendation_instances','recommendation_events','recommendation_outcomes'/);
  assert.match(validator, /Expected migrations through 0018/);
  assert.match(validator, /recommendationOutcomeColumnCount/);
  assert.match(validator, /recommendationOutcomeIndexCount/);
});

test('analytics reports lifecycle and observed progress without predictive claims', () => {
  const lifecycle = read('worker/src/recommendation-lifecycle.ts');
  assert.match(lifecycle, /acceptanceRatePercent/);
  assert.match(lifecycle, /completionRatePercent/);
  assert.match(lifecycle, /medianHoursToAccept/);
  assert.match(lifecycle, /medianHoursToComplete/);
  assert.match(lifecycle, /improvedSharePercent/);
  assert.match(lifecycle, /observationalOnly: true/);
  assert.match(lifecycle, /causalAttribution: false/);
  assert.doesNotMatch(lifecycle, /winProbability|expectedRevenue|expectedLoss/);
});

test('focused CI and documentation cover recommendation outcome measurement', () => {
  const workflow = read('.github/workflows/p2-decision-intelligence.yml');
  const docs = read('docs/RECOMMENDATION_OUTCOMES.md');
  assert.match(workflow, /recommendation-outcome-types\.ts/);
  assert.match(workflow, /recommendation-outcome-model\.ts/);
  assert.match(workflow, /recommendation-outcome-storage\.ts/);
  assert.match(workflow, /recommendation-observation\.ts/);
  assert.match(workflow, /recommendation-lifecycle\.ts/);
  assert.match(workflow, /0018_recommendation_outcomes\.sql/);
  assert.match(workflow, /recommendation-outcome\.test\.mjs/);
  assert.match(workflow, /recommendation-outcome-contract\.test\.mjs/);
  assert.match(docs, /observed association, not causal attribution/i);
  assert.match(docs, /accepted recommendations do not expire merely because they are overdue/i);
  assert.match(docs, /next product-surface slice/i);
});
