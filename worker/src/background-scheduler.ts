import { AppError } from './errors.js';
import { evidenceInstant, snapshotFreshness } from './evidence-freshness.js';
import type { Env } from './types.js';

export const BACKGROUND_DISPATCH_LIMIT = 100;
export const BACKGROUND_CONTINUATION_DELAY = 20;
const MAX_COVERAGE_DEALS = 10_000;

export function backgroundPortal(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 100 || value.trim() !== value || /[\s\x00-\x1f]/.test(value)) {
    throw new AppError(400, 'background_portal_invalid', 'A valid internal portal identity is required.');
  }
  return value;
}

/** Deal close dates are planning data, not source-observation timestamps. */
export function backgroundCloseDate(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return evidenceInstant(`${value}T00:00:00.000Z`);
  if (/^(0|[1-9]\d{0,14})$/.test(value)) {
    const time = Number(value);
    if (!Number.isSafeInteger(time) || time > 253402300799999) return null;
    return new Date(time).toISOString();
  }
  return evidenceInstant(value);
}

/** One old due job always gets a slot; the others prefer actionable close plans. */
export function backgroundJobsQuery(portalId: string, refreshHours: number) {
  return { params: [portalId, refreshHours], sql: `WITH eligible AS (
    SELECT j.deal_id, j.status, j.attempts, j.available_at,
      ROW_NUMBER() OVER (ORDER BY j.available_at, j.deal_id) AS fairness_order,
      CASE WHEN EXISTS (SELECT 1 FROM remediation_cases r WHERE r.portal_id = a.portal_id AND r.deal_id = a.deal_id
        AND r.status IN ('open','acknowledged','in_progress','overdue') AND CASE WHEN pg_input_is_valid(r.due_at,'timestamp with time zone') THEN r.due_at::timestamptz END < NOW()) THEN 0
        WHEN c.close_date BETWEEN NOW() - INTERVAL '7 days' AND NOW() + INTERVAL '7 days' THEN 1
        WHEN a.status = 'critical' THEN 2
        WHEN j.completed_at IS NULL THEN 3 ELSE 4 END AS urgency_order
    FROM background_intelligence_jobs j
    JOIN deal_assessments a ON a.portal_id = j.portal_id AND a.deal_id = j.deal_id
    LEFT JOIN assessment_context c ON c.portal_id = a.portal_id AND c.deal_id = a.deal_id AND c.updated_at = a.assessed_at
    WHERE j.portal_id = ? AND a.is_closed = 0 AND dealguard.record_is_available(a.portal_id,a.deal_id)
      AND j.available_at <= NOW()
      AND (j.status IN ('queued','retry','cancelled')
        OR (j.status = 'processing' AND j.started_at < NOW() - INTERVAL '5 minutes' AND j.attempts < 5)
        OR (j.status = 'completed' AND j.completed_at <= NOW() - (?::integer * INTERVAL '1 hour')))
  ) SELECT deal_id, status, attempts FROM eligible
    ORDER BY CASE WHEN fairness_order = 1 THEN 0 ELSE 1 END, urgency_order, available_at, deal_id LIMIT 3` };
}

/** Reserve at most 100 portal wakeups. An execution lease is acquired by the consumer. */
export async function dispatchBackgroundIntelligence(env: Env): Promise<number> {
  const token = crypto.randomUUID();
  const rows = await env.DB.prepare(`WITH due AS (
    SELECT s.portal_id FROM background_intelligence_settings s JOIN tenants t ON t.portal_id = s.portal_id
    WHERE s.enabled = 1 AND t.status = 'active' AND s.next_run_at <= NOW()
      AND (s.lease_expires_at IS NULL OR s.lease_expires_at <= NOW())
      AND (s.dispatch_expires_at IS NULL OR s.dispatch_expires_at <= NOW())
    ORDER BY s.next_run_at, s.portal_id FOR UPDATE OF s SKIP LOCKED LIMIT 100
  ) UPDATE background_intelligence_settings s SET dispatch_token = ?, dispatch_expires_at = NOW() + INTERVAL '5 minutes'
    FROM due WHERE s.portal_id = due.portal_id RETURNING s.portal_id`).bind(token).all<{portal_id: string}>();
  let sent = 0;
  // Bound producer concurrency, while allowing independent portal consumers.
  const portals = rows.results ?? [];
  for (let offset = 0; offset < portals.length; offset += 10) {
    await Promise.all(portals.slice(offset, offset + 10).map(async row => {
      try {
        await env.MAINTENANCE_QUEUE.send({version: 1, kind: 'maintenance', task: 'background_intelligence',
          portalId: backgroundPortal(row.portal_id), requestedAt: new Date().toISOString()});
        sent += 1;
      } catch {
        await env.DB.prepare(`UPDATE background_intelligence_settings SET dispatch_token = NULL, dispatch_expires_at = NULL,
          last_run_error = 'background_dispatch_unavailable' WHERE portal_id = ? AND dispatch_token = ?`)
          .bind(row.portal_id, token).run();
      }
    }));
  }
  return sent;
}

/** Release only this worker's lease and publish a bounded continuation if work remains. */
export async function finishBackgroundRun(env: Env, portalId: string, lease: string, errorCode: string | null): Promise<void> {
  const token = crypto.randomUUID();
  const holdSeconds = errorCode === 'background_budget_exhausted' ? -1
    : errorCode === 'hubspot_reauthorization_required' || errorCode === 'enterprise_plan_required' ? 21600
      : errorCode === 'hubspot_rate_limited' ? 300 : errorCode ? 900 : 15;
  const row = await env.DB.prepare(`WITH pending AS (
    SELECT 1 FROM deal_assessments a LEFT JOIN background_intelligence_jobs j
      ON j.portal_id = a.portal_id AND j.deal_id = a.deal_id
    WHERE a.portal_id = ? AND a.is_closed = 0 AND dealguard.record_is_available(a.portal_id,a.deal_id)
      AND (j.deal_id IS NULL OR (j.status IN ('queued','retry','cancelled') AND j.available_at <= NOW())
        OR (j.status = 'completed' AND j.available_at <= NOW()
          AND j.completed_at <= NOW() - ((SELECT refresh_hours FROM background_intelligence_settings WHERE portal_id=a.portal_id) * INTERVAL '1 hour'))) LIMIT 1
  ), budget AS (
    SELECT COALESCE(u.request_count,0) < s.daily_request_limit AS available FROM background_intelligence_settings s
    LEFT JOIN background_intelligence_usage u ON u.portal_id = s.portal_id AND u.usage_date = (NOW() AT TIME ZONE 'UTC')::date
    WHERE s.portal_id = ?
  ) UPDATE background_intelligence_settings s SET lease_token = NULL, lease_expires_at = NULL,
    next_run_at = CASE WHEN ?::integer = -1 OR NOT COALESCE((SELECT available FROM budget),false)
      THEN ((NOW() AT TIME ZONE 'UTC')::date + 1)::timestamp AT TIME ZONE 'UTC'
      WHEN ?::integer > 15 THEN NOW() + (?::integer * INTERVAL '1 second')
      WHEN EXISTS (SELECT 1 FROM pending) THEN NOW() + INTERVAL '15 seconds' ELSE NOW() + INTERVAL '15 minutes' END,
    dispatch_token = CASE WHEN ?::integer = 15 AND EXISTS (SELECT 1 FROM pending)
      AND COALESCE((SELECT available FROM budget),false) THEN ? ELSE NULL END,
    dispatch_expires_at = CASE WHEN ?::integer = 15 AND EXISTS (SELECT 1 FROM pending)
      AND COALESCE((SELECT available FROM budget),false) THEN NOW() + INTERVAL '5 minutes' ELSE NULL END,
    last_run_error = ?
    WHERE s.portal_id = ? AND s.lease_token = ?
    RETURNING s.dispatch_token, s.next_run_at`).bind(portalId, portalId, holdSeconds, holdSeconds, holdSeconds,
      holdSeconds, token, holdSeconds, errorCode, portalId, lease).first<{dispatch_token: string | null}>();
  if (row?.dispatch_token !== token) return;
  try {
    await env.MAINTENANCE_QUEUE.send({version: 1, kind: 'maintenance', task: 'background_intelligence',
      portalId, requestedAt: new Date().toISOString()}, {delaySeconds: BACKGROUND_CONTINUATION_DELAY});
  } catch {
    // The durable due time survives a failed send and is recovered by the cron dispatcher.
    await env.DB.prepare(`UPDATE background_intelligence_settings SET dispatch_token = NULL, dispatch_expires_at = NULL,
      last_run_error = 'background_dispatch_unavailable' WHERE portal_id = ? AND dispatch_token = ?`).bind(portalId, token).run();
  }
}

export function backgroundCoverage(rows: Array<Record<string, unknown>>, now: number) {
  if (rows.length > MAX_COVERAGE_DEALS) return null;
  const result = {open_deals: rows.length, recent_briefs: 0, aging_briefs: 0, stale_briefs: 0, unavailable_briefs: 0};
  for (const row of rows) {
    const freshness = snapshotFreshness({assessmentAt: row.assessed_at, snapshotAssessmentAt: row.assessment_at,
      generatedAt: row.generated_at, recordedStatus: row.freshness_status}, now);
    if (freshness.status === 'fresh') result.recent_briefs += 1;
    else if (freshness.status === 'aging') result.aging_briefs += 1;
    else if (freshness.status === 'stale') result.stale_briefs += 1;
    else result.unavailable_briefs += 1;
  }
  return result;
}
