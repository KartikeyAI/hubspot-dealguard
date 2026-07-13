import { sha256Hex } from './crypto.js';
import { AppError } from './errors.js';
import { Repository } from './repository.js';
import type { Env, PlanId, RequestIdentity } from './types.js';

export type CommercialTier = 'free' | 'growth' | 'enterprise';
export type SubscriptionStatus = 'pending' | 'trialing' | 'active' | 'on_hold' | 'past_due' | 'failed' | 'expired' | 'cancelled' | 'manual';
export type UsageMode = 'capped' | 'metered';
export type BillingInterval = 'month' | 'year' | 'contract';
export type BillableMetric = 'ai_credit' | 'active_deal_overage' | 'event_overage' | 'retention_gb_month';

interface DodoBillingEnv extends Env {
  DODO_API_KEY?: string;
  DODO_WEBHOOK_SECRET?: string;
  DODO_ENVIRONMENT?: 'test' | 'live';
  DODO_GROWTH_MONTHLY_PRODUCT_ID?: string;
  DODO_GROWTH_YEARLY_PRODUCT_ID?: string;
  DODO_ENTERPRISE_MONTHLY_PRODUCT_ID?: string;
  DODO_ENTERPRISE_YEARLY_PRODUCT_ID?: string;
  DODO_AI_CREDIT_EVENT_NAME?: string;
  DODO_ACTIVE_DEAL_EVENT_NAME?: string;
  DODO_EVENT_OVERAGE_EVENT_NAME?: string;
  DODO_RETENTION_EVENT_NAME?: string;
}

interface SubscriptionRow {
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
  created_at: string;
  updated_at: string;
}

export interface BillingAllowance {
  metric: BillableMetric;
  includedQuantity: number;
  consumedQuantity: number;
  remainingQuantity: number | null;
  hardLimit: number | null;
  overageEnabled: boolean;
}

export interface BillingStatus {
  tier: CommercialTier;
  status: SubscriptionStatus | 'none';
  provider: 'dodo' | 'manual' | null;
  customerId: string | null;
  subscriptionId: string | null;
  productId: string | null;
  billingInterval: BillingInterval | null;
  usageMode: UsageMode;
  overageEnabled: boolean;
  currency: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  trialEndsAt: string | null;
  graceEndsAt: string | null;
  cancelAtPeriodEnd: boolean;
  contractReference: string | null;
  purchaseOrderReference: string | null;
  scheduledTier: CommercialTier | null;
  scheduledChangeAt: string | null;
  entitled: boolean;
  checkoutConfigured: boolean;
  portalConfigured: boolean;
  allowances: BillingAllowance[];
}

interface DodoWebhookEnvelope {
  id?: string;
  type?: string;
  data?: unknown;
  created_at?: string;
  timestamp?: string;
}

const encoder = new TextEncoder();
const DEFAULT_ALLOWANCES: Record<CommercialTier, Record<BillableMetric, { included: number; hard: number | null; overage: boolean }>> = {
  free: {
    ai_credit: { included: 0, hard: 0, overage: false },
    active_deal_overage: { included: 250, hard: 250, overage: false },
    event_overage: { included: 10000, hard: 10000, overage: false },
    retention_gb_month: { included: 0.25, hard: 0.25, overage: false },
  },
  growth: {
    ai_credit: { included: 500, hard: 2000, overage: false },
    active_deal_overage: { included: 5000, hard: 10000, overage: false },
    event_overage: { included: 250000, hard: 1000000, overage: false },
    retention_gb_month: { included: 5, hard: 20, overage: false },
  },
  enterprise: {
    ai_credit: { included: 5000, hard: null, overage: true },
    active_deal_overage: { included: 25000, hard: null, overage: true },
    event_overage: { included: 2500000, hard: null, overage: true },
    retention_gb_month: { included: 50, hard: null, overage: true },
  },
};

function configured(env: Env): DodoBillingEnv {
  return env as DodoBillingEnv;
}

function apiBase(env: Env): string {
  return configured(env).DODO_ENVIRONMENT === 'live'
    ? 'https://live.dodopayments.com'
    : 'https://test.dodopayments.com';
}

function requireDodo(env: Env): DodoBillingEnv {
  const result = configured(env);
  if (!result.DODO_API_KEY) throw new AppError(503, 'billing_not_configured', 'Dodo Payments billing is not configured.');
  return result;
}

function productFor(env: DodoBillingEnv, tier: CommercialTier, interval: 'month' | 'year'): string {
  const product = tier === 'growth'
    ? interval === 'month' ? env.DODO_GROWTH_MONTHLY_PRODUCT_ID : env.DODO_GROWTH_YEARLY_PRODUCT_ID
    : tier === 'enterprise'
      ? interval === 'month' ? env.DODO_ENTERPRISE_MONTHLY_PRODUCT_ID : env.DODO_ENTERPRISE_YEARLY_PRODUCT_ID
      : undefined;
  if (!product) throw new AppError(503, 'billing_product_not_configured', `The ${tier} ${interval}ly Dodo Payments product is not configured.`);
  return product;
}

function tierForProduct(env: DodoBillingEnv, productId: string): { tier: CommercialTier; interval: 'month' | 'year' } | null {
  const products: Array<[string | undefined, CommercialTier, 'month' | 'year']> = [
    [env.DODO_GROWTH_MONTHLY_PRODUCT_ID, 'growth', 'month'],
    [env.DODO_GROWTH_YEARLY_PRODUCT_ID, 'growth', 'year'],
    [env.DODO_ENTERPRISE_MONTHLY_PRODUCT_ID, 'enterprise', 'month'],
    [env.DODO_ENTERPRISE_YEARLY_PRODUCT_ID, 'enterprise', 'year'],
  ];
  const match = products.find(([id]) => id === productId);
  return match ? { tier: match[1], interval: match[2] } : null;
}

async function dodoRequest<T>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  const cfg = requireDodo(env);
  const response = await fetch(`${apiBase(env)}${path}`, {
    ...init,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${cfg.DODO_API_KEY}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new AppError(502, 'dodo_api_error', `Dodo Payments request failed with status ${response.status}.`, detail.slice(0, 1500));
  }
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

function normalizeEmail(value: string | null): string | null {
  if (!value) return null;
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

export async function createCheckoutSession(
  env: Env,
  identity: RequestIdentity,
  tier: CommercialTier,
  interval: 'month' | 'year',
  options: { usageMode?: UsageMode; overageEnabled?: boolean } = {},
): Promise<{ url: string; sessionId: string | null }> {
  if (!['growth', 'enterprise'].includes(tier)) throw new AppError(400, 'invalid_checkout_tier', 'Choose Growth or Enterprise.');
  const cfg = requireDodo(env);
  const current = await env.DB.prepare(`SELECT provider_customer_id FROM subscriptions_v2 WHERE portal_id = ?`)
    .bind(identity.portalId).first<{ provider_customer_id: string | null }>();
  const metadata = {
    portal_id: identity.portalId,
    tier,
    interval,
    usage_mode: options.usageMode === 'metered' ? 'metered' : 'capped',
    overage_enabled: options.overageEnabled === true ? 'true' : 'false',
  };
  const body: Record<string, unknown> = {
    product_cart: [{ product_id: productFor(cfg, tier, interval), quantity: 1 }],
    return_url: `${env.APP_BASE_URL}/billing/success`,
    cancel_url: `${env.APP_BASE_URL}/billing/canceled`,
    metadata,
    subscription_data: { metadata },
  };
  if (current?.provider_customer_id) body.customer = { customer_id: current.provider_customer_id };
  else {
    const email = normalizeEmail(identity.userEmail);
    if (!email) throw new AppError(400, 'billing_email_required', 'A valid HubSpot user email is required to start Dodo Payments checkout.');
    body.customer = { email };
  }
  const result = await dodoRequest<{ checkout_url?: string; session_id?: string }>(env, '/checkouts', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!result.checkout_url) throw new AppError(502, 'dodo_checkout_url_missing', 'Dodo Payments did not return a checkout URL.');
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'billing.checkout_created', { provider: 'dodo', tier, interval, ...metadata });
  return { url: result.checkout_url, sessionId: result.session_id ?? null };
}

export async function createCustomerPortalSession(env: Env, identity: RequestIdentity): Promise<{ url: string }> {
  const subscription = await env.DB.prepare(`SELECT provider_customer_id, provider FROM subscriptions_v2 WHERE portal_id = ?`)
    .bind(identity.portalId).first<{ provider_customer_id: string | null; provider: string }>();
  if (!subscription?.provider_customer_id || subscription.provider !== 'dodo') {
    throw new AppError(409, 'billing_customer_missing', 'No Dodo Payments customer is associated with this HubSpot portal.');
  }
  const result = await dodoRequest<{ link?: string }>(
    env,
    `/customers/${encodeURIComponent(subscription.provider_customer_id)}/customer-portal/session?return_url=${encodeURIComponent('https://app.hubspot.com')}`,
    { method: 'POST', body: JSON.stringify({}) },
  );
  if (!result.link) throw new AppError(502, 'dodo_portal_url_missing', 'Dodo Payments did not return a customer portal link.');
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'billing.portal_opened', { provider: 'dodo' });
  return { url: result.link };
}

function entitledStatus(status: SubscriptionStatus, graceEndsAt: string | null): boolean {
  if (['trialing', 'active', 'manual'].includes(status)) return true;
  return (status === 'on_hold' || status === 'past_due') && Boolean(graceEndsAt && Date.parse(graceEndsAt) > Date.now());
}

function periodStart(row: SubscriptionRow | null): string {
  if (row?.current_period_start) return row.current_period_start;
  const date = new Date();
  date.setUTCDate(1);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString();
}

async function allowanceViews(env: Env, portalId: string, tier: CommercialTier, row: SubscriptionRow | null): Promise<BillingAllowance[]> {
  const explicit = await env.DB.prepare(`SELECT metric, included_quantity, hard_limit, overage_enabled FROM billing_allowances WHERE portal_id = ?`)
    .bind(portalId).all<{ metric: BillableMetric; included_quantity: number; hard_limit: number | null; overage_enabled: number }>();
  const overrides = new Map((explicit.results ?? []).map((item) => [item.metric, item]));
  const start = periodStart(row);
  const usage = await env.DB.prepare(
    `SELECT event_name, COALESCE(SUM(quantity), 0) AS quantity FROM billing_usage_events
     WHERE portal_id = ? AND occurred_at >= ? AND status IN ('pending', 'reported') GROUP BY event_name`
  ).bind(portalId, start).all<{ event_name: BillableMetric; quantity: number }>();
  const consumed = new Map((usage.results ?? []).map((item) => [item.event_name, Number(item.quantity)]));
  return (Object.keys(DEFAULT_ALLOWANCES[tier]) as BillableMetric[]).map((metric) => {
    const defaults = DEFAULT_ALLOWANCES[tier][metric];
    const override = overrides.get(metric);
    const includedQuantity = Number(override?.included_quantity ?? defaults.included);
    const hardLimit = override?.hard_limit === null || override?.hard_limit === undefined ? defaults.hard : Number(override.hard_limit);
    const consumedQuantity = consumed.get(metric) ?? 0;
    return {
      metric,
      includedQuantity,
      consumedQuantity,
      remainingQuantity: hardLimit === null ? null : Math.max(0, hardLimit - consumedQuantity),
      hardLimit,
      overageEnabled: Boolean(override?.overage_enabled ?? (row?.overage_enabled ?? (defaults.overage ? 1 : 0))),
    };
  });
}

export async function getBillingStatus(env: Env, portalId: string): Promise<BillingStatus> {
  const row = await env.DB.prepare(`SELECT * FROM subscriptions_v2 WHERE portal_id = ?`).bind(portalId).first<SubscriptionRow>();
  const cfg = configured(env);
  if (!row) {
    const tenant = await env.DB.prepare(`SELECT commercial_tier, trial_ends_at FROM tenants WHERE portal_id = ?`)
      .bind(portalId).first<{ commercial_tier?: CommercialTier; trial_ends_at?: string | null }>();
    const tier = tenant?.commercial_tier ?? 'free';
    return {
      tier,
      status: 'none',
      provider: null,
      customerId: null,
      subscriptionId: null,
      productId: null,
      billingInterval: null,
      usageMode: 'capped',
      overageEnabled: false,
      currency: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      trialEndsAt: tenant?.trial_ends_at ?? null,
      graceEndsAt: null,
      cancelAtPeriodEnd: false,
      contractReference: null,
      purchaseOrderReference: null,
      scheduledTier: null,
      scheduledChangeAt: null,
      entitled: tier !== 'free' && Boolean(tenant?.trial_ends_at && Date.parse(tenant.trial_ends_at) > Date.now()),
      checkoutConfigured: Boolean(cfg.DODO_API_KEY),
      portalConfigured: false,
      allowances: await allowanceViews(env, portalId, tier, null),
    };
  }
  return {
    tier: row.tier,
    status: row.status,
    provider: row.provider,
    customerId: row.provider_customer_id,
    subscriptionId: row.provider_subscription_id,
    productId: row.provider_product_id,
    billingInterval: row.billing_interval,
    usageMode: row.usage_mode,
    overageEnabled: Boolean(row.overage_enabled),
    currency: row.currency,
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    trialEndsAt: row.trial_ends_at,
    graceEndsAt: row.grace_ends_at,
    cancelAtPeriodEnd: Boolean(row.cancel_at_period_end),
    contractReference: row.contract_reference,
    purchaseOrderReference: row.purchase_order_reference,
    scheduledTier: row.scheduled_tier,
    scheduledChangeAt: row.scheduled_change_at,
    entitled: entitledStatus(row.status, row.grace_ends_at),
    checkoutConfigured: Boolean(cfg.DODO_API_KEY),
    portalConfigured: Boolean(row.provider === 'dodo' && row.provider_customer_id && cfg.DODO_API_KEY),
    allowances: await allowanceViews(env, portalId, row.tier, row),
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
    provider: 'dodo' | 'manual';
    customerId: string | null;
    subscriptionId: string | null;
    productId: string | null;
    tier: CommercialTier;
    status: SubscriptionStatus;
    interval: BillingInterval | null;
    usageMode: UsageMode;
    overageEnabled: boolean;
    currency: string | null;
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    trialEndsAt: string | null;
    graceEndsAt: string | null;
    contractReference?: string | null;
    purchaseOrderReference?: string | null;
    scheduledTier?: CommercialTier | null;
    scheduledChangeAt?: string | null;
  },
): Promise<void> {
  const now = new Date().toISOString();
  const entitled = entitledStatus(input.status, input.graceEndsAt);
  const internalPlan: PlanId = entitled
    ? input.tier === 'enterprise' ? 'beta_growth' : input.tier === 'growth' ? 'growth' : 'free'
    : 'free';
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO subscriptions_v2 (
        portal_id, provider, provider_customer_id, provider_subscription_id, provider_product_id,
        tier, status, billing_interval, usage_mode, overage_enabled, currency,
        current_period_start, current_period_end, cancel_at_period_end, trial_ends_at, grace_ends_at,
        contract_reference, purchase_order_reference, scheduled_tier, scheduled_change_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(portal_id) DO UPDATE SET
        provider = excluded.provider, provider_customer_id = excluded.provider_customer_id,
        provider_subscription_id = excluded.provider_subscription_id, provider_product_id = excluded.provider_product_id,
        tier = excluded.tier, status = excluded.status, billing_interval = excluded.billing_interval,
        usage_mode = excluded.usage_mode, overage_enabled = excluded.overage_enabled, currency = excluded.currency,
        current_period_start = excluded.current_period_start, current_period_end = excluded.current_period_end,
        cancel_at_period_end = excluded.cancel_at_period_end, trial_ends_at = excluded.trial_ends_at,
        grace_ends_at = excluded.grace_ends_at, contract_reference = excluded.contract_reference,
        purchase_order_reference = excluded.purchase_order_reference, scheduled_tier = excluded.scheduled_tier,
        scheduled_change_at = excluded.scheduled_change_at, updated_at = excluded.updated_at`
    ).bind(
      portalId, input.provider, input.customerId, input.subscriptionId, input.productId,
      input.tier, input.status, input.interval, input.usageMode, input.overageEnabled ? 1 : 0, input.currency,
      input.currentPeriodStart, input.currentPeriodEnd, input.cancelAtPeriodEnd ? 1 : 0, input.trialEndsAt,
      input.graceEndsAt, input.contractReference ?? null, input.purchaseOrderReference ?? null,
      input.scheduledTier ?? null, input.scheduledChangeAt ?? null, now, now,
    ),
    env.DB.prepare(`UPDATE tenants SET commercial_tier = ?, trial_ends_at = ?, plan = ?, updated_at = ? WHERE portal_id = ?`)
      .bind(input.tier, input.trialEndsAt, internalPlan, now, portalId),
  ]);
}

export async function setManualSubscription(
  env: Env,
  portalId: string,
  tier: CommercialTier,
  currentPeriodEnd: string | null,
  options: {
    contractReference?: string | null;
    purchaseOrderReference?: string | null;
    currency?: string;
    usageMode?: UsageMode;
    overageEnabled?: boolean;
  } = {},
): Promise<void> {
  if (!['growth', 'enterprise'].includes(tier)) throw new AppError(400, 'manual_tier_invalid', 'Manual subscriptions support Growth or Enterprise.');
  const now = new Date().toISOString();
  await applySubscription(env, portalId, {
    provider: 'manual',
    customerId: null,
    subscriptionId: null,
    productId: null,
    tier,
    status: 'manual',
    interval: 'contract',
    usageMode: options.usageMode ?? 'capped',
    overageEnabled: options.overageEnabled ?? false,
    currency: options.currency ?? 'USD',
    currentPeriodStart: now,
    currentPeriodEnd,
    cancelAtPeriodEnd: false,
    trialEndsAt: null,
    graceEndsAt: currentPeriodEnd,
    contractReference: options.contractReference ?? null,
    purchaseOrderReference: options.purchaseOrderReference ?? null,
  });
  await new Repository(env).audit(portalId, null, null, 'billing.manual_entitlement_set', {
    tier,
    currentPeriodEnd,
    contractReference: options.contractReference ?? null,
    purchaseOrderReference: options.purchaseOrderReference ?? null,
    usageMode: options.usageMode ?? 'capped',
    overageEnabled: options.overageEnabled ?? false,
  });
}

function decodeBase64(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function constantTimeEqualBytes(left: Uint8Array, right: Uint8Array): boolean {
  const length = Math.max(left.length, right.length);
  let mismatch = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) mismatch |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return mismatch === 0;
}

async function hmacBytes(secret: Uint8Array, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

export async function verifyDodoWebhook(request: Request, env: Env): Promise<{ rawBody: string; webhookId: string }> {
  const secretValue = configured(env).DODO_WEBHOOK_SECRET;
  if (!secretValue) throw new AppError(503, 'dodo_webhook_not_configured', 'Dodo Payments webhook verification is not configured.');
  const webhookId = request.headers.get('webhook-id') ?? '';
  const timestamp = request.headers.get('webhook-timestamp') ?? '';
  const signatures = (request.headers.get('webhook-signature') ?? '').split(/\s+/).filter(Boolean);
  const unix = Number(timestamp);
  if (!webhookId || !Number.isFinite(unix) || Math.abs(Date.now() / 1000 - unix) > 300) {
    throw new AppError(401, 'dodo_signature_expired', 'Dodo Payments webhook timestamp is outside the accepted window.');
  }
  const rawBody = await request.clone().text();
  const secret = secretValue.startsWith('whsec_') ? decodeBase64(secretValue.slice(6)) : encoder.encode(secretValue);
  const expected = await hmacBytes(secret, `${webhookId}.${timestamp}.${rawBody}`);
  const valid = signatures.some((candidate) => {
    const encoded = candidate.includes(',') ? candidate.split(',', 2)[1] ?? '' : candidate;
    try { return constantTimeEqualBytes(expected, decodeBase64(encoded)); } catch { return false; }
  });
  if (!valid) throw new AppError(401, 'dodo_signature_invalid', 'Dodo Payments webhook signature verification failed.');
  return { rawBody, webhookId };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(...values: unknown[]): string | null {
  for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim();
  return null;
}

function isoValue(...values: unknown[]): string | null {
  const value = stringValue(...values);
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function mapDodoStatus(value: unknown): SubscriptionStatus {
  const normalized = String(value ?? '').toLowerCase();
  if (normalized === 'active') return 'active';
  if (normalized === 'pending') return 'pending';
  if (normalized === 'on_hold' || normalized === 'paused') return 'on_hold';
  if (normalized === 'cancelled' || normalized === 'canceled') return 'cancelled';
  if (normalized === 'failed' || normalized === 'unpaid') return 'failed';
  if (normalized === 'expired') return 'expired';
  if (normalized === 'trialing' || normalized === 'trial') return 'trialing';
  if (normalized === 'past_due') return 'past_due';
  return 'pending';
}

function graceFor(status: SubscriptionStatus, existing: string | null): string | null {
  if (status === 'past_due' || status === 'on_hold') return existing && Date.parse(existing) > Date.now()
    ? existing
    : new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString();
  return null;
}

export async function processDodoWebhook(env: Env, rawBody: string, webhookId: string): Promise<void> {
  const envelope = JSON.parse(rawBody) as DodoWebhookEnvelope;
  const eventId = envelope.id ?? webhookId;
  const eventType = String(envelope.type ?? 'unknown');
  const payloadHash = await sha256Hex(rawBody);
  const existing = await env.DB.prepare(`SELECT status FROM billing_events WHERE provider = 'dodo' AND provider_event_id = ?`)
    .bind(eventId).first<{ status: string }>();
  if (existing?.status === 'processed' || existing?.status === 'ignored') return;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO billing_events (id, provider, provider_event_id, event_type, status, payload_hash, received_at)
     VALUES (?, 'dodo', ?, ?, 'received', ?, ?)
     ON CONFLICT(provider, provider_event_id) DO UPDATE SET status = 'received', error_message = NULL`
  ).bind(crypto.randomUUID(), eventId, eventType, payloadHash, now).run();

  try {
    const data = asRecord(envelope.data);
    const object = asRecord(data.object ?? data);
    const metadata = asRecord(object.metadata ?? data.metadata);
    const portalId = stringValue(metadata.portal_id, metadata.portalId, object.portal_id);
    const subscriptionId = stringValue(object.subscription_id, object.id);
    const customer = asRecord(object.customer);
    const customerId = stringValue(object.customer_id, customer.customer_id, customer.id);
    const productId = stringValue(object.product_id, asRecord(object.product).product_id, asRecord(object.product).id);
    if (!portalId || !/^\d+$/.test(portalId)) {
      await env.DB.prepare(`UPDATE billing_events SET status = 'ignored', processed_at = ? WHERE provider = 'dodo' AND provider_event_id = ?`).bind(now, eventId).run();
      return;
    }
    const cfg = configured(env);
    const product = productId ? tierForProduct(cfg, productId) : null;
    const tierValue = stringValue(metadata.tier);
    const tier: CommercialTier = tierValue === 'enterprise' || tierValue === 'growth'
      ? tierValue
      : product?.tier ?? 'free';
    const intervalValue = stringValue(metadata.interval, object.billing_interval, object.interval);
    const interval: BillingInterval | null = intervalValue === 'year' || intervalValue === 'month'
      ? intervalValue
      : product?.interval ?? null;
    const status = mapDodoStatus(object.status ?? (eventType.includes('cancel') ? 'cancelled' : eventType.includes('fail') ? 'failed' : eventType.includes('active') ? 'active' : 'pending'));
    const current = await env.DB.prepare(`SELECT grace_ends_at, usage_mode, overage_enabled FROM subscriptions_v2 WHERE portal_id = ?`)
      .bind(portalId).first<{ grace_ends_at: string | null; usage_mode: UsageMode; overage_enabled: number }>();
    const usageMode: UsageMode = metadata.usage_mode === 'metered' ? 'metered' : current?.usage_mode ?? 'capped';
    const overageEnabled = metadata.overage_enabled === 'true' ? true : current ? Boolean(current.overage_enabled) : false;
    await applySubscription(env, portalId, {
      provider: 'dodo',
      customerId,
      subscriptionId,
      productId,
      tier,
      status,
      interval,
      usageMode,
      overageEnabled,
      currency: stringValue(object.currency),
      currentPeriodStart: isoValue(object.previous_billing_date, object.current_period_start),
      currentPeriodEnd: isoValue(object.next_billing_date, object.current_period_end),
      cancelAtPeriodEnd: Boolean(object.cancel_at_next_billing_date ?? object.cancel_at_period_end),
      trialEndsAt: isoValue(object.trial_period_days ? new Date(Date.now() + Number(object.trial_period_days) * 86400000).toISOString() : null, object.trial_ends_at),
      graceEndsAt: graceFor(status, current?.grace_ends_at ?? null),
    });
    await env.DB.prepare(`UPDATE billing_events SET status = 'processed', processed_at = ? WHERE provider = 'dodo' AND provider_event_id = ?`)
      .bind(new Date().toISOString(), eventId).run();
    await new Repository(env).audit(portalId, null, null, 'billing.subscription_updated', {
      provider: 'dodo', eventId, eventType, tier, status, interval, subscriptionId, customerId, productId,
    });
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 1500);
    await env.DB.prepare(`UPDATE billing_events SET status = 'failed', error_message = ?, processed_at = ? WHERE provider = 'dodo' AND provider_event_id = ?`)
      .bind(message, new Date().toISOString(), eventId).run();
    throw error;
  }
}

function eventName(env: Env, metric: BillableMetric): string {
  const cfg = configured(env);
  const names: Record<BillableMetric, string | undefined> = {
    ai_credit: cfg.DODO_AI_CREDIT_EVENT_NAME,
    active_deal_overage: cfg.DODO_ACTIVE_DEAL_EVENT_NAME,
    event_overage: cfg.DODO_EVENT_OVERAGE_EVENT_NAME,
    retention_gb_month: cfg.DODO_RETENTION_EVENT_NAME,
  };
  return names[metric] ?? `dealguard_${metric}`;
}

export async function recordUsage(
  env: Env,
  portalId: string,
  metric: BillableMetric,
  quantity: number,
  idempotencyKey: string,
  metadata: Record<string, string | number | boolean | null> = {},
): Promise<{ recorded: boolean; reported: boolean }> {
  if (!Number.isFinite(quantity) || quantity < 0) throw new AppError(400, 'usage_quantity_invalid', 'Usage quantity must be a non-negative number.');
  const status = await getBillingStatus(env, portalId);
  const allowance = status.allowances.find((item) => item.metric === metric);
  if (allowance?.hardLimit !== null && allowance && allowance.consumedQuantity + quantity > allowance.hardLimit && !allowance.overageEnabled) {
    throw new AppError(402, 'usage_limit_reached', `The ${metric} allowance has been exhausted and overage is disabled.`, { metric, allowance });
  }
  const id = crypto.randomUUID();
  const occurredAt = new Date().toISOString();
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO billing_usage_events (id, portal_id, event_name, quantity, idempotency_key, status, metadata_json, occurred_at, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
  ).bind(id, portalId, metric, quantity, idempotencyKey.slice(0, 255), JSON.stringify(metadata), occurredAt, occurredAt).run();
  if (Number(result.meta?.changes ?? 0) === 0) return { recorded: false, reported: false };
  if (status.provider !== 'dodo' || !status.customerId || status.usageMode !== 'metered' || !status.overageEnabled) {
    await env.DB.prepare(`UPDATE billing_usage_events SET status = 'ignored', reported_at = ? WHERE id = ?`).bind(new Date().toISOString(), id).run();
    return { recorded: true, reported: false };
  }
  try {
    const eventId = `${portalId}:${idempotencyKey}`.slice(0, 255);
    await dodoRequest<{ ingested_count?: number }>(env, '/events/ingest', {
      method: 'POST',
      body: JSON.stringify({
        events: [{
          event_id: eventId,
          customer_id: status.customerId,
          event_name: eventName(env, metric),
          timestamp: occurredAt,
          metadata: { portal_id: portalId, quantity, ...metadata },
        }],
      }),
    });
    await env.DB.prepare(`UPDATE billing_usage_events SET status = 'reported', provider_event_id = ?, reported_at = ? WHERE id = ?`)
      .bind(eventId, new Date().toISOString(), id).run();
    return { recorded: true, reported: true };
  } catch (error) {
    await env.DB.prepare(`UPDATE billing_usage_events SET status = 'failed', error_message = ? WHERE id = ?`)
      .bind((error instanceof Error ? error.message : String(error)).slice(0, 1500), id).run();
    throw error;
  }
}

export async function retryUsageReports(env: Env, limit = 100): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT id, portal_id, event_name, quantity, idempotency_key, metadata_json, occurred_at
     FROM billing_usage_events WHERE status = 'failed' ORDER BY occurred_at ASC LIMIT ?`
  ).bind(Math.min(500, Math.max(1, limit))).all<Record<string, unknown>>();
  for (const row of rows.results ?? []) {
    const portalId = String(row.portal_id);
    const metric = String(row.event_name) as BillableMetric;
    try {
      await env.DB.prepare(`DELETE FROM billing_usage_events WHERE id = ?`).bind(String(row.id)).run();
      await recordUsage(env, portalId, metric, Number(row.quantity), String(row.idempotency_key), JSON.parse(String(row.metadata_json ?? '{}')));
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', task: 'retry_usage', portalId, metric, error: error instanceof Error ? error.message : String(error) }));
    }
  }
}

export async function updateBillingAllowance(
  env: Env,
  identity: RequestIdentity,
  metric: BillableMetric,
  input: { includedQuantity: number; hardLimit: number | null; overageEnabled: boolean },
): Promise<void> {
  if (!Number.isFinite(input.includedQuantity) || input.includedQuantity < 0) throw new AppError(400, 'allowance_invalid', 'Included quantity must be non-negative.');
  if (input.hardLimit !== null && (!Number.isFinite(input.hardLimit) || input.hardLimit < input.includedQuantity)) {
    throw new AppError(400, 'allowance_hard_limit_invalid', 'Hard limit must be null or greater than or equal to the included quantity.');
  }
  await env.DB.prepare(
    `INSERT INTO billing_allowances (portal_id, metric, included_quantity, hard_limit, overage_enabled, reset_period, updated_at)
     VALUES (?, ?, ?, ?, ?, 'month', ?)
     ON CONFLICT(portal_id, metric) DO UPDATE SET included_quantity = excluded.included_quantity,
     hard_limit = excluded.hard_limit, overage_enabled = excluded.overage_enabled, updated_at = excluded.updated_at`
  ).bind(identity.portalId, metric, input.includedQuantity, input.hardLimit, input.overageEnabled ? 1 : 0, new Date().toISOString()).run();
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'billing.allowance_updated', { metric, ...input });
}

export async function setScheduledPlanChange(
  env: Env,
  identity: RequestIdentity,
  tier: CommercialTier,
  effectiveAt: string,
): Promise<void> {
  if (!['free', 'growth', 'enterprise'].includes(tier)) throw new AppError(400, 'scheduled_tier_invalid', 'Choose a valid tier.');
  const parsed = Date.parse(effectiveAt);
  if (!Number.isFinite(parsed) || parsed <= Date.now()) throw new AppError(400, 'scheduled_change_date_invalid', 'Scheduled changes must use a future date.');
  await env.DB.prepare(`UPDATE subscriptions_v2 SET scheduled_tier = ?, scheduled_change_at = ?, updated_at = ? WHERE portal_id = ?`)
    .bind(tier, new Date(parsed).toISOString(), new Date().toISOString(), identity.portalId).run();
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'billing.plan_change_scheduled', { tier, effectiveAt: new Date(parsed).toISOString() });
}

export async function applyScheduledPlanChanges(env: Env): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT * FROM subscriptions_v2 WHERE scheduled_tier IS NOT NULL AND scheduled_change_at IS NOT NULL AND scheduled_change_at <= ? LIMIT 100`
  ).bind(new Date().toISOString()).all<SubscriptionRow>();
  for (const row of rows.results ?? []) {
    const tier = row.scheduled_tier ?? 'free';
    await applySubscription(env, row.portal_id, {
      provider: row.provider,
      customerId: row.provider_customer_id,
      subscriptionId: row.provider_subscription_id,
      productId: row.provider_product_id,
      tier,
      status: row.status,
      interval: row.billing_interval,
      usageMode: row.usage_mode,
      overageEnabled: Boolean(row.overage_enabled),
      currency: row.currency,
      currentPeriodStart: row.current_period_start,
      currentPeriodEnd: row.current_period_end,
      cancelAtPeriodEnd: Boolean(row.cancel_at_period_end),
      trialEndsAt: row.trial_ends_at,
      graceEndsAt: row.grace_ends_at,
      contractReference: row.contract_reference,
      purchaseOrderReference: row.purchase_order_reference,
      scheduledTier: null,
      scheduledChangeAt: null,
    });
    await new Repository(env).audit(row.portal_id, null, null, 'billing.plan_change_applied', { tier });
  }
}
