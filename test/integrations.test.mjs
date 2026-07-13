import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHubSpotWebhookEvents } from '../dist/hubspot-events.js';
import { buildSlackPayload } from '../dist/slack.js';
import { parseWorkflowActionPayload } from '../dist/workflow-action.js';

const assessment = {
  dealId: '123',
  dealName: 'Enterprise renewal',
  pipelineLabel: 'Sales',
  stageLabel: 'Contract',
  score: 42,
  grade: 'F',
  status: 'critical',
  issues: [{ code: 'owner_missing', label: 'Owner missing', description: 'Assign a deal owner.', severity: 'critical', weight: 12 }],
  readinessSummary: 'One critical issue.',
  isClosed: false,
  isWon: false,
  handoffEligible: false,
  assessedAt: '2026-07-13T00:00:00.000Z',
};

test('builds an accessible Slack message with deal context', () => {
  const payload = buildSlackPayload('456', assessment, 'critical_deal');
  assert.match(payload.text, /Critical deal readiness issue/);
  assert.equal(Array.isArray(payload.blocks), true);
  assert.match(JSON.stringify(payload), /Enterprise renewal/);
  assert.match(JSON.stringify(payload), /record\/0-3\/123/);
});

test('normalizes and caps HubSpot webhook batches', () => {
  const events = normalizeHubSpotWebhookEvents(Array.from({ length: 110 }, (_, eventId) => ({ eventId, portalId: 1, objectId: 2 })));
  assert.equal(events.length, 100);
  assert.deepEqual(normalizeHubSpotWebhookEvents({}), []);
});

test('parses workflow action origin and static Slack input', () => {
  assert.deepEqual(parseWorkflowActionPayload({
    callbackId: 'callback-1',
    origin: { portalId: 456, objectId: 123 },
    inputFields: { notifySlack: 'yes' },
  }), { portalId: '456', dealId: '123', notifySlack: true, callbackId: 'callback-1' });
});

test('rejects workflow executions without a valid deal identity', () => {
  assert.throws(() => parseWorkflowActionPayload({ origin: { portalId: 'bad', objectId: 123 } }));
});
