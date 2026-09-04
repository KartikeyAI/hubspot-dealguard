import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRecommendationDeliveryAnalytics } from '../dist/recommendation-delivery-analytics-model.js';

const generatedAt = '2026-08-31T12:00:00.000Z';
const start = '2026-08-01T12:00:00.000Z';
const end = generatedAt;

function attempt(overrides = {}) {
  return {
    batchId: 'batch-1',
    itemId: 'item-1',
    recommendationId: 'recommendation-1',
    dealId: 'deal-1',
    authorizationMode: 'configured_policy',
    policyId: 'policy-1',
    policyName: 'Overdue recommendation policy',
    trigger: 'overdue',
    escalationAfterMinutes: 60,
    dispatchId: 'dispatch-1',
    batchStatus: 'completed',
    itemStatus: 'delivered',
    kind: 'owner_reminder',
    severity: 'warning',
    createdAt: '2026-08-30T10:00:00.000Z',
    confirmedAt: '2026-08-30T10:00:00.000Z',
    completedAt: '2026-08-30T10:10:00.000Z',
    recommendationDueAt: '2026-08-30T09:00:00.000Z',
    firstMatchedAt: '2026-08-30T09:55:00.000Z',
    firstQueuedAt: '2026-08-30T10:00:00.000Z',
    escalatedAt: null,
    resolvedAt: null,
    routeIds: ['route-1'],
    channelIds: ['channel-1'],
    channelResults: [{
      channelId: 'channel-1',
      channelName: 'Revenue Slack',
      channelType: 'slack_webhook',
      status: 'delivered',
      error: null,
    }],
    pipelineId: 'pipeline-1',
    teamId: 'team-1',
    ownerId: 'owner-1',
    regionCode: 'IN',
    ...overrides,
  };
}

function dispatch(overrides = {}) {
  return {
    id: 'dispatch-1',
    policyId: 'policy-1',
    policyName: 'Overdue recommendation policy',
    trigger: 'overdue',
    escalationAfterMinutes: 60,
    recommendationId: 'recommendation-1',
    state: 'active',
    firstMatchedAt: '2026-08-30T09:55:00.000Z',
    firstQueuedAt: '2026-08-30T10:00:00.000Z',
    lastQueuedAt: '2026-08-30T10:00:00.000Z',
    nextEligibleAt: '2026-08-31T10:00:00.000Z',
    notificationCount: 1,
    escalationCount: 0,
    escalatedAt: null,
    resolvedAt: null,
    lastDeliveryStatus: 'completed',
    pipelineId: 'pipeline-1',
    teamId: 'team-1',
    ownerId: 'owner-1',
    regionCode: 'IN',
    ...overrides,
  };
}

function event(eventType, overrides = {}) {
  return {
    id: `${eventType}-1`,
    eventType,
    policyId: 'policy-1',
    dispatchId: 'dispatch-1',
    recommendationId: 'recommendation-1',
    routeId: 'route-1',
    stage: 'repeat',
    reasonCode: eventType,
    eventAt: '2026-08-30T11:00:00.000Z',
    recommendationDueAt: '2026-08-30T09:00:00.000Z',
    slaDueAt: null,
    pipelineId: 'pipeline-1',
    teamId: 'team-1',
    ownerId: 'owner-1',
    regionCode: 'IN',
    ...overrides,
  };
}

function build({ attempts = [], events = [], dispatches = [] } = {}) {
  return buildRecommendationDeliveryAnalytics({
    generatedAt,
    days: 30,
    start,
    end,
    attempts,
    events,
    dispatches,
    routes: [
      { id: 'route-1', name: 'Primary Slack route' },
      { id: 'route-2', name: 'Manager escalation route' },
    ],
    channels: [
      { id: 'channel-1', name: 'Revenue Slack', type: 'slack_webhook' },
      { id: 'channel-2', name: 'RevOps email', type: 'email' },
    ],
    truncated: false,
  });
}

test('calculates delivery success and completion latency from terminal batch evidence', () => {
  const result = build({
    attempts: [
      attempt(),
      attempt({
        batchId: 'batch-2', itemId: 'item-2', recommendationId: 'recommendation-2', dispatchId: 'dispatch-2',
        itemStatus: 'partially_failed', createdAt: '2026-08-30T11:00:00.000Z', confirmedAt: '2026-08-30T11:00:00.000Z',
        completedAt: '2026-08-30T11:30:00.000Z',
        channelResults: [
          { channelId: 'channel-1', channelName: 'Revenue Slack', channelType: 'slack_webhook', status: 'delivered', error: null },
          { channelId: 'channel-2', channelName: 'RevOps email', channelType: 'email', status: 'failed', error: 'provider unavailable' },
        ],
      }),
      attempt({
        batchId: 'batch-3', itemId: 'item-3', recommendationId: 'recommendation-3', dispatchId: 'dispatch-3',
        itemStatus: 'failed', createdAt: '2026-08-30T12:00:00.000Z', confirmedAt: '2026-08-30T12:00:00.000Z',
        completedAt: '2026-08-30T13:00:00.000Z',
        channelResults: [{ channelId: 'channel-2', channelName: 'RevOps email', channelType: 'email', status: 'failed', error: 'invalid destination' }],
      }),
    ],
  });
  assert.equal(result.summary.attemptedItems, 3);
  assert.equal(result.summary.deliveredItems, 1);
  assert.equal(result.summary.partiallyFailedItems, 1);
  assert.equal(result.summary.failedItems, 1);
  assert.equal(result.summary.deliverySuccessPercent, 33);
  assert.equal(result.summary.medianCompletionMinutes, 30);
  assert.equal(result.summary.p95CompletionMinutes, 60);
  assert.equal(result.channels.find((item) => item.channelId === 'channel-2').failed, 2);
});

test('separates primary, repeat, escalation and human-confirmed delivery', () => {
  const result = build({
    attempts: [
      attempt(),
      attempt({
        batchId: 'batch-repeat', itemId: 'item-repeat', createdAt: '2026-08-30T11:00:00.000Z',
        confirmedAt: '2026-08-30T11:00:00.000Z', completedAt: '2026-08-30T11:10:00.000Z',
      }),
      attempt({
        batchId: 'batch-escalation', itemId: 'item-escalation', kind: 'manager_review',
        createdAt: '2026-08-30T11:05:00.000Z', confirmedAt: '2026-08-30T11:05:00.000Z',
        completedAt: '2026-08-30T11:15:00.000Z', escalatedAt: '2026-08-30T11:05:00.000Z', routeIds: ['route-2'],
      }),
      attempt({
        batchId: 'batch-manual', itemId: 'item-manual', recommendationId: 'recommendation-manual',
        authorizationMode: 'human_confirmation', policyId: null, policyName: null, trigger: null,
        escalationAfterMinutes: null, dispatchId: null, createdAt: '2026-08-30T09:00:00.000Z',
        confirmedAt: '2026-08-30T09:00:00.000Z', completedAt: '2026-08-30T09:05:00.000Z',
      }),
    ],
  });
  assert.equal(result.summary.primaryQueued, 1);
  assert.equal(result.summary.repeatQueued, 1);
  assert.equal(result.summary.escalationQueued, 1);
  assert.equal(result.summary.manualBatches, 1);
  assert.equal(result.summary.policyBatches, 3);
});

test('calculates scheduler-aware escalation SLA compliance and excludes early resolution', () => {
  const result = build({
    dispatches: [
      dispatch({
        id: 'compliant', recommendationId: 'recommendation-compliant',
        firstQueuedAt: '2026-08-30T10:00:00.000Z', escalatedAt: '2026-08-30T11:15:00.000Z', escalationCount: 1,
      }),
      dispatch({
        id: 'breached', recommendationId: 'recommendation-breached',
        firstQueuedAt: '2026-08-30T08:00:00.000Z', escalatedAt: null,
      }),
      dispatch({
        id: 'resolved', recommendationId: 'recommendation-resolved',
        firstQueuedAt: '2026-08-30T07:00:00.000Z', resolvedAt: '2026-08-30T07:30:00.000Z', state: 'resolved',
      }),
    ],
  });
  assert.equal(result.summary.escalationSlaEligible, 2);
  assert.equal(result.summary.escalationSlaCompliant, 1);
  assert.equal(result.summary.escalationSlaBreached, 1);
  assert.equal(result.summary.escalationSlaCompliancePercent, 50);
  assert.equal(result.semantics.schedulerGraceMinutes, 20);
});

test('reports quiet-hour, cooldown, notification-cap and route availability controls', () => {
  const result = build({
    events: [
      event('policy_matched'),
      event('quiet_hours_deferred'),
      event('cooldown_suppressed'),
      event('notification_limit_suppressed'),
      event('route_unavailable'),
      event('dispatch_resolved'),
    ],
  });
  assert.equal(result.summary.quietHourDeferrals, 1);
  assert.equal(result.summary.cooldownSuppressions, 1);
  assert.equal(result.summary.notificationLimitSuppressions, 1);
  assert.equal(result.summary.routeUnavailable, 1);
  assert.equal(result.summary.resolvedDispatches, 1);
  const route = result.routes.find((item) => item.routeId === 'route-1');
  assert.equal(route.quietHourDeferrals, 1);
  assert.equal(route.routeUnavailable, 1);
  assert.equal(route.health, 'watch');
});

test('keeps delivery evidence operational, non-causal and independent of CRM mutation', () => {
  const result = build({ attempts: [attempt()], dispatches: [dispatch()] });
  assert.equal(result.semantics.operationalDeliveryOnly, true);
  assert.equal(result.semantics.notDealOutcome, true);
  assert.equal(result.semantics.noCausalAttribution, true);
  assert.equal(result.semantics.noCrmMutation, true);
  assert.match(result.limitations.join(' '), /does not measure whether a deal progressed/i);
  assert.equal(result.timeline[0].deliveredItems, 1);
});
