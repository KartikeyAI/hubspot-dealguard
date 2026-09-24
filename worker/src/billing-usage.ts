import { getBillingStatus, type BillableMetric } from './billing.js';
import { AppError } from './errors.js';
import type { Env } from './types.js';
import { DELIVERY_CONTEXT_KEY, deliverUsageEvent, usageDeliveryContext, usageProviderMetadata } from './billing-usage-delivery.js';

export type UsageAggregation = 'sum' | 'max';
const AGGREGATIONS: Record<BillableMetric, UsageAggregation> = {
  ai_credit: 'sum',
  active_deal_overage: 'max',
  event_overage: 'sum',
  retention_gb_month: 'max',
};

export function usageAggregation(metric: BillableMetric): UsageAggregation {
  return AGGREGATIONS[metric];
}

export function localUsageIncrement(metric: BillableMetric, current: number, quantity: number): number {
  return usageAggregation(metric) === 'max' ? Math.max(0, quantity - current) : quantity;
}

function periodStart(value: string | null): string {
  if (value && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  const date = new Date();
  date.setUTCDate(1);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString();
}

async function recordSumUsage(
  env: Env,
  input: {
    id: string;
    portalId: string;
    metric: BillableMetric;
    quantity: number;
    key: string;
    metadataJson: string;
    occurredAt: string;
    start: string;
    hardLimit: number | null;
  },
) {
  return env.DB.batch([
    env.DB.prepare(
      `INSERT INTO billing_usage_counters (portal_id, metric, period_start, consumed_quantity, updated_at)
       SELECT ?, ?, ?, COALESCE(SUM(quantity), 0), ? FROM billing_usage_events
       WHERE portal_id = ? AND event_name = ? AND occurred_at >= ?
       ON CONFLICT(portal_id, metric, period_start) DO NOTHING`,
    ).bind(input.portalId, input.metric, input.start, input.occurredAt, input.portalId, input.metric, input.start),
    env.DB.prepare(
      `SELECT consumed_quantity FROM billing_usage_counters
       WHERE portal_id = ? AND metric = ? AND period_start = ? FOR UPDATE`,
    ).bind(input.portalId, input.metric, input.start),
    env.DB.prepare(
      `INSERT INTO billing_usage_events
       (id, portal_id, event_name, quantity, idempotency_key, status, metadata_json, occurred_at, created_at, provider_event_id)
       SELECT ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?
       WHERE (?::double precision IS NULL OR
         COALESCE((SELECT consumed_quantity FROM billing_usage_counters
                   WHERE portal_id = ? AND metric = ? AND period_start = ?), 0) + ? <= ?)
       ON CONFLICT(portal_id, idempotency_key) DO NOTHING`,
    ).bind(
      input.id, input.portalId, input.metric, input.quantity, input.key, input.metadataJson,
      input.occurredAt, input.occurredAt, `dg_usage_${input.id}`, input.hardLimit,
      input.portalId, input.metric, input.start, input.quantity, input.hardLimit,
    ),
    env.DB.prepare(
      `INSERT INTO billing_usage_counters (portal_id, metric, period_start, consumed_quantity, updated_at)
       SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM billing_usage_events WHERE id = ?)
       ON CONFLICT(portal_id, metric, period_start) DO UPDATE SET
         consumed_quantity = billing_usage_counters.consumed_quantity + excluded.consumed_quantity,
         updated_at = excluded.updated_at`,
    ).bind(input.portalId, input.metric, input.start, input.quantity, input.occurredAt, input.id),
  ]);
}

async function recordGaugeUsage(
  env: Env,
  input: {
    id: string;
    portalId: string;
    metric: BillableMetric;
    quantity: number;
    key: string;
    metadataJson: string;
    occurredAt: string;
    start: string;
    hardLimit: number | null;
  },
) {
  return env.DB.batch([
    env.DB.prepare(
      `INSERT INTO billing_usage_counters (portal_id, metric, period_start, consumed_quantity, updated_at)
       SELECT ?, ?, ?, COALESCE(MAX(
         COALESCE(NULLIF(metadata_json::jsonb ->> 'provider_quantity', '')::DOUBLE PRECISION, quantity)
       ), 0), ? FROM billing_usage_events
       WHERE portal_id = ? AND event_name = ? AND occurred_at >= ?
       ON CONFLICT(portal_id, metric, period_start) DO NOTHING`,
    ).bind(input.portalId, input.metric, input.start, input.occurredAt, input.portalId, input.metric, input.start),
    env.DB.prepare(
      `SELECT consumed_quantity FROM billing_usage_counters
       WHERE portal_id = ? AND metric = ? AND period_start = ? FOR UPDATE`,
    ).bind(input.portalId, input.metric, input.start),
    env.DB.prepare(
      `INSERT INTO billing_usage_events
       (id, portal_id, event_name, quantity, idempotency_key, status, metadata_json, occurred_at, created_at, provider_event_id)
       SELECT ?, ?, ?, GREATEST(0, ? - COALESCE((
         SELECT consumed_quantity FROM billing_usage_counters
         WHERE portal_id = ? AND metric = ? AND period_start = ?
       ), 0)), ?, 'pending', ?, ?, ?, ?
       WHERE (?::double precision IS NULL OR ?::double precision <= ?::double precision)
       ON CONFLICT(portal_id, idempotency_key) DO NOTHING`,
    ).bind(
      input.id,
      input.portalId,
      input.metric,
      input.quantity,
      input.portalId,
      input.metric,
      input.start,
      input.key,
      input.metadataJson,
      input.occurredAt,
      input.occurredAt,
      `dg_usage_${input.id}`,
      input.hardLimit,
      input.quantity,
      input.hardLimit,
    ),
    env.DB.prepare(
      `INSERT INTO billing_usage_counters (portal_id, metric, period_start, consumed_quantity, updated_at)
       SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM billing_usage_events WHERE id = ?)
       ON CONFLICT(portal_id, metric, period_start) DO UPDATE SET
         consumed_quantity = GREATEST(billing_usage_counters.consumed_quantity, excluded.consumed_quantity),
         updated_at = excluded.updated_at`,
    ).bind(input.portalId, input.metric, input.start, input.quantity, input.occurredAt, input.id),
  ]);
}

export async function recordUsageAtomic(
  env: Env,
  portalId: string,
  metric: BillableMetric,
  quantity: number,
  idempotencyKey: string,
  metadata: Record<string, string | number | boolean | null> = {},
): Promise<{ recorded: boolean; reported: boolean }> {
  if (!Number.isFinite(quantity) || quantity < 0 || quantity > Number.MAX_SAFE_INTEGER) throw new AppError(400, 'usage_quantity_invalid', 'Usage quantity must be a non-negative number.');
  if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 255 || /[\x00-\x1f\x7f]/.test(idempotencyKey)) {
    throw new AppError(400, 'usage_idempotency_required', 'Use a nonempty idempotency key of at most 255 characters without control characters.');
  }
  if (!Object.hasOwn(AGGREGATIONS, metric)) throw new AppError(400, 'usage_metric_invalid', 'The requested usage metric is not configured.');
  const billing = await getBillingStatus(env, portalId);
  const allowance = billing.allowances.find((item) => item.metric === metric);
  if (!allowance) throw new AppError(400, 'usage_metric_invalid', 'The requested usage metric is not configured.');
  const start = periodStart(billing.currentPeriodStart);
  const id = crypto.randomUUID();
  const occurredAt = new Date().toISOString();
  const key = idempotencyKey.trim();
  const overageAllowed = billing.entitled && billing.usageMode === 'metered'
    && billing.overageEnabled && allowance.overageEnabled ? 1 : 0;
  // Overage may exceed the included amount, never an explicit hard ceiling.
  const hardLimit = overageAllowed ? allowance.hardLimit
    : Math.min(allowance.includedQuantity, allowance.hardLimit ?? allowance.includedQuantity);
  if (!Number.isFinite(allowance.includedQuantity) || allowance.includedQuantity < 0
    || (hardLimit !== null && (!Number.isFinite(hardLimit) || hardLimit < 0))) {
    throw new AppError(409, 'usage_allowance_invalid', 'The billing allowance requires administrator review.');
  }
  const aggregation = usageAggregation(metric);
  const enrichedMetadata = aggregation === 'max'
    ? { ...metadata, requested_quantity: quantity, provider_quantity: quantity, aggregation }
    : { ...metadata, requested_quantity: quantity, aggregation };
  // Reserved context is generated by the service, never accepted from callers.
  const persistedMetadata = { ...enrichedMetadata, [DELIVERY_CONTEXT_KEY]: usageDeliveryContext(env, billing, metric) };
  usageProviderMetadata(portalId, quantity, persistedMetadata);
  const common = {
    id,
    portalId,
    metric,
    quantity,
    key,
    metadataJson: JSON.stringify(persistedMetadata),
    occurredAt,
    start,
    hardLimit,
  };
  const results = aggregation === 'max'
    ? await recordGaugeUsage(env, common)
    : await recordSumUsage(env, common);

  const inserted = Number(results[2]?.meta?.changes ?? 0) > 0;
  if (!inserted) {
    const duplicate = await env.DB.prepare(
      `SELECT id, status, event_name, quantity, metadata_json FROM billing_usage_events WHERE portal_id = ? AND idempotency_key = ?`,
    ).bind(portalId, key).first<{ id: string; status: string; event_name: string; quantity: number; metadata_json: string }>();
    if (duplicate) {
      const priorMetadata = JSON.parse(duplicate.metadata_json) as Record<string, unknown>;
      const priorQuantity = priorMetadata.requested_quantity
        ?? (usageAggregation(metric) === 'max' ? priorMetadata.provider_quantity : duplicate.quantity);
      if (duplicate.event_name !== metric || Number(priorQuantity) !== quantity) {
        throw new AppError(409, 'usage_idempotency_conflict', 'The idempotency key was already used for a different metric or quantity.');
      }
      return { recorded: false, reported: duplicate.status === 'reported' };
    }
    throw new AppError(402, 'usage_limit_reached', `The ${metric} allowance or configured hard limit has been exhausted.`, { metric, allowance });
  }

  return { recorded: true, reported: await deliverUsageEvent(env, portalId, id) };
}

export async function retryAtomicUsageReports(env: Env, limit = 100): Promise<void> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new AppError(400, 'usage_retry_limit_invalid', 'Use an integer retry batch size from 1 to 500.');
  const rows = await env.DB.prepare(
    `SELECT id, portal_id FROM billing_usage_events WHERE status = 'pending'
     ORDER BY occurred_at ASC, id ASC LIMIT ?`,
  ).bind(limit).all<{ id: string; portal_id: string }>();
  for (const row of rows.results ?? []) {
    try { await deliverUsageEvent(env, row.portal_id, row.id); }
    catch (error) {
      console.error(JSON.stringify({ level: 'warn', task: 'dodo_usage_retry', portalId: row.portal_id,
        code: error instanceof AppError ? error.code : 'usage_delivery_internal_error' }));
    }
  }
}
