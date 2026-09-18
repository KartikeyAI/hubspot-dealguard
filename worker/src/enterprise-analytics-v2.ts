import { AppError } from './errors.js';
import { loadOutcomeEvidence, OUTCOME_EVIDENCE_METHOD } from './outcome-evidence.js';
import { activePolicy } from './governance.js';
import type { DealAssessment, Env, RequestIdentity } from './types.js';
import { analyticsFilters, analyticsPredicate, analyticsViewOwner, analyticsCsvCell,
  selectedAnalyticsFilters, requireAnalyticsCollectionAccess, type AnalyticsFilters } from './analytics-scope.js';

type AnalyticsRow = Record<string, unknown>;
type MonetaryMode = 'company_currency' | 'single_deal_currency' | 'unavailable';

interface BreakdownRow extends Record<string, unknown> {
  id: string;
  label: string;
  totalDeals: number;
  averageScore: number;
  critical: number;
  criticalDeals: number;
  amountAtRisk: number | null;
  amountWithReadinessGaps: number | null;
  monetaryMode: 'company_currency' | 'unavailable';
  companyCurrencyCoveragePercent: number;
}

interface SourceCurrencyRow {
  currencyCode: string | null;
  totalDeals: number;
  dealsWithAmount: number;
  pipelineAmount: number;
  amountWithReadinessGaps: number;
}

interface MonetarySummary {
  canAggregate: boolean;
  mode: MonetaryMode;
  currencyCode: string | null;
  currencyLabel: string;
  pipelineAmount: number | null;
  amountWithReadinessGaps: number | null;
  amountCoveragePercent: number;
  companyCurrencyCoveragePercent: number;
  sourceCurrencyCoveragePercent: number;
  sourceCurrencyCount: number;
  unknownCurrencyDeals: number;
  sourceCurrencies: SourceCurrencyRow[];
  reason: string | null;
}

export const TRUSTWORTHY_INTELLIGENCE_SEMANTICS = {
  currentState: 'latest_open_assessment_per_deal',
  trend: 'latest_open_assessment_per_deal_per_day',
  outcomeEvidence: OUTCOME_EVIDENCE_METHOD,
  failurePatterns: 'latest_open_assessment_per_deal',
  amountAtRisk: 'recorded_deal_amount_with_readiness_gaps_not_expected_loss',
  currency: 'company_currency_when_fully_covered_else_single_source_currency_else_not_aggregated',
  attentionPriority: 'deterministic_prioritisation_signal_not_win_probability',
  authorization: 'current_recorded_scope_intersected_with_observation_scope',
  handoffScope: 'latest_recorded_deal_dimensions_including_closed_deals',
} as const;

function number(value: unknown): number {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function optionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value: number, digits = 1): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function percentage(numerator: number, denominator: number): number {
  return denominator > 0 ? round((numerator / denominator) * 100) : 0;
}

function normalizeCurrencyCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

function stageAgeDays(
  properties: Record<string, string | null | undefined>,
  stageId?: string,
): number | null {
  if (!stageId) return null;
  const value = properties[`hs_date_entered_${stageId}`];
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed)
    ? Math.max(0, Math.floor((Date.now() - parsed) / 86_400_000))
    : null;
}

function filterSql(alias: string, filters: AnalyticsFilters): string {
  return analyticsPredicate(alias, filters).sql;
}

function filterParams(filters: AnalyticsFilters): string[] {
  return analyticsPredicate('latest', filters).params;
}

function latestAssessmentCte(): string {
  return `latest_assessments AS (
    SELECT DISTINCT ON (deal_id) *
    FROM assessment_history
    WHERE portal_id = ?
    ORDER BY deal_id, assessed_at DESC, id DESC
  )`;
}

function currentStateWhere(alias: string, filters: AnalyticsFilters): string {
  return `${alias}.is_closed = 0 AND ${filterSql(alias, filters)}`;
}

function safeCompanyCurrencyAmount(
  row: AnalyticsRow,
  amountKey: string,
  dealsWithAmountKey: string,
  dealsWithCompanyAmountKey: string,
): number | null {
  const dealsWithAmount = number(row[dealsWithAmountKey]);
  const dealsWithCompanyAmount = number(row[dealsWithCompanyAmountKey]);
  if (dealsWithAmount === 0) return null;
  return dealsWithCompanyAmount === dealsWithAmount ? number(row[amountKey]) : null;
}

function monetarySummary(current: AnalyticsRow | null, sourceCurrencies: SourceCurrencyRow[]): MonetarySummary {
  const totalDeals = number(current?.total_deals);
  const dealsWithAmount = number(current?.deals_with_amount);
  const dealsWithCompanyCurrencyAmount = number(current?.deals_with_company_currency_amount);
  const dealsWithCurrencyCode = number(current?.deals_with_currency_code);
  const knownCurrencies = sourceCurrencies.filter((row) => row.currencyCode !== null);
  const unknownCurrencyDeals = sourceCurrencies
    .filter((row) => row.currencyCode === null)
    .reduce((sum, row) => sum + row.dealsWithAmount, 0);

  const base = {
    amountCoveragePercent: percentage(dealsWithAmount, totalDeals),
    companyCurrencyCoveragePercent: percentage(dealsWithCompanyCurrencyAmount, dealsWithAmount),
    sourceCurrencyCoveragePercent: percentage(dealsWithCurrencyCode, dealsWithAmount),
    sourceCurrencyCount: knownCurrencies.length,
    unknownCurrencyDeals,
    sourceCurrencies,
  };

  if (dealsWithAmount === 0) {
    return {
      ...base,
      canAggregate: false,
      mode: 'unavailable',
      currencyCode: null,
      currencyLabel: 'Currency unavailable',
      pipelineAmount: null,
      amountWithReadinessGaps: null,
      reason: 'No current open deal amounts are recorded.',
    };
  }

  if (dealsWithCompanyCurrencyAmount === dealsWithAmount) {
    return {
      ...base,
      canAggregate: true,
      mode: 'company_currency',
      currencyCode: null,
      currencyLabel: 'Company currency',
      pipelineAmount: number(current?.pipeline_amount_in_company_currency),
      amountWithReadinessGaps: number(current?.amount_with_readiness_gaps_in_company_currency),
      reason: null,
    };
  }

  if (knownCurrencies.length === 1 && dealsWithCurrencyCode === dealsWithAmount && unknownCurrencyDeals === 0) {
    const single = knownCurrencies[0]!;
    return {
      ...base,
      canAggregate: true,
      mode: 'single_deal_currency',
      currencyCode: single.currencyCode,
      currencyLabel: single.currencyCode ?? 'Deal currency',
      pipelineAmount: single.pipelineAmount,
      amountWithReadinessGaps: single.amountWithReadinessGaps,
      reason: null,
    };
  }

  return {
    ...base,
    canAggregate: false,
    mode: 'unavailable',
    currencyCode: null,
    currencyLabel: 'Mixed or incomplete currencies',
    pipelineAmount: null,
    amountWithReadinessGaps: null,
    reason: 'Deal amounts span multiple or unknown currencies and company-currency coverage is incomplete. DealGuard will not sum them.',
  };
}

export async function recordAssessmentHistory(
  env: Env,
  portalId: string,
  assessment: DealAssessment,
  input: {
    trigger: string;
    properties?: Record<string, string | null | undefined>;
    policyId?: string | null;
  },
): Promise<void> {
  const props = input.properties ?? {};
  const active = input.policyId === undefined ? await activePolicy(env, portalId) : null;
  const dealAmount = assessment.dealAmount ?? optionalNumber(props.amount);
  const dealCurrencyCode = normalizeCurrencyCode(props.deal_currency_code);
  const dealAmountInCompanyCurrency = optionalNumber(props.amount_in_home_currency);

  await env.DB.prepare(
    `INSERT INTO assessment_history (
      id, portal_id, deal_id, score, grade, status, issue_codes_json, issue_count,
      pipeline_id, pipeline_label, stage_id, stage_label, owner_id, team_id, region_code,
      deal_type, deal_amount, deal_currency_code, deal_amount_in_company_currency,
      stage_age_days, is_closed, is_won, policy_id, trigger_type, assessed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    portalId,
    assessment.dealId,
    assessment.score,
    assessment.grade,
    assessment.status,
    JSON.stringify(assessment.issues.map((item) => item.code)),
    assessment.issues.length,
    assessment.pipelineId ?? props.pipeline ?? null,
    assessment.pipelineLabel,
    assessment.stageId ?? props.dealstage ?? null,
    assessment.stageLabel,
    assessment.ownerId ?? props.hubspot_owner_id ?? null,
    props.hs_team_id ?? props.dealguard_team_id ?? null,
    props.region ?? props.dealguard_region ?? null,
    props.dealtype ?? props.deal_type ?? null,
    dealAmount,
    dealCurrencyCode,
    dealAmountInCompanyCurrency,
    stageAgeDays(props, assessment.stageId ?? props.dealstage ?? undefined),
    assessment.isClosed ? 1 : 0,
    assessment.isWon ? 1 : 0,
    input.policyId ?? active?.id ?? null,
    input.trigger.slice(0, 40),
    assessment.assessedAt,
  ).run();
}

async function aggregate(
  env: Env,
  portalId: string,
  since: string,
  filters: AnalyticsFilters,
  authorization: AnalyticsFilters,
  asOf: string,
): Promise<Record<string, unknown>> {
  const scopedParams = filterParams(filters);
  const authorizationParams = filterParams(authorization);
  // Historical observations require both current access and in-scope observed dimensions.
  const authorizedDeal = (alias: string) => `EXISTS (
    SELECT 1 FROM latest_assessments authorized
    WHERE authorized.deal_id = ${alias}.deal_id AND ${filterSql('authorized', authorization)}
  )`;

  const current = await env.DB.prepare(
    `WITH ${latestAssessmentCte()}
    SELECT
      COUNT(*) AS total_deals,
      AVG(latest.score) AS average_score,
      SUM(CASE WHEN latest.status = 'critical' THEN 1 ELSE 0 END) AS critical_deals,
      SUM(CASE WHEN latest.status = 'at_risk' THEN 1 ELSE 0 END) AS at_risk_deals,
      SUM(CASE WHEN latest.status = 'ready' THEN 1 ELSE 0 END) AS ready_deals,
      SUM(CASE WHEN latest.status != 'ready'
        THEN COALESCE(latest.deal_amount_in_company_currency, 0) ELSE 0 END
      ) AS amount_with_readiness_gaps_in_company_currency,
      SUM(COALESCE(latest.deal_amount_in_company_currency, 0)) AS pipeline_amount_in_company_currency,
      AVG(latest.stage_age_days) AS average_stage_age,
      SUM(CASE WHEN latest.deal_amount IS NOT NULL THEN 1 ELSE 0 END) AS deals_with_amount,
      SUM(CASE WHEN latest.deal_amount IS NOT NULL
        AND latest.deal_amount_in_company_currency IS NOT NULL THEN 1 ELSE 0 END
      ) AS deals_with_company_currency_amount,
      SUM(CASE WHEN latest.deal_amount IS NOT NULL
        AND latest.deal_currency_code ~ '^[A-Z]{3}$' THEN 1 ELSE 0 END
      ) AS deals_with_currency_code,
      SUM(CASE WHEN latest.stage_age_days IS NOT NULL THEN 1 ELSE 0 END) AS deals_with_stage_age,
      SUM(CASE WHEN latest.owner_id IS NOT NULL AND latest.owner_id != '' THEN 1 ELSE 0 END) AS deals_with_owner,
      MIN(latest.assessed_at) AS oldest_assessment_at,
      MAX(latest.assessed_at) AS latest_assessment_at
    FROM latest_assessments latest
    WHERE ${currentStateWhere('latest', filters)}`,
  ).bind(portalId, ...scopedParams).first<AnalyticsRow>();

  const sourceCurrencyRows = await env.DB.prepare(
    `WITH ${latestAssessmentCte()}
    SELECT
      NULLIF(upper(trim(latest.deal_currency_code)), '') AS currency_code,
      COUNT(*) AS total_deals,
      SUM(CASE WHEN latest.deal_amount IS NOT NULL THEN 1 ELSE 0 END) AS deals_with_amount,
      SUM(COALESCE(latest.deal_amount, 0)) AS pipeline_amount,
      SUM(CASE WHEN latest.status != 'ready' THEN COALESCE(latest.deal_amount, 0) ELSE 0 END) AS amount_with_readiness_gaps
    FROM latest_assessments latest
    WHERE ${currentStateWhere('latest', filters)} AND latest.deal_amount IS NOT NULL
    GROUP BY NULLIF(upper(trim(latest.deal_currency_code)), '')
    ORDER BY currency_code NULLS LAST`,
  ).bind(portalId, ...scopedParams).all<AnalyticsRow>();

  const sourceCurrencies: SourceCurrencyRow[] = (sourceCurrencyRows.results ?? []).map((row) => ({
    currencyCode: normalizeCurrencyCode(row.currency_code),
    totalDeals: number(row.total_deals),
    dealsWithAmount: number(row.deals_with_amount),
    pipelineAmount: number(row.pipeline_amount),
    amountWithReadinessGaps: number(row.amount_with_readiness_gaps),
  }));
  const monetary = monetarySummary(current, sourceCurrencies);

  const trend = await env.DB.prepare(
    `WITH ${latestAssessmentCte()}, daily_latest AS (
      SELECT DISTINCT ON (deal_id, substr(assessed_at, 1, 10)) *
      FROM assessment_history
      WHERE portal_id = ? AND assessed_at >= ?
      ORDER BY deal_id, substr(assessed_at, 1, 10), assessed_at DESC, id DESC
    )
    SELECT
      substr(daily.assessed_at, 1, 10) AS date,
      AVG(daily.score) AS average_score,
      SUM(CASE WHEN daily.status = 'critical' THEN 1 ELSE 0 END) AS critical_deals,
      SUM(CASE WHEN daily.status != 'ready'
        THEN COALESCE(daily.deal_amount_in_company_currency, 0) ELSE 0 END
      ) AS amount_with_readiness_gaps_in_company_currency,
      SUM(CASE WHEN daily.deal_amount IS NOT NULL THEN 1 ELSE 0 END) AS deals_with_amount,
      SUM(CASE WHEN daily.deal_amount IS NOT NULL
        AND daily.deal_amount_in_company_currency IS NOT NULL THEN 1 ELSE 0 END
      ) AS deals_with_company_currency_amount,
      COUNT(*) AS assessed_deals
    FROM daily_latest daily
    WHERE ${currentStateWhere('daily', filters)} AND ${authorizedDeal('daily')}
    GROUP BY substr(daily.assessed_at, 1, 10)
    ORDER BY date ASC
    LIMIT 370`,
  ).bind(portalId, portalId, since, ...scopedParams, ...authorizationParams).all<AnalyticsRow>();

  const breakdown = async (column: string, label: string): Promise<BreakdownRow[]> => {
    const rows = await env.DB.prepare(
      `WITH ${latestAssessmentCte()}
      SELECT
        COALESCE(latest.${column}, 'unassigned') AS id,
        COALESCE(latest.${label}, COALESCE(latest.${column}, 'Unassigned')) AS label,
        COUNT(*) AS total_deals,
        AVG(latest.score) AS average_score,
        SUM(CASE WHEN latest.status = 'critical' THEN 1 ELSE 0 END) AS critical_deals,
        SUM(CASE WHEN latest.status != 'ready'
          THEN COALESCE(latest.deal_amount_in_company_currency, 0) ELSE 0 END
        ) AS amount_with_readiness_gaps_in_company_currency,
        SUM(CASE WHEN latest.deal_amount IS NOT NULL THEN 1 ELSE 0 END) AS deals_with_amount,
        SUM(CASE WHEN latest.deal_amount IS NOT NULL
          AND latest.deal_amount_in_company_currency IS NOT NULL THEN 1 ELSE 0 END
        ) AS deals_with_company_currency_amount
      FROM latest_assessments latest
      WHERE ${currentStateWhere('latest', filters)}
      GROUP BY latest.${column}, latest.${label}
      ORDER BY critical_deals DESC, total_deals DESC
      LIMIT 250`,
    ).bind(portalId, ...scopedParams).all<AnalyticsRow>();

    return (rows.results ?? []).map((row) => {
      const criticalDeals = number(row.critical_deals);
      const amountWithReadinessGaps = safeCompanyCurrencyAmount(
        row,
        'amount_with_readiness_gaps_in_company_currency',
        'deals_with_amount',
        'deals_with_company_currency_amount',
      );
      const companyCurrencyCoveragePercent = percentage(
        number(row.deals_with_company_currency_amount),
        number(row.deals_with_amount),
      );
      return {
        id: String(row.id),
        label: String(row.label),
        totalDeals: number(row.total_deals),
        averageScore: Math.round(number(row.average_score)),
        critical: criticalDeals,
        criticalDeals,
        amountAtRisk: amountWithReadinessGaps,
        amountWithReadinessGaps,
        monetaryMode: amountWithReadinessGaps === null ? 'unavailable' : 'company_currency',
        companyCurrencyCoveragePercent,
      };
    });
  };

  const ownerRows = await breakdown('owner_id', 'owner_id');
  const teamRows = await breakdown('team_id', 'team_id');
  const baseline = number(current?.average_score);
  const benchmark = (rows: BreakdownRow[]) => rows
    .filter((row) => row.id !== 'unassigned' && row.totalDeals >= 2)
    .map((row) => ({
      ...row,
      scoreDelta: Math.round(row.averageScore - baseline),
      position: row.averageScore >= baseline ? 'above' : 'below',
    }))
    .sort((left, right) => right.scoreDelta - left.scoreDelta);

  const latest = await env.DB.prepare(
    `WITH ${latestAssessmentCte()}
    SELECT
      latest.deal_id,
      latest.score,
      latest.status,
      latest.issue_count,
      latest.deal_amount,
      latest.deal_currency_code,
      latest.stage_age_days,
      latest.owner_id,
      latest.team_id,
      latest.stage_label,
      latest.is_closed,
      latest.is_won,
      latest.assessed_at
    FROM latest_assessments latest
    WHERE ${currentStateWhere('latest', filters)}
    ORDER BY latest.assessed_at DESC
    LIMIT 10000`,
  ).bind(portalId, ...scopedParams).all<AnalyticsRow>();

  const attentionDeals = (latest.results ?? [])
    .map((row) => {
      const score = number(row.score);
      const age = number(row.stage_age_days);
      const issues = number(row.issue_count);
      const signal = Math.min(100, Math.max(0, Math.round((100 - score) * .55 + Math.min(30, age) * .8 + Math.min(10, issues) * 3)));
      return {
        dealId: String(row.deal_id),
        attentionScore: signal,
        // Compatibility alias for clients on the former deterministic-risk contract.
        riskSignal: signal,
        band: signal >= 70 ? 'high' : signal >= 40 ? 'medium' : 'low',
        score,
        issueCount: issues,
        stageAgeDays: age,
        amount: optionalNumber(row.deal_amount),
        currencyCode: normalizeCurrencyCode(row.deal_currency_code),
        ownerId: row.owner_id ? String(row.owner_id) : null,
        stage: row.stage_label ? String(row.stage_label) : null,
      };
    })
    .sort((left, right) => right.attentionScore - left.attentionScore)
    .slice(0, 25);

  const outcomeCorrelation = await loadOutcomeEvidence(
    env, portalId, analyticsPredicate('latest', authorization),
    analyticsPredicate('closure', filters), analyticsPredicate('pre', filters), { since, asOf },
  );

  const issueRows = await env.DB.prepare(
    `WITH ${latestAssessmentCte()}
    SELECT latest.issue_codes_json
    FROM latest_assessments latest
    WHERE ${currentStateWhere('latest', filters)}
    ORDER BY latest.assessed_at DESC
    LIMIT 10000`,
  ).bind(portalId, ...scopedParams).all<{ issue_codes_json: string }>();

  const issues = new Map<string, number>();
  for (const row of issueRows.results ?? []) {
    for (const code of JSON.parse(row.issue_codes_json) as string[]) {
      issues.set(code, (issues.get(code) ?? 0) + 1);
    }
  }

  const heatmap = await env.DB.prepare(
    `WITH ${latestAssessmentCte()}
    SELECT
      COALESCE(latest.pipeline_label, 'Unknown') AS pipeline,
      COALESCE(latest.stage_label, 'Unknown') AS stage,
      COUNT(*) AS deals,
      AVG(latest.stage_age_days) AS average_age,
      MAX(latest.stage_age_days) AS maximum_age,
      SUM(CASE WHEN latest.status = 'critical' THEN 1 ELSE 0 END) AS critical_deals
    FROM latest_assessments latest
    WHERE ${currentStateWhere('latest', filters)}
    GROUP BY latest.pipeline_label, latest.stage_label
    ORDER BY pipeline, average_age DESC`,
  ).bind(portalId, ...scopedParams).all<AnalyticsRow>();

  const handoff = await env.DB.prepare(
    `WITH ${latestAssessmentCte()}
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN handoff.status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed,
      SUM(CASE WHEN handoff.status = 'confirmed' AND handoff.confirmed_at >= ?
        THEN 1 ELSE 0 END) AS confirmations_in_period
    FROM handoffs handoff
    WHERE handoff.portal_id = ? AND EXISTS (
      SELECT 1 FROM latest_assessments latest
      WHERE latest.deal_id = handoff.deal_id AND ${filterSql('latest', filters)}
    )`,
  ).bind(portalId, since, portalId, ...scopedParams).first<AnalyticsRow>();

  const policyImpact = await env.DB.prepare(
    `WITH ${latestAssessmentCte()}, history AS (
      SELECT *
      FROM assessment_history
      WHERE portal_id = ? AND assessed_at >= ?
    ),
    policy_latest AS (
      SELECT DISTINCT ON (deal_id, COALESCE(policy_id, '')) *
      FROM history
      ORDER BY deal_id, COALESCE(policy_id, ''), assessed_at DESC, id DESC
    ),
    policy_period AS (
      SELECT policy_id, MIN(assessed_at) AS first_assessed_at, MAX(assessed_at) AS last_assessed_at
      FROM history observed
      WHERE ${filterSql('observed', filters)} AND ${authorizedDeal('observed')}
      GROUP BY policy_id
    )
    SELECT
      COALESCE(policy.name, 'Ungoverned') AS policy_name,
      latest.policy_id,
      period.first_assessed_at,
      period.last_assessed_at,
      COUNT(*) AS assessed_deals,
      AVG(latest.score) AS average_score,
      SUM(CASE WHEN latest.status = 'critical' THEN 1 ELSE 0 END) AS critical_deals,
      SUM(CASE WHEN latest.status != 'ready'
        THEN COALESCE(latest.deal_amount_in_company_currency, 0) ELSE 0 END
      ) AS amount_with_readiness_gaps_in_company_currency,
      SUM(CASE WHEN latest.deal_amount IS NOT NULL THEN 1 ELSE 0 END) AS deals_with_amount,
      SUM(CASE WHEN latest.deal_amount IS NOT NULL
        AND latest.deal_amount_in_company_currency IS NOT NULL THEN 1 ELSE 0 END
      ) AS deals_with_company_currency_amount
    FROM policy_latest latest
    JOIN policy_period period ON latest.policy_id IS NOT DISTINCT FROM period.policy_id
    LEFT JOIN policy_versions policy ON policy.id = latest.policy_id AND policy.portal_id = latest.portal_id
    WHERE ${filterSql('latest', filters)} AND ${authorizedDeal('latest')}
    GROUP BY latest.policy_id, policy.name, period.first_assessed_at, period.last_assessed_at
    ORDER BY period.first_assessed_at ASC`,
  ).bind(portalId, portalId, since, ...scopedParams, ...authorizationParams, ...scopedParams, ...authorizationParams).all<AnalyticsRow>();

  const totalDeals = number(current?.total_deals);
  const criticalDeals = number(current?.critical_deals);
  const atRiskDeals = number(current?.at_risk_deals);
  const readyDeals = number(current?.ready_deals);
  const dealsWithAmount = number(current?.deals_with_amount);
  const dealsWithCompanyCurrencyAmount = number(current?.deals_with_company_currency_amount);
  const dealsWithCurrencyCode = number(current?.deals_with_currency_code);
  const dealsWithStageAge = number(current?.deals_with_stage_age);
  const dealsWithOwner = number(current?.deals_with_owner);

  const attentionPriority = {
    methodology: 'deterministic_attention_signal',
    deals: attentionDeals,
    highPriorityDeals: attentionDeals.filter((row) => row.band === 'high').length,
  };

  return {
    semantics: TRUSTWORTHY_INTELLIGENCE_SEMANTICS,
    generatedAt: asOf,
    monetary,
    current: {
      totalDeals,
      averageScore: Math.round(baseline),
      criticalDeals,
      atRiskDeals,
      readyDeals,
      // Compatibility aliases retained for existing clients. These are deal counts, not event counts.
      criticalEvents: criticalDeals,
      atRiskEvents: atRiskDeals,
      readyEvents: readyDeals,
      amountWithReadinessGaps: monetary.amountWithReadinessGaps,
      amountAtRisk: monetary.amountWithReadinessGaps,
      pipelineAmount: monetary.pipelineAmount,
      monetaryMode: monetary.mode,
      currencyCode: monetary.currencyCode,
      averageStageAgeDays: round(number(current?.average_stage_age)),
      oldestAssessmentAt: current?.oldest_assessment_at ?? null,
      latestAssessmentAt: current?.latest_assessment_at ?? null,
      coverage: {
        amountPercent: percentage(dealsWithAmount, totalDeals),
        companyCurrencyAmountPercent: percentage(dealsWithCompanyCurrencyAmount, dealsWithAmount),
        currencyCodePercent: percentage(dealsWithCurrencyCode, dealsWithAmount),
        stageAgePercent: percentage(dealsWithStageAge, totalDeals),
        ownerPercent: percentage(dealsWithOwner, totalDeals),
      },
    },
    trend: (trend.results ?? []).map((row) => {
      const critical = number(row.critical_deals);
      const amount = safeCompanyCurrencyAmount(
        row,
        'amount_with_readiness_gaps_in_company_currency',
        'deals_with_amount',
        'deals_with_company_currency_amount',
      );
      return {
        date: String(row.date),
        averageScore: Math.round(number(row.average_score)),
        critical,
        criticalDeals: critical,
        amountAtRisk: amount,
        amountWithReadinessGaps: amount,
        monetaryMode: amount === null ? 'unavailable' : 'company_currency',
        companyCurrencyCoveragePercent: percentage(
          number(row.deals_with_company_currency_amount),
          number(row.deals_with_amount),
        ),
        assessedDeals: number(row.assessed_deals),
      };
    }),
    byPipeline: await breakdown('pipeline_id', 'pipeline_label'),
    byStage: await breakdown('stage_id', 'stage_label'),
    byOwner: ownerRows,
    byTeam: teamRows,
    byRegion: await breakdown('region_code', 'region_code'),
    failurePatterns: [...issues.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((left, right) => right.count - left.count)
      .slice(0, 50),
    stageAgingHeatmap: (heatmap.results ?? []).map((row) => {
      const critical = number(row.critical_deals);
      return {
        pipeline: String(row.pipeline),
        stage: String(row.stage),
        deals: number(row.deals),
        averageAgeDays: round(number(row.average_age)),
        maximumAgeDays: number(row.maximum_age),
        critical,
        criticalDeals: critical,
      };
    }),
    handoffSla: {
      total: number(handoff?.total),
      confirmed: number(handoff?.confirmed),
      completionRate: number(handoff?.total)
        ? round((number(handoff?.confirmed) / number(handoff?.total)) * 100)
        : 0,
      // The canonical handoffs table has no creation/start timestamp. Do not invent SLA duration.
      averageHours: null,
      durationStatus: 'unavailable',
      durationReason: 'Handoff start timestamps are not recorded; elapsed duration cannot be calculated.',
      periodBasis: 'current_scoped_handoffs',
      confirmationsInPeriod: number(handoff?.confirmations_in_period),
    },
    policyImpact: (policyImpact.results ?? []).map((row) => {
      const critical = number(row.critical_deals);
      const amount = safeCompanyCurrencyAmount(
        row,
        'amount_with_readiness_gaps_in_company_currency',
        'deals_with_amount',
        'deals_with_company_currency_amount',
      );
      return {
        policyId: row.policy_id ? String(row.policy_id) : null,
        policyName: String(row.policy_name),
        firstAssessedAt: row.first_assessed_at,
        lastAssessedAt: row.last_assessed_at,
        assessedDeals: number(row.assessed_deals),
        averageScore: Math.round(number(row.average_score)),
        critical,
        criticalDeals: critical,
        amountAtRisk: amount,
        amountWithReadinessGaps: amount,
        monetaryMode: amount === null ? 'unavailable' : 'company_currency',
        companyCurrencyCoveragePercent: percentage(
          number(row.deals_with_company_currency_amount),
          number(row.deals_with_amount),
        ),
      };
    }),
    benchmarking: {
      workspaceAverageScore: Math.round(baseline),
      owners: benchmark(ownerRows),
      teams: benchmark(teamRows),
    },
    attentionPriority,
    // Compatibility contract retained while clients migrate to attentionPriority.
    predictiveRisk: {
      methodology: 'deterministic_signal',
      deals: attentionDeals,
      highRiskDeals: attentionPriority.highPriorityDeals,
      deprecated: true,
    },
    outcomeCorrelation,
  };
}

export async function enterpriseAnalyticsV2(
  env: Env,
  identity: RequestIdentity,
  url: URL,
): Promise<Record<string, unknown>> {
  const access = await requireAnalyticsCollectionAccess(env, identity, 'analytics.view');
  const days = Math.min(730, Math.max(1, Math.floor(Number(url.searchParams.get('days') ?? 90) || 90)));
  const now = Date.now();
  const asOf = new Date(now).toISOString();
  const since = new Date(now - days * 86_400_000).toISOString();
  const filters = selectedAnalyticsFilters(url.searchParams);
  const { effective, authorization } = analyticsFilters(access.scope, filters);

  return {
    audience: url.searchParams.get('audience') ?? 'executive',
    days,
    filters,
    ...await aggregate(env, identity.portalId, since, effective, authorization, asOf),
  };
}

export async function listAnalyticsViews(
  env: Env,
  identity: RequestIdentity,
): Promise<Array<Record<string, unknown>>> {
  await requireAnalyticsCollectionAccess(env, identity, 'analytics.view');
  const owner = analyticsViewOwner(identity);
  const rows = await env.DB.prepare(
    `SELECT * FROM analytics_saved_views
    WHERE portal_id = ? AND (is_shared = 1 OR (${owner.sql}))
    ORDER BY is_shared DESC, name`,
  ).bind(identity.portalId, ...owner.params).all<AnalyticsRow>();

  return (rows.results ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    audience: row.audience,
    filters: JSON.parse(String(row.filters_json ?? '{}')),
    columns: JSON.parse(String(row.columns_json ?? '[]')),
    isShared: Boolean(row.is_shared),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function saveAnalyticsView(
  env: Env,
  identity: RequestIdentity,
  value: unknown,
  viewId: string | null = null,
): Promise<Record<string, unknown>> {
  await requireAnalyticsCollectionAccess(env, identity, 'analytics.view');
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 120) : '';
  if (!name) {
    throw new AppError(400, 'analytics_view_name_required', 'A saved-view name is required.');
  }

  const audiences = ['executive', 'revops', 'sales_manager', 'representative', 'custom'];
  const audience = audiences.includes(String(input.audience)) ? String(input.audience) : 'custom';
  const id = viewId ?? crypto.randomUUID();
  const now = new Date().toISOString();
  const columns = Array.isArray(input.columns) ? input.columns.slice(0, 100) : [];

  const owner = analyticsViewOwner(identity);
  if (viewId !== null) {
    // Update never creates a missing view and cannot overwrite another tenant or creator.
    const updated = await env.DB.prepare(
      `UPDATE analytics_saved_views SET name = ?, audience = ?, filters_json = ?,
        columns_json = ?, is_shared = ?, updated_at = ?
      WHERE id = ? AND portal_id = ? AND (${owner.sql}) RETURNING id`,
    ).bind(name, audience, JSON.stringify(input.filters ?? {}), JSON.stringify(columns),
      input.isShared === true ? 1 : 0, now, viewId, identity.portalId, ...owner.params).first<{ id: string }>();
    if (!updated) throw new AppError(404, 'analytics_view_not_found', 'The saved view does not exist or is not owned by you.');
  } else {
    await env.DB.prepare(
      `INSERT INTO analytics_saved_views (
        id, portal_id, name, audience, filters_json, columns_json, created_by_user_id,
        created_by_email, is_shared, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, identity.portalId, name, audience, JSON.stringify(input.filters ?? {}),
      JSON.stringify(columns), identity.userId?.trim() || null, identity.userEmail?.trim() || null,
      input.isShared === true ? 1 : 0, now, now).run();
  }

  return {
    id,
    name,
    audience,
    filters: input.filters ?? {},
    columns,
    isShared: input.isShared === true,
    updatedAt: now,
  };
}

export async function deleteAnalyticsView(
  env: Env,
  identity: RequestIdentity,
  viewId: string,
): Promise<void> {
  await requireAnalyticsCollectionAccess(env, identity, 'analytics.view');
  const owner = analyticsViewOwner(identity);
  const deleted = await env.DB.prepare(
    `DELETE FROM analytics_saved_views
    WHERE id = ? AND portal_id = ? AND (${owner.sql}) RETURNING id`,
  ).bind(viewId, identity.portalId, ...owner.params).first<{ id: string }>();
  if (!deleted) throw new AppError(404, 'analytics_view_not_found', 'The saved view does not exist or is not owned by you.');
}

export async function exportAnalyticsCsv(
  env: Env,
  identity: RequestIdentity,
  url: URL,
): Promise<Response> {
  await requireAnalyticsCollectionAccess(env, identity, 'analytics.export');
  const data = await enterpriseAnalyticsV2(env, identity, url);
  const rows = data.byPipeline as Array<Record<string, unknown>>;
  const monetary = data.monetary as MonetarySummary;
  const lines = [
    'pipeline_id,pipeline,total_deals,average_score,critical_deals,amount_with_readiness_gaps,currency_basis,currency_code,company_currency_coverage_percent',
  ];

  for (const row of rows) {
    lines.push([
      row.id,
      row.label,
      row.totalDeals,
      row.averageScore,
      row.criticalDeals,
      row.amountWithReadinessGaps,
      row.monetaryMode,
      row.monetaryMode === 'company_currency' ? monetary.currencyCode : null,
      row.companyCurrencyCoveragePercent,
    ].map(analyticsCsvCell).join(','));
  }

  return new Response(lines.join('\n'), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="dealguard-enterprise-analytics-${identity.portalId}.csv"`,
      'cache-control': 'no-store',
    },
  });
}
