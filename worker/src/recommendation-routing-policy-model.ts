import type { RecommendationInstance } from './recommendation-outcome-types.js';
import {
  RECOMMENDATION_POLICY_DUE_SOON_EVENT,
  RECOMMENDATION_POLICY_ESCALATED_EVENT,
  RECOMMENDATION_POLICY_OVERDUE_EVENT,
  type RecommendationPolicyDispatchStage,
  type RecommendationRoutingPolicy,
  type RecommendationRoutingPriority,
  type RecommendationRoutingScope,
  type RecommendationRoutingTrigger,
} from './recommendation-routing-policy-types.js';

const PRIORITY_RANK: Record<RecommendationRoutingPriority, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

export interface RecommendationPolicyDispatchState {
  notificationCount: number;
  escalationCount: number;
  firstQueuedAt: string | null;
  lastQueuedAt: string | null;
  nextEligibleAt: string | null;
  escalatedAt: string | null;
  resolvedAt: string | null;
}

export interface RecommendationPolicyMatch {
  matched: boolean;
  reason: string;
  dueAt: string | null;
  minutesFromDue: number | null;
}

export function policyEventType(
  trigger: RecommendationRoutingTrigger,
  stage: RecommendationPolicyDispatchStage,
): string {
  if (stage === 'escalation') return RECOMMENDATION_POLICY_ESCALATED_EVENT;
  return trigger === 'due_soon'
    ? RECOMMENDATION_POLICY_DUE_SOON_EVENT
    : RECOMMENDATION_POLICY_OVERDUE_EVENT;
}

export function recommendationPriorityAtLeast(
  actual: RecommendationRoutingPriority,
  minimum: RecommendationRoutingPriority,
): boolean {
  return PRIORITY_RANK[actual] >= PRIORITY_RANK[minimum];
}

function withinScope(value: string | null, allowed: string[]): boolean {
  return allowed.length === 0 || Boolean(value && allowed.includes(value));
}

export function recommendationMatchesPolicyScope(
  recommendation: RecommendationInstance,
  scope: RecommendationRoutingScope,
): boolean {
  return withinScope(recommendation.baseline.pipelineId, scope.pipelineIds)
    && withinScope(recommendation.baseline.teamId, scope.teamIds)
    && withinScope(recommendation.baseline.ownerId, scope.ownerIds)
    && withinScope(recommendation.baseline.regionCode, scope.regionCodes);
}

export function evaluateRecommendationPolicyMatch(
  policy: RecommendationRoutingPolicy,
  recommendation: RecommendationInstance,
  now = Date.now(),
): RecommendationPolicyMatch {
  if (recommendation.status !== 'presented' && recommendation.status !== 'accepted') {
    return { matched: false, reason: 'Recommendation is no longer active.', dueAt: recommendation.dueAt, minutesFromDue: null };
  }
  if (policy.statusScope !== 'both' && recommendation.status !== policy.statusScope) {
    return { matched: false, reason: `Policy applies only to ${policy.statusScope} recommendations.`, dueAt: recommendation.dueAt, minutesFromDue: null };
  }
  if (!recommendationPriorityAtLeast(recommendation.priority, policy.minimumPriority)) {
    return { matched: false, reason: 'Recommendation priority is below the policy minimum.', dueAt: recommendation.dueAt, minutesFromDue: null };
  }
  if (!recommendationMatchesPolicyScope(recommendation, policy.scope)) {
    return { matched: false, reason: 'Recommendation is outside the policy data scope.', dueAt: recommendation.dueAt, minutesFromDue: null };
  }
  if (!recommendation.dueAt) {
    return { matched: false, reason: 'Recommendation has no due date.', dueAt: null, minutesFromDue: null };
  }
  const due = Date.parse(recommendation.dueAt);
  if (!Number.isFinite(due)) {
    return { matched: false, reason: 'Recommendation due date is invalid.', dueAt: recommendation.dueAt, minutesFromDue: null };
  }
  const minutesFromDue = Math.round((due - now) / 60_000);
  if (policy.trigger === 'due_soon') {
    const matched = due >= now && due <= now + policy.thresholdMinutes * 60_000;
    return {
      matched,
      reason: matched
        ? `Due within ${policy.thresholdMinutes} minutes.`
        : 'Due date is outside the configured due-soon window.',
      dueAt: recommendation.dueAt,
      minutesFromDue,
    };
  }
  const matched = due <= now - policy.thresholdMinutes * 60_000;
  return {
    matched,
    reason: matched
      ? `Overdue by at least ${policy.thresholdMinutes} minutes.`
      : 'Recommendation has not crossed the configured overdue threshold.',
    dueAt: recommendation.dueAt,
    minutesFromDue,
  };
}

export function nextPolicyDispatchStage(
  policy: RecommendationRoutingPolicy,
  state: RecommendationPolicyDispatchState | null,
  now = Date.now(),
): RecommendationPolicyDispatchStage | null {
  if (!state || state.notificationCount === 0) return 'initial';
  // The evaluator calls this function only for a recommendation that currently
  // matches the policy. A previously resolved dispatch can therefore be
  // reactivated without losing its conservative cooldown and send counters.
  if (
    policy.escalationRouteId
    && policy.escalationAfterMinutes !== null
    && state.firstQueuedAt
    && state.escalationCount === 0
    && Date.parse(state.firstQueuedAt) + policy.escalationAfterMinutes * 60_000 <= now
  ) {
    return 'escalation';
  }
  if (state.notificationCount >= policy.maxNotifications) return null;
  if (!state.nextEligibleAt || Date.parse(state.nextEligibleAt) <= now) return 'repeat';
  return null;
}

export function effectivePolicyCooldownMinutes(
  policyCooldownMinutes: number,
  routeSuppressionWindowMinutes: number,
): number {
  return Math.max(15, policyCooldownMinutes, routeSuppressionWindowMinutes);
}

export function policyNextEligibleAt(
  queuedAt: string,
  cooldownMinutes: number,
): string {
  return new Date(Date.parse(queuedAt) + cooldownMinutes * 60_000).toISOString();
}
