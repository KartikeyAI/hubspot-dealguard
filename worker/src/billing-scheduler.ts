import { AppError } from './errors.js';
import { Repository } from './repository.js';
import type { CommercialTier, SubscriptionStatus, UsageMode, BillingInterval } from './billing.js';
import type { Env, PlanId, RequestIdentity } from './types.js';

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
}

function entitled(status: SubscriptionStatus, graceEndsAt: string | null): boolean {
  if (status === 'active' || status === 'trialing' || status === 'manual') return true;
  return (status === 'on_hold' || status === 'past_due')
    && Boolean(graceEndsAt && Date.parse(graceEndsAt) > Date.now());
}

function planFor(tier: CommercialTier, status: SubscriptionStatus, graceEndsAt: string | null): PlanId {
  if (!entitled(status, graceEndsAt)) return 'free';
  if (tier === 'enterprise') return 'beta_growth';
  if (tier === 'growth') return 'growth';
  return 'free';
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
  await env.DB.prepare(
    `UPDATE subscriptions_v2 SET scheduled_tier = ?, scheduled_change_at = ?,
     scheduled_change_provider_state = 'manual_scheduled', updated_at = ? WHERE portal_id = ?`,
  ).bind(tier, date, new Date().toISOString(), identity.portalId).run();
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'billing.manual_plan_change_scheduled', {
    tier,
    effectiveAt: date,
  });
}

export async function applyManualScheduledPlanChanges(env: Env): Promise<void> {
  const now = new Date().toISOString();
  const rows = await env.DB.prepare(
    `SELECT * FROM subscriptions_v2
     WHERE provider = 'manual' AND scheduled_tier IS NOT NULL
       AND scheduled_change_at IS NOT NULL AND scheduled_change_at <= ?
     ORDER BY scheduled_change_at ASC LIMIT 100`,
  ).bind(now).all<ScheduledSubscriptionRow>();
  for (const row of rows.results ?? []) {
    const tier = row.scheduled_tier ?? 'free';
    const updated = await env.DB.prepare(
      `UPDATE subscriptions_v2 SET tier = ?, scheduled_tier = NULL, scheduled_interval = NULL,
       scheduled_product_id = NULL, scheduled_change_at = NULL,
       scheduled_change_provider_state = 'applied', updated_at = ?
       WHERE portal_id = ? AND provider = 'manual' AND scheduled_tier = ?
         AND scheduled_change_at IS NOT NULL AND scheduled_change_at <= ?`,
    ).bind(tier, now, row.portal_id, tier, now).run();
    if (Number(updated.meta?.changes ?? 0) !== 1) continue;
    const plan = planFor(tier, row.status, row.grace_ends_at);
    await env.DB.prepare(
      `UPDATE tenants SET commercial_tier = ?, plan = ?, updated_at = ? WHERE portal_id = ?`,
    ).bind(tier, plan, now, row.portal_id).run();
    await new Repository(env).audit(row.portal_id, null, null, 'billing.manual_plan_change_applied', { tier });
  }
}
