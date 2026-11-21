import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Flex, Heading, Input, LoadingSpinner, Select, Text, hubspot } from '@hubspot/ui-extensions';
import { safeProductError } from './product-ui';
const ROOT='https://dealguard-api.rokad.co/api/v1/enterprise/ai';
type Status={consent:{enabled:boolean;revision:number};configurationReady:boolean;model:string|null;
  limits:{dailyRequests:number;dailyBudgetMicroUsd:number;concurrentRequests:number};
  usage:{day:string;requests:number;reservedMicroUsd:number;accountedMicroUsd:number};dataUse:string;costAccounting:string;retention:string};
type Draft={cached:boolean;model:string;assessmentAt:string;requiresHumanReview:true;actionsExecuted:false;
  handoverCycle?:number|null;facts:Array<{id:string;kind:string;value:string|number|boolean;sourceAt?:string|null}>;draft:{sections:Array<{heading:string;text:string;evidenceIds:string[]}>}};
const observed=(value:string)=>Number.isFinite(Date.parse(value))?new Date(value).toLocaleString():'Unknown observation time';
export function IntelligenceAssistancePanel({enabled,canGenerate=true,canAdminister=false}:{enabled:boolean;canGenerate?:boolean;canAdminister?:boolean}){
 const [status,setStatus]=useState<Status|null>(null),[draft,setDraft]=useState<Draft|null>(null);
 const [deal,setDeal]=useState(''),[purpose,setPurpose]=useState('risk'),[confirmation,setConfirmation]=useState('');
 const [daily,setDaily]=useState('25'),[budget,setBudget]=useState('5'),[concurrent,setConcurrent]=useState('2');
 const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),epoch=useRef(0);
 useEffect(()=>{setStatus(null);setDraft(null);setBusy(false);return()=>{epoch.current++;};},[enabled,canGenerate,canAdminister]);
 const updateDeal=(v:string)=>{epoch.current++;setBusy(false);setDraft(null);setDeal(v);};
 const request=async(action:'load'|'consent'|'limits'|'assist')=>{
   if(!enabled||busy||(action==='assist'?!canGenerate:!canAdminister))return;const version=++epoch.current;setBusy(true);setError(null);if(action==='assist')setDraft(null);
   const data=action==='consent'?{enabled:!status?.consent.enabled,revision:status?.consent.revision,confirmation}:
     action==='limits'?{revision:status?.consent.revision,dailyRequests:Number(daily),dailyBudgetMicroUsd:Math.round(Number(budget)*1000000),concurrentRequests:Number(concurrent)}:
     action==='assist'?{dealId:deal.trim(),purpose,requestKey:`dg_${Date.now()}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`} : undefined;
   try{
     const response=await hubspot.fetch(`${ROOT}/${action==='load'?'status':action}`,{method:action==='load'?'GET':action==='assist'?'POST':'PUT',timeout:20000,...(data?{body:data}:{})});
     const result=await response.json();if(!response.ok)throw new Error(safeProductError(result?.error?.message));
     if(version!==epoch.current)return;
     if(action==='assist')setDraft(result);else{
       const statusResponse=action==='load'||action==='limits'?result:await(await hubspot.fetch(ROOT+'/status',{method:'GET',timeout:20000})).json();
       if(version!==epoch.current)return;
       if(!statusResponse?.consent||!statusResponse?.limits)throw new Error('Reload the intelligence controls.');
       setStatus(statusResponse);setDaily(String(statusResponse.limits.dailyRequests));setBudget(String(statusResponse.limits.dailyBudgetMicroUsd/1000000));setConcurrent(String(statusResponse.limits.concurrentRequests));setConfirmation('');setDraft(null);
     }
   }catch(e){if(version===epoch.current)setError(safeProductError(e instanceof Error?e.message:undefined));}
   finally{if(version===epoch.current)setBusy(false);}
 };
 if(!enabled)return null;
 return <Card><Flex direction="column" gap="small"><Heading>Evidence-grounded review assistant</Heading>
   <Text>Optional drafts from eligible recorded deal evidence, including closed-won handover. These do not update CRM fields, create work, send messages, or predict revenue. Review every draft against its cited evidence.</Text>
   {!busy?<Flex direction="row" gap="small"><Input name="ai-deal" label="HubSpot deal ID" value={deal} onChange={updateDeal}/>
     <Select name="ai-purpose" label="Draft purpose" value={purpose} options={[{label:'Explain risk',value:'risk'},{label:'Prepare manager review',value:'manager_review'},{label:'Explain next action',value:'next_action'},{label:'Draft handover',value:'handover'}]}
       onChange={v=>{setPurpose(String(v));setDraft(null);}}/></Flex>:null}
   <Flex direction="row" gap="small"><Button disabled={!canGenerate||busy||!/^\d+$/.test(deal.trim())} onClick={()=>request('assist')}>Generate review draft</Button>
     {canAdminister && <Button disabled={busy} onClick={()=>request('load')}>Load administrator controls</Button>}</Flex>
   {!canGenerate?<Text>New assistance is unavailable on the current subscription. Administrator consent revocation remains available.</Text>:null}
   <Text>The server requires explicit portal consent and ai.use permission. Deterministic DealGuard remains usable when AI is off.</Text>
   {busy?<LoadingSpinner label="Checking evidence and generating a bounded draft"/>:null}
   {error?<Alert title="Optional assistance unavailable" variant="warning">{error}</Alert>:null}
   {draft?<><Text>Assessment observed {observed(draft.assessmentAt)} · model {draft.model} · {draft.cached?'cached draft':'new draft'}{draft.handoverCycle!=null?` · handover cycle ${draft.handoverCycle}`:''}</Text>
     <Heading>Recorded evidence</Heading>{draft.facts.map(f=><Text key={f.id}>{f.id}: {String(f.value)}{f.sourceAt?` · observed ${observed(f.sourceAt)}`:''}</Text>)}
     {draft.draft.sections.map((s,i)=><Flex key={i} direction="column" gap="extra-small"><Text format={{fontWeight:'bold'}}>{s.heading.replaceAll('_',' ')}</Text><Text>{s.text}</Text><Text>Cites: {s.evidenceIds.join(', ')}</Text></Flex>)}
     <Text>Draft only. No action was executed. Evidence citations establish provenance, not a guarantee that generated prose is correct.</Text></>:null}
   {status?<><Heading>Administrator controls</Heading><Text>{status.consent.enabled?'Consent enabled':'Consent disabled'} · {status.configurationReady?'Provider configuration ready':'Approved provider configuration unavailable'} · revision {status.consent.revision}</Text>
     <Text>{status.dataUse}</Text><Text>{status.retention}</Text><Text>{status.costAccounting}</Text>
     <Text>UTC {status.usage.day}: {status.usage.requests} requests · ${(status.usage.accountedMicroUsd/1000000).toFixed(4)} estimated cost accounted · ${(status.usage.reservedMicroUsd/1000000).toFixed(4)} reserved.</Text>
     {!busy?<><Input name="ai-confirm" label={`Type ${status.consent.enabled?'DISABLE_AI':'ENABLE_AI'} to change consent`} value={confirmation} onChange={setConfirmation}/>
       <Button disabled={(!canGenerate&&!status.consent.enabled)||confirmation!==(status.consent.enabled?'DISABLE_AI':'ENABLE_AI')} onClick={()=>request('consent')}>{status.consent.enabled?'Disable optional AI':'Enable optional AI consent'}</Button>
       <Flex direction="row" gap="small"><Input name="ai-daily" label="Daily request cap" value={daily} onChange={setDaily}/><Input name="ai-budget" label="Daily estimated provider budget (USD)" value={budget} onChange={setBudget}/><Input name="ai-concurrent" label="Concurrent request cap" value={concurrent} onChange={setConcurrent}/></Flex>
       <Button disabled={!canGenerate} onClick={()=>request('limits')}>Save limits and invalidate prior drafts</Button></>:null}</>:null}
 </Flex></Card>;
}
