import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { verifyDodoWebhook } from '../dist/billing.js';
import { localUsageIncrement, usageAggregation } from '../dist/billing-usage.js';
import { canonicalChangePayload, withoutApprovalFields } from '../dist/change-control.js';
import { parseDodoPlanChangeInput, providerHasTarget } from '../dist/dodo-plan-change.js';
import {
  isSubscriptionDodoEvent,
  resolveDodoSubscriptionStatus,
  shouldIgnoreStaleDodoEvent,
} from '../dist/dodo-webhook.js';
import { permissionMatches } from '../dist/enterprise-access.js';
import { dimensionValues } from '../dist/policy-dimensions.js';
import { exponentialBackoffWithJitter } from '../dist/reliability.js';

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

test('verifies Dodo Standard Webhooks signatures and rejects tampering', async () => {
  const rawSecret = Buffer.from('enterprise-dodo-webhook-secret-32');
  const secret = `whsec_${base64Url(rawSecret)}`;
  const body = JSON.stringify({
    business_id: 'biz_123',
    type: 'subscription.active',
    timestamp: new Date().toISOString(),
    data: { payload_type: 'Subscription', metadata: { portal_id: '123' } },
  });
  const id = 'msg_123';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', rawSecret).update(`${id}.${timestamp}.${body}`).digest('base64url');
  const request = new Request('https://dealguard-api.rokad.co/webhooks/dodo', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'webhook-id': id,
      'webhook-timestamp': timestamp,
      'webhook-signature': `v1,${signature}`,
    },
    body,
  });
  const verified = await verifyDodoWebhook(request, { DODO_WEBHOOK_SECRET: secret });
  assert.equal(verified.rawBody, body);
  assert.equal(verified.webhookId, id);

  const tampered = new Request('https://dealguard-api.rokad.co/webhooks/dodo', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'webhook-id': id,
      'webhook-timestamp': timestamp,
      'webhook-signature': `v1,${signature}`,
    },
    body: `${body} `,
  });
  await assert.rejects(() => verifyDodoWebhook(tampered, { DODO_WEBHOOK_SECRET: secret }));
});

test('only subscription webhooks can mutate commercial entitlement', () => {
  assert.equal(isSubscriptionDodoEvent('subscription.active'), true);
  assert.equal(isSubscriptionDodoEvent('subscription.plan_changed'), true);
  assert.equal(isSubscriptionDodoEvent('payment.failed'), false);
  assert.equal(isSubscriptionDodoEvent('refund.succeeded'), false);
  assert.equal(isSubscriptionDodoEvent('dispute.opened'), false);
});

test('preserves current status for sparse subscription update events', () => {
  assert.equal(resolveDodoSubscriptionStatus('subscription.updated', undefined, 'active'), 'active');
  assert.equal(resolveDodoSubscriptionStatus('subscription.plan_changed', undefined, 'active'), 'active');
  assert.equal(resolveDodoSubscriptionStatus('subscription.cancelled', undefined, 'active'), 'cancelled');
  assert.equal(resolveDodoSubscriptionStatus('subscription.renewed', undefined, 'past_due'), 'active');
});

test('rejects stale subscription events and terminal-state regression', () => {
  assert.equal(
    shouldIgnoreStaleDodoEvent('2026-07-13T12:00:00.000Z', 'cancelled', '2026-07-13T11:59:59.000Z', 'active'),
    true,
  );
  assert.equal(
    shouldIgnoreStaleDodoEvent('2026-07-13T12:00:00.000Z', 'cancelled', '2026-07-13T12:00:00.000Z', 'active'),
    true,
  );
  assert.equal(
    shouldIgnoreStaleDodoEvent('2026-07-13T12:00:00.000Z', 'failed', '2026-07-13T12:00:01.000Z', 'active'),
    false,
  );
});

test('validates and reconciles official Dodo plan-change controls', () => {
  assert.deepEqual(parseDodoPlanChangeInput({ tier: 'enterprise', interval: 'year' }), {
    tier: 'enterprise',
    interval: 'year',
    effectiveAt: 'immediately',
    prorationBillingMode: 'prorated_immediately',
    onPaymentFailure: 'prevent_change',
  });
  assert.deepEqual(parseDodoPlanChangeInput({
    tier: 'growth',
    interval: 'month',
    effectiveAt: 'next_billing_date',
    prorationBillingMode: 'do_not_bill',
    onPaymentFailure: 'apply_change',
    adaptiveCurrencyFeesInclusive: true,
  }), {
    tier: 'growth',
    interval: 'month',
    effectiveAt: 'next_billing_date',
    prorationBillingMode: 'do_not_bill',
    onPaymentFailure: 'apply_change',
    adaptiveCurrencyFeesInclusive: true,
  });
  assert.equal(providerHasTarget({ product_id: 'prod_enterprise' }, 'prod_enterprise', 'immediately'), true);
  assert.equal(providerHasTarget({ scheduled_change: { product_id: 'prod_growth' } }, 'prod_growth', 'next_billing_date'), true);
  assert.equal(providerHasTarget({ product_id: 'prod_growth' }, 'prod_enterprise', 'immediately'), false);
  assert.throws(() => parseDodoPlanChangeInput({ tier: 'free', interval: 'month' }));
});

test('uses sum meters for cumulative usage and max meters for gauges', () => {
  assert.equal(usageAggregation('ai_credit'), 'sum');
  assert.equal(usageAggregation('event_overage'), 'sum');
  assert.equal(usageAggregation('active_deal_overage'), 'max');
  assert.equal(usageAggregation('retention_gb_month'), 'max');
  assert.equal(localUsageIncrement('event_overage', 100, 25), 25);
  assert.equal(localUsageIncrement('active_deal_overage', 100, 125), 25);
  assert.equal(localUsageIncrement('active_deal_overage', 125, 100), 0);
});

test('canonicalizes exact approval payloads independently of object key order', () => {
  assert.equal(
    canonicalChangePayload({ tier: 'enterprise', nested: { b: 2, a: 1 }, values: ['x', 'y'] }),
    canonicalChangePayload({ values: ['x', 'y'], nested: { a: 1, b: 2 }, tier: 'enterprise' }),
  );
  assert.notEqual(
    canonicalChangePayload({ tier: 'enterprise', interval: 'year' }),
    canonicalChangePayload({ tier: 'enterprise', interval: 'month' }),
  );
  assert.deepEqual(
    withoutApprovalFields({ approvalId: 'approval-1', approval_id: 'approval-2', tier: 'growth' }),
    { tier: 'growth' },
  );
});

test('maps enterprise policy dimensions from configured HubSpot properties', () => {
  assert.deepEqual(
    dimensionValues(
      { hs_team_dimension: 'team-emea', market_region: 'eu', deal_motion: 'new-business' },
      { teamProperty: 'hs_team_dimension', regionProperty: 'market_region', dealTypeProperty: 'deal_motion' },
    ),
    { teamId: 'team-emea', regionCode: 'eu', dealType: 'new-business' },
  );
  assert.deepEqual(
    dimensionValues({}, { teamProperty: null, regionProperty: null, dealTypeProperty: null }),
    { teamId: '', regionCode: '', dealType: '' },
  );
});

test('enforces enterprise permissions and wildcard permissions', () => {
  assert.equal(permissionMatches(['*'], 'billing.manage'), true);
  assert.equal(permissionMatches(['policy.*'], 'policy.manage'), true);
  assert.equal(permissionMatches(['analytics.view'], 'analytics.view'), true);
  assert.equal(permissionMatches(['viewer'], 'data.delete'), false);
});

test('uses bounded exponential backoff with jitter', () => {
  assert.equal(exponentialBackoffWithJitter(0, 1000, 60000, () => 0), 1000);
  assert.equal(exponentialBackoffWithJitter(4, 1000, 60000, () => 0.5), 16000);
  assert.equal(exponentialBackoffWithJitter(20, 1000, 60000, () => 0.5), 60000);
});

test('enterprise PostgreSQL migrations cover every A-H domain and hardening layer', async () => {
  const migration = await readFile('database/migrations/0007_enterprise_complete_dodo.sql', 'utf8');
  const hardening = await readFile('database/migrations/0009_dodo_event_ordering_and_usage_counters.sql', 'utf8');
  const planState = await readFile('database/migrations/0010_dodo_plan_change_state.sql', 'utf8');
  const scheduleTrigger = await readFile('database/migrations/0011_preserve_dodo_scheduled_plan_state.sql', 'utf8');
  const changeExecution = await readFile('database/migrations/0012_change_approval_execution.sql', 'utf8');
  const dimensions = await readFile('database/migrations/0013_policy_dimension_mappings.sql', 'utf8');
  const infrastructure = await readFile('database/migrations/0014_neon_tigris_queues.sql', 'utf8');
  const requiredTables = [
    'subscriptions_v2', 'billing_usage_events', 'billing_allowances', 'billing_contracts',
    'enterprise_role_assignments', 'change_approval_requests', 'policy_templates', 'policy_segments',
    'assessment_history', 'analytics_saved_views', 'remediation_comments', 'remediation_evidence',
    'notification_channels', 'notification_routes', 'business_calendars', 'escalation_policies',
    'audit_events_v2', 'compliance_settings', 'siem_destinations', 'legal_holds', 'data_export_jobs',
    'service_slos', 'operational_metrics', 'synthetic_checks', 'incidents', 'scan_checkpoints',
    'job_leases', 'backup_manifests', 'restore_tests',
  ];
  for (const table of requiredTables) assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  assert.match(hardening, /provider_event_at/);
  assert.match(hardening, /CREATE TABLE IF NOT EXISTS billing_usage_counters/);
  assert.match(planState, /scheduled_interval/);
  assert.match(planState, /scheduled_product_id/);
  assert.match(scheduleTrigger, /preserve_dodo_scheduled_plan_state/);
  assert.match(scheduleTrigger, /EXECUTE FUNCTION preserve_dodo_scheduled_plan_state_fn/);
  assert.match(changeExecution, /CREATE TABLE IF NOT EXISTS change_approval_executions/);
  assert.match(changeExecution, /lease_expires_at/);
  assert.match(dimensions, /CREATE TABLE IF NOT EXISTS policy_dimension_mappings/);
  assert.match(infrastructure, /CREATE TABLE object_uploads/);
  assert.match(infrastructure, /CREATE TABLE async_jobs/);
});

test('release source uses hardened Dodo, approval, dimension, simulation and queue runtimes', async () => {
  const billing = await readFile('worker/src/billing.ts', 'utf8');
  const simulationRouter = await readFile('worker/src/routes-v8.ts', 'utf8');
  const handoffRouter = await readFile('worker/src/routes-v9.ts', 'utf8');
  const planChange = await readFile('worker/src/dodo-plan-change.ts', 'utf8');
  const scheduler = await readFile('worker/src/billing-scheduler.ts', 'utf8');
  const index = await readFile('worker/src/index.ts', 'utf8');
  const queueing = await readFile('worker/src/queueing.ts', 'utf8');
  const scanner = await readFile('worker/src/scanner.ts', 'utf8');
  const assessment = await readFile('worker/src/assessment-service.ts', 'utf8');
  const simulation = await readFile('worker/src/policy-simulation-enterprise.ts', 'utf8');
  const dimensions = await readFile('worker/src/policy-dimensions.ts', 'utf8');
  assert.match(billing, /live\.dodopayments\.com/);
  assert.match(billing, /test\.dodopayments\.com/);
  assert.doesNotMatch(billing, /api\.stripe\.com/);
  assert.match(planChange, /\/change-plan\/preview/);
  assert.match(planChange, /\/change-plan\/scheduled/);
  assert.match(planChange, /on_payment_failure/);
  assert.match(scheduler, /provider = 'manual'/);
  assert.doesNotMatch(scheduler, /provider = 'dodo'/);
  assert.match(index, /routes-v10/);
  assert.match(index, /async queue\(/);
  assert.match(index, /processQueueBatch/);
  assert.doesNotMatch(index, /applyManualScheduledPlanChanges|retryAtomicUsageReports/);
  assert.match(queueing, /applyManualScheduledPlanChanges/);
  assert.match(queueing, /retryAtomicUsageReports/);
  assert.match(queueing, /billing_schedule/);
  assert.match(simulationRouter, /runEnterprisePolicySimulation/);
  assert.match(handoffRouter, /policyDimensionPropertyNames/);
  assert.match(handoffRouter, /resolveSegmentedRulesForDeal/);
  assert.match(scanner, /reserveScanUsage/);
  assert.match(scanner, /policyDimensionPropertyNames/);
  assert.match(scanner, /resolveSegmentedRulesForDeal/);
  assert.match(assessment, /policyDimensionPropertyNames/);
  assert.match(assessment, /resolveSegmentedRulesForDeal/);
  assert.match(simulation, /resolvePolicyRulesForDeal/);
  assert.match(simulation, /policyDimensionPropertyNames/);
  assert.match(dimensions, /dimension_properties_missing/);
  await assert.rejects(() => readFile('worker/src/routes.ts', 'utf8'));
});

test('HubSpot App Home points to the complete enterprise console', async () => {
  const metadata = JSON.parse(await readFile('src/app/pages/pages-hsmeta.json', 'utf8'));
  assert.equal(metadata.config.entrypoint, '/app/pages/EnterpriseHomeV3.tsx');
  const source = await readFile('src/app/pages/EnterpriseHomeV3.tsx', 'utf8');
  for (const section of ['policies', 'analytics', 'access', 'remediation', 'alerts', 'compliance', 'reliability', 'billing']) {
    assert.match(source, new RegExp(`'${section}'`));
  }
  assert.match(source, /\/enterprise\/policy-dimensions/);
  assert.match(source, /\/billing\/plan-change\/preview/);
  assert.match(source, /\/billing\/plan-change/);
  assert.match(source, /\/enterprise\/change-approvals/);
  assert.match(source, /Production-equivalent simulation started/);
});
