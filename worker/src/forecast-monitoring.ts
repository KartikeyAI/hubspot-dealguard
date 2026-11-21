import { canonicalAuditValue } from './audit-chain.js';
import { requireCommercialTier } from './billing.js';
import { sha256Hex } from './crypto.js';
import { evidenceInstant } from './evidence-freshness.js';
import { anchorFeatures,loadForecastAnchors } from './forecast-evidence.js';
import { activeForecastQuarter,featureProfile,forecastDrift,forecastOutcomeReport,FORECAST_MONITOR_MS,type ForecastArtifact } from './forecast-model.js';
import { verifyForecastModel,type ForecastModelRow } from './forecast-service.js';
import { requireIntelligenceConsent } from './intelligence-consent.js';
import type { Env } from './types.js';

/** Bounded retained-data batch. No CRM/provider calls and no training on interactive requests. */
export async function refreshForecastMonitoring(env:Env,limit=1):Promise<{processed:number}> {
 let processed=0;
 for(let i=0;i<Math.min(2,Math.max(0,limit));i++){
  const token=crypto.randomUUID();
  const model=await env.DB.prepare(`UPDATE dealguard.forecast_models m SET monitor_lease=?,monitor_lease_expires_at=NOW()+INTERVAL '5 minutes'
   WHERE (portal_id,id)=(SELECT portal_id,id FROM dealguard.forecast_models WHERE state IN ('pending','active') AND expires_at>NOW()
   AND (monitor_lease_expires_at IS NULL OR monitor_lease_expires_at<=NOW())
   AND (monitor_checked_at IS NULL OR monitor_checked_at<NOW()-INTERVAL '12 hours')
   ORDER BY monitor_checked_at NULLS FIRST,requested_at,portal_id,id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING m.*`)
   .bind(token).first<ForecastModelRow>();
  if(!model)break;
  const window=activeForecastQuarter();let status='unavailable';let report:Record<string,unknown>={schema:'dealguard-forecast-drift-v1',status,reason:'evidence_unavailable'};
  try{
   await requireCommercialTier(env,model.portal_id,'enterprise');await requireIntelligenceConsent(env,model.portal_id,'outcomes',model.consent_revision);
   const artifact=await verifyForecastModel(env,model),rows=await loadForecastAnchors(env,model.portal_id,window.anchorAt);
   const cohort=rows.filter(row=>row.baseline?.pipeline_id===artifact.pipelineId);
   const valid=cohort.map(row=>anchorFeatures(row,artifact,window.anchorAt)).filter((features):features is number[]=>features!==null);
   report=forecastDrift(featureProfile(valid.map(features=>({features})),artifact.parameters),artifact.trainingProfile,cohort.length-valid.length,cohort.length);
   status=String(report.status);
   report={...report,quarter:window.quarter,anchorAt:window.anchorAt,modelFingerprint:model.artifact_fingerprint,
    cohortFingerprint:await sha256Hex(canonicalAuditValue(cohort)),unknownPipelineObservations:rows.filter(row=>!row.baseline?.pipeline_id).length};
  }catch{/* Store a sanitized unavailable result. No raw customer/provider/database error is retained. */}
  // The lease, model state and consent revision must still match when the result lands.
  await env.DB.prepare(`WITH accepted AS (
   UPDATE dealguard.forecast_models m SET monitor_checked_at=NOW(),monitor_lease=NULL,monitor_lease_expires_at=NULL,
    state=CASE WHEN ?<>'eligible' AND state='active' THEN 'suspended' ELSE state END,
    suspension_reason=CASE WHEN ?<>'eligible' AND state='active' THEN 'monitoring_evidence_failed' ELSE suspension_reason END
   WHERE portal_id=? AND id=? AND monitor_lease=? AND monitor_lease_expires_at>NOW() AND state IN ('pending','active')
    AND EXISTS(SELECT 1 FROM dealguard.intelligence_consents c WHERE c.portal_id=m.portal_id AND c.capability='outcomes' AND c.enabled AND c.revision=m.consent_revision)
   RETURNING portal_id,id)
   INSERT INTO dealguard.forecast_monitors(portal_id,model_id,quarter,status,report,checked_at,expires_at)
   SELECT portal_id,id,?,?,?::jsonb,NOW(),?::timestamptz FROM accepted
   ON CONFLICT(portal_id,model_id,quarter)DO UPDATE SET status=excluded.status,report=excluded.report,checked_at=excluded.checked_at,expires_at=excluded.expires_at`)
   .bind(status,status,model.portal_id,model.id,token,window.quarter,status,JSON.stringify(report),new Date(Date.now()+FORECAST_MONITOR_MS).toISOString()).run();
  processed++;
 }
 return {processed};
}

/** Mature forecasts are observed independently of opening deals. Missing labels stay excluded. */
export async function observeForecastOutcomes(env:Env,limit=1):Promise<{processed:number}> {
 const groups=await env.DB.prepare(`SELECT p.portal_id,p.model_id,p.quarter,MIN(p.anchor_at) AS anchor_at,MAX(p.horizon_at) AS horizon_at,
   m.artifact,m.artifact_fingerprint,m.consent_revision,m.pipeline_id,m.policy_id,m.id,m.state,m.requested_by,m.evaluation_requested_by,m.reviewed_by,m.expires_at
   FROM dealguard.forecast_predictions p JOIN dealguard.forecast_models m ON m.portal_id=p.portal_id AND m.id=p.model_id
   WHERE p.horizon_at<NOW()-INTERVAL '7 days' AND NOT EXISTS(SELECT 1 FROM dealguard.forecast_outcome_reports r
    WHERE r.portal_id=p.portal_id AND r.model_id=p.model_id AND r.quarter=p.quarter)
    AND EXISTS(SELECT 1 FROM dealguard.intelligence_consents c WHERE c.portal_id=p.portal_id AND c.capability='outcomes' AND c.enabled AND c.revision=p.consent_revision)
   GROUP BY p.portal_id,p.model_id,p.quarter,m.portal_id,m.id ORDER BY MAX(p.horizon_at),p.portal_id,p.model_id LIMIT ?`)
  .bind(Math.min(2,Math.max(0,limit))).all<ForecastModelRow&{model_id:string;quarter:string;horizon_at:string;anchor_at:string}>();
 let processed=0;
 for(const group of groups.results??[]){
  let artifact:ForecastArtifact;
  try{await requireCommercialTier(env,group.portal_id,'enterprise');artifact=await verifyForecastModel(env,group);
   await requireIntelligenceConsent(env,group.portal_id,'outcomes',group.consent_revision);}catch{continue;}
  const rows=await env.DB.prepare(`SELECT p.deal_id,p.probability,to_jsonb(h) AS label,
    dealguard.record_was_available(p.portal_id,p.deal_id,p.horizon_at) AS available
    FROM dealguard.forecast_predictions p LEFT JOIN LATERAL(
     SELECT assessed_at,pipeline_id,policy_id,is_closed,is_won FROM assessment_history h WHERE h.portal_id=p.portal_id AND h.deal_id=p.deal_id
      AND CASE WHEN pg_input_is_valid(h.assessed_at,'timestamp with time zone') THEN h.assessed_at::timestamptz<p.horizon_at ELSE FALSE END
     ORDER BY CASE WHEN pg_input_is_valid(h.assessed_at,'timestamp with time zone') THEN h.assessed_at::timestamptz END DESC,h.id DESC LIMIT 1) h ON TRUE
    WHERE p.portal_id=? AND p.model_id=? AND p.quarter=? ORDER BY p.deal_id LIMIT 10001`)
    .bind(group.portal_id,group.model_id,group.quarter).all<{deal_id:string;probability:number;label:Record<string,unknown>|null;available:boolean}>();
  const labels:number[]=[],probabilities:number[]=[],evidence:unknown[]=[];const candidates=rows.results??[],horizon=new Date(group.horizon_at).getTime();
  if(candidates.length<=10000)for(const row of candidates){const l=row.label,at=evidenceInstant(l?.assessed_at);
   if(!l||!row.available||!at||Date.parse(at)<horizon-72*3600000||Date.parse(at)>=horizon||l.pipeline_id!==artifact.pipelineId||l.policy_id!==artifact.policyId
     ||![0,1].includes(l.is_closed as number)||![0,1].includes(l.is_won as number)||(l.is_closed===0&&l.is_won===1))continue;
   labels.push(l.is_closed===1&&l.is_won===1?1:0);probabilities.push(row.probability);evidence.push({dealId:row.deal_id,labelAt:at,label:labels.at(-1),probability:row.probability});
  }
  const report={...forecastOutcomeReport(labels,probabilities,artifact.baselineProbability,candidates.length),quarter:group.quarter,
   target:artifact.target,modelFingerprint:group.artifact_fingerprint,labelEvidenceFingerprint:await sha256Hex(canonicalAuditValue(evidence)),
   capacityExceeded:candidates.length>10000,interpretation:'Retained observational outcomes; absent or stale labels are excluded, never treated as losses.'};
  await env.DB.prepare(`INSERT INTO dealguard.forecast_outcome_reports(portal_id,model_id,quarter,report)
    SELECT ?,?,?,?::jsonb WHERE EXISTS(SELECT 1 FROM dealguard.intelligence_consents WHERE portal_id=? AND capability='outcomes' AND enabled AND revision=?)
    AND EXISTS(SELECT 1 FROM dealguard.forecast_models WHERE portal_id=? AND id=? AND artifact_fingerprint=?)
    ON CONFLICT DO NOTHING`).bind(group.portal_id,group.model_id,group.quarter,JSON.stringify(report),group.portal_id,group.consent_revision,group.portal_id,group.model_id,group.artifact_fingerprint).run();
  if(report.status==='drifted')await env.DB.prepare(`UPDATE dealguard.forecast_models SET state='suspended',suspension_reason='mature_outcome_drift'
    WHERE portal_id=? AND id=? AND state='active' AND artifact_fingerprint=?`).bind(group.portal_id,group.model_id,group.artifact_fingerprint).run();
  processed++;
 }
 return {processed};
}
export async function cleanupForecastEvidence(env:Env):Promise<void>{
 await env.DB.prepare(`UPDATE dealguard.forecast_models SET state='suspended',suspension_reason='expired'
   WHERE state IN ('pending','active') AND expires_at<=NOW()`).run();
 await env.DB.prepare(`DELETE FROM dealguard.forecast_cache c WHERE expires_at<=NOW()
   AND NOT EXISTS(SELECT 1 FROM legal_holds WHERE portal_id=c.portal_id AND status='active')`).run();
 await env.DB.prepare(`DELETE FROM dealguard.forecast_models m WHERE expires_at<NOW()-INTERVAL '180 days'
   AND NOT EXISTS(SELECT 1 FROM legal_holds WHERE portal_id=m.portal_id AND status='active')`).run();
 await env.DB.prepare(`DELETE FROM dealguard.outcome_evaluation_jobs j WHERE state NOT IN ('queued','running') AND created_at<NOW()-INTERVAL '180 days'
   AND NOT EXISTS(SELECT 1 FROM legal_holds WHERE portal_id=j.portal_id AND status='active')`).run();
}
