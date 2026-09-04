import type {
  DeliveryAnalyticsAttempt,
  DeliveryAnalyticsChannelDefinition,
  DeliveryAnalyticsDispatch,
  DeliveryAnalyticsEvent,
  DeliveryAnalyticsRouteDefinition,
  DeliveryHealth,
  RecommendationDeliveryAnalyticsResponse,
} from './recommendation-delivery-analytics-types.js';

export const DELIVERY_ANALYTICS_SCHEDULER_GRACE_MINUTES = 20;

function timestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value: number, digits = 0): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function percentage(numerator: number, denominator: number): number {
  return denominator > 0 ? Math.round(numerator / denominator * 100) : 0;
}

function percentile(values: number[], percentileValue: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(percentileValue * sorted.length) - 1));
  return round(sorted[index]!, 1);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const result = sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
  return round(result, 1);
}

function dateKey(value: string): string {
  const parsed = timestamp(value);
  return parsed === null ? 'unknown' : new Date(parsed).toISOString().slice(0, 10);
}

function health(attempted: number, delivered: number, failed: number, warnings = 0): DeliveryHealth {
  if (attempted === 0 && warnings === 0) return 'unavailable';
  const success = percentage(delivered, attempted);
  if ((attempted > 0 && success < 80) || failed >= 3) return 'degraded';
  if ((attempted > 0 && success < 95) || failed > 0 || warnings > 0) return 'watch';
  return 'healthy';
}

function eventCount(events: DeliveryAnalyticsEvent[], eventType: DeliveryAnalyticsEvent['eventType']): number {
  return events.filter((event) => event.eventType === eventType).length;
}

function attemptStage(
  attempt: DeliveryAnalyticsAttempt,
  firstPolicyAttemptByDispatch: Map<string, string>,
): 'manual' | 'initial' | 'repeat' | 'escalation' {
  if (attempt.authorizationMode === 'human_confirmation' || !attempt.dispatchId) return 'manual';
  const created = timestamp(attempt.createdAt);
  const escalated = timestamp(attempt.escalatedAt);
  if (
    attempt.kind === 'manager_review'
    && created !== null
    && escalated !== null
    && Math.abs(created - escalated) <= 60 * 60_000
  ) return 'escalation';
  return firstPolicyAttemptByDispatch.get(attempt.dispatchId) === attempt.itemId ? 'initial' : 'repeat';
}

function escalationSla(
  dispatch: DeliveryAnalyticsDispatch,
  windowStart: number,
  windowEnd: number,
): { eligible: boolean; compliant: boolean; breached: boolean; dueAt: number | null } {
  if (dispatch.escalationAfterMinutes === null || !dispatch.firstQueuedAt) {
    return { eligible: false, compliant: false, breached: false, dueAt: null };
  }
  const firstQueued = timestamp(dispatch.firstQueuedAt);
  if (firstQueued === null) return { eligible: false, compliant: false, breached: false, dueAt: null };
  const dueAt = firstQueued + dispatch.escalationAfterMinutes * 60_000;
  const graceAt = dueAt + DELIVERY_ANALYTICS_SCHEDULER_GRACE_MINUTES * 60_000;
  if (dueAt < windowStart || dueAt > windowEnd) {
    return { eligible: false, compliant: false, breached: false, dueAt };
  }
  const resolved = timestamp(dispatch.resolvedAt);
  if (resolved !== null && resolved <= dueAt) {
    return { eligible: false, compliant: false, breached: false, dueAt };
  }
  const escalated = timestamp(dispatch.escalatedAt);
  const compliant = escalated !== null && escalated <= graceAt;
  const breached = !compliant && windowEnd >= graceAt;
  return { eligible: compliant || breached, compliant, breached, dueAt };
}

export function buildRecommendationDeliveryAnalytics(input: {
  generatedAt: string;
  days: number;
  start: string;
  end: string;
  attempts: DeliveryAnalyticsAttempt[];
  events: DeliveryAnalyticsEvent[];
  dispatches: DeliveryAnalyticsDispatch[];
  routes: DeliveryAnalyticsRouteDefinition[];
  channels: DeliveryAnalyticsChannelDefinition[];
  truncated: boolean;
}): RecommendationDeliveryAnalyticsResponse {
  const routeName = new Map(input.routes.map((route) => [route.id, route.name]));
  const channelDefinition = new Map(input.channels.map((channel) => [channel.id, channel]));
  const policyName = new Map<string, { name: string; trigger: 'due_soon' | 'overdue' }>();
  for (const dispatch of input.dispatches) {
    policyName.set(dispatch.policyId, { name: dispatch.policyName, trigger: dispatch.trigger });
  }
  for (const attempt of input.attempts) {
    if (attempt.policyId && attempt.policyName && attempt.trigger) {
      policyName.set(attempt.policyId, { name: attempt.policyName, trigger: attempt.trigger });
    }
  }

  const firstPolicyAttemptByDispatch = new Map<string, string>();
  const sortedPolicyAttempts = input.attempts
    .filter((attempt) => attempt.authorizationMode === 'configured_policy' && attempt.dispatchId)
    .sort((left, right) => (timestamp(left.createdAt) ?? 0) - (timestamp(right.createdAt) ?? 0));
  for (const attempt of sortedPolicyAttempts) {
    if (!firstPolicyAttemptByDispatch.has(attempt.dispatchId!)) {
      firstPolicyAttemptByDispatch.set(attempt.dispatchId!, attempt.itemId);
    }
  }
  const stageByItem = new Map(input.attempts.map((attempt) => [
    attempt.itemId,
    attemptStage(attempt, firstPolicyAttemptByDispatch),
  ]));

  const terminalStatuses = new Set(['delivered', 'partially_failed', 'failed']);
  const attemptedItems = input.attempts.filter((attempt) => terminalStatuses.has(attempt.itemStatus));
  const deliveredItems = attemptedItems.filter((attempt) => attempt.itemStatus === 'delivered');
  const partiallyFailedItems = attemptedItems.filter((attempt) => attempt.itemStatus === 'partially_failed');
  const failedItems = attemptedItems.filter((attempt) => attempt.itemStatus === 'failed');
  const uniqueBatches = new Map(input.attempts.map((attempt) => [attempt.batchId, attempt]));
  const completionMinutes = [...uniqueBatches.values()].flatMap((attempt) => {
    const queued = timestamp(attempt.confirmedAt ?? attempt.createdAt);
    const completed = timestamp(attempt.completedAt);
    return queued !== null && completed !== null && completed >= queued
      ? [round((completed - queued) / 60_000, 1)]
      : [];
  });

  const startMs = timestamp(input.start) ?? 0;
  const endMs = timestamp(input.end) ?? Date.now();
  const slaByDispatch = new Map(input.dispatches.map((dispatch) => [
    dispatch.id,
    escalationSla(dispatch, startMs, endMs),
  ]));
  const slaEligible = [...slaByDispatch.values()].filter((result) => result.eligible);
  const slaCompliant = slaEligible.filter((result) => result.compliant);
  const slaBreached = slaEligible.filter((result) => result.breached);

  type ChannelAggregate = {
    channelId: string;
    channelName: string;
    channelType: DeliveryAnalyticsChannelDefinition['type'];
    attempted: number;
    delivered: number;
    failed: number;
    lastDeliveryAt: string | null;
  };
  const channelAggregates = new Map<string, ChannelAggregate>();
  type RouteAggregate = {
    routeId: string;
    routeName: string;
    attemptedChannels: number;
    deliveredChannels: number;
    failedChannels: number;
    lastDeliveryAt: string | null;
  };
  const routeAggregates = new Map<string, RouteAggregate>();
  const recentFailures: RecommendationDeliveryAnalyticsResponse['recentFailures'] = [];
  const seenChannelAttempts = new Set<string>();
  const seenRouteAttempts = new Set<string>();

  for (const attempt of input.attempts) {
    const occurredAt = attempt.completedAt ?? attempt.createdAt;
    for (const result of attempt.channelResults) {
      const channelKey = `${attempt.batchId}:${attempt.itemId}:${result.channelId}`;
      if (!seenChannelAttempts.has(channelKey)) {
        seenChannelAttempts.add(channelKey);
        const definition = channelDefinition.get(result.channelId);
        const aggregate = channelAggregates.get(result.channelId) ?? {
          channelId: result.channelId,
          channelName: definition?.name ?? result.channelName ?? result.channelId,
          channelType: definition?.type ?? result.channelType,
          attempted: 0,
          delivered: 0,
          failed: 0,
          lastDeliveryAt: null,
        };
        aggregate.attempted += 1;
        if (result.status === 'delivered') aggregate.delivered += 1;
        else aggregate.failed += 1;
        if (!aggregate.lastDeliveryAt || (timestamp(occurredAt) ?? 0) > (timestamp(aggregate.lastDeliveryAt) ?? 0)) {
          aggregate.lastDeliveryAt = occurredAt;
        }
        channelAggregates.set(result.channelId, aggregate);
      }
      for (const routeId of attempt.routeIds) {
        const routeKey = `${attempt.batchId}:${attempt.itemId}:${routeId}:${result.channelId}`;
        if (seenRouteAttempts.has(routeKey)) continue;
        seenRouteAttempts.add(routeKey);
        const aggregate = routeAggregates.get(routeId) ?? {
          routeId,
          routeName: routeName.get(routeId) ?? routeId,
          attemptedChannels: 0,
          deliveredChannels: 0,
          failedChannels: 0,
          lastDeliveryAt: null,
        };
        aggregate.attemptedChannels += 1;
        if (result.status === 'delivered') aggregate.deliveredChannels += 1;
        else aggregate.failedChannels += 1;
        if (!aggregate.lastDeliveryAt || (timestamp(occurredAt) ?? 0) > (timestamp(aggregate.lastDeliveryAt) ?? 0)) {
          aggregate.lastDeliveryAt = occurredAt;
        }
        routeAggregates.set(routeId, aggregate);
      }
      if (result.status === 'failed') {
        recentFailures.push({
          batchId: attempt.batchId,
          recommendationId: attempt.recommendationId,
          dealId: attempt.dealId,
          channelId: result.channelId || null,
          channelName: result.channelName || result.channelId || 'Unknown channel',
          channelType: result.channelType ?? null,
          policyId: attempt.policyId,
          policyName: attempt.policyName,
          occurredAt,
          error: (result.error ?? 'Delivery failed without a recorded provider reason.').slice(0, 500),
        });
      }
    }
  }

  const quietByRoute = new Map<string, number>();
  const unavailableByRoute = new Map<string, number>();
  for (const event of input.events) {
    if (!event.routeId) continue;
    if (event.eventType === 'quiet_hours_deferred') {
      quietByRoute.set(event.routeId, (quietByRoute.get(event.routeId) ?? 0) + 1);
    }
    if (event.eventType === 'route_unavailable') {
      unavailableByRoute.set(event.routeId, (unavailableByRoute.get(event.routeId) ?? 0) + 1);
    }
  }

  const routes = new Set([
    ...routeAggregates.keys(),
    ...quietByRoute.keys(),
    ...unavailableByRoute.keys(),
  ]);
  const routeResults = [...routes].map((routeId) => {
    const aggregate = routeAggregates.get(routeId) ?? {
      routeId,
      routeName: routeName.get(routeId) ?? routeId,
      attemptedChannels: 0,
      deliveredChannels: 0,
      failedChannels: 0,
      lastDeliveryAt: null,
    };
    const warnings = (quietByRoute.get(routeId) ?? 0) + (unavailableByRoute.get(routeId) ?? 0);
    return {
      ...aggregate,
      deliverySuccessPercent: percentage(aggregate.deliveredChannels, aggregate.attemptedChannels),
      quietHourDeferrals: quietByRoute.get(routeId) ?? 0,
      routeUnavailable: unavailableByRoute.get(routeId) ?? 0,
      health: health(aggregate.attemptedChannels, aggregate.deliveredChannels, aggregate.failedChannels, warnings),
    };
  }).sort((left, right) => {
    const rank: Record<DeliveryHealth, number> = { degraded: 0, watch: 1, healthy: 2, unavailable: 3 };
    return rank[left.health] - rank[right.health]
      || right.failedChannels - left.failedChannels
      || right.attemptedChannels - left.attemptedChannels;
  });

  const channelResults = [...channelAggregates.values()].map((aggregate) => ({
    ...aggregate,
    deliverySuccessPercent: percentage(aggregate.delivered, aggregate.attempted),
    health: health(aggregate.attempted, aggregate.delivered, aggregate.failed),
  })).sort((left, right) => {
    const rank: Record<DeliveryHealth, number> = { degraded: 0, watch: 1, healthy: 2, unavailable: 3 };
    return rank[left.health] - rank[right.health]
      || right.failed - left.failed
      || right.attempted - left.attempted;
  });

  const policyIds = new Set([
    ...input.attempts.flatMap((attempt) => attempt.policyId ? [attempt.policyId] : []),
    ...input.events.flatMap((event) => event.policyId ? [event.policyId] : []),
    ...input.dispatches.map((dispatch) => dispatch.policyId),
  ]);
  const policyResults = [...policyIds].map((policyId) => {
    const attempts = input.attempts.filter((attempt) => attempt.policyId === policyId);
    const terminal = attempts.filter((attempt) => terminalStatuses.has(attempt.itemStatus));
    const delivered = terminal.filter((attempt) => attempt.itemStatus === 'delivered').length;
    const failed = terminal.filter((attempt) => attempt.itemStatus === 'failed' || attempt.itemStatus === 'partially_failed').length;
    const events = input.events.filter((event) => event.policyId === policyId);
    const dispatches = input.dispatches.filter((dispatch) => dispatch.policyId === policyId);
    const primary = attempts.filter((attempt) => stageByItem.get(attempt.itemId) === 'initial').length;
    const repeat = attempts.filter((attempt) => stageByItem.get(attempt.itemId) === 'repeat').length;
    const escalation = attempts.filter((attempt) => stageByItem.get(attempt.itemId) === 'escalation').length;
    const sla = dispatches.map((dispatch) => slaByDispatch.get(dispatch.id)!)
      .filter((result) => result.eligible);
    const firstQueueMinutes = dispatches.flatMap((dispatch) => {
      const matched = timestamp(dispatch.firstMatchedAt);
      const queued = timestamp(dispatch.firstQueuedAt);
      return matched !== null && queued !== null && queued >= matched
        ? [round((queued - matched) / 60_000, 1)]
        : [];
    });
    const quiet = eventCount(events, 'quiet_hours_deferred');
    const cooldown = eventCount(events, 'cooldown_suppressed');
    const limited = eventCount(events, 'notification_limit_suppressed');
    const unavailable = eventCount(events, 'route_unavailable');
    const warnings = quiet + cooldown + limited + unavailable + sla.filter((result) => result.breached).length;
    const identity = policyName.get(policyId) ?? { name: policyId, trigger: 'overdue' as const };
    return {
      policyId,
      policyName: identity.name,
      trigger: identity.trigger,
      matched: eventCount(events, 'policy_matched'),
      primaryQueued: primary,
      repeatQueued: repeat,
      escalationQueued: escalation,
      attemptedItems: terminal.length,
      deliveredItems: delivered,
      failedItems: failed,
      deliverySuccessPercent: percentage(delivered, terminal.length),
      quietHourDeferrals: quiet,
      cooldownSuppressions: cooldown,
      notificationLimitSuppressions: limited,
      routeUnavailable: unavailable,
      escalationSlaEligible: sla.length,
      escalationSlaCompliant: sla.filter((result) => result.compliant).length,
      escalationSlaBreached: sla.filter((result) => result.breached).length,
      escalationSlaCompliancePercent: percentage(sla.filter((result) => result.compliant).length, sla.length),
      medianFirstQueueMinutes: median(firstQueueMinutes),
      health: health(terminal.length, delivered, failed, warnings),
    };
  }).sort((left, right) => {
    const rank: Record<DeliveryHealth, number> = { degraded: 0, watch: 1, healthy: 2, unavailable: 3 };
    return rank[left.health] - rank[right.health]
      || right.escalationSlaBreached - left.escalationSlaBreached
      || right.failedItems - left.failedItems;
  });

  const timeline = new Map<string, RecommendationDeliveryAnalyticsResponse['timeline'][number]>();
  const day = (date: string) => {
    const key = dateKey(date);
    const existing = timeline.get(key) ?? {
      date: key,
      attemptedItems: 0,
      deliveredItems: 0,
      failedItems: 0,
      escalationsQueued: 0,
      quietHourDeferrals: 0,
      cooldownSuppressions: 0,
    };
    timeline.set(key, existing);
    return existing;
  };
  for (const attempt of attemptedItems) {
    const item = day(attempt.completedAt ?? attempt.createdAt);
    item.attemptedItems += 1;
    if (attempt.itemStatus === 'delivered') item.deliveredItems += 1;
    if (attempt.itemStatus === 'failed' || attempt.itemStatus === 'partially_failed') item.failedItems += 1;
    if (stageByItem.get(attempt.itemId) === 'escalation') item.escalationsQueued += 1;
  }
  for (const event of input.events) {
    const item = day(event.eventAt);
    if (event.eventType === 'quiet_hours_deferred') item.quietHourDeferrals += 1;
    if (event.eventType === 'cooldown_suppressed') item.cooldownSuppressions += 1;
  }

  const attemptsWithChannelEvidence = attemptedItems.filter((attempt) => attempt.channelResults.length > 0).length;
  return {
    generatedAt: input.generatedAt,
    methodology: 'deterministic_recommendation_delivery_analytics_v1',
    window: { days: input.days, start: input.start, end: input.end },
    summary: {
      batches: uniqueBatches.size,
      manualBatches: [...uniqueBatches.values()].filter((attempt) => attempt.authorizationMode === 'human_confirmation').length,
      policyBatches: [...uniqueBatches.values()].filter((attempt) => attempt.authorizationMode === 'configured_policy').length,
      attemptedItems: attemptedItems.length,
      deliveredItems: deliveredItems.length,
      partiallyFailedItems: partiallyFailedItems.length,
      failedItems: failedItems.length,
      deliverySuccessPercent: percentage(deliveredItems.length, attemptedItems.length),
      medianCompletionMinutes: median(completionMinutes),
      p95CompletionMinutes: percentile(completionMinutes, .95),
      primaryQueued: input.attempts.filter((attempt) => stageByItem.get(attempt.itemId) === 'initial').length,
      repeatQueued: input.attempts.filter((attempt) => stageByItem.get(attempt.itemId) === 'repeat').length,
      escalationQueued: input.attempts.filter((attempt) => stageByItem.get(attempt.itemId) === 'escalation').length,
      escalationSlaEligible: slaEligible.length,
      escalationSlaCompliant: slaCompliant.length,
      escalationSlaBreached: slaBreached.length,
      escalationSlaCompliancePercent: percentage(slaCompliant.length, slaEligible.length),
      quietHourDeferrals: eventCount(input.events, 'quiet_hours_deferred'),
      cooldownSuppressions: eventCount(input.events, 'cooldown_suppressed'),
      notificationLimitSuppressions: eventCount(input.events, 'notification_limit_suppressed'),
      routeUnavailable: eventCount(input.events, 'route_unavailable'),
      resolvedDispatches: eventCount(input.events, 'dispatch_resolved'),
    },
    policies: policyResults,
    routes: routeResults,
    channels: channelResults,
    timeline: [...timeline.values()].filter((item) => item.date !== 'unknown').sort((left, right) => left.date.localeCompare(right.date)),
    recentFailures: recentFailures
      .sort((left, right) => (timestamp(right.occurredAt) ?? 0) - (timestamp(left.occurredAt) ?? 0))
      .slice(0, 25),
    coverage: {
      loadedAttempts: input.attempts.length,
      loadedEvents: input.events.length,
      loadedDispatches: input.dispatches.length,
      completedAttemptPercent: percentage(attemptedItems.length, input.attempts.length),
      channelEvidencePercent: percentage(attemptsWithChannelEvidence, attemptedItems.length),
      truncated: input.truncated,
    },
    limitations: [
      'Delivery success measures notification transport evidence. It does not measure whether a deal progressed or whether a recommendation was correct.',
      'Escalation SLA compliance uses the configured escalation threshold plus a 20-minute scheduler allowance for the 15-minute maintenance cadence.',
      'Quiet-hour, cooldown, notification-cap, and route-unavailable counts are deduplicated operational observations rather than raw evaluator invocations.',
      'A shared channel can be attributed to more than one matching route; channel totals remain deduplicated by batch, recommendation item, and channel.',
      input.truncated ? 'The response reached a bounded evidence limit; older rows in the selected window may be omitted.' : 'The selected evidence window remained within the configured query bounds.',
    ],
    semantics: {
      operationalDeliveryOnly: true,
      notDealOutcome: true,
      noCausalAttribution: true,
      noCrmMutation: true,
      escalationSlaUsesConfiguredThreshold: true,
      schedulerGraceMinutes: DELIVERY_ANALYTICS_SCHEDULER_GRACE_MINUTES,
      suppressionCountsAreDeduplicatedOperationalEvents: true,
    },
  };
}
