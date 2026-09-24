import { enterpriseAccessContext, permissionMatches, requireEnterprisePermission } from './enterprise-access.js';
import { AppError } from './errors.js';
import type { Env, RequestIdentity } from './types.js';

export const DELIVERY_REASONS = [
  'usage_delivery_provenance_missing', 'usage_delivery_provenance_invalid', 'usage_delivery_authorization_changed',
  'usage_delivery_target_changed', 'usage_delivery_identity_missing', 'usage_delivery_clock_invalid',
  'usage_delivery_window_expired', 'usage_delivery_provider_conflict', 'usage_metadata_invalid', 'usage_metric_invalid',
  'billing_not_configured', 'dodo_usage_transport_failed', 'dodo_usage_response_invalid',
  'dodo_usage_report_failed', 'dodo_usage_not_ingested', 'usage_delivery_internal_error',
] as const;

/** Billing spans the whole portal; record-scoped roles cannot inspect or mutate its commercial account. */
export async function requireBillingManagement(env: Env, identity: RequestIdentity): Promise<void> {
  if (!identity.userId && !identity.userEmail) throw new AppError(403, 'billing_user_required', 'An identified HubSpot user is required.');
  const tenant = await env.DB.prepare('SELECT status FROM tenants WHERE portal_id = ?')
    .bind(identity.portalId).first<{ status: string }>();
  if (tenant?.status !== 'active') throw new AppError(403, 'installation_inactive', 'This DealGuard installation is not active.');
  await requireEnterprisePermission(env, identity, 'billing.manage');
  // No subscription-tier check: administrators must be able to inspect billing after expiry.
}

/** Preserve assigned scopes and billing roles when Enterprise features are unavailable. */
export async function billingAccessFallback(env: Env, identity: RequestIdentity) {
  if (!identity.userId && !identity.userEmail) throw new AppError(403, 'billing_user_required', 'An identified HubSpot user is required.');
  const context = await enterpriseAccessContext(env, identity);
  return { role: context.role, permissions: ['billing.view',
    ...(permissionMatches(context.permissions, 'billing.manage') ? ['billing.manage'] : [])],
    scope: context.scope, bootstrap: context.bootstrap, entitled: false, redacted: true,
    reason: 'enterprise_subscription_required' };
}

export async function billingDeliveryStatus(env: Env, identity: RequestIdentity) {
  await requireBillingManagement(env, identity);
  const placeholders = DELIVERY_REASONS.map(() => '?').join(',');
  const rows = await env.DB.prepare(`SELECT status,
      CASE WHEN error_message IS NULL THEN NULL
        WHEN error_message IN (${placeholders}) THEN error_message ELSE 'legacy_delivery_error' END AS reason,
      COUNT(*) AS events, MIN(occurred_at) AS oldest_observation_at
    FROM billing_usage_events WHERE portal_id = ? GROUP BY status, reason ORDER BY status, reason`)
    .bind(...DELIVERY_REASONS, identity.portalId)
    .all<{ status: string; reason: string | null; events: number | string; oldest_observation_at: string | null }>();
  await requireBillingManagement(env, identity);
  return { generatedAt: new Date().toISOString(), coverage: 'retained_events' as const, readOnly: true,
    outcomes: (rows.results ?? []).map(row => ({ status: row.status, reason: row.reason,
      events: Number(row.events), oldestObservationAt: row.oldest_observation_at })) };
}
