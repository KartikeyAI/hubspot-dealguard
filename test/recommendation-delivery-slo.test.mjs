import assert from 'node:assert/strict';
import test from 'node:test';
import {
  advanceRecommendationDeliverySlo,
  deliverySloMetricComparison,
  deliverySloMetricSupportsTarget,
  evaluateRecommendationDeliverySloMetric,
  worseDeliverySloValue,
} from '../dist/recommendation-delivery-slo-model.js';

const start = '2026-08-30T00:00:00.000Z';
const end = '2026-08-31T00:00:00.000Z';

function policy(overrides = {}) {
  return {
    id: 'slo-1',
    name: 'Delivery success',
    metric: 'delivery_success_percent',
    targetType: 'portal',
    targetId: null,
    targetLabel: 'Entire portal',
    comparison: 'minimum',
    thresholdValue: 95,
    windowMinutes: 1440,
    minimumSamples: 1,
    breachEvaluations: 2,
    recoveryEvaluations: 2,
    severity: 'warning',
    notificationRouteId: 'route-alerts',
    notificationRouteName: 'Operational alerts',
    alertCooldownMinutes: 60,
    maxAlertsPerIncident: 3,
    notifyRecovery: true,
    enabled: true,
    createdAt: start,
    updatedAt: start,
    lastEvaluatedAt: null,
    lastValue: null,
    lastSampleCount: 0,
    lastStatus: null,
    lastError: null,
    ...overrides,
  };
}

function attempt(overrides = {}) {
  return {
    batchId: 'batch-1',
    itemId: 'item-1',
    authorizationMode: 'configured_policy',
    routingPolicyId: 'routing-policy-1',
    itemStatus: 'delivered',
    createdAt: '2026-08-30T10:00:00.000Z',
    confirmedAt: '2026-08-30T10:00:00.000Z',
    completedAt: '2026-08-30T10:10:00.000Z',
    routeIds: ['route-1'],
    channelResults: [{ channelId: 'channel-1', status: 'delivered' }],
    ...overrides,
  };
}

function evidence(overrides = {}) {
  return {
    attempts: [],
    events: [],
    dispatches: [],
    start,
    end,
    truncated: false,
    ...overrides,
  };
}

function observation(overrides = {}) {
  return {
    value: 80,
    sampleCount: 10,
    breached: true,
    sufficient: true,
    truncated: false,
    evidenceStartAt: start,
    evidenceEndAt: end,
    reason: 'Delivery success was below the configured objective.',
    ...overrides,
  };
}

test('defines metric direction and supported target combinations', () => {
  assert.equal(deliverySloMetricComparison('delivery_success_percent'), 'minimum');
  assert.equal(deliverySloMetricComparison('failure_count'), 'maximum');
  assert.equal(deliverySloMetricSupportsTarget('route_unavailable_count', 'route'), true);
  assert.equal(deliverySloMetricSupportsTarget('route_unavailable_count', 'channel'), false);
  assert.equal(deliverySloMetricSupportsTarget('p95_completion_minutes', 'routing_policy'), true);
  assert.equal(deliverySloMetricSupportsTarget('p95_completion_minutes', 'route'), false);
});

test('calculates portal delivery success and treats partial delivery as unsuccessful', () => {
  const result = evaluateRecommendationDeliverySloMetric(policy(), evidence({
    attempts: [
      attempt({ itemId: 'delivered', itemStatus: 'delivered' }),
      attempt({ itemId: 'partial', itemStatus: 'partially_failed' }),
      attempt({ itemId: 'failed', itemStatus: 'failed' }),
    ],
  }));
  assert.equal(result.sampleCount, 3);
  assert.equal(result.value, 33.3);
  assert.equal(result.breached, true);

  const failures = evaluateRecommendationDeliverySloMetric(policy({
    metric: 'failure_count',
    comparison: 'maximum',
    thresholdValue: 1,
  }), evidence({
    attempts: [
      attempt({ itemId: 'delivered', itemStatus: 'delivered' }),
      attempt({ itemId: 'partial', itemStatus: 'partially_failed' }),
      attempt({ itemId: 'failed', itemStatus: 'failed' }),
    ],
  }));
  assert.equal(failures.value, 2);
  assert.equal(failures.breached, true);
});

test('evaluates route and channel delivery evidence without mixing targets', () => {
  const source = evidence({ attempts: [
    attempt({
      itemId: 'route-1-item',
      routeIds: ['route-1'],
      channelResults: [
        { channelId: 'channel-1', status: 'delivered' },
        { channelId: 'channel-2', status: 'failed' },
      ],
    }),
    attempt({
      itemId: 'route-2-item',
      routeIds: ['route-2'],
      channelResults: [{ channelId: 'channel-1', status: 'failed' }],
    }),
  ] });
  const route = evaluateRecommendationDeliverySloMetric(policy({
    targetType: 'route', targetId: 'route-1', targetLabel: 'Route 1',
  }), source);
  assert.equal(route.sampleCount, 2);
  assert.equal(route.value, 50);

  const channel = evaluateRecommendationDeliverySloMetric(policy({
    targetType: 'channel', targetId: 'channel-1', targetLabel: 'Channel 1',
  }), source);
  assert.equal(channel.sampleCount, 2);
  assert.equal(channel.value, 50);
});

test('counts deduplicated route-unavailable evidence for the selected target', () => {
  const result = evaluateRecommendationDeliverySloMetric(policy({
    metric: 'route_unavailable_count',
    targetType: 'route',
    targetId: 'route-1',
    targetLabel: 'Route 1',
    comparison: 'maximum',
    thresholdValue: 0,
    minimumSamples: 1,
  }), evidence({
    events: [
      { eventType: 'route_unavailable', routingPolicyId: 'p1', routeId: 'route-1', eventAt: start },
      { eventType: 'route_unavailable', routingPolicyId: 'p1', routeId: 'route-2', eventAt: start },
    ],
  }));
  assert.equal(result.sampleCount, 1);
  assert.equal(result.value, 1);
  assert.equal(result.breached, true);
});

test('uses the scheduler grace when evaluating escalation SLA breaches', () => {
  const result = evaluateRecommendationDeliverySloMetric(policy({
    metric: 'escalation_sla_breach_count',
    targetType: 'routing_policy',
    targetId: 'routing-policy-1',
    targetLabel: 'Overdue routing',
    comparison: 'maximum',
    thresholdValue: 0,
  }), evidence({
    dispatches: [
      {
        id: 'late', routingPolicyId: 'routing-policy-1',
        firstQueuedAt: '2026-08-30T10:00:00.000Z',
        escalationAfterMinutes: 60,
        escalatedAt: '2026-08-30T11:25:00.000Z',
        resolvedAt: null,
      },
      {
        id: 'resolved', routingPolicyId: 'routing-policy-1',
        firstQueuedAt: '2026-08-30T12:00:00.000Z',
        escalationAfterMinutes: 60,
        escalatedAt: null,
        resolvedAt: '2026-08-30T12:30:00.000Z',
      },
    ],
  }));
  assert.equal(result.sampleCount, 1);
  assert.equal(result.value, 1);
  assert.equal(result.breached, true);
});

test('calculates 95th-percentile completion latency per batch', () => {
  const result = evaluateRecommendationDeliverySloMetric(policy({
    metric: 'p95_completion_minutes',
    targetType: 'routing_policy',
    targetId: 'routing-policy-1',
    targetLabel: 'Routing policy',
    comparison: 'maximum',
    thresholdValue: 60,
  }), evidence({ attempts: [
    attempt({ batchId: 'fast', itemId: 'fast-1', completedAt: '2026-08-30T10:10:00.000Z' }),
    attempt({ batchId: 'fast', itemId: 'fast-2', completedAt: '2026-08-30T10:10:00.000Z' }),
    attempt({ batchId: 'slow', itemId: 'slow-1', createdAt: '2026-08-30T11:00:00.000Z', confirmedAt: '2026-08-30T11:00:00.000Z', completedAt: '2026-08-30T12:30:00.000Z' }),
  ] }));
  assert.equal(result.sampleCount, 2);
  assert.equal(result.value, 90);
  assert.equal(result.breached, true);
});

test('withholds enforcement for truncated or insufficient evidence', () => {
  const truncated = evaluateRecommendationDeliverySloMetric(policy(), evidence({
    attempts: [attempt()], truncated: true,
  }));
  assert.equal(truncated.sufficient, false);
  assert.equal(truncated.breached, false);
  assert.equal(truncated.value, null);

  const insufficient = evaluateRecommendationDeliverySloMetric(policy({ minimumSamples: 5 }), evidence({
    attempts: [attempt()],
  }));
  assert.equal(insufficient.sufficient, false);
  assert.equal(insufficient.breached, false);
});

test('requires persistent breach and recovery evidence before incident transitions', () => {
  const configured = policy({ breachEvaluations: 2, recoveryEvaluations: 2 });
  const first = advanceRecommendationDeliverySlo(configured, null, observation(), null, '2026-08-30T10:00:00.000Z');
  assert.equal(first.nextState.status, 'breaching');
  assert.equal(first.action, 'none');

  const second = advanceRecommendationDeliverySlo(configured, first.nextState, observation(), null, '2026-08-30T10:15:00.000Z');
  assert.equal(second.nextState.status, 'breached');
  assert.equal(second.action, 'open_incident');

  const recovering = advanceRecommendationDeliverySlo(
    configured,
    second.nextState,
    observation({ value: 99, breached: false }),
    { alertCount: 1, nextAlertAt: second.nextState.nextAlertAt },
    '2026-08-30T10:30:00.000Z',
  );
  assert.equal(recovering.nextState.status, 'recovering');
  assert.equal(recovering.action, 'update_incident');

  const recovered = advanceRecommendationDeliverySlo(
    configured,
    recovering.nextState,
    observation({ value: 99, breached: false }),
    { alertCount: 1, nextAlertAt: recovering.nextState.nextAlertAt },
    '2026-08-30T10:45:00.000Z',
  );
  assert.equal(recovered.nextState.status, 'meeting');
  assert.equal(recovered.action, 'resolve_incident');
});

test('enforces alert cooldown and maximum reminder count', () => {
  const configured = policy({ breachEvaluations: 1, alertCooldownMinutes: 60, maxAlertsPerIncident: 2 });
  const opened = advanceRecommendationDeliverySlo(configured, null, observation(), null, '2026-08-30T10:00:00.000Z');
  assert.equal(opened.action, 'open_incident');

  const cooling = advanceRecommendationDeliverySlo(
    configured,
    opened.nextState,
    observation(),
    { alertCount: 1, nextAlertAt: opened.nextState.nextAlertAt },
    '2026-08-30T10:30:00.000Z',
  );
  assert.equal(cooling.action, 'update_incident');

  const reminder = advanceRecommendationDeliverySlo(
    configured,
    cooling.nextState,
    observation(),
    { alertCount: 1, nextAlertAt: cooling.nextState.nextAlertAt },
    '2026-08-30T11:01:00.000Z',
  );
  assert.equal(reminder.action, 'send_reminder');

  const capped = advanceRecommendationDeliverySlo(
    configured,
    reminder.nextState,
    observation(),
    { alertCount: 2, nextAlertAt: reminder.nextState.nextAlertAt },
    '2026-08-30T12:30:00.000Z',
  );
  assert.equal(capped.action, 'update_incident');
});

test('tracks the worst observed value according to the objective direction', () => {
  assert.equal(worseDeliverySloValue('minimum', 90, 80), 80);
  assert.equal(worseDeliverySloValue('minimum', 80, 90), 80);
  assert.equal(worseDeliverySloValue('maximum', 2, 5), 5);
  assert.equal(worseDeliverySloValue('maximum', 5, 2), 5);
});
