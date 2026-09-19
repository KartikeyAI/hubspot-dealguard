import { analyticsFilters, analyticsPredicate, selectedAnalyticsFilters, requireAnalyticsCollectionAccess } from './analytics-scope.js';
import { portfolioHistoryPoint, portfolioHistoryWindow } from './portfolio-history.js';
import { requireCommercialTier } from './billing.js';
import type { Env, RequestIdentity } from './types.js';

export const SNAPSHOT_MAX_DEALS = 10_000;

/** Atomic manifest + items: a retry cannot revise an already captured UTC day. */
export function portfolioCaptureQuery(portalId: string, capturedAt: string, runId: string) {
  return {
    params: [portalId, SNAPSHOT_MAX_DEALS + 1, capturedAt,
      runId, portalId, capturedAt, capturedAt, SNAPSHOT_MAX_DEALS, portalId],
    sql: `WITH candidates AS MATERIALIZED (
      SELECT DISTINCT ON (deal_id) id AS source_assessment_id, deal_id, pipeline_id, stage_id,
        owner_id, team_id, region_code, score, status, is_closed, deal_amount, deal_currency_code,
        deal_amount_in_company_currency,
        CASE WHEN assessed_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T.*(Z|[+-][0-9]{2}:[0-9]{2})$'
          AND pg_input_is_valid(assessed_at, 'timestamp with time zone') THEN assessed_at::timestamptz END AS observed_at
      FROM assessment_history WHERE portal_id = ? AND dealguard.record_is_available(assessment_history.portal_id,deal_id)
      ORDER BY deal_id, observed_at DESC NULLS FIRST, id DESC
    ), bounded AS MATERIALIZED (SELECT * FROM candidates ORDER BY deal_id LIMIT ?),
    quality AS (
      SELECT COUNT(*)::integer AS count,
        COUNT(*) FILTER (WHERE observed_at IS NULL OR observed_at > ?::timestamptz
          OR is_closed NOT IN (0,1) OR is_closed IS NULL
          OR status NOT IN ('ready','at_risk','critical'))::integer AS invalid,
        encode(sha256(convert_to(COALESCE(string_agg(to_jsonb(bounded)::text, E'\n' ORDER BY deal_id), ''), 'UTF8')), 'hex') AS fingerprint
      FROM bounded
    ), created AS (
      INSERT INTO portfolio_snapshot_runs(id, portal_id, snapshot_date, captured_at, deal_count, source_fingerprint)
      SELECT ?, ?, (?::timestamptz AT TIME ZONE 'UTC')::date, ?::timestamptz, quality.count, fingerprint
      FROM quality WHERE count BETWEEN 1 AND ? AND invalid = 0
      ON CONFLICT (portal_id, snapshot_date) DO NOTHING RETURNING id
    ), copied AS (
      INSERT INTO portfolio_snapshot_items(portal_id, run_id, deal_id, source_assessment_id, observed_at,
        pipeline_id, stage_id, owner_id, team_id, region_code, score, status, is_closed,
        deal_amount, deal_currency_code, deal_amount_in_company_currency)
      SELECT ?, created.id, b.deal_id, b.source_assessment_id, b.observed_at,
        b.pipeline_id, b.stage_id, b.owner_id, b.team_id, b.region_code, b.score, b.status, b.is_closed,
        b.deal_amount, b.deal_currency_code, b.deal_amount_in_company_currency
      FROM bounded b CROSS JOIN created RETURNING run_id
    ) SELECT quality.count, quality.invalid,
      (SELECT COUNT(*) FROM copied)::integer AS copied,
      (SELECT id FROM created) AS id FROM quality`,
  };
}

export async function capturePortfolioSnapshot(env: Env, portalId: string) {
  const capturedAt = new Date().toISOString();
  const query = portfolioCaptureQuery(portalId, capturedAt, crypto.randomUUID());
  // Bound in SQL order, keeping capture time entirely server-owned.
  const row = await env.DB.prepare(query.sql).bind(...query.params)
    .first<{ count: number; invalid: number; copied: number; id: string | null }>();
  if (!row) throw new Error('Snapshot capture returned no result.');
  if (Number(row.count) > SNAPSHOT_MAX_DEALS) return { status: 'portfolio_limit_exceeded', capturedAt: null };
  if (Number(row.invalid)) return { status: 'invalid_source_evidence', capturedAt: null };
  if (!Number(row.count)) return { status: 'no_observations', capturedAt: null };
  if (!row.id) return { status: 'already_captured', capturedAt: null };
  if (Number(row.copied) !== Number(row.count)) throw new Error('Incomplete snapshot capture.');
  return { status: 'captured', capturedAt };
}

/** Bounded, resumable maintenance with a lease to prevent repeated concurrent capture work. */
export async function captureDuePortfolioSnapshots(env: Env): Promise<void> {
  const rows = await env.DB.prepare(`SELECT t.portal_id FROM tenants t
    LEFT JOIN portfolio_snapshot_schedule s ON s.portal_id = t.portal_id
    WHERE t.status = 'active' AND (s.next_attempt_at IS NULL OR s.next_attempt_at <= NOW())
      AND NOT EXISTS (SELECT 1 FROM portfolio_snapshot_runs r WHERE r.portal_id = t.portal_id
        AND r.snapshot_date = (NOW() AT TIME ZONE 'UTC')::date)
    ORDER BY s.last_attempt_at NULLS FIRST, t.portal_id LIMIT 10`).all<{ portal_id: string }>();
  for (const { portal_id: portalId } of rows.results ?? []) {
    const lease = crypto.randomUUID();
    const claim = await env.DB.prepare(`INSERT INTO portfolio_snapshot_schedule
      (portal_id, next_attempt_at, last_attempt_at, last_result, lease_token)
      VALUES (?, NOW() + INTERVAL '15 minutes', NOW(), 'processing', ?)
      ON CONFLICT (portal_id) DO UPDATE SET next_attempt_at = excluded.next_attempt_at,
        last_attempt_at = excluded.last_attempt_at, last_result = 'processing', lease_token = excluded.lease_token
      WHERE portfolio_snapshot_schedule.next_attempt_at <= NOW() RETURNING portal_id`)
      .bind(portalId, lease).first();
    if (!claim) continue;
    let status = 'failed', capturedAt: string | null = null;
    try {
      await requireCommercialTier(env, portalId, 'enterprise');
      const result = await capturePortfolioSnapshot(env, portalId);
      status = result.status; capturedAt = result.capturedAt;
    } catch { /* Bounded public result; do not persist provider errors or credentials. */ }
    await env.DB.prepare(`UPDATE portfolio_snapshot_schedule SET last_result = ?,
      last_capture_at = COALESCE(?::timestamptz, last_capture_at),
      next_attempt_at = NOW() + INTERVAL '1 hour', lease_token = NULL WHERE portal_id = ? AND lease_token = ?`)
      .bind(status, capturedAt, portalId, lease).run();
  }
}

export async function recordedPortfolioHistory(env: Env, identity: RequestIdentity, url: URL) {
  const access = await requireAnalyticsCollectionAccess(env, identity, 'analytics.view');
  const selected = selectedAnalyticsFilters(url.searchParams);
  const { effective, authorization } = analyticsFilters(access.scope, selected);
  const window = portfolioHistoryWindow(url.searchParams);
  const historical = analyticsPredicate('state', effective);
  const current = analyticsPredicate('latest', authorization);
  // Unrestricted roles need no current-row proof; scoped roles require retained current access evidence.
  const currentAccess = current.sql === 'TRUE' ? 'TRUE' : `EXISTS (SELECT 1 FROM latest_assessments latest
    WHERE latest.deal_id = state.deal_id AND latest.current_observed_at <= NOW() AND ${current.sql})`;
  const sql = `WITH latest_assessments AS (
    SELECT DISTINCT ON (deal_id) *, CASE
      WHEN pg_input_is_valid(assessed_at, 'timestamp with time zone')
        AND assessed_at ~ 'T.*(Z|[+-][0-9]{2}:[0-9]{2})$'
      THEN assessed_at::timestamptz END AS current_observed_at
    FROM assessment_history WHERE portal_id = ?
    ORDER BY deal_id, current_observed_at DESC NULLS FIRST, id DESC
  ), days AS (
    SELECT (?::date + n)::date AS day FROM generate_series(0, ?::integer - 1) n
  ), runs AS (
    SELECT r.*, r.deal_count = (SELECT COUNT(*) FROM portfolio_snapshot_items i
      WHERE i.portal_id = r.portal_id AND i.run_id = r.id) AS intact
    FROM portfolio_snapshot_runs r WHERE r.portal_id = ? AND snapshot_date >= ?::date AND snapshot_date <= ?::date
  ), matching AS (
    SELECT d.day, r.captured_at AS snapshot_at, r.id AS capture_id, COALESCE(r.intact, TRUE) AS intact, state.*
    FROM days d LEFT JOIN runs r ON r.snapshot_date = d.day
    LEFT JOIN portfolio_snapshot_items state ON state.portal_id = r.portal_id AND state.run_id = r.id
      AND (${historical.sql}) AND (${currentAccess})
  )
    SELECT day::text AS date,
      to_char(snapshot_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS snapshot_at,
      COUNT(deal_id) AS known_deals,
      COUNT(deal_id) FILTER (WHERE is_closed = 1) AS closed_deals,
      COUNT(deal_id) FILTER (WHERE is_closed = 0) AS open_deals,
      COUNT(deal_id) FILTER (WHERE is_closed = 0 AND score BETWEEN 0 AND 100) AS scored_deals,
      AVG(score) FILTER (WHERE is_closed = 0 AND score BETWEEN 0 AND 100) AS average_score,
      COUNT(deal_id) FILTER (WHERE is_closed = 0 AND status != 'ready') AS gap_deals,
      COUNT(deal_id) FILTER (WHERE is_closed = 0 AND (observed_at AT TIME ZONE 'UTC')::date = day) AS assessed_deals,
      COUNT(deal_id) FILTER (WHERE is_closed = 0 AND snapshot_at - observed_at <= INTERVAL '24 hours') AS fresh_deals,
      COUNT(deal_id) FILTER (WHERE is_closed = 0 AND snapshot_at - observed_at > INTERVAL '24 hours'
        AND snapshot_at - observed_at <= INTERVAL '72 hours') AS aging_deals,
      COUNT(deal_id) FILTER (WHERE is_closed = 0 AND snapshot_at - observed_at > INTERVAL '72 hours') AS stale_deals,
      to_char(MIN(observed_at) FILTER (WHERE is_closed = 0) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS oldest_observed_at,
      to_char(MAX(observed_at) FILTER (WHERE is_closed = 0) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS latest_observed_at,
      COUNT(deal_id) FILTER (WHERE is_closed = 0 AND deal_amount IS NOT NULL) AS amount_deals,
      COUNT(deal_id) FILTER (WHERE is_closed = 0 AND deal_amount IS NOT NULL
        AND deal_amount_in_company_currency IS NOT NULL) AS company_amount_deals,
      COUNT(deal_id) FILTER (WHERE is_closed = 0 AND deal_amount IS NOT NULL
        AND upper(trim(deal_currency_code)) ~ '^[A-Z]{3}$') AS currency_deals,
      COUNT(DISTINCT upper(trim(deal_currency_code))) FILTER (WHERE is_closed = 0 AND deal_amount IS NOT NULL) AS currency_count,
      MIN(upper(trim(deal_currency_code))) FILTER (WHERE is_closed = 0 AND deal_amount IS NOT NULL) AS currency_code,
      SUM(deal_amount) FILTER (WHERE is_closed = 0) AS source_amount,
      SUM(CASE WHEN status != 'ready' THEN deal_amount ELSE 0 END) FILTER (WHERE is_closed = 0) AS source_gap_amount,
      SUM(deal_amount_in_company_currency) FILTER (WHERE is_closed = 0 AND deal_amount IS NOT NULL) AS company_amount,
      SUM(CASE WHEN status != 'ready' THEN deal_amount_in_company_currency ELSE 0 END)
        FILTER (WHERE is_closed = 0 AND deal_amount IS NOT NULL) AS company_gap_amount
      , bool_and(intact) AS intact, MAX(capture_id) AS capture_id
    FROM matching GROUP BY day, snapshot_at ORDER BY day`;
  const rows = await env.DB.prepare(sql).bind(identity.portalId, window.startDate, window.days,
    identity.portalId, window.startDate, window.endDate, ...historical.params, ...current.params)
    .all<Record<string, unknown>>();
  const results = rows.results ?? [];
  const intact = results.every(r => r.intact === true);
  return { status: intact ? 'available' : 'unavailable', reason: intact ? null : 'snapshot_integrity_failure',
    generatedAt: window.generatedAt, window, filters: selected,
    methodology: 'first_successful_daily_capture_v1',
    points: intact ? results.map(row => ({ ...portfolioHistoryPoint(row),
      snapshotAt: row.snapshot_at ?? null, captureId: row.capture_id ?? null,
      evidenceStatus: row.capture_id ? Number(row.known_deals) ? 'recorded' : 'no_in_scope_observations' : 'not_captured',
    })) : [],
    semantics: { durableCapture: true, historicalBackfill: false, currentAccessRechecked: true,
      missingCaptureIsNotZero: true, deletionMayRemoveEvidence: true, endOfDaySnapshot: false },
  };
}
