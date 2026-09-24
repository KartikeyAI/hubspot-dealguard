import { sha256Hex } from './crypto.js';
import { AppError } from './errors.js';
import type { CommercialTier, SubscriptionStatus, UsageMode, BillingInterval } from './billing.js';
import type { Env, PlanId } from './types.js';

interface DodoWebhookEnvelope {
  business_id?: string;
  type?: string;
  timestamp?: string;
  data?: unknown;
}

interface DodoEnv extends Env {
  DODO_GROWTH_MONTHLY_PRODUCT_ID?: string;
  DODO_GROWTH_YEARLY_PRODUCT_ID?: string;
  DODO_ENTERPRISE_MONTHLY_PRODUCT_ID?: string;
  DODO_ENTERPRISE_YEARLY_PRODUCT_ID?: string;
}

interface CurrentSubscription {
  state_token: string;
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
  provider_event_at: string | null;
  last_provider_event_id: string | null;
  last_provider_event_type: string | null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function iso(...values: unknown[]): string | null {
  const value = text(...values);
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function isSubscriptionDodoEvent(eventType: string): boolean {
  return ['subscription.active', 'subscription.renewed', 'subscription.updated', 'subscription.on_hold',
    'subscription.cancelled', 'subscription.canceled', 'subscription.failed', 'subscription.expired',
    'subscription.plan_changed', 'subscription.update_payment_method'].includes(eventType);
}

function normalizedStatus(value: unknown): SubscriptionStatus | null {
  const status = String(value ?? '').trim().toLowerCase();
  if (status === 'active') return 'active';
  if (status === 'pending') return 'pending';
  if (status === 'trial' || status === 'trialing') return 'trialing';
  if (status === 'on_hold' || status === 'paused') return 'on_hold';
  if (status === 'past_due') return 'past_due';
  if (status === 'failed' || status === 'unpaid') return 'failed';
  if (status === 'expired') return 'expired';
  if (status === 'cancelled' || status === 'canceled') return 'cancelled';
  return null;
}

export function resolveDodoSubscriptionStatus(
  eventType: string,
  payloadStatus: unknown,
  currentStatus: SubscriptionStatus | null,
): SubscriptionStatus {
  const explicit = normalizedStatus(payloadStatus);
  if (explicit) return explicit;
  if (eventType === 'subscription.active' || eventType === 'subscription.renewed') return 'active';
  if (eventType === 'subscription.on_hold') return 'on_hold';
  if (eventType === 'subscription.cancelled' || eventType === 'subscription.canceled') return 'cancelled';
  if (eventType === 'subscription.failed') return 'failed';
  if (eventType === 'subscription.expired') return 'expired';
  if (eventType === 'subscription.updated' || eventType === 'subscription.plan_changed' || eventType === 'subscription.update_payment_method') {
    return currentStatus ?? 'pending';
  }
  return currentStatus ?? 'pending';
}

const STATUS_PRECEDENCE: Record<SubscriptionStatus, number> = {
  pending: 0,
  trialing: 1,
  active: 2,
  manual: 2,
  on_hold: 3,
  past_due: 3,
  failed: 4,
  expired: 5,
  cancelled: 5,
};

export function shouldIgnoreStaleDodoEvent(
  currentEventAt: string | null,
  currentStatus: SubscriptionStatus | null,
  incomingEventAt: string,
  incomingStatus: SubscriptionStatus,
): boolean {
  if (!currentEventAt) return false;
  const current = Date.parse(currentEventAt);
  const incoming = Date.parse(incomingEventAt);
  if (!Number.isFinite(current) || !Number.isFinite(incoming)) return false;
  if (incoming < current) return true;
  return incoming === current && currentStatus !== null
    && STATUS_PRECEDENCE[incomingStatus] <= STATUS_PRECEDENCE[currentStatus];
}

function productTier(env: DodoEnv, productId: string | null): { tier: CommercialTier; interval: 'month' | 'year' } | null {
  if (!productId) return null;
  const products: Array<[string | undefined, CommercialTier, 'month' | 'year']> = [
    [env.DODO_GROWTH_MONTHLY_PRODUCT_ID, 'growth', 'month'],
    [env.DODO_GROWTH_YEARLY_PRODUCT_ID, 'growth', 'year'],
    [env.DODO_ENTERPRISE_MONTHLY_PRODUCT_ID, 'enterprise', 'month'],
    [env.DODO_ENTERPRISE_YEARLY_PRODUCT_ID, 'enterprise', 'year'],
  ];
  const match = products.find(([id]) => Boolean(id) && id === productId);
  return match ? { tier: match[1], interval: match[2] } : null;
}

export function subscriptionGraceDeadline(status: SubscriptionStatus, previous: SubscriptionStatus | null,
  existing: string | null, eventAt: string, previousEventAt: string | null): string | null {
  if (status !== 'on_hold' && status !== 'past_due') return null;
  if (previous === 'on_hold' || previous === 'past_due') {
    // An expired grace clock is still the clock for this delinquency episode.
    if (existing) return iso(existing);
    return previousEventAt ? new Date(Date.parse(previousEventAt) + 7 * 86_400_000).toISOString() : eventAt;
  }
  return new Date(Date.parse(eventAt) + 7 * 86_400_000).toISOString();
}

function entitled(status: SubscriptionStatus, graceEndsAt: string | null): boolean {
  if (status === 'active' || status === 'trialing' || status === 'manual') return true;
  return (status === 'on_hold' || status === 'past_due')
    && Boolean(graceEndsAt && Date.parse(graceEndsAt) > Date.now());
}

async function markEvent(
  env: Env,
  webhookId: string,
  payloadHash: string,
  status: 'failed' | 'ignored',
  reason: string | null = null,
  audit?: { portalId: string; metadata: Record<string, unknown> },
): Promise<void> {
  const now = new Date().toISOString();
  const transition = `UPDATE billing_events SET status = ?, error_message = ?, processed_at = ?
    WHERE provider = 'dodo' AND provider_event_id = ? AND payload_hash = ?
      AND status IN ('received', 'failed') RETURNING provider_event_id`;
  if (audit) {
    // Only the delivery that actually changes the receipt may record its disposition.
    // RETURNING links both writes in one statement, so an audit error rolls back both.
    await env.DB.prepare(`WITH transitioned_receipt AS (${transition})
      INSERT INTO audit_events (id, portal_id, action, metadata_json, created_at)
      SELECT ?, ?, 'billing.stale_event_ignored', ?, ? FROM transitioned_receipt`)
      .bind(status, reason, now, webhookId, payloadHash, crypto.randomUUID(),
        audit.portalId, JSON.stringify(audit.metadata), now).run();
    return;
  }
  await env.DB.prepare(transition).bind(status, reason, now, webhookId, payloadHash).run();
}

async function correlatePortal(
  env: Env,
  metadataPortalId: string | null,
  subscriptionId: string | null,
  customerId: string | null,
): Promise<string | null> {
  const candidates = new Set<string>();
  if (metadataPortalId && /^\d+$/.test(metadataPortalId)) candidates.add(metadataPortalId);
  if (subscriptionId) {
    const row = await env.DB.prepare(
      `SELECT portal_id FROM subscriptions_v2 WHERE provider = 'dodo' AND provider_subscription_id = ? LIMIT 1`,
    ).bind(subscriptionId).first<{ portal_id: string }>();
    if (row?.portal_id) candidates.add(row.portal_id);
  }
  if (customerId) {
    const row = await env.DB.prepare(
      `SELECT portal_id FROM subscriptions_v2 WHERE provider = 'dodo' AND provider_customer_id = ? LIMIT 1`,
    ).bind(customerId).first<{ portal_id: string }>();
    if (row?.portal_id) candidates.add(row.portal_id);
  }
  if (candidates.size > 1) throw new AppError(409, 'billing_identity_conflict', 'Subscription and customer identities require administrator reconciliation.');
  return candidates.values().next().value ?? null;
}

async function applyProviderState(
  env: Env,
  portalId: string,
  input: {
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
    eventAt: string;
    eventId: string;
    eventType: string;
  },
  expectedState: string | null,
  payloadHash: string,
): Promise<boolean> {
  const now = new Date().toISOString();
  const plan: PlanId = entitled(input.status, input.graceEndsAt)
    ? input.tier === 'enterprise' ? 'beta_growth' : input.tier === 'growth' ? 'growth' : 'free'
    : 'free';
  const results = await env.DB.batch([
    // Serialize duplicate deliveries before any subscription, plan or audit mutation.
    env.DB.prepare(`SELECT status FROM billing_events WHERE provider = 'dodo' AND provider_event_id = ? FOR UPDATE`).bind(input.eventId),
    env.DB.prepare(
      `INSERT INTO subscriptions_v2 AS current_subscription (
        portal_id, provider, provider_customer_id, provider_subscription_id, provider_product_id,
        tier, status, billing_interval, usage_mode, overage_enabled, currency,
        current_period_start, current_period_end, cancel_at_period_end, trial_ends_at, grace_ends_at,
        contract_reference, purchase_order_reference, scheduled_tier, scheduled_change_at,
        provider_event_at, last_provider_event_id, last_provider_event_type, created_at, updated_at
      ) SELECT ?, 'dodo', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM billing_events WHERE provider = 'dodo' AND provider_event_id = ?
        AND payload_hash = ? AND status IN ('received', 'failed'))
        AND (?::text IS NULL OR EXISTS (SELECT 1 FROM subscriptions_v2 s
          WHERE s.portal_id = ? AND md5(row_to_json(s)::text) = ?))
      ON CONFLICT(portal_id) DO UPDATE SET
        provider = 'dodo', provider_customer_id = excluded.provider_customer_id,
        provider_subscription_id = excluded.provider_subscription_id,
        provider_product_id = excluded.provider_product_id, tier = excluded.tier, status = excluded.status,
        billing_interval = excluded.billing_interval, usage_mode = excluded.usage_mode,
        overage_enabled = excluded.overage_enabled, currency = excluded.currency,
        current_period_start = excluded.current_period_start, current_period_end = excluded.current_period_end,
        cancel_at_period_end = excluded.cancel_at_period_end, trial_ends_at = excluded.trial_ends_at,
        grace_ends_at = excluded.grace_ends_at, contract_reference = NULL,
        purchase_order_reference = NULL, scheduled_tier = NULL, scheduled_change_at = NULL,
        provider_event_at = excluded.provider_event_at,
        last_provider_event_id = excluded.last_provider_event_id,
        last_provider_event_type = excluded.last_provider_event_type, updated_at = excluded.updated_at
      WHERE ?::text IS NOT NULL AND md5(row_to_json(current_subscription)::text) = ?
        AND current_subscription.last_provider_event_id IS DISTINCT FROM excluded.last_provider_event_id
      RETURNING portal_id`,
    ).bind(
      portalId, input.customerId, input.subscriptionId, input.productId, input.tier, input.status,
      input.interval, input.usageMode, input.overageEnabled ? 1 : 0, input.currency,
      input.currentPeriodStart, input.currentPeriodEnd, input.cancelAtPeriodEnd ? 1 : 0,
      input.trialEndsAt, input.graceEndsAt, input.eventAt, input.eventId, input.eventType, now, now,
      input.eventId, payloadHash, expectedState, portalId, expectedState, expectedState, expectedState,
    ),
    env.DB.prepare(
      `UPDATE tenants SET commercial_tier = ?, trial_ends_at = ?, plan = ?, updated_at = ? WHERE portal_id = ?
       AND EXISTS (SELECT 1 FROM subscriptions_v2 s JOIN billing_events e
         ON e.provider = 'dodo' AND e.provider_event_id = s.last_provider_event_id
         WHERE s.portal_id = ? AND s.last_provider_event_id = ? AND s.updated_at = ? AND e.status IN ('received','failed'))`,
    ).bind(input.tier, input.trialEndsAt, plan, now, portalId, portalId, input.eventId, now),
    env.DB.prepare(`INSERT INTO audit_events (id, portal_id, action, metadata_json, created_at)
      SELECT ?, ?, 'billing.subscription_updated', ?, ? WHERE EXISTS (
        SELECT 1 FROM subscriptions_v2 s JOIN billing_events e
          ON e.provider = 'dodo' AND e.provider_event_id = s.last_provider_event_id
        WHERE s.portal_id = ? AND s.last_provider_event_id = ? AND s.updated_at = ? AND e.status IN ('received','failed'))`)
      .bind(crypto.randomUUID(), portalId, JSON.stringify({ provider: 'dodo', webhookId: input.eventId,
        eventType: input.eventType, eventAt: input.eventAt, tier: input.tier, status: input.status, interval: input.interval }),
        now, portalId, input.eventId, now),
    env.DB.prepare(`UPDATE billing_events SET status = 'processed', error_message = NULL, processed_at = ?
      WHERE provider = 'dodo' AND provider_event_id = ? AND status IN ('received','failed')
        AND EXISTS (SELECT 1 FROM subscriptions_v2 WHERE portal_id = ? AND last_provider_event_id = ? AND updated_at = ?)`)
      .bind(now, input.eventId, portalId, input.eventId, now),
  ]);
  return Number(results[1]?.meta?.changes ?? 0) === 1;
}

export async function processDodoWebhookOrdered(env: Env, rawBody: string, webhookId: string): Promise<void> {
  let envelope: DodoWebhookEnvelope;
  try {
    envelope = JSON.parse(rawBody) as DodoWebhookEnvelope;
  } catch {
    throw new AppError(400, 'dodo_payload_invalid', 'Dodo Payments webhook payload is not valid JSON.');
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
    || typeof webhookId !== 'string' || !webhookId.trim() || webhookId.length > 255 || /[\x00-\x1f\x7f]/.test(webhookId)) {
    throw new AppError(400, 'dodo_payload_invalid', 'A valid webhook envelope and bounded identity are required.');
  }
  const eventType = text(envelope.type) ?? 'unknown';
  const eventAt = iso(envelope.timestamp);
  if (!eventAt || Date.parse(eventAt) > Date.now() + 300_000) throw new AppError(400, 'dodo_event_timestamp_invalid', 'Dodo Payments webhook is missing a valid event timestamp.');
  const payloadHash = await sha256Hex(rawBody);
  const prior = await env.DB.prepare(
    `SELECT status, payload_hash FROM billing_events WHERE provider = 'dodo' AND provider_event_id = ?`,
  ).bind(webhookId).first<{ status: string; payload_hash: string }>();
  if (prior?.status === 'processed' || prior?.status === 'ignored') return;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO billing_events (
      id, provider, provider_event_id, event_type, status, payload_hash, event_occurred_at, received_at
    ) VALUES (?, 'dodo', ?, ?, 'received', ?, ?, ?)
    ON CONFLICT(provider, provider_event_id) DO UPDATE SET
      payload_hash = excluded.payload_hash, event_type = excluded.event_type,
      event_occurred_at = excluded.event_occurred_at, error_message = NULL
    WHERE billing_events.status IN ('received', 'failed')`,
  ).bind(crypto.randomUUID(), webhookId, eventType, payloadHash, eventAt, now).run();

  const receipt = await env.DB.prepare(`SELECT status, payload_hash FROM billing_events WHERE provider = 'dodo' AND provider_event_id = ?`)
    .bind(webhookId).first<{ status: string; payload_hash: string }>();
  if (receipt?.status === 'processed' || receipt?.status === 'ignored') return;
  if (receipt?.payload_hash !== payloadHash) throw new AppError(409, 'billing_event_payload_changed', 'A newer delivery is being processed; retry against the current provider payload.');

  if (!isSubscriptionDodoEvent(eventType)) {
    await markEvent(env, webhookId, payloadHash, 'ignored', 'non_subscription_event');
    return;
  }

  try {
    const data = record(envelope.data);
    const object = record(data.object ?? data);
    const metadata = record(object.metadata ?? data.metadata);
    const subscriptionId = text(object.subscription_id, object.id);
    const customer = record(object.customer);
    const customerId = text(object.customer_id, customer.customer_id, customer.id);
    const product = record(object.product);
    const productId = text(object.product_id, product.product_id, product.id);
    const portalId = await correlatePortal(
      env,
      text(metadata.portal_id, metadata.portalId, object.portal_id),
      subscriptionId,
      customerId,
    );
    if (!portalId) {
      await markEvent(env, webhookId, payloadHash, 'ignored', 'tenant_correlation_missing');
      return;
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await env.DB.prepare(`SELECT s.*, md5(row_to_json(s)::text) AS state_token FROM subscriptions_v2 s WHERE portal_id = ?`)
        .bind(portalId).first<CurrentSubscription>();
      if (current?.provider === 'manual') {
        await markEvent(env, webhookId, payloadHash, 'ignored', 'manual_contract_authoritative'); return;
      }
      if (current?.provider_event_at && !iso(current.provider_event_at)) throw new AppError(409, 'billing_clock_invalid', 'Stored provider clock requires reconciliation.');
      if (!subscriptionId || !customerId) throw new AppError(400, 'billing_provider_identity_missing', 'Subscription and customer identities are required.');
      if (current?.provider_customer_id && customerId !== current.provider_customer_id) {
        throw new AppError(409, 'billing_customer_changed', 'The subscription customer requires reconciliation.');
      }
      const status = resolveDodoSubscriptionStatus(eventType, object.status, current?.status ?? null);
      if (current?.provider_subscription_id && subscriptionId !== current.provider_subscription_id
        && !(['cancelled', 'expired', 'failed'].includes(current.status)
          && (status === 'active' || status === 'trialing') && current.provider_event_at
          && Date.parse(eventAt) > Date.parse(current.provider_event_at))) {
        await markEvent(env, webhookId, payloadHash, 'ignored', 'different_subscription_requires_reconciliation'); return;
      }
      if (shouldIgnoreStaleDodoEvent(current?.provider_event_at ?? null, current?.status ?? null, eventAt, status)) {
        await markEvent(env, webhookId, payloadHash, 'ignored', 'stale_subscription_event', {
          portalId,
          metadata: { provider: 'dodo', webhookId, eventType, eventAt,
            currentEventAt: current?.provider_event_at ?? null },
        });
        return;
      }

      // A replacement subscription has its own periods, consent and cancellation state.
      const sameSubscription = current?.provider_subscription_id === subscriptionId ? current : null;
      const mappedProduct = productTier(env as DodoEnv, productId ?? sameSubscription?.provider_product_id ?? null);
      if (!mappedProduct) throw new AppError(409, 'billing_product_unmapped', 'The provider product must map to a configured DealGuard plan.');
      // Signed checkout metadata can still be old after a provider-side plan change.
      const tier = mappedProduct.tier;
      const interval = mappedProduct.interval;
      const metadataUsageMode = text(metadata.usage_mode);
      const usageMode: UsageMode = metadataUsageMode === 'metered' || metadataUsageMode === 'capped'
        ? metadataUsageMode
        : sameSubscription?.usage_mode ?? 'capped';
      const overageEnabled = metadata.overage_enabled === 'true'
        ? true
        : metadata.overage_enabled === 'false'
          ? false
          : Boolean(sameSubscription?.overage_enabled ?? 0);
      const graceEndsAt = subscriptionGraceDeadline(status, sameSubscription?.status ?? null,
        sameSubscription?.grace_ends_at ?? null, eventAt, sameSubscription?.provider_event_at ?? null);

      const applied = await applyProviderState(env, portalId, {
        customerId: customerId ?? current?.provider_customer_id ?? null,
        subscriptionId: subscriptionId ?? current?.provider_subscription_id ?? null,
        productId: productId ?? current?.provider_product_id ?? null,
        tier,
        status,
        interval,
        usageMode,
        overageEnabled,
        currency: text(object.currency) ?? sameSubscription?.currency ?? null,
        currentPeriodStart: iso(object.previous_billing_date, object.current_period_start)
          ?? sameSubscription?.current_period_start ?? null,
        currentPeriodEnd: iso(object.next_billing_date, object.current_period_end)
          ?? sameSubscription?.current_period_end ?? null,
        cancelAtPeriodEnd: bool(
          object.cancel_at_next_billing_date ?? object.cancel_at_period_end,
          Boolean(sameSubscription?.cancel_at_period_end ?? 0),
        ),
        trialEndsAt: iso(object.trial_ends_at) ?? sameSubscription?.trial_ends_at ?? null,
        graceEndsAt,
        eventAt,
        eventId: webhookId,
        eventType,
      }, current?.state_token ?? null, payloadHash);
      if (applied) return;
      const finished = await env.DB.prepare(`SELECT status FROM billing_events WHERE provider = 'dodo' AND provider_event_id = ?`)
        .bind(webhookId).first<{ status: string }>();
      if (finished?.status === 'processed' || finished?.status === 'ignored') return;
      // A concurrent accepted change invalidated the pre-read state. Read it anew.
    }
    throw new AppError(409, 'billing_state_changed', 'Subscription changed concurrently; retry this event.');

  } catch (error) {
    await markEvent(
      env,
      webhookId,
      payloadHash,
      'failed',
      error instanceof AppError ? error.code : 'billing_processing_failed',
    );
    throw error;
  }
}
