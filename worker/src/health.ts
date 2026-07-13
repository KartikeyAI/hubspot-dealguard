import { getBillingStatus } from './billing.js';
import type { Env } from './types.js';

interface HealthRow {
  status: 'healthy' | 'degraded' | 'failing';
  last_scan_success_at: string | null;
  last_webhook_success_at: string | null;
  last_delivery_success_at: string | null;
  last_failure_at: string | null;
  consecutive_failures: number;
  last_error: string | null;
  updated_at: string;
}

export interface ServiceHealthView {
  status: 'healthy' | 'degraded' | 'failing';
  lastScanSuccessAt: string | null;
  lastWebhookSuccessAt: string | null;
  lastDeliverySuccessAt: string | null;
  lastFailureAt: string | null;
  consecutiveFailures: number;
  lastError: string | null;
  pendingDeliveries: number;
  failedDeliveries: number;
  deadLetters: number;
  overdueRemediations: number;
  subscription: Awaited<ReturnType<typeof getBillingStatus>>;
  updatedAt: string | null;
}

export async function recordServiceSuccess(env: Env, portalId: string, kind: 'scan' | 'webhook' | 'delivery'): Promise<void> {
  const now = new Date().toISOString();
  const column = kind === 'scan' ? 'last_scan_success_at' : kind === 'webhook' ? 'last_webhook_success_at' : 'last_delivery_success_at';
  await env.DB.prepare(
    `INSERT INTO service_health (portal_id, status, ${column}, consecutive_failures, last_error, updated_at)
     VALUES (?, 'healthy', ?, 0, NULL, ?)
     ON CONFLICT(portal_id) DO UPDATE SET
       status = 'healthy',
       ${column} = excluded.${column},
       consecutive_failures = 0,
       last_error = NULL,
       updated_at = excluded.updated_at`
  ).bind(portalId, now, now).run();
}

export async function recordServiceFailure(env: Env, portalId: string, error: unknown): Promise<void> {
  const now = new Date().toISOString();
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
  await env.DB.prepare(
    `INSERT INTO service_health (portal_id, status, last_failure_at, consecutive_failures, last_error, updated_at)
     VALUES (?, 'degraded', ?, 1, ?, ?)
     ON CONFLICT(portal_id) DO UPDATE SET
       status = CASE WHEN service_health.consecutive_failures + 1 >= 5 THEN 'failing' ELSE 'degraded' END,
       last_failure_at = excluded.last_failure_at,
       consecutive_failures = service_health.consecutive_failures + 1,
       last_error = excluded.last_error,
       updated_at = excluded.updated_at`
  ).bind(portalId, now, message, now).run();
}

export async function serviceHealth(env: Env, portalId: string): Promise<ServiceHealthView> {
  const [row, outbox, remediation, subscription] = await Promise.all([
    env.DB.prepare(`SELECT * FROM service_health WHERE portal_id = ?`).bind(portalId).first<HealthRow>(),
    env.DB.prepare(
      `SELECT
        SUM(CASE WHEN status IN ('pending', 'processing') THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status = 'dead_letter' THEN 1 ELSE 0 END) AS dead
       FROM outbox_events WHERE portal_id = ?`
    ).bind(portalId).first<Record<string, unknown>>(),
    env.DB.prepare(`SELECT COUNT(*) AS count FROM remediation_cases WHERE portal_id = ? AND status = 'overdue'`).bind(portalId).first<{ count: number }>(),
    getBillingStatus(env, portalId),
  ]);
  const deadLetters = Number(outbox?.dead ?? 0);
  const failed = Number(outbox?.failed ?? 0);
  const calculatedStatus = deadLetters > 0 || (row?.consecutive_failures ?? 0) >= 5
    ? 'failing'
    : failed > 0 || (row?.consecutive_failures ?? 0) > 0
      ? 'degraded'
      : row?.status ?? 'healthy';
  return {
    status: calculatedStatus,
    lastScanSuccessAt: row?.last_scan_success_at ?? null,
    lastWebhookSuccessAt: row?.last_webhook_success_at ?? null,
    lastDeliverySuccessAt: row?.last_delivery_success_at ?? null,
    lastFailureAt: row?.last_failure_at ?? null,
    consecutiveFailures: Number(row?.consecutive_failures ?? 0),
    lastError: row?.last_error ?? null,
    pendingDeliveries: Number(outbox?.pending ?? 0),
    failedDeliveries: failed,
    deadLetters,
    overdueRemediations: Number(remediation?.count ?? 0),
    subscription,
    updatedAt: row?.updated_at ?? null,
  };
}
