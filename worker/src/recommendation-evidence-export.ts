import { requireEnterprisePermission } from './enterprise-access.js';
import { AppError } from './errors.js';
import { analyticsScopeFilter, mapRecommendation, RECOMMENDATION_SELECT, safeRecommendationStatus, type RecommendationRow } from './recommendation-outcome-storage.js';
import { safeCsvCell } from './recommendation-operations-model.js';
import { Repository } from './repository.js';
import type { Env, RequestIdentity } from './types.js';

const MAX_ROWS = 10_000;
const DAY_MS = 86_400_000;
const STATUSES = ['presented', 'accepted', 'completed', 'dismissed', 'expired', 'superseded'] as const;
const PRIORITIES = ['high', 'medium', 'low'] as const;

function text(value: string | null, maximum = 500): string | null {
  const normalized = value?.trim() ?? '';
  return normalized ? normalized.slice(0, maximum) : null;
}

function parseDate(value: string | null, endOfDay = false): Date | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new AppError(400, 'recommendation_export_date_invalid', 'Export dates must use YYYY-MM-DD.');
  }
  const parsed = new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);
  if (!Number.isFinite(parsed.getTime())) {
    throw new AppError(400, 'recommendation_export_date_invalid', 'Export dates must use YYYY-MM-DD.');
  }
  return parsed;
}

function exportWindow(url: URL): { start: Date; end: Date; days: number } {
  const from = parseDate(url.searchParams.get('from'));
  const to = parseDate(url.searchParams.get('to'), true);
  if ((from && !to) || (!from && to)) {
    throw new AppError(400, 'recommendation_export_window_incomplete', 'Provide both from and to dates.');
  }
  if (from && to) {
    if (from.getTime() > to.getTime()) {
      throw new AppError(400, 'recommendation_export_window_invalid', 'The export start date cannot be after the end date.');
    }
    if (to.getTime() - from.getTime() > 366 * DAY_MS) {
      throw new AppError(400, 'recommendation_export_window_too_large', 'Recommendation evidence exports cannot exceed 366 days.');
    }
    return { start: from, end: to, days: Math.max(1, Math.ceil((to.getTime() - from.getTime()) / DAY_MS)) };
  }
  const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days') ?? 90) || 90));
  const end = new Date();
  return { start: new Date(end.getTime() - days * DAY_MS), end, days };
}

function csv(recommendations: ReturnType<typeof mapRecommendation>[]): string {
  const columns = [
    'recommendation_id', 'deal_id', 'recommendation_code', 'label', 'action', 'dimension',
    'priority', 'owner_role', 'status', 'current', 'overdue', 'due_at', 'presented_at',
    'accepted_at', 'completed_at', 'dismissed_at', 'expired_at', 'superseded_at',
    'dismissal_reason', 'baseline_assessment_at', 'baseline_readiness_score',
    'baseline_readiness_status', 'baseline_pipeline_id', 'baseline_stage_id',
    'baseline_stage_label', 'baseline_owner_id', 'baseline_team_id', 'baseline_region_code',
    'baseline_close_date', 'baseline_attention_score', 'baseline_brief_status',
    'outcome_evaluation_status', 'observed_progress', 'observation_assessment_at',
    'readiness_delta', 'attention_delta', 'stage_changed', 'close_date_delta_days',
    'evidence_no_longer_observed', 'recommendation_still_current', 'outcome_explanation',
    'causal_attribution',
  ];
  const rows = recommendations.map((item) => [
    item.id,
    item.dealId,
    item.recommendationCode,
    item.label,
    item.action,
    item.dimension,
    item.priority,
    item.owner,
    item.status,
    item.current,
    item.overdue,
    item.dueAt,
    item.presentedAt,
    item.acceptedAt,
    item.completedAt,
    item.dismissedAt,
    item.expiredAt,
    item.supersededAt,
    item.dismissalReason,
    item.baseline.assessmentAt,
    item.baseline.readinessScore,
    item.baseline.readinessStatus,
    item.baseline.pipelineId,
    item.baseline.stageId,
    item.baseline.stageLabel,
    item.baseline.ownerId,
    item.baseline.teamId,
    item.baseline.regionCode,
    item.baseline.closeDate,
    item.baseline.attentionScore,
    item.baseline.briefStatus,
    item.outcome?.evaluationStatus ?? null,
    item.outcome?.observedProgress ?? null,
    item.outcome?.observationAssessmentAt ?? null,
    item.outcome?.readinessDelta ?? null,
    item.outcome?.attentionDelta ?? null,
    item.outcome?.stageChanged ?? null,
    item.outcome?.closeDateDeltaDays ?? null,
    item.outcome?.evidenceNoLongerObservedCodes ?? [],
    item.outcome?.recommendationStillCurrent ?? null,
    item.outcome?.explanation ?? null,
    false,
  ].map(safeCsvCell).join(','));
  return `${columns.map(safeCsvCell).join(',')}\n${rows.join('\n')}\n`;
}

export async function exportRecommendationEvidence(
  env: Env,
  identity: RequestIdentity,
  url: URL,
): Promise<Response> {
  const access = await requireEnterprisePermission(env, identity, 'analytics.export');
  const window = exportWindow(url);
  const scoped = analyticsScopeFilter(url, access);
  if (scoped.deniedKey) {
    throw new AppError(403, 'recommendation_export_scope_denied', `The selected ${scoped.deniedKey} is outside your assigned scope.`);
  }
  const clauses = [
    'recommendation.portal_id = ?',
    'recommendation.presented_at >= ?',
    'recommendation.presented_at <= ?',
    ...scoped.clauses,
  ];
  const params: unknown[] = [identity.portalId, window.start.toISOString(), window.end.toISOString(), ...scoped.params];
  const status = text(url.searchParams.get('status'), 40);
  if (status) {
    const normalized = safeRecommendationStatus(status);
    if (!STATUSES.includes(normalized as typeof STATUSES[number])) {
      throw new AppError(400, 'recommendation_export_status_invalid', 'Choose a supported recommendation status.');
    }
    clauses.push('recommendation.status = ?');
    params.push(normalized);
  }
  const priority = text(url.searchParams.get('priority'), 20);
  if (priority) {
    if (!PRIORITIES.includes(priority as typeof PRIORITIES[number])) {
      throw new AppError(400, 'recommendation_export_priority_invalid', 'Choose high, medium, or low priority.');
    }
    clauses.push('recommendation.priority = ?');
    params.push(priority);
  }
  const code = text(url.searchParams.get('recommendationCode'), 128);
  if (code) {
    clauses.push('recommendation.recommendation_code = ?');
    params.push(code);
  }
  const overdueOnly = url.searchParams.get('overdueOnly') === 'true';
  if (overdueOnly) {
    clauses.push("recommendation.status = 'accepted'");
    clauses.push('recommendation.due_at IS NOT NULL');
    clauses.push('recommendation.due_at::timestamptz < NOW()');
  }
  const result = await env.DB.prepare(
    `${RECOMMENDATION_SELECT}
     WHERE ${clauses.join(' AND ')}
     ORDER BY recommendation.presented_at DESC, recommendation.id DESC
     LIMIT ?`,
  ).bind(...params, MAX_ROWS + 1).all<RecommendationRow>();
  const rows = result.results ?? [];
  const truncated = rows.length > MAX_ROWS;
  const recommendations = rows.slice(0, MAX_ROWS).map((row) => mapRecommendation(row));
  const format = url.searchParams.get('format') === 'json' ? 'json' : 'csv';
  const generatedAt = new Date().toISOString();
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'recommendation.evidence_exported', {
    format,
    count: recommendations.length,
    truncated,
    windowDays: window.days,
    filters: {
      status,
      priority,
      recommendationCode: code,
      overdueOnly,
      pipelineId: url.searchParams.get('pipelineId'),
      teamId: url.searchParams.get('teamId'),
      ownerId: url.searchParams.get('ownerId'),
      regionCode: url.searchParams.get('regionCode'),
    },
    causalAttribution: false,
  });
  if (format === 'json') {
    return new Response(JSON.stringify({
      generatedAt,
      window: { start: window.start.toISOString(), end: window.end.toISOString(), days: window.days },
      count: recommendations.length,
      truncated,
      semantics: {
        observationalOnly: true,
        causalAttribution: false,
        completionDoesNotProveImpact: true,
        missingEvidenceDoesNotMeanFailure: true,
      },
      recommendations,
    }, null, 2), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="dealguard-recommendation-evidence-${generatedAt.slice(0, 10)}.json"`,
        'cache-control': 'no-store',
      },
    });
  }
  return new Response(csv(recommendations), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="dealguard-recommendation-evidence-${generatedAt.slice(0, 10)}.csv"`,
      'cache-control': 'no-store',
      'x-dealguard-export-truncated': String(truncated),
    },
  });
}
