import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Flex, Heading, Input, LoadingSpinner, Text, hubspot } from '@hubspot/ui-extensions';
import { safeProductError } from './product-ui';
const ROOT='https://dealguard-api.rokad.co/api/v1/enterprise/breeze';
type Status={enabled:boolean;revision:number;dailyLimit:number;approvedTools:string[];disclosure:string};
export function BreezeAdministrationPanel({enabled,canEnable=true}:{enabled:boolean;canEnable?:boolean}){
 const [status,setStatus]=useState<Status|null>(null),[confirmation,setConfirmation]=useState(''),[limit,setLimit]=useState('200');
 const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),epoch=useRef(0);
 useEffect(()=>{setStatus(null);setBusy(false);setError(null);setConfirmation('');return()=>{epoch.current++;};},[enabled,canEnable]);
 const act=async(write=false)=>{
   if(!enabled||busy||(write&&!canEnable&&!status?.enabled))return;const version=++epoch.current;setBusy(true);setError(null);
   try{
     const response=await hubspot.fetch(ROOT,{method:write?'PUT':'GET',timeout:20000,
       ...(write?{body:{enabled:!status?.enabled,revision:status?.revision,dailyLimit:Number(limit),confirmation}}:{})});
     const result=await response.json();if(!response.ok)throw new Error(safeProductError(result?.error?.message));
     if(version!==epoch.current)return;setStatus(result);setLimit(String(result.dailyLimit));setConfirmation('');
   }catch(e){if(version===epoch.current)setError(safeProductError(e instanceof Error?e.message:undefined));}
   finally{if(version===epoch.current)setBusy(false);}
 };
 if(!enabled)return null;
 return <Card><Flex direction="column" gap="small"><Heading>Optional agent-tool consent</Heading>
   <Text>Breeze availability, tool approval and portal consent are separate from native AI assistance. Unapproved components remain outside the production HubSpot project.</Text>
   <Button disabled={busy} onClick={()=>act()}>Load agent-tool administration</Button>
   {busy?<LoadingSpinner label="Checking optional agent controls"/>:null}{error?<Alert title="Agent controls unavailable" variant="warning">{error}</Alert>:null}
   {status?<><Text>{status.disclosure}</Text><Text>{status.enabled?'Portal consent enabled':'Portal consent disabled'} · approved bindings: {status.approvedTools.join(', ')||'None configured'}</Text>
     <Text>Enabling consent does not upload or publish a tool. The service also requires a validated action-definition binding and breeze.use permission.</Text>
     {!busy?<><Input name="breeze-limit" label="Daily read invocation limit" value={limit} onChange={setLimit}/>
       <Input name="breeze-confirm" label={`Type ${status.enabled?'DISABLE_BREEZE':'ENABLE_BREEZE'}`} value={confirmation} onChange={setConfirmation}/>
       <Button disabled={(!canEnable&&!status.enabled)||confirmation!==(status.enabled?'DISABLE_BREEZE':'ENABLE_BREEZE')} onClick={()=>act(true)}>{status.enabled?'Revoke agent-tool consent':'Enable agent-tool consent'}</Button></>:null}</>:null}
 </Flex></Card>;
}
