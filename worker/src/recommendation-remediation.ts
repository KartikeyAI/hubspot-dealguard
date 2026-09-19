import { assertRecordScope } from './record-access.js';
import { sha256Hex } from './crypto.js';
import { AppError } from './errors.js';
import { evidenceInstant } from './evidence-freshness.js';
import { requireRemediationRecord } from './remediation-access.js';
import { recommendationById } from './recommendation-outcome-storage.js';
import type { Env, RequestIdentity } from './types.js';

const WORK_ERRORS: Record<string,string> = {
  record_changed: 'The deal changed or became unavailable. Refresh before continuing.',
  not_found: 'The recommendation does not exist.',
  not_actionable: 'This recommendation is no longer actionable.',
  definition_changed: 'The recommendation changed. Review its current definition before creating work.',
  request_changed: 'This recommendation is already linked using different creation parameters.',
  reason_required: 'A dismissal reason of at most 1,000 characters is required.',
  invalid_deadline: 'The recorded recommendation deadline is invalid.',
  invalid_action: 'The work request is invalid.',
  evidence_required: 'Required evidence must be accepted before resolution.',
  acknowledgement_required: 'Acknowledge the remediation before resolving it.',
  note_required: 'A resolution or waiver note is required.',
};
export function requireWorkResult(row: {result?: unknown}|null): Record<string,unknown> {
  const result=row?.result;
  if (!result || typeof result!=='object' || Array.isArray(result)) throw new AppError(503,'work_result_unavailable','The operation could not be verified. Refresh before retrying.');
  const value=result as Record<string,unknown>;
  if (typeof value.error==='string') throw new AppError(value.error==='not_found'?404:409,`recommendation_${value.error}`,WORK_ERRORS[value.error]??'The operation could not be completed.');
  return value;
}
export function remediationLinkInput(value: unknown) {
  const v=value && typeof value==='object' && !Array.isArray(value)? value as Record<string,unknown>:{};
  if (v.confirm!==true || typeof v.ownerId!=='string' || !/^\d{1,32}$/.test(v.ownerId)
    || typeof v.expectedRevision!=='string' || !/^(0|[1-9][0-9]{0,18})$/.test(v.expectedRevision)
    || typeof v.dueAt!=='string' || evidenceInstant(v.dueAt)===null) {
    throw new AppError(400,'remediation_confirmation_required','Confirm the reviewed recommendation, a HubSpot owner ID, and an explicit ISO deadline with timezone.');
  }
  return {ownerId:v.ownerId,dueAt:new Date(evidenceInstant(v.dueAt)!).toISOString(),expectedRevision:v.expectedRevision};
}
export async function createRecommendationRemediation(env:Env,identity:RequestIdentity,id:string,value:unknown) {
  const input=remediationLinkInput(value);
  const item=await recommendationById(env,identity.portalId,id);
  if(!item) throw new AppError(404,'recommendation_not_found','The recommendation does not exist.');
  const access=await requireRemediationRecord(env,identity,item.dealId);
  assertRecordScope(access.context,item.baseline);
  const fingerprint=await sha256Hex(JSON.stringify({recommendationId:id,...input}));
  const result=requireWorkResult(await env.DB.prepare('SELECT dealguard.link_recommendation_remediation(?,?,?,?,?,?,?,?,?,?) AS result')
    .bind(identity.portalId,item.dealId,id,access.assessmentAt,input.expectedRevision,input.ownerId,input.dueAt,fingerprint,identity.userId,identity.userEmail)
    .first<{result:unknown}>());
  await requireRemediationRecord(env,identity,item.dealId);
  return {...result,recommendation:await recommendationById(env,identity.portalId,id),
    semantics:{createsHubSpotTask:false,sendsImmediateNotification:false,completionDoesNotResolveCase:true,causalAttribution:false}};
}
