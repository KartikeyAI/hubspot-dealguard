import { canonicalAuditValue } from './audit-chain.js';
import { requireCommercialTier } from './billing.js';
import { sha256Hex } from './crypto.js';
import { requireEnterprisePermission } from './enterprise-access.js';
import { AppError } from './errors.js';
import { assessmentFreshness } from './evidence-freshness.js';
import { anchorFeatures,forecastPolicyFingerprint,loadForecastAnchors } from './forecast-evidence.js';
import { activeForecastQuarter,forecastWindow,FORECAST_SCHEMA,FORECAST_TARGET,validateForecastArtifact,type ForecastArtifact } from './forecast-model.js';
import { getIntelligenceConsent,requireIntelligenceAdministrator,requireIntelligenceConsent } from './intelligence-consent.js';
import { logisticProbability } from './outcome-evaluation.js';
import { assertRecordScope,authorizeRecordedDeal,requireRecordActor } from './record-access.js';
import type { Env,RequestIdentity } from './types.js';

export type ForecastModelRow={id:string;portal_id:string;artifact:ForecastArtifact;artifact_fingerprint:string;consent_revision:number;state:string;
 pipeline_id:string;policy_id:string;requested_by:string;evaluation_requested_by:string;reviewed_by:string|null;expires_at:string;monitor_lease?:string};
function object(v:unknown):Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v))throw new AppError(400,'forecast_input_invalid','Use a JSON object.');return v as Record<string,unknown>;}
function exactKeys(v:Record<string,unknown>,keys:string[]):void{if(Object.keys(v).some(k=>!keys.includes(k)))throw new AppError(400,'forecast_input_invalid','The request contains unsupported fields.');}
export function forecastGloballyEnabled(env:Env):boolean{return (env as Env&{DEALGUARD_FORECAST_ENABLED?:string}).DEALGUARD_FORECAST_ENABLED==='true';}
async function assignedActor(env:Env,identity:RequestIdentity,review=false):Promise<void>{
 if(!identity.userId||!/^\d{1,32}$/.test(identity.userId))throw new AppError(403,'forecast_identified_actor_required','An assigned stable HubSpot user ID is required.');
 const row=await env.DB.prepare('SELECT dealguard.forecast_actor_authorized(?,?,?) AS allowed').bind(identity.portalId,identity.userId,review).first<{allowed:boolean}>();
 if(!row?.allowed)throw new AppError(403,'forecast_assigned_role_required','Forecast administration requires an explicitly assigned portal-wide administrator; approval also permits an assigned reviewer with forecast.approve.');
}
export async function verifyForecastModel(env:Env,model:ForecastModelRow):Promise<ForecastArtifact>{
 validateForecastArtifact(model.artifact);
 if(await sha256Hex(canonicalAuditValue(model.artifact))!==model.artifact_fingerprint
   ||await sha256Hex(canonicalAuditValue({report:model.artifact.report,parameters:model.artifact.parameters,datasetFingerprints:model.artifact.datasetFingerprints}))!==model.artifact.evaluationFingerprint
   ||model.artifact.pipelineId!==model.pipeline_id||model.artifact.policyId!==model.policy_id||model.artifact.consentRevision!==model.consent_revision
   ||await forecastPolicyFingerprint(env,model.portal_id,model.policy_id)!==model.artifact.policyFingerprint)
   throw new AppError(422,'forecast_artifact_changed','Model or policy evidence no longer matches the approved artifact.');
 return model.artifact;
}
export async function forecastStatus(env:Env,identity:RequestIdentity):Promise<Record<string,unknown>>{
 await requireRecordActor(env,identity,'analytics.view');await assignedActor(env,identity,true);
 const c=await env.DB.prepare('SELECT enabled,revision FROM dealguard.forecast_controls WHERE portal_id=?').bind(identity.portalId).first<{enabled:boolean;revision:number}>();
 const quarter=activeForecastQuarter();
 const consent=await getIntelligenceConsent(env,identity.portalId,'outcomes');
 const unavailable=()=>({globalEnabled:forecastGloballyEnabled(env),controls:c??{enabled:false,revision:0},models:[],outcomeReports:[],quarter:quarter.quarter,
   predictionsEnabled:false,target:FORECAST_TARGET,estimateOrigin:'quarter_start',
   reviewBoundary:'Current outcome consent and Enterprise access are required to inspect retained model or outcome evidence. Disabling remains available.'});
 if(!consent.enabled)return unavailable();
 try{await requireCommercialTier(env,identity.portalId,'enterprise');}catch{return unavailable();}
 const result=await env.DB.prepare(`SELECT m.id,m.state,m.pipeline_id,m.policy_id,m.expires_at,m.artifact_fingerprint,m.requested_by,m.reviewed_by,m.suspension_reason,
   f.status AS monitor_status,f.checked_at,f.expires_at AS monitor_expires_at,f.report AS monitor_report,
   m.artifact->'report' AS evaluation_report,m.artifact->>'evaluationId' AS evaluation_id,
   dealguard.forecast_actor_authorized(m.portal_id,m.reviewed_by,TRUE) AS reviewer_authorized
   FROM dealguard.forecast_models m LEFT JOIN dealguard.forecast_monitors f ON f.portal_id=m.portal_id AND f.model_id=m.id AND f.quarter=?
   WHERE m.portal_id=? AND m.consent_revision=? ORDER BY m.requested_at DESC,m.id LIMIT 100`).bind(quarter.quarter,identity.portalId,consent.revision).all<Record<string,unknown>>();
 const outcomes=await env.DB.prepare(`SELECT r.model_id,r.quarter,r.report,r.observed_at FROM dealguard.forecast_outcome_reports r
   JOIN dealguard.forecast_models m ON m.portal_id=r.portal_id AND m.id=r.model_id WHERE r.portal_id=? AND m.consent_revision=? ORDER BY r.observed_at DESC LIMIT 100`)
   .bind(identity.portalId,consent.revision).all<Record<string,unknown>>();
 await requireRecordActor(env,identity,'analytics.view');await assignedActor(env,identity,true);
 const finalConsent=await getIntelligenceConsent(env,identity.portalId,'outcomes');
 if(!finalConsent.enabled||finalConsent.revision!==consent.revision)return unavailable();
 try{await requireCommercialTier(env,identity.portalId,'enterprise');}catch{return unavailable();}
 const models=(result.results??[]).map(m=>({id:m.id,state:m.state,pipelineId:m.pipeline_id,policyId:m.policy_id,expiresAt:m.expires_at,artifactFingerprint:m.artifact_fingerprint,
   requestedBy:m.requested_by,reviewedBy:m.reviewed_by,suspensionReason:m.suspension_reason,evaluationId:m.evaluation_id,evaluationReport:m.evaluation_report,
   reviewerAuthorized:m.reviewer_authorized,monitor:m.monitor_status?{status:m.monitor_status,checkedAt:m.checked_at,expiresAt:m.monitor_expires_at,report:m.monitor_report}:null}));
 const now=Date.now();const ready=models.some(m=>m.state==='active'&&m.reviewerAuthorized&&Date.parse(String(m.expiresAt))>now&&m.monitor?.status==='eligible'&&Date.parse(String(m.monitor.expiresAt))>now);
 return {globalEnabled:forecastGloballyEnabled(env),controls:c??{enabled:false,revision:0},models,outcomeReports:outcomes.results??[],quarter:quarter.quarter,
   predictionsEnabled:forecastGloballyEnabled(env)&&!!c?.enabled&&ready,
   target:FORECAST_TARGET,estimateOrigin:'quarter_start',reviewBoundary:'A report digest records a named reviewer’s attestation. It does not establish the truth of the report or confer production release approval.'};
}
export async function changeForecastControls(env:Env,identity:RequestIdentity,value:unknown):Promise<Record<string,unknown>>{
 const i=object(value);exactKeys(i,['enabled','revision','confirmation']);
 if(typeof i.enabled!=='boolean'||!Number.isSafeInteger(i.revision)||Number(i.revision)<0||i.confirmation!==(i.enabled?'ENABLE_FORECASTS':'DISABLE_FORECASTS'))
   throw new AppError(400,'forecast_confirmation_required','Provide the current revision and exact forecast enable/disable confirmation.');
 await requireIntelligenceAdministrator(env,identity,i.enabled);await assignedActor(env,identity);
 if(i.enabled)await requireIntelligenceConsent(env,identity.portalId,'outcomes');
 const row=await env.DB.prepare('SELECT dealguard.change_forecast_controls(?,?,?,?) AS controls').bind(identity.portalId,identity.userId,i.revision,i.enabled).first<{controls:unknown}>();
 if(!row?.controls)throw new AppError(409,'forecast_controls_changed','Consent, permissions or controls changed. Reload before retrying.');
 return forecastStatus(env,identity);
}
export async function registerForecastModel(env:Env,identity:RequestIdentity,value:unknown):Promise<Record<string,unknown>>{
 const i=object(value);exactKeys(i,['evaluationId','expiresAt','confirmation']);
 if(typeof i.evaluationId!=='string'||!i.evaluationId||i.evaluationId.length>128||typeof i.expiresAt!=='string'||!Number.isFinite(Date.parse(i.expiresAt))
   ||i.confirmation!=='REGISTER_FORECAST_CANDIDATE')throw new AppError(400,'forecast_candidate_invalid','Provide an evaluation ID, expiry and exact registration confirmation.');
 await requireIntelligenceAdministrator(env,identity);await assignedActor(env,identity);const consent=await requireIntelligenceConsent(env,identity.portalId,'outcomes');
 const row=await env.DB.prepare(`SELECT result_artifact,result_fingerprint,updated_at FROM dealguard.outcome_evaluation_jobs WHERE portal_id=? AND evaluation_id=?
   AND state='completed' AND consent_revision=?`).bind(identity.portalId,i.evaluationId,consent.revision).first<{result_artifact:unknown;result_fingerprint:string;updated_at:string}>();
 if(!row)throw new AppError(404,'forecast_evaluation_unavailable','A completed controlled evaluation is required.');
 validateForecastArtifact(row.result_artifact);const artifact=row.result_artifact;
 const holdoutEnd=Date.parse(forecastWindow(artifact.quarters[2]!).horizonAt);
 if(holdoutEnd>Date.parse(activeForecastQuarter().anchorAt)||Date.now()-holdoutEnd>180*86400000)
   throw new AppError(422,'forecast_evaluation_stale','The holdout must precede the current quarter and end within the past one hundred eighty days.');
 if(await sha256Hex(canonicalAuditValue(artifact))!==row.result_fingerprint||await forecastPolicyFingerprint(env,identity.portalId,artifact.policyId)!==artifact.policyFingerprint)
   throw new AppError(422,'forecast_evaluation_changed','Evaluation integrity or the policy binding failed.');
 const expiry=new Date(Date.parse(i.expiresAt)).toISOString(),id=crypto.randomUUID();
 await requireIntelligenceAdministrator(env,identity);
 const result=await env.DB.prepare('SELECT dealguard.register_forecast_model(?,?,?,?,?::jsonb,?,?::timestamptz) AS accepted')
   .bind(identity.portalId,identity.userId,id,i.evaluationId,JSON.stringify(artifact),row.result_fingerprint,expiry).first<{accepted:boolean}>();
 if(!result?.accepted)throw new AppError(409,'forecast_registration_denied','Registration requires a recent qualified evaluation, unchanged consent and an expiry within thirty days and dataset retention. Check for an existing pending candidate or an exhausted daily candidate allowance.');
 return {id,state:'pending',artifactFingerprint:row.result_fingerprint,expiresAt:expiry,predictionsEnabled:false,
   nextStep:'Wait for current-quarter monitoring, then obtain a distinct authorized reviewer’s evidence-bound approval.'};
}
export async function reviewForecastModel(env:Env,identity:RequestIdentity,value:unknown):Promise<Record<string,unknown>>{
 const i=object(value);exactKeys(i,['modelId','artifactFingerprint','decision','evidenceSha256','confirmation']);
 if(typeof i.modelId!=='string'||!i.modelId||i.modelId.length>128||typeof i.artifactFingerprint!=='string'||!/^([a-f0-9]{64})$/.test(i.artifactFingerprint)
   ||!['approve','reject'].includes(String(i.decision))||typeof i.evidenceSha256!=='string'||!/^[a-f0-9]{64}$/.test(i.evidenceSha256)
   ||i.confirmation!==(i.decision==='approve'?'APPROVE_FORECAST':'REJECT_FORECAST'))throw new AppError(400,'forecast_review_invalid','Provide the exact model fingerprint, independent review digest, decision and confirmation.');
 await requireRecordActor(env,identity,'analytics.view');await requireCommercialTier(env,identity.portalId,'enterprise');
 await requireEnterprisePermission(env,identity,'forecast.approve');await assignedActor(env,identity,true);
 await requireIntelligenceConsent(env,identity.portalId,'outcomes');
 const model=await env.DB.prepare('SELECT * FROM dealguard.forecast_models WHERE portal_id=? AND id=?').bind(identity.portalId,i.modelId).first<ForecastModelRow>();
 if(!model)throw new AppError(404,'forecast_model_unavailable','The candidate model is unavailable.');
 await verifyForecastModel(env,model);
 const result=await env.DB.prepare('SELECT dealguard.review_forecast_model(?,?,?,?,?,?,?) AS accepted')
   .bind(identity.portalId,identity.userId,i.modelId,i.artifactFingerprint,i.decision==='approve',i.evidenceSha256,activeForecastQuarter().quarter).first<{accepted:boolean}>();
 if(!result?.accepted)throw new AppError(409,'forecast_review_denied','The reviewer must differ from both requesters; consent, artifact, expiry and current monitoring must still match.');
 return {id:i.modelId,state:i.decision==='approve'?'active':'rejected',predictionsEnabled:false,
   message:'Approval does not enable the global or tenant forecast switch and is not production release sign-off.'};
}

const LIMITATIONS=[
 'This estimate uses retained quarter-start evidence. It is not a newly trained probability based on today’s deal state.',
 'The target is a recorded closed-won state near quarter end; missing later observations are not losses.',
 'Calibration intervals describe historical outcome rates in a probability bin, not a confidence interval for this individual deal.',
 'Readiness, management priority and observed business outcomes remain separate. No causal revenue or expected-loss claim is made.'
];
type Eligible={model:ForecastModelRow;artifact:ForecastArtifact;controls:{enabled:boolean;revision:number};consentRevision:number;
 features:number[];sourceFingerprint:string;assessmentAt:string;evidenceAt:string;window:ReturnType<typeof activeForecastQuarter>};
async function eligibility(env:Env,identity:RequestIdentity,dealId:string):Promise<Eligible|string>{
 await requireCommercialTier(env,identity.portalId,'enterprise');
 const access=await authorizeRecordedDeal(env,identity,dealId);
 if(!access.assessmentAt)return 'record_unavailable';
 if(!forecastGloballyEnabled(env))return 'globally_disabled';
 const consent=await requireIntelligenceConsent(env,identity.portalId,'outcomes');
 const controls=await env.DB.prepare('SELECT enabled,revision FROM dealguard.forecast_controls WHERE portal_id=?').bind(identity.portalId).first<{enabled:boolean;revision:number}>();
 if(!controls?.enabled)return 'tenant_disabled';
 const current=await env.DB.prepare(`SELECT a.is_closed,a.is_won,a.assessed_at,h.pipeline_id,h.policy_id FROM deal_assessments a
   LEFT JOIN LATERAL(SELECT pipeline_id,policy_id FROM assessment_history WHERE portal_id=a.portal_id AND deal_id=a.deal_id
   AND assessed_at=a.assessed_at ORDER BY id DESC LIMIT 1)h ON TRUE
   WHERE a.portal_id=? AND a.deal_id=? AND dealguard.record_is_available(a.portal_id,a.deal_id)`).bind(identity.portalId,dealId)
   .first<{is_closed:number;is_won:number;assessed_at:string;pipeline_id:string|null;policy_id:string|null}>();
 if(!current||current.assessed_at!==access.assessmentAt)return 'record_changed';
 if(current.is_closed!==0||current.is_won!==0)return 'outcome_already_observed';
 if(!['fresh','aging'].includes(assessmentFreshness(current.assessed_at,Date.now()).status))return 'current_evidence_stale';
 const model=await env.DB.prepare(`SELECT * FROM dealguard.forecast_models WHERE portal_id=? AND pipeline_id=? AND policy_id=? AND state='active'
   AND consent_revision=? AND expires_at>NOW() AND dealguard.forecast_actor_authorized(portal_id,reviewed_by,TRUE)`)
   .bind(identity.portalId,current.pipeline_id,current.policy_id,consent.revision).first<ForecastModelRow>();
 if(!model)return 'no_independently_approved_model';
 let artifact:ForecastArtifact;try{artifact=await verifyForecastModel(env,model);}catch{return 'model_evidence_changed';}
 const window=activeForecastQuarter();
 if(Date.parse(forecastWindow(artifact.quarters[2]!).horizonAt)>Date.parse(window.anchorAt)||Date.now()-Date.parse(forecastWindow(artifact.quarters[2]!).horizonAt)>180*86400000)
   return 'model_evaluation_stale';
 const monitor=await env.DB.prepare(`SELECT status FROM dealguard.forecast_monitors WHERE portal_id=? AND model_id=? AND quarter=? AND expires_at>NOW()`)
   .bind(identity.portalId,model.id,window.quarter).first<{status:string}>();
 if(monitor?.status!=='eligible')return monitor?.status==='drifted'?'cohort_drift':'monitoring_evidence_unavailable';
 const anchor=(await loadForecastAnchors(env,identity.portalId,window.anchorAt,dealId))[0];
 const features=anchor?anchorFeatures(anchor,artifact,window.anchorAt):null;
 if(!anchor?.baseline||!features)return 'quarter_anchor_evidence_unavailable';
 assertRecordScope(access.context,{pipelineId:anchor.baseline.pipeline_id as string|null,ownerId:anchor.baseline.owner_id as string|null,
   teamId:anchor.baseline.team_id as string|null,regionCode:anchor.baseline.region_code as string|null});
 const transition=await env.DB.prepare(`SELECT EXISTS(SELECT 1 FROM assessment_history WHERE portal_id=? AND deal_id=?
   AND CASE WHEN pg_input_is_valid(assessed_at,'timestamp with time zone') THEN assessed_at::timestamptz>?::timestamptz ELSE FALSE END
   AND (pipeline_id IS DISTINCT FROM ? OR policy_id IS DISTINCT FROM ? OR is_closed<>0)) AS changed`)
   .bind(identity.portalId,dealId,window.anchorAt,artifact.pipelineId,artifact.policyId).first<{changed:boolean}>();
 if(transition?.changed)return 'cohort_or_lifecycle_changed';
 const sourceFingerprint=await sha256Hex(canonicalAuditValue({quarter:window.quarter,anchor:anchor.baseline,features,model:model.artifact_fingerprint}));
 return {model,artifact,controls,consentRevision:consent.revision,features,sourceFingerprint,assessmentAt:current.assessed_at,
   evidenceAt:String(anchor.baseline.assessed_at),window};
}
export async function dealForecast(env:Env,identity:RequestIdentity,dealId:string):Promise<Record<string,unknown>>{
 if(!identity.userId||!/^\d{1,32}$/.test(dealId))throw new AppError(400,'forecast_record_required','An identified user and valid deal ID are required.');
 const unavailable=(reason:string)=>({status:'unavailable',reason,probability:null,target:FORECAST_TARGET,...activeForecastQuarter(),modelId:null,
   modelVersion:FORECAST_SCHEMA,evidenceAt:null,assessmentAt:null,estimateOrigin:'quarter_start',uncertainty:null,limitations:LIMITATIONS});
 let state:Eligible|string;try{state=await eligibility(env,identity,dealId);}catch(error){
   if(error instanceof AppError&&error.code==='intelligence_consent_required')return unavailable('outcome_consent_required');throw error;
 }
 if(typeof state==='string')return unavailable(state);
 const cache=await env.DB.prepare(`SELECT probability FROM dealguard.forecast_cache WHERE portal_id=? AND model_id=? AND deal_id=? AND quarter=?
   AND source_fingerprint=? AND controls_revision=? AND consent_revision=? AND expires_at>NOW()`)
   .bind(identity.portalId,state.model.id,dealId,state.window.quarter,state.sourceFingerprint,state.controls.revision,state.consentRevision).first<{probability:number}>();
 const probability=logisticProbability(state.features,state.artifact.parameters);
 const bin=state.artifact.calibrationBins[Math.min(9,Math.floor(probability*10))]!;
 if(bin.count<20)return unavailable('calibration_support_insufficient');
 // A retained cache is an optimization, never authority to return data or change the original estimate.
 const cached=cache?.probability===probability;
 if(!cached){
   const saved=await env.DB.prepare('SELECT dealguard.store_forecast_prediction(?,?,?,?,?,?,?,?,?,?::timestamptz,?::timestamptz,?) AS accepted')
     .bind(identity.portalId,state.model.id,dealId,state.window.quarter,state.controls.revision,state.consentRevision,state.assessmentAt,
       state.sourceFingerprint,probability,state.window.anchorAt,state.window.horizonAt,state.evidenceAt).first<{accepted:boolean}>();
   if(!saved?.accepted)return unavailable('eligibility_changed');
 }
 const final=await eligibility(env,identity,dealId);
 if(typeof final==='string'||final.model.id!==state.model.id||final.sourceFingerprint!==state.sourceFingerprint||final.assessmentAt!==state.assessmentAt
   ||final.controls.revision!==state.controls.revision||final.consentRevision!==state.consentRevision)return unavailable('eligibility_changed');
 return {status:'eligible',reason:null,probability,target:FORECAST_TARGET,...state.window,modelId:state.model.id,modelVersion:FORECAST_SCHEMA,
   evidenceAt:state.evidenceAt,assessmentAt:state.assessmentAt,estimateOrigin:'quarter_start',cached,
   uncertainty:{method:'held_out_probability_bin_wilson_95',calibrationSamples:bin.count,observedRate:bin.observedRate,
     observedRateInterval:bin.observedRateInterval,individualProbabilityInterval:null,support:bin.count>=20?'supported':'sparse'},limitations:LIMITATIONS};
}
