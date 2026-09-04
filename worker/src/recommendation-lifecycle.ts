import { requireEnterprisePermission, type EnterpriseAccessContext } from './enterprise-access.js';
import { AppError } from './errors.js';
import {
  ACTIVE_RECOMMENDATION_STATUSES,
  RECOMMENDATION_SELECT,
  addRecommendationEvent,
  analyticsScopeFilter,
  expirePresentedRecommendations,
  mapRecommendation,
  median,
  object,
  percentage,
  recommendationById,
  recommendationDealScope,
  recommendationScopeResource,
  text,
  type RecommendationRow,
} from './recommendation-outcome-storage.js';
import type {
  RecommendationAnalyticsResponse,
  RecommendationInstance,
  RecommendationTransition,
} from './recommendation-outcome-types.js';
import { Repository } from './repository.js';
import type { Env, RequestIdentity } from './types.js';

const AUDIT_ACTIONS: Record<RecommendationTransition, string> = {
  accept: 'recommendation.accepted',
  complete: 'recommendation.completed',
  dismiss: 'recommendation.dismissed',
};

export async function listDealRecommendations(
  env: Env,
  identity: RequestIdentity,
  dealId: string,
  url: URL,
): Promise<{ recommendations: RecommendationInstance[]; semantics: Record<string, boolean> }> {
  const scope = await recommendationDealScope(env, identity.portalId, dealId);
  await requireEnterprisePermission(env, identity, 'remediation.view', recommendationScopeResource(scope));
  await expirePresentedRecommendations(env, identity.portalId, dealId);
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') ?? 20) || 20));
  const rows = await env.DB.prepare(
    `${RECOMMENDATION_SELECT}
     WHERE recommendation.portal_id = ? AND recommendation.deal_id = ?
     ORDER BY recommendation.presented_at DESC
     LIMIT ?`,
  ).bind(identity.portalId, dealId, limit).all<RecommendationRow>();
  return {
    recommendations: (rows.results ?? []).map((row) => mapRecommendation(row)),
    semantics: {
      observationalOnly: true,
      causalAttribution: false,
      completionDoesNotProveImpact: true,
      missingEvidenceDoesNotMeanFailure: true,
    },
  };
}

export async function transitionRecommendation(
  env: Env,
  identity: RequestIdentity,
  recommendationId: string,
  transition: RecommendationTransition,
  input: unknown,
): Promise<RecommendationInstance> {
  const row = await env.DB.prepare(
    `SELECT * FROM recommendation_instances WHERE portal_id = ? AND id = ? LIMIT 1`,
  ).bind(identity.portalId, recommendationId).first<RecommendationRow>();
  if (!row) throw new AppError(404, 'recommendation_not_found', 'The recommendation does not exist.');
  const scope = await recommendationDealScope(env, identity.portalId, row.deal_id);
  await requireEnterprisePermission(env, identity, 'remediation.manage', recommendationScopeResource(scope));
  const body = object(input) ?? {};
  const now = new Date().toISOString();

  if (transition === 'accept') {
    if (row.status === 'accepted' || row.status === 'completed') {
      return (await recommendationById(env, identity.portalId, row.id))!;
    }
    if (row.status !== 'presented') {
      throw new AppError(409, 'recommendation_not_actionable', `A ${row.status} recommendation cannot be accepted.`);
    }
    const result = await env.DB.prepare(
      `UPDATE recommendation_instances
       SET status = 'accepted', accepted_at = ?, accepted_by_user_id = ?, accepted_by_email = ?, updated_at = ?
       WHERE portal_id = ? AND id = ? AND status = 'presented'`,
    ).bind(now, identity.userId, identity.userEmail, now, identity.portalId, row.id).run();
    if (Number(result.meta?.changes ?? 0) <= 0) {
      const current = await recommendationById(env, identity.portalId, row.id);
      if (current?.status === 'accepted' || current?.status === 'completed') return current;
      throw new AppError(409, 'recommendation_transition_conflict', 'The recommendation changed before it could be accepted. Refresh and try again.');
    }
    await addRecommendationEvent(env, identity.portalId, row.id, row.deal_id, 'accepted', identity, {}, now);
  } else if (transition === 'complete') {
    if (row.status === 'completed') return (await recommendationById(env, identity.portalId, row.id))!;
    if (!ACTIVE_RECOMMENDATION_STATUSES.includes(row.status)) {
      throw new AppError(409, 'recommendation_not_actionable', `A ${row.status} recommendation cannot be completed.`);
    }
    const result = await env.DB.prepare(
      `UPDATE recommendation_instances
       SET status = 'completed',
           accepted_at = COALESCE(accepted_at, ?),
           accepted_by_user_id = COALESCE(accepted_by_user_id, ?),
           accepted_by_email = COALESCE(accepted_by_email, ?),
           completed_at = ?, completed_by_user_id = ?, completed_by_email = ?, updated_at = ?
       WHERE portal_id = ? AND id = ? AND status IN ('presented', 'accepted')`,
    ).bind(
      now, identity.userId, identity.userEmail,
      now, identity.userId, identity.userEmail, now,
      identity.portalId, row.id,
    ).run();
    if (Number(result.meta?.changes ?? 0) <= 0) {
      const current = await recommendationById(env, identity.portalId, row.id);
      if (current?.status === 'completed') return current;
      throw new AppError(409, 'recommendation_transition_conflict', 'The recommendation changed before it could be completed. Refresh and try again.');
    }
    if (row.status === 'presented') {
      await addRecommendationEvent(env, identity.portalId, row.id, row.deal_id, 'accepted', identity, {
        automaticallyAcceptedOnCompletion: true,
      }, now);
    }
    await env.DB.prepare(
      `INSERT INTO recommendation_outcomes (
        recommendation_id, portal_id, deal_id, evaluation_status, created_at, updated_at
      ) VALUES (?, ?, ?, 'pending', ?, ?)
      ON CONFLICT(recommendation_id) DO NOTHING`,
    ).bind(row.id, identity.portalId, row.deal_id, now, now).run();
    await addRecommendationEvent(env, identity.portalId, row.id, row.deal_id, 'completed', identity, {
      observationStatus: 'pending_next_deal_brief',
    }, now);
  } else {
    if (row.status === 'dismissed') return (await recommendationById(env, identity.portalId, row.id))!;
    if (!ACTIVE_RECOMMENDATION_STATUSES.includes(row.status)) {
      throw new AppError(409, 'recommendation_not_actionable', `A ${row.status} recommendation cannot be dismissed.`);
    }
    const reason = text(body.reason, 1000);
    if (!reason) throw new AppError(400, 'dismissal_reason_required', 'Provide a reason for dismissing the recommendation.');
    const result = await env.DB.prepare(
      `UPDATE recommendation_instances
       SET status = 'dismissed', terminal_reason = 'user_dismissed', dismissed_at = ?,
           dismissed_by_user_id = ?, dismissed_by_email = ?, dismissal_reason = ?, updated_at = ?
       WHERE portal_id = ? AND id = ? AND status IN ('presented', 'accepted')`,
    ).bind(now, identity.userId, identity.userEmail, reason, now, identity.portalId, row.id).run();
    if (Number(result.meta?.changes ?? 0) <= 0) {
      const current = await recommendationById(env, identity.portalId, row.id);
      if (current?.status === 'dismissed') return current;
      throw new AppError(409, 'recommendation_transition_conflict', 'The recommendation changed before it could be dismissed. Refresh and try again.');
    }
    await addRecommendationEvent(env, identity.portalId, row.id, row.deal_id, 'dismissed', identity, { reason }, now);
  }

  await new Repository(env).audit(
    identity.portalId,
    identity.userId,
    identity.userEmail,
    AUDIT_ACTIONS[transition],
    {
      recommendationId: row.id,
      dealId: row.deal_id,
      recommendationCode: row.recommendation_code,
    },
  );
  return (await recommendationById(env, identity.portalId, row.id))!;
}

function scopedAnalyticsFilter(
  url: URL,
  access: EnterpriseAccessContext,
): { clauses: string[]; params: unknown[] } {
  const scoped = analyticsScopeFilter(url, access);
  if (scoped.deniedKey) {
    throw new AppError(403, 'recommendation_scope_denied', `The selected ${scoped.deniedKey} is outside your assigned scope.`);
  }
  return { clauses: scoped.clauses, params: scoped.params };
}

export async function recommendationOutcomeAnalytics(
  env: Env,
  identity: RequestIdentity,
  url: URL,
): Promise<RecommendationAnalyticsResponse> {
  const access = await requireEnterprisePermission(env, identity, 'analytics.view');
  await expirePresentedRecommendations(env, identity.portalId);
  const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days') ?? 90) || 90));
  const end = new Date();
  const start = new Date(end.getTime() - days * 86_400_000);
  const scoped = scopedAnalyticsFilter(url, access);
  const where = scoped.clauses.length > 0 ? `AND ${scoped.clauses.join(' AND ')}` : '';
  const rows = await env.DB.prepare(
    `${RECOMMENDATION_SELECT}
     WHERE recommendation.portal_id = ? AND recommendation.presented_at >= ? ${where}
     ORDER BY recommendation.presented_at DESC
     LIMIT 10000`,
  ).bind(identity.portalId, start.toISOString(), ...scoped.params).all<RecommendationRow>();
  const recommendations = (rows.results ?? []).map((row) => mapRecommendation(row));
  const accepted = recommendations.filter((item) => item.acceptedAt !== null).length;
  const completed = recommendations.filter((item) => item.completedAt !== null).length;
  const observed = recommendations
    .filter((item) => item.outcome?.observedProgress)
    .map((item) => item.outcome!);
  const acceptHours = recommendations
    .filter((item) => item.acceptedAt)
    .map((item) => (Date.parse(item.acceptedAt!) - Date.parse(item.presentedAt)) / 3_600_000)
    .filter((value) => value >= 0 && Number.isFinite(value));
  const completeHours = recommendations
    .filter((item) => item.completedAt)
    .map((item) => (Date.parse(item.completedAt!) - Date.parse(item.presentedAt)) / 3_600_000)
    .filter((value) => value >= 0 && Number.isFinite(value));
  const byCode = new Map<string, RecommendationAnalyticsResponse['byRecommendation'][number]>();
  for (const item of recommendations) {
    const current = byCode.get(item.recommendationCode) ?? {
      code: item.recommendationCode,
      label: item.label,
      presented: 0,
      accepted: 0,
      completed: 0,
      dismissed: 0,
      expired: 0,
      observed: 0,
      improved: 0,
    };
    current.presented += 1;
    if (item.acceptedAt) current.accepted += 1;
    if (item.completedAt) current.completed += 1;
    if (item.status === 'dismissed') current.dismissed += 1;
    if (item.status === 'expired') current.expired += 1;
    if (item.outcome?.observedProgress) current.observed += 1;
    if (item.outcome?.observedProgress === 'improved') current.improved += 1;
    byCode.set(item.recommendationCode, current);
  }
  const improved = observed.filter((item) => item.observedProgress === 'improved').length;
  return {
    generatedAt: end.toISOString(),
    window: { days, start: start.toISOString(), end: end.toISOString() },
    summary: {
      presented: recommendations.length,
      accepted,
      completed,
      dismissed: recommendations.filter((item) => item.status === 'dismissed').length,
      expired: recommendations.filter((item) => item.status === 'expired').length,
      superseded: recommendations.filter((item) => item.status === 'superseded').length,
      overdueAccepted: recommendations.filter((item) => item.overdue).length,
      acceptanceRatePercent: percentage(accepted, recommendations.length),
      completionRatePercent: percentage(completed, recommendations.length),
      medianHoursToAccept: median(acceptHours),
      medianHoursToComplete: median(completeHours),
    },
    observedOutcomes: {
      total: observed.length,
      improved,
      mixed: observed.filter((item) => item.observedProgress === 'mixed').length,
      unchanged: observed.filter((item) => item.observedProgress === 'unchanged').length,
      worsened: observed.filter((item) => item.observedProgress === 'worsened').length,
      insufficientEvidence: observed.filter((item) => item.observedProgress === 'insufficient_evidence').length,
      improvedSharePercent: percentage(improved, observed.length),
    },
    byRecommendation: [...byCode.values()]
      .sort((left, right) => right.presented - left.presented || right.completed - left.completed)
      .slice(0, 50),
    recent: recommendations.slice(0, 50),
    semantics: {
      observationalOnly: true,
      causalAttribution: false,
      completionDoesNotProveImpact: true,
      missingEvidenceDoesNotMeanFailure: true,
    },
  };
}
