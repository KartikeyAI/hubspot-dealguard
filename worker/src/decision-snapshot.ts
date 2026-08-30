import {
  closeRecommendationsForDeal,
  observeRecommendationSnapshot,
} from './recommendation-outcomes.js';
import type { Env } from './types.js';

const BRIEF_STATUSES = new Set(['on_track', 'watch', 'intervention_required', 'insufficient_evidence']);
const CONFIDENCE = new Set(['high', 'medium', 'low']);
const FRESHNESS = new Set(['fresh', 'aging', 'stale', 'unavailable']);
const ACTION_PRIORITIES = new Set(['high', 'medium', 'low']);
const ACTION_OWNERS = new Set(['deal_owner', 'manager']);
const ISSUE_SEVERITIES = new Set(['critical', 'warning', 'info']);

export interface DecisionSnapshotRisk {
  code: string;
  label: string;
  dimension: string;
  severity: 'critical' | 'warning' | 'info';
}

export interface DecisionSnapshotAction {
  code: string;
  label: string;
  action: string;
  priority: 'high' | 'medium' | 'low';
  owner: 'deal_owner' | 'manager';
  dueAt: string | null;
  rationale: string;
  evidenceCodes: string[];
}

export interface DecisionSnapshot {
  portalId: string;
  dealId: string;
  assessmentAt: string;
  generatedAt: string;
  methodology: string;
  briefStatus: 'on_track' | 'watch' | 'intervention_required' | 'insufficient_evidence';
  attentionScore: number;
  confidence: 'high' | 'medium' | 'low';
  coveragePercent: number;
  freshnessStatus: 'fresh' | 'aging' | 'stale' | 'unavailable';
  nextAction: DecisionSnapshotAction | null;
  risks: DecisionSnapshotRisk[];
  dimensions: Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown, maximum = 500): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maximum) : null;
}

function iso(value: unknown): string | null {
  const normalized = text(value, 80);
  if (!normalized) return null;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function number(value: unknown, minimum = 0, maximum = 100): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : null;
}

function stringArray(value: unknown, maximum = 20): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    .map((item) => item.trim().slice(0, 160)))]
    .slice(0, maximum);
}

function statusValue<T extends string>(value: unknown, allowed: Set<string>): T | null {
  const normalized = text(value, 80);
  return normalized && allowed.has(normalized) ? normalized as T : null;
}

function dimensionState(value: unknown, scoreKey: string, statusKey: string): Record<string, unknown> | null {
  const source = record(value);
  if (!source) return null;
  const score = number(source[scoreKey]);
  const status = text(source[statusKey], 80);
  if (score === null && !status) return null;
  return {
    ...(score !== null ? { score: Math.round(score) } : {}),
    ...(status ? { status } : {}),
  };
}

function safeRisks(value: unknown): DecisionSnapshotRisk[] {
  if (!Array.isArray(value)) return [];
  const risks: DecisionSnapshotRisk[] = [];
  for (const item of value.slice(0, 8)) {
    const source = record(item);
    if (!source) continue;
    const code = text(source.code, 160);
    const label = text(source.label, 240);
    const dimension = text(source.dimension, 80) ?? 'unknown';
    const severity = statusValue<DecisionSnapshotRisk['severity']>(source.severity, ISSUE_SEVERITIES) ?? 'warning';
    if (!code || !label) continue;
    risks.push({ code, label, dimension, severity });
  }
  return risks;
}

function safeAction(value: unknown): DecisionSnapshotAction | null {
  const source = record(value);
  if (!source) return null;
  const code = text(source.code, 160);
  const label = text(source.label, 240);
  const action = text(source.action, 800);
  const priority = statusValue<DecisionSnapshotAction['priority']>(source.priority, ACTION_PRIORITIES);
  const owner = statusValue<DecisionSnapshotAction['owner']>(source.owner, ACTION_OWNERS);
  if (!code || !label || !action || !priority || !owner) return null;
  return {
    code,
    label,
    action,
    priority,
    owner,
    dueAt: iso(source.dueAt),
    rationale: text(source.rationale, 800) ?? 'The action is supported by the current deterministic Deal Brief evidence.',
    evidenceCodes: stringArray(source.evidenceCodes, 20),
  };
}

export function extractDecisionSnapshot(
  portalId: string,
  dealId: string,
  payload: unknown,
  now = Date.now(),
): DecisionSnapshot | null {
  const assessment = record(payload);
  if (!assessment) return null;
  if (assessment.isClosed === true) return null;
  const intelligence = record(assessment.intelligence);
  const brief = record(intelligence?.dealBrief);
  if (!intelligence || !brief) return null;

  const assessmentAt = iso(assessment.assessedAt);
  const generatedAt = iso(brief.generatedAt) ?? new Date(now).toISOString();
  const briefStatus = statusValue<DecisionSnapshot['briefStatus']>(brief.status, BRIEF_STATUSES);
  const attentionScore = number(brief.attentionScore);
  const confidence = statusValue<DecisionSnapshot['confidence']>(brief.confidence, CONFIDENCE);
  const coverage = record(brief.coverage);
  const coveragePercent = number(coverage?.percent);
  const freshness = record(brief.freshness);
  const freshnessStatus = statusValue<DecisionSnapshot['freshnessStatus']>(freshness?.status, FRESHNESS);
  if (!assessmentAt || !briefStatus || attentionScore === null || !confidence || coveragePercent === null || !freshnessStatus) {
    return null;
  }

  const dimensions: Record<string, unknown> = {
    readiness: {
      score: Math.round(number(assessment.score) ?? 0),
      status: text(assessment.status, 80) ?? 'unknown',
    },
  };
  const momentum = dimensionState(intelligence.momentum, 'score', 'band');
  const closeDate = dimensionState(intelligence.closeDateCredibility, 'score', 'status');
  const relationship = dimensionState(intelligence.relationshipCoverage, 'score', 'status');
  const engagement = dimensionState(intelligence.engagement, 'score', 'status');
  const commercial = dimensionState(intelligence.commercialIntegrity, 'score', 'status');
  if (momentum) dimensions.momentum = momentum;
  if (closeDate) dimensions.closeDate = closeDate;
  if (relationship) dimensions.relationship = relationship;
  if (engagement) dimensions.engagement = engagement;
  if (commercial) dimensions.commercial = commercial;

  return {
    portalId: portalId.slice(0, 128),
    dealId: dealId.slice(0, 128),
    assessmentAt,
    generatedAt,
    methodology: text(brief.methodology, 120) ?? 'deterministic_evidence_synthesis',
    briefStatus,
    attentionScore: Math.round(attentionScore),
    confidence,
    coveragePercent: Math.round(coveragePercent),
    freshnessStatus,
    nextAction: safeAction(brief.nextAction),
    risks: safeRisks(brief.risks),
    dimensions,
  };
}

function logRecommendationObservation(task: string, portalId: string, dealId: string, error: unknown): void {
  console.error(JSON.stringify({
    level: 'warn',
    task,
    portalId,
    dealId,
    error: error instanceof Error ? error.message : String(error),
  }));
}

export async function persistDecisionSnapshot(
  env: Env,
  portalId: string,
  dealId: string,
  payload: unknown,
): Promise<boolean> {
  const assessment = record(payload);
  if (assessment?.isClosed === true) {
    await env.DB.prepare(`DELETE FROM deal_decision_snapshots WHERE portal_id = ? AND deal_id = ?`)
      .bind(portalId, dealId)
      .run();
    await closeRecommendationsForDeal(env, portalId, dealId).catch((error) => {
      logRecommendationObservation('recommendation_close_observation', portalId, dealId, error);
    });
    return false;
  }

  const snapshot = extractDecisionSnapshot(portalId, dealId, payload);
  if (!snapshot) return false;
  const action = snapshot.nextAction;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO deal_decision_snapshots (
      portal_id, deal_id, assessment_at, generated_at, methodology, brief_status,
      attention_score, confidence, coverage_percent, freshness_status,
      next_action_code, next_action_label, next_action_text, next_action_priority,
      next_action_owner, next_action_due_at, next_action_rationale,
      next_action_evidence_json, risk_summary_json, dimensions_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(portal_id, deal_id) DO UPDATE SET
      assessment_at = excluded.assessment_at,
      generated_at = excluded.generated_at,
      methodology = excluded.methodology,
      brief_status = excluded.brief_status,
      attention_score = excluded.attention_score,
      confidence = excluded.confidence,
      coverage_percent = excluded.coverage_percent,
      freshness_status = excluded.freshness_status,
      next_action_code = excluded.next_action_code,
      next_action_label = excluded.next_action_label,
      next_action_text = excluded.next_action_text,
      next_action_priority = excluded.next_action_priority,
      next_action_owner = excluded.next_action_owner,
      next_action_due_at = excluded.next_action_due_at,
      next_action_rationale = excluded.next_action_rationale,
      next_action_evidence_json = excluded.next_action_evidence_json,
      risk_summary_json = excluded.risk_summary_json,
      dimensions_json = excluded.dimensions_json,
      updated_at = excluded.updated_at
    WHERE excluded.assessment_at::timestamptz >= deal_decision_snapshots.assessment_at::timestamptz`,
  ).bind(
    snapshot.portalId,
    snapshot.dealId,
    snapshot.assessmentAt,
    snapshot.generatedAt,
    snapshot.methodology,
    snapshot.briefStatus,
    snapshot.attentionScore,
    snapshot.confidence,
    snapshot.coveragePercent,
    snapshot.freshnessStatus,
    action?.code ?? null,
    action?.label ?? null,
    action?.action ?? null,
    action?.priority ?? null,
    action?.owner ?? null,
    action?.dueAt ?? null,
    action?.rationale ?? null,
    JSON.stringify(action?.evidenceCodes ?? []),
    JSON.stringify(snapshot.risks),
    JSON.stringify(snapshot.dimensions),
    now,
    now,
  ).run();
  await observeRecommendationSnapshot(env, snapshot, payload).catch((error) => {
    logRecommendationObservation('recommendation_snapshot_observation', portalId, dealId, error);
  });
  return true;
}
