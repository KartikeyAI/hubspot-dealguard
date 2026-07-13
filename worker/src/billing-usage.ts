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
): Record<string, string> {
  const output: Record<string, string> = {
    portal_id: portalId,
    quantity: String(quantity),
  };
  for (const [key, value] of Object.entries(metadata)) {
    if (value !== null) output[key.slice(0, 100)] = String(value).slice(0, 500);
  }
  return output;
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
  if (billing.provider !== 'dodo' || !billing.customerId || billing.usageMode !== 'metered' || !billing.overageEnabled) {
    return false;
  }
  if (!cfg.DODO_API_KEY) throw new AppError(503, 'billing_not_configured', 'Dodo Payments usage reporting is not configured.');
  const providerEventId = `${row.portalId}:${row.idempotencyKey}`.slice(0, 255);
  const response = await fetch(`${dodoBase(env)}/events/ingest`, {
    method: 'POST',
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
        metadata: metadataValues(row.portalId, row.quantity, row.metadata),
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

export async function recordUsageAtomic(
  env: Env,
  portalId: string,
  metric: BillableMetric,
  quantity: number,
  idempotencyKey: string,
  metadata: Record<string, string | number | boolean | null> = {},
): Promise<{ recorded: boolean; reported: boolean }> {
  if (!Number.isFinite(quantity) || quantity < 0) throw new AppError(400, 'usage_quantity_invalid', 'Usage quantity must be a non-negative number.');
  if (!idempotencyKey.trim()) throw new AppError(400, 'usage_idempotency_required', 'Usage reporting requires an idempotency key.');
  const billing = await getBillingStatus(env, portalId);
  const allowance = billing.allowances.find((item) => item.metric === metric);
  if (!allowance) throw new AppError(400, 'usage_metric_invalid', 'The requested usage metric is not configured.');
  const start = periodStart(billing.currentPeriodStart);
  const id = crypto.randomUUID();
  const occurredAt = new Date().toISOString();
  const key = idempotencyKey.trim().slice(0, 255);
  const overageAllowed = allowance.overageEnabled ? 1 : 0;
  const hardLimit = allowance.hardLimit;

  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO billing_usage_counters (portal_id, metric, period_start, consumed_quantity, updated_at)
       SELECT ?, ?, ?, COALESCE(SUM(quantity), 0), ? FROM billing_usage_events
       WHERE portal_id = ? AND event_name = ? AND occurred_at >= ?`,
    ).bind(portalId, metric, start, occurredAt, portalId, metric, start),
    env.DB.prepare(
      `INSERT OR IGNORE INTO billing_usage_events
       (id, portal_id, event_name, quantity, idempotency_key, status, metadata_json, occurred_at, created_at)
       SELECT ?, ?, ?, ?, ?, 'pending', ?, ?, ?
       WHERE (? = 1 OR ? IS NULL OR
         COALESCE((SELECT consumed_quantity FROM billing_usage_counters
                   WHERE portal_id = ? AND metric = ? AND period_start = ?), 0) + ? <= ?)`,
    ).bind(
      id, portalId, metric, quantity, key, JSON.stringify(metadata), occurredAt, occurredAt,
      overageAllowed, hardLimit, portalId, metric, start, quantity, hardLimit,
    ),
    env.DB.prepare(
      `INSERT INTO billing_usage_counters (portal_id, metric, period_start, consumed_quantity, updated_at)
       SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM billing_usage_events WHERE id = ?)
       ON CONFLICT(portal_id, metric, period_start) DO UPDATE SET
         consumed_quantity = billing_usage_counters.consumed_quantity + excluded.consumed_quantity,
         updated_at = excluded.updated_at`,
    ).bind(portalId, metric, start, quantity, occurredAt, id),
  ]);

  const inserted = Number(results[1]?.meta?.changes ?? 0) > 0;
  if (!inserted) {
    const duplicate = await env.DB.prepare(
      `SELECT id, status FROM billing_usage_events WHERE portal_id = ? AND idempotency_key = ?`,
    ).bind(portalId, key).first<{ id: string; status: string }>();
    if (duplicate) return { recorded: false, reported: duplicate.status === 'reported' };
    throw new AppError(402, 'usage_limit_reached', `The ${metric} allowance has been exhausted and overage is disabled.`, { metric, allowance });
  }

  try {
    const reported = await reportEvent(env, {
      id,
      portalId,
      metric,
      quantity,
      idempotencyKey: key,
      occurredAt,
      metadata,
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
