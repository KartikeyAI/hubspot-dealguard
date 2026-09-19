import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Checkbox, Divider, Flex, Heading, Input, LoadingSpinner, Select, Text, TextArea, hubspot } from '@hubspot/ui-extensions';
import { safeProductError } from './product-ui';
const ROOT='https://dealguard-api.rokad.co/api/v1';
type Case={id:string;dealId:string;title:string;description:string;status:string;priority:string;ownerId:string|null;dueAt:string|null;
 evidenceRequired:boolean;acknowledgementRequired:boolean;evidenceStatus:string};
type Detail={case:Case;comments:Array<{id:string;body:string}>;evidence:Array<{id:string;label:string;value:string}>;
 linkedRecommendations:Array<{recommendation_id:string}>;truncated:boolean};
type Summary={open:number;overdue:number;critical:number;dueSoon:number;averageResolutionHours:number|null;resolutionObservations:number};
async function request(path:string,method:'GET'|'POST'|'PUT'='GET',body?:Record<string,unknown>) {
 const response=await hubspot.fetch(`${ROOT}${path}`,{method,timeout:20000,...(body?{body}:{})});
 const data=await response.json();if(!response.ok)throw new Error(safeProductError(data?.error?.message));return data;
}
export function RemediationWorkPanel({enabled}:{enabled:boolean}) {
 const [permissions,setPermissions]=useState<string[]>([]),[cases,setCases]=useState<Case[]>([]),[summary,setSummary]=useState<Summary|null>(null);
 const [detail,setDetail]=useState<Detail|null>(null),[caseId,setCaseId]=useState(''),[filter,setFilter]=useState('open'),[page,setPage]=useState(0);
 const [note,setNote]=useState(''),[owner,setOwner]=useState(''),[due,setDue]=useState(''),[evidenceLabel,setEvidenceLabel]=useState(''),[evidenceText,setEvidenceText]=useState('');
 const [evidenceRequired,setEvidenceRequired]=useState(false),[ackRequired,setAckRequired]=useState(false);
 const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[notice,setNotice]=useState<string|null>(null);
 const epoch=useRef(0);
 useEffect(()=>{if(!enabled){setDetail(null);setCases([]);setSummary(null);setPermissions([]);setBusy(false);}return()=>{epoch.current+=1;};},[enabled]);
 const can=(permission:string)=>permissions.includes('*')||permissions.includes(permission);
 const adopt=(d:Detail)=>{setDetail(d);setCaseId(d.case.id);setOwner(d.case.ownerId??'');setDue(d.case.dueAt??'');setEvidenceRequired(d.case.evidenceRequired);setAckRequired(d.case.acknowledgementRequired);};
 const run=async(work:()=>Promise<unknown>,apply:(value:any)=>void,message?:string)=>{
  if(!enabled||busy)return;const token=++epoch.current;setBusy(true);setError(null);setNotice(null);
  try{const value=await work();if(token===epoch.current){apply(value);if(message)setNotice(message);}}
  catch(problem){if(token===epoch.current)setError(safeProductError(problem instanceof Error?problem.message:undefined));}
  finally{if(token===epoch.current)setBusy(false);}
 };
 const load=()=>run(async()=>{
  const access=await request('/enterprise/access');
  if(!access.entitled || !Array.isArray(access.permissions) || !access.permissions.some((p:string)=>p==='*'||p==='remediation.view'))throw new Error('Your role cannot view remediation work.');
  const [items,totals]=await Promise.all([request(`/remediations?status=${encodeURIComponent(filter)}`),request('/remediations/summary')]);
  return {items,totals,permissions:access.permissions};
 },v=>{setCases(v.items.cases??[]);setSummary(v.totals);setPermissions(v.permissions);setPage(0);setDetail(null);});
 const open=(id:string)=>run(()=>request(`/remediations/${encodeURIComponent(id)}/detail`),adopt);
 const act=(action:string,body:Record<string,unknown>={},method:'POST'|'PUT'='POST')=>{
  if(!detail)return;const id=detail.case.id;
  return run(async()=>{await request(`/remediations/${encodeURIComponent(id)}/${action}`,method,body);return request(`/remediations/${encodeURIComponent(id)}/detail`);},v=>{adopt(v);setNote('');},'Case updated. Reload the list to refresh summary counts.');
 };
 if(!enabled)return null;
 const item=detail?.case,active=item?['open','acknowledged','in_progress','overdue'].includes(item.status):false;
 return <Card><Flex direction="column" gap="small">
  <Heading>Accountable remediation work</Heading>
  <Text>Manage linked recommendations and evidence-backed cases within your current deal scope. Completing a recommendation does not resolve its case or prove revenue impact.</Text>
  {!busy?<Select name="case-status-filter" label="Case status" value={filter} options={['open','acknowledged','in_progress','overdue','resolved','waived','closed'].map(value=>({label:value,value}))} onChange={v=>setFilter(String(v))}/>:null}
  <Button disabled={busy} onClick={load}>Load remediation work</Button>
  {busy?<LoadingSpinner label="Updating remediation work"/>:null}
  {error?<Alert title="Remediation action unavailable" variant="warning">{error}</Alert>:null}
  {notice?<Alert title="Remediation" variant="success">{notice}</Alert>:null}
  {summary?<>
   <Text>{summary.open} open · {summary.overdue} overdue · {summary.dueSoon} due within 24 hours. Mean recorded resolution duration: {summary.averageResolutionHours===null?'Unavailable':`${summary.averageResolutionHours} hours`} ({summary.resolutionObservations} observations).</Text>
   {cases.slice(page*10,(page+1)*10).map(c=><Flex direction="row" gap="small" key={c.id}><Text>{c.title} · {c.status} · {c.priority}</Text><Button disabled={busy} variant="secondary" onClick={()=>open(c.id)}>Open case</Button></Flex>)}
   {!cases.length?<Text>No cases match this status in your current scope.</Text>:null}
   <Flex direction="row" gap="small"><Button disabled={busy||page===0} onClick={()=>setPage(n=>n-1)}>Previous cases</Button><Text>{cases.length} matching cases</Text><Button disabled={busy||(page+1)*10>=cases.length} onClick={()=>setPage(n=>n+1)}>Next cases</Button></Flex>
   <Input name="case-id" label="Open a linked case by its case ID" value={caseId} onChange={setCaseId}/><Button disabled={busy||!caseId.trim()} onClick={()=>open(caseId.trim())}>Load case ID</Button>
  </>:null}
  {item?<>
   <Divider/><Heading>{item.title}</Heading><Text>Case {item.id} · Deal {item.dealId} · {item.status} · {item.priority}</Text><Text>{item.description}</Text>
   <Text>Owner ID: {item.ownerId??'Unassigned'} · Due: {item.dueAt??'Not assigned'} · Evidence: {item.evidenceStatus}</Text>
   <Text>{detail!.linkedRecommendations.length} linked recommendation(s). Case resolution is separate from recommendation completion.</Text>
   {can('remediation.manage')?<>
    <TextArea name="case-note" label="Comment, resolution or waiver note" value={note} onChange={setNote}/>
    <Flex direction="row" gap="small" wrap="wrap">
     <Button disabled={busy||!note.trim()} onClick={()=>act('comments',{body:note})}>Add comment</Button>
     <Button disabled={busy||!active} onClick={()=>act('acknowledge')}>Acknowledge</Button>
     <Button disabled={busy||!active} onClick={()=>act('start')}>Start work</Button>
     <Button disabled={busy||!active||!note.trim()} onClick={()=>act('resolve',{note})}>Resolve with note</Button>
     <Button disabled={busy||!active||!note.trim()} onClick={()=>act('waive',{note})}>Waive with reason</Button>
     <Button disabled={busy||!['resolved','waived'].includes(item.status)} onClick={()=>act('close')}>Close resolved case</Button>
     <Button disabled={busy||active} onClick={()=>act('reopen')}>Reopen case</Button>
    </Flex>
    <Input name="case-assignee" label="HubSpot owner ID" value={owner} onChange={setOwner}/><Input name="case-deadline" label="Deadline (ISO with timezone)" value={due} onChange={setDue}/>
    <Button disabled={busy||!owner.trim()||!due.trim()} onClick={()=>act('assign',{ownerId:owner.trim(),dueAt:due.trim()})}>Confirm assignment and deadline</Button>
    <Checkbox name="case-evidence-required" checked={evidenceRequired} onChange={setEvidenceRequired}>Require accepted evidence</Checkbox>
    <Checkbox name="case-ack-required" checked={ackRequired} onChange={setAckRequired}>Require acknowledgement</Checkbox>
    <Button disabled={busy} onClick={()=>act('controls',{evidenceRequired,acknowledgementRequired:ackRequired},'PUT')}>Save case requirements</Button>
   </>:null}
   {can('remediation.evidence')?<>
    <Input name="evidence-label" label="Evidence label" value={evidenceLabel} onChange={setEvidenceLabel}/><TextArea name="evidence-text" label="Supporting evidence (text)" value={evidenceText} onChange={setEvidenceText}/>
    <Button disabled={busy||!evidenceLabel.trim()||!evidenceText.trim()} onClick={()=>act('evidence',{type:'text',label:evidenceLabel,value:evidenceText})}>Submit evidence</Button>
   </>:null}
   {can('remediation.review')?<Flex direction="row" gap="small">
    <Button disabled={busy||!item.evidenceRequired||!detail!.evidence.length} onClick={()=>act('evidence/accept',{comment:note})}>Accept submitted evidence</Button>
    <Button disabled={busy||!item.evidenceRequired||!detail!.evidence.length} onClick={()=>act('evidence/reject',{comment:note})}>Reject submitted evidence</Button>
   </Flex>:null}
   <Heading>Supporting record</Heading>{detail!.comments.slice(0,10).map(c=><Text key={c.id}>{c.body}</Text>)}{detail!.evidence.slice(0,10).map(e=><Text key={e.id}>{e.label}: {e.value}</Text>)}
   {detail!.truncated || detail!.comments.length>10 || detail!.evidence.length>10?<Text>This panel shows a bounded portion of the case history. Full retained evidence remains subject to authorized compliance export.</Text>:null}
  </>:null}
 </Flex></Card>;
}
