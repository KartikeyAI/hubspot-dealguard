import { AppError } from './errors.js';
import { entitlementPlan, rowEntitled } from './billing-entitlements.js';
import type { CommercialTier, SubscriptionStatus, UsageMode, BillingInterval } from './billing.js';
import type { Env, RequestIdentity } from './types.js';

interface ScheduledSubscriptionRow {
  portal_id: string;
  provider: 'dodo' | 'manual';
  provider_customer_id: string | null;
  provider_subscription_id: string | null;
  provider_product_id: string | null;
  tier: CommercialTier;
  status: SubscriptionStatus;
  billing_interval: BillingInterval | null;
  usage_mode: UsageMode;
  overage_enabled: number;
  currency: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  trial_ends_at: string | null;
  grace_ends_at: string | null;
  cancel_at_period_end: number;
  contract_reference: string | null;
  purchase_order_reference: string | null;
  scheduled_tier: CommercialTier | null;
  scheduled_change_at: string | null;
  state_hash: string;
}

export async function scheduleManualPlanChange(
  env: Env,
  identity: RequestIdentity,
  tier: CommercialTier,
  effectiveAt: string,
): Promise<void> {
  if (!['free', 'growth', 'enterprise'].includes(tier)) {
    throw new AppError(400, 'scheduled_tier_invalid', 'Choose a valid commercial tier.');
  }
  const parsed = Date.parse(effectiveAt);
  if (!Number.isFinite(parsed) || parsed <= Date.now()) {
    throw new AppError(400, 'scheduled_change_date_invalid', 'Scheduled changes must use a future date.');
  }
  const subscription = await env.DB.prepare(
    `SELECT provider FROM subscriptions_v2 WHERE portal_id = ?`,
  ).bind(identity.portalId).first<{ provider: 'dodo' | 'manual' }>();
  if (!subscription) throw new AppError(409, 'subscription_missing', 'This portal does not have a managed subscription.');
  if (subscription.provider !== 'manual') {
    throw new AppError(409, 'provider_schedule_required', 'Dodo subscriptions must be changed through the Dodo plan-change API so provider billing remains authoritative.');
  }
  const date = new Date(parsed).toISOString();
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    `WITH changed AS (
      UPDATE subscriptions_v2 SET scheduled_tier = ?, scheduled_change_at = ?,
        scheduled_change_provider_state = 'manual_scheduled', updated_at = ?
      WHERE portal_id = ? AND provider = 'manual' RETURNING portal_id
    ) INSERT INTO audit_events (id, portal_id, user_id, user_email, action, metadata_json, created_at)
      SELECT ?, portal_id, ?, ?, 'billing.manual_plan_change_scheduled', ?, ? FROM changed`,
  ).bind(tier, date, now, identity.portalId, crypto.randomUUID(), identity.userId, identity.userEmail,
    JSON.stringify({ tier, effectiveAt: date }), now).run();
  if (Number(result.meta?.changes ?? 0) !== 1) throw new AppError(409, 'subscription_changed', 'The subscription changed. Reload billing before scheduling a change.');
}

export async function applyManualScheduledPlanChanges(env: Env): Promise<void> {
  const now = new Date().toISOString();
  const rows = await env.DB.prepare(
    `SELECT s.*, md5(row_to_json(s)::text) AS state_hash FROM subscriptions_v2 s
     WHERE provider = 'manual' AND scheduled_tier IS NOT NULL
       AND scheduled_change_at IS NOT NULL AND scheduled_change_at <= ?
     ORDER BY scheduled_change_at ASC LIMIT 100`,
  ).bind(now).all<ScheduledSubscriptionRow>();
  for (const row of rows.results ?? []) {
    const tier = row.scheduled_tier ?? 'free';
    const plan = entitlementPlan(tier, rowEntitled(row, Date.parse(now)));
    // The exact inspected contract, tenant plan and audit move together. A provider
    // conversion or contract revision while this job is running makes it a no-op.
    await env.DB.prepare(
      `WITH changed AS (
        UPDATE subscriptions_v2 AS s SET tier = ?, scheduled_tier = NULL, scheduled_interval = NULL,
          scheduled_product_id = NULL, scheduled_change_at = NULL,
          scheduled_change_provider_state = 'applied', updated_at = ?
        WHERE portal_id = ? AND provider = 'manual' AND scheduled_tier = ?
          AND scheduled_change_at IS NOT NULL AND scheduled_change_at <= ?
          AND md5(row_to_json(s)::text) = ? RETURNING portal_id
      ), updated_tenant AS (
        UPDATE tenants AS t SET commercial_tier = ?, plan = ?, updated_at = ?
        FROM changed WHERE t.portal_id = changed.portal_id RETURNING t.portal_id
      ) INSERT INTO audit_events (id, portal_id, action, metadata_json, created_at)
        SELECT ?, portal_id, 'billing.manual_plan_change_applied', ?, ? FROM updated_tenant`,
    ).bind(tier, now, row.portal_id, tier, now, row.state_hash, tier, plan, now,
      crypto.randomUUID(), JSON.stringify({ tier }), now).run();
  }
}
