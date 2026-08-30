import { sha256Hex } from './crypto.js';
import type { DecisionSnapshot } from './decision-snapshot.js';
import { evaluateRecommendationOutcome } from './recommendation-outcome-model.js';
import {
  addRecommendationEvent,
  expirePresentedRecommendations,
  iso,
  numeric,
  object,
  parseJson,
  recommendationDealScope,
  text,
  type RecommendationRow,
  type RecommendationScopeRow,
} from './recommendation-outcome-storage.js';
import type {
  RecommendationBaseline,
  RecommendationEventType,
  RecommendationObservationInput,
  RecommendationStatus,
} from './recommendation-outcome-types.js';
import type { Env } from './types.js';

const OBSERVATION_WINDOW_MS = 90 * 86_400_000;
const MIN_OBSERVATION_DELAY_MS = 60_000;

function baselineFromSnapshot(
  snapshot: DecisionSnapshot,
  payload: unknown,
  scope: RecommendationScopeRow,
): RecommendationBaseline {
  const assessment = object(payload) ?? {};
  const intelligence = object(assessment.intelligence);
  const closeDate = object(intelligence?.closeDateCredibility);
  const readinessStatus = ['ready', 'at_risk', 'critical'].includes(String(assessment.status))
    ? assessment.status as RecommendationBaseline['readinessStatus']
    : null;
  return {
    assessmentAt: snapshot.assessmentAt,
    generatedAt: snapshot.generatedAt,
    readinessScore: numeric(assessment.score),
    readinessStatus,
    pipelineId: text(assessment.pipelineId, 128) ?? text(scope.pipeline_id, 128),
    stageId: text(assessment.stageId, 128),
    stageLabel: text(assessment.stageLabel, 240),
    ownerId: text(assessment.ownerId, 128) ?? text(scope.owner_id, 128),
    teamId: text(scope.team_id, 128),
    regionCode: text(scope.region_code, 128),
    closeDate: iso(closeDate?.currentCloseDate),
    attentionScore: snapshot.attentionScore,
    briefStatus: snapshot.briefStatus,
    dimensions: snapshot.dimensions,
  };
}

function recommendationDimension(snapshot: DecisionSnapshot): string {
  const action = snapshot.nextAction;
  if (!action) return 'general';
  const evidence = new Set(action.evidenceCodes);
  const matchingRisk = snapshot.risks.find((risk) => evidence.has(risk.code));
  if (matchingRisk) return matchingRisk.dimension.slice(0, 80);
  const code = action.code.toLowerCase();
  if (code.includes('relationship') || code.includes('stakeholder') || code.includes('champion')) return 'relationship';
  if (code.includes('engagement') || code.includes('meeting') || code.includes('response')) return 'engagement';
  if (code.includes('quote') || code.includes('commercial') || code.includes('discount') || code.includes('line_item')) return 'commercial';
  if (code.includes('close') || code.includes('stage') || code.includes('momentum')) return 'momentum';
  return 'readiness';
}

async function recommendationFingerprint(snapshot: DecisionSnapshot): Promise<string> {
  const action = snapshot.nextAction!;
  return sha256Hex(JSON.stringify({
    code: action.code,
    action: action.action,
    owner: action.owner,
    evidenceCodes: [...action.evidenceCodes].sort(),
  }));
}

async function supersedePresented(
  env: Env,
  portalId: string,
  dealId: string,
  exceptFingerprint: string | null,
  reason: string,
): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT id, status
     FROM recommendation_instances
     WHERE portal_id = ? AND deal_id = ? AND status = 'presented'
       ${exceptFingerprint ? 'AND recommendation_fingerprint != ?' : ''}`,
  ).bind(portalId, dealId, ...(exceptFingerprint ? [exceptFingerprint] : []))
    .all<{ id: string }>();
  const now = new Date().toISOString();
  for (const row of rows.results ?? []) {
    const result = await env.DB.prepare(
      `UPDATE recommendation_instances
       SET status = 'superseded', terminal_reason = ?, superseded_at = ?, updated_at = ?
       WHERE portal_id = ? AND id = ? AND status = 'presented'`,
    ).bind(reason, now, now, portalId, row.id).run();
    if (Number(result.meta?.changes ?? 0) <= 0) continue;
    await addRecommendationEvent(env, portalId, row.id, dealId, 'superseded', {
      userId: null,
      userEmail: null,
    }, { reason }, now);
  }
}

async function syncPresentedRecommendation(
  env: Env,
  snapshot: DecisionSnapshot,
  payload: unknown,
  scope: RecommendationScopeRow,
): Promise<void> {
  const action = snapshot.nextAction;
  if (!action) {
    await supersedePresented(env, snapshot.portalId, snapshot.dealId, null, 'no_current_recommendation');
    return;
  }
  const fingerprint = await recommendationFingerprint(snapshot);
  await supersedePresented(env, snapshot.portalId, snapshot.dealId, fingerprint, 'replaced_by_new_recommendation');
  const existing = await env.DB.prepare(
    `SELECT id, status
     FROM recommendation_instances
     WHERE portal_id = ? AND deal_id = ? AND recommendation_fingerprint = ?
       AND status IN ('presented', 'accepted')
     ORDER BY presented_at DESC
     LIMIT 1`,
  ).bind(snapshot.portalId, snapshot.dealId, fingerprint).first<{ id: string; status: RecommendationStatus }>();
  const now = new Date().toISOString();
  if (existing?.status === 'accepted') return;
  if (existing) {
    await env.DB.prepare(
      `UPDATE recommendation_instances
       SET recommendation_label = ?, recommendation_text = ?, recommendation_dimension = ?,
           priority = ?, owner_role = ?, rationale = ?, evidence_codes_json = ?,
           methodology = ?, last_presented_at = ?, updated_at = ?
       WHERE portal_id = ? AND id = ?`,
    ).bind(
      action.label, action.action, recommendationDimension(snapshot), action.priority, action.owner,
      action.rationale, JSON.stringify(action.evidenceCodes), snapshot.methodology,
      now, now, snapshot.portalId, existing.id,
    ).run();
    return;
  }

  const baseline = baselineFromSnapshot(snapshot, payload, scope);
  const duplicate = await env.DB.prepare(
    `SELECT id FROM recommendation_instances
     WHERE portal_id = ? AND deal_id = ? AND recommendation_fingerprint = ? AND baseline_assessment_at = ?
     LIMIT 1`,
  ).bind(snapshot.portalId, snapshot.dealId, fingerprint, baseline.assessmentAt).first<{ id: string }>();
  if (duplicate) return;

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO recommendation_instances (
      id, portal_id, deal_id, recommendation_fingerprint,
      recommendation_code, recommendation_label, recommendation_text, recommendation_dimension,
      priority, owner_role, due_at, rationale, evidence_codes_json, methodology, status,
      presented_at, last_presented_at,
      baseline_assessment_at, baseline_snapshot_generated_at,
      baseline_readiness_score, baseline_readiness_status,
      baseline_pipeline_id, baseline_stage_id, baseline_stage_label,
      baseline_owner_id, baseline_team_id, baseline_region_code, baseline_close_date,
      baseline_attention_score, baseline_brief_status, baseline_dimensions_json,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'presented', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id, snapshot.portalId, snapshot.dealId, fingerprint,
    action.code, action.label, action.action, recommendationDimension(snapshot),
    action.priority, action.owner, action.dueAt, action.rationale,
    JSON.stringify(action.evidenceCodes), snapshot.methodology,
    now, now,
    baseline.assessmentAt, baseline.generatedAt,
    baseline.readinessScore, baseline.readinessStatus,
    baseline.pipelineId, baseline.stageId, baseline.stageLabel,
    baseline.ownerId, baseline.teamId, baseline.regionCode, baseline.closeDate,
    baseline.attentionScore, baseline.briefStatus, JSON.stringify(baseline.dimensions),
    now, now,
  ).run();
  await addRecommendationEvent(env, snapshot.portalId, id, snapshot.dealId, 'presented', {
    userId: null,
    userEmail: null,
  }, {
    recommendationCode: action.code,
    assessmentAt: baseline.assessmentAt,
    generatedAt: baseline.generatedAt,
  }, now);
}

function currentObservation(
  snapshot: DecisionSnapshot,
  payload: unknown,
): RecommendationObservationInput['current'] {
  const assessment = object(payload) ?? {};
  const intelligence = object(assessment.intelligence);
  const closeDate = object(intelligence?.closeDateCredibility);
  const readinessStatus = ['ready', 'at_risk', 'critical'].includes(String(assessment.status))
    ? assessment.status as RecommendationBaseline['readinessStatus']
    : null;
  return {
    assessmentAt: iso(assessment.assessedAt),
    generatedAt: snapshot.generatedAt,
    readinessScore: numeric(assessment.score),
    readinessStatus,
    stageId: text(assessment.stageId, 128),
    closeDate: iso(closeDate?.currentCloseDate),
    attentionScore: snapshot.attentionScore,
    briefStatus: snapshot.briefStatus,
    dimensions: snapshot.dimensions,
    currentRecommendationCode: snapshot.nextAction?.code ?? null,
    observedEvidenceCodes: [
      ...snapshot.risks.map((risk) => risk.code),
      ...(snapshot.nextAction?.evidenceCodes ?? []),
      ...(snapshot.nextAction ? [snapshot.nextAction.code] : []),
    ],
  };
}

async function evaluateCompletedRecommendations(
  env: Env,
  snapshot: DecisionSnapshot,
  payload: unknown,
): Promise<void> {
  const generatedAtMs = Date.parse(snapshot.generatedAt);
  const rows = await env.DB.prepare(
    `SELECT * FROM recommendation_instances
     WHERE portal_id = ? AND deal_id = ? AND status = 'completed'
       AND completed_at IS NOT NULL AND completed_at::timestamptz <= ?::timestamptz
       AND completed_at::timestamptz >= ?::timestamptz
     ORDER BY completed_at DESC
     LIMIT 100`,
  ).bind(
    snapshot.portalId,
    snapshot.dealId,
    new Date(generatedAtMs - MIN_OBSERVATION_DELAY_MS).toISOString(),
    new Date(generatedAtMs - OBSERVATION_WINDOW_MS).toISOString(),
  ).all<RecommendationRow>();
  const current = currentObservation(snapshot, payload);

  for (const row of rows.results ?? []) {
    const previous = await env.DB.prepare(
      `SELECT observation_generated_at, first_observed_at
       FROM recommendation_outcomes
       WHERE portal_id = ? AND recommendation_id = ?`,
    ).bind(snapshot.portalId, row.id).first<{
      observation_generated_at: string | null;
      first_observed_at: string | null;
    }>();
    if (previous?.observation_generated_at
      && Date.parse(previous.observation_generated_at) >= generatedAtMs) continue;

    const baseline: RecommendationBaseline = {
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
    };
    const evaluation = evaluateRecommendationOutcome({
      recommendationCode: row.recommendation_code,
      baseline,
      baselineEvidenceCodes: parseJson<string[]>(row.evidence_codes_json, []),
      current,
    });
    const observedAt = snapshot.generatedAt;
    const now = new Date().toISOString();
    const firstObservation = !previous?.observation_generated_at;
    await env.DB.prepare(
      `INSERT INTO recommendation_outcomes (
        recommendation_id, portal_id, deal_id, evaluation_status, observed_progress,
        observation_assessment_at, observation_generated_at, readiness_delta, attention_delta,
        stage_changed, close_date_delta_days, dimension_deltas_json,
        evidence_no_longer_observed_json, recommendation_still_current,
        positive_signal_count, negative_signal_count, explanation, causal_attribution,
        first_observed_at, last_observed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
      ON CONFLICT(recommendation_id) DO UPDATE SET
        evaluation_status = excluded.evaluation_status,
        observed_progress = excluded.observed_progress,
        observation_assessment_at = excluded.observation_assessment_at,
        observation_generated_at = excluded.observation_generated_at,
        readiness_delta = excluded.readiness_delta,
        attention_delta = excluded.attention_delta,
        stage_changed = excluded.stage_changed,
        close_date_delta_days = excluded.close_date_delta_days,
        dimension_deltas_json = excluded.dimension_deltas_json,
        evidence_no_longer_observed_json = excluded.evidence_no_longer_observed_json,
        recommendation_still_current = excluded.recommendation_still_current,
        positive_signal_count = excluded.positive_signal_count,
        negative_signal_count = excluded.negative_signal_count,
        explanation = excluded.explanation,
        first_observed_at = COALESCE(recommendation_outcomes.first_observed_at, excluded.first_observed_at),
        last_observed_at = excluded.last_observed_at,
        updated_at = excluded.updated_at
      WHERE recommendation_outcomes.observation_generated_at IS NULL
         OR excluded.observation_generated_at::timestamptz > recommendation_outcomes.observation_generated_at::timestamptz`,
    ).bind(
      row.id, snapshot.portalId, snapshot.dealId,
      evaluation.evaluationStatus, evaluation.observedProgress,
      current.assessmentAt, observedAt,
      evaluation.readinessDelta, evaluation.attentionDelta,
      evaluation.stageChanged === null ? null : evaluation.stageChanged ? 1 : 0,
      evaluation.closeDateDeltaDays,
      JSON.stringify(evaluation.dimensionDeltas),
      JSON.stringify(evaluation.evidenceNoLongerObservedCodes),
      evaluation.recommendationStillCurrent ? 1 : 0,
      evaluation.positiveSignalCount, evaluation.negativeSignalCount,
      evaluation.explanation,
      firstObservation ? observedAt : previous?.first_observed_at ?? observedAt,
      observedAt, now, now,
    ).run();
    if (firstObservation) {
      await addRecommendationEvent(env, snapshot.portalId, row.id, snapshot.dealId, 'outcome_observed', {
        userId: null,
        userEmail: null,
      }, {
        observedProgress: evaluation.observedProgress,
        causalAttribution: false,
      }, observedAt);
    }
  }
}

export async function observeRecommendationSnapshot(
  env: Env,
  snapshot: DecisionSnapshot,
  payload: unknown,
): Promise<void> {
  await expirePresentedRecommendations(env, snapshot.portalId, snapshot.dealId);
  const scope = await recommendationDealScope(env, snapshot.portalId, snapshot.dealId);
  await syncPresentedRecommendation(env, snapshot, payload, scope);
  await evaluateCompletedRecommendations(env, snapshot, payload);
}

export async function closeRecommendationsForDeal(
  env: Env,
  portalId: string,
  dealId: string,
): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT id, status FROM recommendation_instances
     WHERE portal_id = ? AND deal_id = ? AND status IN ('presented', 'accepted')`,
  ).bind(portalId, dealId).all<{ id: string; status: RecommendationStatus }>();
  const now = new Date().toISOString();
  for (const row of rows.results ?? []) {
    const status: RecommendationStatus = row.status === 'accepted' ? 'expired' : 'superseded';
    const event: RecommendationEventType = status === 'expired' ? 'expired' : 'superseded';
    const result = await env.DB.prepare(
      `UPDATE recommendation_instances
       SET status = ?, terminal_reason = 'deal_closed',
           expired_at = CASE WHEN ? = 'expired' THEN ? ELSE expired_at END,
           superseded_at = CASE WHEN ? = 'superseded' THEN ? ELSE superseded_at END,
           updated_at = ?
       WHERE portal_id = ? AND id = ? AND status IN ('presented', 'accepted')`,
    ).bind(status, status, now, status, now, now, portalId, row.id).run();
    if (Number(result.meta?.changes ?? 0) <= 0) continue;
    await addRecommendationEvent(env, portalId, row.id, dealId, event, {
      userId: null,
      userEmail: null,
    }, { reason: 'deal_closed' }, now);
  }
}
