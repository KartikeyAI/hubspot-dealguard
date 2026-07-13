import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { verifyDodoWebhook } from '../dist/billing.js';
import { parseDodoPlanChangeInput } from '../dist/dodo-plan-change.js';
import {
  isSubscriptionDodoEvent,
  resolveDodoSubscriptionStatus,
  shouldIgnoreStaleDodoEvent,
} from '../dist/dodo-webhook.js';
import { permissionMatches } from '../dist/enterprise-access.js';
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

test('validates the official Dodo plan-change controls', () => {
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
  assert.throws(() => parseDodoPlanChangeInput({ tier: 'free', interval: 'month' }));
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

test('enterprise migrations cover every A-H control-plane domain and billing hardening', async () => {
  const migration = await readFile('worker/migrations/0007_enterprise_complete_dodo.sql', 'utf8');
  const hardening = await readFile('worker/migrations/0009_dodo_event_ordering_and_usage_counters.sql', 'utf8');
  const planState = await readFile('worker/migrations/0010_dodo_plan_change_state.sql', 'utf8');
  const scheduleTrigger = await readFile('worker/migrations/0011_preserve_dodo_scheduled_plan_state.sql', 'utf8');
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
  assert.match(scheduleTrigger, /complete_dodo_scheduled_plan_change/);
});

test('release source is Dodo-first and uses hardened runtime adapters', async () => {
  const billing = await readFile('worker/src/billing.ts', 'utf8');
  const router = await readFile('worker/src/routes-v5.ts', 'utf8');
  const planChange = await readFile('worker/src/dodo-plan-change.ts', 'utf8');
  const index = await readFile('worker/src/index.ts', 'utf8');
  const scanner = await readFile('worker/src/scanner.ts', 'utf8');
  assert.match(billing, /live\.dodopayments\.com/);
  assert.match(billing, /test\.dodopayments\.com/);
  assert.doesNotMatch(billing, /api\.stripe\.com/);
  assert.match(router, /previewDodoPlanChange/);
  assert.match(router, /cancelScheduledDodoPlanChange/);
  assert.match(planChange, /\/change-plan\/preview/);
  assert.match(planChange, /\/change-plan\/scheduled/);
  assert.match(planChange, /on_payment_failure/);
  assert.match(index, /retryAtomicUsageReports/);
  assert.match(scanner, /recordUsageAtomic/);
  await assert.rejects(() => readFile('worker/src/routes.ts', 'utf8'));
});

test('HubSpot App Home points to the complete enterprise console', async () => {
  const metadata = JSON.parse(await readFile('src/app/pages/pages-hsmeta.json', 'utf8'));
  assert.equal(metadata.config.entrypoint, '/app/pages/EnterpriseHomeV2.tsx');
  const source = await readFile('src/app/pages/EnterpriseHomeV2.tsx', 'utf8');
  for (const section of ['policies', 'analytics', 'access', 'remediation', 'alerts', 'compliance', 'reliability', 'billing']) {
    assert.match(source, new RegExp(`'${section}'`));
  }
});
