import { PLAN_LIMITS } from './config.js';
import { AppError } from './errors.js';
import { buildExecutiveRevenueView } from './executive-revenue-analysis.js';
import type {
  ExecutiveDecisionEvidence,
  ExecutiveRevenueDeal,
  ExecutiveRevenuePeriod,
  ExecutiveRevenueResponse,
  ExecutiveRevenueSnapshot,
} from './executive-revenue-types.js';
import { requireEnterprisePermission, type EnterpriseAccessContext } from './enterprise-access.js';
import { HubSpotClient } from './hubspot.js';
import type { Env, NormalizedDeal, RequestIdentity } from './types.js';

const DAY_MS = 86_400_000;
const CACHE_TTL_MS = 120_000;
const CACHE_MAX = 100;
const SNAPSHOT_RETENTION_DAYS = 730;
const executiveCache = new Map<string, { expiresAt: number; response: ExecutiveRevenueResponse }>();

interface AssessmentRow extends Record<string, unknown> {
  deal_id: string;
  deal_name: string;
  score: number;
  status: 'ready' | 'at_risk' | 'critical';
  assessed_at: string;
}

interface DecisionRow extends Record<string, unknown> {
  deal_id: string;
  assessment_at: string;
  generated_at: string;
  brief_status: ExecutiveDecisionEvidence['status'];
  attention_score: number;
  confidence: ExecutiveDecisionEvidence['confidence'];
  coverage_percent: number;
  next_action_due_at: string | null;
  next_action_priority: ExecutiveDecisionEvidence['nextActionPriority'];
  dimensions_json: string;
}

interface SnapshotRow extends Record<string, unknown> {
  deal_id: string;
  snapshot_date: string;
  captured_at: string;
  pipeline_id: string | null;
  stage_id: string | null;
  owner_id: string | null;
  team_id: string | null;
  region_code: string | null;
  amount: number | null;
  amount_in_company_currency: number | null;
  currency_code: string | null;
  close_date: string | null;
  forecast_category: string | null;
  readiness_score: number | null;
  readiness_status: ExecutiveRevenueSnapshot['readinessStatus'];
  assessment_at: string | null;
  decision_status: ExecutiveRevenueSnapshot['decisionStatus'];
  decision_attention_score: number | null;
  decision_confidence: ExecutiveRevenueSnapshot['decisionConfidence'];
  decision_coverage_percent: number | null;
  decision_generated_at: string | null;
}

interface ScopeFilter {
  pipelineId: string | null;
  teamId: string | null;
  ownerId: string | null;
  regionCode: string | null;
}

export interface ExecutiveRevenueResult {
  response: ExecutiveRevenueResponse;
  persist: () => Promise<void>;
}

function numeric(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value: unknown, maximum = 240): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maximum) : null;
}

function iso(value: unknown): string | null {
  const normalized = text(value, 80);
  if (!normalized) return null;
  const numericValue = Number(normalized);
  const parsed = Number.isFinite(numericValue) && numericValue > 0 ? numericValue : Date.parse(normalized);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function currency(value: unknown): string | null {
  const code = text(value, 3)?.toUpperCase() ?? null;
  return code && /^[A-Z]{3}$/.test(code) ? code : null;
}

function sameInstant(left: unknown, right: unknown): boolean {
  const leftValue = iso(left);
  const rightValue = iso(right);
  return Boolean(leftValue && rightValue && Math.abs(Date.parse(leftValue) - Date.parse(rightValue)) < 1000);
}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function currentQuarter(now: Date): { start: Date; end: Date } {
  const startMonth = Math.floor(now.getUTCMonth() / 3) * 3;
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), startMonth, 1)),
    end: new Date(Date.UTC(now.getUTCFullYear(), startMonth + 3, 1) - 1),
  };
}

function parsePeriod(url: URL, now = new Date()): ExecutiveRevenuePeriod {
  const defaults = currentQuarter(now);
  const rawStart = url.searchParams.get('periodStart');
  const rawEnd = url.searchParams.get('periodEnd');
  const custom = Boolean(rawStart || rawEnd);
  if ((rawStart && !rawEnd) || (!rawStart && rawEnd)) {
    throw new AppError(400, 'executive_period_incomplete', 'Provide both periodStart and periodEnd.');
  }
  if (rawStart && !/^\d{4}-\d{2}-\d{2}$/.test(rawStart)) {
    throw new AppError(400, 'executive_period_invalid', 'Executive period dates must use YYYY-MM-DD.');
  }
  if (rawEnd && !/^\d{4}-\d{2}-\d{2}$/.test(rawEnd)) {
    throw new AppError(400, 'executive_period_invalid', 'Executive period dates must use YYYY-MM-DD.');
  }
  const start = rawStart ? new Date(`${rawStart}T00:00:00.000Z`) : defaults.start;
  const end = rawEnd ? new Date(`${rawEnd}T23:59:59.999Z`) : defaults.end;
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    throw new AppError(400, 'executive_period_invalid', 'Executive period dates must use YYYY-MM-DD.');
  }
  if (start.getTime() > end.getTime()) {
    throw new AppError(400, 'executive_period_order_invalid', 'periodStart must not be after periodEnd.');
  }
  if (end.getTime() - start.getTime() > 366 * DAY_MS) {
    throw new AppError(400, 'executive_period_too_large', 'Executive revenue periods cannot exceed 366 days.');
  }
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    basis: custom ? 'custom' : 'calendar_quarter',
    pullInHorizonEnd: new Date(end.getTime() + 30 * DAY_MS).toISOString(),
  };
}

function requestedFilters(url: URL, access: EnterpriseAccessContext): ScopeFilter {
  const filters: ScopeFilter = { pipelineId: null, teamId: null, ownerId: null, regionCode: null };
  const definitions = [
    ['pipelineId', 'pipelineIds'],
    ['teamId', 'teamIds'],
    ['ownerId', 'ownerIds'],
    ['regionCode', 'regionCodes'],
  ] as const;
  for (const [queryKey, scopeKey] of definitions) {
    const requested = text(url.searchParams.get(queryKey), 128);
    const allowed = access.scope[scopeKey];
    if (requested && allowed.length > 0 && !allowed.includes(requested)) {
      throw new AppError(403, 'executive_scope_denied', `The selected ${queryKey} is outside your assigned scope.`);
    }
    filters[queryKey] = requested;
  }
  return filters;
}

function allowedByScope(deal: NormalizedDeal, access: EnterpriseAccessContext, filters: ScopeFilter): boolean {
  const values = {
    pipelineId: text(deal.properties.pipeline, 128),
    teamId: text(deal.properties.hs_team_id, 128),
    ownerId: text(deal.properties.hubspot_owner_id, 128),
    regionCode: text(deal.properties.region, 128),
  };
  const definitions = [
    ['pipelineId', 'pipelineIds'],
    ['teamId', 'teamIds'],
    ['ownerId', 'ownerIds'],
    ['regionCode', 'regionCodes'],
  ] as const;
  for (const [key, scopeKey] of definitions) {
    const requested = filters[key];
    if (requested && values[key] !== requested) return false;
    const allowed = access.scope[scopeKey];
    if (allowed.length > 0 && (!values[key] || !allowed.includes(values[key]!))) return false;
  }
  return true;
}

function unavailableDecision(): ExecutiveDecisionEvidence {
  return {
    status: null,
    attentionScore: null,
    confidence: null,
    coveragePercent: null,
    generatedAt: null,
    closeDateCredibilityScore: null,
    closeDateCredibilityStatus: null,
    nextActionDueAt: null,
    nextActionPriority: null,
  };
}

function currentDecision(row: DecisionRow | undefined, assessmentAt: string | null, now: number): ExecutiveDecisionEvidence {
  if (!row || !assessmentAt || !sameInstant(row.assessment_at, assessmentAt)) return unavailableDecision();
  const generatedAt = iso(row.generated_at);
  if (!generatedAt || now - Date.parse(generatedAt) > 72 * 3_600_000) return unavailableDecision();

  let dimensions: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.dimensions_json) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) dimensions = parsed as Record<string, unknown>;
  } catch {
    dimensions = {};
  }
  const closeDate = dimensions.closeDate && typeof dimensions.closeDate === 'object'
    ? dimensions.closeDate as Record<string, unknown>
    : null;
  const confidence = ['high', 'medium', 'low'].includes(String(row.confidence)) ? row.confidence : null;
  const status = ['on_track', 'watch', 'intervention_required', 'insufficient_evidence'].includes(String(row.brief_status))
    ? row.brief_status
    : null;
  const priority = ['high', 'medium', 'low'].includes(String(row.next_action_priority))
    ? row.next_action_priority
    : null;
  return {
    status,
    attentionScore: numeric(row.attention_score),
    confidence,
    coveragePercent: numeric(row.coverage_percent),
    generatedAt,
    closeDateCredibilityScore: numeric(closeDate?.score),
    closeDateCredibilityStatus: text(closeDate?.status, 80),
    nextActionDueAt: iso(row.next_action_due_at),
    nextActionPriority: priority,
  };
}

function mapCurrentDeal(
  portalId: string,
  deal: NormalizedDeal,
  assessment: AssessmentRow | undefined,
  decision: DecisionRow | undefined,
  now: number,
): ExecutiveRevenueDeal {
  const assessmentAt = iso(assessment?.assessed_at);
  return {
    dealId: deal.id,
    dealName: text(deal.properties.dealname, 300) ?? assessment?.deal_name ?? `Deal ${deal.id}`,
    recordUrl: `https://app.hubspot.com/contacts/${encodeURIComponent(portalId)}/record/0-3/${encodeURIComponent(deal.id)}`,
    pipelineId: text(deal.properties.pipeline, 128),
    pipelineLabel: deal.stage?.pipelineLabel ?? text(deal.properties.pipeline, 240),
    stageId: text(deal.properties.dealstage, 128),
    stageLabel: deal.stage?.label ?? text(deal.properties.dealstage, 240),
    ownerId: text(deal.properties.hubspot_owner_id, 128),
    teamId: text(deal.properties.hs_team_id, 128),
    regionCode: text(deal.properties.region, 128),
    amount: numeric(deal.properties.amount),
    amountInCompanyCurrency: numeric(deal.properties.amount_in_home_currency),
    currencyCode: currency(deal.properties.deal_currency_code),
    closeDate: iso(deal.properties.closedate),
    forecastCategoryRaw: text(deal.properties.hs_forecast_category, 120),
    readinessScore: numeric(assessment?.score),
    readinessStatus: assessment?.status ?? null,
    assessmentAt,
    decision: currentDecision(decision, assessmentAt, now),
    isClosed: deal.stage?.isClosed ?? false,
    isWon: deal.stage?.isWon ?? false,
  };
}

function mapSnapshot(row: SnapshotRow): ExecutiveRevenueSnapshot {
  const readinessStatus = ['ready', 'at_risk', 'critical'].includes(String(row.readiness_status))
    ? row.readiness_status
    : null;
  const decisionStatus = ['on_track', 'watch', 'intervention_required', 'insufficient_evidence'].includes(String(row.decision_status))
    ? row.decision_status
    : null;
  const decisionConfidence = ['high', 'medium', 'low'].includes(String(row.decision_confidence))
    ? row.decision_confidence
    : null;
  return {
    dealId: String(row.deal_id),
    snapshotDate: String(row.snapshot_date),
    capturedAt: String(row.captured_at),
    pipelineId: text(row.pipeline_id, 128),
    stageId: text(row.stage_id, 128),
    ownerId: text(row.owner_id, 128),
    teamId: text(row.team_id, 128),
    regionCode: text(row.region_code, 128),
    amount: numeric(row.amount),
    amountInCompanyCurrency: numeric(row.amount_in_company_currency),
    currencyCode: currency(row.currency_code),
    closeDate: iso(row.close_date),
    forecastCategoryRaw: text(row.forecast_category, 120),
    readinessScore: numeric(row.readiness_score),
    readinessStatus,
    assessmentAt: iso(row.assessment_at),
    decisionStatus,
    decisionAttentionScore: numeric(row.decision_attention_score),
    decisionConfidence,
    decisionCoveragePercent: numeric(row.decision_coverage_percent),
    decisionGeneratedAt: iso(row.decision_generated_at),
  };
}

async function loadDatabaseEvidence(
  env: Env,
  portalId: string,
  snapshotDate: string,
): Promise<{
  assessments: Map<string, AssessmentRow>;
  decisions: Map<string, DecisionRow>;
  snapshots: ExecutiveRevenueSnapshot[];
}> {
  const [assessmentRows, decisionRows, snapshotRows] = await Promise.all([
    env.DB.prepare(
      `SELECT deal_id, deal_name, score, status, assessed_at
       FROM deal_assessments WHERE portal_id = ?`,
    ).bind(portalId).all<AssessmentRow>(),
    env.DB.prepare(
      `SELECT deal_id, assessment_at, generated_at, brief_status, attention_score,
              confidence, coverage_percent, next_action_due_at, next_action_priority,
              dimensions_json
       FROM deal_decision_snapshots WHERE portal_id = ?`,
    ).bind(portalId).all<DecisionRow>(),
    env.DB.prepare(
      `WITH latest_previous AS (
         SELECT DISTINCT ON (deal_id) *
         FROM executive_revenue_snapshots
         WHERE portal_id = ? AND snapshot_date < ?
         ORDER BY deal_id, snapshot_date DESC, captured_at DESC
       )
       SELECT * FROM latest_previous`,
    ).bind(portalId, snapshotDate).all<SnapshotRow>(),
  ]);
  return {
    assessments: new Map((assessmentRows.results ?? []).map((row) => [String(row.deal_id), row])),
    decisions: new Map((decisionRows.results ?? []).map((row) => [String(row.deal_id), row])),
    snapshots: (snapshotRows.results ?? []).map(mapSnapshot),
  };
}

function cacheKey(
  identity: RequestIdentity,
  access: EnterpriseAccessContext,
  filters: ScopeFilter,
  period: ExecutiveRevenuePeriod,
  candidateLimit: number,
): string {
  return JSON.stringify({
    portalId: identity.portalId,
    userId: identity.userId,
    userEmail: identity.userEmail,
    scope: access.scope,
    filters,
    period,
    candidateLimit,
  });
}

function putCache(key: string, response: ExecutiveRevenueResponse): void {
  if (executiveCache.size >= CACHE_MAX) {
    const oldest = executiveCache.keys().next().value as string | undefined;
    if (oldest) executiveCache.delete(oldest);
  }
  executiveCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, response });
}

async function persistSnapshots(
  env: Env,
  portalId: string,
  deals: ExecutiveRevenueDeal[],
  snapshotDate: string,
  capturedAt: string,
): Promise<void> {
  const retentionCutoff = dateOnly(new Date(Date.parse(`${snapshotDate}T00:00:00.000Z`) - SNAPSHOT_RETENTION_DAYS * DAY_MS));
  await env.DB.prepare(
    `DELETE FROM executive_revenue_snapshots WHERE portal_id = ? AND snapshot_date < ?`,
  ).bind(portalId, retentionCutoff).run();

  for (let offset = 0; offset < deals.length; offset += 100) {
    const statements = deals.slice(offset, offset + 100).map((deal) => env.DB.prepare(
      `INSERT INTO executive_revenue_snapshots (
        portal_id, snapshot_date, deal_id, captured_at,
        pipeline_id, pipeline_label, stage_id, stage_label, owner_id, team_id, region_code,
        amount, currency_code, amount_in_company_currency, close_date, forecast_category,
        readiness_score, readiness_status, assessment_at,
        decision_status, decision_attention_score, decision_confidence,
        decision_coverage_percent, decision_generated_at, is_closed, is_won
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(portal_id, snapshot_date, deal_id) DO UPDATE SET
        captured_at = excluded.captured_at,
        pipeline_id = excluded.pipeline_id,
        pipeline_label = excluded.pipeline_label,
        stage_id = excluded.stage_id,
        stage_label = excluded.stage_label,
        owner_id = excluded.owner_id,
        team_id = excluded.team_id,
        region_code = excluded.region_code,
        amount = excluded.amount,
        currency_code = excluded.currency_code,
        amount_in_company_currency = excluded.amount_in_company_currency,
        close_date = excluded.close_date,
        forecast_category = excluded.forecast_category,
        readiness_score = excluded.readiness_score,
        readiness_status = excluded.readiness_status,
        assessment_at = excluded.assessment_at,
        decision_status = excluded.decision_status,
        decision_attention_score = excluded.decision_attention_score,
        decision_confidence = excluded.decision_confidence,
        decision_coverage_percent = excluded.decision_coverage_percent,
        decision_generated_at = excluded.decision_generated_at,
        is_closed = excluded.is_closed,
        is_won = excluded.is_won`,
    ).bind(
      portalId, snapshotDate, deal.dealId, capturedAt,
      deal.pipelineId, deal.pipelineLabel, deal.stageId, deal.stageLabel,
      deal.ownerId, deal.teamId, deal.regionCode,
      deal.amount, deal.currencyCode, deal.amountInCompanyCurrency,
      deal.closeDate, deal.forecastCategoryRaw,
      deal.readinessScore, deal.readinessStatus, deal.assessmentAt,
      deal.decision.status, deal.decision.attentionScore, deal.decision.confidence,
      deal.decision.coveragePercent, deal.decision.generatedAt,
      deal.isClosed ? 1 : 0, deal.isWon ? 1 : 0,
    ));
    if (statements.length > 0) await env.DB.batch(statements);
  }
}

export async function executiveRevenueView(
  env: Env,
  identity: RequestIdentity,
  url: URL,
): Promise<ExecutiveRevenueResult> {
  const access = await requireEnterprisePermission(env, identity, 'analytics.view');
  const period = parsePeriod(url);
  const filters = requestedFilters(url, access);
  const candidateLimit = Math.min(50, Math.max(1, Number(url.searchParams.get('candidateLimit') ?? 20) || 20));
  const key = cacheKey(identity, access, filters, period, candidateLimit);
  const force = url.searchParams.get('refresh') === 'true';

  if (!force) {
    const cached = executiveCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return { response: cached.response, persist: async () => undefined };
    }
    if (cached) executiveCache.delete(key);
  }

  const client = await HubSpotClient.forPortal(env, identity.portalId);
  const maxDeals = PLAN_LIMITS[client.plan].maxDealsPerScan;
  const fetchedAt = new Date().toISOString();
  const snapshotDate = fetchedAt.slice(0, 10);
  const evidencePromise = loadDatabaseEvidence(env, identity.portalId, snapshotDate);
  const dealsPromise = client.listDeals(maxDeals, ['hs_forecast_category']);
  const [rawDeals, evidence] = await Promise.all([dealsPromise, evidencePromise]);
  const now = Date.parse(fetchedAt);
  const allCurrentDeals = rawDeals.map((deal) => mapCurrentDeal(
    identity.portalId,
    deal,
    evidence.assessments.get(deal.id),
    evidence.decisions.get(deal.id),
    now,
  ));
  const scopedDeals = rawDeals.filter((deal) => allowedByScope(deal, access, filters)).map((deal) => mapCurrentDeal(
    identity.portalId,
    deal,
    evidence.assessments.get(deal.id),
    evidence.decisions.get(deal.id),
    now,
  ));

  const response = buildExecutiveRevenueView(scopedDeals, evidence.snapshots, {
    period,
    generatedAt: fetchedAt,
    fetchedAt,
    maxDeals,
    loadedDeals: rawDeals.length,
    sourceTruncated: rawDeals.length >= maxDeals,
    candidateLimit,
  });
  putCache(key, response);

  return {
    response,
    persist: () => persistSnapshots(env, identity.portalId, allCurrentDeals, snapshotDate, fetchedAt),
  };
}
