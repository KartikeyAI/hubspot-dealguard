import { AppError } from './errors.js';
import { evidenceInstant } from './evidence-freshness.js';
import { OUTCOME_SCHEMA,quarterWindow,type OutcomeDataset,type OutcomeSample } from './outcome-cohort.js';
export interface EvaluationMetrics { brier:number;logLoss:number;ece:number;auc:number|null }
export interface LogisticParameters { means:number[];scales:number[];weights:number[];temperature:number }
export interface EvaluationResult { report:{schema:'dealguard-logistic-evaluation-v1';status:'insufficient_evidence'|'not_qualified'|'qualified_candidate';
  predictionsEnabled:false;reason:string|null;counts:number[];duplicatesExcluded:number[];model:EvaluationMetrics|null;baseline:EvaluationMetrics|null;
  brierDifferenceInterval:[number,number]|null};parameters:LogisticParameters|null }
const sigmoid=(x:number)=>1/(1+Math.exp(-Math.max(-35,Math.min(35,x))));
const clipped=(p:number)=>Math.max(1e-9,Math.min(1-1e-9,p));
export function predictionMetrics(labels:number[],probabilities:number[]):EvaluationMetrics {
  if(!labels.length||labels.length!==probabilities.length||labels.some(x=>x!==0&&x!==1)
    ||probabilities.some(x=>!Number.isFinite(x)||x<0||x>1))throw new AppError(422,'evaluation_values_invalid','Metrics require valid paired labels and probabilities.');
  let brier=0,logLoss=0,ece=0;
  const bins=Array.from({length:10},()=>({count:0,p:0,y:0}));
  const ranked=probabilities.map((p,i)=>({p,y:labels[i]!})).sort((a,b)=>a.p-b.p);
  let positiveRanks=0,positives=0;
  for(let i=0;i<ranked.length;){let j=i;while(j<ranked.length&&ranked[j]!.p===ranked[i]!.p)j++;
    const rank=(i+1+j)/2;for(let k=i;k<j;k++)if(ranked[k]!.y===1){positiveRanks+=rank;positives++;}i=j;}
  for(let i=0;i<labels.length;i++){const y=labels[i]!,p=probabilities[i]!,q=clipped(p);brier+=(p-y)**2;logLoss-=y*Math.log(q)+(1-y)*Math.log(1-q);
    const bin=bins[Math.min(9,Math.floor(p*10))]!;bin.count++;bin.p+=p;bin.y+=y;}
  for(const bin of bins)if(bin.count)ece+=Math.abs(bin.p-bin.y)/labels.length;
  const negatives=labels.length-positives;
  return {brier:brier/labels.length,logLoss:logLoss/labels.length,ece,auc:positives&&negatives?(positiveRanks-positives*(positives+1)/2)/(positives*negatives):null};
}
function validDataset(d:OutcomeDataset):void{
  const m=d?.manifest;if(!m||m.schema!==OUTCOME_SCHEMA||!Array.isArray(d.samples)||d.samples.length>2000||m.sampleCount!==d.samples.length)
    throw new AppError(422,'evaluation_dataset_invalid','Use a bounded, complete outcome dataset.');
  const w=quarterWindow(m.quarter);if(w.anchor!==m.anchor||w.horizon!==m.horizon)throw new AppError(422,'evaluation_window_invalid','Dataset quarter boundaries do not match.');
  const seen=new Set<string>(),anchor=Date.parse(m.anchor),horizon=Date.parse(m.horizon);
  for(const s of d.samples){const b=evidenceInstant(s.observationAt),l=evidenceInstant(s.labelAt);
    if(typeof s.dealId!=='string'||!s.dealId||seen.has(s.dealId)||!b||!l||Date.parse(b)>anchor||Date.parse(b)<anchor-72*3600000
      ||Date.parse(l)>=horizon||Date.parse(l)<horizon-72*3600000||![0,1].includes(s.label)||!Array.isArray(s.features)||s.features.length!==4
      ||s.features.some(v=>typeof v!=='number'||!Number.isFinite(v))||s.features[0]<0||s.features[0]>100||s.features[1]<0||s.features[1]>10000
      ||s.features[2]<0||s.features[2]>36500||![0,1].includes(s.features[3])||(s.features[3]===1&&s.features[2]!==0))
      throw new AppError(422,'evaluation_sample_invalid','Dataset samples fail identity, clock or feature validation.');seen.add(s.dealId);}
}
function standardize(x:number[],m:LogisticParameters):number[]{return [1,...x.map((v,i)=>(v-m.means[i]!)/m.scales[i]!)];}
export function logisticProbability(x:number[],m:LogisticParameters):number{
  return sigmoid(standardize(x,m).reduce((sum,v,i)=>sum+v*m.weights[i]!,0)/m.temperature);
}
function train(samples:OutcomeSample[]):LogisticParameters{
  const means=Array.from({length:4},(_,i)=>samples.reduce((sum,s)=>sum+s.features[i]!,0)/samples.length);
  const scales=means.map((mean,i)=>Math.max(1e-6,Math.sqrt(samples.reduce((sum,s)=>sum+(s.features[i]!-mean)**2,0)/samples.length)));
  const prior=(samples.reduce((sum,s)=>sum+s.label,0)+1)/(samples.length+2);
  const m:LogisticParameters={means,scales,weights:[Math.log(prior/(1-prior)),0,0,0,0],temperature:1};
  const x=samples.map(s=>standardize(s.features,m));
  for(let epoch=0;epoch<400;epoch++){
    const gradient=[0,0,0,0,0];
    for(let n=0;n<samples.length;n++){const values=x[n]!,error=sigmoid(values.reduce((sum,v,i)=>sum+v*m.weights[i]!,0))-samples[n]!.label;
      for(let i=0;i<5;i++)gradient[i]=gradient[i]!+error*values[i]!;}
    for(let i=0;i<5;i++)m.weights[i]=m.weights[i]!-0.05*(gradient[i]!/samples.length+(i?0.01*m.weights[i]!:0));
  }
  return m;
}
export function evaluateOutcomeCohorts(trainData:OutcomeDataset,calibrationData:OutcomeDataset,holdoutData:OutcomeDataset):EvaluationResult{
  const datasets=[trainData,calibrationData,holdoutData];datasets.forEach(validDataset);
  if(datasets.some(d=>d.manifest.pipelineId!==trainData.manifest.pipelineId||d.manifest.policyId!==trainData.manifest.policyId)
    ||Date.parse(trainData.manifest.horizon)>Date.parse(calibrationData.manifest.anchor)||Date.parse(calibrationData.manifest.horizon)>Date.parse(holdoutData.manifest.anchor))
    throw new AppError(422,'evaluation_cohorts_overlap','Use ordered non-overlapping quarters in one pipeline and policy.');
  const seen=new Set<string>(),duplicatesExcluded:number[]=[];
  const splits=datasets.map(d=>{const samples=d.samples.filter(s=>!seen.has(s.dealId));duplicatesExcluded.push(d.samples.length-samples.length);
    for(const s of samples)seen.add(s.dealId);return samples;});
  const report:EvaluationResult['report']={schema:'dealguard-logistic-evaluation-v1',status:'insufficient_evidence',predictionsEnabled:false,
    reason:null,counts:splits.map(s=>s.length),duplicatesExcluded,model:null,baseline:null,brierDifferenceInterval:null};
  if(splits.some((s,i)=>s.length<(i===0?200:100)||s.filter(x=>x.label===1).length<20||s.filter(x=>x.label===0).length<20))
    return {report:{...report,reason:'Each split requires enough distinct deals and both outcome classes.'},parameters:null};
  const [training,calibration,holdout]=splits as [OutcomeSample[],OutcomeSample[],OutcomeSample[]];
  const model=train(training),calLabels=calibration.map(s=>s.label);let best=Infinity,temperature=1;
  for(const t of [0.5,0.75,1,1.5,2,3]){model.temperature=t;const loss=predictionMetrics(calLabels,calibration.map(s=>logisticProbability(s.features,model))).logLoss;
    if(loss<best){best=loss;temperature=t;}}
  model.temperature=temperature;
  const predictions=holdout.map(s=>logisticProbability(s.features,model)),labels=holdout.map(s=>s.label);
  const prior=(training.reduce((sum,s)=>sum+s.label,0)+1)/(training.length+2),baseline=labels.map(()=>prior);
  report.model=predictionMetrics(labels,predictions);report.baseline=predictionMetrics(labels,baseline);
  const diffs=labels.map((y,i)=>(predictions[i]!-y)**2-(prior-y)**2),boot:number[]=[];let seed=0x1badc0de;
  for(let b=0;b<200;b++){let sum=0;for(let i=0;i<diffs.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;sum+=diffs[seed%diffs.length]!;}boot.push(sum/diffs.length);}
  boot.sort((a,b)=>a-b);report.brierDifferenceInterval=[boot[4]!,boot[194]!];
  report.status=report.brierDifferenceInterval[1]<-0.001&&report.model.logLoss<report.baseline.logLoss&&report.model.ece<=0.1&&(report.model.auc??0)>=0.6?'qualified_candidate':'not_qualified';
  report.reason=report.status==='qualified_candidate'?'Historical candidate only; no deployment or current-deal eligibility is implied.':'Held-out performance did not meet the candidate gate.';
  return {report,parameters:model};
}
