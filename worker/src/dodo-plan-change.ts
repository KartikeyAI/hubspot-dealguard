import { AppError } from './errors.js';
import { Repository } from './repository.js';
import type { CommercialTier, BillingInterval } from './billing.js';
import type { Env, RequestIdentity } from './types.js';

export type DodoPlanChangeEffectiveAt = 'immediately' | 'next_billing_date';
export type DodoProrationBillingMode =
  | 'prorated_immediately'
  | 'full_immediately'
  | 'difference_immediately'
  | 'do_not_bill';
export type DodoPaymentFailureMode = 'prevent_change' | 'apply_change';

interface DodoPlanEnv extends Env {
  DODO_API_KEY?: string;
  DODO_ENVIRONMENT?: 'test' | 'live';
  DODO_GROWTH_MONTHLY_PRODUCT_ID?: string;
  DODO_GROWTH_YEARLY_PRODUCT_ID?: string;
  DODO_ENTERPRISE_MONTHLY_PRODUCT_ID?: string;
  DODO_ENTERPRISE_YEARLY_PRODUCT_ID?: string;
}

interface DodoSubscriptionRow {
  provider: 'dodo' | 'manual';
  provider_subscription_id: string | null;
  provider_product_id: string | null;
  tier: CommercialTier;
  status: string;
  billing_interval: BillingInterval | null;
  current_period_end: string | null;
}

interface ProviderScheduledChange {
  id?: string;
  effective_at?: string;
  product_id?: string;
  quantity?: number;
}

interface ProviderSubscription {
  subscription_id?: string;
  product_id?: string;
  status?: string;
  next_billing_date?: string;
  scheduled_change?: ProviderScheduledChange | null;
}

export interface DodoPlanChangeInput {
  tier: Extract<CommercialTier, 'growth' | 'enterprise'>;
  interval: Extract<BillingInterval, 'month' | 'year'>;
  effectiveAt: DodoPlanChangeEffectiveAt;
  prorationBillingMode: DodoProrationBillingMode;
  onPaymentFailure: DodoPaymentFailureMode;
  adaptiveCurrencyFeesInclusive?: boolean | null;
}

function config(env: Env): DodoPlanEnv {
  return env as DodoPlanEnv;
}

function baseUrl(env: Env): string {
  return config(env).DODO_ENVIRONMENT === 'live'
    ? 'https://live.dodopayments.com'
    : 'https://test.dodopayments.com';
}

function apiKey(env: Env): string {
  const key = config(env).DODO_API_KEY;
  if (!key) throw new AppError(503, 'billing_not_configured', 'Dodo Payments billing is not configured.');
  return key;
}

function productId(env: Env, tier: DodoPlanChangeInput['tier'], interval: DodoPlanChangeInput['interval']): string {
  const cfg = config(env);
  const value = tier === 'growth'
    ? interval === 'month' ? cfg.DODO_GROWTH_MONTHLY_PRODUCT_ID : cfg.DODO_GROWTH_YEARLY_PRODUCT_ID
    : interval === 'month' ? cfg.DODO_ENTERPRISE_MONTHLY_PRODUCT_ID : cfg.DODO_ENTERPRISE_YEARLY_PRODUCT_ID;
  if (!value) throw new AppError(503, 'billing_product_not_configured', `The ${tier} ${interval}ly Dodo Payments product is not configured.`);
  return value;
}

async function subscription(env: Env, portalId: string): Promise<DodoSubscriptionRow> {
  const row = await env.DB.prepare(
    `SELECT provider, provider_subscription_id, provider_product_id, tier, status, billing_interval, current_period_end
     FROM subscriptions_v2 WHERE portal_id = ?`,
  ).bind(portalId).first<DodoSubscriptionRow>();
  if (!row) throw new AppError(409, 'subscription_missing', 'This HubSpot portal does not have a managed subscription.');
  if (row.provider !== 'dodo' || !row.provider_subscription_id) {
    throw new AppError(409, 'dodo_subscription_required', 'Dodo plan changes are available only for Dodo-managed subscriptions. Manual contracts must be amended through Rokad billing administration.');
  }
  return row;
}

function parseInput(value: unknown): DodoPlanChangeInput {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const tier = input.tier === 'growth' || input.tier === 'enterprise' ? input.tier : null;
  const interval = input.interval === 'month' || input.interval === 'year' ? input.interval : null;
  const effectiveAt: DodoPlanChangeEffectiveAt = input.effectiveAt === 'next_billing_date'
    ? 'next_billing_date'
    : 'immediately';
  const modes: DodoProrationBillingMode[] = [
    'prorated_immediately',
    'full_immediately',
    'difference_immediately',
    'do_not_bill',
  ];
  const prorationBillingMode = modes.includes(input.prorationBillingMode as DodoProrationBillingMode)
    ? input.prorationBillingMode as DodoProrationBillingMode
    : 'prorated_immediately';
  const onPaymentFailure: DodoPaymentFailureMode = input.onPaymentFailure === 'apply_change'
    ? 'apply_change'
    : 'prevent_change';
  if (!tier || !interval) throw new AppError(400, 'plan_change_target_required', 'Choose a Growth or Enterprise target and monthly or annual billing.');
  return {
    tier,
    interval,
    effectiveAt,
    prorationBillingMode,
    onPaymentFailure,
    ...(typeof input.adaptiveCurrencyFeesInclusive === 'boolean'
      ? { adaptiveCurrencyFeesInclusive: input.adaptiveCurrencyFeesInclusive }
      : {}),
  };
}

function providerBody(
  identity: RequestIdentity,
  targetProductId: string,
  input: DodoPlanChangeInput,
): Record<string, unknown> {
  return {
    product_id: targetProductId,
    quantity: 1,
    proration_billing_mode: input.prorationBillingMode,
    effective_at: input.effectiveAt,
    on_payment_failure: input.onPaymentFailure,
    metadata: {
      portal_id: identity.portalId,
      tier: input.tier,
      interval: input.interval,
    },
    ...(input.adaptiveCurrencyFeesInclusive !== undefined
      ? { adaptive_currency_fees_inclusive: input.adaptiveCurrencyFeesInclusive }
      : {}),
  };
}

async function request<T>(env: Env, path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl(env)}${path}`, {
    ...init,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${apiKey(env)}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new AppError(502, 'dodo_plan_change_failed', `Dodo Payments plan change request failed with status ${response.status}.`, detail.slice(0, 1500));
  }
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

async function providerSubscription(env: Env, subscriptionId: string): Promise<ProviderSubscription> {
  return request<ProviderSubscription>(env, `/subscriptions/${encodeURIComponent(subscriptionId)}`, { method: 'GET' });
}

export function providerHasTarget(
  provider: ProviderSubscription,
  targetProductId: string,
  effectiveAt: DodoPlanChangeEffectiveAt,
): boolean {
  return effectiveAt === 'next_billing_date'
    ? provider.scheduled_change?.product_id === targetProductId
    : provider.product_id === targetProductId;
}

async function saveProviderChangeState(
  env: Env,
  portalId: string,
  input: DodoPlanChangeInput,
  targetProductId: string,
  provider: ProviderSubscription,
): Promise<void> {
  const now = new Date().toISOString();
  if (input.effectiveAt === 'next_billing_date') {
    await env.DB.prepare(
      `UPDATE subscriptions_v2 SET scheduled_tier = ?, scheduled_interval = ?, scheduled_product_id = ?,
       scheduled_change_at = ?, scheduled_change_provider_state = 'scheduled', updated_at = ? WHERE portal_id = ?`,
    ).bind(
      input.tier,
      input.interval,
      targetProductId,
      provider.scheduled_change?.effective_at ?? provider.next_billing_date ?? null,
      now,
      portalId,
    ).run();
  } else {
    await env.DB.prepare(
      `UPDATE subscriptions_v2 SET scheduled_tier = NULL, scheduled_interval = NULL,
       scheduled_product_id = NULL, scheduled_change_at = NULL,
       scheduled_change_provider_state = 'awaiting_webhook', updated_at = ? WHERE portal_id = ?`,
    ).bind(now, portalId).run();
  }
}

export async function previewDodoPlanChange(
  env: Env,
  identity: RequestIdentity,
  value: unknown,
): Promise<Record<string, unknown>> {
  const current = await subscription(env, identity.portalId);
  const input = parseInput(value);
  const targetProductId = productId(env, input.tier, input.interval);
  const provider = await providerSubscription(env, current.provider_subscription_id!);
  if (providerHasTarget(provider, targetProductId, input.effectiveAt)) {
    throw new AppError(409, 'plan_already_selected', input.effectiveAt === 'next_billing_date'
      ? 'This Dodo product is already scheduled for the next billing date.'
      : 'This subscription already uses the selected Dodo product.');
  }
  const preview = await request<Record<string, unknown>>(
    env,
    `/subscriptions/${encodeURIComponent(current.provider_subscription_id!)}/change-plan/preview`,
    { method: 'POST', body: JSON.stringify(providerBody(identity, targetProductId, input)) },
  );
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'billing.plan_change_previewed', {
    provider: 'dodo', fromTier: current.tier, fromInterval: current.billing_interval,
    targetTier: input.tier, targetInterval: input.interval, effectiveAt: input.effectiveAt,
    prorationBillingMode: input.prorationBillingMode,
  });
  return {
    provider: 'dodo',
    current: { tier: current.tier, interval: current.billing_interval, productId: provider.product_id ?? current.provider_product_id },
    target: { tier: input.tier, interval: input.interval, productId: targetProductId },
    effectiveAt: input.effectiveAt,
    preview,
  };
}

export async function changeDodoPlan(
  env: Env,
  identity: RequestIdentity,
  value: unknown,
): Promise<{ accepted: true; pendingWebhook: true; effectiveAt: DodoPlanChangeEffectiveAt; recovered: boolean }> {
  const current = await subscription(env, identity.portalId);
  const input = parseInput(value);
  const targetProductId = productId(env, input.tier, input.interval);
  let provider = await providerSubscription(env, current.provider_subscription_id!);
  let recovered = providerHasTarget(provider, targetProductId, input.effectiveAt);
  if (!recovered) {
    try {
      await request<void>(
        env,
        `/subscriptions/${encodeURIComponent(current.provider_subscription_id!)}/change-plan`,
        { method: 'POST', body: JSON.stringify(providerBody(identity, targetProductId, input)) },
      );
    } catch (error) {
      provider = await providerSubscription(env, current.provider_subscription_id!);
      if (!providerHasTarget(provider, targetProductId, input.effectiveAt)) throw error;
      recovered = true;
    }
    provider = await providerSubscription(env, current.provider_subscription_id!);
    if (!providerHasTarget(provider, targetProductId, input.effectiveAt)) {
      throw new AppError(502, 'dodo_plan_change_unconfirmed', 'Dodo Payments accepted the request but the target plan state could not be confirmed. Retry after checking the Dodo subscription.');
    }
  }
  await saveProviderChangeState(env, identity.portalId, input, targetProductId, provider);
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'billing.plan_change_requested', {
    provider: 'dodo', fromTier: current.tier, fromInterval: current.billing_interval,
    targetTier: input.tier, targetInterval: input.interval, targetProductId,
    effectiveAt: input.effectiveAt, prorationBillingMode: input.prorationBillingMode,
    onPaymentFailure: input.onPaymentFailure, recovered,
  });
  return { accepted: true, pendingWebhook: true, effectiveAt: input.effectiveAt, recovered };
}

export async function cancelScheduledDodoPlanChange(
  env: Env,
  identity: RequestIdentity,
): Promise<void> {
  const current = await subscription(env, identity.portalId);
  const provider = await providerSubscription(env, current.provider_subscription_id!);
  if (provider.scheduled_change) {
    try {
      await request<void>(
        env,
        `/subscriptions/${encodeURIComponent(current.provider_subscription_id!)}/change-plan/scheduled`,
        { method: 'DELETE' },
      );
    } catch (error) {
      const refreshed = await providerSubscription(env, current.provider_subscription_id!);
      if (refreshed.scheduled_change) throw error;
    }
  }
  const refreshed = await providerSubscription(env, current.provider_subscription_id!);
  if (refreshed.scheduled_change) {
    throw new AppError(502, 'dodo_scheduled_change_not_cancelled', 'Dodo Payments still reports a scheduled plan change after cancellation.');
  }
  await env.DB.prepare(
    `UPDATE subscriptions_v2 SET scheduled_tier = NULL, scheduled_interval = NULL,
     scheduled_product_id = NULL, scheduled_change_at = NULL,
     scheduled_change_provider_state = 'cancelled', updated_at = ? WHERE portal_id = ?`,
  ).bind(new Date().toISOString(), identity.portalId).run();
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'billing.plan_change_cancelled', {
    provider: 'dodo', subscriptionId: current.provider_subscription_id,
  });
}

export const parseDodoPlanChangeInput = parseInput;
