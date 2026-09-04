import test from 'node:test';
import assert from 'node:assert/strict';
import { destinationMatches, retryDelaySeconds } from '../dist/outbox.js';
import { parseRemediationWorkflowPayload } from '../dist/remediation-workflow.js';
import { PLAN_LIMITS, REQUIRED_HUBSPOT_SCOPES } from '../dist/config.js';

test('enterprise tier enables remediation and routed delivery', () => {
  assert.equal(PLAN_LIMITS.free.remediationAutomation, false);
  assert.equal(PLAN_LIMITS.growth.enterpriseGovernance, false);
  assert.equal(PLAN_LIMITS.beta_growth.remediationAutomation, true);
  assert.equal(PLAN_LIMITS.beta_growth.multiDestinationDelivery, true);
  assert.equal(PLAN_LIMITS.beta_growth.maxNotificationDestinations, 25);
  assert.equal(REQUIRED_HUBSPOT_SCOPES.includes('crm.objects.tasks.write'), false);
});

test('delivery routing respects event, severity, and pipeline filters', () => {
  const destination = {
    enabled: 1,
    event_types_json: JSON.stringify(['remediation.overdue']),
    minimum_severity: 'warning',
    pipeline_ids_json: JSON.stringify(['enterprise']),
  };
  assert.equal(destinationMatches(destination, { event_type: 'remediation.overdue', severity: 'critical', pipeline_id: 'enterprise' }), true);
  assert.equal(destinationMatches(destination, { event_type: 'remediation.created', severity: 'critical', pipeline_id: 'enterprise' }), false);
  assert.equal(destinationMatches(destination, { event_type: 'remediation.overdue', severity: 'info', pipeline_id: 'enterprise' }), false);
  assert.equal(destinationMatches(destination, { event_type: 'remediation.overdue', severity: 'critical', pipeline_id: 'smb' }), false);
});

test('outbox retry uses bounded exponential delay', () => {
  assert.equal(retryDelaySeconds(0, 0), 30);
  assert.equal(retryDelaySeconds(1, 0), 60);
  assert.equal(retryDelaySeconds(8, 0), 7680);
  assert.equal(retryDelaySeconds(20, 30), 21630);
});

test('parses remediation workflow payload and bounds SLA hours', () => {
  assert.deepEqual(parseRemediationWorkflowPayload({
    callbackId: 'cb-1',
    origin: { portalId: 456, objectId: 123 },
    inputFields: {
      issueCode: 'security_review',
      title: 'Complete security review',
      description: 'Provide the security package.',
      severity: 'critical',
      dueHours: 9999,
      createHubSpotTask: 'yes',
    },
  }), {
    portalId: '456',
    dealId: '123',
    callbackId: 'cb-1',
    issueCode: 'security_review',
    title: 'Complete security review',
    description: 'Provide the security package.',
    severity: 'critical',
    dueHours: 720,
    createHubSpotTask: true,
  });
});
