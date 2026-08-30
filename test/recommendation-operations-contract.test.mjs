import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('follow-up APIs require Enterprise entitlement, remediation.bulk and human confirmation', () => {
  const route = read('worker/src/routes-v14.ts');
  const operations = read('worker/src/recommendation-operations.ts');
  const index = read('worker/src/index.ts');
  assert.match(route, /recommendation-followups\/preview/);
  assert.match(route, /recommendation-followups\/\(\[\^\/\]\+\)\/confirm/);
  assert.match(route, /requireCommercialTier\(env, identity\.portalId, 'enterprise'\)/);
  assert.match(operations, /requireEnterprisePermission\(env, identity, 'remediation\.bulk'\)/);
  assert.match(operations, /PREVIEW_TTL_MS = 15 \* 60_000/);
  assert.match(operations, /MAX_RECOMMENDATIONS = 100/);
  assert.match(operations, /sameActor/);
  assert.match(operations, /ctx\.waitUntil\(deliverRecommendationFollowupBatch/);
  assert.match(index, /from '\.\/routes-v14\.js'/);
});

test('routing requires explicit event opt-in and revalidation before delivery', () => {
  const model = read('worker/src/recommendation-operations-model.ts');
  const operations = read('worker/src/recommendation-operations.ts');
  assert.match(model, /route\.eventTypes\.includes\(RECOMMENDATION_FOLLOWUP_EVENT\)/);
  assert.doesNotMatch(model, /eventTypes\.length === 0.*true/);
  assert.match(operations, /recommendation_followup_routing_changed/);
  assert.match(operations, /routing\.fingerprint !== item\.routing_fingerprint/);
  assert.match(operations, /quietRouteIds/);
  assert.match(operations, /Every selected recommendation must be active and have an explicitly opted-in notification route/);
});

test('delivery is deterministic, audited and never mutates HubSpot CRM', () => {
  const operations = read('worker/src/recommendation-operations.ts');
  assert.match(operations, /followup_requested/);
  assert.match(operations, /recommendation\.followup_confirmed/);
  assert.match(operations, /recommendation\.followup_delivery_completed/);
  assert.match(operations, /noCrmMutation: true/);
  assert.match(operations, /notificationContentIsDeterministic: true/);
  assert.doesNotMatch(operations, /HubSpotClient|api\.hubapi\.com|\/crm\//);
  assert.doesNotMatch(operations, /dealstage|closedate\s*=|hubspot_owner_id\s*=|hs_next_step\s*=/);
});

test('secure recommendation evidence export is scoped, bounded and spreadsheet-safe', () => {
  const downloads = read('worker/src/secure-downloads.ts');
  const exporter = read('worker/src/recommendation-evidence-export.ts');
  const model = read('worker/src/recommendation-operations-model.ts');
  assert.match(downloads, /recommendation_evidence/);
  assert.match(downloads, /analytics\.export/);
  assert.match(exporter, /requireEnterprisePermission\(env, identity, 'analytics\.export'\)/);
  assert.match(exporter, /analyticsScopeFilter/);
  assert.match(exporter, /MAX_ROWS = 10_000/);
  assert.match(exporter, /causalAttribution: false/);
  assert.match(exporter, /x-dealguard-export-truncated/);
  assert.match(model, /\^\[=\+\\-@\]/);
  assert.doesNotMatch(exporter, /email_body|meeting_body|call_recording|quote_document|contact_email/i);
});

test('migration and Neon registry cover governed follow-up batches', () => {
  const migration = read('database/migrations/0019_recommendation_operations.sql');
  const postgres = read('worker/src/postgres.ts');
  const validator = read('scripts/postgres-validate.mjs');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS recommendation_followup_batches/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS recommendation_followup_items/);
  assert.match(migration, /recommendation_evidence/);
  assert.match(migration, /followup_requested/);
  assert.match(migration, /UNIQUE \(batch_id, recommendation_id\)/);
  assert.match(migration, /FOREIGN KEY \(recommendation_id\) REFERENCES recommendation_instances/);
  assert.match(postgres, /'recommendation_followup_batches','recommendation_followup_items'/);
  assert.match(validator, /Expected migrations through 0019/);
  assert.match(validator, /recommendationOperationsColumnCount/);
  assert.match(validator, /recommendationOperationsIndexCount/);
});

test('focused CI and documentation cover recommendation operations', () => {
  const workflow = read('.github/workflows/p2-decision-intelligence.yml');
  const docs = read('docs/RECOMMENDATION_OPERATIONS.md');
  assert.match(workflow, /recommendation-operations-types\.ts/);
  assert.match(workflow, /recommendation-operations-model\.ts/);
  assert.match(workflow, /recommendation-operations\.ts/);
  assert.match(workflow, /recommendation-evidence-export\.ts/);
  assert.match(workflow, /0019_recommendation_operations\.sql/);
  assert.match(workflow, /recommendation-operations\.test\.mjs/);
  assert.match(workflow, /recommendation-operations-contract\.test\.mjs/);
  assert.match(docs, /explicit route opt-in/i);
  assert.match(docs, /human confirmation/i);
  assert.match(docs, /no CRM mutation/i);
  assert.match(docs, /one-time secure download/i);
});
