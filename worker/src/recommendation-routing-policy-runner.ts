import { loadFollowupRoutingState } from './recommendation-followup-delivery.js';
import { routingMatch } from './recommendation-operations-model.js';
import type { RecommendationFollowupRoutingMatch, RecommendationFollowupScope } from './recommendation-operations-types.js';
import {
  effectivePolicyCooldownMinutes,
  evaluateRecommendationPolicyMatch,
  nextPolicyDispatchStage,
  policyEventType,
  policyNextEligibleAt,
  type RecommendationPolicyDispatchState,
} from './recommendation-routing-policy-model.js';
import {
  policyFromRow,
  type RecommendationRoutingPolicyRow,
} from './recommendation-routing-policies.js';
import type {
  RecommendationPolicyDispatchStage,
  RecommendationRoutingPolicy,
} from './recommendation-routing-policy-types.js';
import {
  mapRecommendation,
  RECOMMENDATION_SELECT,
  type RecommendationRow,
} from './recommendation-outcome-storage.js';
import { wakeDeliveryQueue } from './queue-publisher.js';
import { Repository } from './repository.js';
import type { Env } from './types.js';

const MAX_POLICIES_PER_RUN = 500;
const MAX_RECOMMENDATIONS_PER_PORTAL = 5000;
const MAX_ITEMS_PER_POLICY_BATCH = 100;

interface DispatchRow extends Record<string, unknown> {
  id: string;
  policy_id: string;
  recommendation_id: string;
  notification_count: number;
  escalation_count: number;
  first_matched_at: string;
  first_queued_at: string | null;
  last_queued_at: string | null;
  next_eligible_at: string | null;
  escalated_at: string | null;
  resolved_at: string | null;
}

interface QueueCandidate {
  row: RecommendationRow;
  recommendation: ReturnType<typeof mapRecommendation>;
  dispatch: DispatchRow | null;
  dispatchId: string;
  stage: RecommendationPolicyDispatchStage;
  eventType: string;
  routing: RecommendationFollowupRoutingMatch;
  cooldownMinutes: number;
}

export interface RecommendationPolicyRunSummary {
  evaluatedPolicies: number;
  matchedRecommendations: number;
  queuedBatches: number;
  queuedRecommendations: number;
  routeUnavailable: number;
  errors: number;
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

function routingSummary(
  eventType: string,
  candidates: QueueCandidate[],
): Record<string, unknown> {
  const routes = new Map<string, RecommendationFollowupRoutingMatch['routes'][number]>();
  const items: Record<string, RecommendationFollowupRoutingMatch> = {};
  for (const candidate of candidates) {
    items[candidate.recommendation.id] = candidate.routing;
    for (const route of candidate.routing.routes) routes.set(route.id, route);
  }
  return {
    eventType,
    authorizationMode: 'configured_policy',
    explicitRouteOptInRequired: true,
    routes: [...routes.values()],
    items,
  };
}

async function updateResolvedDispatches(
  env: Env,
  portalId: string,
  policyId: string,
  matchedIds: string[],
  now: string,
): Promise<void> {
  if (matchedIds.length === 0) {
    await env.DB.prepare(
      `UPDATE recommendation_policy_dispatches
       SET state = 'resolved', resolved_at = COALESCE(resolved_at, ?), updated_at = ?
       WHERE portal_id = ? AND policy_id = ? AND state = 'active'`,
    ).bind(now, now, portalId, policyId).run();
    return;
  }
  await env.DB.prepare(
    `UPDATE recommendation_policy_dispatches
     SET state = 'resolved', resolved_at = COALESCE(resolved_at, ?), updated_at = ?
     WHERE portal_id = ? AND policy_id = ? AND state = 'active'
       AND recommendation_id NOT IN (${matchedIds.map(() => '?').join(', ')})`,
  ).bind(now, now, portalId, policyId, ...matchedIds).run();
}

async function queuePolicyBatch(
  env: Env,
  policy: RecommendationRoutingPolicy,
  policyRow: RecommendationRoutingPolicyRow,
  stage: RecommendationPolicyDispatchStage,
  candidates: QueueCandidate[],
): Promise<string | null> {
  if (candidates.length === 0) return null;
  const batchId = crypto.randomUUID();
  const now = new Date().toISOString();
  const eventType = candidates[0]!.eventType;
  const severity = stage === 'escalation' ? 'critical' : policy.severity;
  const kind = stage === 'escalation' ? 'manager_review' : 'owner_reminder';
  const summary = routingSummary(eventType, candidates);
  const statements = [
    env.DB.prepare(
      `INSERT INTO recommendation_followup_batches (
        id, portal_id, kind, severity, manager_note, authorization_mode, automation_policy_id,
        status, requested_count, eligible_count, delivery_ready_count, confirmed_count,
        routing_summary_json, preview_expires_at,
        created_by_user_id, created_by_email, confirmed_by_user_id, confirmed_by_email,
        confirmed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'configured_policy', ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      batchId,
      policyRow.portal_id,
      kind,
      severity,
      policy.managerNote,
      policy.id,
      candidates.length,
      candidates.length,
      candidates.length,
      candidates.length,
      JSON.stringify(summary),
      now,
      policyRow.created_by_user_id,
      policyRow.created_by_email,
      policyRow.updated_by_user_id ?? policyRow.created_by_user_id,
      policyRow.updated_by_email ?? policyRow.created_by_email,
      now,
      now,
      now,
    ),
  ];
  for (const candidate of candidates) {
    const recommendation = candidate.recommendation;
    statements.push(
      env.DB.prepare(
        `INSERT INTO recommendation_followup_items (
          id, portal_id, batch_id, recommendation_id, policy_dispatch_id, deal_id,
          recommendation_code, recommendation_label, recommendation_text, recommendation_status,
          priority, due_at, pipeline_id, team_id, owner_id, region_code,
          matched_route_ids_json, matched_channel_ids_json, routing_fingerprint,
          status, ineligibility_reason, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        policyRow.portal_id,
        batchId,
        recommendation.id,
        candidate.dispatchId,
        recommendation.dealId,
        recommendation.recommendationCode,
        recommendation.label,
        recommendation.action,
        recommendation.status,
        recommendation.priority,
        recommendation.dueAt,
        recommendation.baseline.pipelineId,
        recommendation.baseline.teamId,
        recommendation.baseline.ownerId,
        recommendation.baseline.regionCode,
        JSON.stringify(candidate.routing.routeIds),
        JSON.stringify(candidate.routing.channelIds),
        candidate.routing.fingerprint,
        now,
        now,
      ),
    );
    if (candidate.dispatch) {
      statements.push(env.DB.prepare(
        `UPDATE recommendation_policy_dispatches
         SET state = 'active', resolved_at = NULL,
             first_queued_at = COALESCE(first_queued_at, ?),
             last_queued_at = ?, next_eligible_at = ?,
             notification_count = notification_count + ?,
             escalation_count = escalation_count + ?,
             escalated_at = CASE WHEN ? = 1 THEN COALESCE(escalated_at, ?) ELSE escalated_at END,
             last_batch_id = ?, last_delivery_status = 'queued', last_error = NULL, updated_at = ?
         WHERE portal_id = ? AND id = ?`,
      ).bind(
        now,
        now,
        policyNextEligibleAt(now, candidate.cooldownMinutes),
        stage === 'escalation' ? 0 : 1,
        stage === 'escalation' ? 1 : 0,
        stage === 'escalation' ? 1 : 0,
        now,
        batchId,
        now,
        policyRow.portal_id,
        candidate.dispatchId,
      ));
    } else {
      statements.push(env.DB.prepare(
        `INSERT INTO recommendation_policy_dispatches (
          id, portal_id, policy_id, recommendation_id, state,
          first_matched_at, first_queued_at, last_queued_at, next_eligible_at,
          notification_count, escalation_count, escalated_at,
          last_batch_id, last_delivery_status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
      ).bind(
        candidate.dispatchId,
        policyRow.portal_id,
        policy.id,
        recommendation.id,
        now,
        now,
        now,
        policyNextEligibleAt(now, candidate.cooldownMinutes),
        stage === 'escalation' ? 0 : 1,
        stage === 'escalation' ? 1 : 0,
        stage === 'escalation' ? now : null,
        batchId,
        now,
        now,
      ));
    }
    statements.push(env.DB.prepare(
      `INSERT INTO recommendation_events (
        id, portal_id, recommendation_id, deal_id, event_type,
        actor_user_id, actor_email, metadata_json, occurred_at
      ) VALUES (?, ?, ?, ?, 'followup_requested', ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      policyRow.portal_id,
      recommendation.id,
      recommendation.dealId,
      policyRow.updated_by_user_id ?? policyRow.created_by_user_id,
      policyRow.updated_by_email ?? policyRow.created_by_email,
      JSON.stringify({
        batchId,
        policyId: policy.id,
        policyName: policy.name,
        stage,
        eventType,
        configuredPolicyAuthorized: true,
        noCrmMutation: true,
      }),
      now,
    ));
  }
  await env.DB.batch(statements);
  await new Repository(env).audit(
    policyRow.portal_id,
    policyRow.updated_by_user_id ?? policyRow.created_by_user_id,
    policyRow.updated_by_email ?? policyRow.created_by_email,
    'recommendation.policy_batch_queued',
    {
      batchId,
      policyId: policy.id,
      stage,
      eventType,
      recommendationCount: candidates.length,
      configurationAuthorized: true,
      noCrmMutation: true,
    },
  );
  return batchId;
}

async function evaluatePolicy(
  env: Env,
  policyRow: RecommendationRoutingPolicyRow,
  recommendationRows: RecommendationRow[],
): Promise<{
  matched: number;
  queuedBatches: number;
  queuedRecommendations: number;
  routeUnavailable: number;
}> {
  const policy = policyFromRow(policyRow);
  const now = new Date();
  const nowIso = now.toISOString();
  const dispatchResult = await env.DB.prepare(
    `SELECT * FROM recommendation_policy_dispatches
     WHERE portal_id = ? AND policy_id = ?`,
  ).bind(policyRow.portal_id, policy.id).all<DispatchRow>();
  const dispatchByRecommendation = new Map((dispatchResult.results ?? []).map((row) => [row.recommendation_id, row]));
  const routingState = await loadFollowupRoutingState(env, policyRow.portal_id, now);
  const matchedIds: string[] = [];
  const byStage = new Map<RecommendationPolicyDispatchStage, QueueCandidate[]>();
  let routeUnavailable = 0;

  for (const row of recommendationRows) {
    const recommendation = mapRecommendation(row);
    const match = evaluateRecommendationPolicyMatch(policy, recommendation, now.getTime());
    if (!match.matched) continue;
    matchedIds.push(recommendation.id);
    const dispatch = dispatchByRecommendation.get(recommendation.id) ?? null;
    const stage = nextPolicyDispatchStage(policy, dispatchState(dispatch), now.getTime());
    if (!stage) continue;
    const selectedRouteId = stage === 'escalation' ? policy.escalationRouteId : policy.routeId;
    if (!selectedRouteId) continue;
    const eventType = policyEventType(policy.trigger, stage);
    const routeSubset = routingState.routes.filter((route) => route.id === selectedRouteId);
    const routing = await routingMatch({
      routes: routeSubset,
      channels: routingState.channelSummaries,
      quietRouteIds: routingState.quietRouteIds,
      scope: recommendationScope(recommendation),
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
      routeUnavailable += 1;
      if (dispatch) {
        await env.DB.prepare(
          `UPDATE recommendation_policy_dispatches SET last_error = ?, updated_at = ?
           WHERE portal_id = ? AND id = ?`,
        ).bind('Configured route unavailable, not opted in, or in quiet hours.', nowIso, policyRow.portal_id, dispatch.id).run();
      }
      continue;
    }
    const routeCooldown = Math.max(...routing.routes.map((route) => route.suppressionWindowMinutes), 0);
    const candidate: QueueCandidate = {
      row,
      recommendation,
      dispatch,
      dispatchId: dispatch?.id ?? crypto.randomUUID(),
      stage,
      eventType,
      routing,
      cooldownMinutes: effectivePolicyCooldownMinutes(policy.cooldownMinutes, routeCooldown),
    };
    const group = byStage.get(stage) ?? [];
    group.push(candidate);
    byStage.set(stage, group);
  }

  await updateResolvedDispatches(env, policyRow.portal_id, policy.id, matchedIds, nowIso);
  let queuedBatches = 0;
  let queuedRecommendations = 0;
  for (const [stage, candidates] of byStage.entries()) {
    for (let offset = 0; offset < candidates.length; offset += MAX_ITEMS_PER_POLICY_BATCH) {
      const batchCandidates = candidates.slice(offset, offset + MAX_ITEMS_PER_POLICY_BATCH);
      const batchId = await queuePolicyBatch(env, policy, policyRow, stage, batchCandidates);
      if (!batchId) continue;
      queuedBatches += 1;
      queuedRecommendations += batchCandidates.length;
    }
  }
  await env.DB.prepare(
    `UPDATE recommendation_routing_policies
     SET last_evaluated_at = ?, last_match_count = ?, last_queue_count = ?, last_error = ?, updated_at = updated_at
     WHERE portal_id = ? AND id = ?`,
  ).bind(
    nowIso,
    matchedIds.length,
    queuedRecommendations,
    routeUnavailable > 0 ? `${routeUnavailable} matching recommendation(s) had no currently deliverable route.` : null,
    policyRow.portal_id,
    policy.id,
  ).run();
  return { matched: matchedIds.length, queuedBatches, queuedRecommendations, routeUnavailable };
}

export async function evaluateRecommendationRoutingPolicies(
  env: Env,
  portalId?: string,
): Promise<RecommendationPolicyRunSummary> {
  const policies = await env.DB.prepare(
    `SELECT * FROM recommendation_routing_policies
     WHERE enabled = 1 ${portalId ? 'AND portal_id = ?' : ''}
     ORDER BY portal_id, updated_at ASC
     LIMIT ?`,
  ).bind(...(portalId ? [portalId, MAX_POLICIES_PER_RUN] : [MAX_POLICIES_PER_RUN]))
    .all<RecommendationRoutingPolicyRow>();
  const byPortal = new Map<string, RecommendationRoutingPolicyRow[]>();
  for (const policy of policies.results ?? []) {
    const group = byPortal.get(policy.portal_id) ?? [];
    group.push(policy);
    byPortal.set(policy.portal_id, group);
  }
  const summary: RecommendationPolicyRunSummary = {
    evaluatedPolicies: 0,
    matchedRecommendations: 0,
    queuedBatches: 0,
    queuedRecommendations: 0,
    routeUnavailable: 0,
    errors: 0,
  };
  for (const [currentPortalId, portalPolicies] of byPortal.entries()) {
    const recommendations = await env.DB.prepare(
      `${RECOMMENDATION_SELECT}
       WHERE recommendation.portal_id = ?
         AND recommendation.status IN ('presented','accepted')
         AND recommendation.due_at IS NOT NULL
         AND (recommendation.status = 'accepted' OR snapshot.next_action_code = recommendation.recommendation_code)
       ORDER BY recommendation.due_at ASC
       LIMIT ?`,
    ).bind(currentPortalId, MAX_RECOMMENDATIONS_PER_PORTAL).all<RecommendationRow>();
    for (const policy of portalPolicies) {
      summary.evaluatedPolicies += 1;
      try {
        const result = await evaluatePolicy(env, policy, recommendations.results ?? []);
        summary.matchedRecommendations += result.matched;
        summary.queuedBatches += result.queuedBatches;
        summary.queuedRecommendations += result.queuedRecommendations;
        summary.routeUnavailable += result.routeUnavailable;
      } catch (error) {
        summary.errors += 1;
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
        await env.DB.prepare(
          `UPDATE recommendation_routing_policies
           SET last_evaluated_at = ?, last_error = ?
           WHERE portal_id = ? AND id = ?`,
        ).bind(new Date().toISOString(), message, policy.portal_id, policy.id).run().catch(() => undefined);
        console.error(JSON.stringify({
          level: 'error',
          task: 'recommendation_policy_evaluation',
          portalId: policy.portal_id,
          policyId: policy.id,
          error: message,
        }));
      }
    }
  }
  if (summary.queuedBatches > 0) await wakeDeliveryQueue(env, 'outbox');
  return summary;
}
