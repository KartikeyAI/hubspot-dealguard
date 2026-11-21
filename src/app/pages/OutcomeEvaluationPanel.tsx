import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Flex, Heading, Input, LoadingSpinner, Text, hubspot } from '@hubspot/ui-extensions';
import { safeProductError } from './product-ui';
const ROOT='https://dealguard-api.rokad.co/api/v1/enterprise/outcome-evaluation';
type Consent={enabled:boolean;revision:number};
type Dataset={id:string;manifest:{quarter:string;sampleCount:number;pipelineId:string;policyId:string}};
type Metrics={brier:number;logLoss:number;ece:number;auc:number|null};
type Evaluation={id:string;report:{status:string;reason:string|null;attempts?:number;counts?:number[];duplicatesExcluded?:number[];model?:Metrics|null;baseline?:Metrics|null;brierDifferenceInterval?:number[]|null}};
const number=(value:number|null|undefined)=>typeof value==='number'&&Number.isFinite(value)?value.toFixed(4):'Unavailable';
export function OutcomeEvaluationPanel({enabled,canEvaluate=true}:{enabled:boolean;canEvaluate?:boolean}){
 const [consent,setConsent]=useState<Consent|null>(null),[datasets,setDatasets]=useState<Dataset[]>([]),[evaluations,setEvaluations]=useState<Evaluation[]>([]);
 const [quarter,setQuarter]=useState(''),[pipeline,setPipeline]=useState(''),[policy,setPolicy]=useState(''),[confirmation,setConfirmation]=useState('');
 const [train,setTrain]=useState(''),[calibration,setCalibration]=useState(''),[holdout,setHoldout]=useState('');
 const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[notice,setNotice]=useState<string|null>(null),epoch=useRef(0);
 useEffect(()=>{setConsent(null);setDatasets([]);setEvaluations([]);setBusy(false);setNotice(null);setError(null);return()=>{epoch.current++;};},[enabled,canEvaluate]);
 const call=async(path:string,method:'GET'|'POST'|'PUT'='GET',body?:Record<string,unknown>)=>{
   const response=await hubspot.fetch(ROOT+path,{method,timeout:20000,...(body?{body}:{})});const result=await response.json();
   if(!response.ok)throw new Error(safeProductError(result?.error?.message));return result;
 };
 const act=async(action:'load'|'consent'|'build'|'evaluate')=>{
   if(!enabled||busy||(['build','evaluate'].includes(action)&&!canEvaluate))return;const version=++epoch.current;setBusy(true);setError(null);setNotice(null);
   try{
     if(action==='consent')await call('/consent','PUT',{enabled:!consent?.enabled,revision:consent?.revision,confirmation});
     if(action==='build')await call('/datasets','POST',{quarter:quarter.trim(),pipelineId:pipeline.trim(),policyId:policy.trim()});
     let queued:string|null=null;
     if(action==='evaluate'){const job=await call('/evaluations','POST',{trainId:train.trim(),calibrationId:calibration.trim(),holdoutId:holdout.trim()});queued=`Evaluation ${job.id} is ${job.status}. Reload reports after the background worker has processed it.`;}
     if(version!==epoch.current)return;
     const c:Consent=await call('/consent');if(version!==epoch.current)return;
     const [ds,es]=c.enabled&&canEvaluate?await Promise.all([call('/datasets'),call('/evaluations')]):[{items:[]},{items:[]}];
     if(version!==epoch.current)return;setConsent(c);setDatasets(ds.items);setEvaluations(es.items);setConfirmation('');setNotice(queued);
   }catch(e){if(version===epoch.current)setError(safeProductError(e instanceof Error?e.message:undefined));}
   finally{if(version===epoch.current)setBusy(false);}
 };
 if(!enabled)return null;
 return <Card><Flex direction="column" gap="small"><Heading>Governed outcome evaluation</Heading>
   <Text>Evaluate historical quarter-boundary evidence. This is not a current-deal forecast, and no evaluation automatically activates predictions. Missing observations are excluded, not labeled as losses.</Text>
   <Button disabled={busy} onClick={()=>act('load')}>Load evaluation administration</Button>
   {busy?<LoadingSpinner label="Loading governed outcome evidence"/>:null}{error?<Alert title="Evaluation unavailable" variant="warning">{error}</Alert>:null}
   {notice?<Alert title="Evaluation status" variant="info">{notice}</Alert>:null}
   {consent?<><Text>{consent.enabled?'Evaluation consent enabled':'Evaluation consent disabled'} · revision {consent.revision}</Text>
     {!canEvaluate?<Text>Evaluation requires an active subscription; consent revocation remains available.</Text>:null}
     <Text>Consent permits tenant-bound datasets of recorded scores, issue counts, stage age and outcome labels. Revocation prevents access; legal holds may retain inaccessible evidence.</Text>
     {!busy?<><Input name="outcome-confirm" label={`Type ${consent.enabled?'DISABLE_OUTCOMES':'ENABLE_OUTCOMES'}`} value={confirmation} onChange={setConfirmation}/>
       <Button disabled={(!canEvaluate&&!consent.enabled)||confirmation!==(consent.enabled?'DISABLE_OUTCOMES':'ENABLE_OUTCOMES')} onClick={()=>act('consent')}>{consent.enabled?'Revoke outcome consent':'Enable outcome consent'}</Button></>:null}
     {consent.enabled&&canEvaluate&&!busy?<><Flex direction="row" gap="small"><Input name="outcome-quarter" label="Mature quarter (YYYY-Qn)" value={quarter} onChange={setQuarter}/><Input name="outcome-pipeline" label="Pipeline ID" value={pipeline} onChange={setPipeline}/><Input name="outcome-policy" label="Policy version ID" value={policy} onChange={setPolicy}/></Flex>
       <Button disabled={!quarter||!pipeline||!policy} onClick={()=>act('build')}>Build historical dataset</Button>
       <Text>Choose distinct, time-ordered datasets from the same pipeline and policy. Each later split excludes deals seen in earlier splits.</Text>
       <Flex direction="row" gap="small"><Input name="outcome-train" label="Training dataset ID" value={train} onChange={setTrain}/><Input name="outcome-calibration" label="Calibration dataset ID" value={calibration} onChange={setCalibration}/><Input name="outcome-holdout" label="Holdout dataset ID" value={holdout} onChange={setHoldout}/></Flex>
       <Button disabled={!train||!calibration||!holdout||new Set([train.trim(),calibration.trim(),holdout.trim()]).size!==3} onClick={()=>act('evaluate')}>Queue held-out evaluation</Button><Text>Training runs in a bounded background job. Queued and running jobs have no metrics yet; failed or cancelled jobs cannot qualify a model.</Text></>:null}
     <Heading>Dataset manifests</Heading>{datasets.length?datasets.map(d=><Text key={d.id}>{d.id} · {d.manifest.quarter} · {d.manifest.sampleCount} observations · pipeline {d.manifest.pipelineId}</Text>):<Text>No retained datasets available under current consent.</Text>}
     <Heading>Evaluation reports</Heading>{evaluations.length?evaluations.map(e=><Flex key={e.id} direction="column" gap="extra-small"><Text format={{fontWeight:'bold'}}>{e.report.status.replaceAll('_',' ')} · {e.id}</Text><Text>{e.report.reason??'No qualification decision available.'}</Text>
       {Array.isArray(e.report.counts)?<><Text>Training / calibration / holdout observations: {e.report.counts.join(' / ')}. Overlapping deals excluded: {e.report.duplicatesExcluded?.join(' / ')??'Unavailable'}.</Text><Text>Model Brier score {number(e.report.model?.brier)}; baseline {number(e.report.baseline?.brier)}. Lower is better.</Text><Text>Model log loss {number(e.report.model?.logLoss)}; baseline {number(e.report.baseline?.logLoss)}. Lower is better.</Text><Text>Calibration error {number(e.report.model?.ece)}; AUC {number(e.report.model?.auc)}.</Text><Text>Approximate Brier-difference interval: {e.report.brierDifferenceInterval?.map(v=>number(v)).join(' to ')??'Unavailable'}. This is historical validation, not a causal or revenue-impact estimate.</Text></>:<Text>Attempts: {e.report.attempts??0}. No completed metrics are available. Reload administration to check progress.</Text>}
     </Flex>):<Text>No evaluation reports available. A forecast requires a completed qualified evaluation, independent review and current monitoring.</Text>}
   </>:null}
 </Flex></Card>;
}
