import { AppError } from './errors.js';
import { analyticsFilters, analyticsPredicate, selectedAnalyticsFilters,
  requireAnalyticsCollectionAccess, type AnalyticsFilters } from './analytics-scope.js';
import type { Env, RequestIdentity } from './types.js';

const DAY_MS = 86_400_000;
export const PORTFOLIO_HISTORY_LIMITS = { maximumDays: 90, maximumDeals: 10_000,
  freshHours: 24, staleAfterHours: 72 } as const;

export interface HistoryWindow {
  days: number; startDate: string; endDate: string; startAt: string; generatedAt: string;
}

/** The clock is server-owned. Request parameters cannot choose an authorization time. */
export function portfolioHistoryWindow(params: URLSearchParams, now = Date.now()): HistoryWindow {
  const values = params.getAll('days');
  const value = values[0] ?? '30';
  if (values.length > 1 || !/^[1-9][0-9]*$/.test(value)
    || Number(value) > PORTFOLIO_HISTORY_LIMITS.maximumDays || !Number.isFinite(new Date(now).getTime())) {
    throw new AppError(400, 'portfolio_history_window_invalid', 'History requires one whole-number window between 1 and 90 days.');
  }
  const generatedAt = new Date(now).toISOString();
  const endDate = generatedAt.slice(0, 10);
  const days = Number(value);
  const startAt = new Date(Date.parse(`${endDate}T00:00:00.000Z`) - (days - 1) * DAY_MS).toISOString();
  return { days, startDate: startAt.slice(0, 10), endDate, startAt, generatedAt };
}

/** A single SQL statement supplies a consistent read snapshot and bounded daily aggregates.
 * Scope is applied AFTER selecting a deal's latest state; historical states cannot resurrect
 * a closed/reassigned deal. All transitions are kept until interval construction finishes.
 */
export function buildPortfolioHistoryQuery(
  portalId: string, filters: AnalyticsFilters, authorization: AnalyticsFilters, window: HistoryWindow,
): { sql: string; params: Array<string | number> } {
  const currentScope = analyticsPredicate('latest', authorization);
  const observationScope = analyticsPredicate('state', filters);
  return {
    params: [window.generatedAt, window.startAt, window.days, portalId,
      ...currentScope.params, PORTFOLIO_HISTORY_LIMITS.maximumDeals, ...observationScope.params],
    sql: `WITH bounds AS (
      SELECT ?::timestamptz AS as_of, ?::timestamptz AS start_at, ?::integer AS days
    ), history AS MATERIALIZED (
      SELECT id, portal_id, deal_id, pipeline_id, stage_id, owner_id, team_id, region_code,
        score, status, is_closed, deal_amount, deal_currency_code, deal_amount_in_company_currency,
        CASE WHEN assessed_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6}){0,1}(Z|[+-][0-9]{2}:[0-9]{2})$'
          AND pg_input_is_valid(assessed_at, 'timestamp with time zone')
          THEN assessed_at::timestamptz ELSE NULL END AS observed_at
      FROM assessment_history WHERE portal_id = ?
    ), current_latest AS (
      SELECT DISTINCT ON (deal_id) * FROM history
      ORDER BY deal_id, observed_at DESC NULLS FIRST, id DESC
    ), authorized_deals AS MATERIALIZED (
      SELECT deal_id FROM current_latest latest WHERE ${currentScope.sql}
    ), quality AS (
      SELECT (SELECT COUNT(*) FROM authorized_deals) AS authorized_deals,
        COUNT(*) FILTER (WHERE history.observed_at IS NULL) AS invalid_timestamps
      FROM history JOIN authorized_deals USING (deal_id)
    ), eligible AS MATERIALIZED (
      SELECT history.* FROM history JOIN authorized_deals USING (deal_id)
      CROSS JOIN bounds CROSS JOIN quality
      WHERE quality.authorized_deals <= ? AND quality.invalid_timestamps = 0
        AND history.observed_at <= bounds.as_of
    ), seed AS (
      SELECT DISTINCT ON (deal_id) eligible.* FROM eligible CROSS JOIN bounds
      WHERE observed_at < bounds.start_at ORDER BY deal_id, observed_at DESC, id DESC
    ), daily_last AS (
      SELECT DISTINCT ON (deal_id, (observed_at AT TIME ZONE 'UTC')::date) eligible.*
      FROM eligible CROSS JOIN bounds WHERE observed_at >= bounds.start_at
      ORDER BY deal_id, (observed_at AT TIME ZONE 'UTC')::date, observed_at DESC, id DESC
    ), states AS (
      SELECT reduced.*, LEAD(observed_at) OVER (PARTITION BY deal_id ORDER BY observed_at, id) AS next_at
      FROM (SELECT * FROM seed UNION ALL SELECT * FROM daily_last) reduced
    ), days AS (
      SELECT (bounds.start_at AT TIME ZONE 'UTC')::date + n AS day,
        LEAST(bounds.as_of, bounds.start_at + (n + 1) * INTERVAL '24 hours' - INTERVAL '1 microsecond') AS snapshot_at
      FROM bounds CROSS JOIN generate_series(0, bounds.days - 1) n
    ), matching AS (
      SELECT days.day, days.snapshot_at, state.* FROM days
      LEFT JOIN states state ON state.observed_at <= days.snapshot_at
        AND (state.next_at IS NULL OR state.next_at > days.snapshot_at)
        AND (${observationScope.sql})
        AND dealguard.record_was_available(state.portal_id,state.deal_id,days.snapshot_at)
    )
    SELECT day::text AS date,
      to_char(snapshot_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS snapshot_at,
      MAX(quality.authorized_deals) AS authorized_deals,
      MAX(quality.invalid_timestamps) AS invalid_timestamps,
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
    FROM matching CROSS JOIN quality GROUP BY day, snapshot_at ORDER BY day`,
  };
}

function numeric(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
const count = (value: unknown): number => numeric(value) ?? 0;
const percent = (n: number, d: number): number | null => d > 0 ? Math.round(n / d * 1000) / 10 : null;

export function portfolioHistoryPoint(row: Record<string, unknown>) {
  const openDeals = count(row.open_deals), amountDeals = count(row.amount_deals);
  const companyDeals = count(row.company_amount_deals), currencyDeals = count(row.currency_deals);
  const companyAmount = numeric(row.company_amount), sourceAmount = numeric(row.source_amount);
  const code = typeof row.currency_code === 'string' && /^[A-Z]{3}$/.test(row.currency_code) ? row.currency_code : null;
  const mode = amountDeals > 0 && companyDeals === amountDeals && companyAmount !== null
    ? 'company_currency' : amountDeals > 0 && currencyDeals === amountDeals
      && count(row.currency_count) === 1 && code && sourceAmount !== null ? 'single_deal_currency' : 'unavailable';
  return {
    date: String(row.date), snapshotAt: String(row.snapshot_at),
    evidenceStatus: count(row.known_deals) > 0 ? 'recorded' : 'no_observations',
    knownDeals: count(row.known_deals), openDeals, closedDeals: count(row.closed_deals),
    averageScore: openDeals > 0 && count(row.scored_deals) === openDeals && numeric(row.average_score) !== null
      ? Math.round(Number(row.average_score) * 10) / 10 : null,
    dealsWithReadinessGaps: count(row.gap_deals), assessedDeals: count(row.assessed_deals),
    carriedForwardDeals: Math.max(0, openDeals - count(row.assessed_deals)),
    freshness: { freshDeals: count(row.fresh_deals), agingDeals: count(row.aging_deals), staleDeals: count(row.stale_deals),
      oldestObservedAt: row.oldest_observed_at ?? null, latestObservedAt: row.latest_observed_at ?? null },
    monetary: { mode, currencyCode: mode === 'single_deal_currency' ? code : null,
      pipelineAmount: mode === 'company_currency' ? companyAmount : mode === 'single_deal_currency' ? sourceAmount : null,
      amountWithReadinessGaps: mode === 'company_currency' ? numeric(row.company_gap_amount)
        : mode === 'single_deal_currency' ? numeric(row.source_gap_amount) : null,
      amountCoveragePercent: percent(amountDeals, openDeals), companyCurrencyCoveragePercent: percent(companyDeals, amountDeals) },
  };
}

export async function portfolioHistory(env: Env, identity: RequestIdentity, url: URL, now = Date.now()) {
  const access = await requireAnalyticsCollectionAccess(env, identity, 'analytics.view');
  const window = portfolioHistoryWindow(url.searchParams, now);
  const selected = selectedAnalyticsFilters(url.searchParams);
  const { effective, authorization } = analyticsFilters(access.scope, selected);
  const query = buildPortfolioHistoryQuery(identity.portalId, effective, authorization, window);
  const result = await env.DB.prepare(query.sql).bind(...query.params).all<Record<string, unknown>>();
  const rows = result.results ?? [];
  const reason = rows.length !== window.days ? 'incomplete_history_result'
    : count(rows[0]?.invalid_timestamps) > 0 ? 'invalid_assessment_timestamps'
      : count(rows[0]?.authorized_deals) > PORTFOLIO_HISTORY_LIMITS.maximumDeals ? 'portfolio_limit_exceeded' : null;
  return {
    status: reason ? 'unavailable' : 'available', reason, generatedAt: window.generatedAt,
    window: { days: window.days, startDate: window.startDate, endDate: window.endDate, timezone: 'UTC' },
    filters: selected, limits: PORTFOLIO_HISTORY_LIMITS,
    methodology: 'retained_assessment_daily_carry_forward',
    authorizationBasis: 'current_recorded_scope_and_historical_observation_scope',
    limitations: [
      'Reconstructed from retained assessments, not immutable snapshots or complete CRM history.',
      'Dates before the first retained observation are unavailable, not zero pipeline.',
      'Carrying evidence forward does not refresh it. Today is a partial day.',
      'Recorded closed/open transitions are respected; unrecorded deletion or reassignment cannot be inferred.',
      'Changes in portfolio membership, policy, currency basis or coverage are not evidence of causal improvement.',
    ],
    points: reason ? [] : rows.map(portfolioHistoryPoint),
  };
}
