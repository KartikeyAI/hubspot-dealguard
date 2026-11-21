import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Flex, Heading, LoadingSpinner, StatusTag, Text, hubspot } from '@hubspot/ui-extensions';
import { safeProductError } from './product-ui';
type Checklist={generatedAt:string;liveAcceptanceVerified:false;checks:Array<{code:string;state:string;title:string;detail:string}>;
 missingRequiredScopes:string[];scopeProvenance:string;recordedEvidence:{deals:number;openDeals:number;latestAssessmentAge:string};
 billing:{recordedTier:string;effectiveTier:string;status:string;interval:string|null;usageMode:string};
 limits:{dealsPerScan:number;minimumScanIntervalMinutes:number;historyDays:number};nextStep:string;dataBoundary:string};
export function OnboardingChecklistPanel({enabled}:{enabled:boolean}){
 const [value,setValue]=useState<Checklist|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),epoch=useRef(0);
 useEffect(()=>{if(!enabled){setValue(null);setBusy(false);}return()=>{epoch.current++;};},[enabled]);
 const load=async()=>{if(!enabled||busy)return;const version=++epoch.current;setBusy(true);setError(null);setValue(null);
  try{const response=await hubspot.fetch('https://dealguard-api.rokad.co/api/v1/onboarding',{method:'GET',timeout:20000});const result=await response.json();
   if(!response.ok)throw new Error(safeProductError(result?.error?.message));if(version===epoch.current)setValue(result);
  }catch(e){if(version===epoch.current)setError(safeProductError(e instanceof Error?e.message:undefined));}finally{if(version===epoch.current)setBusy(false);}};
 if(!enabled)return null;
 return <Card><Flex direction="column" gap="small"><Heading>Self-service setup checklist</Heading>
  <Text>Review the recorded grant, configuration, initial scan and optional consent without starting a scan or contacting a provider.</Text>
  <Button disabled={busy} onClick={load}>Check installation readiness</Button>
  {busy?<LoadingSpinner label="Checking recorded installation evidence"/>:null}{error?<Alert title="Setup checklist unavailable" variant="warning">{error}</Alert>:null}
  {value?<><Text>Recorded at {value.generatedAt}. Suggested next step: {value.nextStep.replaceAll('_',' ')}.</Text>
   {value.checks.map(c=><Flex key={c.code} direction="column" gap="extra-small"><Flex direction="row" gap="small"><Text format={{fontWeight:'bold'}}>{c.title}</Text><StatusTag variant={c.state==='complete'?'success':c.state==='action_required'?'warning':'default'}>{c.state.replaceAll('_',' ')}</StatusTag></Flex><Text>{c.detail}</Text></Flex>)}
   {value.missingRequiredScopes.length?<Text>Missing recorded permissions: {value.missingRequiredScopes.join(', ')}</Text>:null}
   <Text>Recorded plan: {value.billing.recordedTier}; currently effective plan: {value.billing.effectiveTier}. Billing status: {value.billing.status}. Interval: {value.billing.interval??'No subscription interval recorded'}.</Text>
   <Text>Current plan limits: {value.limits.dealsPerScan} deals per scan; at least {value.limits.minimumScanIntervalMinutes} minutes between scans; {value.limits.historyDays} days of history.</Text>
   <Text>{value.recordedEvidence.openDeals} recorded open deals. Latest open-deal assessment age: {value.recordedEvidence.latestAssessmentAge}.</Text>
   <Text>{value.dataBoundary}</Text><Text>Use the existing Home scan controls, connected-project settings and billing controls to complete the listed steps. A successful checklist is not production certification.</Text>
  </>:null}
 </Flex></Card>;
}
