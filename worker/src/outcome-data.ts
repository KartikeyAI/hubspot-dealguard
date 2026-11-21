import { canonicalAuditValue } from './audit-chain.js';
import { sha256Hex } from './crypto.js';
import { AppError } from './errors.js';
import { forecastPolicyFingerprint } from './forecast-evidence.js';
import { buildOutcomeCohort,quarterWindow,type OutcomeDataset } from './outcome-cohort.js';
import { requireIntelligenceAdministrator,requireIntelligenceConsent } from './intelligence-consent.js';
import type { Env,RequestIdentity } from './types.js';
export async function buildOutcomeDataset(env:Env,identity:RequestIdentity,input:Record<string,unknown>):Promise<{id:string;fingerprint:string;manifest:OutcomeDataset['manifest'];predictionsEnabled:false}>{
  await requireIntelligenceAdministrator(env,identity);
  const consent=await requireIntelligenceConsent(env,identity.portalId,'outcomes');
  if(typeof input.pipelineId!=='string'||!input.pipelineId||input.pipelineId.length>128||typeof input.policyId!=='string'||!input.policyId||input.policyId.length>128)
    throw new AppError(400,'outcome_cohort_required','An exact pipeline and versioned policy are required.');
  const quarter=String(input.quarter??''),window=quarterWindow(quarter);
  const policy=await env.DB.prepare('SELECT created_at FROM policy_versions WHERE portal_id=? AND id=?').bind(identity.portalId,input.policyId).first<{created_at:string}>();
  const result=await env.DB.prepare(`WITH candidates AS (
    SELECT DISTINCT deal_id FROM assessment_history WHERE portal_id=? AND
      (NOT pg_input_is_valid(assessed_at,'timestamp with time zone') OR
       CASE WHEN pg_input_is_valid(assessed_at,'timestamp with time zone') THEN assessed_at::timestamptz<=?::timestamptz ELSE TRUE END)
    ORDER BY deal_id LIMIT 10001)
    SELECT c.deal_id,to_jsonb(b) AS baseline,to_jsonb(l) AS label,
    EXISTS(SELECT 1 FROM assessment_history h WHERE h.portal_id=? AND h.deal_id=c.deal_id
      AND NOT pg_input_is_valid(h.assessed_at,'timestamp with time zone')) AS invalid_history,
    dealguard.record_was_available(?,c.deal_id,?::timestamptz) AS baseline_available,
    dealguard.record_was_available(?,c.deal_id,?::timestamptz) AS label_available
    FROM candidates c LEFT JOIN LATERAL (
      SELECT assessed_at,score,issue_count,stage_age_days,pipeline_id,policy_id,is_closed,is_won FROM assessment_history h
      WHERE h.portal_id=? AND h.deal_id=c.deal_id AND
        CASE WHEN pg_input_is_valid(h.assessed_at,'timestamp with time zone') THEN h.assessed_at::timestamptz<=?::timestamptz ELSE FALSE END
      ORDER BY CASE WHEN pg_input_is_valid(h.assessed_at,'timestamp with time zone') THEN h.assessed_at::timestamptz END DESC,h.id DESC LIMIT 1) b ON TRUE
    LEFT JOIN LATERAL (
      SELECT assessed_at,pipeline_id,policy_id,is_closed,is_won FROM assessment_history h
      WHERE h.portal_id=? AND h.deal_id=c.deal_id AND
        CASE WHEN pg_input_is_valid(h.assessed_at,'timestamp with time zone') THEN h.assessed_at::timestamptz<?::timestamptz ELSE FALSE END
      ORDER BY CASE WHEN pg_input_is_valid(h.assessed_at,'timestamp with time zone') THEN h.assessed_at::timestamptz END DESC,h.id DESC LIMIT 1) l ON TRUE`)
    .bind(identity.portalId,window.anchor,identity.portalId,identity.portalId,window.anchor,identity.portalId,window.horizon,
      identity.portalId,window.anchor,identity.portalId,window.horizon).all<Record<string,unknown>>();
  const dataset=buildOutcomeCohort(result.results??[],quarter,input.pipelineId,input.policyId,policy?.created_at);
  dataset.manifest.policyFingerprint=await forecastPolicyFingerprint(env,identity.portalId,input.policyId);
  const fingerprint=await sha256Hex(canonicalAuditValue(dataset));
  await requireIntelligenceAdministrator(env,identity);
  const saved=await env.DB.prepare('SELECT dealguard.store_outcome_dataset(?,?,?,?,?::jsonb,?::jsonb) AS id')
    .bind(identity.portalId,consent.revision,crypto.randomUUID(),fingerprint,JSON.stringify(dataset.manifest),JSON.stringify(dataset.samples)).first<{id:string|null}>();
  if(!saved?.id)throw new AppError(409,'outcome_consent_changed','Consent changed before the dataset was saved.');
  return {id:saved.id,fingerprint,manifest:dataset.manifest,predictionsEnabled:false};
}
export async function listOutcomeDatasets(env:Env,identity:RequestIdentity):Promise<unknown[]>{
  await requireIntelligenceAdministrator(env,identity);const c=await requireIntelligenceConsent(env,identity.portalId,'outcomes');
  const result=await env.DB.prepare(`SELECT id,fingerprint,manifest,created_at,expires_at FROM dealguard.outcome_datasets
    WHERE portal_id=? AND consent_revision=? AND expires_at>NOW() ORDER BY created_at DESC,id LIMIT 100`)
    .bind(identity.portalId,c.revision).all<Record<string,unknown>>();
  await requireIntelligenceConsent(env,identity.portalId,'outcomes',c.revision);return result.results??[];
}
