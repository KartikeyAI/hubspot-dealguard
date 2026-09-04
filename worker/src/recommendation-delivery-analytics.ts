import { requireEnterprisePermission, type EnterpriseAccessContext } from './enterprise-access.js';
import { AppError } from './errors.js';
import { buildRecommendationDeliveryAnalytics } from './recommendation-delivery-analytics-model.js';
import type {
  DeliveryAnalyticsAttempt,
  DeliveryAnalyticsChannelDefinition,
  DeliveryAnalyticsDispatch,
  DeliveryAnalyticsEvent,
  DeliveryAnalyticsRouteDefinition,
  DeliveryChannelResult,
  RecommendationDeliveryAnalyticsResponse,
  RecommendationDeliveryEventType,
} from './recommendation-delivery-analytics-types.js';
import type { Env, RequestIdentity } from './types.js';

const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 100;
const ATTEMPT_LIMIT = 20_000;
const EVENT_LIMIT = 20_000;
const DISPATCH_LIMIT = 10_000;
const cache = new Map<string, { expiresAt: number; value: RecommendationDeliveryAnalyticsResponse }>();

interface AttemptRow extends Record<string, unknown> {
  batch_id: string;
  authorization_mode: 'human_confirmation' | 'configured_policy';
  automation_policy_id: string | null;
  batch_status: string;
  kind: 'owner_reminder' | 'manager_review';
  severity: 'warning' | 'critical';
  batch_created_at: string;
  confirmed_at: string | null;
  completed_at: string | null;
  routing_summary_json: string;
  item_id: string;
  recommendation_id: string;
  policy_dispatch_id: string | null;
  deal_id: string;
  due_at: string | null;
  item_status: string;
  matched_route_ids_json: string;
  matched_channel_ids_json: string;
  delivery_summary_json: string;
  pipeline_id: string | null;
  team_id: string | null;
  owner_id: string | null;
  region_code: string | null;
  policy_name: string | null;
  trigger_kind: 'due_soon' | 'overdue' | null;
  escalation_after_minutes: number | null;
  first_matched_at: string | null;
  first_queued_at: string | null;
  escalated_at: string | null;
  resolved_at: string | null;
}

interface EventRow extends Record<string, unknown> {
  id: string;
  event_type: RecommendationDeliveryEventType;
  policy_id: string | null;
  dispatch_id: string | null;
  recommendation_id: string | null;
  route_id: string | null;
  stage: 'initial' | 'repeat' | 'escalation' | null;
  reason_code: string | null;
  event_at: string;
  recommendation_due_at: string | null;
  sla_due_at: string | null;
  pipeline_id: string | null;
  team_id: string | null;
  owner_id: string | null;
  region_code: string | null;
}

interface DispatchRow extends Record<string, unknown> {
  id: string;
  policy_id: string;
  policy_name: string;
  trigger_kind: 'due_soon' | 'overdue';
  escalation_after_minutes: number | null;
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
  last_delivery_status: 'queued' | 'completed' | 'partially_failed' | 'failed' | null;
  baseline_pipeline_id: string | null;
  baseline_team_id: string | null;
  baseline_owner_id: string | null;
  baseline_region_code: string | null;
}

interface ScopeSelection {
  pipelineIds: string[];
  teamIds: string[];
  ownerIds: string[];
  regionCodes: string[];
}

function text(value: unknown, maximum = 500): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maximum) : null;
}

function number(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(value: unknown): string | null {
  const normalized = text(value, 80);
  if (!normalized) return null;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function strings(value: unknown, maximum = 100): string[] {
  const parsed = typeof value === 'string' ? parseJson<unknown>(value, []) : value;
  if (!Array.isArray(parsed)) return [];
  return [...new Set(parsed
    .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    .map((item) => item.trim().slice(0, 256)))]
    .slice(0, maximum);
}

function days(url: URL): number {
  const parsed = Math.round(Number(url.searchParams.get('days') ?? 30));
  return Number.isFinite(parsed) ? Math.min(365, Math.max(7, parsed)) : 30;
}

function selectedScope(url: URL, access: EnterpriseAccessContext): ScopeSelection {
  const result: ScopeSelection = { pipelineIds: [], teamIds: [], ownerIds: [], regionCodes: [] };
  const definitions = [
    ['pipelineId', 'pipelineIds'],
    ['teamId', 'teamIds'],
    ['ownerId', 'ownerIds'],
    ['regionCode', 'regionCodes'],
  ] as const;
  for (const [queryKey, scopeKey] of definitions) {
    const requested = text(url.searchParams.get(queryKey), 128);
    const allowed = access.scope[scopeKey];
    if (requested && allowed.length > 0 && !allowed.includes(requested)) {
      throw new AppError(403, 'recommendation_delivery_analytics_scope_denied', `The selected ${queryKey} is outside your assigned data scope.`);
    }
    result[scopeKey] = requested ? [requested] : [...allowed];
  }
  return result;
}

function scopeSql(
  scope: ScopeSelection,
  columns: { pipeline: string; team: string; owner: string; region: string },
): { clauses: string[]; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  const definitions: Array<[string[], string]> = [
    [scope.pipelineIds, columns.pipeline],
    [scope.teamIds, columns.team],
    [scope.ownerIds, columns.owner],
    [scope.regionCodes, columns.region],
  ];
  for (const [values, column] of definitions) {
    if (values.length === 0) continue;
    clauses.push(`${column} IN (${values.map(() => '?').join(', ')})`);
    params.push(...values);
  }
  return { clauses, params };
}

function channelResults(value: unknown): DeliveryChannelResult[] {
  const rows = parseJson<unknown[]>(value, []);
  return rows.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const item = entry as Record<string, unknown>;
    const channelId = text(item.channelId, 128);
    const channelName = text(item.channelName, 240);
    const channelType = item.channelType;
    const status = item.status;
    if (
      !channelId || !channelName
      || !['slack_webhook', 'teams_workflow', 'email', 'webhook'].includes(String(channelType))
      || !['delivered', 'failed'].includes(String(status))
    ) return [];
    return [{
      channelId,
      channelName,
      channelType: channelType as DeliveryChannelResult['channelType'],
      status: status as DeliveryChannelResult['status'],
      error: text(item.error, 1000),
    }];
  });
}

function attempt(row: AttemptRow): DeliveryAnalyticsAttempt {
  return {
    batchId: String(row.batch_id),
    itemId: String(row.item_id),
    recommendationId: String(row.recommendation_id),
    dealId: String(row.deal_id),
    authorizationMode: row.authorization_mode,
    policyId: text(row.automation_policy_id, 128),
    policyName: text(row.policy_name, 240),
    trigger: row.trigger_kind,
    escalationAfterMinutes: number(row.escalation_after_minutes),
    dispatchId: text(row.policy_dispatch_id, 128),
    batchStatus: String(row.batch_status),
    itemStatus: String(row.item_status),
    kind: row.kind,
    severity: row.severity,
    createdAt: iso(row.batch_created_at) ?? String(row.batch_created_at),
    confirmedAt: iso(row.confirmed_at),
    completedAt: iso(row.completed_at),
    recommendationDueAt: iso(row.due_at),
    firstMatchedAt: iso(row.first_matched_at),
    firstQueuedAt: iso(row.first_queued_at),
    escalatedAt: iso(row.escalated_at),
    resolvedAt: iso(row.resolved_at),
    routeIds: strings(row.matched_route_ids_json),
    channelIds: strings(row.matched_channel_ids_json),
    channelResults: channelResults(row.delivery_summary_json),
    pipelineId: text(row.pipeline_id, 128),
    teamId: text(row.team_id, 128),
    ownerId: text(row.owner_id, 128),
    regionCode: text(row.region_code, 128),
  };
}

function event(row: EventRow): DeliveryAnalyticsEvent {
  return {
    id: String(row.id),
    eventType: row.event_type,
    policyId: text(row.policy_id, 128),
    dispatchId: text(row.dispatch_id, 128),
    recommendationId: text(row.recommendation_id, 128),
    routeId: text(row.route_id, 128),
    stage: row.stage,
    reasonCode: text(row.reason_code, 240),
    eventAt: iso(row.event_at) ?? String(row.event_at),
    recommendationDueAt: iso(row.recommendation_due_at),
    slaDueAt: iso(row.sla_due_at),
    pipelineId: text(row.pipeline_id, 128),
    teamId: text(row.team_id, 128),
    ownerId: text(row.owner_id, 128),
    regionCode: text(row.region_code, 128),
  };
}

function dispatch(row: DispatchRow): DeliveryAnalyticsDispatch {
  return {
    id: String(row.id),
    policyId: String(row.policy_id),
    policyName: String(row.policy_name),
    trigger: row.trigger_kind,
    escalationAfterMinutes: number(row.escalation_after_minutes),
    recommendationId: String(row.recommendation_id),
    state: row.state,
    firstMatchedAt: iso(row.first_matched_at) ?? String(row.first_matched_at),
    firstQueuedAt: iso(row.first_queued_at),
    lastQueuedAt: iso(row.last_queued_at),
    nextEligibleAt: iso(row.next_eligible_at),
    notificationCount: Number(row.notification_count ?? 0),
    escalationCount: Number(row.escalation_count ?? 0),
    escalatedAt: iso(row.escalated_at),
    resolvedAt: iso(row.resolved_at),
    lastDeliveryStatus: row.last_delivery_status,
    pipelineId: text(row.baseline_pipeline_id, 128),
    teamId: text(row.baseline_team_id, 128),
    ownerId: text(row.baseline_owner_id, 128),
    regionCode: text(row.baseline_region_code, 128),
  };
}

function cacheKey(identity: RequestIdentity, url: URL, scope: ScopeSelection): string {
  return JSON.stringify({
    portalId: identity.portalId,
    userId: identity.userId,
    userEmail: identity.userEmail,
    days: days(url),
    scope,
    policyId: text(url.searchParams.get('policyId'), 128),
    routeId: text(url.searchParams.get('routeId'), 128),
    authorizationMode: text(url.searchParams.get('authorizationMode'), 32),
  });
}

function putCache(key: string, value: RecommendationDeliveryAnalyticsResponse): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });
}

export async function recommendationDeliveryAnalytics(
  env: Env,
  identity: RequestIdentity,
  url: URL,
): Promise<RecommendationDeliveryAnalyticsResponse> {
  const access = await requireEnterprisePermission(env, identity, 'analytics.view');
  const scope = selectedScope(url, access);
  const key = cacheKey(identity, url, scope);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (cached) cache.delete(key);

  const windowDays = days(url);
  const end = new Date();
  const start = new Date(end.getTime() - windowDays * 86_400_000);
  const policyId = text(url.searchParams.get('policyId'), 128);
  const routeId = text(url.searchParams.get('routeId'), 128);
  const authorizationMode = url.searchParams.get('authorizationMode');
  if (authorizationMode && !['human_confirmation', 'configured_policy'].includes(authorizationMode)) {
    throw new AppError(400, 'recommendation_delivery_authorization_mode_invalid', 'Choose human_confirmation or configured_policy.');
  }

  const attemptScope = scopeSql(scope, {
    pipeline: 'item.pipeline_id', team: 'item.team_id', owner: 'item.owner_id', region: 'item.region_code',
  });
  const eventScope = scopeSql(scope, {
    pipeline: 'delivery_event.pipeline_id', team: 'delivery_event.team_id', owner: 'delivery_event.owner_id', region: 'delivery_event.region_code',
  });
  const dispatchScope = scopeSql(scope, {
    pipeline: 'recommendation.baseline_pipeline_id', team: 'recommendation.baseline_team_id',
    owner: 'recommendation.baseline_owner_id', region: 'recommendation.baseline_region_code',
  });
  const attemptClauses = [
    'item.portal_id = ?',
    'batch.created_at::timestamptz >= ?::timestamptz',
    'batch.created_at::timestamptz <= ?::timestamptz',
    ...attemptScope.clauses,
  ];
  const attemptParams: unknown[] = [identity.portalId, start.toISOString(), end.toISOString(), ...attemptScope.params];
  if (policyId) { attemptClauses.push('batch.automation_policy_id = ?'); attemptParams.push(policyId); }
  if (authorizationMode) { attemptClauses.push('batch.authorization_mode = ?'); attemptParams.push(authorizationMode); }

  const eventClauses = [
    'delivery_event.portal_id = ?',
    'delivery_event.event_at::timestamptz >= ?::timestamptz',
    'delivery_event.event_at::timestamptz <= ?::timestamptz',
    ...eventScope.clauses,
  ];
  const eventParams: unknown[] = [identity.portalId, start.toISOString(), end.toISOString(), ...eventScope.params];
  if (policyId) { eventClauses.push('delivery_event.policy_id = ?'); eventParams.push(policyId); }
  if (routeId) { eventClauses.push('delivery_event.route_id = ?'); eventParams.push(routeId); }

  const dispatchClauses = ['dispatch.portal_id = ?', ...dispatchScope.clauses];
  const dispatchParams: unknown[] = [identity.portalId, ...dispatchScope.params];
  if (policyId) { dispatchClauses.push('dispatch.policy_id = ?'); dispatchParams.push(policyId); }

  const [attemptRows, eventRows, dispatchRows, routeRows, channelRows] = await Promise.all([
    env.DB.prepare(
      `SELECT
        batch.id AS batch_id, batch.authorization_mode, batch.automation_policy_id,
        batch.status AS batch_status, batch.kind, batch.severity,
        batch.created_at AS batch_created_at, batch.confirmed_at, batch.completed_at,
        batch.routing_summary_json,
        item.id AS item_id, item.recommendation_id, item.policy_dispatch_id, item.deal_id,
        item.due_at, item.status AS item_status,
        item.matched_route_ids_json, item.matched_channel_ids_json,
        item.delivery_summary_json, item.pipeline_id, item.team_id, item.owner_id, item.region_code,
        policy.name AS policy_name, policy.trigger_kind, policy.escalation_after_minutes,
        dispatch.first_matched_at, dispatch.first_queued_at, dispatch.escalated_at, dispatch.resolved_at
       FROM recommendation_followup_items item
       JOIN recommendation_followup_batches batch
         ON batch.portal_id = item.portal_id AND batch.id = item.batch_id
       LEFT JOIN recommendation_routing_policies policy
         ON policy.portal_id = batch.portal_id AND policy.id = batch.automation_policy_id
       LEFT JOIN recommendation_policy_dispatches dispatch
         ON dispatch.portal_id = item.portal_id AND dispatch.id = item.policy_dispatch_id
       WHERE ${attemptClauses.join(' AND ')}
       ORDER BY batch.created_at DESC, item.created_at DESC
       LIMIT ?`,
    ).bind(...attemptParams, ATTEMPT_LIMIT).all<AttemptRow>(),
    env.DB.prepare(
      `SELECT * FROM recommendation_delivery_events delivery_event
       WHERE ${eventClauses.join(' AND ')}
       ORDER BY delivery_event.event_at DESC
       LIMIT ?`,
    ).bind(...eventParams, EVENT_LIMIT).all<EventRow>(),
    env.DB.prepare(
      `SELECT dispatch.*, policy.name AS policy_name, policy.trigger_kind,
              policy.escalation_after_minutes,
              recommendation.baseline_pipeline_id, recommendation.baseline_team_id,
              recommendation.baseline_owner_id, recommendation.baseline_region_code
       FROM recommendation_policy_dispatches dispatch
       JOIN recommendation_routing_policies policy
         ON policy.portal_id = dispatch.portal_id AND policy.id = dispatch.policy_id
       JOIN recommendation_instances recommendation
         ON recommendation.portal_id = dispatch.portal_id AND recommendation.id = dispatch.recommendation_id
       WHERE ${dispatchClauses.join(' AND ')}
       ORDER BY dispatch.updated_at DESC
       LIMIT ?`,
    ).bind(...dispatchParams, DISPATCH_LIMIT).all<DispatchRow>(),
    env.DB.prepare(
      `SELECT id, name FROM notification_routes WHERE portal_id = ? ORDER BY name`,
    ).bind(identity.portalId).all<{ id: string; name: string }>(),
    env.DB.prepare(
      `SELECT id, name, type FROM notification_channels WHERE portal_id = ? ORDER BY name`,
    ).bind(identity.portalId).all<{ id: string; name: string; type: DeliveryAnalyticsChannelDefinition['type'] }>(),
  ]);

  let attempts = (attemptRows.results ?? []).map(attempt);
  if (routeId) attempts = attempts.filter((item) => item.routeIds.includes(routeId));
  const events = (eventRows.results ?? []).map(event);
  const earliestMatch = new Map<string, string>();
  for (const item of events) {
    if (item.eventType !== 'policy_matched' || !item.policyId || !item.recommendationId) continue;
    const matchKey = `${item.policyId}:${item.recommendationId}`;
    const current = earliestMatch.get(matchKey);
    if (!current || Date.parse(item.eventAt) < Date.parse(current)) earliestMatch.set(matchKey, item.eventAt);
  }
  const dispatches = (dispatchRows.results ?? []).map(dispatch).map((item) => {
    const observed = earliestMatch.get(`${item.policyId}:${item.recommendationId}`);
    return observed && Date.parse(observed) < Date.parse(item.firstMatchedAt)
      ? { ...item, firstMatchedAt: observed }
      : item;
  });
  const routes: DeliveryAnalyticsRouteDefinition[] = (routeRows.results ?? []).map((row) => ({
    id: String(row.id), name: String(row.name),
  }));
  const channels: DeliveryAnalyticsChannelDefinition[] = (channelRows.results ?? []).map((row) => ({
    id: String(row.id), name: String(row.name), type: row.type,
  }));

  const result = buildRecommendationDeliveryAnalytics({
    generatedAt: end.toISOString(),
    days: windowDays,
    start: start.toISOString(),
    end: end.toISOString(),
    attempts,
    events,
    dispatches,
    routes,
    channels,
    truncated: (attemptRows.results?.length ?? 0) >= ATTEMPT_LIMIT
      || (eventRows.results?.length ?? 0) >= EVENT_LIMIT
      || (dispatchRows.results?.length ?? 0) >= DISPATCH_LIMIT,
  });
  putCache(key, result);
  return result;
}
