import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Flex, Heading, Input, LoadingSpinner, Select, Text, hubspot } from '@hubspot/ui-extensions';
import { safeProductError } from './product-ui';

const ROOT = 'https://dealguard-api.rokad.co/api/v1/enterprise/forecast';
type Model = { id:string; state:string; pipelineId:string; policyId:string; expiresAt:string;
  artifactFingerprint:string; evaluationId:string; requestedBy:string; reviewedBy:string|null;
  reviewerAuthorized:boolean; suspensionReason:string|null;
  evaluationReport:{status?:string;model?:{brier?:number};baseline?:{brier?:number}};
  monitor:{status:string;checkedAt:string;expiresAt:string;report:{reason?:string}}|null };
type Status = { globalEnabled:boolean; controls:{enabled:boolean;revision:number}; models:Model[];
  predictionsEnabled:boolean; quarter:string; reviewBoundary:string;
  outcomeReports:Array<{model_id:string;quarter:string;observed_at:string;report:{status?:string;reason?:string}}> };
type Forecast = { status:'eligible'|'unavailable'; reason:string|null; probability:number|null;
  target:string; quarter:string; anchorAt:string; horizonAt:string; modelId:string|null; modelVersion:string;
  evidenceAt:string|null; assessmentAt:string|null; estimateOrigin:'quarter_start'; limitations:string[];
  uncertainty:{calibrationSamples:number;observedRate:number|null;observedRateInterval:number[]|null;support:string}|null };
const when = (value:string|null) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : 'Unavailable';
const percent = (value:number|null|undefined) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? `${(100*value).toFixed(1)}%` : 'Unavailable';
const score = (value:number|undefined) => typeof value === 'number' && Number.isFinite(value) ? value.toFixed(4) : 'Unavailable';

export function ForecastAdministrationPanel({canForecast,canInspect,canAdminister,canReview,entitled}:
  {canForecast:boolean;canInspect:boolean;canAdminister:boolean;canReview:boolean;entitled:boolean}) {
  const [status,setStatus] = useState<Status|null>(null), [forecast,setForecast] = useState<Forecast|null>(null);
  const [deal,setDeal] = useState(''), [evaluation,setEvaluation] = useState(''), [expiry,setExpiry] = useState('');
  const [modelId,setModelId] = useState(''), [decision,setDecision] = useState('approve'), [digest,setDigest] = useState('');
  const [controlConfirmation,setControlConfirmation] = useState(''), [registerConfirmation,setRegisterConfirmation] = useState(''), [reviewConfirmation,setReviewConfirmation] = useState('');
  const [busy,setBusy] = useState(false), [error,setError] = useState<string|null>(null), [notice,setNotice] = useState<string|null>(null);
  const epoch = useRef(0), inFlight = useRef(false);
  useEffect(()=>{setStatus(null);setForecast(null);setBusy(false);setNotice(null);setError(null);inFlight.current=false;
    return()=>{epoch.current++;inFlight.current=false;};},[canForecast,canInspect,canAdminister,canReview,entitled]);

  const call = async (path:string,method:'GET'|'PUT'|'POST'='GET',body?:Record<string,unknown>) => {
    const response=await hubspot.fetch(ROOT+path,{method,timeout:20000,...(body?{body}:{})});
    const result=await response.json();
    if(!response.ok)throw new Error(safeProductError(result?.error?.message));
    return result;
  };
  const act = async (action:'deal'|'status'|'controls'|'register'|'review') => {
    if(inFlight.current || (action==='deal'?!canForecast:!canInspect)
      || (['controls','register'].includes(action)&&!canAdminister)
      || (action==='review'&&!canReview) || (['register','review'].includes(action)&&!entitled)) return;
    const version=++epoch.current;inFlight.current=true;setBusy(true);setError(null);setNotice(null);
    if(action==='deal')setForecast(null);
    try {
      let message:string|null=null;
      if(action==='deal') {
        const result=await call(`/deal?dealId=${encodeURIComponent(deal.trim())}`);
        if(version!==epoch.current)return;
        setForecast(result);return;
      }
      if(action==='controls') {
        if(!status || (!status.controls.enabled&&!entitled))return;
        await call('/controls','PUT',{enabled:!status.controls.enabled,revision:status.controls.revision,confirmation:controlConfirmation});
        message='Forecast controls updated. Each deal still requires current eligibility checks.';
      }
      if(action==='register') {
        const result=await call('/models','POST',{evaluationId:evaluation.trim(),expiresAt:expiry.trim(),confirmation:registerConfirmation});
        message=`Candidate ${result.id} registered. Current monitoring and an independent reviewer are required before activation.`;
      }
      if(action==='review') {
        const model=status?.models.find(item=>item.id===modelId);
        if(!model)throw new Error('Load and select the exact candidate before reviewing.');
        await call('/review','POST',{modelId:model.id,artifactFingerprint:model.artifactFingerprint,decision,evidenceSha256:digest.trim(),confirmation:reviewConfirmation});
        message='Review recorded. Approval does not enable either forecast switch and does not provide production release sign-off.';
      }
      if(version!==epoch.current)return;
      const result=await call('/status');
      if(version!==epoch.current)return;
      setStatus(result);setNotice(message);setForecast(null);
      setControlConfirmation('');setRegisterConfirmation('');setReviewConfirmation('');
    } catch(e) {
      if(version===epoch.current)setError(safeProductError(e instanceof Error?e.message:undefined));
    } finally {
      if(version===epoch.current){inFlight.current=false;setBusy(false);}
    }
  };
  const selected=status?.models.find(model=>model.id===modelId);
  const controlPhrase=status?.controls.enabled?'DISABLE_FORECASTS':'ENABLE_FORECASTS';
  const reviewPhrase=decision==='approve'?'APPROVE_FORECAST':'REJECT_FORECAST';
  if(!canForecast&&!canInspect)return null;
  return <Card><Flex direction="column" gap="small">
    <Heading>Qualified quarter-start forecast</Heading>
    <Text>This optional estimate targets a recorded closed-won state at quarter end. It uses retained quarter-start evidence, separate from readiness and management priority. Unavailable evidence never becomes a zero probability.</Text>
    {canForecast?<><Input name="forecast-deal" label="HubSpot deal ID" value={deal} readOnly={busy} onChange={value=>{setDeal(value);setForecast(null);setError(null);}}/>
      <Button disabled={busy||!/^\d+$/.test(deal.trim())} onClick={()=>act('deal')}>Check deal forecast eligibility</Button></>:null}
    {canInspect?<Button disabled={busy} onClick={()=>act('status')}>Load forecast administration</Button>:null}
    {busy?<LoadingSpinner label="Checking forecast evidence and permissions"/>:null}
    {error?<Alert title="Forecast unavailable" variant="warning">{error}</Alert>:null}
    {notice?<Alert title="Forecast status updated" variant="info">{notice}</Alert>:null}
    {forecast?<><Heading>{forecast.status==='eligible'?'Eligible forecast':'Forecast unavailable'}</Heading>
      <Text>Quarter {forecast.quarter} · target: recorded closed-won at quarter end.</Text>
      <Text>Probability: {forecast.status==='eligible'?percent(forecast.probability):'Unavailable'}{forecast.reason?` · ${forecast.reason.replaceAll('_',' ')}`:''}</Text>
      <Text>Quarter anchor {when(forecast.anchorAt)} · horizon {when(forecast.horizonAt)}.</Text>
      {forecast.status==='eligible'?<><Text>Model {forecast.modelId} · {forecast.modelVersion}. Anchor evidence {when(forecast.evidenceAt)}; current assessment {when(forecast.assessmentAt)}.</Text>
        <Text>Held-out calibration: {forecast.uncertainty?.calibrationSamples??'Unavailable'} observations in this probability bin · {forecast.uncertainty?.support??'unavailable'} support.</Text>
        <Text>Observed bin outcome rate: {percent(forecast.uncertainty?.observedRate)}. 95% historical rate interval: {forecast.uncertainty?.observedRateInterval?.map(percent).join(' to ')??'Unavailable'}. This is not an individual deal confidence interval.</Text></>:null}
      {forecast.limitations.map((limitation,index)=><Text key={index}>{limitation}</Text>)}
    </>:null}
    {status?<><Heading>Forecast controls and review</Heading>
      <Text>Global switch {status.globalEnabled?'enabled':'disabled'} · workspace switch {status.controls.enabled?'enabled':'disabled'} · revision {status.controls.revision}.</Text>
      <Text>{status.predictionsEnabled?'At least one model meets workspace activation gates. Each deal is checked separately.':'Predictions are unavailable under the current switches, approvals or monitoring.'}</Text>
      <Text>{status.reviewBoundary}</Text>
      {canAdminister?<><Input name="forecast-control-confirm" label={`Type ${controlPhrase}`} value={controlConfirmation} readOnly={busy} onChange={setControlConfirmation}/>
        <Button disabled={busy||(!entitled&&!status.controls.enabled)||controlConfirmation!==controlPhrase} onClick={()=>act('controls')}>{status.controls.enabled?'Disable workspace forecasts':'Enable workspace forecast switch'}</Button>
        {!entitled?<Text>Subscription access has expired. Disabling remains available; registration, approval and prediction do not.</Text>:null}
        <Heading>Register a qualified candidate</Heading>
        <Text>Use a completed qualified evaluation from the last seven days and a future expiry within thirty days. Registration does not approve or activate a model.</Text>
        <Input name="forecast-evaluation" label="Completed evaluation ID" value={evaluation} readOnly={busy||!entitled} onChange={setEvaluation}/>
        <Input name="forecast-expiry" label="Expiry (ISO timestamp with timezone)" value={expiry} readOnly={busy||!entitled} onChange={setExpiry}/>
        <Input name="forecast-register-confirm" label="Type REGISTER_FORECAST_CANDIDATE" value={registerConfirmation} readOnly={busy||!entitled} onChange={setRegisterConfirmation}/>
        <Button disabled={busy||!entitled||!evaluation.trim()||!Number.isFinite(Date.parse(expiry))||registerConfirmation!=='REGISTER_FORECAST_CANDIDATE'} onClick={()=>act('register')}>Register candidate</Button>
      </>:null}
      <Heading>Candidate and active models</Heading>
      {status.models.length?status.models.map(model=><Flex key={model.id} direction="column" gap="extra-small">
        <Text format={{fontWeight:'bold'}}>{model.state.replaceAll('_',' ')} · {model.id}</Text>
        <Text>Pipeline {model.pipelineId} · policy {model.policyId} · expiry {when(model.expiresAt)}.</Text>
        <Text>Evaluation {model.evaluationId} · {model.evaluationReport?.status??'unavailable'}. Brier model {score(model.evaluationReport?.model?.brier)}, baseline {score(model.evaluationReport?.baseline?.brier)}; lower is better.</Text>
        <Text>Artifact fingerprint: {model.artifactFingerprint}</Text>
        <Text>Registration requester {model.requestedBy} · reviewer {model.reviewedBy??'none'} · reviewer currently authorized: {model.reviewerAuthorized?'yes':'no'}.</Text>
        <Text>Monitoring {model.monitor?.status??'pending'} · checked {when(model.monitor?.checkedAt??null)} · expires {when(model.monitor?.expiresAt??null)}{model.monitor?.report?.reason?` · ${model.monitor.report.reason.replaceAll('_',' ')}`:''}.</Text>
        {model.suspensionReason?<Text>Suspension reason: {model.suspensionReason.replaceAll('_',' ')}</Text>:null}
      </Flex>):<Text>No retained candidates. Build and evaluate governed historical datasets before registration.</Text>}
      <Text>Monitoring runs through the background maintenance worker. Missing, expired or drifted monitoring blocks predictions; reloading this panel does not run training or monitoring.</Text>
      {canReview&&status.models.some(model=>model.state==='pending')?<><Heading>Independent evidence review</Heading>
        <Text>The reviewer must differ from both the evaluation requester and candidate registrant. Independently validate the artifact and monitoring, then supply the SHA-256 digest of your retained review evidence. DealGuard does not manufacture that evidence or its approval.</Text>
        <Select name="forecast-model" label="Pending candidate" options={status.models.filter(model=>model.state==='pending').map(model=>({label:model.id,value:model.id}))} value={modelId} readOnly={busy||!entitled} onChange={value=>{setModelId(String(value));setReviewConfirmation('');setDigest('');}}/>
        {selected?<Text>Reviewing fingerprint {selected.artifactFingerprint}; monitoring {selected.monitor?.status??'pending'}.</Text>:null}
        <Select name="forecast-review-decision" label="Review decision" options={[{label:'Approve',value:'approve'},{label:'Reject',value:'reject'}]} value={decision} readOnly={busy||!entitled} onChange={value=>{setDecision(String(value));setReviewConfirmation('');}}/>
        <Input name="forecast-review-digest" label="Independent review evidence SHA-256" value={digest} readOnly={busy||!entitled} onChange={setDigest}/>
        <Input name="forecast-review-confirm" label={`Type ${reviewPhrase}`} value={reviewConfirmation} readOnly={busy||!entitled} onChange={setReviewConfirmation}/>
        <Button disabled={busy||!entitled||!selected||!/^[a-f0-9]{64}$/.test(digest.trim())||reviewConfirmation!==reviewPhrase} onClick={()=>act('review')}>Record independent review</Button>
      </>:null}
      <Heading>Observed outcome monitoring</Heading>
      {status.outcomeReports.length?status.outcomeReports.map((report,index)=><Text key={index}>{report.quarter} · model {report.model_id} · {report.report.status??'recorded'} · observed {when(report.observed_at)}{report.report.reason?` · ${report.report.reason.replaceAll('_',' ')}`:''}</Text>):<Text>No mature outcome reports are available. Missing outcomes are excluded rather than counted as losses.</Text>}
    </>:null}
  </Flex></Card>;
}
