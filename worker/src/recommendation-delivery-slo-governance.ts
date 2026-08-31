import { AppError } from './errors.js';
import {
  deleteRecommendationDeliverySlo,
  saveRecommendationDeliverySlo,
  type DeliverySloPolicyRow,
} from './recommendation-delivery-slos.js';
import {
  RECOMMENDATION_DELIVERY_SLO_BREACHED_EVENT,
  RECOMMENDATION_DELIVERY_SLO_RECOVERED_EVENT,
  RECOMMENDATION_DELIVERY_SLO_REMINDER_EVENT,
  type RecommendationDeliverySloPolicy,
} from './recommendation-delivery-slo-types.js';
import type { Env, RequestIdentity } from './types.js';

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown, maximum = 128): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maximum) : null;
}

function strings(value: unknown): string[] {
  if (Array.isArray(value)) {
    return [...new Set(value
      .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
      .map((item) => item.trim()))];
  }
  if (typeof value !== 'string') return [];
  try {
    return strings(JSON.parse(value));
  } catch {
    return [];
  }
}

function comparable(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : value;
}

function structuralChange(input: Record<string, unknown>, current: DeliverySloPolicyRow): boolean {
  const definitions: Array<[string, unknown]> = [
    ['metric', current.metric],
    ['targetType', current.target_type],
    ['targetId', current.target_id],
    ['thresholdValue', Number(current.threshold_value)],
    ['windowMinutes', Number(current.window_minutes)],
    ['minimumSamples', Number(current.minimum_samples)],
    ['breachEvaluations', Number(current.breach_evaluations)],
    ['recoveryEvaluations', Number(current.recovery_evaluations)],
    ['severity', current.severity],
    ['notificationRouteId', current.notification_route_id],
    ['alertCooldownMinutes', Number(current.alert_cooldown_minutes)],
    ['maxAlertsPerIncident', Number(current.max_alerts_per_incident)],
    ['notifyRecovery', Boolean(current.notify_recovery)],
  ];
  return definitions.some(([key, existing]) =>
    input[key] !== undefined && comparable(input[key]) !== comparable(existing));
}

async function validateRouteContract(
  env: Env,
  portalId: string,
  input: Record<string, unknown>,
  current: DeliverySloPolicyRow | null,
): Promise<void> {
  const routeId = text(input.notificationRouteId) ?? current?.notification_route_id ?? null;
  if (!routeId) return;
  const route = await env.DB.prepare(
    `SELECT minimum_severity, event_types_json
     FROM notification_routes
     WHERE portal_id = ? AND id = ? LIMIT 1`,
  ).bind(portalId, routeId).first<{
    minimum_severity: 'info' | 'warning' | 'critical';
    event_types_json: string;
  }>();
  if (!route) return;

  const requiredEvents = [
    RECOMMENDATION_DELIVERY_SLO_BREACHED_EVENT,
    RECOMMENDATION_DELIVERY_SLO_REMINDER_EVENT,
    RECOMMENDATION_DELIVERY_SLO_RECOVERED_EVENT,
  ];
  const eventTypes = strings(route.event_types_json);
  const missing = requiredEvents.filter((eventType) => !eventTypes.includes(eventType));
  if (missing.length > 0) {
    throw new AppError(
      400,
      'delivery_slo_route_opt_in_required',
      `The selected route must explicitly subscribe to: ${missing.join(', ')}.`,
    );
  }

  const severity = input.severity === 'critical' || input.severity === 'warning'
    ? input.severity
    : current?.severity ?? 'warning';
  const notifyRecovery = input.notifyRecovery === undefined
    ? Boolean(current?.notify_recovery ?? 1)
    : input.notifyRecovery === true;
  const rank = { info: 0, warning: 1, critical: 2 } as const;
  if (rank[severity] < rank[route.minimum_severity]) {
    throw new AppError(
      400,
      'delivery_slo_route_severity_incompatible',
      `The selected route requires ${route.minimum_severity} severity, which would reject this ${severity} SLO breach.`,
    );
  }
  if (notifyRecovery && route.minimum_severity === 'critical') {
    throw new AppError(
      400,
      'delivery_slo_recovery_route_severity_incompatible',
      'Recovery notifications require a route whose minimum severity is warning or info.',
    );
  }
}

export async function saveGovernedRecommendationDeliverySlo(
  env: Env,
  identity: RequestIdentity,
  value: unknown,
  policyId: string | null = null,
): Promise<RecommendationDeliverySloPolicy> {
  const input = object(value);
  const current = policyId
    ? await env.DB.prepare(
        `SELECT * FROM recommendation_delivery_slo_policies
         WHERE portal_id = ? AND id = ? LIMIT 1`,
      ).bind(identity.portalId, policyId).first<DeliverySloPolicyRow>()
    : null;
  if (current) {
    const incident = await env.DB.prepare(
      `SELECT id FROM recommendation_delivery_slo_incidents
       WHERE portal_id = ? AND slo_policy_id = ?
         AND status IN ('open', 'acknowledged') LIMIT 1`,
    ).bind(identity.portalId, policyId).first<{ id: string }>();
    if (incident && structuralChange(input, current)) {
      throw new AppError(
        409,
        'delivery_slo_active_incident_semantics_locked',
        'Target, threshold, evidence window, persistence, route, severity, and alert-policy settings cannot change while this SLO has an active incident. Disable it or wait for recovery; name and enabled state may still be updated.',
      );
    }
  }
  await validateRouteContract(env, identity.portalId, input, current);
  return saveRecommendationDeliverySlo(env, identity, value, policyId);
}

export async function deleteGovernedRecommendationDeliverySlo(
  env: Env,
  identity: RequestIdentity,
  policyId: string,
): Promise<void> {
  const historical = await env.DB.prepare(
    `SELECT id FROM recommendation_delivery_slo_incidents
     WHERE portal_id = ? AND slo_policy_id = ? LIMIT 1`,
  ).bind(identity.portalId, policyId).first<{ id: string }>();
  if (historical) {
    throw new AppError(
      409,
      'delivery_slo_incident_history_retained',
      'This SLO has incident history and cannot be deleted. Disable it to preserve the operational audit record.',
    );
  }
  await deleteRecommendationDeliverySlo(env, identity, policyId);
}
