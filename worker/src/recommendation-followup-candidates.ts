import {
  permissionMatches,
  requireEnterprisePermission,
} from './enterprise-access.js';
import { loadFollowupRoutingState } from './recommendation-followup-delivery.js';
import { listRecommendationFollowupBatches } from './recommendation-operations.js';
import { RECOMMENDATION_FOLLOWUP_EVENT } from './recommendation-operations-types.js';
import {
  analyticsScopeFilter,
  mapRecommendation,
  RECOMMENDATION_SELECT,
  type RecommendationRow,
} from './recommendation-outcome-storage.js';
import type { Env, RequestIdentity } from './types.js';

export async function listRecommendationFollowupCandidates(
  env: Env,
  identity: RequestIdentity,
  url: URL,
): Promise<Record<string, unknown>> {
  const access = await requireEnterprisePermission(env, identity, 'remediation.view');
  const scoped = analyticsScopeFilter(url, access);
  if (scoped.deniedKey) {
    return {
      candidates: [],
      batches: [],
      permissions: {
        canView: true,
        canBulkFollowup: false,
        canManageRouting: permissionMatches(access.permissions, 'alert.manage'),
        canExport: permissionMatches(access.permissions, 'analytics.export'),
      },
      deniedFilter: scoped.deniedKey,
    };
  }
  const clauses = scoped.clauses.length > 0 ? `AND ${scoped.clauses.join(' AND ')}` : '';
  const result = await env.DB.prepare(
    `${RECOMMENDATION_SELECT}
     WHERE recommendation.portal_id = ?
       AND recommendation.status IN ('presented', 'accepted')
       AND (
         recommendation.status = 'accepted'
         OR snapshot.next_action_code = recommendation.recommendation_code
       )
       ${clauses}
     ORDER BY
       CASE WHEN recommendation.status = 'accepted' THEN 0 ELSE 1 END,
       CASE WHEN recommendation.due_at IS NOT NULL AND recommendation.due_at::timestamptz < NOW() THEN 0 ELSE 1 END,
       CASE recommendation.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
       recommendation.due_at ASC NULLS LAST,
       recommendation.presented_at DESC
     LIMIT 100`,
  ).bind(identity.portalId, ...scoped.params).all<RecommendationRow>();
  const recommendations = (result.results ?? []).map(mapRecommendation);
  const routing = await loadFollowupRoutingState(env, identity.portalId);
  const manualRoutes = routing.routes.filter((route) => route.eventTypes.includes(RECOMMENDATION_FOLLOWUP_EVENT));
  const canBulkFollowup = permissionMatches(access.permissions, 'remediation.bulk');
  let batches: unknown[] = [];
  if (canBulkFollowup && (identity.userId || identity.userEmail)) {
    try {
      batches = (await listRecommendationFollowupBatches(env, identity, new URL(`${url.origin}${url.pathname}?limit=10`))).batches;
    } catch {
      batches = [];
    }
  }
  return {
    candidates: recommendations.map((recommendation) => ({
      id: recommendation.id,
      dealId: recommendation.dealId,
      recommendationCode: recommendation.recommendationCode,
      label: recommendation.label,
      action: recommendation.action,
      dimension: recommendation.dimension,
      priority: recommendation.priority,
      owner: recommendation.owner,
      dueAt: recommendation.dueAt,
      status: recommendation.status,
      overdue: recommendation.overdue,
      rationale: recommendation.rationale,
      scope: {
        pipelineId: recommendation.baseline.pipelineId,
        teamId: recommendation.baseline.teamId,
        ownerId: recommendation.baseline.ownerId,
        regionCode: recommendation.baseline.regionCode,
      },
    })),
    batches,
    routing: {
      explicitEventType: RECOMMENDATION_FOLLOWUP_EVENT,
      eligibleRoutes: manualRoutes.map((route) => ({
        id: route.id,
        name: route.name,
        channelCount: route.channelIds.length,
        quietHoursConfigured: Boolean(route.quietHoursCalendarId),
        suppressionWindowMinutes: route.suppressionWindowMinutes,
        currentlyInQuietHours: routing.quietRouteIds.has(route.id),
      })),
      ready: manualRoutes.some((route) => route.channelIds.length > 0 && !routing.quietRouteIds.has(route.id)),
    },
    permissions: {
      canView: true,
      canBulkFollowup,
      canManageRouting: permissionMatches(access.permissions, 'alert.manage'),
      canExport: permissionMatches(access.permissions, 'analytics.export'),
    },
    semantics: {
      explicitPreviewRequired: true,
      explicitConfirmationRequired: true,
      explicitRouteOptInRequired: true,
      noAutomaticRecommendationTransition: true,
      noCrmMutation: true,
    },
  };
}
