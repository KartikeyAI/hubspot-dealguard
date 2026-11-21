import { AppError } from './errors.js';
import { evidenceInstant } from './evidence-freshness.js';
export const OUTCOME_SCHEMA='dealguard-quarter-outcomes-v1';
export interface OutcomeSample { dealId:string; observationAt:string; labelAt:string; features:[number,number,number,number]; label:0|1 }
export interface OutcomeManifest { schema:typeof OUTCOME_SCHEMA; quarter:string; anchor:string; horizon:string; pipelineId:string; policyId:string;
  sampleCount:number; exclusions:Record<string,number>; policyFingerprint?:string }
export interface OutcomeDataset {manifest:OutcomeManifest;samples:OutcomeSample[]}
export function quarterWindow(quarter:unknown,now=Date.now()):{anchor:string;horizon:string}{
  if(typeof quarter!=='string'||!/^20\d{2}-Q[1-4]$/.test(quarter))throw new AppError(400,'outcome_quarter_invalid','Use YYYY-Q1 through YYYY-Q4.');
  const year=Number(quarter.slice(0,4)),month=(Number(quarter.slice(-1))-1)*3;
  const anchor=Date.UTC(year,month,1),horizon=Date.UTC(year,month+3,1);
  if(horizon+7*86400000>now)throw new AppError(422,'outcome_horizon_immature','A quarter must end at least seven days before evaluation.');
  return {anchor:new Date(anchor).toISOString(),horizon:new Date(horizon).toISOString()};
}
function row(value:unknown):Record<string,unknown>|null{return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;}
function numeric(value:unknown,min:number,max:number):value is number{return typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max;}
export function buildOutcomeCohort(candidates:Record<string,unknown>[],quarter:string,pipelineId:string,policyId:string,policyCreatedAt:unknown,now=Date.now()):OutcomeDataset{
  if(candidates.length>10000)throw new AppError(422,'outcome_capacity_exceeded','More than 10,000 deals require a narrower cohort.');
  const window=quarterWindow(quarter,now),anchor=Date.parse(window.anchor),horizon=Date.parse(window.horizon);
  const created=evidenceInstant(policyCreatedAt);
  if(!created||Date.parse(created)>anchor)throw new AppError(422,'outcome_policy_invalid','The policy must have existed at the cohort boundary.');
  const samples:OutcomeSample[]=[],exclusions:Record<string,number>={},seen=new Set<string>();
  const exclude=(reason:string)=>{exclusions[reason]=(exclusions[reason]??0)+1;};
  for(const c of candidates){
    const id=typeof c.deal_id==='string'?c.deal_id:'';
    if(!id||seen.has(id))throw new AppError(422,'outcome_duplicate_identity','Dataset identities must be unique.');seen.add(id);
    if(c.invalid_history===true){exclude('invalid_history');continue;}
    const b=row(c.baseline),l=row(c.label);
    if(!b||!l){exclude('missing_observation');continue;}
    const bt=evidenceInstant(b.assessed_at),lt=evidenceInstant(l.assessed_at);
    if(!bt||!lt||Date.parse(bt)>anchor||Date.parse(bt)<anchor-72*3600000||Date.parse(lt)>=horizon||Date.parse(lt)<horizon-72*3600000){exclude('stale_or_invalid_observation');continue;}
    if(c.baseline_available!==true||c.label_available!==true){exclude('archived');continue;}
    if(b.pipeline_id!==pipelineId||l.pipeline_id!==pipelineId||b.policy_id!==policyId||l.policy_id!==policyId){exclude('cohort_changed');continue;}
    if(b.is_closed!==0||b.is_won!==0){exclude('not_open_at_anchor');continue;}
    if(![0,1].includes(l.is_closed as number)||![0,1].includes(l.is_won as number)||(l.is_closed===0&&l.is_won===1)){exclude('invalid_label');continue;}
    if(!numeric(b.score,0,100)||!numeric(b.issue_count,0,10000)||(b.stage_age_days!==null&&!numeric(b.stage_age_days,0,36500))){exclude('invalid_features');continue;}
    samples.push({dealId:id,observationAt:bt,labelAt:lt,features:[b.score,b.issue_count,b.stage_age_days===null?0:b.stage_age_days as number,b.stage_age_days===null?1:0],label:l.is_closed===1&&l.is_won===1?1:0});
  }
  samples.sort((a,b)=>a.dealId.localeCompare(b.dealId,'en'));
  return {manifest:{schema:OUTCOME_SCHEMA,quarter,...window,pipelineId,policyId,sampleCount:samples.length,exclusions},samples};
}
