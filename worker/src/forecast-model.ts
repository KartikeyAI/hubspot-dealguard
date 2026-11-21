import { AppError } from './errors.js';
import { evidenceInstant } from './evidence-freshness.js';
import { logisticProbability, predictionMetrics, type LogisticParameters } from './outcome-evaluation.js';
import type { OutcomeDataset, OutcomeSample } from './outcome-cohort.js';

export const FORECAST_SCHEMA = 'dealguard-quarter-anchor-forecast-v1';
export const FORECAST_TARGET = 'recorded_closed_won_at_quarter_end';
export const FORECAST_FEATURES = ['readiness_score','issue_count','stage_age_days','stage_age_missing'] as const;
export const FORECAST_MONITOR_MS = 24 * 3600000;
export interface FeatureProfile { counts:number[][]; sampleCount:number }
export interface CalibrationBin { count:number; meanProbability:number|null; observedRate:number|null; observedRateInterval:[number,number]|null }
export interface ForecastArtifact {
  schema:typeof FORECAST_SCHEMA; target:typeof FORECAST_TARGET; evaluationId:string; evaluationFingerprint:string;
  pipelineId:string; policyId:string; policyFingerprint:string; featureSchema:string[];
  datasetFingerprints:string[]; quarters:string[]; consentRevision:number; parameters:LogisticParameters;
  trainingProfile:FeatureProfile; baselineProbability:number; calibrationBins:CalibrationBin[];
  report:Record<string,unknown>; evaluatedAt:string;
}
export function activeForecastQuarter(now=Date.now()):{quarter:string;anchorAt:string;horizonAt:string} {
  const d=new Date(now),year=d.getUTCFullYear(),q=Math.floor(d.getUTCMonth()/3);
  return {quarter:`${year}-Q${q+1}`,anchorAt:new Date(Date.UTC(year,q*3,1)).toISOString(),horizonAt:new Date(Date.UTC(year,q*3+3,1)).toISOString()};
}
export function forecastWindow(quarter:string):ReturnType<typeof activeForecastQuarter> {
  if(!/^20\d{2}-Q[1-4]$/.test(quarter))throw new AppError(422,'forecast_quarter_invalid','A valid quarter is required.');
  return activeForecastQuarter(Date.UTC(Number(quarter.slice(0,4)),(Number(quarter.slice(-1))-1)*3,1));
}
export function validForecastFeatures(value:unknown):value is [number,number,number,number] {
  return Array.isArray(value)&&value.length===4&&value.every(v=>typeof v==='number'&&Number.isFinite(v))
    &&value[0]>=0&&value[0]<=100&&value[1]>=0&&value[1]<=10000&&value[2]>=0&&value[2]<=36500
    &&[0,1].includes(value[3])&&(value[3]!==1||value[2]===0);
}
export function validateForecastParameters(value:unknown):asserts value is LogisticParameters {
  const p=value as LogisticParameters|null;
  if(!p||!Array.isArray(p.means)||p.means.length!==4||!Array.isArray(p.scales)||p.scales.length!==4
    ||!Array.isArray(p.weights)||p.weights.length!==5||[...p.means,...p.scales,...p.weights].some(v=>typeof v!=='number'||!Number.isFinite(v))
    ||p.scales.some(v=>v<1e-6)||typeof p.temperature!=='number'||!Number.isFinite(p.temperature)||p.temperature<0.5||p.temperature>3)
    throw new AppError(422,'forecast_model_invalid','Model parameters do not match the registered feature contract.');
}
function bucket(value:number,index:number,model:LogisticParameters):number {
  if(index===3)return value===1?1:0;
  const z=(value-model.means[index]!)/model.scales[index]!;
  return z < -2 ? 0 : z < -1 ? 1 : z < 0 ? 2 : z < 1 ? 3 : z < 2 ? 4 : 5;
}
export function featureProfile(samples:ReadonlyArray<{features:number[]}>,model:LogisticParameters):FeatureProfile {
  validateForecastParameters(model);
  const counts=Array.from({length:4},(_,i)=>Array(i===3?2:6).fill(0) as number[]);
  for(const s of samples){if(!validForecastFeatures(s.features))throw new AppError(422,'forecast_features_invalid','The quarter-anchor features are invalid.');
    for(let i=0;i<4;i++)counts[i]![bucket(s.features[i]!,i,model)]!++;}
  return {counts,sampleCount:samples.length};
}
export function calibrationBins(samples:OutcomeSample[],model:LogisticParameters):CalibrationBin[] {
  const bins=Array.from({length:10},()=>({count:0,successes:0,total:0}));
  for(const sample of samples){const p=logisticProbability(sample.features,model),b=bins[Math.min(9,Math.floor(p*10))]!;b.count++;b.successes+=sample.label;b.total+=p;}
  return bins.map(b=>{if(!b.count)return {count:0,meanProbability:null,observedRate:null,observedRateInterval:null};
    const n=b.count,p=b.successes/n,z=1.959963984540054,denom=1+z*z/n,center=(p+z*z/(2*n))/denom;
    const half=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/denom;
    return {count:n,meanProbability:b.total/n,observedRate:p,observedRateInterval:[p===0?0:Math.max(0,center-half),p===1?1:Math.min(1,center+half)] as [number,number]};});
}
export function disjointOutcomeSplits(datasets:OutcomeDataset[]):OutcomeSample[][] {
  const seen=new Set<string>();return datasets.map(d=>{const rows=d.samples.filter(s=>!seen.has(s.dealId));for(const s of rows)seen.add(s.dealId);return rows;});
}
export function modelReportQualified(report:Record<string,unknown>):boolean {
  const model=report.model as Record<string,number>|null,base=report.baseline as Record<string,number>|null,interval=report.brierDifferenceInterval;
  return report.schema==='dealguard-logistic-evaluation-v1'&&report.status==='qualified_candidate'
    &&Array.isArray(report.counts)&&report.counts.length===3&&report.counts.every((n,i)=>Number.isSafeInteger(n)&&n>=(i===0?200:100))
    &&!!model&&!!base&&['brier','logLoss','ece','auc'].every(k=>typeof model[k]==='number'&&Number.isFinite(model[k]))
    &&Number.isFinite(base.brier)&&Number.isFinite(base.logLoss)&&Array.isArray(interval)&&interval.length===2
    &&interval.every(v=>typeof v==='number'&&Number.isFinite(v))&&interval[0]<=interval[1]&&interval[1]<-0.001
    &&model.logLoss!<base.logLoss!&&model.ece!>=0&&model.ece!<=0.1&&model.auc!>=0.6&&model.auc!<=1;
}
export function validateForecastArtifact(value:unknown):asserts value is ForecastArtifact {
  const a=value as ForecastArtifact|null;
  if(!a||a.schema!==FORECAST_SCHEMA||a.target!==FORECAST_TARGET||!a.pipelineId||!a.policyId||!a.evaluationId
    ||![a.evaluationFingerprint,a.policyFingerprint,...(a.datasetFingerprints??[])].every(v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v))
    ||a.datasetFingerprints?.length!==3||a.quarters?.length!==3||a.featureSchema?.join('|')!==FORECAST_FEATURES.join('|')
    ||!Number.isSafeInteger(a.consentRevision)||a.consentRevision<1||!modelReportQualified(a.report)
    ||!evidenceInstant(a.evaluatedAt)||!a.trainingProfile||a.trainingProfile.sampleCount<200
    ||a.trainingProfile.counts?.length!==4||a.trainingProfile.counts.some((b,i)=>!Array.isArray(b)||b.length!==(i===3?2:6)
      ||b.some(n=>!Number.isSafeInteger(n)||n<0)||b.reduce((sum,n)=>sum+n,0)!==a.trainingProfile.sampleCount)
    ||!Number.isFinite(a.baselineProbability)||a.baselineProbability<=0||a.baselineProbability>=1||a.calibrationBins?.length!==10)
    throw new AppError(422,'forecast_artifact_invalid','The evaluation artifact cannot be validated.');
  validateForecastParameters(a.parameters);
  const windows=a.quarters.map(forecastWindow);
  if(windows[0]!.horizonAt>windows[1]!.anchorAt||windows[1]!.horizonAt>windows[2]!.anchorAt)
    throw new AppError(422,'forecast_artifact_invalid','Model evaluation windows overlap.');
  for(const b of a.calibrationBins){if(!Number.isSafeInteger(b.count)||b.count<0||b.count>2000
    ||(b.count>0&&(!Number.isFinite(b.meanProbability)||!Number.isFinite(b.observedRate)||!Array.isArray(b.observedRateInterval)
      ||b.observedRateInterval.length!==2||b.observedRateInterval.some(p=>!Number.isFinite(p)||p<0||p>1))))
    throw new AppError(422,'forecast_uncertainty_invalid','Calibration support is invalid.');}
}
export function forecastDrift(profile:FeatureProfile,reference:FeatureProfile,excluded:number,total:number) {
  const distances=profile.counts.map((bins,i)=>profile.sampleCount>0?bins.reduce((sum,n,j)=>sum+Math.abs(n/profile.sampleCount-reference.counts[i]![j]!/reference.sampleCount),0)/2:null);
  const exclusionRate=total?excluded/total:1;
  const status=profile.sampleCount<100?'insufficient_evidence':exclusionRate>0.2||distances.some(x=>(x??1)>0.25)?'drifted':'eligible';
  return {schema:'dealguard-forecast-drift-v1',status,sampleCount:profile.sampleCount,total,excluded,exclusionRate,totalVariation:distances,
    gates:{minimumSamples:100,maximumExclusionRate:0.2,maximumFeatureTotalVariation:0.25},
    interpretation:'Feature-distribution checks are drift indicators, not proof of forecast accuracy or causal impact.'};
}
export function forecastOutcomeReport(labels:number[],probabilities:number[],baseline:number,total:number) {
  if(labels.length<100||labels.filter(x=>x===1).length<20||labels.filter(x=>x===0).length<20)
    return {schema:'dealguard-forecast-outcomes-v1',status:'insufficient_evidence',total,observed:labels.length,excluded:total-labels.length,metrics:null,baseline:null};
  const metrics=predictionMetrics(labels,probabilities),reference=predictionMetrics(labels,labels.map(()=>baseline));
  return {schema:'dealguard-forecast-outcomes-v1',status:metrics.brier>reference.brier||metrics.logLoss>reference.logLoss||metrics.ece>0.15?'drifted':'observed',
    total,observed:labels.length,excluded:total-labels.length,metrics,baseline:reference};
}
