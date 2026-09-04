import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('routing policy APIs are Enterprise-scoped, permission-aware and active in the Worker route stack', () => {
  const route = read('worker/src/routes-v15.ts');
  const route16 = read('worker/src/routes-v16.ts');
  const route17 = read('worker/src/routes-v17.ts');
  const scope = read('worker/src/recommendation-routing-policy-api.ts');
  const index = read('worker/src/index.ts');
  assert.match(route, /recommendation-routing-policies/);
  assert.match(route, /recommendation-followups\/candidates/);
  assert.match(route, /requireCommercialTier\(env, identity\.portalId, 'enterprise'\)/);
  assert.match(route, /previewScopedRecommendationRoutingPolicy/);
  assert.match(route, /saveScopedRecommendationRoutingPolicy/);
  assert.match(route, /deleteScopedRecommendationRoutingPolicy/);
  assert.match(route, /listScopedRecommendationRoutingPolicies/);
  assert.match(scope, /requireEnterprisePermission\(env, identity, 'alert\.manage'\)/);
  assert.match(scope, /requirePolicyScope/);
  assert.match(index, /from '\.\/routes-v17\.js'/);
  assert.match(route17, /from '\.\/routes-v16\.js'/);
  assert.match(route16, /from '\.\/routes-v15\.js'/);
});

test('enabled policies require explicit event opt-in, assigned scope, active channels, quiet hours and cooldowns', () => {
  const policies = read('worker/src/recommendation-routing-policies.ts');
  const scope = read('worker/src/recommendation-routing-policy-api.ts');
  const model = read('worker/src/recommendation-routing-policy-model.ts');
  const routing = read('worker/src/recommendation-operations-model.ts');
  assert.match(policies, /recommendation_policy_route_not_opted_in/);
  assert.match(policies, /recommendation_policy_escalation_not_opted_in/);
  assert.match(policies, /scopeWithinAccess/);
  assert.match(scope, /allowed\.length > 0 && requested\.length === 0/);
  assert.match(scope, /recommendation_policy_channel_unavailable/);
  assert.match(scope, /policies\.filter\(\(policy\) => scopeAllowed/);
  assert.match(routing, /quietRouteIds/);
  assert.match(routing, /route\.eventTypes\.includes\(eventType\)/);
  assert.match(model, /Math\.max\(15, policyCooldownMinutes, routeSuppressionWindowMinutes\)/);
  assert.match(model, /escalationCount === 0/);
});

test('maintenance and explicit evaluation queue deterministic notifications outside the UI request', () => {
  const route = read('worker/src/routes-v15.ts');
  const runner = read('worker/src/recommendation-routing-policy-runner.ts');
  const maintenance = read('worker/src/maintenance.ts');
  const delivery = read('worker/src/recommendation-followup-delivery.ts');
  assert.match(maintenance, /evaluateRecommendationRoutingPolicies\(env\)/);
  assert.match(route, /authorizePortalWideRecommendationPolicyEvaluation/);
  assert.match(route, /ctx\.waitUntil\(\(async \(\) => \{/);
  assert.match(route, /await evaluateRecommendationRoutingPolicies\(env, identity\.portalId\)/);
  assert.match(route, /await observeRecommendationDeliveryControls\(env, identity\.portalId\)/);
  assert.match(route, /evaluationQueued: true/);
  assert.match(runner, /authorization_mode, automation_policy_id/);
  assert.match(runner, /'configured_policy'/);
  assert.match(runner, /wakeDeliveryQueue\(env, 'outbox'\)/);
  assert.match(runner, /configuredPolicyAuthorized: true/);
  assert.match(runner, /noCrmMutation: true/);
  assert.match(delivery, /configuredPolicyAuthorized/);
  assert.match(delivery, /slack_webhook/);
  assert.match(delivery, /teams_workflow/);
  assert.doesNotMatch(runner, /HubSpotClient|api\.hubapi\.com|\/crm\//);
  assert.doesNotMatch(runner, /transitionRecommendation/);
});

test('manual recommendation operations use the canonical route API and no longer collect direct recipients', () => {
  const panel = read('src/app/pages/RecommendationOperationsPanel.tsx');
  const candidates = read('worker/src/recommendation-followup-candidates.ts');
  assert.match(panel, /recommendation-followups\/candidates/);
  assert.match(panel, /recommendation-followups\/preview/);
  assert.match(panel, /Preview routes and channels/);
  assert.match(panel, /explicitly opted-in DealGuard routes/);
  assert.doesNotMatch(panel, /recommendation-follow-ups/);
  assert.doesNotMatch(panel, /recipientText|manager@example\.com/);
  assert.match(candidates, /RECOMMENDATION_FOLLOWUP_EVENT/);
  assert.match(candidates, /remediation\.view/);
  assert.match(candidates, /activeChannelIds/);
  assert.equal(fs.existsSync(new URL('../worker/src/recommendation-follow-ups.ts', import.meta.url)), false);
  assert.equal(fs.existsSync(new URL('../.github/workflows/p2-recommendation-operations.yml', import.meta.url)), false);
});

test('App Home exposes live encrypted channels, explicit routes and quiet-hour calendars', () => {
  const panel = read('src/app/pages/RecommendationNotificationConfigurationPanel.tsx');
  const alerts = read('worker/src/alerting-enterprise.ts');
  const routes = read('worker/src/enterprise-routes.ts');
  assert.match(panel, /Slack webhook/);
  assert.match(panel, /Microsoft Teams workflow/);
  assert.match(panel, /Signed webhook/);
  assert.match(panel, /Email recipients/);
  assert.match(panel, /IANA timezone/);
  assert.match(panel, /Explicit recommendation events/);
  assert.match(panel, /Suppression window minutes/);
  assert.match(panel, /\/enterprise\/alerts\/channels/);
  assert.match(panel, /\/enterprise\/alerts\/routes/);
  assert.match(panel, /\/enterprise\/alerts\/calendars/);
  assert.match(alerts, /encryptSecret/);
  assert.match(alerts, /slack_webhook/);
  assert.match(alerts, /teams_workflow/);
  assert.match(alerts, /Notification endpoints must use HTTPS/);
  assert.match(routes, /\/api\/v1\/enterprise\/alerts\/channels/);
  assert.match(routes, /\/api\/v1\/enterprise\/alerts\/routes/);
  assert.match(routes, /\/api\/v1\/enterprise\/alerts\/calendars/);
});

test('migration 0020 adds tenant-safe policies, dispatch state and configured-policy authorization', () => {
  const migration = read('database/migrations/0020_recommendation_routing_policies.sql');
  const postgres = read('worker/src/postgres.ts');
  const validator = read('scripts/postgres-validate-recommendation-operations.mjs');
  assert.match(migration, /CREATE TABLE recommendation_routing_policies/);
  assert.match(migration, /CREATE TABLE recommendation_policy_dispatches/);
  assert.match(migration, /authorization_mode/);
  assert.match(migration, /configured_policy/);
  assert.match(migration, /FOREIGN KEY \(portal_id, automation_policy_id\)/);
  assert.match(migration, /ON DELETE SET NULL \(automation_policy_id\)/);
  assert.match(migration, /FOREIGN KEY \(portal_id, policy_dispatch_id\)/);
  assert.match(migration, /idx_recommendation_policy_dispatches_due/);
  assert.match(postgres, /'recommendation_routing_policies','recommendation_policy_dispatches'/);
  assert.match(validator, /Expected migrations through 0020/);
  assert.match(validator, /operationsRequiredColumnCount !== 90/);
  assert.match(validator, /operationsForeignKeyCount !== 12/);
});

test('App Home and documentation expose due, overdue, routing, quiet-hour and escalation controls', () => {
  const panel = read('src/app/pages/RecommendationRoutingPoliciesPanel.tsx');
  const configuration = read('src/app/pages/RecommendationNotificationConfigurationPanel.tsx');
  const composition = read('src/app/pages/ManagerDecisionQueuePanel.tsx');
  const docs = read('docs/RECOMMENDATION_ROUTING_SLAS.md');
  const workflow = read('.github/workflows/recommendation-operations.yml');
  assert.match(panel, /Due soon/);
  assert.match(panel, /Overdue/);
  assert.match(panel, /Cooldown minutes/);
  assert.match(panel, /Manager escalation route/);
  assert.match(panel, /Enable policy/);
  assert.match(panel, /Policy evaluation queued/);
  assert.match(configuration, /Notification routes & quiet hours/);
  assert.match(composition, /RecommendationNotificationConfigurationPanel/);
  assert.match(composition, /RecommendationRoutingPoliciesPanel/);
  assert.match(docs, /durable customer authorization/i);
  assert.match(docs, /does not alter recommendation ownership or CRM data/i);
  assert.match(docs, /Slack/i);
  assert.match(docs, /quiet hours/i);
  assert.match(workflow, /RecommendationNotificationConfigurationPanel\.tsx/);
  assert.match(workflow, /recommendation-routing-policy\.test\.mjs/);
  assert.match(workflow, /recommendation-routing-policy-contract\.test\.mjs/);
  assert.match(workflow, /0020_recommendation_routing_policies\.sql/);
});
