import { AppError } from './errors.js';
import { requireEnterprisePermission, type EnterpriseAccessContext } from './enterprise-access.js';
import type {
  DecisionAmountBasis,
  DecisionEvidenceMode,
  DecisionQueueAction,
  DecisionQueueAmountCohort,
  DecisionQueueItem,
  DecisionQueueReason,
  ManagerDecisionBand,
  ManagerDecisionQueueResponse,
} from './manager-decision-queue-types.js';
import type { Env, IssueSeverity, RequestIdentity } from './types.js';

const OPEN_REMEDIATION_STATUSES = ['open', 'acknowledged', 'in_progress', 'overdue'] as const;
const FILTERS = [
  ['pipelineId', 'pipeline_id', 'pipelineIds'],
  ['teamId', 'team_id', 'teamIds'],
  ['ownerId', 'owner_id', 'ownerIds'],
  ['regionCode', 'region_code', 'regionCodes'],
] as const;
const ISSUE_ORDER: Record<IssueSeverity, number> = { critical: 0, warning: 1, info: 2 };
const ACTION_ORDER = { high: 0, medium: 1, low: 2 } as const;

export interface ManagerDecisionSourceRow extends Record<string, unknown> {
  deal_id: string;
  deal_name?: string | null;
  readiness_summary?: string | null;
  issues_json?: string | null;
  score: number;
  status: 'ready' | 'at_risk' | 'critical';
  issue_count: number;
  pipeline_id?: string | null;
  pipeline_label?: string | null;
  stage_id?: string | null;
  stage_label?: string | null;
  owner_id?: string | null;
  team_id?: string | null;
  region_code?: string | null;
  deal_amount?: number | null;
  deal_currency_code?: string | null;
  deal_amount_in_company_currency?: number | null;
  stage_age_days?: number | null;
  assessed_at: string;
  snapshot_assessment_at?: string | null;
  snapshot_generated_at?: string | null;
  brief_status?: string | null;
  snapshot_attention_score?: number | null;
  snapshot_confidence?: string | null;
  snapshot_coverage_percent?: number | null;
  snapshot_freshness_status?: string | null;
  next_action_code?: string | null;
  next_action_label?: string | null;
  next_action_text?: string | null;
  next_action_priority?: string | null;
  next_action_owner?: string | null;
  next_action_due_at?: string | null;
  next_action_rationale?: string | null;
  next_action_evidence_json?: string | null;
  risk_summary_json?: string | null;
  dimensions_json?: string | null;
  open_remediation_count?: number | null;
  overdue_remediation_count?: number | null;
  remediation_title?: string | null;
  remediation_description?: string | null;
  remediation_priority?: string | null;
  remediation_owner_id?: string | null;
  remediation_due_at?: string | null;
  remediation_issue_code?: string | null;
}

interface WorkingItem {
  source: ManagerDecisionSourceRow;
  dealId: string;
  dealName: string;
  recordUrl: string;
  readinessScore: number;
  readinessStatus: 'ready' | 'at_risk' | 'critical';
  issueCount: number;
  stageAgeDays: number | null;
  assessedAt: string;
  deterministicAttentionScore: number;
  evidenceMode: DecisionEvidenceMode;
  evidenceCoveragePercent: number;
  evidenceConfidence: 'high' | 'medium' | 'low';
  snapshotGeneratedAt: string | null;
  dealBriefStatus: DecisionQueueItem['dealBriefStatus'];
  snapshotUsable: boolean;
  nextAction: DecisionQueueAction | null;
  reasons: DecisionQueueReason[];
  dimensionStates: Record<string, unknown>;
  amountValue: number | null;
  amountBasis: DecisionAmountBasis;
  amountCurrencyCode: string | null;
  amountLabel: string;
  amountCohortKey: string | null;
  commercialImportanceScore: number;
  actionUrgencyScore: number;
  evidenceReviewScore: number;
  priorityScore: number;
  band: ManagerDecisionBand;
  openRemediationCount: number;
  overdueRemediationCount: number;
}

function clamp(value: number, minimum = 0, maximum = 100): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function numeric(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function integer(value: unknown): number {
  const parsed = numeric(value);
  return parsed === null ? 0 : Math.max(0, Math.round(parsed));
}

function normalizedText(value: unknown, maximum = 500): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maximum) : null;
}

function iso(value: unknown): string | null {
  const text = normalizedText(value, 80);
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizeCurrency(value: unknown): string | null {
  const code = normalizedText(value, 3)?.toUpperCase() ?? null;
  return code && /^[A-Z]{3}$/.test(code) ? code : null;
}

function sameInstant(left: unknown, right: unknown): boolean {
  const leftTime = left ? Date.parse(String(left)) : Number.NaN;
  const rightTime = right ? Date.parse(String(right)) : Number.NaN;
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && Math.abs(leftTime - rightTime) < 1000;
}

function snapshotMode(row: ManagerDecisionSourceRow, now: number): {
  mode: DecisionEvidenceMode;
  usable: boolean;
  generatedAt: string | null;
} {
  const generatedAt = iso(row.snapshot_generated_at);
  const current = sameInstant(row.snapshot_assessment_at, row.assessed_at);
  if (!generatedAt || !current) return { mode: 'readiness_only', usable: false, generatedAt };
  const ageHours = Math.max(0, now - Date.parse(generatedAt)) / 3_600_000;
  if (ageHours <= 24) return { mode: 'full_deal_brief', usable: true, generatedAt };
  if (ageHours <= 72) return { mode: 'aging_deal_brief', usable: true, generatedAt };
  return { mode: 'stale_deal_brief', usable: false, generatedAt };
}

function readinessAttention(score: number, stageAgeDays: number | null, issueCount: number): number {
  return Math.round(clamp(
    (100 - clamp(score)) * .55
    + Math.min(30, Math.max(0, stageAgeDays ?? 0)) * .8
    + Math.min(10, Math.max(0, issueCount)) * 3,
  ));
}

function issueAction(row: ManagerDecisionSourceRow, now: number): DecisionQueueAction | null {
  const issues = parseJson<Array<Record<string, unknown>>>(row.issues_json, []);
  const candidates = issues
    .map((item) => ({
      code: normalizedText(item.code, 160),
      label: normalizedText(item.label, 240),
      description: normalizedText(item.description, 800),
      severity: ['critical', 'warning', 'info'].includes(String(item.severity))
        ? String(item.severity) as IssueSeverity
        : 'warning' as IssueSeverity,
      weight: integer(item.weight),
    }))
    .filter((item) => item.code && item.label)
    .sort((left, right) => ISSUE_ORDER[left.severity] - ISSUE_ORDER[right.severity] || right.weight - left.weight);
  const issue = candidates[0];
  if (!issue || !issue.code || !issue.label) return null;
  const priority = issue.severity === 'critical' ? 'high' : issue.severity === 'warning' ? 'medium' : 'low';
  const dueHours = issue.severity === 'critical' ? 24 : issue.severity === 'warning' ? 72 : 168;
  return {
    code: `readiness_${issue.code}`,
    label: issue.label,
    action: issue.description ?? `Resolve the ${issue.label.toLowerCase()} readiness issue.`,
    priority,
    owner: 'deal_owner',
    dueAt: new Date(now + dueHours * 3_600_000).toISOString(),
    rationale: `This is the highest-priority current readiness issue and carries ${issue.weight} readiness points.`,
    evidenceCodes: [issue.code],
    source: 'readiness',
    overdue: false,
  };
}

function snapshotAction(row: ManagerDecisionSourceRow, usable: boolean, now: number): DecisionQueueAction | null {
  if (!usable) return null;
  const code = normalizedText(row.next_action_code, 160);
  const label = normalizedText(row.next_action_label, 240);
  const action = normalizedText(row.next_action_text, 800);
  const priority = ['high', 'medium', 'low'].includes(String(row.next_action_priority))
    ? row.next_action_priority as DecisionQueueAction['priority']
    : null;
  const owner = ['deal_owner', 'manager'].includes(String(row.next_action_owner))
    ? row.next_action_owner as DecisionQueueAction['owner']
    : null;
  if (!code || !label || !action || !priority || !owner) return null;
  const dueAt = iso(row.next_action_due_at);
  return {
    code,
    label,
    action,
    priority,
    owner,
    dueAt,
    rationale: normalizedText(row.next_action_rationale, 800)
      ?? 'The action is supported by the current deterministic Deal Brief.',
    evidenceCodes: parseJson<string[]>(row.next_action_evidence_json, [])
      .filter((item): item is string => typeof item === 'string')
      .slice(0, 20),
    source: 'deal_brief',
    overdue: dueAt ? Date.parse(dueAt) < now : false,
  };
}

function remediationAction(row: ManagerDecisionSourceRow, now: number): DecisionQueueAction | null {
  const label = normalizedText(row.remediation_title, 240);
  if (!label) return null;
  const rawPriority = normalizedText(row.remediation_priority, 40);
  const priority: DecisionQueueAction['priority'] = rawPriority === 'urgent' || rawPriority === 'high'
    ? 'high'
    : rawPriority === 'medium'
      ? 'medium'
      : 'low';
  const dueAt = iso(row.remediation_due_at);
  const issueCode = normalizedText(row.remediation_issue_code, 160) ?? 'remediation';
  return {
    code: `remediation_${issueCode}`,
    label,
    action: normalizedText(row.remediation_description, 800) ?? `Resolve the open remediation case: ${label}.`,
    priority,
    owner: rawPriority === 'urgent' ? 'manager' : 'deal_owner',
    dueAt,
    rationale: 'An open DealGuard remediation case requires an owned response.',
    evidenceCodes: [issueCode],
    source: 'remediation',
    overdue: dueAt ? Date.parse(dueAt) < now : false,
  };
}

function chooseAction(row: ManagerDecisionSourceRow, snapshotUsable: boolean, now: number): DecisionQueueAction | null {
  const actions = [
    snapshotAction(row, snapshotUsable, now),
    remediationAction(row, now),
    issueAction(row, now),
  ].filter((item): item is DecisionQueueAction => Boolean(item));
  return actions.sort((left, right) => {
    const priority = ACTION_ORDER[left.priority] - ACTION_ORDER[right.priority];
    if (priority !== 0) return priority;
    if (left.overdue !== right.overdue) return left.overdue ? -1 : 1;
    const leftDue = left.dueAt ? Date.parse(left.dueAt) : Number.POSITIVE_INFINITY;
    const rightDue = right.dueAt ? Date.parse(right.dueAt) : Number.POSITIVE_INFINITY;
    return leftDue - rightDue;
  })[0] ?? null;
}

function urgencyScore(action: DecisionQueueAction | null, overdueRemediations: number, now: number): number {
  if (overdueRemediations > 0 || action?.overdue) return 100;
  if (!action) return 0;
  if (action.dueAt) {
    const hours = (Date.parse(action.dueAt) - now) / 3_600_000;
    if (hours <= 24) return 90;
    if (hours <= 72) return 75;
    if (hours <= 168) return 55;
    if (hours <= 336) return 35;
    return 15;
  }
  return action.priority === 'high' ? 60 : action.priority === 'medium' ? 35 : 15;
}

function reason(code: string, label: string, severity: IssueSeverity, dimension: string): DecisionQueueReason {
  return { code, label, severity, dimension };
}

function initialReasons(row: ManagerDecisionSourceRow, mode: DecisionEvidenceMode, usable: boolean): DecisionQueueReason[] {
  const output: DecisionQueueReason[] = [];
  const risks = usable
    ? parseJson<Array<Record<string, unknown>>>(row.risk_summary_json, [])
    : [];
  for (const item of risks.slice(0, 3)) {
    const code = normalizedText(item.code, 160);
    const label = normalizedText(item.label, 240);
    if (!code || !label) continue;
    const severity = ['critical', 'warning', 'info'].includes(String(item.severity))
      ? item.severity as IssueSeverity
      : 'warning';
    output.push(reason(code, label, severity, normalizedText(item.dimension, 80) ?? 'deal_brief'));
  }
  if (row.status === 'critical') output.push(reason('critical_readiness', 'Critical readiness state', 'critical', 'readiness'));
  else if (row.status === 'at_risk') output.push(reason('at_risk_readiness', 'Readiness requires review', 'warning', 'readiness'));
  if (integer(row.overdue_remediation_count) > 0) output.push(reason('overdue_remediation', 'Overdue remediation case', 'critical', 'action'));
  if ((numeric(row.stage_age_days) ?? 0) >= 21) output.push(reason('stage_age_review', 'Extended time in the current stage', 'warning', 'momentum'));
  if (mode === 'readiness_only') output.push(reason('deal_brief_missing', 'Full Deal Brief evidence has not been captured', 'info', 'evidence'));
  if (mode === 'stale_deal_brief') output.push(reason('deal_brief_stale', 'Stored Deal Brief evidence is stale', 'warning', 'evidence'));
  const seen = new Set<string>();
  return output.filter((item) => {
    if (seen.has(item.code)) return false;
    seen.add(item.code);
    return true;
  }).slice(0, 5);
}

function amountContext(row: ManagerDecisionSourceRow): Pick<WorkingItem, 'amountValue' | 'amountBasis' | 'amountCurrencyCode' | 'amountLabel' | 'amountCohortKey'> {
  const companyAmount = numeric(row.deal_amount_in_company_currency);
  if (companyAmount !== null && companyAmount >= 0) {
    return {
      amountValue: companyAmount,
      amountBasis: 'company_currency',
      amountCurrencyCode: null,
      amountLabel: 'Company currency',
      amountCohortKey: 'company_currency',
    };
  }
  const dealAmount = numeric(row.deal_amount);
  const currencyCode = normalizeCurrency(row.deal_currency_code);
  if (dealAmount !== null && dealAmount >= 0 && currencyCode) {
    return {
      amountValue: dealAmount,
      amountBasis: 'deal_currency',
      amountCurrencyCode: currencyCode,
      amountLabel: currencyCode,
      amountCohortKey: `deal_currency:${currencyCode}`,
    };
  }
  return {
    amountValue: dealAmount,
    amountBasis: 'unavailable',
    amountCurrencyCode: currencyCode,
    amountLabel: currencyCode ?? 'Currency unavailable',
    amountCohortKey: null,
  };
}

function workingItem(row: ManagerDecisionSourceRow, portalId: string, now: number): WorkingItem {
  const readinessScore = Math.round(clamp(numeric(row.score) ?? 0));
  const issueCount = integer(row.issue_count);
  const stageAgeDays = numeric(row.stage_age_days);
  const snapshot = snapshotMode(row, now);
  const snapshotAttention = snapshot.usable ? numeric(row.snapshot_attention_score) : null;
  const deterministicAttentionScore = Math.round(clamp(
    snapshotAttention ?? readinessAttention(readinessScore, stageAgeDays, issueCount),
  ));
  const coverage = snapshot.usable ? Math.round(clamp(numeric(row.snapshot_coverage_percent) ?? 40)) : 40;
  const confidence = snapshot.usable && ['high', 'medium', 'low'].includes(String(row.snapshot_confidence))
    ? row.snapshot_confidence as WorkingItem['evidenceConfidence']
    : 'low';
  const action = chooseAction(row, snapshot.usable, now);
  const amount = amountContext(row);
  return {
    source: row,
    dealId: String(row.deal_id),
    dealName: normalizedText(row.deal_name, 300) ?? `Deal ${row.deal_id}`,
    recordUrl: `https://app.hubspot.com/contacts/${encodeURIComponent(portalId)}/record/0-3/${encodeURIComponent(String(row.deal_id))}`,
    readinessScore,
    readinessStatus: row.status,
    issueCount,
    stageAgeDays,
    assessedAt: iso(row.assessed_at) ?? String(row.assessed_at),
    deterministicAttentionScore,
    evidenceMode: snapshot.mode,
    evidenceCoveragePercent: coverage,
    evidenceConfidence: confidence,
    snapshotGeneratedAt: snapshot.generatedAt,
    dealBriefStatus: snapshot.usable && ['on_track', 'watch', 'intervention_required', 'insufficient_evidence'].includes(String(row.brief_status))
      ? row.brief_status as WorkingItem['dealBriefStatus']
      : null,
    snapshotUsable: snapshot.usable,
    nextAction: action,
    reasons: initialReasons(row, snapshot.mode, snapshot.usable),
    dimensionStates: snapshot.usable ? parseJson<Record<string, unknown>>(row.dimensions_json, {}) : {},
    ...amount,
    commercialImportanceScore: 0,
    actionUrgencyScore: urgencyScore(action, integer(row.overdue_remediation_count), now),
    evidenceReviewScore: Math.round(clamp(100 - coverage + (snapshot.mode === 'stale_deal_brief' ? 20 : 0))),
    priorityScore: 0,
    band: 'monitor',
    openRemediationCount: integer(row.open_remediation_count),
    overdueRemediationCount: integer(row.overdue_remediation_count),
  };
}

function applyAmountPercentiles(items: WorkingItem[]): DecisionQueueAmountCohort[] {
  const cohorts = new Map<string, WorkingItem[]>();
  for (const item of items) {
    if (!item.amountCohortKey || item.amountValue === null) continue;
    const current = cohorts.get(item.amountCohortKey) ?? [];
    current.push(item);
    cohorts.set(item.amountCohortKey, current);
  }
  const summaries: DecisionQueueAmountCohort[] = [];
  for (const [key, members] of cohorts) {
    const values = [...new Set(members.map((item) => item.amountValue ?? 0))].sort((left, right) => left - right);
    for (const item of members) {
      const value = item.amountValue ?? 0;
      const index = values.indexOf(value);
      item.commercialImportanceScore = values.length <= 1 ? 50 : Math.round(index / (values.length - 1) * 100);
      if (item.commercialImportanceScore >= 80) {
        item.reasons.push(reason('high_value_cohort', 'High commercial value within a comparable currency cohort', 'warning', 'commercial_importance'));
      }
    }
    const first = members[0]!;
    summaries.push({
      basis: first.amountBasis === 'company_currency' ? 'company_currency' : 'deal_currency',
      currencyCode: first.amountCurrencyCode,
      label: first.amountLabel,
      deals: members.length,
      totalAmount: members.reduce((sum, item) => sum + (item.amountValue ?? 0), 0),
    });
    void key;
  }
  return summaries.sort((left, right) => right.deals - left.deals || left.label.localeCompare(right.label));
}

function finalize(item: WorkingItem): void {
  item.priorityScore = Math.round(clamp(
    item.deterministicAttentionScore * .55
    + item.actionUrgencyScore * .20
    + item.commercialImportanceScore * .15
    + item.evidenceReviewScore * .10,
  ));
  if (item.readinessStatus === 'critical' || item.dealBriefStatus === 'intervention_required') {
    item.priorityScore = Math.max(item.priorityScore, 75);
  }
  if (item.overdueRemediationCount > 0 || item.nextAction?.overdue) item.priorityScore = Math.max(item.priorityScore, 80);
  if (item.nextAction?.priority === 'high' && item.actionUrgencyScore >= 90) item.priorityScore = Math.max(item.priorityScore, 75);
  item.band = item.priorityScore >= 75 ? 'act_now' : item.priorityScore >= 50 ? 'review' : 'monitor';
  const seen = new Set<string>();
  item.reasons = item.reasons
    .filter((entry) => {
      if (seen.has(entry.code)) return false;
      seen.add(entry.code);
      return true;
    })
    .sort((left, right) => ISSUE_ORDER[left.severity] - ISSUE_ORDER[right.severity])
    .slice(0, 5);
}

function toResponseItem(item: WorkingItem): DecisionQueueItem {
  return {
    dealId: item.dealId,
    dealName: item.dealName,
    recordUrl: item.recordUrl,
    pipelineId: normalizedText(item.source.pipeline_id, 128),
    pipelineLabel: normalizedText(item.source.pipeline_label, 240),
    stageId: normalizedText(item.source.stage_id, 128),
    stageLabel: normalizedText(item.source.stage_label, 240),
    ownerId: normalizedText(item.source.owner_id, 128),
    teamId: normalizedText(item.source.team_id, 128),
    regionCode: normalizedText(item.source.region_code, 128),
    readinessScore: item.readinessScore,
    readinessStatus: item.readinessStatus,
    issueCount: item.issueCount,
    stageAgeDays: item.stageAgeDays,
    assessedAt: item.assessedAt,
    priorityScore: item.priorityScore,
    band: item.band,
    deterministicAttentionScore: item.deterministicAttentionScore,
    actionUrgencyScore: item.actionUrgencyScore,
    commercialImportanceScore: item.commercialImportanceScore,
    evidenceReviewScore: item.evidenceReviewScore,
    evidenceMode: item.evidenceMode,
    evidenceCoveragePercent: item.evidenceCoveragePercent,
    evidenceConfidence: item.evidenceConfidence,
    snapshotGeneratedAt: item.snapshotGeneratedAt,
    dealBriefStatus: item.dealBriefStatus,
    amount: {
      value: item.amountValue,
      basis: item.amountBasis,
      currencyCode: item.amountCurrencyCode,
      label: item.amountLabel,
      cohortPercentile: item.amountCohortKey ? item.commercialImportanceScore : null,
      comparable: item.amountCohortKey !== null,
    },
    nextAction: item.nextAction,
    openRemediationCount: item.openRemediationCount,
    overdueRemediationCount: item.overdueRemediationCount,
    reasons: item.reasons,
    dimensionStates: item.dimensionStates,
    semantics: {
      priorityNotWinProbability: true,
      amountPercentileWithinComparableCurrencyCohort: true,
      missingEvidenceNotProofOfLoss: true,
    },
  };
}

export function buildManagerDecisionQueue(
  portalId: string,
  rows: ManagerDecisionSourceRow[],
  options: { now?: number; limit?: number; band?: ManagerDecisionBand | null; evidenceMode?: DecisionEvidenceMode | null } = {},
): ManagerDecisionQueueResponse {
  const now = options.now ?? Date.now();
  const limit = Math.min(100, Math.max(1, Math.round(options.limit ?? 25)));
  const working = rows.map((row) => workingItem(row, portalId, now));
  const amountCohorts = applyAmountPercentiles(working);
  for (const item of working) finalize(item);
  const all = working.sort((left, right) =>
    right.priorityScore - left.priorityScore
    || right.actionUrgencyScore - left.actionUrgencyScore
    || right.commercialImportanceScore - left.commercialImportanceScore
    || Date.parse(right.assessedAt) - Date.parse(left.assessedAt));
  const filtered = all.filter((item) =>
    (!options.band || item.band === options.band)
    && (!options.evidenceMode || item.evidenceMode === options.evidenceMode));
  const items = filtered.slice(0, limit).map(toResponseItem);
  const fullDealBriefDeals = all.filter((item) => item.evidenceMode === 'full_deal_brief' || item.evidenceMode === 'aging_deal_brief').length;
  return {
    generatedAt: new Date(now).toISOString(),
    methodology: 'deterministic_manager_decision_queue_v1',
    filters: {
      band: options.band ?? null,
      evidenceMode: options.evidenceMode ?? null,
      limit,
    },
    summary: {
      totalOpenDeals: all.length,
      returnedDeals: items.length,
      actNow: all.filter((item) => item.band === 'act_now').length,
      review: all.filter((item) => item.band === 'review').length,
      monitor: all.filter((item) => item.band === 'monitor').length,
      overdueActions: all.filter((item) => item.nextAction?.overdue || item.overdueRemediationCount > 0).length,
      fullDealBriefDeals,
      readinessOnlyDeals: all.filter((item) => item.evidenceMode === 'readiness_only').length,
      staleDealBriefDeals: all.filter((item) => item.evidenceMode === 'stale_deal_brief').length,
      fullDealBriefCoveragePercent: all.length > 0 ? Math.round(fullDealBriefDeals / all.length * 100) : 0,
      amountComparableDeals: all.filter((item) => item.amountCohortKey !== null).length,
    },
    amountCohorts,
    items,
    semantics: {
      currentState: 'latest_open_assessment_per_deal',
      priority: 'deterministic_management_priority_not_win_probability',
      amount: 'percentile_within_company_currency_or_same_deal_currency_cohort',
      evidence: 'current_record_enrichment_snapshot_when_available_else_readiness_fallback',
      actions: 'owned_due_dated_recommendation_or_remediation_fallback',
    },
  };
}

function queryFilter(
  url: URL,
  access: EnterpriseAccessContext,
): { clauses: string[]; params: unknown[]; filters: Record<string, string> } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const filters: Record<string, string> = {};
  for (const [queryKey, column, scopeKey] of FILTERS) {
    const requested = normalizedText(url.searchParams.get(queryKey), 128);
    const allowed = access.scope[scopeKey];
    if (requested && allowed.length > 0 && !allowed.includes(requested)) {
      throw new AppError(403, 'decision_queue_scope_denied', `The selected ${queryKey} is outside your assigned scope.`);
    }
    if (requested) {
      clauses.push(`latest.${column} = ?`);
      params.push(requested);
      filters[queryKey] = requested;
    } else if (allowed.length > 0) {
      clauses.push(`latest.${column} IN (${allowed.map(() => '?').join(', ')})`);
      params.push(...allowed);
    }
  }
  return { clauses, params, filters };
}

export async function managerDecisionQueue(
  env: Env,
  identity: RequestIdentity,
  url: URL,
): Promise<ManagerDecisionQueueResponse> {
  const access = await requireEnterprisePermission(env, identity, 'analytics.view');
  const scoped = queryFilter(url, access);
  const where = scoped.clauses.length > 0 ? `AND ${scoped.clauses.join(' AND ')}` : '';
  const rows = await env.DB.prepare(
    `WITH latest_assessments AS (
      SELECT DISTINCT ON (deal_id) *
      FROM assessment_history
      WHERE portal_id = ?
      ORDER BY deal_id, assessed_at DESC, id DESC
    ),
    remediation_counts AS (
      SELECT
        deal_id,
        COUNT(*) AS open_remediation_count,
        SUM(CASE WHEN due_at IS NOT NULL AND due_at::timestamptz < NOW() THEN 1 ELSE 0 END) AS overdue_remediation_count
      FROM remediation_cases
      WHERE portal_id = ? AND status IN ('open', 'acknowledged', 'in_progress', 'overdue')
      GROUP BY deal_id
    ),
    next_remediation AS (
      SELECT DISTINCT ON (deal_id)
        deal_id,
        issue_code,
        title,
        description,
        priority,
        owner_id,
        due_at
      FROM remediation_cases
      WHERE portal_id = ? AND status IN ('open', 'acknowledged', 'in_progress', 'overdue')
      ORDER BY deal_id,
        CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
        due_at NULLS LAST,
        created_at ASC
    )
    SELECT
      latest.deal_id,
      assessment.deal_name,
      assessment.readiness_summary,
      assessment.issues_json,
      latest.score,
      latest.status,
      latest.issue_count,
      latest.pipeline_id,
      latest.pipeline_label,
      latest.stage_id,
      latest.stage_label,
      latest.owner_id,
      latest.team_id,
      latest.region_code,
      latest.deal_amount,
      latest.deal_currency_code,
      latest.deal_amount_in_company_currency,
      latest.stage_age_days,
      latest.assessed_at,
      snapshot.assessment_at AS snapshot_assessment_at,
      snapshot.generated_at AS snapshot_generated_at,
      snapshot.brief_status,
      snapshot.attention_score AS snapshot_attention_score,
      snapshot.confidence AS snapshot_confidence,
      snapshot.coverage_percent AS snapshot_coverage_percent,
      snapshot.freshness_status AS snapshot_freshness_status,
      snapshot.next_action_code,
      snapshot.next_action_label,
      snapshot.next_action_text,
      snapshot.next_action_priority,
      snapshot.next_action_owner,
      snapshot.next_action_due_at,
      snapshot.next_action_rationale,
      snapshot.next_action_evidence_json,
      snapshot.risk_summary_json,
      snapshot.dimensions_json,
      COALESCE(remediation.open_remediation_count, 0) AS open_remediation_count,
      COALESCE(remediation.overdue_remediation_count, 0) AS overdue_remediation_count,
      next_remediation.title AS remediation_title,
      next_remediation.description AS remediation_description,
      next_remediation.priority AS remediation_priority,
      next_remediation.owner_id AS remediation_owner_id,
      next_remediation.due_at AS remediation_due_at,
      next_remediation.issue_code AS remediation_issue_code
    FROM latest_assessments latest
    LEFT JOIN deal_assessments assessment
      ON assessment.portal_id = ? AND assessment.deal_id = latest.deal_id
    LEFT JOIN deal_decision_snapshots snapshot
      ON snapshot.portal_id = ? AND snapshot.deal_id = latest.deal_id
    LEFT JOIN remediation_counts remediation ON remediation.deal_id = latest.deal_id
    LEFT JOIN next_remediation ON next_remediation.deal_id = latest.deal_id
    WHERE latest.is_closed = 0 ${where}
    ORDER BY latest.assessed_at DESC
    LIMIT 10000`,
  ).bind(
    identity.portalId,
    identity.portalId,
    identity.portalId,
    identity.portalId,
    identity.portalId,
    ...scoped.params,
  ).all<ManagerDecisionSourceRow>();

  const bandValue = normalizedText(url.searchParams.get('band'), 40);
  const band = ['act_now', 'review', 'monitor'].includes(String(bandValue))
    ? bandValue as ManagerDecisionBand
    : null;
  const evidenceValue = normalizedText(url.searchParams.get('evidenceMode'), 40);
  const evidenceMode = ['full_deal_brief', 'aging_deal_brief', 'stale_deal_brief', 'readiness_only'].includes(String(evidenceValue))
    ? evidenceValue as DecisionEvidenceMode
    : null;
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 25) || 25));
  const response = buildManagerDecisionQueue(identity.portalId, rows.results ?? [], { limit, band, evidenceMode });
  response.filters = { ...response.filters, ...scoped.filters };
  return response;
}
