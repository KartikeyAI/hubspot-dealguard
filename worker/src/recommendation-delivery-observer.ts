import { loadFollowupRoutingState } from './recommendation-followup-delivery.js';
import { routingMatch } from './recommendation-operations-model.js';
import type { RecommendationFollowupScope } from './recommendation-operations-types.js';
import {
  evaluateRecommendationPolicyMatch,
  nextPolicyDispatchStage,
  policyEventType,
  type RecommendationPolicyDispatchState,
} from './recommendation-routing-policy-model.js';
import type { RecommendationRoutingPolicyRow } from './recommendation-routing-policies.js';
import type { RecommendationRoutingPolicy } from './recommendation-routing-policy-types.js';
import {
  mapRecommendation,
  RECOMMENDATION_SELECT,
  type RecommendationRow,
} from './recommendation-outcome-storage.js';
import type { RecommendationDeliveryEventType } from './recommendation-delivery-analytics-types.js';
import type { Env } from './types.js';

const MAX_POLICIES = 500;
const MAX_RECOMMENDATIONS_PER_PORTAL = 5000;
const MAX_EVENTS_PER_RUN = 10_000;
const EVENT_RETENTION_DAYS = 400;

interface DispatchRow extends Record<string, unknown> {
  id: string;
  portal_id: string;
  policy_id: string;
  recommendation_id: string;
  state: 'active' | 'resolved';
  first_matched_at: string;
  first_queued_at: string | null;
  last_queued_at: string | null;
  next_eligible_at: string | null;
  notification_count: number;
  escalation_count: number;
  escalated_at: string | null;
  resolved_at: string | null;
}

interface EventInput {
  portalId: string;
  eventType: RecommendationDeliveryEventType;
  policyId: string | null;
  dispatchId: string | null;
  recommendationId: string | null;
  routeId: string | null;
  stage: 'initial' | 'repeat' | 'escalation' | null;
  reasonCode: string;
  severity: 'info' | 'warning' | 'critical' | null;
  eventAt: string;
  recommendationDueAt: string | null;
  slaDueAt: string | null;
  scope: RecommendationFollowupScope;
  dedupeKey: string;
  metadata: Record<string, unknown>;
}

export interface RecommendationDeliveryObservationSummary {
  evaluatedPolicies: number;
  matchedRecommendations: number;
  quietHourDeferrals: number;
  cooldownSuppressions: number;
  notificationLimitSuppressions: number;
  routeUnavailable: number;
  resolvedDispatches: number;
  eventCandidates: number;
  truncated: boolean;
}

function parseStrings(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim().slice(0, 128)))]
      : [];
  } catch {
    return [];
  }
}

function policyFromRow(row: RecommendationRoutingPolicyRow): RecommendationRoutingPolicy {
  return {
    id: row.id,
    name: row.name,
    trigger: row.trigger_kind,
    statusScope: row.status_scope,
    minimumPriority: row.minimum_priority,
    thresholdMinutes: Number(row.threshold_minutes),
    cooldownMinutes: Number(row.cooldown_minutes),
    maxNotifications: Number(row.max_notifications),
    severity: row.severity,
    routeId: row.route_id,
    escalationRouteId: row.escalation_route_id,
    escalationAfterMinutes: row.escalation_after_minutes === null ? null : Number(row.escalation_after_minutes),
    managerNote: row.manager_note,
    scope: {
      pipelineIds: parseStrings(row.pipeline_ids_json),
      teamIds: parseStrings(row.team_ids_json),
      ownerIds: parseStrings(row.owner_ids_json),
      regionCodes: parseStrings(row.region_codes_json),
    },
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastEvaluatedAt: row.last_evaluated_at,
    lastMatchCount: Number(row.last_match_count ?? 0),
    lastQueueCount: Number(row.last_queue_count ?? 0),
    lastError: row.last_error,
    dispatchSummary: { active: 0, queued: 0, delivered: 0, failed: 0, escalated: 0 },
  };
}

function dispatchState(row: DispatchRow | null): RecommendationPolicyDispatchState | null {
  if (!row) return null;
  return {
    notificationCount: Number(row.notification_count ?? 0),
    escalationCount: Number(row.escalation_count ?? 0),
    firstQueuedAt: row.first_queued_at,
    lastQueuedAt: row.last_queued_at,
    nextEligibleAt: row.next_eligible_at,
    escalatedAt: row.escalated_at,
    resolvedAt: row.resolved_at,
  };
}

function recommendationScope(recommendation: ReturnType<typeof mapRecommendation>): RecommendationFollowupScope {
  return {
    pipelineId: recommendation.baseline.pipelineId,
    teamId: recommendation.baseline.teamId,
    ownerId: recommendation.baseline.ownerId,
    regionCode: recommendation.baseline.regionCode,
  };
}

function dayBucket(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function escalationDueAt(policy: RecommendationRoutingPolicy, dispatch: DispatchRow | null): string | null {
  if (!dispatch?.first_queued_at || policy.escalationAfterMinutes === null) return null;
  const queued = Date.parse(dispatch.first_queued_at);
  return Number.isFinite(queued)
    ? new Date(queued + policy.escalationAfterMinutes * 60_000).toISOString()
    : null;
}

function eventStatement(env: Env, event: EventInput) {
  const createdAt = new Date().toISOString();
  return env.DB.prepare(
    `INSERT INTO recommendation_delivery_events (
      id, portal_id, event_type, authorization_mode,
      policy_id, dispatch_id, recommendation_id, route_id, stage,
      reason_code, severity, event_at, recommendation_due_at, sla_due_at,
      pipeline_id, team_id, owner_id, region_code,
      dedupe_key, metadata_json, created_at
    ) VALUES (?, ?, ?, 'configured_policy', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(portal_id, dedupe_key) DO NOTHING`,
  ).bind(
    crypto.randomUUID(),
    event.portalId,
    event.eventType,
    event.policyId,
    event.dispatchId,
    event.recommendationId,
    event.routeId,
    event.stage,
    event.reasonCode,
    event.severity,
    event.eventAt,
    event.recommendationDueAt,
    event.slaDueAt,
    event.scope.pipelineId,
    event.scope.teamId,
    event.scope.ownerId,
    event.scope.regionCode,
    event.dedupeKey.slice(0, 500),
    JSON.stringify(event.metadata).slice(0, 8000),
    createdAt,
  );
}

async function insertEvents(env: Env, events: EventInput[]): Promise<void> {
  for (let offset = 0; offset < events.length; offset += 100) {
    await env.DB.batch(events.slice(offset, offset + 100).map((event) => eventStatement(env, event)));
  }
}

export async function observeRecommendationDeliveryControls(
  env: Env,
  portalId?: string,
): Promise<RecommendationDeliveryObservationSummary> {
  const now = new Date();
  const nowIso = now.toISOString();
  const cutoff = new Date(now.getTime() - EVENT_RETENTION_DAYS * 86_400_000).toISOString();
  await env.DB.prepare(
    `DELETE FROM recommendation_delivery_events
     WHERE event_at < ? ${portalId ? 'AND portal_id = ?' : ''}`,
  ).bind(...(portalId ? [cutoff, portalId] : [cutoff])).run();

  const policyRows = await env.DB.prepare(
    `SELECT * FROM recommendation_routing_policies
     WHERE enabled = 1 ${portalId ? 'AND portal_id = ?' : ''}
     ORDER BY portal_id, updated_at ASC
     LIMIT ?`,
  ).bind(...(portalId ? [portalId, MAX_POLICIES] : [MAX_POLICIES]))
    .all<RecommendationRoutingPolicyRow>();
  const policiesByPortal = new Map<string, RecommendationRoutingPolicyRow[]>();
  for (const row of policyRows.results ?? []) {
    const group = policiesByPortal.get(row.portal_id) ?? [];
    group.push(row);
    policiesByPortal.set(row.portal_id, group);
  }

  const events: EventInput[] = [];
  const summary: RecommendationDeliveryObservationSummary = {
    evaluatedPolicies: 0,
    matchedRecommendations: 0,
    quietHourDeferrals: 0,
    cooldownSuppressions: 0,
    notificationLimitSuppressions: 0,
    routeUnavailable: 0,
    resolvedDispatches: 0,
    eventCandidates: 0,
    truncated: false,
  };

  const add = (event: EventInput) => {
    if (events.length >= MAX_EVENTS_PER_RUN) {
      summary.truncated = true;
      return;
    }
    events.push(event);
  };

  for (const [currentPortalId, policyGroup] of policiesByPortal.entries()) {
    const [recommendationRows, dispatchRows, routingState] = await Promise.all([
      env.DB.prepare(
        `${RECOMMENDATION_SELECT}
         WHERE recommendation.portal_id = ?
           AND recommendation.status IN ('presented', 'accepted')
         ORDER BY recommendation.last_presented_at DESC
         LIMIT ?`,
      ).bind(currentPortalId, MAX_RECOMMENDATIONS_PER_PORTAL).all<RecommendationRow>(),
      env.DB.prepare(
        `SELECT * FROM recommendation_policy_dispatches
         WHERE portal_id = ? AND policy_id IN (${policyGroup.map(() => '?').join(', ')})`,
      ).bind(currentPortalId, ...policyGroup.map((policy) => policy.id)).all<DispatchRow>(),
      loadFollowupRoutingState(env, currentPortalId, now),
    ]);
    const recommendations = (recommendationRows.results ?? []).map((row) => ({ row, recommendation: mapRecommendation(row) }));
    const dispatches = dispatchRows.results ?? [];
    const dispatchByKey = new Map(dispatches.map((dispatch) => [
      `${dispatch.policy_id}:${dispatch.recommendation_id}`,
      dispatch,
    ]));

    for (const dispatch of dispatches) {
      if (!dispatch.resolved_at) continue;
      const recommendation = recommendations.find((item) => item.recommendation.id === dispatch.recommendation_id)?.recommendation;
      const scope = recommendation ? recommendationScope(recommendation) : {
        pipelineId: null, teamId: null, ownerId: null, regionCode: null,
      };
      add({
        portalId: currentPortalId,
        eventType: 'dispatch_resolved',
        policyId: dispatch.policy_id,
        dispatchId: dispatch.id,
        recommendationId: dispatch.recommendation_id,
        routeId: null,
        stage: null,
        reasonCode: 'recommendation_no_longer_matches',
        severity: 'info',
        eventAt: dispatch.resolved_at,
        recommendationDueAt: recommendation?.dueAt ?? null,
        slaDueAt: null,
        scope,
        dedupeKey: `dispatch-resolved:${dispatch.id}:${dispatch.resolved_at}`,
        metadata: { state: dispatch.state },
      });
      summary.resolvedDispatches += 1;
    }

    for (const policyRow of policyGroup) {
      summary.evaluatedPolicies += 1;
      const policy = policyFromRow(policyRow);
      for (const { recommendation } of recommendations) {
        const match = evaluateRecommendationPolicyMatch(policy, recommendation, now.getTime());
        if (!match.matched) continue;
        summary.matchedRecommendations += 1;
        const dispatch = dispatchByKey.get(`${policy.id}:${recommendation.id}`) ?? null;
        const scope = recommendationScope(recommendation);
        add({
          portalId: currentPortalId,
          eventType: 'policy_matched',
          policyId: policy.id,
          dispatchId: dispatch?.id ?? null,
          recommendationId: recommendation.id,
          routeId: policy.routeId,
          stage: dispatch?.notification_count ? 'repeat' : 'initial',
          reasonCode: policy.trigger,
          severity: policy.severity,
          eventAt: dispatch?.first_matched_at ?? nowIso,
          recommendationDueAt: recommendation.dueAt,
          slaDueAt: null,
          scope,
          dedupeKey: `policy-matched:${policy.id}:${recommendation.id}`,
          metadata: {
            policyName: policy.name,
            trigger: policy.trigger,
            matchReason: match.reason,
            minutesFromDue: match.minutesFromDue,
          },
        });

        const state = dispatchState(dispatch);
        const stage = nextPolicyDispatchStage(policy, state, now.getTime());
        if (!stage) {
          if (dispatch && Number(dispatch.notification_count) >= policy.maxNotifications) {
            add({
              portalId: currentPortalId,
              eventType: 'notification_limit_suppressed',
              policyId: policy.id,
              dispatchId: dispatch.id,
              recommendationId: recommendation.id,
              routeId: policy.routeId,
              stage: 'repeat',
              reasonCode: 'maximum_notification_count_reached',
              severity: policy.severity,
              eventAt: nowIso,
              recommendationDueAt: recommendation.dueAt,
              slaDueAt: null,
              scope,
              dedupeKey: `notification-limit:${dispatch.id}:${policy.maxNotifications}`,
              metadata: { notificationCount: dispatch.notification_count, maxNotifications: policy.maxNotifications },
            });
            summary.notificationLimitSuppressions += 1;
          } else if (dispatch?.next_eligible_at && Date.parse(dispatch.next_eligible_at) > now.getTime()) {
            add({
              portalId: currentPortalId,
              eventType: 'cooldown_suppressed',
              policyId: policy.id,
              dispatchId: dispatch.id,
              recommendationId: recommendation.id,
              routeId: policy.routeId,
              stage: 'repeat',
              reasonCode: 'cooldown_active',
              severity: policy.severity,
              eventAt: nowIso,
              recommendationDueAt: recommendation.dueAt,
              slaDueAt: null,
              scope,
              dedupeKey: `cooldown:${dispatch.id}:${dispatch.next_eligible_at}`,
              metadata: { nextEligibleAt: dispatch.next_eligible_at },
            });
            summary.cooldownSuppressions += 1;
          }
          continue;
        }

        const routeId = stage === 'escalation' ? policy.escalationRouteId : policy.routeId;
        const dueAt = stage === 'escalation' ? escalationDueAt(policy, dispatch) : null;
        if (!routeId) {
          add({
            portalId: currentPortalId,
            eventType: 'route_unavailable',
            policyId: policy.id,
            dispatchId: dispatch?.id ?? null,
            recommendationId: recommendation.id,
            routeId: null,
            stage,
            reasonCode: 'route_not_configured',
            severity: stage === 'escalation' ? 'critical' : policy.severity,
            eventAt: nowIso,
            recommendationDueAt: recommendation.dueAt,
            slaDueAt: dueAt,
            scope,
            dedupeKey: `route-unavailable:${policy.id}:${recommendation.id}:${stage}:none:${dayBucket(now)}`,
            metadata: { policyName: policy.name },
          });
          summary.routeUnavailable += 1;
          continue;
        }
        if (routingState.quietRouteIds.has(routeId)) {
          add({
            portalId: currentPortalId,
            eventType: 'quiet_hours_deferred',
            policyId: policy.id,
            dispatchId: dispatch?.id ?? null,
            recommendationId: recommendation.id,
            routeId,
            stage,
            reasonCode: 'business_calendar_quiet_hours',
            severity: stage === 'escalation' ? 'critical' : policy.severity,
            eventAt: nowIso,
            recommendationDueAt: recommendation.dueAt,
            slaDueAt: dueAt,
            scope,
            dedupeKey: `quiet-hours:${policy.id}:${recommendation.id}:${stage}:${routeId}:${dayBucket(now)}`,
            metadata: { policyName: policy.name, trigger: policy.trigger },
          });
          summary.quietHourDeferrals += 1;
          continue;
        }
        const eventType = policyEventType(policy.trigger, stage);
        const routing = await routingMatch({
          routes: routingState.routes.filter((route) => route.id === routeId),
          channels: routingState.channelSummaries,
          quietRouteIds: routingState.quietRouteIds,
          scope,
          severity: stage === 'escalation' ? 'critical' : policy.severity,
          recommendationId: recommendation.id,
          recommendationStatus: recommendation.status,
          priority: recommendation.priority,
          dueAt: recommendation.dueAt,
          kind: stage === 'escalation' ? 'manager_review' : 'owner_reminder',
          managerNote: policy.managerNote,
          eventType,
        });
        if (!routing.ready) {
          add({
            portalId: currentPortalId,
            eventType: 'route_unavailable',
            policyId: policy.id,
            dispatchId: dispatch?.id ?? null,
            recommendationId: recommendation.id,
            routeId,
            stage,
            reasonCode: 'route_disabled_unsubscribed_or_channel_unavailable',
            severity: stage === 'escalation' ? 'critical' : policy.severity,
            eventAt: nowIso,
            recommendationDueAt: recommendation.dueAt,
            slaDueAt: dueAt,
            scope,
            dedupeKey: `route-unavailable:${policy.id}:${recommendation.id}:${stage}:${routeId}:${dayBucket(now)}`,
            metadata: { policyName: policy.name, eventType },
          });
          summary.routeUnavailable += 1;
        }
      }
    }
  }

  await insertEvents(env, events);
  summary.eventCandidates = events.length;
  return summary;
}
