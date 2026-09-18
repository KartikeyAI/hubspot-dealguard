import type { Env } from './types.js';

export const OUTCOME_EVIDENCE_METHOD = 'latest_preclose_assessment_for_current_closed_episode';
export const OUTCOME_EVIDENCE_LIMITS = { maximumDeals: 10_000, maximumObservations: 250_000 } as const;

type Row = Record<string, unknown>;
type Predicate = { sql: string; params: readonly string[] };
type Window = { since: string; asOf: string };

/** Predicates are compiled by analyticsPredicate using fixed repository aliases, never request SQL. */
export function buildOutcomeEvidenceQuery(
  portalId: string, currentScope: Predicate, closureScope: Predicate, precloseScope: Predicate, window: Window,
): { sql: string; params: Array<string | number> } {
  const metrics = [['score', 'score BETWEEN 0 AND 100'], ['issue_count', 'issue_count >= 0'],
    ['stage_age_days', 'stage_age_days >= 0']] as const;
  const aggregates = [0, 1].flatMap((won) => metrics.flatMap(([field, validity]) => {
    const group = won === 1 ? 'won' : 'lost';
    const condition = `excluded_reason IS NULL AND is_won = ${won} AND pre_${validity}`;
    return [`COUNT(*) FILTER (WHERE ${condition}) AS ${group}_${field}_count`,
      `AVG(pre_${field}) FILTER (WHERE ${condition}) AS ${group}_${field}_average`];
  })).join(',\n      ');
  return {
    params: [window.asOf, window.since, portalId, ...currentScope.params,
      OUTCOME_EVIDENCE_LIMITS.maximumDeals, OUTCOME_EVIDENCE_LIMITS.maximumObservations,
      ...precloseScope.params, ...closureScope.params],
    sql: `WITH bounds AS (
      SELECT ?::timestamptz AS as_of, ?::timestamptz AS since
    ), history AS MATERIALIZED (
      SELECT id, deal_id, pipeline_id, stage_id, owner_id, team_id, region_code,
        score, issue_count, stage_age_days, is_closed, is_won,
        CASE WHEN assessed_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6}){0,1}(Z|[+-][0-9]{2}:[0-9]{2})$'
          AND pg_input_is_valid(assessed_at, 'timestamp with time zone')
          THEN assessed_at::timestamptz ELSE NULL END AS observed_at
      FROM assessment_history WHERE portal_id = ?
    ), current_latest AS (
      SELECT DISTINCT ON (deal_id) * FROM history
      ORDER BY deal_id, observed_at DESC NULLS FIRST, id DESC
    ), authorized AS MATERIALIZED (
      SELECT deal_id FROM current_latest latest WHERE ${currentScope.sql}
    ), quality AS (
      SELECT (SELECT COUNT(*) FROM authorized) AS authorized_deals,
        COUNT(*) AS retained_observations,
        COUNT(*) FILTER (WHERE observed_at IS NULL) AS invalid_timestamps,
        COUNT(*) FILTER (WHERE is_closed IS NULL OR is_closed NOT IN (0, 1)
          OR is_won IS NULL OR is_won NOT IN (0, 1)
          OR (is_closed = 0 AND is_won = 1)) AS invalid_states
      FROM history JOIN authorized USING (deal_id)
    ), eligible AS MATERIALIZED (
      SELECT history.* FROM history JOIN authorized USING (deal_id)
      CROSS JOIN quality CROSS JOIN bounds
      WHERE quality.authorized_deals <= ? AND quality.retained_observations <= ?
        AND quality.invalid_timestamps = 0 AND quality.invalid_states = 0
        AND observed_at <= bounds.as_of
    ), observations AS MATERIALIZED (
      -- A UUID tie-break is not proof of an open/closed sequence at the same instant.
      SELECT DISTINCT ON (deal_id, observed_at) * FROM eligible
      ORDER BY deal_id, observed_at, id DESC
    ), latest_observed AS (
      SELECT DISTINCT ON (deal_id) * FROM observations
      ORDER BY deal_id, observed_at DESC, id DESC
    ), last_open AS (
      SELECT DISTINCT ON (deal_id) * FROM observations WHERE is_closed = 0
      ORDER BY deal_id, observed_at DESC, id DESC
    ), closures AS (
      -- Select the FIRST close in the current episode, not a later refresh of a closed record.
      SELECT DISTINCT ON (history.deal_id) history.* FROM observations history
      JOIN latest_observed current ON current.deal_id = history.deal_id AND current.is_closed = 1
      LEFT JOIN last_open opening ON opening.deal_id = history.deal_id
      WHERE history.is_closed = 1 AND (opening.observed_at IS NULL OR history.observed_at > opening.observed_at)
      ORDER BY history.deal_id, history.observed_at, history.id
    ), candidates AS (
      SELECT closure.is_won, closure.observed_at AS outcome_at,
        pre.score AS pre_score, pre.issue_count AS pre_issue_count, pre.stage_age_days AS pre_stage_age_days,
        CASE WHEN pre.observed_at IS NULL THEN 'no_preclose_evidence'
          WHEN (${precloseScope.sql}) IS NOT TRUE THEN 'preclose_outside_scope'
          WHEN EXISTS (SELECT 1 FROM observations later
            WHERE later.deal_id = closure.deal_id AND later.observed_at >= closure.observed_at
              AND later.is_closed = 1 AND later.is_won <> closure.is_won)
            THEN 'conflicting_outcome_labels'
          ELSE NULL END AS excluded_reason
      FROM closures closure LEFT JOIN last_open pre ON pre.deal_id = closure.deal_id
      CROSS JOIN bounds
      WHERE closure.observed_at >= bounds.since AND closure.observed_at <= bounds.as_of
        AND (${closureScope.sql})
    ), totals AS (
      SELECT COUNT(*) AS closed_deals_in_window,
        COUNT(*) FILTER (WHERE excluded_reason IS NULL) AS sample_size,
        COUNT(*) FILTER (WHERE excluded_reason IS NULL AND is_won = 1) AS won,
        COUNT(*) FILTER (WHERE excluded_reason IS NULL AND is_won = 0) AS lost,
        COUNT(*) FILTER (WHERE excluded_reason = 'no_preclose_evidence') AS without_preclose,
        COUNT(*) FILTER (WHERE excluded_reason = 'preclose_outside_scope') AS preclose_outside_scope,
        COUNT(*) FILTER (WHERE excluded_reason = 'conflicting_outcome_labels') AS conflicting_outcomes,
        to_char(MIN(outcome_at) FILTER (WHERE excluded_reason IS NULL) AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS first_outcome_at,
        to_char(MAX(outcome_at) FILTER (WHERE excluded_reason IS NULL) AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_outcome_at,
        ${aggregates}
      FROM candidates
    ) SELECT quality.*, totals.* FROM quality CROSS JOIN totals`,
  };
}

function numeric(value: unknown): number | null {
  if ((typeof value !== 'number' && typeof value !== 'string') || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function count(value: unknown): number | null {
  const parsed = numeric(value);
  return parsed !== null && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
const round = (value: number): number => Math.round(value * 10) / 10;

/** No unknown group average or single-class comparison is manufactured as zero. */
export function outcomeEvidenceSummary(row: Row | undefined, window: Window) {
  const data = row ?? {};
  const countFields = ['authorized_deals', 'retained_observations', 'invalid_timestamps', 'invalid_states',
    'closed_deals_in_window', 'sample_size', 'won', 'lost', 'without_preclose', 'preclose_outside_scope',
    'conflicting_outcomes', ...['won', 'lost'].flatMap((group) =>
      ['score', 'issue_count', 'stage_age_days'].map((field) => `${group}_${field}_count`))];
  const samples = count(data.sample_size) ?? 0, won = count(data.won) ?? 0, lost = count(data.lost) ?? 0;
  let reason = countFields.some((key) => count(data[key]) === null) ? 'incomplete_outcome_result'
    : Number(data.invalid_timestamps) > 0 ? 'invalid_assessment_timestamps'
      : Number(data.invalid_states) > 0 ? 'invalid_lifecycle_states'
        : Number(data.authorized_deals) > OUTCOME_EVIDENCE_LIMITS.maximumDeals ? 'portfolio_limit_exceeded'
          : Number(data.retained_observations) > OUTCOME_EVIDENCE_LIMITS.maximumObservations ? 'history_limit_exceeded' : null;
  if (!reason && (samples !== won + lost || Number(data.closed_deals_in_window) !== samples
    + Number(data.without_preclose) + Number(data.preclose_outside_scope) + Number(data.conflicting_outcomes)
    || ['won', 'lost'].some((group) => ['score', 'issue_count', 'stage_age_days']
      .some((field) => Number(data[`${group}_${field}_count`]) > Number(data[group]))))) {
    reason = 'inconsistent_outcome_result';
  }
  const average = (group: 'won' | 'lost', field: string): number | null => {
    const size = group === 'won' ? won : lost;
    const value = numeric(data[`${group}_${field}_average`]);
    if (reason || size === 0 || Number(data[`${group}_${field}_count`]) !== size || value === null
      || value < 0 || (field === 'score' && value > 100)) return null;
    return round(value);
  };
  const wonScore = average('won', 'score'), lostScore = average('lost', 'score');
  const hasScoreComparison = wonScore !== null && lostScore !== null;
  const confidence = !reason && hasScoreComparison && samples >= 100 && Math.min(won, lost) >= 30 ? 'strong'
    : !reason && hasScoreComparison && samples >= 30 && Math.min(won, lost) >= 10 ? 'directional' : 'limited';
  return {
    methodology: OUTCOME_EVIDENCE_METHOD,
    status: reason ? 'unavailable' : samples > 0 ? 'available' : 'insufficient_evidence',
    reason: reason ?? (samples === 0 ? 'no_eligible_closed_episodes' : null),
    window: { start: window.since, end: window.asOf, basis: 'first_observed_close_in_current_episode' },
    sampleSize: reason ? 0 : samples, won: reason ? 0 : won, lost: reason ? 0 : lost,
    winRate: !reason && samples > 0 ? round(won / samples * 100) : null,
    winRateBasis: 'included_deals_with_preclose_evidence_not_all_pipeline_outcomes',
    wonAverageScore: wonScore, lostAverageScore: lostScore,
    scoreDelta: hasScoreComparison ? round(wonScore - lostScore) : null,
    wonAverageIssues: average('won', 'issue_count'), lostAverageIssues: average('lost', 'issue_count'),
    wonAverageStageAgeDays: average('won', 'stage_age_days'), lostAverageStageAgeDays: average('lost', 'stage_age_days'),
    confidence, confidenceBasis: 'sample_size_and_group_coverage_not_predictive_confidence',
    coverage: reason ? null : {
      closedDealsInWindow: Number(data.closed_deals_in_window), includedDeals: samples,
      withoutPrecloseEvidence: Number(data.without_preclose), precloseOutsideScope: Number(data.preclose_outside_scope),
      conflictingOutcomes: Number(data.conflicting_outcomes),
      won: { score: Number(data.won_score_count), issues: Number(data.won_issue_count_count), stageAge: Number(data.won_stage_age_days_count) },
      lost: { score: Number(data.lost_score_count), issues: Number(data.lost_issue_count_count), stageAge: Number(data.lost_stage_age_days_count) },
      firstOutcomeAt: data.first_outcome_at ?? null, lastOutcomeAt: data.last_outcome_at ?? null,
    },
    semantics: {
      currentlyClosedOnly: true, repeatedCloseObservationsDoNotShiftWindow: true,
      precloseEvidenceStrictlyBeforeClosure: true, retainedHistoryOnly: true,
      causalAttribution: false, calibratedPrediction: false,
    },
  };
}

export async function loadOutcomeEvidence(
  env: Env, portalId: string, currentScope: Predicate, closureScope: Predicate,
  precloseScope: Predicate, window: Window,
) {
  const query = buildOutcomeEvidenceQuery(portalId, currentScope, closureScope, precloseScope, window);
  const row = await env.DB.prepare(query.sql).bind(...query.params).first<Row>();
  return outcomeEvidenceSummary(row ?? undefined, window);
}
