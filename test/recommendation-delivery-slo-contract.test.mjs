import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('delivery SLO APIs are Enterprise, portal-wide and reliability permission scoped', () => {
  const route = read('worker/src/routes-v17.ts');
  const storage = read('worker/src/recommendation-delivery-slos.ts');
  const routeSetup = read('worker/src/recommendation-delivery-slo-route-setup.ts');
  const index = read('worker/src/index.ts');
  assert.match(route, /SLO_ROOT = '\/api\/v1\/enterprise\/recommendation-delivery-slos'/);
  assert.match(route, /requireCommercialTier\(env, identity\.portalId, 'enterprise'\)/);
  assert.match(route, /recommendation-delivery-slos.*incidents.*acknowledge/);
  assert.match(route, /recommendation-delivery-slos.*routes.*enable-events/);
  assert.match(storage, /requireEnterprisePermission\(env, identity, permission\)/);
  assert.match(storage, /delivery_slo_portal_scope_required/);
  assert.match(storage, /'reliability\.view'/);
  assert.match(storage, /'reliability\.manage'/);
  assert.match(routeSetup, /permissionMatches\(access\.permissions, 'alert\.manage'\)/);
  assert.match(index, /from '\.\/routes-v17\.js'/);
});

test('SLO lifecycle requires sufficient persistent evidence and never treats truncation as breach', () => {
  const model = read('worker/src/recommendation-delivery-slo-model.ts');
  const evaluator = read('worker/src/recommendation-delivery-slo-evaluator.ts');
  assert.match(model, /if \(evidence\.truncated\)/);
  assert.match(model, /sufficient: false/);
  assert.match(model, /state\.consecutiveBreaches < policy\.breachEvaluations/);
  assert.match(model, /state\.consecutiveRecoveries < policy\.recoveryEvaluations/);
  assert.match(model, /incident\.alertCount < policy\.maxAlertsPerIncident/);
  assert.match(model, /policy\.alertCooldownMinutes/);
  assert.match(evaluator, /recommendation\.delivery_slo_incident_opened/);
  assert.match(evaluator, /recommendation\.delivery_slo_incident_resolved/);
  assert.match(evaluator, /worseDeliverySloValue/);
});

test('active incidents freeze SLO semantics and historical evidence cannot be deleted', () => {
  const governance = read('worker/src/recommendation-delivery-slo-governance.ts');
  const route = read('worker/src/routes-v17.ts');
  const migration = read('database/migrations/0022_recommendation_delivery_slo_alerts.sql');
  assert.match(governance, /delivery_slo_active_incident_semantics_locked/);
  assert.match(governance, /structuralChange/);
  assert.match(governance, /delivery_slo_incident_history_retained/);
  assert.match(route, /saveGovernedRecommendationDeliverySlo/);
  assert.match(route, /deleteGovernedRecommendationDeliverySlo/);
  assert.match(migration, /protect_recommendation_delivery_slo_incident_semantics/);
  assert.match(migration, /ON DELETE NO ACTION/);
});

test('governed notifications require explicit event opt-in and revalidate routing before delivery', () => {
  const notifications = read('worker/src/recommendation-delivery-slo-notifications.ts');
  const routeSetup = read('worker/src/recommendation-delivery-slo-route-setup.ts');
  const governance = read('worker/src/recommendation-delivery-slo-governance.ts');
  const operationsModel = read('worker/src/recommendation-operations-model.ts');
  assert.match(notifications, /eventType,/);
  assert.match(notifications, /routing\.fingerprint !== row\.routing_fingerprint/);
  assert.match(notifications, /state\.quietRouteIds\.has\(route\.id\)/);
  assert.match(notifications, /status = 'deferred'/);
  assert.match(notifications, /completed_at IS NULL/);
  assert.match(notifications, /MAX_ATTEMPTS = 5/);
  assert.match(notifications, /wakeDeliveryQueue\(env, 'outbox'\)/);
  assert.match(routeSetup, /RECOMMENDATION_DELIVERY_SLO_BREACHED_EVENT/);
  assert.match(routeSetup, /RECOMMENDATION_DELIVERY_SLO_REMINDER_EVENT/);
  assert.match(routeSetup, /RECOMMENDATION_DELIVERY_SLO_RECOVERED_EVENT/);
  assert.match(routeSetup, /delivery_slo_route_scope_invalid/);
  assert.match(governance, /delivery_slo_route_opt_in_required/);
  assert.match(governance, /delivery_slo_recovery_route_severity_incompatible/);
  assert.match(operationsModel, /route\.eventTypes\.includes\(eventType\)/);
});

test('scheduled evaluation and Delivery Queue integration remain bounded and separate from CRM', () => {
  const maintenance = read('worker/src/maintenance.ts');
  const queueing = read('worker/src/queueing.ts');
  const evaluator = read('worker/src/recommendation-delivery-slo-evaluator.ts');
  const notifications = read('worker/src/recommendation-delivery-slo-notifications.ts');
  const source = `${maintenance}\n${queueing}\n${evaluator}\n${notifications}`;
  assert.match(maintenance, /evaluateRecommendationDeliverySlos\(env\)/);
  assert.match(queueing, /dispatchRecommendationDeliverySloNotifications\(env, 20\)/);
  assert.match(evaluator, /MAX_POLICIES_PER_RUN = 500/);
  assert.match(evaluator, /ATTEMPT_LIMIT = 20_000/);
  assert.match(evaluator, /EVENT_LIMIT = 20_000/);
  assert.match(evaluator, /DISPATCH_LIMIT = 10_000/);
  assert.doesNotMatch(source, /HubSpotClient|api\.hubapi\.com|\/crm\//);
  assert.doesNotMatch(source, /dealstage\s*=|closedate\s*=|hubspot_owner_id\s*=|hs_next_step\s*=/);
});

test('migration provides tenant-safe policies, states, incidents, notifications and deduplication', () => {
  const migration = read('database/migrations/0022_recommendation_delivery_slo_alerts.sql');
  const postgres = read('worker/src/postgres.ts');
  assert.match(migration, /CREATE TABLE recommendation_delivery_slo_policies/);
  assert.match(migration, /CREATE TABLE recommendation_delivery_slo_states/);
  assert.match(migration, /CREATE TABLE recommendation_delivery_slo_incidents/);
  assert.match(migration, /CREATE TABLE recommendation_delivery_slo_notifications/);
  assert.match(migration, /uq_recommendation_delivery_slo_open_incident/);
  assert.match(migration, /UNIQUE \(portal_id, dedupe_key\)/);
  assert.match(migration, /FOREIGN KEY \(portal_id, notification_route_id\)/);
  assert.match(migration, /recommendation\.delivery\.slo\.breached/);
  assert.match(migration, /recommendation\.delivery\.slo\.reminder/);
  assert.match(migration, /recommendation\.delivery\.slo\.recovered/);
  assert.match(postgres, /'recommendation_delivery_slo_policies'/);
  assert.match(postgres, /'recommendation_delivery_slo_states'/);
  assert.match(postgres, /'recommendation_delivery_slo_incidents'/);
  assert.match(postgres, /'recommendation_delivery_slo_notifications'/);
});

test('App Home SLO controls are on-demand, permission-aware and non-mutating', () => {
  const panel = read('src/app/pages/RecommendationDeliverySloPanel.tsx');
  const composition = read('src/app/pages/ManagerDecisionQueuePanel.tsx');
  assert.match(panel, /Recommendation delivery SLOs could not be loaded/);
  assert.match(panel, /Load delivery SLOs/);
  assert.doesNotMatch(panel, /useEffect/);
  assert.match(panel, /\$\{SLO_PATH\}\/routes\/\$\{encodeURIComponent\(routeId\)\}\/enable-events/);
  assert.match(panel, /\$\{SLO_PATH\}\/incidents\/\$\{encodeURIComponent\(incidentId\)\}\/acknowledge/);
  assert.match(panel, /Insufficient or truncated evidence cannot open an incident/);
  assert.match(panel, /never mutate CRM or recommendation lifecycle state/);
  assert.match(composition, /RecommendationDeliverySloPanel/);
  assert.doesNotMatch(panel, /\/crm\//);
});

test('dedicated documentation, schema validation and CI cover delivery SLO enforcement', () => {
  const docs = read('docs/RECOMMENDATION_DELIVERY_SLO_ALERTS.md');
  const validator = read('scripts/postgres-validate-delivery-slos.mjs');
  const workflow = read('.github/workflows/recommendation-delivery-slo-alerts.yml');
  const packageJson = read('package.json');
  assert.match(docs, /operational objectives?/i);
  assert.match(docs, /insufficient(?: or truncated)? evidence/i);
  assert.match(docs, /quiet hours/i);
  assert.match(docs, /no CRM mutation/i);
  assert.match(validator, /Expected migrations through 0022/);
  assert.match(validator, /recommendation_delivery_slo_policies/);
  assert.match(validator, /recommendation_delivery_slo_notifications/);
  assert.match(validator, /activeIncidentSemanticTriggerCount/);
  assert.match(workflow, /recommendation-delivery-slo-model\.ts/);
  assert.match(workflow, /recommendation-delivery-slo-governance\.ts/);
  assert.match(workflow, /0022_recommendation_delivery_slo_alerts\.sql/);
  assert.match(workflow, /recommendation-delivery-slo\.test\.mjs/);
  assert.match(workflow, /recommendation-delivery-slo-contract\.test\.mjs/);
  assert.match(packageJson, /db:validate:delivery-slos/);
});
