import { canonicalAuditValue } from './audit-chain.js';
import { requireCommercialTier } from './billing.js';
import { sha256Hex } from './crypto.js';
import { AppError } from './errors.js';
import { forecastPolicyFingerprint } from './forecast-evidence.js';
import { FORECAST_FEATURES, FORECAST_SCHEMA, FORECAST_TARGET, calibrationBins, disjointOutcomeSplits, featureProfile, type ForecastArtifact } from './forecast-model.js';
import { requireIntelligenceAdministrator,requireIntelligenceConsent } from './intelligence-consent.js';
import type { OutcomeDataset } from './outcome-cohort.js';
import { evaluateOutcomeCohorts } from './outcome-evaluation.js';
import type { Env,RequestIdentity } from './types.js';

type Job={portal_id:string;id:string;actor_id:string;consent_revision:number;train_id:string;calibration_id:string;holdout_id:string;attempts:number;lease_token:string};
/** Interactive requests only enqueue work. Training never runs on a CRM read. */
export async function evaluateStoredOutcomes(env:Env,identity:RequestIdentity,input:Record<string,unknown>):Promise<Record<string,unknown>>{
  await requireIntelligenceAdministrator(env,identity);const c=await requireIntelligenceConsent(env,identity.portalId,'outcomes');
  const ids=[input.trainId,input.calibrationId,input.holdoutId];
  if(Object.keys(input).some(k=>!['trainId','calibrationId','holdoutId'].includes(k))||ids.some(id=>typeof id!=='string'||!id||id.length>128)||new Set(ids).size!==3)
    throw new AppError(400,'evaluation_datasets_required','Three distinct dataset IDs are required.');
  const row=await env.DB.prepare('SELECT dealguard.enqueue_outcome_evaluation(?,?,?,?,?,?,?) AS job')
    .bind(identity.portalId,c.revision,identity.userId,crypto.randomUUID(),...ids).first<{job:{id:string;state:string;error?:string}|null}>();
  if(row?.job?.error)throw new AppError(429,'evaluation_daily_capacity','The daily controlled-evaluation allowance is exhausted.');
  if(!row?.job)throw new AppError(409,'evaluation_not_admitted','Use current consent, three available datasets, and an explicitly assigned portal-wide administrator.');
  return {id:row.job.id,status:row.job.state,predictionsEnabled:false,execution:'durable_batch',message:'The bounded maintenance worker evaluates queued data. A completed evaluation is not permission to activate predictions.'};
}
async function readJobDatasets(env:Env,job:Job):Promise<{datasets:OutcomeDataset[];fingerprints:string[]}> {
  const datasets:OutcomeDataset[]=[],fingerprints:string[]=[];
  for(const id of [job.train_id,job.calibration_id,job.holdout_id]){
    const row=await env.DB.prepare(`SELECT fingerprint,manifest,samples FROM dealguard.outcome_datasets WHERE portal_id=? AND id=? AND consent_revision=? AND expires_at>NOW()`)
      .bind(job.portal_id,id,job.consent_revision).first<OutcomeDataset&{fingerprint:string}>();
    if(!row)throw new AppError(409,'evaluation_dataset_unavailable','An evaluation dataset is unavailable.');
    const dataset={manifest:row.manifest,samples:row.samples};
    if(await sha256Hex(canonicalAuditValue(dataset))!==row.fingerprint)throw new AppError(422,'outcome_fingerprint_mismatch','Dataset integrity failed.');
    datasets.push(dataset);fingerprints.push(row.fingerprint);
  }
  return {datasets,fingerprints};
}
/** One bounded, durable job per maintenance invocation by default. Expired leases retry at most three times. */
export async function processOutcomeEvaluationJobs(env:Env,limit=1):Promise<{processed:number}> {
  let processed=0;
  for(let n=0;n<Math.min(2,Math.max(0,limit));n++){
    await env.DB.prepare(`UPDATE dealguard.outcome_evaluation_jobs SET state='failed',error_code='lease_exhausted',updated_at=NOW()
      WHERE (portal_id,id) IN(SELECT portal_id,id FROM dealguard.outcome_evaluation_jobs WHERE state='running' AND attempts>=3
      AND lease_expires_at<=NOW() ORDER BY lease_expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)`).run();
    const token=crypto.randomUUID();
    const job=await env.DB.prepare(`UPDATE dealguard.outcome_evaluation_jobs j SET state='running',attempts=attempts+1,lease_token=?,
      lease_expires_at=NOW()+INTERVAL '5 minutes',updated_at=NOW() WHERE (portal_id,id)=(SELECT portal_id,id FROM dealguard.outcome_evaluation_jobs
      WHERE attempts<3 AND ((state='queued' AND not_before<=NOW()) OR (state='running' AND lease_expires_at<=NOW()))
      ORDER BY not_before,created_at,portal_id,id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING j.*`).bind(token).first<Job>();
    if(!job)break;
    try{
      const identity:RequestIdentity={portalId:job.portal_id,userId:job.actor_id,userEmail:null,appId:null};
      await requireIntelligenceAdministrator(env,identity);
      await requireIntelligenceConsent(env,job.portal_id,'outcomes',job.consent_revision);
      const {datasets,fingerprints}=await readJobDatasets(env,job);
      const policyFingerprint=await forecastPolicyFingerprint(env,job.portal_id,datasets[0]!.manifest.policyId);
      if(datasets.some(d=>d.manifest.policyFingerprint!==policyFingerprint))
        throw new AppError(422,'evaluation_policy_evidence_changed','Rebuild datasets with an unchanged versioned policy fingerprint before controlled evaluation.');
      const result=evaluateOutcomeCohorts(datasets[0]!,datasets[1]!,datasets[2]!);
      const evaluationId=crypto.randomUUID(),evaluatedAt=new Date().toISOString();
      let artifact:ForecastArtifact|null=null;
      if(result.parameters){
        const splits=disjointOutcomeSplits(datasets),training=splits[0]!,holdout=splits[2]!;
        const evaluationFingerprint=await sha256Hex(canonicalAuditValue({report:result.report,parameters:result.parameters,datasetFingerprints:fingerprints}));
        artifact={schema:FORECAST_SCHEMA,target:FORECAST_TARGET,evaluationId,evaluationFingerprint,
          pipelineId:datasets[0]!.manifest.pipelineId,policyId:datasets[0]!.manifest.policyId,
          policyFingerprint,
          featureSchema:[...FORECAST_FEATURES],datasetFingerprints:fingerprints,quarters:datasets.map(d=>d.manifest.quarter),consentRevision:job.consent_revision,
          parameters:result.parameters,trainingProfile:featureProfile(training,result.parameters),
          baselineProbability:(training.reduce((sum,s)=>sum+s.label,0)+1)/(training.length+2),
          calibrationBins:calibrationBins(holdout,result.parameters),report:result.report,evaluatedAt};
      }
      await requireIntelligenceAdministrator(env,identity);await requireCommercialTier(env,job.portal_id,'enterprise');
      const fingerprint=await sha256Hex(canonicalAuditValue(artifact??{evaluationId,...result,datasetFingerprints:fingerprints}));
      await env.DB.prepare('SELECT dealguard.finish_outcome_evaluation(?,?,?,?,?::jsonb,?::jsonb,?::jsonb,?) AS accepted')
        .bind(job.portal_id,job.id,token,evaluationId,JSON.stringify(result.report),JSON.stringify(result.parameters),JSON.stringify(artifact),fingerprint).first();
    }catch(error){
      const code=error instanceof AppError?error.code:'evaluation_failed';
      const cancelled=error instanceof AppError&&[401,403].includes(error.status);
      await env.DB.prepare(`UPDATE dealguard.outcome_evaluation_jobs SET state=?,error_code=?,lease_token=NULL,lease_expires_at=NULL,updated_at=NOW()
        WHERE portal_id=? AND id=? AND state='running' AND lease_token=?`)
        .bind(cancelled?'cancelled':'failed',code,job.portal_id,job.id,token).run();
    }
    processed++;
  }
  return {processed};
}
export async function listOutcomeEvaluations(env:Env,identity:RequestIdentity):Promise<unknown[]>{
  await requireIntelligenceAdministrator(env,identity);const c=await requireIntelligenceConsent(env,identity.portalId,'outcomes');
  const result=await env.DB.prepare(`SELECT id,train_id,calibration_id,holdout_id,report,created_at FROM dealguard.outcome_evaluations e
    WHERE portal_id=? AND consent_revision=? AND NOT EXISTS(SELECT 1 FROM dealguard.outcome_datasets d
      WHERE d.portal_id=e.portal_id AND d.id IN(e.train_id,e.calibration_id,e.holdout_id) AND d.expires_at<=NOW())
    ORDER BY created_at DESC,id LIMIT 100`).bind(identity.portalId,c.revision).all<Record<string,unknown>>();
  const jobs=await env.DB.prepare(`SELECT id,train_id,calibration_id,holdout_id,state,attempts,error_code,created_at FROM dealguard.outcome_evaluation_jobs
    WHERE portal_id=? AND consent_revision=? AND state<>'completed' ORDER BY created_at DESC,id LIMIT 100`).bind(identity.portalId,c.revision).all<Record<string,unknown>>();
  await requireIntelligenceAdministrator(env,identity);await requireIntelligenceConsent(env,identity.portalId,'outcomes',c.revision);
  return [...(jobs.results??[]).map(j=>({id:j.id,train_id:j.train_id,calibration_id:j.calibration_id,holdout_id:j.holdout_id,created_at:j.created_at,
    report:{schema:'dealguard-evaluation-job-v1',status:j.state,reason:j.error_code??'Controlled evaluation is pending.',attempts:j.attempts,predictionsEnabled:false}})),...(result.results??[])];
}
