import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Flex, Heading, Input, LoadingSpinner, Select, Text, hubspot } from '@hubspot/ui-extensions';
import { productPermissionAvailable, safeProductError } from './product-ui';

const ROOT='https://dealguard-api.rokad.co/api/v1/enterprise';
type Approval={id:string;changeType:string;resourceType:string;resourceId:string;payload:Record<string,unknown>;
  status:string;requestedByUserId:string|null;requestedByEmail:string|null;decidedByUserId:string|null;decidedByEmail:string|null;
  decisionComment:string|null;requestedAt:string;expiresAt:string|null;targetState?:Record<string,unknown>|null};
type Props={access:unknown;entitled:boolean;currentUser:{id:string;email:string};reloadToken:number;onAccessChanged:()=>Promise<void>};
const date=(value:string|null)=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString():'Unavailable';
const object=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const roles=['administrator','policy_administrator','revops_manager','sales_manager','reviewer','remediation_manager','compliance_auditor','billing_administrator','viewer'];
const scopeKeys=['pipelineIds','ownerIds','teamIds','regionCodes'];
function replayable(row:Approval):boolean {
  if(row.resourceType!=='enterprise_role'||!object(row.payload))return false;
  if(row.changeType==='role.remove')return Boolean(row.resourceId)&&row.resourceId.length<=128&&Object.keys(row.payload).length===0&&object(row.targetState)&&row.targetState.id===row.resourceId;
  const payload=row.payload;
  return row.changeType==='role.assign'&&typeof payload.userId==='string'&&/^\d{1,32}$/.test(payload.userId)&&payload.userId===row.resourceId
    &&typeof payload.role==='string'&&roles.includes(payload.role)&&Array.isArray(payload.permissions)
    &&payload.permissions.every(value=>typeof value==='string'&&['forecast.approve','ai.use','breeze.use'].includes(value))
    &&(payload.userEmail===null||payload.userEmail===undefined||typeof payload.userEmail==='string'&&payload.userEmail.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.userEmail))
    &&object(payload.scope)&&Object.keys(payload.scope).every(key=>scopeKeys.includes(key))&&scopeKeys.every(key=>{
      const values=(payload.scope as Record<string,unknown>)[key];return Array.isArray(values)&&values.length<=500&&values.every(value=>typeof value==='string'&&value.length>0&&value.length<=128&&value.trim()===value);
    })
    &&Object.keys(payload).every(key=>['userId','userEmail','role','permissions','scope'].includes(key));
}
function BoundAssignment({state}:{state:Approval['targetState']}) {
  if(state===null)return <Text>No existing enterprise assignment was recorded for this target when the request was created.</Text>;
  if(!object(state))return <Text>The previous assignment was not captured by this request. Refresh or submit a new request if the service requires current target evidence.</Text>;
  const values=(key:string,empty='none')=>{try{const items=typeof state[key]==='string'?JSON.parse(state[key] as string):state[key];return Array.isArray(items)&&items.every(value=>typeof value==='string')?items.join(', ')||empty:'Unavailable';}catch{return 'Unavailable';}};
  return <Flex direction="column" gap="extra-small">
    <Heading>Assignment reviewed with this request</Heading>
    <Text>Assignment {String(state.id??'Unavailable')} · user ID {String(state.user_id??'not yet assigned')} · email {String(state.user_email??'none')} · role {String(state.role??'Unavailable').replaceAll('_',' ')}.</Text>
    <Text>Additional grants: {values('permissions_json')}.</Text>
    {scopeKeys.map(key=><Text key={key}>{key}: {values(({pipelineIds:'pipeline_ids_json',ownerIds:'owner_ids_json',teamIds:'team_ids_json',regionCodes:'region_codes_json'} as Record<string,string>)[key]!,'all records in this dimension')}</Text>)}
    <Text>Assignment last changed: {date(typeof state.updated_at==='string'?state.updated_at:null)}. Changing this assignment invalidates the reviewed state; submit a new request if it has changed.</Text>
  </Flex>;
}
function Payload({row}:{row:Approval}) {
  if(row.changeType==='role.remove')return <Text>Remove assignment {row.resourceId}. The service rechecks current authorization and final-administrator protection before applying it.</Text>;
  const payload=object(row.payload)?row.payload:{};
  const scope=object(payload.scope)?payload.scope:{};
  return <Flex direction="column" gap="extra-small">
    <Text>Target user ID {String(payload.userId??'Unavailable')} · email {String(payload.userEmail??'none')} · role {String(payload.role??'Unavailable').replaceAll('_',' ')}.</Text>
    <Text>Additional grants: {Array.isArray(payload.permissions)?payload.permissions.join(', ')||'none':'Unavailable'}.</Text>
    {scopeKeys.map(key=><Text key={key}>{key}: {Array.isArray(scope[key])?(scope[key] as unknown[]).join(', ')||'all records in this dimension':'Unavailable'}</Text>)}
  </Flex>;
}
export function RoleChangeApprovalsPanel({access,entitled,currentUser,reloadToken,onAccessChanged}:Props) {
  const canView=entitled&&productPermissionAvailable(access,'change.view',true);
  const canReview=entitled&&productPermissionAvailable(access,'change.approve',true);
  const canApply=entitled&&productPermissionAvailable(access,'role.manage',true);
  const [rows,setRows]=useState<Approval[]|null>(null),[selectedId,setSelectedId]=useState('');
  const [decision,setDecision]=useState<'approve'|'reject'>('approve'),[comment,setComment]=useState(''),[confirmation,setConfirmation]=useState('');
  const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[notice,setNotice]=useState<string|null>(null);
  const epoch=useRef(0),inFlight=useRef(false),autoReloaded=useRef(0),rights=useRef({canView,canReview,canApply});rights.current={canView,canReview,canApply};
  const boundary=useRef({access,id:currentUser.id,email:currentUser.email});boundary.current={access,id:currentUser.id,email:currentUser.email};
  const active=()=>rights.current.canView&&boundary.current.access===access&&boundary.current.id===currentUser.id&&boundary.current.email===currentUser.email;
  useEffect(()=>{rights.current={canView,canReview,canApply};setRows(null);setSelectedId('');setBusy(false);setError(null);setNotice(null);inFlight.current=false;
    return()=>{epoch.current++;inFlight.current=false;rights.current={canView:false,canReview:false,canApply:false};};},[access,canView,currentUser.id,currentUser.email]);
  useEffect(()=>{if(reloadToken>autoReloaded.current&&canView&&!busy){autoReloaded.current=reloadToken;void load();}},[reloadToken,canView,busy]);
  const call=async(path:string,method:'GET'|'POST'|'PUT'|'DELETE'='GET',body?:Record<string,unknown>)=>{
    const response=await hubspot.fetch(ROOT+path,{method,timeout:20000,...(body?{body}:{})}),result=await response.json();
    if(!response.ok)throw new Error(safeProductError(result?.error?.message));return result;
  };
  const fetchRows=async(version:number)=>{
    const verified=await call('/access');if(version!==epoch.current)return null;
    if(!verified.entitled||!productPermissionAvailable(verified,'change.view',true))throw new Error('Your current access cannot view these approvals. Refresh Home.');
    const result=await call('/change-approvals');if(version!==epoch.current)return null;
    if(result.redacted||!Array.isArray(result.approvals))throw new Error('Approval evidence could not be verified. Reload Home and try again.');
    return (result.approvals as Approval[]).filter(row=>['role.assign','role.remove'].includes(row.changeType)&&row.resourceType==='enterprise_role');
  };
  async function load() {
    if(!active()||inFlight.current)return;
    const version=++epoch.current;inFlight.current=true;setBusy(true);setError(null);setNotice(null);setRows(null);
    try {const values=await fetchRows(version);if(version===epoch.current&&values)setRows(values);}
    catch(problem){if(version===epoch.current)setError(safeProductError(problem instanceof Error?problem.message:undefined));}
    finally{if(version===epoch.current){inFlight.current=false;setBusy(false);}}
  }
  const selected=rows?.find(row=>row.id===selectedId);
  const expired=!selected?.expiresAt||!Number.isFinite(Date.parse(selected.expiresAt))||Date.parse(selected.expiresAt)<=Date.now();
  const self=Boolean(selected&&(selected.requestedByUserId===currentUser.id||selected.requestedByEmail?.toLowerCase()===currentUser.email.toLowerCase()));
  const identified=Boolean(selected?.requestedByUserId&&/^\d{1,32}$/.test(selected.requestedByUserId));
  const phrase=selected?.status==='approved'?'APPLY APPROVED ROLE CHANGE':decision==='approve'?'APPROVE ROLE CHANGE':'REJECT ROLE CHANGE';
  const act=async(apply=false)=>{
    if(inFlight.current||!active()||!selected||expired||!identified||confirmation!==phrase)return;
    if(apply?(!rights.current.canApply||selected.status!=='approved'||!replayable(selected)):
      (!rights.current.canReview||selected.status!=='pending'||self||!comment.trim()||comment.length>2000||decision==='approve'&&!replayable(selected)))return;
    const version=++epoch.current;inFlight.current=true;setBusy(true);setError(null);setNotice(null);
    try {
      if(apply) {
        const path=selected.changeType==='role.assign'?'/roles':`/roles/${encodeURIComponent(selected.resourceId)}`;
        await call(`${path}?approvalId=${encodeURIComponent(selected.id)}`,selected.changeType==='role.assign'?'PUT':'DELETE',selected.changeType==='role.assign'?selected.payload:undefined);
        if(version!==epoch.current)return;
        setRows(null);setSelectedId('');await onAccessChanged();
      } else {
        await call(`/change-approvals/${encodeURIComponent(selected.id)}/${decision}`,'POST',{comment:comment.trim()});
        if(version!==epoch.current)return;
        const values=await fetchRows(version);if(version!==epoch.current)return;
        if(values)setRows(values);setConfirmation('');setComment('');setNotice(decision==='approve'?'Approved. A role manager must explicitly apply this exact request.':'The request was rejected. No role change was applied.');
      }
    } catch(problem){if(version===epoch.current)setError(safeProductError(problem instanceof Error?problem.message:undefined));}
    finally{if(version===epoch.current){inFlight.current=false;setBusy(false);}}
  };
  if(!canView)return null;
  return <Card><Flex direction="column" gap="small">
    <Heading>Two-person role changes</Heading>
    <Text>A role change remains pending until a different authorized administrator reviews the exact user, role, grants and scope. Approval and application are separate actions. Requesting or approving a change does not itself assign a role.</Text>
    <Button disabled={busy} onClick={()=>void load()}>Load role change requests</Button>
    {busy?<LoadingSpinner label="Checking role change approval evidence"/>:null}
    {error?<Alert title="Role approval unavailable" variant="warning">{error}</Alert>:null}
    {notice?<Alert title="Role request updated" variant="info">{notice}</Alert>:null}
    {rows!==null?<>{rows.length?rows.map(row=><Flex key={row.id} direction="column" gap="extra-small">
      <Text>{row.changeType==='role.assign'?'Assign role':'Remove role'} · {row.status.replaceAll('_',' ')} · request {row.id}</Text>
      <Text>Requested by user {row.requestedByUserId??'unavailable'} · {row.requestedByEmail??'email unavailable'} · expires {date(row.expiresAt)}.</Text>
      <Button variant="secondary" disabled={busy} onClick={()=>{setSelectedId(row.id);setConfirmation('');setComment('');setDecision('approve');}}>Inspect request {row.id}</Button>
    </Flex>):<Text>No retained role-change requests are available.</Text>}</>:null}
    {selected?<><BoundAssignment state={selected.targetState}/><Heading>Exact requested change</Heading><Payload row={selected}/>
      <Text>Request {selected.id} · {selected.status}. Requested {date(selected.requestedAt)}; expires {date(selected.expiresAt)}.</Text>
      {selected.decidedByUserId?<Text>Decision by user {selected.decidedByUserId} · {selected.decidedByEmail??'email unavailable'} · {selected.decisionComment??'No review note recorded'}.</Text>:null}
      {expired?<Alert title="Request expired or unverified" variant="warning">This request cannot be reviewed or applied. Submit a new role change for independent review.</Alert>:null}
      {!identified?<Text>A stable requester identity is required. Submit a new role request through the current application.</Text>:null}
      {!replayable(selected)?<Text>This request lacks a supported exact role payload or the recorded removal target. It can be rejected; approving or applying it requires a new supported request.</Text>:null}
      {selected.status==='pending'&&self?<Text>You requested this change. A different authorized administrator must review it.</Text>:null}
      {selected.status==='pending'&&canReview&&!self&&identified&&!expired?<><Select name="role-approval-decision" label="Review decision" value={decision} readOnly={busy} options={[{label:'Approve',value:'approve'},{label:'Reject',value:'reject'}]} onChange={value=>{setDecision(String(value) as 'approve'|'reject');setConfirmation('');}}/>
        <Input name="role-approval-comment" label="Review note" value={comment} readOnly={busy} onChange={setComment}/>
        <Input name="role-approval-confirm" label={`Type ${phrase}`} value={confirmation} readOnly={busy} onChange={setConfirmation}/>
        <Button disabled={busy||!comment.trim()||comment.length>2000||confirmation!==phrase||decision==='approve'&&!replayable(selected)} onClick={()=>void act()}>{decision==='approve'?'Approve role request':'Reject role request'}</Button></>:null}
      {selected.status==='approved'&&canApply&&!expired?<>{!replayable(selected)?<Text>This stored request does not match the current role schema. Submit a new request; this panel will not guess a replacement payload.</Text>:<>
        <Input name="role-apply-confirm" label="Type APPLY APPROVED ROLE CHANGE" value={confirmation} readOnly={busy} onChange={setConfirmation}/>
        <Button disabled={busy||!identified||confirmation!==phrase} onClick={()=>void act(true)}>Apply approved role change</Button></>}</>:null}
    </>:null}
  </Flex></Card>;
}
