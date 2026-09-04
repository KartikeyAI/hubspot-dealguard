import {
  permissionMatches,
  requireEnterprisePermission,
  type EnterpriseAccessContext,
} from './enterprise-access.js';
import { AppError } from './errors.js';
import { Repository } from './repository.js';
import { deliverySloMetricComparison, deliverySloMetricSupportsTarget } from './recommendation-delivery-slo-model.js';
import {
  RECOMMENDATION_DELIVERY_SLO_BREACHED_EVENT,
  RECOMMENDATION_DELIVERY_SLO_RECOVERED_EVENT,
  RECOMMENDATION_DELIVERY_SLO_REMINDER_EVENT,
  type RecommendationDeliverySloIncident,
  type RecommendationDeliverySloListResponse,
  type RecommendationDeliverySloMetric,
  type RecommendationDeliverySloNotification,
  type RecommendationDeliverySloNotificationStatus,
  type RecommendationDeliverySloPolicy,
  type RecommendationDeliverySloRouteOption,
  type RecommendationDeliverySloState,
  type RecommendationDeliverySloStatus,
  type RecommendationDeliverySloTargetOption,
  type RecommendationDeliverySloTargetType,
} from './recommendation-delivery-slo-types.js';
import type { RecommendationChannelSummary } from './recommendation-operations-types.js';
import type { Env, RequestIdentity } from './types.js';

const MAX_POLICIES = 25;

export interface DeliverySloPolicyRow extends Record<string, unknown> {
  id: string;
  portal_id: string;
  name: string;
  metric: RecommendationDeliverySloMetric;
  target_type: RecommendationDeliverySloTargetType;
  target_id: string | null;
  comparison: 'minimum' | 'maximum';
  threshold_value: number;
  window_minutes: number;
  minimum_samples: number;
  breach_evaluations: number;
  recovery_evaluations: number;
  severity: 'warning' | 'critical';
  notification_route_id: string;
  alert_cooldown_minutes: number;
  max_alerts_per_incident: number;
  notify_recovery: number;
  enabled: number;
  created_by_user_id: string | null;
  created_by_email: string | null;
  updated_by_user_id: string | null;
  updated_by_email: string | null;
  last_evaluated_at: string | null;
  last_value: number | null;
  last_sample_count: number;
  last_status: RecommendationDeliverySloStatus | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeliverySloStateRow extends Record<string, unknown> {
  portal_id: string;
  slo_policy_id: string;
  status: RecommendationDeliverySloStatus;
  consecutive_breaches: number;
  consecutive_recoveries: number;
  first_breached_at: string | null;
  last_breached_at: string | null;
  last_recovered_at: string | null;
  last_alert_at: string | null;
  next_alert_at: string | null;
  current_value: number | null;
  sample_count: number;
  evidence_start_at: string | null;
  evidence_end_at: string | null;
  evidence_truncated: number;
  last_reason: string | null;
  evaluated_at: string;
  updated_at: string;
}

export interface DeliverySloIncidentRow extends Record<string, unknown> {
  id: string;
  portal_id: string;
  slo_policy_id: string;
  status: 'open' | 'acknowledged' | 'resolved';
  severity: 'warning' | 'critical';
  metric: RecommendationDeliverySloMetric;
  target_type: RecommendationDeliverySloTargetType;
  target_id: string | null;
  comparison: 'minimum' | 'maximum';
  threshold_value: number;
  first_value: number | null;
  worst_value: number | null;
  last_value: number | null;
  last_sample_count: number;
  opened_at: string;
  last_observed_at: string;
  acknowledged_at: string | null;
  resolved_at: string | null;
  resolution_reason: string | null;
  alert_count: number;
  last_notification_id: string | null;
  last_notification_status: RecommendationDeliverySloNotificationStatus | null;
  last_alert_at: string | null;
}

interface DeliverySloNotificationRow extends Record<string, unknown> {
  id: string;
  incident_id: string;
  slo_policy_id: string;
  route_id: string;
  event_type: RecommendationDeliverySloNotification['eventType'];
  severity: RecommendationDeliverySloNotification['severity'];
  status: RecommendationDeliverySloNotificationStatus;
  attempts: number;
  available_at: string;
  last_error: string | null;
  created_at: string;
  completed_at: string | null;
  delivery_summary_json: string;
}

interface RouteRow extends Record<string, unknown> {
  id: string;
  name: string;
  event_types_json: string;
  channel_ids_json: string;
  pipeline_ids_json: string;
  team_ids_json: string;
  owner_ids_json: string;
  region_codes_json: string;
  quiet_hours_calendar_id: string | null;
  suppression_window_minutes: number;
  enabled: number;
}

interface ChannelRow extends Record<string, unknown> {
  id: string;
  name: string;
  type: RecommendationChannelSummary['type'];
  enabled: number;
  updated_at: string;
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

function numeric(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function numberWithin(value: unknown, minimum: number, maximum: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(parsed)));
}

function jsonStrings(value: unknown): string[] {
  if (Array.isArray(value)) return [...new Set(value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim()))];
  if (typeof value !== 'string') return [];
  try { return jsonStrings(JSON.parse(value)); } catch { return []; }
}

function portalWide(access: EnterpriseAccessContext): boolean {
  return access.scope.pipelineIds.length === 0
    && access.scope.teamIds.length === 0
    && access.scope.ownerIds.length === 0
    && access.scope.regionCodes.length === 0;
}

export async function requirePortalWideDeliverySloAccess(
  env: Env,
  identity: RequestIdentity,
  permission: 'reliability.view' | 'reliability.manage',
): Promise<EnterpriseAccessContext> {
  const access = await requireEnterprisePermission(env, identity, permission);
  if (!portalWide(access)) {
    throw new AppError(403, 'delivery_slo_portal_scope_required', 'Recommendation delivery SLOs require a portal-wide reliability assignment.');
  }
  return access;
}

export function deliverySloStateFromRow(row: DeliverySloStateRow | null): RecommendationDeliverySloState | null {
  return row ? {
    status: row.status,
    consecutiveBreaches: Number(row.consecutive_breaches ?? 0),
    consecutiveRecoveries: Number(row.consecutive_recoveries ?? 0),
    firstBreachedAt: row.first_breached_at,
    lastBreachedAt: row.last_breached_at,
    lastRecoveredAt: row.last_recovered_at,
    lastAlertAt: row.last_alert_at,
    nextAlertAt: row.next_alert_at,
    currentValue: numeric(row.current_value),
    sampleCount: Number(row.sample_count ?? 0),
    evidenceStartAt: row.evidence_start_at,
    evidenceEndAt: row.evidence_end_at,
    evidenceTruncated: Boolean(row.evidence_truncated),
    lastReason: row.last_reason,
    evaluatedAt: row.evaluated_at,
  } : null;
}

function targetLabel(
  row: Pick<DeliverySloPolicyRow | DeliverySloIncidentRow, 'target_type' | 'target_id'>,
  labels: Map<string, string>,
): string {
  if (row.target_type === 'portal') return 'Entire portal';
  return labels.get(`${row.target_type}:${row.target_id}`) ?? row.target_id ?? 'Unavailable target';
}

export function deliverySloPolicyFromRow(
  row: DeliverySloPolicyRow,
  labels = new Map<string, string>(),
  routeNames = new Map<string, string>(),
): RecommendationDeliverySloPolicy {
  return {
    id: row.id,
    name: row.name,
    metric: row.metric,
    targetType: row.target_type,
    targetId: row.target_id,
    targetLabel: targetLabel(row, labels),
    comparison: row.comparison,
    thresholdValue: Number(row.threshold_value),
    windowMinutes: Number(row.window_minutes),
    minimumSamples: Number(row.minimum_samples),
    breachEvaluations: Number(row.breach_evaluations),
    recoveryEvaluations: Number(row.recovery_evaluations),
    severity: row.severity,
    notificationRouteId: row.notification_route_id,
    notificationRouteName: routeNames.get(row.notification_route_id) ?? row.notification_route_id,
    alertCooldownMinutes: Number(row.alert_cooldown_minutes),
    maxAlertsPerIncident: Number(row.max_alerts_per_incident),
    notifyRecovery: Boolean(row.notify_recovery),
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastEvaluatedAt: row.last_evaluated_at,
    lastValue: numeric(row.last_value),
    lastSampleCount: Number(row.last_sample_count ?? 0),
    lastStatus: row.last_status,
    lastError: row.last_error,
  };
}

function incidentFromRow(
  row: DeliverySloIncidentRow,
  policyNames: Map<string, string>,
  labels: Map<string, string>,
): RecommendationDeliverySloIncident {
  return {
    id: row.id,
    sloPolicyId: row.slo_policy_id,
    policyName: policyNames.get(row.slo_policy_id) ?? row.slo_policy_id,
    status: row.status,
    severity: row.severity,
    metric: row.metric,
    targetType: row.target_type,
    targetId: row.target_id,
    targetLabel: targetLabel(row, labels),
    comparison: row.comparison,
    thresholdValue: Number(row.threshold_value),
    firstValue: numeric(row.first_value),
    worstValue: numeric(row.worst_value),
    lastValue: numeric(row.last_value),
    lastSampleCount: Number(row.last_sample_count ?? 0),
    openedAt: row.opened_at,
    lastObservedAt: row.last_observed_at,
    acknowledgedAt: row.acknowledged_at,
    resolvedAt: row.resolved_at,
    resolutionReason: row.resolution_reason,
    alertCount: Number(row.alert_count ?? 0),
    lastNotificationId: row.last_notification_id,
    lastNotificationStatus: row.last_notification_status,
    lastAlertAt: row.last_alert_at,
  };
}

function notificationFromRow(
  row: DeliverySloNotificationRow,
  policyNames: Map<string, string>,
  routeNames: Map<string, string>,
): RecommendationDeliverySloNotification {
  return {
    id: row.id,
    incidentId: row.incident_id,
    sloPolicyId: row.slo_policy_id,
    policyName: policyNames.get(row.slo_policy_id) ?? row.slo_policy_id,
    routeId: row.route_id,
    routeName: routeNames.get(row.route_id) ?? row.route_id,
    eventType: row.event_type,
    severity: row.severity,
    status: row.status,
    attempts: Number(row.attempts ?? 0),
    availableAt: row.available_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    deliverySummary: (() => {
      try { return JSON.parse(row.delivery_summary_json) as RecommendationDeliverySloNotification['deliverySummary']; }
      catch { return []; }
    })(),
  };
}

async function loadOptions(env: Env, portalId: string): Promise<{
  routes: RecommendationDeliverySloRouteOption[];
  targets: RecommendationDeliverySloTargetOption[];
  labels: Map<string, string>;
  routeNames: Map<string, string>;
}> {
  const [routeResult, channelResult, policyResult] = await Promise.all([
    env.DB.prepare(`SELECT * FROM notification_routes WHERE portal_id = ? ORDER BY name`).bind(portalId).all<RouteRow>(),
    env.DB.prepare(`SELECT id, name, type, enabled, updated_at FROM notification_channels WHERE portal_id = ? ORDER BY name`).bind(portalId).all<ChannelRow>(),
    env.DB.prepare(`SELECT id, name FROM recommendation_routing_policies WHERE portal_id = ? ORDER BY name`).bind(portalId).all<{ id: string; name: string }>(),
  ]);
  const channels = channelResult.results ?? [];
  const channelById = new Map(channels.filter((item) => Boolean(item.enabled)).map((item) => [item.id, item]));
  const routeNames = new Map<string, string>();
  const routes = (routeResult.results ?? []).map((route) => {
    routeNames.set(route.id, route.name);
    const channelViews = jsonStrings(route.channel_ids_json)
      .map((id) => channelById.get(id))
      .filter((item): item is ChannelRow => Boolean(item))
      .map((item) => ({ id: item.id, name: item.name, type: item.type, updatedAt: item.updated_at }));
    const globalScope = [route.pipeline_ids_json, route.team_ids_json, route.owner_ids_json, route.region_codes_json]
      .every((value) => jsonStrings(value).length === 0);
    return {
      id: route.id,
      name: route.name,
      eventTypes: jsonStrings(route.event_types_json),
      enabled: Boolean(route.enabled),
      globalScope,
      quietHoursConfigured: Boolean(route.quiet_hours_calendar_id),
      suppressionWindowMinutes: Number(route.suppression_window_minutes ?? 0),
      channels: channelViews,
    };
  });
  const labels = new Map<string, string>();
  const targets: RecommendationDeliverySloTargetOption[] = [];
  for (const route of routes) {
    labels.set(`route:${route.id}`, route.name);
    targets.push({ id: route.id, label: route.name, type: 'route' });
  }
  for (const channel of channels) {
    labels.set(`channel:${channel.id}`, channel.name);
    targets.push({ id: channel.id, label: channel.name, type: 'channel' });
  }
  for (const policy of policyResult.results ?? []) {
    labels.set(`routing_policy:${policy.id}`, policy.name);
    targets.push({ id: policy.id, label: policy.name, type: 'routing_policy' });
  }
  return { routes, targets, labels, routeNames };
}

export async function listRecommendationDeliverySlos(
  env: Env,
  identity: RequestIdentity,
): Promise<RecommendationDeliverySloListResponse> {
  const access = await requirePortalWideDeliverySloAccess(env, identity, 'reliability.view');
  const [policyRows, stateRows, incidentRows, notificationRows, options] = await Promise.all([
    env.DB.prepare(`SELECT * FROM recommendation_delivery_slo_policies WHERE portal_id = ? ORDER BY name`).bind(identity.portalId).all<DeliverySloPolicyRow>(),
    env.DB.prepare(`SELECT * FROM recommendation_delivery_slo_states WHERE portal_id = ?`).bind(identity.portalId).all<DeliverySloStateRow>(),
    env.DB.prepare(`SELECT * FROM recommendation_delivery_slo_incidents WHERE portal_id = ? ORDER BY opened_at DESC LIMIT 100`).bind(identity.portalId).all<DeliverySloIncidentRow>(),
    env.DB.prepare(`SELECT * FROM recommendation_delivery_slo_notifications WHERE portal_id = ? ORDER BY created_at DESC LIMIT 100`).bind(identity.portalId).all<DeliverySloNotificationRow>(),
    loadOptions(env, identity.portalId),
  ]);
  const policyNames = new Map((policyRows.results ?? []).map((row) => [row.id, row.name]));
  const states = new Map((stateRows.results ?? []).map((row) => [row.slo_policy_id, row]));
  return {
    generatedAt: new Date().toISOString(),
    policies: (policyRows.results ?? []).map((row) => ({
      ...deliverySloPolicyFromRow(row, options.labels, options.routeNames),
      state: deliverySloStateFromRow(states.get(row.id) ?? null),
    })),
    incidents: (incidentRows.results ?? []).map((row) => incidentFromRow(row, policyNames, options.labels)),
    notifications: (notificationRows.results ?? []).map((row) => notificationFromRow(row, policyNames, options.routeNames)),
    routes: options.routes,
    targets: options.targets,
    permissions: {
      canView: true,
      canManage: permissionMatches(access.permissions, 'reliability.manage'),
      portalWideAccess: true,
    },
    limits: { maxPolicies: MAX_POLICIES, evaluationCadenceMinutes: 15, evidenceRetentionDays: 400 },
    semantics: {
      operationalSloOnly: true,
      explicitRouteOptInRequired: true,
      noCausalAttribution: true,
      noDealOutcomeInference: true,
      noCrmMutation: true,
      insufficientEvidenceCannotOpenIncident: true,
    },
  };
}

function metric(value: unknown): RecommendationDeliverySloMetric {
  const allowed: RecommendationDeliverySloMetric[] = [
    'delivery_success_percent', 'failure_count', 'route_unavailable_count',
    'escalation_sla_breach_count', 'p95_completion_minutes',
  ];
  if (allowed.includes(value as RecommendationDeliverySloMetric)) return value as RecommendationDeliverySloMetric;
  throw new AppError(400, 'delivery_slo_metric_invalid', 'Choose a supported recommendation delivery SLO metric.');
}

function targetType(value: unknown): RecommendationDeliverySloTargetType {
  const allowed: RecommendationDeliverySloTargetType[] = ['portal', 'route', 'channel', 'routing_policy'];
  if (allowed.includes(value as RecommendationDeliverySloTargetType)) return value as RecommendationDeliverySloTargetType;
  throw new AppError(400, 'delivery_slo_target_invalid', 'Choose portal, route, channel, or routing policy as the SLO target.');
}

async function validateTarget(env: Env, portalId: string, type: RecommendationDeliverySloTargetType, id: string | null): Promise<void> {
  if (type === 'portal') {
    if (id) throw new AppError(400, 'delivery_slo_portal_target_id_forbidden', 'Portal-wide SLOs do not use a target ID.');
    return;
  }
  if (!id) throw new AppError(400, 'delivery_slo_target_id_required', 'Select a target for this SLO.');
  const table = type === 'route' ? 'notification_routes' : type === 'channel' ? 'notification_channels' : 'recommendation_routing_policies';
  const row = await env.DB.prepare(`SELECT id FROM ${table} WHERE portal_id = ? AND id = ? LIMIT 1`)
    .bind(portalId, id).first<{ id: string }>();
  if (!row) throw new AppError(404, 'delivery_slo_target_not_found', 'The selected SLO target does not exist in this portal.');
}

async function validateNotificationRoute(
  env: Env,
  portalId: string,
  routeId: string,
  maxAlerts: number,
  notifyRecovery: boolean,
): Promise<void> {
  const route = await env.DB.prepare(`SELECT * FROM notification_routes WHERE portal_id = ? AND id = ? LIMIT 1`)
    .bind(portalId, routeId).first<RouteRow>();
  if (!route || !route.enabled) throw new AppError(404, 'delivery_slo_route_not_found', 'Select an enabled notification route.');
  const globalScope = [route.pipeline_ids_json, route.team_ids_json, route.owner_ids_json, route.region_codes_json]
    .every((value) => jsonStrings(value).length === 0);
  if (!globalScope) throw new AppError(400, 'delivery_slo_route_scope_invalid', 'Delivery SLO alerts require a portal-wide notification route without deal-scope filters.');
  const events = jsonStrings(route.event_types_json);
  const required = [RECOMMENDATION_DELIVERY_SLO_BREACHED_EVENT];
  if (maxAlerts > 1) required.push(RECOMMENDATION_DELIVERY_SLO_REMINDER_EVENT);
  if (notifyRecovery) required.push(RECOMMENDATION_DELIVERY_SLO_RECOVERED_EVENT);
  const missing = required.filter((event) => !events.includes(event));
  if (missing.length > 0) throw new AppError(400, 'delivery_slo_route_opt_in_required', `The selected route must explicitly subscribe to: ${missing.join(', ')}.`);
  const channelIds = jsonStrings(route.channel_ids_json);
  if (channelIds.length === 0) throw new AppError(400, 'delivery_slo_route_channel_required', 'The selected route has no notification channel.');
  const placeholders = channelIds.map(() => '?').join(', ');
  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM notification_channels
     WHERE portal_id = ? AND enabled = 1 AND id IN (${placeholders})`,
  ).bind(portalId, ...channelIds).first<{ count: number }>();
  if (Number(count?.count ?? 0) === 0) throw new AppError(400, 'delivery_slo_route_channel_unavailable', 'The selected route has no enabled notification channel.');
}

function threshold(metricName: RecommendationDeliverySloMetric, value: unknown): number {
  const fallback = metricName === 'delivery_success_percent' ? 95 : metricName === 'p95_completion_minutes' ? 60 : 0;
  const parsed = numeric(value) ?? fallback;
  if (metricName === 'delivery_success_percent') return Math.min(100, Math.max(0, parsed));
  if (metricName === 'p95_completion_minutes') return Math.min(43_200, Math.max(1, parsed));
  return Math.min(100_000, Math.max(0, parsed));
}

export async function saveRecommendationDeliverySlo(
  env: Env,
  identity: RequestIdentity,
  value: unknown,
  policyId: string | null = null,
): Promise<RecommendationDeliverySloPolicy> {
  await requirePortalWideDeliverySloAccess(env, identity, 'reliability.manage');
  const input = object(value);
  const current = policyId
    ? await env.DB.prepare(`SELECT * FROM recommendation_delivery_slo_policies WHERE portal_id = ? AND id = ?`).bind(identity.portalId, policyId).first<DeliverySloPolicyRow>()
    : null;
  if (policyId && !current) throw new AppError(404, 'delivery_slo_policy_not_found', 'The recommendation delivery SLO does not exist.');
  if (!current) {
    const count = await env.DB.prepare(`SELECT COUNT(*) AS count FROM recommendation_delivery_slo_policies WHERE portal_id = ?`).bind(identity.portalId).first<{ count: number }>();
    if (Number(count?.count ?? 0) >= MAX_POLICIES) throw new AppError(409, 'delivery_slo_policy_limit', `A portal can configure at most ${MAX_POLICIES} delivery SLOs.`);
  }
  const metricName = input.metric === undefined && current ? current.metric : metric(input.metric);
  const type = input.targetType === undefined && current ? current.target_type : targetType(input.targetType);
  if (!deliverySloMetricSupportsTarget(metricName, type)) {
    throw new AppError(400, 'delivery_slo_metric_target_invalid', `${metricName} cannot be evaluated for target type ${type}.`);
  }
  const targetId = type === 'portal' ? null : text(input.targetId, 128) ?? current?.target_id ?? null;
  const name = text(input.name, 120) ?? current?.name ?? '';
  if (name.length < 3) throw new AppError(400, 'delivery_slo_name_required', 'SLO name must contain at least 3 characters.');
  const routeId = text(input.notificationRouteId, 128) ?? current?.notification_route_id ?? '';
  if (!routeId) throw new AppError(400, 'delivery_slo_route_required', 'Select a notification route for breach alerts.');
  const maxAlerts = numberWithin(input.maxAlertsPerIncident, 1, 10, current?.max_alerts_per_incident ?? 3);
  const notifyRecovery = input.notifyRecovery === undefined ? Boolean(current?.notify_recovery ?? 1) : input.notifyRecovery === true;
  await Promise.all([
    validateTarget(env, identity.portalId, type, targetId),
    validateNotificationRoute(env, identity.portalId, routeId, maxAlerts, notifyRecovery),
  ]);
  const id = current?.id ?? crypto.randomUUID();
  const now = new Date().toISOString();
  const severity = input.severity === 'critical' ? 'critical' : input.severity === 'warning' ? 'warning' : current?.severity ?? 'warning';
  const values = {
    threshold: threshold(metricName, input.thresholdValue ?? current?.threshold_value),
    windowMinutes: numberWithin(input.windowMinutes, 60, 43_200, current?.window_minutes ?? 1_440),
    minimumSamples: numberWithin(input.minimumSamples, 1, 10_000, current?.minimum_samples ?? 10),
    breachEvaluations: numberWithin(input.breachEvaluations, 1, 10, current?.breach_evaluations ?? 2),
    recoveryEvaluations: numberWithin(input.recoveryEvaluations, 1, 10, current?.recovery_evaluations ?? 2),
    alertCooldownMinutes: numberWithin(input.alertCooldownMinutes, 15, 43_200, current?.alert_cooldown_minutes ?? 1_440),
    maxAlerts,
  };
  await env.DB.prepare(
    `INSERT INTO recommendation_delivery_slo_policies (
      id, portal_id, name, metric, target_type, target_id, comparison,
      threshold_value, window_minutes, minimum_samples, breach_evaluations,
      recovery_evaluations, severity, notification_route_id,
      alert_cooldown_minutes, max_alerts_per_incident, notify_recovery, enabled,
      created_by_user_id, created_by_email, updated_by_user_id, updated_by_email,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(portal_id, id) DO UPDATE SET
      name = excluded.name, metric = excluded.metric, target_type = excluded.target_type,
      target_id = excluded.target_id, comparison = excluded.comparison,
      threshold_value = excluded.threshold_value, window_minutes = excluded.window_minutes,
      minimum_samples = excluded.minimum_samples, breach_evaluations = excluded.breach_evaluations,
      recovery_evaluations = excluded.recovery_evaluations, severity = excluded.severity,
      notification_route_id = excluded.notification_route_id,
      alert_cooldown_minutes = excluded.alert_cooldown_minutes,
      max_alerts_per_incident = excluded.max_alerts_per_incident,
      notify_recovery = excluded.notify_recovery, enabled = excluded.enabled,
      updated_by_user_id = excluded.updated_by_user_id,
      updated_by_email = excluded.updated_by_email, updated_at = excluded.updated_at`,
  ).bind(
    id, identity.portalId, name, metricName, type, targetId, deliverySloMetricComparison(metricName),
    values.threshold, values.windowMinutes, values.minimumSamples, values.breachEvaluations,
    values.recoveryEvaluations, severity, routeId, values.alertCooldownMinutes,
    values.maxAlerts, notifyRecovery ? 1 : 0,
    input.enabled === undefined ? Number(current?.enabled ?? 0) : input.enabled === true ? 1 : 0,
    current?.created_by_user_id ?? identity.userId,
    current?.created_by_email ?? identity.userEmail,
    identity.userId, identity.userEmail,
    current?.created_at ?? now, now,
  ).run();
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, current ? 'recommendation.delivery_slo_updated' : 'recommendation.delivery_slo_created', {
    sloPolicyId: id, metric: metricName, targetType: type, targetId, enabled: input.enabled === true,
    noCrmMutation: true,
  });
  const saved = await env.DB.prepare(`SELECT * FROM recommendation_delivery_slo_policies WHERE portal_id = ? AND id = ?`).bind(identity.portalId, id).first<DeliverySloPolicyRow>();
  const options = await loadOptions(env, identity.portalId);
  return deliverySloPolicyFromRow(saved!, options.labels, options.routeNames);
}

export async function deleteRecommendationDeliverySlo(
  env: Env,
  identity: RequestIdentity,
  policyId: string,
): Promise<void> {
  await requirePortalWideDeliverySloAccess(env, identity, 'reliability.manage');
  const open = await env.DB.prepare(
    `SELECT id FROM recommendation_delivery_slo_incidents
     WHERE portal_id = ? AND slo_policy_id = ? AND status IN ('open', 'acknowledged') LIMIT 1`,
  ).bind(identity.portalId, policyId).first<{ id: string }>();
  if (open) throw new AppError(409, 'delivery_slo_open_incident', 'Resolve the active delivery SLO incident before deleting its policy.');
  const result = await env.DB.prepare(`DELETE FROM recommendation_delivery_slo_policies WHERE portal_id = ? AND id = ?`).bind(identity.portalId, policyId).run();
  if (Number(result.meta?.changes ?? 0) <= 0) throw new AppError(404, 'delivery_slo_policy_not_found', 'The recommendation delivery SLO does not exist.');
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'recommendation.delivery_slo_deleted', { sloPolicyId: policyId });
}

export async function acknowledgeRecommendationDeliverySloIncident(
  env: Env,
  identity: RequestIdentity,
  incidentId: string,
): Promise<RecommendationDeliverySloIncident> {
  await requirePortalWideDeliverySloAccess(env, identity, 'reliability.manage');
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    `UPDATE recommendation_delivery_slo_incidents
     SET status = 'acknowledged', acknowledged_by_user_id = ?, acknowledged_by_email = ?,
         acknowledged_at = COALESCE(acknowledged_at, ?), updated_at = ?
     WHERE portal_id = ? AND id = ? AND status = 'open'`,
  ).bind(identity.userId, identity.userEmail, now, now, identity.portalId, incidentId).run();
  if (Number(result.meta?.changes ?? 0) <= 0) throw new AppError(404, 'delivery_slo_incident_not_acknowledgeable', 'The delivery SLO incident does not exist or is not open.');
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'recommendation.delivery_slo_incident_acknowledged', { incidentId });
  const row = await env.DB.prepare(`SELECT * FROM recommendation_delivery_slo_incidents WHERE portal_id = ? AND id = ?`).bind(identity.portalId, incidentId).first<DeliverySloIncidentRow>();
  const policies = await env.DB.prepare(`SELECT id, name FROM recommendation_delivery_slo_policies WHERE portal_id = ?`).bind(identity.portalId).all<{ id: string; name: string }>();
  const options = await loadOptions(env, identity.portalId);
  return incidentFromRow(row!, new Map((policies.results ?? []).map((item) => [item.id, item.name])), options.labels);
}
