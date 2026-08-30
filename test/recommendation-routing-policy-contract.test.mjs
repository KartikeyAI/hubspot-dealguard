import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('routing policy APIs are Enterprise-scoped, permission-aware and active in the Worker route stack', () => {
  const route = read('worker/src/routes-v15.ts');
  const index = read('worker/src/index.ts');
  assert.match(route, /recommendation-routing-policies/);
  assert.match(route, /recommendation-followups\/candidates/);
  assert.match(route, /requireCommercialTier\(env, identity\.portalId, 'enterprise'\)/);
  assert.match(route, /requireEnterprisePermission\(env, identity, 'alert\.manage'\)/);
  assert.match(route, /previewScopedRecommendationRoutingPolicy/);
  assert.match(route, /saveScopedRecommendationRoutingPolicy/);
  assert.match(index, /from '\.\/routes-v15\.js'/);
});

test('enabled policies require explicit route event opt-in, scope limits, quiet hours and cooldowns', () => {
  const policies = read('worker/src/recommendation-routing-policies.ts');
  const scope = read('worker/src/recommendation-routing-policy-api.ts');
  const model = read('worker/src/recommendation-routing-policy-model.ts');
  const routing = read('worker/src/recommendation-operations-model.ts');
  assert.match(policies, /recommendation_policy_route_not_opted_in/);
  assert.match(policies, /recommendation_policy_escalation_not_opted_in/);
  assert.match(policies, /scopeWithinAccess/);
  assert.match(scope, /allowed\.length > 0 && requested\.length === 0/);
  assert.match(routing, /quietRouteIds/);
  assert.match(routing, /route\.eventTypes\.includes\(eventType\)/);
  assert.match(model, /Math\.max\(15, policyCooldownMinutes, routeSuppressionWindowMinutes\)/);
  assert.match(model, /escalationCount === 0/);
});

test('maintenance evaluation queues deterministic notifications without CRM or lifecycle mutation', () => {
  const runner = read('worker/src/recommendation-routing-policy-runner.ts');
  const maintenance = read('worker/src/maintenance.ts');
  const delivery = read('worker/src/recommendation-followup-delivery.ts');
  assert.match(maintenance, /evaluateRecommendationRoutingPolicies\(env\)/);
  assert.match(runner, /authorization_mode, automation_policy_id/);
  assert.match(runner, /'configured_policy'/);
  assert.match(runner, /wakeDeliveryQueue\(env, 'outbox'\)/);
  assert.match(runner, /configuredPolicyAuthorized: true/);
  assert.match(delivery, /configuredPolicyAuthorized/);
  assert.match(delivery, /slack_webhook/);
  assert.match(delivery, /teams_workflow/);
  assert.doesNotMatch(runner, /HubSpotClient|api\.hubapi\.com|\/crm\//);
  assert.doesNotMatch(runner, /transitionRecommendation|status = 'accepted'|status = 'completed'|dealstage|closedate/);
});

test('manual recommendation operations use the canonical route API and no longer collect direct recipients', () => {
  const panel = read('src/app/pages/RecommendationOperationsPanel.tsx');
  const candidates = read('worker/src/recommendation-followup-candidates.ts');
  assert.match(panel, /recommendation-followups\/candidates/);
  assert.match(panel, /recommendation-followups\/preview/);
  assert.match(panel, /Preview routes and channels/);
  assert.match(panel, /explicitly opted-in DealGuard routes/);
  assert.doesNotMatch(panel, /recommendation-follow-ups/);
  assert.doesNotMatch(panel, /recipientText|Recipients|manager@example\.com/);
  assert.match(candidates, /RECOMMENDATION_FOLLOWUP_EVENT/);
  assert.match(candidates, /remediation\.view/);
  assert.equal(fs.existsSync(new URL('../worker/src/recommendation-follow-ups.ts', import.meta.url)), false);
  assert.equal(fs.existsSync(new URL('../.github/workflows/p2-recommendation-operations.yml', import.meta.url)), false);
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
  assert.match(migration, /FOREIGN KEY \(portal_id, policy_dispatch_id\)/);
  assert.match(migration, /idx_recommendation_policy_dispatches_due/);
  assert.match(postgres, /'recommendation_routing_policies','recommendation_policy_dispatches'/);
  assert.match(validator, /Expected migrations through 0020/);
  assert.match(validator, /operationsRequiredColumnCount !== 90/);
  assert.match(validator, /operationsForeignKeyCount !== 12/);
});

test('App Home and documentation expose due, overdue, Slack, quiet-hour and escalation controls', () => {
  const panel = read('src/app/pages/RecommendationRoutingPoliciesPanel.tsx');
  const composition = read('src/app/pages/ManagerDecisionQueuePanel.tsx');
  const docs = read('docs/RECOMMENDATION_ROUTING_SLAS.md');
  const workflow = read('.github/workflows/recommendation-operations.yml');
  assert.match(panel, /Due soon/);
  assert.match(panel, /Overdue/);
  assert.match(panel, /Slack/);
  assert.match(panel, /quiet hours/);
  assert.match(panel, /Cooldown minutes/);
  assert.match(panel, /Manager escalation route/);
  assert.match(panel, /Enable policy/);
  assert.match(composition, /RecommendationRoutingPoliciesPanel/);
  assert.match(docs, /durable customer authorization/i);
  assert.match(docs, /no CRM mutation/i);
  assert.match(docs, /Slack/i);
  assert.match(docs, /quiet hours/i);
  assert.match(workflow, /recommendation-routing-policy\.test\.mjs/);
  assert.match(workflow, /recommendation-routing-policy-contract\.test\.mjs/);
  assert.match(workflow, /0020_recommendation_routing_policies\.sql/);
});
