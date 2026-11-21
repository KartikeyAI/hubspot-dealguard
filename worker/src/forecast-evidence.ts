import { canonicalAuditValue } from './audit-chain.js';
import { sha256Hex } from './crypto.js';
import { AppError } from './errors.js';
import { evidenceInstant } from './evidence-freshness.js';
import { validForecastFeatures, type ForecastArtifact } from './forecast-model.js';
import type { Env } from './types.js';

export async function forecastPolicyFingerprint(env:Env,portalId:string,policyId:string):Promise<string> {
  const row=await env.DB.prepare('SELECT id,version_number,rules_json,checksum,created_at FROM policy_versions WHERE portal_id=? AND id=?')
    .bind(portalId,policyId).first<Record<string,unknown>>();
  if(!row)throw new AppError(422,'forecast_policy_unavailable','The versioned forecast policy is unavailable.');
  return sha256Hex(canonicalAuditValue(row));
}
export type AnchorRow={deal_id:string;baseline:Record<string,unknown>|null;available:boolean;invalid_history:boolean};
export function anchorFeatures(row:AnchorRow,artifact:Pick<ForecastArtifact,'pipelineId'|'policyId'>,anchorAt:string):number[]|null {
  const b=row.baseline,stamp=evidenceInstant(b?.assessed_at),anchor=Date.parse(anchorAt);
  if(!b||!stamp||Date.parse(stamp)>anchor||Date.parse(stamp)<anchor-72*3600000||!row.available||row.invalid_history
    ||b.pipeline_id!==artifact.pipelineId||b.policy_id!==artifact.policyId||b.is_closed!==0||b.is_won!==0)return null;
  const features=[b.score,b.issue_count,b.stage_age_days===null?0:b.stage_age_days,b.stage_age_days===null?1:0];
  return validForecastFeatures(features)?features:null;
}
/** The input is retained quarter-start evidence, never the latest arbitrary snapshot. */
export async function loadForecastAnchors(env:Env,portalId:string,anchorAt:string,dealId?:string):Promise<AnchorRow[]> {
  const result=await env.DB.prepare(`WITH candidates AS (
    SELECT DISTINCT deal_id FROM assessment_history WHERE portal_id=? AND (?::text IS NULL OR deal_id=?)
      AND CASE WHEN pg_input_is_valid(assessed_at,'timestamp with time zone') THEN assessed_at::timestamptz<=?::timestamptz ELSE TRUE END
    ORDER BY deal_id LIMIT 10001)
    SELECT c.deal_id,to_jsonb(b) AS baseline,dealguard.record_was_available(?,c.deal_id,?::timestamptz) AS available,
      EXISTS(SELECT 1 FROM assessment_history h WHERE h.portal_id=? AND h.deal_id=c.deal_id
        AND NOT pg_input_is_valid(h.assessed_at,'timestamp with time zone')) AS invalid_history
    FROM candidates c LEFT JOIN LATERAL (
      SELECT assessed_at,score,issue_count,stage_age_days,pipeline_id,policy_id,is_closed,is_won,owner_id,team_id,region_code
      FROM assessment_history h WHERE h.portal_id=? AND h.deal_id=c.deal_id
        AND CASE WHEN pg_input_is_valid(h.assessed_at,'timestamp with time zone') THEN h.assessed_at::timestamptz<=?::timestamptz ELSE FALSE END
      ORDER BY CASE WHEN pg_input_is_valid(h.assessed_at,'timestamp with time zone') THEN h.assessed_at::timestamptz END DESC,h.id DESC LIMIT 1) b ON TRUE`)
    .bind(portalId,dealId??null,dealId??null,anchorAt,portalId,anchorAt,portalId,portalId,anchorAt).all<AnchorRow>();
  if((result.results?.length??0)>10000)throw new AppError(422,'forecast_cohort_capacity','The recorded cohort exceeds the bounded forecast monitor capacity.');
  return result.results??[];
}
