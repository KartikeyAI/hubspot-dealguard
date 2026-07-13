import { AppError } from './errors.js';
import { activePolicy } from './governance.js';
import { Repository } from './repository.js';
import type { DealAssessment, Env, RequestIdentity } from './types.js';
import { requireEnterprisePermission } from './enterprise-access.js';

function number(value: unknown): number {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function stageAgeDays(properties: Record<string, string | null | undefined>, stageId?: string): number | null {
  if (!stageId) return null;
  const value = properties[`hs_date_entered_${stageId}`];
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor((Date.now() - parsed) / 86400000)) : null;
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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    crypto.randomUUID(), portalId, assessment.dealId, assessment.score, assessment.grade, assessment.status,
    JSON.stringify(assessment.issues.map((issue) => issue.code)), assessment.issues.length,
    assessment.pipelineId ?? props.pipeline ?? null, assessment.pipelineLabel,
    assessment.stageId ?? props.dealstage ?? null, assessment.stageLabel,
    assessment.ownerId ?? props.hubspot_owner_id ?? null,
    props.hs_team_id ?? props.dealguard_team_id ?? null,
    props.region ?? props.dealguard_region ?? null,
    props.dealtype ?? props.deal_type ?? null,
    assessment.dealAmount ?? (props.amount ? Number(props.amount) : null),
    stageAgeDays(props, assessment.stageId ?? props.dealstage ?? undefined),
    assessment.isClosed ? 1 : 0, assessment.isWon ? 1 : 0,
    input.policyId ?? active?.id ?? null, input.trigger.slice(0, 40), assessment.assessedAt,
  ).run();
}

async function aggregate(env: Env, portalId: string, since: string, filters: Record<string, string>): Promise<Record<string, unknown>> {
  const where = [
    'portal_id = ?',
    'assessed_at >= ?',
    filters.pipelineId ? 'pipeline_id = ?' : '',
    filters.stageId ? 'stage_id = ?' : '',
    filters.ownerId ? 'owner_id = ?' : '',
    filters.teamId ? 'team_id = ?' : '',
    filters.regionCode ? 'region_code = ?' : '',
  ].filter(Boolean).join(' AND ');
  const params: unknown[] = [portalId, since];
  for (const key of ['pipelineId', 'stageId', 'ownerId', 'teamId', 'regionCode']) if (filters[key]) params.push(filters[key]);
  const current = await env.DB.prepare(
    `SELECT COUNT(DISTINCT deal_id) AS total_deals,
      AVG(score) AS average_score,
      SUM(CASE WHEN status = 'critical' THEN 1 ELSE 0 END) AS critical_events,
      SUM(CASE WHEN status = 'at_risk' THEN 1 ELSE 0 END) AS at_risk_events,
      SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS ready_events,
      SUM(CASE WHEN status != 'ready' THEN COALESCE(deal_amount, 0) ELSE 0 END) AS amount_at_risk,
      SUM(COALESCE(deal_amount, 0)) AS pipeline_amount,
      AVG(stage_age_days) AS average_stage_age
     FROM assessment_history WHERE ${where}`
  ).bind(...params).first<Record<string, unknown>>();

  const trend = await env.DB.prepare(
    `SELECT substr(assessed_at, 1, 10) AS date,
      AVG(score) AS average_score,
      SUM(CASE WHEN status = 'critical' THEN 1 ELSE 0 END) AS critical,
      SUM(CASE WHEN status != 'ready' THEN COALESCE(deal_amount, 0) ELSE 0 END) AS amount_at_risk,
      COUNT(DISTINCT deal_id) AS assessed_deals
     FROM assessment_history WHERE ${where}
     GROUP BY substr(assessed_at, 1, 10) ORDER BY date ASC LIMIT 370`
  ).bind(...params).all<Record<string, unknown>>();

  const breakdown = async (column: string, label: string) => {
    const rows = await env.DB.prepare(
      `SELECT COALESCE(${column}, 'unassigned') AS id, COALESCE(${label}, COALESCE(${column}, 'Unassigned')) AS label,
        COUNT(DISTINCT deal_id) AS total_deals, AVG(score) AS average_score,
        SUM(CASE WHEN status = 'critical' THEN 1 ELSE 0 END) AS critical,
        SUM(CASE WHEN status != 'ready' THEN COALESCE(deal_amount, 0) ELSE 0 END) AS amount_at_risk
       FROM assessment_history WHERE ${where}
       GROUP BY ${column}, ${label} ORDER BY amount_at_risk DESC LIMIT 250`
    ).bind(...params).all<Record<string, unknown>>();
    return (rows.results ?? []).map((row) => ({
      id: String(row.id), label: String(row.label), totalDeals: number(row.total_deals),
      averageScore: Math.round(number(row.average_score)), critical: number(row.critical), amountAtRisk: number(row.amount_at_risk),
    }));
  };

  const issueRows = await env.DB.prepare(
    `SELECT issue_codes_json FROM assessment_history WHERE ${where} ORDER BY assessed_at DESC LIMIT 10000`
  ).bind(...params).all<{ issue_codes_json: string }>();
  const issues = new Map<string, number>();
  for (const row of issueRows.results ?? []) {
    for (const code of JSON.parse(row.issue_codes_json) as string[]) issues.set(code, (issues.get(code) ?? 0) + 1);
  }

  const heatmap = await env.DB.prepare(
    `SELECT COALESCE(pipeline_label, 'Unknown') AS pipeline, COALESCE(stage_label, 'Unknown') AS stage,
      COUNT(DISTINCT deal_id) AS deals, AVG(stage_age_days) AS average_age,
      MAX(stage_age_days) AS maximum_age, SUM(CASE WHEN status = 'critical' THEN 1 ELSE 0 END) AS critical
     FROM assessment_history WHERE ${where}
     GROUP BY pipeline_label, stage_label ORDER BY pipeline, average_age DESC`
  ).bind(...params).all<Record<string, unknown>>();

  const handoff = await env.DB.prepare(
    `SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed,
      AVG(CASE WHEN confirmed_at IS NOT NULL THEN (julianday(confirmed_at) - julianday(created_at)) * 24 END) AS average_hours
     FROM handoffs WHERE portal_id = ? AND created_at >= ?`
  ).bind(portalId, since).first<Record<string, unknown>>();

  const policyImpact = await env.DB.prepare(
    `SELECT COALESCE(p.name, 'Ungoverned') AS policy_name, h.policy_id,
      MIN(h.assessed_at) AS first_assessed_at, MAX(h.assessed_at) AS last_assessed_at,
      AVG(h.score) AS average_score, SUM(CASE WHEN h.status = 'critical' THEN 1 ELSE 0 END) AS critical,
      SUM(CASE WHEN h.status != 'ready' THEN COALESCE(h.deal_amount, 0) ELSE 0 END) AS amount_at_risk
     FROM assessment_history h LEFT JOIN policy_versions p ON p.id = h.policy_id
     WHERE h.portal_id = ? AND h.assessed_at >= ?
     GROUP BY h.policy_id, p.name ORDER BY first_assessed_at ASC`
  ).bind(portalId, since).all<Record<string, unknown>>();

  return {
    current: {
      totalDeals: number(current?.total_deals),
      averageScore: Math.round(number(current?.average_score)),
      criticalEvents: number(current?.critical_events),
      atRiskEvents: number(current?.at_risk_events),
      readyEvents: number(current?.ready_events),
      amountAtRisk: number(current?.amount_at_risk),
      pipelineAmount: number(current?.pipeline_amount),
      averageStageAgeDays: Math.round(number(current?.average_stage_age) * 10) / 10,
    },
    trend: (trend.results ?? []).map((row) => ({
      date: String(row.date), averageScore: Math.round(number(row.average_score)),
      critical: number(row.critical), amountAtRisk: number(row.amount_at_risk), assessedDeals: number(row.assessed_deals),
    })),
    byPipeline: await breakdown('pipeline_id', 'pipeline_label'),
    byStage: await breakdown('stage_id', 'stage_label'),
    byOwner: await breakdown('owner_id', 'owner_id'),
    byTeam: await breakdown('team_id', 'team_id'),
    byRegion: await breakdown('region_code', 'region_code'),
    failurePatterns: [...issues.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count).slice(0, 50),
    stageAgingHeatmap: (heatmap.results ?? []).map((row) => ({
      pipeline: String(row.pipeline), stage: String(row.stage), deals: number(row.deals),
      averageAgeDays: Math.round(number(row.average_age) * 10) / 10, maximumAgeDays: number(row.maximum_age), critical: number(row.critical),
    })),
    handoffSla: {
      total: number(handoff?.total), confirmed: number(handoff?.confirmed),
      completionRate: number(handoff?.total) ? Math.round(number(handoff?.confirmed) / number(handoff?.total) * 1000) / 10 : 0,
      averageHours: Math.round(number(handoff?.average_hours) * 10) / 10,
    },
    policyImpact: (policyImpact.results ?? []).map((row) => ({
      policyId: row.policy_id ? String(row.policy_id) : null, policyName: String(row.policy_name),
      firstAssessedAt: row.first_assessed_at, lastAssessedAt: row.last_assessed_at,
      averageScore: Math.round(number(row.average_score)), critical: number(row.critical), amountAtRisk: number(row.amount_at_risk),
    })),
  };
}

export async function enterpriseAnalyticsV2(env: Env, identity: RequestIdentity, url: URL): Promise<Record<string, unknown>> {
  const access = await requireEnterprisePermission(env, identity, 'analytics.view');
  const days = Math.min(730, Math.max(1, Number(url.searchParams.get('days') ?? 90) || 90));
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const filters: Record<string, string> = {};
  for (const key of ['pipelineId', 'stageId', 'ownerId', 'teamId', 'regionCode']) {
    const value = url.searchParams.get(key);
    if (value) filters[key] = value.slice(0, 128);
  }
  for (const [scopeKey, filterKey] of [
    ['pipelineIds', 'pipelineId'], ['teamIds', 'teamId'], ['ownerIds', 'ownerId'], ['regionCodes', 'regionCode'],
  ] as const) {
    const allowed = access.scope[scopeKey];
    if (allowed.length && filters[filterKey] && !allowed.includes(filters[filterKey]!)) throw new AppError(403, 'analytics_scope_denied', 'The selected analytics filter is outside your assigned scope.');
    if (allowed.length === 1 && !filters[filterKey]) filters[filterKey] = allowed[0]!;
  }
  return { audience: url.searchParams.get('audience') ?? 'executive', days, filters, ...(await aggregate(env, identity.portalId, since, filters)) };
}

export async function listAnalyticsViews(env: Env, identity: RequestIdentity): Promise<Array<Record<string, unknown>>> {
  await requireEnterprisePermission(env, identity, 'analytics.view');
  const rows = await env.DB.prepare(`SELECT * FROM analytics_saved_views WHERE portal_id = ? AND (is_shared = 1 OR created_by_user_id = ? OR lower(COALESCE(created_by_email,'')) = lower(COALESCE(?,''))) ORDER BY is_shared DESC, name`)
    .bind(identity.portalId, identity.userId, identity.userEmail).all<Record<string, unknown>>();
  return (rows.results ?? []).map((row) => ({
    id: row.id, name: row.name, audience: row.audience, filters: JSON.parse(String(row.filters_json ?? '{}')),
    columns: JSON.parse(String(row.columns_json ?? '[]')), isShared: Boolean(row.is_shared), createdAt: row.created_at, updatedAt: row.updated_at,
  }));
}

export async function saveAnalyticsView(env: Env, identity: RequestIdentity, value: unknown, viewId: string | null = null): Promise<Record<string, unknown>> {
  await requireEnterprisePermission(env, identity, 'analytics.view');
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 120) : '';
  if (!name) throw new AppError(400, 'analytics_view_name_required', 'A saved-view name is required.');
  const audiences = ['executive', 'revops', 'sales_manager', 'representative', 'custom'];
  const audience = audiences.includes(String(input.audience)) ? String(input.audience) : 'custom';
  const id = viewId ?? crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO analytics_saved_views (id, portal_id, name, audience, filters_json, columns_json, created_by_user_id, created_by_email, is_shared, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, audience = excluded.audience, filters_json = excluded.filters_json,
     columns_json = excluded.columns_json, is_shared = excluded.is_shared, updated_at = excluded.updated_at`
  ).bind(id, identity.portalId, name, audience, JSON.stringify(input.filters ?? {}), JSON.stringify(Array.isArray(input.columns) ? input.columns.slice(0, 100) : []), identity.userId, identity.userEmail, input.isShared === true ? 1 : 0, now, now).run();
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, viewId ? 'analytics.view_updated' : 'analytics.view_created', { viewId: id, name, audience });
  return { id, name, audience, filters: input.filters ?? {}, columns: input.columns ?? [], isShared: input.isShared === true, updatedAt: now };
}

export async function deleteAnalyticsView(env: Env, identity: RequestIdentity, viewId: string): Promise<void> {
  await requireEnterprisePermission(env, identity, 'analytics.view');
  const result = await env.DB.prepare(`DELETE FROM analytics_saved_views WHERE portal_id = ? AND id = ? AND (created_by_user_id = ? OR lower(COALESCE(created_by_email,'')) = lower(COALESCE(?,'')))`)
    .bind(identity.portalId, viewId, identity.userId, identity.userEmail).run();
  if (!Number(result.meta?.changes ?? 0)) throw new AppError(404, 'analytics_view_not_found', 'The saved analytics view does not exist or is not owned by this user.');
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'analytics.view_deleted', { viewId });
}

function csv(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return `"${text.replaceAll('"', '""')}"`;
}

export async function exportAnalyticsCsv(env: Env, identity: RequestIdentity, url: URL): Promise<Response> {
  await requireEnterprisePermission(env, identity, 'analytics.export');
  const result = await enterpriseAnalyticsV2(env, identity, url);
  const data = result as Record<string, unknown>;
  const rows = data.byPipeline as Array<Record<string, unknown>>;
  const lines = ['pipeline_id,pipeline,total_deals,average_score,critical,amount_at_risk'];
  for (const row of rows) lines.push([row.id, row.label, row.totalDeals, row.averageScore, row.critical, row.amountAtRisk].map(csv).join(','));
  return new Response(lines.join('\n'), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="dealguard-enterprise-analytics-${identity.portalId}.csv"`,
      'cache-control': 'no-store',
    },
  });
}
