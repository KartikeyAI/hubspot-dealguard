import { AppError } from './errors.js';
import { activePolicy } from './governance.js';
import type { DealAssessment, Env, RequestIdentity } from './types.js';
import { requireEnterprisePermission } from './enterprise-access.js';

const FILTER_DIMENSIONS = [
  ['pipelineId', 'pipeline_id'],
  ['stageId', 'stage_id'],
  ['ownerId', 'owner_id'],
  ['teamId', 'team_id'],
  ['regionCode', 'region_code'],
] as const;

type AnalyticsFilters = Record<string, string>;
type AnalyticsRow = Record<string, unknown>;

interface BreakdownRow extends Record<string, unknown> {
  id: string;
  label: string;
  totalDeals: number;
  averageScore: number;
  critical: number;
  criticalDeals: number;
  amountAtRisk: number;
  amountWithReadinessGaps: number;
}

export const TRUSTWORTHY_INTELLIGENCE_SEMANTICS = {
  currentState: 'latest_open_assessment_per_deal',
  trend: 'latest_open_assessment_per_deal_per_day',
  outcomeEvidence: 'latest_open_assessment_before_latest_close_per_deal',
  failurePatterns: 'latest_open_assessment_per_deal',
  amountAtRisk: 'recorded_deal_amount_with_readiness_gaps_not_expected_loss',
  currency: 'source_currency_not_available_in_assessment_history',
} as const;

function number(value: unknown): number {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function round(value: number, digits = 1): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function percentage(numerator: number, denominator: number): number {
  return denominator > 0 ? round((numerator / denominator) * 100) : 0;
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
  const clauses: string[] = [];
  for (const [key, column] of FILTER_DIMENSIONS) {
    if (filters[key]) clauses.push(`${alias}.${column} = ?`);
  }
  return clauses.length > 0 ? clauses.join(' AND ') : 'TRUE';
}

function filterParams(filters: AnalyticsFilters): string[] {
  const params: string[] = [];
  for (const [key] of FILTER_DIMENSIONS) {
    const value = filters[key];
    if (value) params.push(value);
  }
  return params;
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
  await env.DB.prepare(
    `INSERT INTO assessment_history (
      id, portal_id, deal_id, score, grade, status, issue_codes_json, issue_count,
      pipeline_id, pipeline_label, stage_id, stage_label, owner_id, team_id, region_code,
      deal_type, deal_amount, stage_age_days, is_closed, is_won, policy_id, trigger_type, assessed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    assessment.dealAmount ?? (props.amount ? Number(props.amount) : null),
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
): Promise<Record<string, unknown>> {
  const scopedParams = filterParams(filters);

  const current = await env.DB.prepare(
    `WITH ${latestAssessmentCte()}
    SELECT
      COUNT(*) AS total_deals,
      AVG(latest.score) AS average_score,
      SUM(CASE WHEN latest.status = 'critical' THEN 1 ELSE 0 END) AS critical_deals,
      SUM(CASE WHEN latest.status = 'at_risk' THEN 1 ELSE 0 END) AS at_risk_deals,
      SUM(CASE WHEN latest.status = 'ready' THEN 1 ELSE 0 END) AS ready_deals,
      SUM(CASE WHEN latest.status != 'ready' THEN COALESCE(latest.deal_amount, 0) ELSE 0 END) AS amount_with_readiness_gaps,
      SUM(COALESCE(latest.deal_amount, 0)) AS pipeline_amount,
      AVG(latest.stage_age_days) AS average_stage_age,
      SUM(CASE WHEN latest.deal_amount IS NOT NULL THEN 1 ELSE 0 END) AS deals_with_amount,
      SUM(CASE WHEN latest.stage_age_days IS NOT NULL THEN 1 ELSE 0 END) AS deals_with_stage_age,
      SUM(CASE WHEN latest.owner_id IS NOT NULL AND latest.owner_id != '' THEN 1 ELSE 0 END) AS deals_with_owner,
      MIN(latest.assessed_at) AS oldest_assessment_at,
      MAX(latest.assessed_at) AS latest_assessment_at
    FROM latest_assessments latest
    WHERE ${currentStateWhere('latest', filters)}`,
  ).bind(portalId, ...scopedParams).first<AnalyticsRow>();

  const trend = await env.DB.prepare(
    `WITH daily_latest AS (
      SELECT DISTINCT ON (deal_id, substr(assessed_at, 1, 10)) *
      FROM assessment_history
      WHERE portal_id = ? AND assessed_at >= ?
      ORDER BY deal_id, substr(assessed_at, 1, 10), assessed_at DESC, id DESC
    )
    SELECT
      substr(daily.assessed_at, 1, 10) AS date,
      AVG(daily.score) AS average_score,
      SUM(CASE WHEN daily.status = 'critical' THEN 1 ELSE 0 END) AS critical_deals,
      SUM(CASE WHEN daily.status != 'ready' THEN COALESCE(daily.deal_amount, 0) ELSE 0 END) AS amount_with_readiness_gaps,
      COUNT(*) AS assessed_deals
    FROM daily_latest daily
    WHERE ${currentStateWhere('daily', filters)}
    GROUP BY substr(daily.assessed_at, 1, 10)
    ORDER BY date ASC
    LIMIT 370`,
  ).bind(portalId, since, ...scopedParams).all<AnalyticsRow>();

  const breakdown = async (column: string, label: string): Promise<BreakdownRow[]> => {
    const rows = await env.DB.prepare(
      `WITH ${latestAssessmentCte()}
      SELECT
        COALESCE(latest.${column}, 'unassigned') AS id,
        COALESCE(latest.${label}, COALESCE(latest.${column}, 'Unassigned')) AS label,
        COUNT(*) AS total_deals,
        AVG(latest.score) AS average_score,
        SUM(CASE WHEN latest.status = 'critical' THEN 1 ELSE 0 END) AS critical_deals,
        SUM(CASE WHEN latest.status != 'ready' THEN COALESCE(latest.deal_amount, 0) ELSE 0 END) AS amount_with_readiness_gaps
      FROM latest_assessments latest
      WHERE ${currentStateWhere('latest', filters)}
      GROUP BY latest.${column}, latest.${label}
      ORDER BY amount_with_readiness_gaps DESC
      LIMIT 250`,
    ).bind(portalId, ...scopedParams).all<AnalyticsRow>();

    return (rows.results ?? []).map((row) => {
      const criticalDeals = number(row.critical_deals);
      const amountWithReadinessGaps = number(row.amount_with_readiness_gaps);
      return {
        id: String(row.id),
        label: String(row.label),
        totalDeals: number(row.total_deals),
        averageScore: Math.round(number(row.average_score)),
        critical: criticalDeals,
        criticalDeals,
        amountAtRisk: amountWithReadinessGaps,
        amountWithReadinessGaps,
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

  const predictive = (latest.results ?? [])
    .map((row) => {
      const score = number(row.score);
      const age = number(row.stage_age_days);
      const issues = number(row.issue_count);
      const signal = Math.min(100, Math.max(0, Math.round((100-score)*.55+Math.min(30,age)*.8+Math.min(10,issues)*3)));
      return {
        dealId: String(row.deal_id),
        riskSignal: signal,
        band: signal >= 70 ? 'high' : signal >= 40 ? 'medium' : 'low',
        score,
        issueCount: issues,
        stageAgeDays: age,
        amount: number(row.deal_amount),
        ownerId: row.owner_id ? String(row.owner_id) : null,
        stage: row.stage_label ? String(row.stage_label) : null,
      };
    })
    .sort((left, right) => right.riskSignal - left.riskSignal)
    .slice(0, 25);

  const outcomeFilter = filterSql('pre', filters);
  const outcomes = await env.DB.prepare(
    `WITH closed_outcomes AS (
      SELECT DISTINCT ON (deal_id)
        deal_id,
        is_won,
        assessed_at AS outcome_at
      FROM assessment_history
      WHERE portal_id = ? AND assessed_at >= ? AND is_closed = 1
      ORDER BY deal_id, assessed_at DESC, id DESC
    ),
    pre_outcome AS (
      SELECT DISTINCT ON (history.deal_id)
        history.deal_id,
        history.score,
        history.issue_count,
        history.stage_age_days,
        history.deal_amount,
        history.pipeline_id,
        history.stage_id,
        history.owner_id,
        history.team_id,
        history.region_code,
        history.assessed_at,
        outcome.is_won
      FROM assessment_history history
      JOIN closed_outcomes outcome ON outcome.deal_id = history.deal_id
      WHERE history.portal_id = ?
        AND history.is_closed = 0
        AND history.assessed_at < outcome.outcome_at
      ORDER BY history.deal_id, history.assessed_at DESC, history.id DESC
    )
    SELECT
      pre.deal_id,
      pre.score,
      pre.issue_count,
      pre.stage_age_days,
      pre.is_won,
      pre.deal_amount,
      pre.assessed_at
    FROM pre_outcome pre
    WHERE ${outcomeFilter}
    ORDER BY pre.assessed_at DESC
    LIMIT 10000`,
  ).bind(portalId, since, portalId, ...scopedParams).all<AnalyticsRow>();

  const closed = outcomes.results ?? [];
  const won = closed.filter((row) => Boolean(row.is_won));
  const lost = closed.filter((row) => !Boolean(row.is_won));
  const average = (rows: AnalyticsRow[], key: string) => rows.length > 0
    ? round(rows.reduce((sum, row) => sum + number(row[key]), 0) / rows.length)
    : 0;

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
    `SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed,
      AVG(CASE WHEN confirmed_at IS NOT NULL
        THEN EXTRACT(EPOCH FROM (confirmed_at::timestamptz - created_at::timestamptz)) / 3600.0
      END) AS average_hours
    FROM handoffs
    WHERE portal_id = ? AND created_at >= ?`,
  ).bind(portalId, since).first<AnalyticsRow>();

  const policyImpact = await env.DB.prepare(
    `WITH history AS (
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
      FROM history
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
      SUM(CASE WHEN latest.status != 'ready' THEN COALESCE(latest.deal_amount, 0) ELSE 0 END) AS amount_with_readiness_gaps
    FROM policy_latest latest
    JOIN policy_period period ON latest.policy_id IS NOT DISTINCT FROM period.policy_id
    LEFT JOIN policy_versions policy ON policy.id = latest.policy_id
    WHERE ${filterSql('latest', filters)}
    GROUP BY latest.policy_id, policy.name, period.first_assessed_at, period.last_assessed_at
    ORDER BY period.first_assessed_at ASC`,
  ).bind(portalId, since, ...scopedParams).all<AnalyticsRow>();

  const totalDeals = number(current?.total_deals);
  const criticalDeals = number(current?.critical_deals);
  const atRiskDeals = number(current?.at_risk_deals);
  const readyDeals = number(current?.ready_deals);
  const amountWithReadinessGaps = number(current?.amount_with_readiness_gaps);
  const dealsWithAmount = number(current?.deals_with_amount);
  const dealsWithStageAge = number(current?.deals_with_stage_age);
  const dealsWithOwner = number(current?.deals_with_owner);

  return {
    semantics: TRUSTWORTHY_INTELLIGENCE_SEMANTICS,
    generatedAt: new Date().toISOString(),
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
      amountWithReadinessGaps,
      amountAtRisk: amountWithReadinessGaps,
      pipelineAmount: number(current?.pipeline_amount),
      averageStageAgeDays: round(number(current?.average_stage_age)),
      oldestAssessmentAt: current?.oldest_assessment_at ?? null,
      latestAssessmentAt: current?.latest_assessment_at ?? null,
      coverage: {
        amountPercent: percentage(dealsWithAmount, totalDeals),
        stageAgePercent: percentage(dealsWithStageAge, totalDeals),
        ownerPercent: percentage(dealsWithOwner, totalDeals),
      },
    },
    trend: (trend.results ?? []).map((row) => {
      const critical = number(row.critical_deals);
      const amount = number(row.amount_with_readiness_gaps);
      return {
        date: String(row.date),
        averageScore: Math.round(number(row.average_score)),
        critical,
        criticalDeals: critical,
        amountAtRisk: amount,
        amountWithReadinessGaps: amount,
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
      averageHours: round(number(handoff?.average_hours)),
    },
    policyImpact: (policyImpact.results ?? []).map((row) => {
      const critical = number(row.critical_deals);
      const amount = number(row.amount_with_readiness_gaps);
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
      };
    }),
    benchmarking: {
      workspaceAverageScore: Math.round(baseline),
      owners: benchmark(ownerRows),
      teams: benchmark(teamRows),
    },
    predictiveRisk: {
      methodology:'deterministic_signal',
      deals: predictive,
      highRiskDeals: predictive.filter((row) => row.band === 'high').length,
    },
    outcomeCorrelation: {
      methodology: TRUSTWORTHY_INTELLIGENCE_SEMANTICS.outcomeEvidence,
      sampleSize: closed.length,
      won: won.length,
      lost: lost.length,
      winRate: closed.length > 0 ? round((won.length / closed.length) * 100) : 0,
      wonAverageScore: average(won, 'score'),
      lostAverageScore: average(lost, 'score'),
      scoreDelta: round(average(won, 'score') - average(lost, 'score')),
      wonAverageIssues: average(won, 'issue_count'),
      lostAverageIssues: average(lost, 'issue_count'),
      wonAverageStageAgeDays: average(won, 'stage_age_days'),
      lostAverageStageAgeDays: average(lost, 'stage_age_days'),
      confidence:closed.length>=100?'strong':closed.length>=30?'directional':'limited',
    },
  };
}

export async function enterpriseAnalyticsV2(
  env: Env,
  identity: RequestIdentity,
  url: URL,
): Promise<Record<string, unknown>> {
  const access = await requireEnterprisePermission(env, identity, 'analytics.view');
  const days = Math.min(730, Math.max(1, Number(url.searchParams.get('days') ?? 90) || 90));
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const filters: AnalyticsFilters = {};

  for (const [key] of FILTER_DIMENSIONS) {
    const value = url.searchParams.get(key);
    if (value) filters[key] = value.slice(0, 128);
  }

  for (const [scopeKey, filterKey] of [
    ['pipelineIds', 'pipelineId'],
    ['teamIds', 'teamId'],
    ['ownerIds', 'ownerId'],
    ['regionCodes', 'regionCode'],
  ] as const) {
    const allowed = access.scope[scopeKey];
    if (allowed.length > 0 && filters[filterKey] && !allowed.includes(filters[filterKey]!)) {
      throw new AppError(
        403,
        'analytics_scope_denied',
        'The selected analytics filter is outside your assigned scope.',
      );
    }
    if (allowed.length === 1 && !filters[filterKey]) filters[filterKey] = allowed[0]!;
  }

  return {
    audience: url.searchParams.get('audience') ?? 'executive',
    days,
    filters,
    ...await aggregate(env, identity.portalId, since, filters),
  };
}

export async function listAnalyticsViews(
  env: Env,
  identity: RequestIdentity,
): Promise<Array<Record<string, unknown>>> {
  await requireEnterprisePermission(env, identity, 'analytics.view');
  const rows = await env.DB.prepare(
    `SELECT * FROM analytics_saved_views
    WHERE portal_id = ? AND (
      is_shared = 1 OR created_by_user_id = ? OR lower(COALESCE(created_by_email, '')) = lower(COALESCE(?, ''))
    )
    ORDER BY is_shared DESC, name`,
  ).bind(identity.portalId, identity.userId, identity.userEmail).all<AnalyticsRow>();

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
  await requireEnterprisePermission(env, identity, 'analytics.view');
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

  await env.DB.prepare(
    `INSERT INTO analytics_saved_views (
      id, portal_id, name, audience, filters_json, columns_json, created_by_user_id,
      created_by_email, is_shared, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      audience = excluded.audience,
      filters_json = excluded.filters_json,
      columns_json = excluded.columns_json,
      is_shared = excluded.is_shared,
      updated_at = excluded.updated_at`,
  ).bind(
    id,
    identity.portalId,
    name,
    audience,
    JSON.stringify(input.filters ?? {}),
    JSON.stringify(columns),
    identity.userId,
    identity.userEmail,
    input.isShared === true ? 1 : 0,
    now,
    now,
  ).run();

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
  await requireEnterprisePermission(env, identity, 'analytics.view');
  await env.DB.prepare(
    `DELETE FROM analytics_saved_views
    WHERE id = ? AND portal_id = ? AND (
      created_by_user_id = ? OR lower(COALESCE(created_by_email, '')) = lower(COALESCE(?, ''))
    )`,
  ).bind(viewId, identity.portalId, identity.userId, identity.userEmail).run();
}

function csv(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return `"${text.replaceAll('"', '""')}"`;
}

export async function exportAnalyticsCsv(
  env: Env,
  identity: RequestIdentity,
  url: URL,
): Promise<Response> {
  await requireEnterprisePermission(env, identity, 'analytics.export');
  const data = await enterpriseAnalyticsV2(env, identity, url);
  const rows = data.byPipeline as Array<Record<string, unknown>>;
  const lines = [
    'pipeline_id,pipeline,total_deals,average_score,critical_deals,amount_with_readiness_gaps',
  ];

  for (const row of rows) {
    lines.push([
      row.id,
      row.label,
      row.totalDeals,
      row.averageScore,
      row.criticalDeals,
      row.amountWithReadinessGaps,
    ].map(csv).join(','));
  }

  return new Response(lines.join('\n'), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="dealguard-enterprise-analytics-${identity.portalId}.csv"`,
      'cache-control': 'no-store',
    },
  });
}
