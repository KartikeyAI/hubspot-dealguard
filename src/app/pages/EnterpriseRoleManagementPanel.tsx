import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Checkbox, Flex, Heading, Input, LoadingSpinner, Select, Text, hubspot } from '@hubspot/ui-extensions';
import { productPermissionAvailable, safeProductError } from './product-ui';

const ROOT = 'https://dealguard-api.rokad.co/api/v1/enterprise';
const ROLES = ['administrator','policy_administrator','revops_manager','sales_manager','reviewer','remediation_manager','compliance_auditor','billing_administrator','viewer'] as const;
const OPTIONAL_GRANTS = ['forecast.approve','ai.use','breeze.use'] as const;
type Role = typeof ROLES[number];
type Scope = {pipelineIds:string[];ownerIds:string[];teamIds:string[];regionCodes:string[]};
type Assignment = {id:string;userId:string|null;userEmail:string|null;role:Role;permissions:string[];scope:Scope};
type Props = {access:unknown;entitled:boolean;currentUser:{id:string;email:string};onAccessChanged:()=>Promise<void>;onApprovalRequested:()=>void};
class RoleRequestError extends Error {constructor(readonly code:string,message:string,readonly details:Record<string,unknown>|undefined){super(message);}}
const split = (value:string):string[] => [...new Set(value.split(',').map(item=>item.trim()).filter(Boolean))];
const label = (value:string) => value.replaceAll('_',' ');

/** Uses the governed enterprise-role API. UI state never grants authorization. */
export function EnterpriseRoleManagementPanel({access,entitled,currentUser,onAccessChanged,onApprovalRequested}:Props) {
  const canManage = entitled && productPermissionAvailable(access,'role.manage',true) && (access as {bootstrap?:boolean})?.bootstrap!==true;
  const [rows,setRows] = useState<Assignment[]|null>(null), [editing,setEditing] = useState<Assignment|null>(null);
  const [userId,setUserId] = useState(''), [email,setEmail] = useState(''), [role,setRole] = useState<Role>('viewer');
  const [grants,setGrants] = useState<string[]>([]), [pipeline,setPipeline] = useState(''), [owner,setOwner] = useState(''), [team,setTeam] = useState(''), [region,setRegion] = useState('');
  const [confirm,setConfirm] = useState(''), [removeConfirm,setRemoveConfirm] = useState(''), [replaceLegacy,setReplaceLegacy] = useState(false);
  const [busy,setBusy] = useState(false), [error,setError] = useState<string|null>(null), [pending,setPending] = useState<string|null>(null);
  const epoch = useRef(0), inFlight = useRef(false), allowed = useRef(canManage);
  allowed.current=canManage;
  const boundary=useRef({access,id:currentUser.id,email:currentUser.email});boundary.current={access,id:currentUser.id,email:currentUser.email};
  const active=()=>allowed.current&&boundary.current.access===access&&boundary.current.id===currentUser.id&&boundary.current.email===currentUser.email;
  useEffect(()=>{allowed.current=canManage;setRows(null);setEditing(null);setBusy(false);setError(null);setPending(null);inFlight.current=false;
    return()=>{epoch.current++;inFlight.current=false;allowed.current=false;};},[access,canManage,currentUser.id,currentUser.email]);
  useEffect(()=>{setConfirm('');setRemoveConfirm('');},[userId,email,role,grants,pipeline,owner,team,region,replaceLegacy]);

  const reset = () => {setEditing(null);setUserId('');setEmail('');setRole('viewer');setGrants([]);
    setPipeline('');setOwner('');setTeam('');setRegion('');setConfirm('');setRemoveConfirm('');setReplaceLegacy(false);};
  const edit = (row:Assignment) => {setEditing(row);setUserId(row.userId??'');setEmail(row.userEmail??'');setRole(row.role);setGrants(row.permissions.filter(p=>OPTIONAL_GRANTS.includes(p as typeof OPTIONAL_GRANTS[number])));
    setPipeline(row.scope.pipelineIds.join(', '));setOwner(row.scope.ownerIds.join(', '));setTeam(row.scope.teamIds.join(', '));setRegion(row.scope.regionCodes.join(', '));setConfirm('');setRemoveConfirm('');setReplaceLegacy(false);};
  const legacyGrants = editing?.permissions.filter(p=>!OPTIONAL_GRANTS.includes(p as typeof OPTIONAL_GRANTS[number]))??[];
  const scope:Scope = {pipelineIds:split(pipeline),ownerIds:split(owner),teamIds:split(team),regionCodes:split(region)};
  const portalWide = Object.values(scope).every(values=>values.length===0);
  const validScope = Object.values(scope).every(values=>values.length<=500&&values.every(value=>value.length<=128));
  const validIdentity = /^\d{1,32}$/.test(userId.trim()) && email.trim().length<=254 && (!email.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()));
  const editableIdentity = !editing?.userId;
  const canSave = rows!==null && validIdentity && validScope && (!legacyGrants.length||replaceLegacy) && confirm==='SAVE ROLE';
  const send = async(path:string,method:'GET'|'PUT'|'DELETE'='GET',body?:Record<string,unknown>) => {
    const response=await hubspot.fetch(ROOT+path,{method,timeout:20000,...(body?{body}:{})});
    const result=await response.json();
    if(!response.ok)throw new RoleRequestError(String(result?.error?.code??'request_failed'),safeProductError(result?.error?.message),result?.error?.details);
    return result;
  };
  const load = async() => {
    if(!active()||inFlight.current)return;
    const version=++epoch.current;inFlight.current=true;setBusy(true);setError(null);setRows(null);reset();
    try {
      const verified=await send('/access');
      if(version!==epoch.current)return;
      if(verified.entitled!==true||!productPermissionAvailable(verified,'role.manage',true))throw new Error('Your current role cannot manage workspace assignments. Refresh Home to recheck access.');
      const result=await send('/roles');
      if(version!==epoch.current)return;
      if(result.redacted||!Array.isArray(result.roles))throw new Error('Role assignments could not be verified. Refresh Home and try again.');
      setRows(result.roles);
    } catch(problem) {
      if(version===epoch.current)setError(safeProductError(problem instanceof Error?problem.message:undefined));
    } finally {if(version===epoch.current){inFlight.current=false;setBusy(false);}}
  };
  const change = async(remove=false) => {
    if(!active()||inFlight.current||(!remove&&!canSave)||(remove&&(!editing||removeConfirm!=='REMOVE ROLE')))return;
    const version=++epoch.current;inFlight.current=true;setBusy(true);setError(null);setPending(null);
    try {
      if(remove)await send(`/roles/${encodeURIComponent(editing!.id)}`,'DELETE');
      else await send('/roles','PUT',{userId:userId.trim(),userEmail:email.trim().toLowerCase()||null,role,permissions:grants,scope});
      if(version!==epoch.current)return;
      setRows(null);reset();
      // Reload the parent access boundary, including the current caller's own role.
      // A self-demotion must not leave privileged panels mounted.
      await onAccessChanged();
    } catch(problem) {
      if(version===epoch.current){
        if(problem instanceof RoleRequestError&&['change_approval_created','change_approval_pending'].includes(problem.code)){
          setPending(`Request ${String(problem.details?.approvalId??'created')} is pending independent approval. No role change was applied. Review it in Two-person role changes below.`);setConfirm('');setRemoveConfirm('');onApprovalRequested();
        } else setError(safeProductError(problem instanceof Error?problem.message:undefined));
      }
    } finally {if(version===epoch.current){inFlight.current=false;setBusy(false);}}
  };
  if(!canManage)return null;
  return <Card><Flex direction="column" gap="small">
    <Heading>Workspace roles and record access</Heading>
    <Text>Request changes for stable HubSpot user IDs using the existing governed roles. Each high-impact request needs independent approval before it can be applied. Role permissions, record scope and final-administrator protection remain enforced by the service.</Text>
    {(access as {explicitAssignment?:boolean})?.explicitAssignment!==true?<Alert title="Use an explicit stable assignment" variant="info">Legacy governance access does not authorize forecast administration. Request your stable-ID assignment, obtain independent review, then apply that exact request through Two-person role changes.</Alert>:null}
    <Text>Your HubSpot identity: {currentUser.id} · {currentUser.email}. Verify another person's user ID in HubSpot before assigning access; email alone cannot authorize forecast review.</Text>
    <Button disabled={busy} onClick={()=>void load()}>Load workspace role assignments</Button>
    {busy?<LoadingSpinner label="Checking governed role assignments"/>:null}
    {error?<Alert title="Role change unavailable" variant="warning">{error}</Alert>:null}
    {pending?<Alert title="Independent approval pending" variant="info">{pending}</Alert>:null}
    {rows!==null?<>
      <Heading>Current assignments</Heading>
      {rows.length?rows.map(row=><Flex key={row.id} direction="column" gap="extra-small">
        <Text>{row.userEmail??'No email recorded'} · user ID {row.userId??'not yet assigned'} · {label(row.role)}</Text>
        <Text>Additional grants: {row.permissions.join(', ')||'role defaults only'}. Scope: {Object.entries(row.scope).filter(([,values])=>values.length).map(([key,values])=>`${key}: ${values.join(', ')}`).join('; ')||'all records in this portal'}.</Text>
        <Button variant="secondary" disabled={busy} onClick={()=>edit(row)}>Edit assignment for {row.userId??row.userEmail??row.id}</Button>
      </Flex>):<Text>No explicit enterprise assignments are recorded. Complete the initial administrator assignment before onboarding reviewers.</Text>}
      <Heading>{editing?'Edit role assignment':'New role assignment'}</Heading>
      <Flex direction="row" gap="small"><Button variant="secondary" disabled={busy} onClick={reset}>Start a new assignment</Button>
        <Button variant="secondary" disabled={busy||Boolean(editing)} onClick={()=>{setUserId(currentUser.id);setEmail(currentUser.email);if((access as {explicitAssignment?:boolean})?.explicitAssignment!==true)setRole('administrator');setConfirm('');}}>Use my HubSpot identity</Button></Flex>
      <Input name="enterprise-role-user-id" label="HubSpot user ID (required)" value={userId} readOnly={busy||!editableIdentity} onChange={setUserId}/>
      <Input name="enterprise-role-email" label="HubSpot user email (optional)" value={email} readOnly={busy||Boolean(editing&&!editing.userId)} onChange={setEmail}/>
      {editing&&!editing.userId?<Text>Enter this person's verified stable user ID to bind the existing email-only assignment. Its current email is preserved for the server's identity check.</Text>:null}
      <Select name="enterprise-role-value" label="Role" value={role} readOnly={busy} options={ROLES.map(value=>({label:label(value),value}))} onChange={value=>{setRole(String(value) as Role);setConfirm('');}}/>
      <Text>Administrator includes all application permissions. Reviewer or compliance auditor plus forecast.approve can independently review eligible models. Reviewers must differ from the evaluation requester and model registrant.</Text>
      <Heading>Optional additional permissions</Heading>
      {OPTIONAL_GRANTS.map(permission=><Checkbox key={permission} name={`grant-${permission}`} checked={grants.includes(permission)} readOnly={busy} onChange={checked=>{setGrants(existing=>checked?[...new Set([...existing,permission])]:existing.filter(value=>value!==permission));setConfirm('');}}>{permission}</Checkbox>)}
      {legacyGrants.length?<><Alert title="Review existing additional grants" variant="warning">This assignment includes additional grants outside this setup editor: {legacyGrants.join(', ')}. They will be removed if you replace the assignment. The base permissions of the selected role still apply.</Alert>
        <Checkbox name="replace-legacy-role-grants" checked={replaceLegacy} readOnly={busy} onChange={setReplaceLegacy}>I intend to remove those existing additional grants.</Checkbox></>:null}
      <Heading>Record scope</Heading>
      <Text>Enter comma-separated IDs. Empty fields include all records in that dimension; restrictions across dimensions must all match. Existing restrictions stay in the form when editing. A scoped administrator cannot manage portal-wide settings, roles or forecasts.</Text>
      <Input name="role-pipeline-scope" label="Pipeline IDs" value={pipeline} readOnly={busy} onChange={setPipeline}/>
      <Input name="role-owner-scope" label="Owner IDs" value={owner} readOnly={busy} onChange={setOwner}/>
      <Input name="role-team-scope" label="Team IDs" value={team} readOnly={busy} onChange={setTeam}/>
      <Input name="role-region-scope" label="Region codes" value={region} readOnly={busy} onChange={setRegion}/>
      <Text>Proposed access: {label(role)} · {portalWide?'all records in this portal':'restricted to the entered record scope'} · additional grants {grants.join(', ')||'none'}.</Text>
      <Input name="enterprise-role-confirm" label="Type SAVE ROLE to request this assignment" value={confirm} readOnly={busy} onChange={setConfirm}/>
      <Button disabled={busy||!canSave} onClick={()=>void change()}>Submit role change</Button>
      {editing?<><Text>Removing an assignment leaves any remaining legacy/default authorization in effect. Verify the person's resulting access; removal is not a substitute for deactivating their HubSpot account.</Text>
        <Input name="enterprise-role-remove-confirm" label={`Type REMOVE ROLE to request removal of ${editing.userId??editing.userEmail}`} value={removeConfirm} readOnly={busy} onChange={setRemoveConfirm}/>
        <Button variant="secondary" disabled={busy||removeConfirm!=='REMOVE ROLE'} onClick={()=>void change(true)}>Request assignment removal</Button></>:null}
    </>:null}
  </Flex></Card>;
}
