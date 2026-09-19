import { assertRecordScope } from './record-access.js';
import { requireRemediationRecord } from './remediation-access.js';
import { requireWorkResult } from './recommendation-remediation.js';
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


export async function listDealRecommendations(
  env: Env,
  identity: RequestIdentity,
  dealId: string,
  url: URL,
): Promise<{ recommendations: RecommendationInstance[]; semantics: Record<string, boolean> }> {
  const access=await requireRemediationRecord(env, identity, dealId, 'remediation.view');
  await expirePresentedRecommendations(env, identity.portalId, dealId);
  const values=url.searchParams.getAll('limit');
  if(values.length>1 || (values[0] && !/^[1-9][0-9]?$/.test(values[0])) || Number(values[0]??20)>50) throw new AppError(400,'recommendation_limit_invalid','Choose a limit from 1 to 50.');
  const limit=Number(values[0]??20);
  const clauses:string[]=[],params:unknown[]=[];
  for(const [allowed,column] of [[access.context.scope.pipelineIds,'baseline_pipeline_id'],[access.context.scope.ownerIds,'baseline_owner_id'],
    [access.context.scope.teamIds,'baseline_team_id'],[access.context.scope.regionCodes,'baseline_region_code']] as Array<[string[],string]>) {
    if(allowed.length){clauses.push(`recommendation.${column} IN (${allowed.map(()=>'?').join(',')})`);params.push(...allowed);}
  }
  const rows = await env.DB.prepare(
    `${RECOMMENDATION_SELECT}
     WHERE recommendation.portal_id = ? AND recommendation.deal_id = ? AND ${clauses.join(' AND ')||'TRUE'}
     ORDER BY recommendation.presented_at DESC
     LIMIT ?`,
  ).bind(identity.portalId, dealId, ...params, limit).all<RecommendationRow>();
  await requireRemediationRecord(env,identity,dealId,'remediation.view');
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
  env: Env, identity: RequestIdentity, recommendationId: string,
  transition: RecommendationTransition, input: unknown,
): Promise<RecommendationInstance> {
  const row = await env.DB.prepare('SELECT * FROM recommendation_instances WHERE portal_id=? AND id=?')
    .bind(identity.portalId,recommendationId).first<RecommendationRow>();
  if(!row) throw new AppError(404,'recommendation_not_found','The recommendation does not exist.');
  const access=await requireRemediationRecord(env,identity,row.deal_id);
  assertRecordScope(access.context,{pipelineId:row.baseline_pipeline_id,ownerId:row.baseline_owner_id,teamId:row.baseline_team_id,regionCode:row.baseline_region_code});
  const body=object(input)??{};
  if(transition==='dismiss' && (typeof body.reason!=='string' || !body.reason.trim() || body.reason.length>1000))
    throw new AppError(400,'dismissal_reason_required','Provide a dismissal reason of at most 1,000 characters.');
  requireWorkResult(await env.DB.prepare('SELECT dealguard.transition_recommendation_work(?,?,?,?,?,?,?,?) AS result')
    .bind(identity.portalId,row.deal_id,row.id,access.assessmentAt,transition,identity.userId,identity.userEmail,
      transition==='dismiss'?(body.reason as string).trim():null).first<{result:unknown}>());
  await requireRemediationRecord(env,identity,row.deal_id);
  return (await recommendationById(env,identity.portalId,row.id))!;
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
