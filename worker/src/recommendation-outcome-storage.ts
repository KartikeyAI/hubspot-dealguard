import type { EnterpriseAccessContext } from './enterprise-access.js';
import type {
  RecommendationEventType,
  RecommendationInstance,
  RecommendationOutcome,
  RecommendationStatus,
} from './recommendation-outcome-types.js';
import type { Env } from './types.js';

export const ACTIVE_RECOMMENDATION_STATUSES: RecommendationStatus[] = ['presented', 'accepted'];

export interface RecommendationScopeRow extends Record<string, unknown> {
  pipeline_id: string | null;
  team_id: string | null;
  owner_id: string | null;
  region_code: string | null;
}

export interface RecommendationRow extends Record<string, unknown> {
  id: string;
  portal_id: string;
  deal_id: string;
  recommendation_fingerprint: string;
  recommendation_code: string;
  recommendation_label: string;
  recommendation_text: string;
  recommendation_dimension: string;
  priority: 'high' | 'medium' | 'low';
  owner_role: 'deal_owner' | 'manager';
  due_at: string | null;
  rationale: string;
  evidence_codes_json: string;
  methodology: string;
  status: RecommendationStatus;
  terminal_reason: string | null;
  presented_at: string;
  last_presented_at: string;
  accepted_at: string | null;
  completed_at: string | null;
  dismissed_at: string | null;
  expired_at: string | null;
  superseded_at: string | null;
  dismissal_reason: string | null;
  baseline_assessment_at: string;
  baseline_snapshot_generated_at: string;
  baseline_readiness_score: number | null;
  baseline_readiness_status: RecommendationInstance['baseline']['readinessStatus'];
  baseline_pipeline_id: string | null;
  baseline_stage_id: string | null;
  baseline_stage_label: string | null;
  baseline_owner_id: string | null;
  baseline_team_id: string | null;
  baseline_region_code: string | null;
  baseline_close_date: string | null;
  baseline_attention_score: number | null;
  baseline_brief_status: RecommendationInstance['baseline']['briefStatus'];
  baseline_dimensions_json: string;
  current_action_code?: string | null;
  outcome_evaluation_status?: RecommendationOutcome['evaluationStatus'] | null;
  outcome_observed_progress?: RecommendationOutcome['observedProgress'] | null;
  outcome_observation_assessment_at?: string | null;
  outcome_observation_generated_at?: string | null;
  outcome_readiness_delta?: number | null;
  outcome_attention_delta?: number | null;
  outcome_stage_changed?: number | null;
  outcome_close_date_delta_days?: number | null;
  outcome_dimension_deltas_json?: string | null;
  outcome_evidence_no_longer_observed_json?: string | null;
  outcome_recommendation_still_current?: number | null;
  outcome_positive_signal_count?: number | null;
  outcome_negative_signal_count?: number | null;
  outcome_explanation?: string | null;
  outcome_first_observed_at?: string | null;
  outcome_last_observed_at?: string | null;
}

export function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function text(value: unknown, maximum = 500): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maximum) : null;
}

export function numeric(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function iso(value: unknown): string | null {
  const normalized = text(value, 80);
  if (!normalized) return null;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function percentage(numerator: number, denominator: number): number {
  return denominator > 0 ? Math.round(numerator / denominator * 100) : 0;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
  return Math.round(value * 10) / 10;
}

export async function recommendationDealScope(
  env: Env,
  portalId: string,
  dealId: string,
): Promise<RecommendationScopeRow> {
  return await env.DB.prepare(
    `SELECT pipeline_id, team_id, owner_id, region_code
     FROM assessment_history
     WHERE portal_id = ? AND deal_id = ?
     ORDER BY assessed_at DESC, id DESC
     LIMIT 1`,
  ).bind(portalId, dealId).first<RecommendationScopeRow>() ?? {
    pipeline_id: null,
    team_id: null,
    owner_id: null,
    region_code: null,
  };
}

export function recommendationScopeResource(scope: RecommendationScopeRow): {
  pipelineId: string | null;
  teamId: string | null;
  ownerId: string | null;
  regionCode: string | null;
} {
  return {
    pipelineId: text(scope.pipeline_id, 128),
    teamId: text(scope.team_id, 128),
    ownerId: text(scope.owner_id, 128),
    regionCode: text(scope.region_code, 128),
  };
}

export async function addRecommendationEvent(
  env: Env,
  portalId: string,
  recommendationId: string,
  dealId: string,
  eventType: RecommendationEventType,
  actor: { userId: string | null; userEmail: string | null },
  metadata: Record<string, unknown>,
  occurredAt = new Date().toISOString(),
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO recommendation_events (
      id, portal_id, recommendation_id, deal_id, event_type,
      actor_user_id, actor_email, metadata_json, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(), portalId, recommendationId, dealId, eventType,
    actor.userId, actor.userEmail, JSON.stringify(metadata), occurredAt,
  ).run();
}

export async function expirePresentedRecommendations(
  env: Env,
  portalId: string,
  dealId?: string,
): Promise<number> {
  const now = new Date().toISOString();
  const rows = await env.DB.prepare(
    `SELECT id, deal_id, due_at
     FROM recommendation_instances
     WHERE portal_id = ? AND status = 'presented' AND due_at IS NOT NULL
       AND due_at::timestamptz < NOW()
       ${dealId ? 'AND deal_id = ?' : ''}
     ORDER BY due_at ASC
     LIMIT 500`,
  ).bind(portalId, ...(dealId ? [dealId] : [])).all<{ id: string; deal_id: string; due_at: string }>();
  let expired = 0;
  for (const row of rows.results ?? []) {
    const result = await env.DB.prepare(
      `UPDATE recommendation_instances
       SET status = 'expired', terminal_reason = 'unaccepted_due_date_passed', expired_at = ?, updated_at = ?
       WHERE portal_id = ? AND id = ? AND status = 'presented'`,
    ).bind(now, now, portalId, row.id).run();
    if (Number(result.meta?.changes ?? 0) <= 0) continue;
    expired += 1;
    await addRecommendationEvent(env, portalId, row.id, row.deal_id, 'expired', {
      userId: null,
      userEmail: null,
    }, {
      reason: 'unaccepted_due_date_passed',
      dueAt: row.due_at,
    }, now);
  }
  return expired;
}

function outcomeFromRow(row: RecommendationRow): RecommendationOutcome | null {
  if (!row.outcome_evaluation_status) return null;
  return {
    evaluationStatus: row.outcome_evaluation_status,
    observedProgress: row.outcome_observed_progress ?? null,
    observationAssessmentAt: iso(row.outcome_observation_assessment_at),
    observationGeneratedAt: iso(row.outcome_observation_generated_at),
    readinessDelta: numeric(row.outcome_readiness_delta),
    attentionDelta: numeric(row.outcome_attention_delta),
    stageChanged: row.outcome_stage_changed === null || row.outcome_stage_changed === undefined
      ? null
      : Number(row.outcome_stage_changed) === 1,
    closeDateDeltaDays: numeric(row.outcome_close_date_delta_days),
    dimensionDeltas: parseJson<Record<string, number>>(row.outcome_dimension_deltas_json, {}),
    evidenceNoLongerObservedCodes: parseJson<string[]>(row.outcome_evidence_no_longer_observed_json, []),
    recommendationStillCurrent: row.outcome_recommendation_still_current === null || row.outcome_recommendation_still_current === undefined
      ? null
      : Number(row.outcome_recommendation_still_current) === 1,
    positiveSignalCount: Number(row.outcome_positive_signal_count ?? 0),
    negativeSignalCount: Number(row.outcome_negative_signal_count ?? 0),
    explanation: text(row.outcome_explanation, 2000),
    causalAttribution: false,
    firstObservedAt: iso(row.outcome_first_observed_at),
    lastObservedAt: iso(row.outcome_last_observed_at),
  };
}

export function mapRecommendation(row: RecommendationRow, now = Date.now()): RecommendationInstance {
  const dueAt = iso(row.due_at);
  return {
    id: row.id,
    dealId: row.deal_id,
    recommendationCode: row.recommendation_code,
    label: row.recommendation_label,
    action: row.recommendation_text,
    dimension: row.recommendation_dimension,
    priority: row.priority,
    owner: row.owner_role,
    dueAt,
    rationale: row.rationale,
    evidenceCodes: parseJson<string[]>(row.evidence_codes_json, []),
    methodology: row.methodology,
    status: row.status,
    terminalReason: text(row.terminal_reason, 240),
    presentedAt: row.presented_at,
    lastPresentedAt: row.last_presented_at,
    acceptedAt: iso(row.accepted_at),
    completedAt: iso(row.completed_at),
    dismissedAt: iso(row.dismissed_at),
    expiredAt: iso(row.expired_at),
    supersededAt: iso(row.superseded_at),
    dismissalReason: text(row.dismissal_reason, 1000),
    overdue: row.status === 'accepted' && Boolean(dueAt && Date.parse(dueAt) < now),
    current: ACTIVE_RECOMMENDATION_STATUSES.includes(row.status)
      && row.current_action_code === row.recommendation_code,
    baseline: {
      assessmentAt: row.baseline_assessment_at,
      generatedAt: row.baseline_snapshot_generated_at,
      readinessScore: numeric(row.baseline_readiness_score),
      readinessStatus: row.baseline_readiness_status,
      pipelineId: text(row.baseline_pipeline_id, 128),
      stageId: text(row.baseline_stage_id, 128),
      stageLabel: text(row.baseline_stage_label, 240),
      ownerId: text(row.baseline_owner_id, 128),
      teamId: text(row.baseline_team_id, 128),
      regionCode: text(row.baseline_region_code, 128),
      closeDate: iso(row.baseline_close_date),
      attentionScore: numeric(row.baseline_attention_score),
      briefStatus: row.baseline_brief_status,
      dimensions: parseJson<Record<string, unknown>>(row.baseline_dimensions_json, {}),
    },
    outcome: outcomeFromRow(row),
  };
}

export const RECOMMENDATION_SELECT = `
  SELECT recommendation.*,
    snapshot.next_action_code AS current_action_code,
    outcome.evaluation_status AS outcome_evaluation_status,
    outcome.observed_progress AS outcome_observed_progress,
    outcome.observation_assessment_at AS outcome_observation_assessment_at,
    outcome.observation_generated_at AS outcome_observation_generated_at,
    outcome.readiness_delta AS outcome_readiness_delta,
    outcome.attention_delta AS outcome_attention_delta,
    outcome.stage_changed AS outcome_stage_changed,
    outcome.close_date_delta_days AS outcome_close_date_delta_days,
    outcome.dimension_deltas_json AS outcome_dimension_deltas_json,
    outcome.evidence_no_longer_observed_json AS outcome_evidence_no_longer_observed_json,
    outcome.recommendation_still_current AS outcome_recommendation_still_current,
    outcome.positive_signal_count AS outcome_positive_signal_count,
    outcome.negative_signal_count AS outcome_negative_signal_count,
    outcome.explanation AS outcome_explanation,
    outcome.first_observed_at AS outcome_first_observed_at,
    outcome.last_observed_at AS outcome_last_observed_at
  FROM recommendation_instances recommendation
  LEFT JOIN deal_decision_snapshots snapshot
    ON snapshot.portal_id = recommendation.portal_id AND snapshot.deal_id = recommendation.deal_id
  LEFT JOIN recommendation_outcomes outcome
    ON outcome.portal_id = recommendation.portal_id AND outcome.recommendation_id = recommendation.id`;

export async function recommendationById(
  env: Env,
  portalId: string,
  id: string,
): Promise<RecommendationInstance | null> {
  const row = await env.DB.prepare(
    `${RECOMMENDATION_SELECT}
     WHERE recommendation.portal_id = ? AND recommendation.id = ?
     LIMIT 1`,
  ).bind(portalId, id).first<RecommendationRow>();
  return row ? mapRecommendation(row) : null;
}

export function analyticsScopeFilter(
  url: URL,
  access: EnterpriseAccessContext,
): { clauses: string[]; params: unknown[]; deniedKey: string | null } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const definitions = [
    ['pipelineId', 'baseline_pipeline_id', 'pipelineIds'],
    ['teamId', 'baseline_team_id', 'teamIds'],
    ['ownerId', 'baseline_owner_id', 'ownerIds'],
    ['regionCode', 'baseline_region_code', 'regionCodes'],
  ] as const;
  for (const [queryKey, column, scopeKey] of definitions) {
    const requested = text(url.searchParams.get(queryKey), 128);
    const allowed = access.scope[scopeKey];
    if (requested && allowed.length > 0 && !allowed.includes(requested)) {
      return { clauses: [], params: [], deniedKey: queryKey };
    }
    if (requested) {
      clauses.push(`recommendation.${column} = ?`);
      params.push(requested);
    } else if (allowed.length > 0) {
      clauses.push(`recommendation.${column} IN (${allowed.map(() => '?').join(', ')})`);
      params.push(...allowed);
    }
  }
  return { clauses, params, deniedKey: null };
}
