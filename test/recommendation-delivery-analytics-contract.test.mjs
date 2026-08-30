import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('delivery analytics endpoint is Enterprise-scoped, GET-only and permission checked', () => {
  const route = read('worker/src/routes-v16.ts');
  const analytics = read('worker/src/recommendation-delivery-analytics.ts');
  const index = read('worker/src/index.ts');
  assert.match(route, /recommendation-delivery-analytics/);
  assert.match(route, /request\.method !== 'GET'/);
  assert.match(route, /requireCommercialTier\(env, identity\.portalId, 'enterprise'\)/);
  assert.match(analytics, /requireEnterprisePermission\(env, identity, 'analytics\.view'\)/);
  assert.match(analytics, /recommendation_delivery_analytics_scope_denied/);
  assert.match(index, /from '\.\/routes-v16\.js'/);
  assert.doesNotMatch(`${route}\n${analytics}`, /HubSpotClient|api\.hubapi\.com|\/crm\//);
  assert.doesNotMatch(`${route}\n${analytics}`, /PATCH|DELETE FROM deals|dealstage\s*=|closedate\s*=/);
});

test('scheduled and explicit policy evaluation record bounded deduplicated control evidence', () => {
  const observer = read('worker/src/recommendation-delivery-observer.ts');
  const maintenance = read('worker/src/maintenance.ts');
  const policyRoute = read('worker/src/routes-v15.ts');
  assert.match(observer, /MAX_EVENTS_PER_RUN = 10_000/);
  assert.match(observer, /EVENT_RETENTION_DAYS = 400/);
  assert.match(observer, /ON CONFLICT\(portal_id, dedupe_key\) DO NOTHING/);
  assert.match(observer, /quiet_hours_deferred/);
  assert.match(observer, /cooldown_suppressed/);
  assert.match(observer, /notification_limit_suppressed/);
  assert.match(observer, /route_unavailable/);
  assert.match(observer, /policy_matched/);
  assert.match(observer, /dispatch_resolved/);
  assert.match(maintenance, /observeRecommendationDeliveryControls\(env\)/);
  assert.match(policyRoute, /observeRecommendationDeliveryControls\(env, identity\.portalId\)/);
});

test('analytics derives delivery, route, channel and scheduler-aware SLA evidence without causal claims', () => {
  const source = read('worker/src/recommendation-delivery-analytics-model.ts');
  const types = read('worker/src/recommendation-delivery-analytics-types.ts');
  assert.match(source, /DELIVERY_ANALYTICS_SCHEDULER_GRACE_MINUTES = 20/);
  assert.match(source, /escalationSla/);
  assert.match(source, /deliverySuccessPercent/);
  assert.match(source, /quietHourDeferrals/);
  assert.match(source, /cooldownSuppressions/);
  assert.match(source, /notificationLimitSuppressions/);
  assert.match(source, /operationalDeliveryOnly: true/);
  assert.match(source, /notDealOutcome: true/);
  assert.match(source, /noCausalAttribution: true/);
  assert.match(source, /noCrmMutation: true/);
  assert.match(types, /schedulerGraceMinutes/);
});

test('migration and Neon registry define the delivery control ledger', () => {
  const migration = read('database/migrations/0021_recommendation_delivery_sla_analytics.sql');
  const postgres = read('worker/src/postgres.ts');
  const validator = read('scripts/postgres-validate-delivery-analytics.mjs');
  assert.match(migration, /CREATE TABLE recommendation_delivery_events/);
  assert.match(migration, /UNIQUE \(portal_id, dedupe_key\)/);
  assert.match(migration, /quiet_hours_deferred/);
  assert.match(migration, /cooldown_suppressed/);
  assert.match(migration, /notification_limit_suppressed/);
  assert.match(migration, /idx_recommendation_delivery_events_time/);
  assert.match(migration, /idx_recommendation_delivery_events_policy/);
  assert.match(migration, /idx_recommendation_delivery_events_route/);
  assert.match(postgres, /'recommendation_delivery_events'/);
  assert.match(validator, /Expected migrations through 0021/);
  assert.match(validator, /deliveryAnalyticsColumnCount/);
  assert.match(validator, /deliveryAnalyticsIndexCount/);
});

test('App Home surface is on-demand and preserves operational interpretation boundaries', () => {
  const panel = read('src/app/pages/RecommendationDeliveryAnalyticsPanel.tsx');
  const composition = read('src/app/pages/ManagerDecisionQueuePanel.tsx');
  assert.match(panel, /Load delivery analytics/);
  assert.match(panel, /recommendation-delivery-analytics\?days=/);
  assert.match(panel, /const WINDOWS = \[7, 30, 90, 180\]/);
  assert.doesNotMatch(panel, /useEffect/);
  assert.match(panel, /Operational evidence only/);
  assert.match(panel, /does not mean a deal progressed/i);
  assert.match(panel, /no CRM read or mutation/i);
  assert.match(panel, /Escalation SLA/);
  assert.match(panel, /Route health/);
  assert.match(panel, /Channel health/);
  assert.match(composition, /RecommendationDeliveryAnalyticsPanel/);
});

test('documentation and focused CI cover delivery and SLA analytics', () => {
  const docs = read('docs/RECOMMENDATION_DELIVERY_SLA_ANALYTICS.md');
  const workflow = read('.github/workflows/recommendation-delivery-analytics.yml');
  assert.match(docs, /notification transport evidence/i);
  assert.match(docs, /20-minute scheduler allowance/i);
  assert.match(docs, /deduplicated operational observations/i);
  assert.match(docs, /No CRM mutation/i);
  assert.match(workflow, /0021_recommendation_delivery_sla_analytics\.sql/);
  assert.match(workflow, /recommendation-delivery-analytics\.test\.mjs/);
  assert.match(workflow, /recommendation-delivery-analytics-contract\.test\.mjs/);
  assert.match(workflow, /postgres-validate-delivery-analytics\.mjs/);
});
