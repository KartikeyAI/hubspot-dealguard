import {
  permissionMatches,
  requireEnterprisePermission,
  type EnterpriseAccessContext,
} from './enterprise-access.js';
import { AppError } from './errors.js';
import { loadFollowupRoutingState } from './recommendation-followup-delivery.js';
import { routingMatch, uniqueStrings } from './recommendation-operations-model.js';
import type { RecommendationFollowupScope } from './recommendation-operations-types.js';
import {
  evaluateRecommendationPolicyMatch,
  nextPolicyDispatchStage,
  policyEventType,
  type RecommendationPolicyDispatchState,
} from './recommendation-routing-policy-model.js';
import {
  RECOMMENDATION_POLICY_DUE_SOON_EVENT,
  RECOMMENDATION_POLICY_ESCALATED_EVENT,
  RECOMMENDATION_POLICY_OVERDUE_EVENT,
  type RecommendationRoutingPolicy,
  type RecommendationRoutingPolicyListResponse,
  type RecommendationRoutingPolicyPreview,
  type RecommendationRoutingPriority,
  type RecommendationRoutingScope,
  type RecommendationRoutingSeverity,
  type RecommendationRoutingStatusScope,
  type RecommendationRoutingTrigger,
} from './recommendation-routing-policy-types.js';
import {
  mapRecommendation,
  RECOMMENDATION_SELECT,
  type RecommendationRow,
} from './recommendation-outcome-storage.js';
import { Repository } from './repository.js';
import type { Env, RequestIdentity } from './types.js';

const POLICY_PREVIEW_LIMIT = 25;
const POLICY_SCAN_LIMIT = 1000;
const POLICY_EVENTS = new Set<string>([
  RECOMMENDATION_POLICY_DUE_SOON_EVENT,
  RECOMMENDATION_POLICY_OVERDUE_EVENT,
  RECOMMENDATION_POLICY_ESCALATED_EVENT,
]);

export interface RecommendationRoutingPolicyRow extends Record<string, unknown> {
  id: string;
  portal_id: string;
  name: string;
  trigger_kind: RecommendationRoutingTrigger;
  status_scope: RecommendationRoutingStatusScope;
  minimum_priority: RecommendationRoutingPriority;
  threshold_minutes: number;
  cooldown_minutes: number;
  max_notifications: number;
  severity: RecommendationRoutingSeverity;
  route_id: string;
  escalation_route_id: string | null;
  escalation_after_minutes: number | null;
  manager_note: string;
  pipeline_ids_json: string;
  team_ids_json: string;
  owner_ids_json: string;
  region_codes_json: string;
  enabled: number;
  created_by_user_id: string | null;
  created_by_email: string | null;
  updated_by_user_id: string | null;
  updated_by_email: string | null;
  created_at: string;
  updated_at: string;
  last_evaluated_at: string | null;
  last_match_count: number;
  last_queue_count: number;
  last_error: string | null;
}

interface DispatchSummaryRow extends Record<string, unknown> {
  policy_id: string;
  active_count: number;
  queued_count: number;
  delivered_count: number;
  failed_count: number;
  escalated_count: number;
}

interface DispatchRow extends Record<string, unknown> {
  id: string;
  recommendation_id: string;
  notification_count: number;
  escalation_count: number;
  first_queued_at: string | null;
  last_queued_at: string | null;
  next_eligible_at: string | null;
  escalated_at: string | null;
  resolved_at: string | null;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown, maximum = 500): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maximum) : null;
}

function numberWithin(value: unknown, minimum: number, maximum: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(parsed)));
}

function parseStrings(value: unknown, maximum = 100): string[] {
  if (typeof value === 'string') {
    try {
      return uniqueStrings(JSON.parse(value), maximum);
    } catch {
      return [];
    }
  }
  return uniqueStrings(value, maximum);
}

function scopeFromInput(input: Record<string, unknown>): RecommendationRoutingScope {
  const scope = object(input.scope);
  return {
    pipelineIds: parseStrings(scope.pipelineIds),
    teamIds: parseStrings(scope.teamIds),
    ownerIds: parseStrings(scope.ownerIds),
    regionCodes: parseStrings(scope.regionCodes),
  };
}

function scopeWithinAccess(scope: RecommendationRoutingScope, access: EnterpriseAccessContext): boolean {
  const checks: Array<[string[], string[]]> = [
    [scope.pipelineIds, access.scope.pipelineIds],
    [scope.teamIds, access.scope.teamIds],
    [scope.ownerIds, access.scope.ownerIds],
    [scope.regionCodes, access.scope.regionCodes],
  ];
  return checks.every(([requested, allowed]) => {
    if (allowed.length === 0) return true;
    if (requested.length === 0) return false;
    return requested.every((value) => allowed.includes(value));
  });
}

function policyScope(row: RecommendationRoutingPolicyRow): RecommendationRoutingScope {
  return {
    pipelineIds: parseStrings(row.pipeline_ids_json),
    teamIds: parseStrings(row.team_ids_json),
    ownerIds: parseStrings(row.owner_ids_json),
    regionCodes: parseStrings(row.region_codes_json),
  };
}

function dispatchState(row: DispatchRow | undefined): RecommendationPolicyDispatchState | null {
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

function policyFromRow(
  row: RecommendationRoutingPolicyRow,
  summary?: DispatchSummaryRow,
): RecommendationRoutingPolicy {
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
    scope: policyScope(row),
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastEvaluatedAt: row.last_evaluated_at,
    lastMatchCount: Number(row.last_match_count ?? 0),
    lastQueueCount: Number(row.last_queue_count ?? 0),
    lastError: row.last_error,
    dispatchSummary: {
      active: Number(summary?.active_count ?? 0),
      queued: Number(summary?.queued_count ?? 0),
      delivered: Number(summary?.delivered_count ?? 0),
      failed: Number(summary?.failed_count ?? 0),
      escalated: Number(summary?.escalated_count ?? 0),
    },
  };
}

function policyInput(
  value: unknown,
  current: RecommendationRoutingPolicyRow | null,
): Omit<RecommendationRoutingPolicy, 'dispatchSummary'> {
  const input = object(value);
  const now = new Date().toISOString();
  const trigger: RecommendationRoutingTrigger = input.trigger === 'overdue'
    ? 'overdue'
    : input.trigger === 'due_soon'
      ? 'due_soon'
      : current?.trigger_kind ?? 'overdue';
  const statusScope: RecommendationRoutingStatusScope = input.statusScope === 'presented' || input.statusScope === 'accepted' || input.statusScope === 'both'
    ? input.statusScope
    : current?.status_scope ?? 'accepted';
  const minimumPriority: RecommendationRoutingPriority = input.minimumPriority === 'low' || input.minimumPriority === 'medium' || input.minimumPriority === 'high'
    ? input.minimumPriority
    : current?.minimum_priority ?? 'high';
  const severity: RecommendationRoutingSeverity = input.severity === 'critical' ? 'critical' : input.severity === 'warning' ? 'warning' : current?.severity ?? 'warning';
  const name = text(input.name, 120) ?? current?.name ?? '';
  const routeId = text(input.routeId, 128) ?? current?.route_id ?? '';
  const escalationRouteId = input.escalationRouteId === null
    ? null
    : text(input.escalationRouteId, 128) ?? current?.escalation_route_id ?? null;
  const escalationAfterMinutes = input.escalationAfterMinutes === null
    ? null
    : input.escalationAfterMinutes === undefined
      ? current?.escalation_after_minutes ?? null
      : numberWithin(input.escalationAfterMinutes, 15, 43_200, 1_440);
  const note = text(input.managerNote, 2000) ?? current?.manager_note ?? '';
  const scope = input.scope === undefined && current ? policyScope(current) : scopeFromInput(input);
  if (name.length < 3) throw new AppError(400, 'recommendation_policy_name_required', 'Policy name must contain at least 3 characters.');
  if (!routeId) throw new AppError(400, 'recommendation_policy_route_required', 'Select an initial notification route.');
  if (note.length < 10) throw new AppError(400, 'recommendation_policy_note_required', 'Add at least 10 characters of deterministic follow-up guidance.');
  if (escalationRouteId && escalationAfterMinutes === null) {
    throw new AppError(400, 'recommendation_policy_escalation_sla_required', 'Set an escalation SLA when an escalation route is selected.');
  }
  return {
    id: current?.id ?? crypto.randomUUID(),
    name,
    trigger,
    statusScope,
    minimumPriority,
    thresholdMinutes: numberWithin(input.thresholdMinutes, 0, 43_200, current?.threshold_minutes ?? (trigger === 'due_soon' ? 1_440 : 60)),
    cooldownMinutes: numberWithin(input.cooldownMinutes, 15, 43_200, current?.cooldown_minutes ?? 1_440),
    maxNotifications: numberWithin(input.maxNotifications, 1, 10, current?.max_notifications ?? 3),
    severity,
    routeId,
    escalationRouteId,
    escalationAfterMinutes,
    managerNote: note,
    scope,
    enabled: input.enabled === undefined ? Boolean(current?.enabled) : input.enabled === true,
    createdAt: current?.created_at ?? now,
    updatedAt: now,
    lastEvaluatedAt: current?.last_evaluated_at ?? null,
    lastMatchCount: Number(current?.last_match_count ?? 0),
    lastQueueCount: Number(current?.last_queue_count ?? 0),
    lastError: current?.last_error ?? null,
  };
}

async function validatePolicyRoutes(
  env: Env,
  portalId: string,
  policy: Omit<RecommendationRoutingPolicy, 'dispatchSummary'>,
): Promise<void> {
  const routeIds = [policy.routeId, policy.escalationRouteId].filter((value): value is string => Boolean(value));
  const rows = await env.DB.prepare(
    `SELECT id, event_types_json, enabled FROM notification_routes
     WHERE portal_id = ? AND id IN (${routeIds.map(() => '?').join(', ')})`,
  ).bind(portalId, ...routeIds).all<{ id: string; event_types_json: string; enabled: number }>();
  const byId = new Map((rows.results ?? []).map((row) => [row.id, row]));
  if (!byId.has(policy.routeId)) throw new AppError(400, 'recommendation_policy_route_invalid', 'The selected initial notification route does not exist.');
  if (policy.escalationRouteId && !byId.has(policy.escalationRouteId)) {
    throw new AppError(400, 'recommendation_policy_escalation_route_invalid', 'The selected escalation route does not exist.');
  }
  if (!policy.enabled) return;
  const initialEvent = policyEventType(policy.trigger, 'initial');
  const initial = byId.get(policy.routeId)!;
  if (!Boolean(initial.enabled) || !parseStrings(initial.event_types_json).includes(initialEvent)) {
    throw new AppError(409, 'recommendation_policy_route_not_opted_in', `The initial route must be enabled and explicitly include ${initialEvent}.`);
  }
  if (policy.escalationRouteId) {
    const escalation = byId.get(policy.escalationRouteId)!;
    if (!Boolean(escalation.enabled) || !parseStrings(escalation.event_types_json).includes(RECOMMENDATION_POLICY_ESCALATED_EVENT)) {
      throw new AppError(409, 'recommendation_policy_escalation_not_opted_in', `The escalation route must be enabled and explicitly include ${RECOMMENDATION_POLICY_ESCALATED_EVENT}.`);
    }
  }
}

export async function listRecommendationRoutingPolicies(
  env: Env,
  identity: RequestIdentity,
): Promise<RecommendationRoutingPolicyListResponse> {
  const access = await requireEnterprisePermission(env, identity, 'alert.view');
  const [policyRows, summaryRows, routing] = await Promise.all([
    env.DB.prepare(
      `SELECT * FROM recommendation_routing_policies
       WHERE portal_id = ? ORDER BY enabled DESC, name ASC`,
    ).bind(identity.portalId).all<RecommendationRoutingPolicyRow>(),
    env.DB.prepare(
      `SELECT policy_id,
        COUNT(*) FILTER (WHERE state = 'active') AS active_count,
        COUNT(*) FILTER (WHERE last_delivery_status = 'queued') AS queued_count,
        COUNT(*) FILTER (WHERE last_delivery_status IN ('completed','partially_failed')) AS delivered_count,
        COUNT(*) FILTER (WHERE last_delivery_status = 'failed') AS failed_count,
        COUNT(*) FILTER (WHERE escalation_count > 0) AS escalated_count
       FROM recommendation_policy_dispatches
       WHERE portal_id = ? GROUP BY policy_id`,
    ).bind(identity.portalId).all<DispatchSummaryRow>(),
    loadFollowupRoutingState(env, identity.portalId),
  ]);
  const summaries = new Map((summaryRows.results ?? []).map((row) => [row.policy_id, row]));
  const channelById = new Map(routing.channelSummaries.map((channel) => [channel.id, channel]));
  return {
    policies: (policyRows.results ?? []).map((row) => policyFromRow(row, summaries.get(row.id))),
    routes: routing.routes.map((route) => ({
      ...route,
      channels: route.channelIds.map((id) => channelById.get(id)).filter((channel): channel is NonNullable<typeof channel> => Boolean(channel)),
      quietHoursConfigured: Boolean(route.quietHoursCalendarId),
      supportedEvents: route.eventTypes.filter((event) => POLICY_EVENTS.has(event)),
    })),
    permissions: {
      canView: true,
      canManage: permissionMatches(access.permissions, 'alert.manage'),
      canRun: permissionMatches(access.permissions, 'alert.manage'),
    },
    semantics: {
      configurationAuthorizesNotifications: true,
      explicitRouteOptInRequired: true,
      quietHoursHonoured: true,
      cooldownEnforced: true,
      noCrmMutation: true,
      deterministicContentOnly: true,
    },
  };
}

export async function saveRecommendationRoutingPolicy(
  env: Env,
  identity: RequestIdentity,
  value: unknown,
  policyId: string | null = null,
): Promise<RecommendationRoutingPolicy> {
  const access = await requireEnterprisePermission(env, identity, 'alert.manage');
  const current = policyId
    ? await env.DB.prepare(
        `SELECT * FROM recommendation_routing_policies WHERE portal_id = ? AND id = ?`,
      ).bind(identity.portalId, policyId).first<RecommendationRoutingPolicyRow>()
    : null;
  if (policyId && !current) throw new AppError(404, 'recommendation_policy_not_found', 'The recommendation routing policy does not exist.');
  const policy = policyInput(value, current);
  if (!scopeWithinAccess(policy.scope, access)) {
    throw new AppError(403, 'recommendation_policy_scope_denied', 'The policy scope exceeds your assigned pipeline, team, owner, or region scope.');
  }
  await validatePolicyRoutes(env, identity.portalId, policy);
  await env.DB.prepare(
    `INSERT INTO recommendation_routing_policies (
      id, portal_id, name, trigger_kind, status_scope, minimum_priority,
      threshold_minutes, cooldown_minutes, max_notifications, severity,
      route_id, escalation_route_id, escalation_after_minutes, manager_note,
      pipeline_ids_json, team_ids_json, owner_ids_json, region_codes_json,
      enabled, created_by_user_id, created_by_email, updated_by_user_id, updated_by_email,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(portal_id, id) DO UPDATE SET
      name = excluded.name,
      trigger_kind = excluded.trigger_kind,
      status_scope = excluded.status_scope,
      minimum_priority = excluded.minimum_priority,
      threshold_minutes = excluded.threshold_minutes,
      cooldown_minutes = excluded.cooldown_minutes,
      max_notifications = excluded.max_notifications,
      severity = excluded.severity,
      route_id = excluded.route_id,
      escalation_route_id = excluded.escalation_route_id,
      escalation_after_minutes = excluded.escalation_after_minutes,
      manager_note = excluded.manager_note,
      pipeline_ids_json = excluded.pipeline_ids_json,
      team_ids_json = excluded.team_ids_json,
      owner_ids_json = excluded.owner_ids_json,
      region_codes_json = excluded.region_codes_json,
      enabled = excluded.enabled,
      updated_by_user_id = excluded.updated_by_user_id,
      updated_by_email = excluded.updated_by_email,
      updated_at = excluded.updated_at`,
  ).bind(
    policy.id, identity.portalId, policy.name, policy.trigger, policy.statusScope, policy.minimumPriority,
    policy.thresholdMinutes, policy.cooldownMinutes, policy.maxNotifications, policy.severity,
    policy.routeId, policy.escalationRouteId, policy.escalationAfterMinutes, policy.managerNote,
    JSON.stringify(policy.scope.pipelineIds), JSON.stringify(policy.scope.teamIds),
    JSON.stringify(policy.scope.ownerIds), JSON.stringify(policy.scope.regionCodes),
    policy.enabled ? 1 : 0,
    current?.created_by_user_id ?? identity.userId,
    current?.created_by_email ?? identity.userEmail,
    identity.userId, identity.userEmail,
    policy.createdAt, policy.updatedAt,
  ).run();
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, current ? 'recommendation.policy_updated' : 'recommendation.policy_created', {
    policyId: policy.id,
    trigger: policy.trigger,
    enabled: policy.enabled,
    routeId: policy.routeId,
    escalationRouteId: policy.escalationRouteId,
    thresholdMinutes: policy.thresholdMinutes,
    cooldownMinutes: policy.cooldownMinutes,
    maxNotifications: policy.maxNotifications,
    noCrmMutation: true,
  });
  const stored = await env.DB.prepare(
    `SELECT * FROM recommendation_routing_policies WHERE portal_id = ? AND id = ?`,
  ).bind(identity.portalId, policy.id).first<RecommendationRoutingPolicyRow>();
  return policyFromRow(stored!);
}

export async function deleteRecommendationRoutingPolicy(
  env: Env,
  identity: RequestIdentity,
  policyId: string,
): Promise<void> {
  await requireEnterprisePermission(env, identity, 'alert.manage');
  const result = await env.DB.prepare(
    `DELETE FROM recommendation_routing_policies WHERE portal_id = ? AND id = ?`,
  ).bind(identity.portalId, policyId).run();
  if (Number(result.meta?.changes ?? 0) === 0) {
    throw new AppError(404, 'recommendation_policy_not_found', 'The recommendation routing policy does not exist.');
  }
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'recommendation.policy_deleted', {
    policyId,
    noCrmMutation: true,
  });
}

export async function previewRecommendationRoutingPolicy(
  env: Env,
  identity: RequestIdentity,
  value: unknown,
): Promise<RecommendationRoutingPolicyPreview> {
  const access = await requireEnterprisePermission(env, identity, 'alert.view');
  await requireEnterprisePermission(env, identity, 'remediation.view');
  const input = object(value);
  const existingId = text(input.id, 128);
  const current = existingId
    ? await env.DB.prepare(
        `SELECT * FROM recommendation_routing_policies WHERE portal_id = ? AND id = ?`,
      ).bind(identity.portalId, existingId).first<RecommendationRoutingPolicyRow>()
    : null;
  const policy = policyInput(value, current);
  if (!scopeWithinAccess(policy.scope, access)) {
    throw new AppError(403, 'recommendation_policy_scope_denied', 'The preview scope exceeds your assigned data scope.');
  }
  await validatePolicyRoutes(env, identity.portalId, { ...policy, enabled: true });
  const [recommendationRows, dispatchRows, routing] = await Promise.all([
    env.DB.prepare(
      `${RECOMMENDATION_SELECT}
       WHERE recommendation.portal_id = ?
         AND recommendation.status IN ('presented','accepted')
         AND recommendation.due_at IS NOT NULL
         AND (recommendation.status = 'accepted' OR snapshot.next_action_code = recommendation.recommendation_code)
       ORDER BY recommendation.due_at ASC
       LIMIT ?`,
    ).bind(identity.portalId, POLICY_SCAN_LIMIT).all<RecommendationRow>(),
    current
      ? env.DB.prepare(
          `SELECT * FROM recommendation_policy_dispatches WHERE portal_id = ? AND policy_id = ?`,
        ).bind(identity.portalId, current.id).all<DispatchRow>()
      : Promise.resolve({ results: [] as DispatchRow[], success: true }),
    loadFollowupRoutingState(env, identity.portalId),
  ]);
  const dispatchByRecommendation = new Map((dispatchRows.results ?? []).map((row) => [row.recommendation_id, row]));
  const now = Date.now();
  const items = [];
  let matchedCount = 0;
  let deliveryReadyCount = 0;
  let escalationReadyCount = 0;
  for (const recommendation of (recommendationRows.results ?? []).map(mapRecommendation)) {
    const match = evaluateRecommendationPolicyMatch(policy, recommendation, now);
    if (!match.matched) continue;
    matchedCount += 1;
    const stage = nextPolicyDispatchStage(policy, dispatchState(dispatchByRecommendation.get(recommendation.id)), now);
    const routeId = stage === 'escalation' ? policy.escalationRouteId : policy.routeId;
    const eventType = stage ? policyEventType(policy.trigger, stage) : policyEventType(policy.trigger, 'initial');
    const routeSubset = routeId ? routing.routes.filter((route) => route.id === routeId) : [];
    const scope: RecommendationFollowupScope = {
      pipelineId: recommendation.baseline.pipelineId,
      teamId: recommendation.baseline.teamId,
      ownerId: recommendation.baseline.ownerId,
      regionCode: recommendation.baseline.regionCode,
    };
    const route = stage
      ? await routingMatch({
          routes: routeSubset,
          channels: routing.channelSummaries,
          quietRouteIds: routing.quietRouteIds,
          scope,
          severity: stage === 'escalation' ? 'critical' : policy.severity,
          recommendationId: recommendation.id,
          recommendationStatus: recommendation.status,
          priority: recommendation.priority,
          dueAt: recommendation.dueAt,
          kind: stage === 'escalation' ? 'manager_review' : 'owner_reminder',
          managerNote: policy.managerNote,
          eventType,
        })
      : { routeIds: [], channelIds: [], routes: [], fingerprint: '', ready: false };
    if (route.ready) deliveryReadyCount += 1;
    if (stage === 'escalation' && route.ready) escalationReadyCount += 1;
    if (items.length < POLICY_PREVIEW_LIMIT) {
      items.push({
        recommendationId: recommendation.id,
        dealId: recommendation.dealId,
        label: recommendation.label,
        status: recommendation.status,
        priority: recommendation.priority,
        dueAt: recommendation.dueAt,
        matched: true,
        deliveryReady: route.ready,
        stage,
        reason: stage
          ? route.ready
            ? match.reason
            : 'Policy matched, but the selected route is unavailable, not opted in, or currently in quiet hours.'
          : 'Policy matched, but cooldown, notification limit, or completed escalation suppresses another notification.',
        routeNames: route.routes.map((item) => item.name),
        channelNames: route.routes.flatMap((item) => item.channelNames),
      });
    }
  }
  return {
    evaluatedAt: new Date(now).toISOString(),
    matchedCount,
    deliveryReadyCount,
    escalationReadyCount,
    items,
    limitations: [
      `Preview returns at most ${POLICY_PREVIEW_LIMIT} matching recommendation rows while counts cover up to ${POLICY_SCAN_LIMIT} active due-dated recommendations.`,
      'A preview sends no notification and does not change recommendation or CRM state.',
      'Enabled policies are evaluated by the maintenance queue and honour route quiet hours, scope, severity, cooldown, and channel configuration.',
    ],
    semantics: {
      previewSendsNothing: true,
      noCrmMutation: true,
      configurationAuthorizesNotifications: true,
    },
  };
}

export { policyFromRow };
