import { DELIVERY_ANALYTICS_SCHEDULER_GRACE_MINUTES } from './recommendation-delivery-analytics-model.js';
import type {
  RecommendationDeliverySloComparison,
  RecommendationDeliverySloLifecycleDecision,
  RecommendationDeliverySloMetric,
  RecommendationDeliverySloObservation,
  RecommendationDeliverySloPolicy,
  RecommendationDeliverySloState,
  RecommendationDeliverySloTargetType,
} from './recommendation-delivery-slo-types.js';

const TERMINAL_ITEM_STATUSES = new Set(['delivered', 'partially_failed', 'failed']);

export interface RecommendationDeliverySloAttempt {
  batchId: string;
  itemId: string;
  authorizationMode: 'human_confirmation' | 'configured_policy';
  routingPolicyId: string | null;
  itemStatus: string;
  createdAt: string;
  confirmedAt: string | null;
  completedAt: string | null;
  routeIds: string[];
  channelResults: Array<{
    channelId: string;
    status: 'delivered' | 'failed';
  }>;
}

export interface RecommendationDeliverySloEventEvidence {
  eventType: string;
  routingPolicyId: string | null;
  routeId: string | null;
  eventAt: string;
}

export interface RecommendationDeliverySloDispatchEvidence {
  id: string;
  routingPolicyId: string;
  firstQueuedAt: string | null;
  escalatedAt: string | null;
  resolvedAt: string | null;
  escalationAfterMinutes: number | null;
}

export interface RecommendationDeliverySloEvidence {
  attempts: RecommendationDeliverySloAttempt[];
  events: RecommendationDeliverySloEventEvidence[];
  dispatches: RecommendationDeliverySloDispatchEvidence[];
  start: string;
  end: string;
  truncated: boolean;
}

export interface RecommendationDeliveryOpenIncidentState {
  alertCount: number;
  nextAlertAt: string | null;
}

function timestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function percentile(values: number[], percentileValue: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(percentileValue * sorted.length) - 1));
  return round(sorted[index]!);
}

function targetMatchesAttempt(
  policy: Pick<RecommendationDeliverySloPolicy, 'targetType' | 'targetId'>,
  attempt: RecommendationDeliverySloAttempt,
): boolean {
  if (policy.targetType === 'portal') return true;
  if (!policy.targetId) return false;
  if (policy.targetType === 'route') return attempt.routeIds.includes(policy.targetId);
  if (policy.targetType === 'routing_policy') return attempt.routingPolicyId === policy.targetId;
  return true;
}

function targetMatchesEvent(
  policy: Pick<RecommendationDeliverySloPolicy, 'targetType' | 'targetId'>,
  event: RecommendationDeliverySloEventEvidence,
): boolean {
  if (policy.targetType === 'portal') return true;
  if (!policy.targetId) return false;
  if (policy.targetType === 'route') return event.routeId === policy.targetId;
  if (policy.targetType === 'routing_policy') return event.routingPolicyId === policy.targetId;
  return false;
}

function targetMatchesDispatch(
  policy: Pick<RecommendationDeliverySloPolicy, 'targetType' | 'targetId'>,
  dispatch: RecommendationDeliverySloDispatchEvidence,
): boolean {
  if (policy.targetType === 'portal') return true;
  return policy.targetType === 'routing_policy'
    && Boolean(policy.targetId && dispatch.routingPolicyId === policy.targetId);
}

export function deliverySloMetricComparison(metric: RecommendationDeliverySloMetric): RecommendationDeliverySloComparison {
  return metric === 'delivery_success_percent' ? 'minimum' : 'maximum';
}

export function deliverySloMetricSupportsTarget(
  metric: RecommendationDeliverySloMetric,
  targetType: RecommendationDeliverySloTargetType,
): boolean {
  if (metric === 'route_unavailable_count') return targetType === 'portal' || targetType === 'route';
  if (metric === 'escalation_sla_breach_count' || metric === 'p95_completion_minutes') {
    return targetType === 'portal' || targetType === 'routing_policy';
  }
  return true;
}

function metricBreached(comparison: RecommendationDeliverySloComparison, value: number, threshold: number): boolean {
  return comparison === 'minimum' ? value < threshold : value > threshold;
}

function itemDeliveryEvidence(policy: RecommendationDeliverySloPolicy, evidence: RecommendationDeliverySloEvidence) {
  const attempts = evidence.attempts.filter((attempt) => targetMatchesAttempt(policy, attempt));
  if (policy.targetType === 'channel') {
    const results = attempts.flatMap((attempt) => attempt.channelResults)
      .filter((result) => result.channelId === policy.targetId);
    return {
      sampleCount: results.length,
      delivered: results.filter((result) => result.status === 'delivered').length,
      failed: results.filter((result) => result.status === 'failed').length,
    };
  }
  if (policy.targetType === 'route') {
    const results = attempts.flatMap((attempt) => attempt.channelResults);
    return {
      sampleCount: results.length,
      delivered: results.filter((result) => result.status === 'delivered').length,
      failed: results.filter((result) => result.status === 'failed').length,
    };
  }
  const terminal = attempts.filter((attempt) => TERMINAL_ITEM_STATUSES.has(attempt.itemStatus));
  return {
    sampleCount: terminal.length,
    delivered: terminal.filter((attempt) => attempt.itemStatus === 'delivered').length,
    failed: terminal.filter((attempt) => attempt.itemStatus === 'failed' || attempt.itemStatus === 'partially_failed').length,
  };
}

function escalationEvidence(
  policy: RecommendationDeliverySloPolicy,
  evidence: RecommendationDeliverySloEvidence,
): { sampleCount: number; breached: number } {
  const start = timestamp(evidence.start) ?? 0;
  const end = timestamp(evidence.end) ?? Date.now();
  let eligible = 0;
  let breached = 0;
  for (const dispatch of evidence.dispatches.filter((item) => targetMatchesDispatch(policy, item))) {
    if (dispatch.escalationAfterMinutes === null || !dispatch.firstQueuedAt) continue;
    const queued = timestamp(dispatch.firstQueuedAt);
    if (queued === null) continue;
    const due = queued + dispatch.escalationAfterMinutes * 60_000;
    const grace = due + DELIVERY_ANALYTICS_SCHEDULER_GRACE_MINUTES * 60_000;
    if (due < start || due > end) continue;
    const resolved = timestamp(dispatch.resolvedAt);
    if (resolved !== null && resolved <= due) continue;
    if (end < grace) continue;
    eligible += 1;
    const escalated = timestamp(dispatch.escalatedAt);
    if (escalated === null || escalated > grace) breached += 1;
  }
  return { sampleCount: eligible, breached };
}

function completionLatencyEvidence(
  policy: RecommendationDeliverySloPolicy,
  evidence: RecommendationDeliverySloEvidence,
): { sampleCount: number; p95: number | null } {
  const batches = new Map<string, RecommendationDeliverySloAttempt>();
  for (const attempt of evidence.attempts.filter((item) => targetMatchesAttempt(policy, item))) {
    if (!batches.has(attempt.batchId)) batches.set(attempt.batchId, attempt);
  }
  const values = [...batches.values()].flatMap((attempt) => {
    const started = timestamp(attempt.confirmedAt ?? attempt.createdAt);
    const completed = timestamp(attempt.completedAt);
    return started !== null && completed !== null && completed >= started
      ? [round((completed - started) / 60_000)]
      : [];
  });
  return { sampleCount: values.length, p95: percentile(values, 0.95) };
}

export function evaluateRecommendationDeliverySloMetric(
  policy: RecommendationDeliverySloPolicy,
  evidence: RecommendationDeliverySloEvidence,
): RecommendationDeliverySloObservation {
  if (evidence.truncated) {
    return {
      value: null,
      sampleCount: 0,
      breached: false,
      sufficient: false,
      truncated: true,
      evidenceStartAt: evidence.start,
      evidenceEndAt: evidence.end,
      reason: 'The bounded evidence query was truncated, so DealGuard withheld enforcement for this evaluation.',
    };
  }

  let value: number | null = null;
  let sampleCount = 0;
  if (policy.metric === 'delivery_success_percent' || policy.metric === 'failure_count') {
    const item = itemDeliveryEvidence(policy, evidence);
    sampleCount = item.sampleCount;
    value = policy.metric === 'delivery_success_percent'
      ? sampleCount > 0 ? round(item.delivered / sampleCount * 100) : null
      : item.failed;
  } else if (policy.metric === 'route_unavailable_count') {
    const unavailable = evidence.events.filter((event) =>
      event.eventType === 'route_unavailable' && targetMatchesEvent(policy, event));
    const attempts = evidence.attempts.filter((attempt) => targetMatchesAttempt(policy, attempt));
    sampleCount = attempts.length + unavailable.length;
    value = unavailable.length;
  } else if (policy.metric === 'escalation_sla_breach_count') {
    const escalation = escalationEvidence(policy, evidence);
    sampleCount = escalation.sampleCount;
    value = escalation.breached;
  } else if (policy.metric === 'p95_completion_minutes') {
    const latency = completionLatencyEvidence(policy, evidence);
    sampleCount = latency.sampleCount;
    value = latency.p95;
  }

  const sufficient = value !== null && sampleCount >= policy.minimumSamples;
  const breached = sufficient && metricBreached(policy.comparison, value!, policy.thresholdValue);
  const relation = policy.comparison === 'minimum' ? 'at least' : 'at most';
  return {
    value,
    sampleCount,
    breached,
    sufficient,
    truncated: false,
    evidenceStartAt: evidence.start,
    evidenceEndAt: evidence.end,
    reason: sufficient
      ? `${policy.metric} was ${value}; the configured objective is ${relation} ${policy.thresholdValue}.`
      : `Only ${sampleCount} comparable sample(s) were available; ${policy.minimumSamples} are required.`,
  };
}

function emptyState(now: string): RecommendationDeliverySloState {
  return {
    status: 'insufficient_data',
    consecutiveBreaches: 0,
    consecutiveRecoveries: 0,
    firstBreachedAt: null,
    lastBreachedAt: null,
    lastRecoveredAt: null,
    lastAlertAt: null,
    nextAlertAt: null,
    currentValue: null,
    sampleCount: 0,
    evidenceStartAt: null,
    evidenceEndAt: null,
    evidenceTruncated: false,
    lastReason: null,
    evaluatedAt: now,
  };
}

export function advanceRecommendationDeliverySlo(
  policy: RecommendationDeliverySloPolicy,
  previous: RecommendationDeliverySloState | null,
  observation: RecommendationDeliverySloObservation,
  incident: RecommendationDeliveryOpenIncidentState | null,
  now = new Date().toISOString(),
): RecommendationDeliverySloLifecycleDecision {
  const state = previous ? { ...previous } : emptyState(now);
  state.currentValue = observation.value;
  state.sampleCount = observation.sampleCount;
  state.evidenceStartAt = observation.evidenceStartAt;
  state.evidenceEndAt = observation.evidenceEndAt;
  state.evidenceTruncated = observation.truncated;
  state.lastReason = observation.reason;
  state.evaluatedAt = now;

  if (!observation.sufficient) {
    state.status = 'insufficient_data';
    state.consecutiveBreaches = 0;
    state.consecutiveRecoveries = 0;
    return { nextState: state, action: 'none' };
  }

  if (observation.breached) {
    state.consecutiveBreaches = (previous?.consecutiveBreaches ?? 0) + 1;
    state.consecutiveRecoveries = 0;
    state.firstBreachedAt = previous?.firstBreachedAt ?? now;
    state.lastBreachedAt = now;
    if (state.consecutiveBreaches < policy.breachEvaluations) {
      state.status = 'breaching';
      return { nextState: state, action: incident ? 'update_incident' : 'none' };
    }
    state.status = 'breached';
    if (!incident) {
      state.lastAlertAt = now;
      state.nextAlertAt = new Date(Date.parse(now) + policy.alertCooldownMinutes * 60_000).toISOString();
      return { nextState: state, action: 'open_incident' };
    }
    const nextAlert = timestamp(incident.nextAlertAt);
    if (
      incident.alertCount < policy.maxAlertsPerIncident
      && (nextAlert === null || nextAlert <= Date.parse(now))
    ) {
      state.lastAlertAt = now;
      state.nextAlertAt = new Date(Date.parse(now) + policy.alertCooldownMinutes * 60_000).toISOString();
      return { nextState: state, action: 'send_reminder' };
    }
    return { nextState: state, action: 'update_incident' };
  }

  state.consecutiveBreaches = 0;
  state.consecutiveRecoveries = incident ? (previous?.consecutiveRecoveries ?? 0) + 1 : 0;
  if (!incident) {
    state.status = 'meeting';
    state.firstBreachedAt = null;
    state.nextAlertAt = null;
    return { nextState: state, action: 'none' };
  }
  if (state.consecutiveRecoveries < policy.recoveryEvaluations) {
    state.status = 'recovering';
    return { nextState: state, action: 'update_incident' };
  }
  state.status = 'meeting';
  state.firstBreachedAt = null;
  state.lastRecoveredAt = now;
  state.nextAlertAt = null;
  return { nextState: state, action: 'resolve_incident' };
}

export function worseDeliverySloValue(
  comparison: RecommendationDeliverySloComparison,
  current: number | null,
  candidate: number | null,
): number | null {
  if (current === null) return candidate;
  if (candidate === null) return current;
  return comparison === 'minimum' ? Math.min(current, candidate) : Math.max(current, candidate);
}
