import { sha256Hex } from './crypto.js';
import { AppError } from './errors.js';
import { Repository } from './repository.js';
import type { Env, PlanId, RequestIdentity } from './types.js';

export type CommercialTier = 'free' | 'growth' | 'enterprise';
export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'unpaid' | 'canceled' | 'incomplete' | 'paused' | 'manual';

interface BillingEnv extends Env {
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_GROWTH_MONTHLY_PRICE_ID?: string;
  STRIPE_GROWTH_YEARLY_PRICE_ID?: string;
  STRIPE_ENTERPRISE_MONTHLY_PRICE_ID?: string;
  STRIPE_ENTERPRISE_YEARLY_PRICE_ID?: string;
}

interface SubscriptionRow {
  portal_id: string;
  provider: 'stripe' | 'manual';
  provider_customer_id: string | null;
  provider_subscription_id: string | null;
  tier: CommercialTier;
  status: SubscriptionStatus;
  billing_interval: 'month' | 'year' | null;
  current_period_end: string | null;
  cancel_at_period_end: number;
  trial_ends_at: string | null;
  grace_ends_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BillingStatus {
  tier: CommercialTier;
  status: SubscriptionStatus | 'none';
  provider: 'stripe' | 'manual' | null;
  currentPeriodEnd: string | null;
  trialEndsAt: string | null;
  graceEndsAt: string | null;
  cancelAtPeriodEnd: boolean;
  entitled: boolean;
  checkoutConfigured: boolean;
  portalConfigured: boolean;
}

interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

const STRIPE_VERSION = '2026-02-25.clover';
const encoder = new TextEncoder();

function billingEnv(env: Env): BillingEnv {
  return env as BillingEnv;
}

function requireStripe(env: Env): BillingEnv {
  const configured = billingEnv(env);
  if (!configured.STRIPE_SECRET_KEY) throw new AppError(503, 'billing_not_configured', 'Stripe billing is not configured.');
  return configured;
}

function priceFor(env: BillingEnv, tier: CommercialTier, interval: 'month' | 'year'): string {
  const price = tier === 'growth'
    ? interval === 'month' ? env.STRIPE_GROWTH_MONTHLY_PRICE_ID : env.STRIPE_GROWTH_YEARLY_PRICE_ID
    : tier === 'enterprise'
      ? interval === 'month' ? env.STRIPE_ENTERPRISE_MONTHLY_PRICE_ID : env.STRIPE_ENTERPRISE_YEARLY_PRICE_ID
      : undefined;
  if (!price) throw new AppError(503, 'billing_price_not_configured', `The ${tier} ${interval}ly Stripe price is not configured.`);
  return price;
}

function tierForPrice(env: BillingEnv, priceId: string): { tier: CommercialTier; interval: 'month' | 'year' } | null {
  const prices: Array<[string | undefined, CommercialTier, 'month' | 'year']> = [
    [env.STRIPE_GROWTH_MONTHLY_PRICE_ID, 'growth', 'month'],
    [env.STRIPE_GROWTH_YEARLY_PRICE_ID, 'growth', 'year'],
    [env.STRIPE_ENTERPRISE_MONTHLY_PRICE_ID, 'enterprise', 'month'],
    [env.STRIPE_ENTERPRISE_YEARLY_PRICE_ID, 'enterprise', 'year'],
  ];
  const match = prices.find(([configured]) => configured === priceId);
  return match ? { tier: match[1], interval: match[2] } : null;
}

async function stripeRequest<T>(env: Env, path: string, body: URLSearchParams): Promise<T> {
  const configured = requireStripe(env);
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${configured.STRIPE_SECRET_KEY}`,
      'content-type': 'application/x-www-form-urlencoded;charset=utf-8',
      'stripe-version': STRIPE_VERSION,
    },
    body,
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new AppError(502, 'stripe_api_error', `Stripe request failed with status ${response.status}.`, detail.slice(0, 1000));
  }
  return await response.json() as T;
}

export async function createCheckoutSession(
  env: Env,
  identity: RequestIdentity,
  tier: CommercialTier,
  interval: 'month' | 'year',
): Promise<{ url: string }> {
  if (!['growth', 'enterprise'].includes(tier)) throw new AppError(400, 'invalid_checkout_tier', 'Choose Growth or Enterprise.');
  const configured = requireStripe(env);
  const existing = await env.DB.prepare(`SELECT provider_customer_id FROM subscriptions WHERE portal_id = ?`).bind(identity.portalId).first<{ provider_customer_id: string | null }>();
  const body = new URLSearchParams({
    mode: 'subscription',
    client_reference_id: identity.portalId,
    'line_items[0][price]': priceFor(configured, tier, interval),
    'line_items[0][quantity]': '1',
    success_url: `${env.APP_BASE_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${env.APP_BASE_URL}/billing/canceled`,
    'metadata[portal_id]': identity.portalId,
    'metadata[tier]': tier,
    'subscription_data[metadata][portal_id]': identity.portalId,
    'subscription_data[metadata][tier]': tier,
    allow_promotion_codes: 'true',
  });
  if (existing?.provider_customer_id) body.set('customer', existing.provider_customer_id);
  else if (identity.userEmail) body.set('customer_email', identity.userEmail);
  const session = await stripeRequest<{ url: string | null }>(env, '/checkout/sessions', body);
  if (!session.url) throw new AppError(502, 'stripe_checkout_url_missing', 'Stripe did not return a checkout URL.');
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'billing.checkout_created', { tier, interval });
  return { url: session.url };
}

export async function createCustomerPortalSession(env: Env, identity: RequestIdentity): Promise<{ url: string }> {
  const existing = await env.DB.prepare(`SELECT provider_customer_id FROM subscriptions WHERE portal_id = ?`).bind(identity.portalId).first<{ provider_customer_id: string | null }>();
  if (!existing?.provider_customer_id) throw new AppError(409, 'billing_customer_missing', 'No Stripe customer is associated with this HubSpot portal.');
  const session = await stripeRequest<{ url: string }>(env, '/billing_portal/sessions', new URLSearchParams({
    customer: existing.provider_customer_id,
    return_url: 'https://app.hubspot.com',
  }));
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'billing.portal_opened', {});
  return { url: session.url };
}

function entitledStatus(status: SubscriptionStatus, graceEndsAt: string | null): boolean {
  if (['trialing', 'active', 'manual'].includes(status)) return true;
  return status === 'past_due' && Boolean(graceEndsAt && Date.parse(graceEndsAt) > Date.now());
}

export async function getBillingStatus(env: Env, portalId: string): Promise<BillingStatus> {
  const row = await env.DB.prepare(`SELECT * FROM subscriptions WHERE portal_id = ?`).bind(portalId).first<SubscriptionRow>();
  const configured = billingEnv(env);
  if (!row) {
    const tenant = await env.DB.prepare(`SELECT commercial_tier, trial_ends_at FROM tenants WHERE portal_id = ?`).bind(portalId).first<{ commercial_tier?: CommercialTier; trial_ends_at?: string | null }>();
    const tier = tenant?.commercial_tier ?? 'free';
    return {
      tier,
      status: 'none',
      provider: null,
      currentPeriodEnd: null,
      trialEndsAt: tenant?.trial_ends_at ?? null,
      graceEndsAt: null,
      cancelAtPeriodEnd: false,
      entitled: tier !== 'free' && Boolean(tenant?.trial_ends_at && Date.parse(tenant.trial_ends_at) > Date.now()),
      checkoutConfigured: Boolean(configured.STRIPE_SECRET_KEY),
      portalConfigured: false,
    };
  }
  return {
    tier: row.tier,
    status: row.status,
    provider: row.provider,
    currentPeriodEnd: row.current_period_end,
    trialEndsAt: row.trial_ends_at,
    graceEndsAt: row.grace_ends_at,
    cancelAtPeriodEnd: Boolean(row.cancel_at_period_end),
    entitled: entitledStatus(row.status, row.grace_ends_at),
    checkoutConfigured: Boolean(configured.STRIPE_SECRET_KEY),
    portalConfigured: Boolean(row.provider_customer_id && configured.STRIPE_SECRET_KEY),
  };
}

export async function requireCommercialTier(env: Env, portalId: string, minimum: CommercialTier): Promise<BillingStatus> {
  const status = await getBillingStatus(env, portalId);
  const order: Record<CommercialTier, number> = { free: 0, growth: 1, enterprise: 2 };
  if (!status.entitled || order[status.tier] < order[minimum]) {
    throw new AppError(403, 'subscription_required', `This capability requires an active ${minimum === 'enterprise' ? 'Enterprise' : 'Growth'} subscription.`);
  }
  return status;
}

async function applySubscription(
  env: Env,
  portalId: string,
  input: {
    provider: 'stripe' | 'manual'; customerId: string | null; subscriptionId: string | null;
    tier: CommercialTier; status: SubscriptionStatus; interval: 'month' | 'year' | null;
    currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean; trialEndsAt: string | null; graceEndsAt: string | null;
  },
): Promise<void> {
  const now = new Date().toISOString();
  const internalPlan: PlanId = input.tier === 'enterprise' ? 'beta_growth' : input.tier === 'growth' ? 'growth' : 'free';
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO subscriptions (portal_id, provider, provider_customer_id, provider_subscription_id, tier, status, billing_interval, current_period_end, cancel_at_period_end, trial_ends_at, grace_ends_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(portal_id) DO UPDATE SET provider = excluded.provider, provider_customer_id = excluded.provider_customer_id,
       provider_subscription_id = excluded.provider_subscription_id, tier = excluded.tier, status = excluded.status,
       billing_interval = excluded.billing_interval, current_period_end = excluded.current_period_end,
       cancel_at_period_end = excluded.cancel_at_period_end, trial_ends_at = excluded.trial_ends_at,
       grace_ends_at = excluded.grace_ends_at, updated_at = excluded.updated_at`
    ).bind(portalId, input.provider, input.customerId, input.subscriptionId, input.tier, input.status, input.interval, input.currentPeriodEnd, input.cancelAtPeriodEnd ? 1 : 0, input.trialEndsAt, input.graceEndsAt, now, now),
    env.DB.prepare(`UPDATE tenants SET commercial_tier = ?, trial_ends_at = ?, plan = ?, updated_at = ? WHERE portal_id = ?`)
      .bind(input.tier, input.trialEndsAt, internalPlan, now, portalId),
  ]);
}

export async function setManualSubscription(
  env: Env,
  portalId: string,
  tier: CommercialTier,
  currentPeriodEnd: string | null,
): Promise<void> {
  if (!['growth', 'enterprise'].includes(tier)) throw new AppError(400, 'manual_tier_invalid', 'Manual subscriptions support Growth or Enterprise.');
  await applySubscription(env, portalId, {
    provider: 'manual', customerId: null, subscriptionId: null, tier, status: 'manual', interval: null,
    currentPeriodEnd, cancelAtPeriodEnd: false, trialEndsAt: null, graceEndsAt: currentPeriodEnd,
  });
  await new Repository(env).audit(portalId, null, null, 'billing.manual_entitlement_set', { tier, currentPeriodEnd });
}

function constantTimeHex(left: string, right: string): boolean {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.max(a.length, b.length);
  let mismatch = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) mismatch |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return mismatch === 0;
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function verifyStripeWebhook(request: Request, env: Env): Promise<string> {
  const secret = billingEnv(env).STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new AppError(503, 'stripe_webhook_not_configured', 'Stripe webhook verification is not configured.');
  const body = await request.clone().text();
  const header = request.headers.get('stripe-signature') ?? '';
  const values = new Map<string, string[]>();
  for (const part of header.split(',')) {
    const [key, value] = part.split('=', 2);
    if (!key || !value) continue;
    values.set(key, [...(values.get(key) ?? []), value]);
  }
  const timestamp = Number(values.get('t')?.[0]);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 300) throw new AppError(401, 'stripe_signature_expired', 'Stripe webhook timestamp is outside the accepted window.');
  const expected = await hmacHex(secret, `${timestamp}.${body}`);
  if (!(values.get('v1') ?? []).some((signature) => constantTimeHex(expected, signature))) throw new AppError(401, 'stripe_signature_invalid', 'Stripe webhook signature could not be verified.');
  return body;
}

function unixDate(value: unknown): string | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? new Date(numeric * 1000).toISOString() : null;
}

function objectString(object: Record<string, unknown>, key: string): string | null {
  const value = object[key];
  return typeof value === 'string' && value ? value : null;
}

function metadata(object: Record<string, unknown>): Record<string, string> {
  const value = object.metadata;
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

function subscriptionStatus(value: unknown): SubscriptionStatus {
  const allowed: SubscriptionStatus[] = ['trialing', 'active', 'past_due', 'unpaid', 'canceled', 'incomplete', 'paused'];
  return allowed.includes(value as SubscriptionStatus) ? value as SubscriptionStatus : 'incomplete';
}

async function processSubscriptionObject(env: Env, object: Record<string, unknown>): Promise<void> {
  const configured = billingEnv(env);
  const meta = metadata(object);
  let portalId = meta.portal_id ?? null;
  const subscriptionId = objectString(object, 'id');
  if (!portalId && subscriptionId) {
    const existing = await env.DB.prepare(`SELECT portal_id FROM subscriptions WHERE provider_subscription_id = ?`).bind(subscriptionId).first<{ portal_id: string }>();
    portalId = existing?.portal_id ?? null;
  }
  if (!portalId) throw new AppError(400, 'stripe_portal_metadata_missing', 'Stripe subscription is missing DealGuard portal metadata.');
  const items = object.items && typeof object.items === 'object' ? (object.items as Record<string, unknown>).data : null;
  const firstItem = Array.isArray(items) && items[0] && typeof items[0] === 'object' ? items[0] as Record<string, unknown> : {};
  const price = firstItem.price && typeof firstItem.price === 'object' ? firstItem.price as Record<string, unknown> : {};
  const matched = tierForPrice(configured, objectString(price, 'id') ?? '');
  const tier = (meta.tier === 'enterprise' || meta.tier === 'growth' ? meta.tier : matched?.tier) ?? 'free';
  const status = subscriptionStatus(object.status);
  const currentPeriodEnd = unixDate(object.current_period_end);
  const trialEndsAt = unixDate(object.trial_end);
  const graceEndsAt = status === 'past_due' ? new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString() : null;
  await applySubscription(env, portalId, {
    provider: 'stripe', customerId: objectString(object, 'customer'), subscriptionId,
    tier, status, interval: matched?.interval ?? null, currentPeriodEnd,
    cancelAtPeriodEnd: object.cancel_at_period_end === true, trialEndsAt, graceEndsAt,
  });
}

export async function processStripeWebhook(env: Env, rawBody: string): Promise<void> {
  const event = JSON.parse(rawBody) as StripeEvent;
  if (!event.id || !event.type || !event.data?.object) throw new AppError(400, 'stripe_event_invalid', 'Stripe webhook payload is invalid.');
  const payloadHash = await sha256Hex(rawBody);
  const existing = await env.DB.prepare(`SELECT status FROM billing_events WHERE provider = 'stripe' AND provider_event_id = ?`).bind(event.id).first<{ status: string }>();
  if (existing?.status === 'processed' || existing?.status === 'ignored') return;
  const now = new Date().toISOString();
  if (!existing) {
    await env.DB.prepare(`INSERT INTO billing_events (id, provider, provider_event_id, event_type, status, payload_hash, received_at) VALUES (?, 'stripe', ?, ?, 'received', ?, ?)`)
      .bind(crypto.randomUUID(), event.id, event.type, payloadHash, now).run();
  }
  try {
    if (event.type.startsWith('customer.subscription.')) {
      await processSubscriptionObject(env, event.data.object);
    } else if (event.type === 'checkout.session.completed') {
      const object = event.data.object;
      const portalId = objectString(object, 'client_reference_id') ?? metadata(object).portal_id;
      if (portalId) {
        const current = await env.DB.prepare(`SELECT * FROM subscriptions WHERE portal_id = ?`).bind(portalId).first<SubscriptionRow>();
        await applySubscription(env, portalId, {
          provider: 'stripe', customerId: objectString(object, 'customer'), subscriptionId: objectString(object, 'subscription'),
          tier: metadata(object).tier === 'enterprise' ? 'enterprise' : 'growth', status: current?.status ?? 'incomplete',
          interval: current?.billing_interval ?? null, currentPeriodEnd: current?.current_period_end ?? null,
          cancelAtPeriodEnd: Boolean(current?.cancel_at_period_end), trialEndsAt: current?.trial_ends_at ?? null, graceEndsAt: current?.grace_ends_at ?? null,
        });
      }
    } else {
      await env.DB.prepare(`UPDATE billing_events SET status = 'ignored', processed_at = ? WHERE provider = 'stripe' AND provider_event_id = ?`).bind(new Date().toISOString(), event.id).run();
      return;
    }
    await env.DB.prepare(`UPDATE billing_events SET status = 'processed', processed_at = ?, error_message = NULL WHERE provider = 'stripe' AND provider_event_id = ?`).bind(new Date().toISOString(), event.id).run();
  } catch (error) {
    await env.DB.prepare(`UPDATE billing_events SET status = 'failed', processed_at = ?, error_message = ? WHERE provider = 'stripe' AND provider_event_id = ?`)
      .bind(new Date().toISOString(), (error instanceof Error ? error.message : String(error)).slice(0, 1000), event.id).run();
    throw error;
  }
}
