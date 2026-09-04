import assert from 'node:assert/strict';
import test from 'node:test';
import {
  effectivePolicyCooldownMinutes,
  evaluateRecommendationPolicyMatch,
  nextPolicyDispatchStage,
  policyEventType,
  policyNextEligibleAt,
  recommendationPriorityAtLeast,
} from '../dist/recommendation-routing-policy-model.js';

const basePolicy = {
  id: 'policy-1',
  name: 'Accepted recommendation SLA',
  trigger: 'overdue',
  statusScope: 'accepted',
  minimumPriority: 'medium',
  thresholdMinutes: 60,
  cooldownMinutes: 1440,
  maxNotifications: 3,
  severity: 'warning',
  routeId: 'route-1',
  escalationRouteId: 'route-2',
  escalationAfterMinutes: 2880,
  managerNote: 'Review the recommendation and record a dated next action.',
  scope: { pipelineIds: ['pipeline-1'], teamIds: [], ownerIds: [], regionCodes: [] },
  enabled: true,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  lastEvaluatedAt: null,
  lastMatchCount: 0,
  lastQueueCount: 0,
  lastError: null,
  dispatchSummary: { active: 0, queued: 0, delivered: 0, failed: 0, escalated: 0 },
};

function recommendation(overrides = {}) {
  return {
    id: 'recommendation-1',
    dealId: 'deal-1',
    recommendationCode: 'next_step_missing',
    label: 'Record a dated next step',
    action: 'Record the next buyer-owned milestone and date.',
    dimension: 'readiness',
    priority: 'high',
    owner: 'deal_owner',
    dueAt: '2026-08-31T11:00:00.000Z',
    rationale: 'The deal has no dated next step.',
    evidenceCodes: ['next_step_missing'],
    methodology: 'deterministic',
    status: 'accepted',
    terminalReason: null,
    presentedAt: '2026-08-28T00:00:00.000Z',
    lastPresentedAt: '2026-08-28T00:00:00.000Z',
    acceptedAt: '2026-08-28T01:00:00.000Z',
    completedAt: null,
    dismissedAt: null,
    expiredAt: null,
    supersededAt: null,
    dismissalReason: null,
    overdue: true,
    current: true,
    baseline: {
      assessmentAt: '2026-08-28T00:00:00.000Z',
      generatedAt: '2026-08-28T00:00:00.000Z',
      readinessScore: 62,
      readinessStatus: 'at_risk',
      pipelineId: 'pipeline-1',
      stageId: 'stage-1',
      stageLabel: 'Evaluation',
      ownerId: 'owner-1',
      teamId: 'team-1',
      regionCode: 'IN',
      closeDate: '2026-09-30T00:00:00.000Z',
      attentionScore: 70,
      briefStatus: 'watch',
      dimensions: {},
    },
    outcome: null,
    ...overrides,
  };
}

test('matches an accepted recommendation only after the configured overdue grace period', () => {
  const beforeGrace = evaluateRecommendationPolicyMatch(
    basePolicy,
    recommendation(),
    Date.parse('2026-08-31T11:30:00.000Z'),
  );
  assert.equal(beforeGrace.matched, false);

  const afterGrace = evaluateRecommendationPolicyMatch(
    basePolicy,
    recommendation(),
    Date.parse('2026-08-31T12:30:00.000Z'),
  );
  assert.equal(afterGrace.matched, true);
  assert.match(afterGrace.reason, /Overdue by at least 60 minutes/);
});

test('matches due-soon recommendations inside the future threshold without treating overdue work as due soon', () => {
  const policy = { ...basePolicy, trigger: 'due_soon', statusScope: 'both', thresholdMinutes: 1440 };
  const now = Date.parse('2026-08-30T12:00:00.000Z');
  assert.equal(evaluateRecommendationPolicyMatch(policy, recommendation(), now).matched, true);
  assert.equal(evaluateRecommendationPolicyMatch(
    policy,
    recommendation({ dueAt: '2026-08-30T11:00:00.000Z' }),
    now,
  ).matched, false);
});

test('enforces lifecycle, minimum priority and policy scope', () => {
  const now = Date.parse('2026-08-31T12:30:00.000Z');
  assert.equal(evaluateRecommendationPolicyMatch(basePolicy, recommendation({ status: 'presented' }), now).matched, false);
  assert.equal(evaluateRecommendationPolicyMatch(basePolicy, recommendation({ priority: 'low' }), now).matched, false);
  assert.equal(evaluateRecommendationPolicyMatch(basePolicy, recommendation({
    baseline: { ...recommendation().baseline, pipelineId: 'pipeline-2' },
  }), now).matched, false);
  assert.equal(recommendationPriorityAtLeast('high', 'medium'), true);
  assert.equal(recommendationPriorityAtLeast('low', 'medium'), false);
});

test('selects initial, repeat and one-time escalation stages transparently', () => {
  const now = Date.parse('2026-08-31T12:00:00.000Z');
  assert.equal(nextPolicyDispatchStage(basePolicy, null, now), 'initial');
  assert.equal(nextPolicyDispatchStage(basePolicy, {
    notificationCount: 1,
    escalationCount: 0,
    firstQueuedAt: '2026-08-28T00:00:00.000Z',
    lastQueuedAt: '2026-08-28T00:00:00.000Z',
    nextEligibleAt: '2026-09-01T00:00:00.000Z',
    escalatedAt: null,
    resolvedAt: '2026-08-30T00:00:00.000Z',
  }, now), 'escalation');
  assert.equal(nextPolicyDispatchStage({ ...basePolicy, escalationRouteId: null, escalationAfterMinutes: null }, {
    notificationCount: 1,
    escalationCount: 0,
    firstQueuedAt: '2026-08-30T00:00:00.000Z',
    lastQueuedAt: '2026-08-30T00:00:00.000Z',
    nextEligibleAt: '2026-08-31T11:00:00.000Z',
    escalatedAt: null,
    resolvedAt: '2026-08-30T12:00:00.000Z',
  }, now), 'repeat');
  assert.equal(nextPolicyDispatchStage(basePolicy, {
    notificationCount: 3,
    escalationCount: 1,
    firstQueuedAt: '2026-08-28T00:00:00.000Z',
    lastQueuedAt: '2026-08-30T00:00:00.000Z',
    nextEligibleAt: '2026-08-31T11:00:00.000Z',
    escalatedAt: '2026-08-30T00:00:00.000Z',
    resolvedAt: null,
  }, now), null);
});

test('uses the larger route suppression or policy cooldown and exposes event semantics', () => {
  assert.equal(effectivePolicyCooldownMinutes(60, 120), 120);
  assert.equal(effectivePolicyCooldownMinutes(240, 30), 240);
  assert.equal(effectivePolicyCooldownMinutes(0, 0), 15);
  assert.equal(policyEventType('due_soon', 'initial'), 'recommendation.policy.due_soon');
  assert.equal(policyEventType('overdue', 'repeat'), 'recommendation.policy.overdue');
  assert.equal(policyEventType('overdue', 'escalation'), 'recommendation.policy.escalated');
  assert.equal(policyNextEligibleAt('2026-08-31T12:00:00.000Z', 60), '2026-08-31T13:00:00.000Z');
});
