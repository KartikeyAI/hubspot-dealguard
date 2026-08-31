import { AppError } from './errors.js';
import {
  deleteRecommendationDeliverySlo,
  saveRecommendationDeliverySlo,
  type DeliverySloPolicyRow,
} from './recommendation-delivery-slos.js';
import type { RecommendationDeliverySloPolicy } from './recommendation-delivery-slo-types.js';
import type { Env, RequestIdentity } from './types.js';

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
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

export async function saveGovernedRecommendationDeliverySlo(
  env: Env,
  identity: RequestIdentity,
  value: unknown,
  policyId: string | null = null,
): Promise<RecommendationDeliverySloPolicy> {
  if (policyId) {
    const [current, incident] = await Promise.all([
      env.DB.prepare(
        `SELECT * FROM recommendation_delivery_slo_policies
         WHERE portal_id = ? AND id = ? LIMIT 1`,
      ).bind(identity.portalId, policyId).first<DeliverySloPolicyRow>(),
      env.DB.prepare(
        `SELECT id FROM recommendation_delivery_slo_incidents
         WHERE portal_id = ? AND slo_policy_id = ?
           AND status IN ('open', 'acknowledged') LIMIT 1`,
      ).bind(identity.portalId, policyId).first<{ id: string }>(),
    ]);
    if (current && incident && structuralChange(object(value), current)) {
      throw new AppError(
        409,
        'delivery_slo_active_incident_semantics_locked',
        'Target, threshold, evidence window, persistence, route, severity, and alert-policy settings cannot change while this SLO has an active incident. Disable it or wait for recovery; name and enabled state may still be updated.',
      );
    }
  }
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
