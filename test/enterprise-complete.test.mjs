import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { verifyDodoWebhook } from '../dist/billing.js';
import { permissionMatches } from '../dist/enterprise-access.js';
import { exponentialBackoffWithJitter } from '../dist/reliability.js';

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

test('verifies Dodo Standard Webhooks signatures and rejects tampering', async () => {
  const rawSecret = Buffer.from('enterprise-dodo-webhook-secret-32');
  const secret = `whsec_${base64Url(rawSecret)}`;
  const body = JSON.stringify({ id: 'evt_123', type: 'subscription.active', data: { metadata: { portal_id: '123' } } });
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

test('enterprise migration covers every A-H control-plane domain', async () => {
  const migration = await readFile('worker/migrations/0007_enterprise_complete_dodo.sql', 'utf8');
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
});

test('release source is Dodo-first and has no active Stripe adapter', async () => {
  const billing = await readFile('worker/src/billing.ts', 'utf8');
  const router = await readFile('worker/src/routes-v2.ts', 'utf8');
  assert.match(billing, /live\.dodopayments\.com/);
  assert.match(billing, /test\.dodopayments\.com/);
  assert.match(billing, /events\/ingest/);
  assert.doesNotMatch(billing, /api\.stripe\.com/);
  assert.match(router, /webhooks\/dodo/);
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
