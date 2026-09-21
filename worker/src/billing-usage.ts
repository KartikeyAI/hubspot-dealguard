import { getBillingStatus, type BillableMetric } from './billing.js';
import { AppError } from './errors.js';
import type { Env } from './types.js';

interface DodoUsageEnv extends Env {
  DODO_API_KEY?: string;
  DODO_ENVIRONMENT?: 'test' | 'live';
  DODO_AI_CREDIT_EVENT_NAME?: string;
  DODO_ACTIVE_DEAL_EVENT_NAME?: string;
  DODO_EVENT_OVERAGE_EVENT_NAME?: string;
  DODO_RETENTION_EVENT_NAME?: string;
}

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

function dodoBase(env: Env): string {
  return (env as DodoUsageEnv).DODO_ENVIRONMENT === 'live'
    ? 'https://live.dodopayments.com'
    : 'https://test.dodopayments.com';
}

function providerEventName(env: Env, metric: BillableMetric): string {
  const cfg = env as DodoUsageEnv;
  const names: Record<BillableMetric, string | undefined> = {
    ai_credit: cfg.DODO_AI_CREDIT_EVENT_NAME,
    active_deal_overage: cfg.DODO_ACTIVE_DEAL_EVENT_NAME,
    event_overage: cfg.DODO_EVENT_OVERAGE_EVENT_NAME,
    retention_gb_month: cfg.DODO_RETENTION_EVENT_NAME,
  };
  return names[metric] ?? `dealguard_${metric}`;
}

function periodStart(value: string | null): string {
  if (value && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  const date = new Date();
  date.setUTCDate(1);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString();
}

function metadataValues(
  portalId: string,
  quantity: number,
  metadata: Record<string, string | number | boolean | null>,
): Record<string, string | number | boolean> {
  const output: Record<string, string | number | boolean> = {
    portal_id: portalId,
    quantity,
  };
  for (const [key, value] of Object.entries(metadata)) {
    if (value !== null && key !== 'portal_id' && key !== 'quantity') output[key.slice(0, 100)] = typeof value === 'string' ? value.slice(0, 500) : value;
  }
  return output;
}

function providerQuantity(
  metric: BillableMetric,
  storedQuantity: number,
  metadata: Record<string, string | number | boolean | null>,
): number {
  if (usageAggregation(metric) === 'sum') return storedQuantity;
  const value = Number(metadata.provider_quantity);
  if (!Number.isFinite(value) || value < 0) {
    throw new AppError(500, 'gauge_usage_value_missing', `Gauge usage for ${metric} is missing its absolute provider quantity.`);
  }
  return value;
}

async function reportEvent(
  env: Env,
  row: {
    id: string;
    portalId: string;
    metric: BillableMetric;
    quantity: number;
    idempotencyKey: string;
    occurredAt: string;
    metadata: Record<string, string | number | boolean | null>;
  },
): Promise<boolean> {
  const billing = await getBillingStatus(env, row.portalId);
  const cfg = env as DodoUsageEnv;
  if (!billing.entitled || billing.provider !== 'dodo' || !billing.customerId || billing.usageMode !== 'metered' || !billing.overageEnabled) {
    return false;
  }
  if (!cfg.DODO_API_KEY) throw new AppError(503, 'billing_not_configured', 'Dodo Payments usage reporting is not configured.');
  const persisted = await env.DB.prepare('SELECT provider_event_id FROM billing_usage_events WHERE portal_id = ? AND id = ?')
    .bind(row.portalId, row.id).first<{ provider_event_id: string | null }>();
  // Preserve legacy IDs for retries whose provider-side outcome may already exist.
  const providerEventId = persisted?.provider_event_id ?? `${row.portalId}:${row.idempotencyKey}`.slice(0, 255);
  const absoluteQuantity = providerQuantity(row.metric, row.quantity, row.metadata);
  const response = await fetch(`${dodoBase(env)}/events/ingest`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${cfg.DODO_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      events: [{
        customer_id: billing.customerId,
        event_id: providerEventId,
        event_name: providerEventName(env, row.metric),
        timestamp: row.occurredAt,
        metadata: metadataValues(row.portalId, absoluteQuantity, row.metadata),
      }],
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new AppError(502, 'dodo_usage_report_failed', `Dodo Payments usage reporting failed with status ${response.status}.`, detail.slice(0, 1000));
  }
  const payload = await response.json() as { ingested_count?: number };
  if (Number(payload.ingested_count ?? 0) < 1) throw new AppError(502, 'dodo_usage_not_ingested', 'Dodo Payments did not ingest the usage event.');
  await env.DB.prepare(
    `UPDATE billing_usage_events SET status = 'reported', provider_event_id = ?, reported_at = ?, error_message = NULL WHERE id = ?`,
  ).bind(providerEventId, new Date().toISOString(), row.id).run();
  return true;
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
  const common = {
    id,
    portalId,
    metric,
    quantity,
    key,
    metadataJson: JSON.stringify(enrichedMetadata),
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

  const storedQuantity = aggregation === 'max'
    ? localUsageIncrement(metric, allowance.consumedQuantity, quantity)
    : quantity;
  try {
    const reported = await reportEvent(env, {
      id,
      portalId,
      metric,
      quantity: storedQuantity,
      idempotencyKey: key,
      occurredAt,
      metadata: enrichedMetadata,
    });
    return { recorded: true, reported };
  } catch (error) {
    await env.DB.prepare(
      `UPDATE billing_usage_events SET status = 'pending', error_message = ? WHERE id = ?`,
    ).bind((error instanceof Error ? error.message : String(error)).slice(0, 1500), id).run();
    throw error;
  }
}

export async function retryAtomicUsageReports(env: Env, limit = 100): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT id, portal_id, event_name, quantity, idempotency_key, metadata_json, occurred_at
     FROM billing_usage_events
     WHERE status = 'pending' AND error_message IS NOT NULL
     ORDER BY occurred_at ASC LIMIT ?`,
  ).bind(Math.min(500, Math.max(1, limit))).all<Record<string, unknown>>();
  for (const item of rows.results ?? []) {
    const row = {
      id: String(item.id),
      portalId: String(item.portal_id),
      metric: String(item.event_name) as BillableMetric,
      quantity: Number(item.quantity),
      idempotencyKey: String(item.idempotency_key),
      occurredAt: String(item.occurred_at),
      metadata: JSON.parse(String(item.metadata_json ?? '{}')) as Record<string, string | number | boolean | null>,
    };
    try {
      await reportEvent(env, row);
    } catch (error) {
      await env.DB.prepare(`UPDATE billing_usage_events SET error_message = ? WHERE id = ?`)
        .bind((error instanceof Error ? error.message : String(error)).slice(0, 1500), row.id).run();
      console.error(JSON.stringify({ level: 'error', task: 'dodo_usage_retry', portalId: row.portalId, metric: row.metric, error: error instanceof Error ? error.message : String(error) }));
    }
  }
}
