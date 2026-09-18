import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Flex, Heading, LoadingSpinner, Text, hubspot } from '@hubspot/ui-extensions';
import { safeProductError } from './product-ui';
const ROOT = 'https://dealguard-api.rokad.co/api/v1/enterprise/webhook-inbox';
type Row = { status: string; count: number; oldest_received_at: string | null };
export function WebhookHealthPanel({ enabled }: { enabled: boolean }) {
  const [rows,setRows]=useState<Row[]|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const requestId=useRef(0);
  useEffect(()=>{setRows(null);setBusy(false);return()=>{requestId.current++;};},[enabled]);
  const load=async(retry=false)=>{
    if(!enabled||busy)return;
    const id=++requestId.current;setBusy(true);setError(null);
    try{
      if(retry){const r=await hubspot.fetch(`${ROOT}/retry`,{method:'POST',timeout:20000});const b=await r.json();if(!r.ok)throw new Error(safeProductError(b?.error?.message));}
      const r=await hubspot.fetch(ROOT,{method:'GET',timeout:20000});const b=await r.json();if(!r.ok)throw new Error(safeProductError(b?.error?.message));
      if(id===requestId.current)setRows(b.statuses);
    }catch(e){if(id===requestId.current)setError(safeProductError(e instanceof Error?e.message:undefined));}
    finally{if(id===requestId.current)setBusy(false);}
  };
  if(!enabled)return null;
  return <Card><Flex direction="column" gap="small">
    <Heading>CRM event processing</Heading>
    <Text>Signed HubSpot events are stored before acknowledgment. Archive and restore events are verified against HubSpot; a missing record alone is not counted as a lost sale.</Text>
    <Button disabled={busy} onClick={()=>load()}>Load event status</Button>
    {busy?<LoadingSpinner label="Loading event processing status"/>:null}
    {error?<Alert title="Event controls unavailable" variant="warning">{error}</Alert>:null}
    {rows?<><Text>{rows.map(r=>`${r.status}: ${r.count}`).join(' · ')||'No retained events'}</Text>
      <Button disabled={busy||!rows.some(r=>r.status==='dead_letter'&&r.count>0)} onClick={()=>load(true)}>Retry up to 100 failed events</Button>
      <Text>Retries require portal-wide scan permission. Provider failures can delay reconciliation. Unresolved events remain visible after automatic retries are exhausted.</Text></>:null}
  </Flex></Card>;
}
