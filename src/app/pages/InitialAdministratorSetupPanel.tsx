import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Flex, Heading, Input, LoadingSpinner, Text, hubspot } from '@hubspot/ui-extensions';
import { safeProductError } from './product-ui';

const ENDPOINT='https://dealguard-api.rokad.co/api/v1/enterprise/roles/bootstrap';
type Identity={userId:string;userEmail:string};
type Proposal={id:string;payloadHash:string;status:'pending';expiresAt:string;requester:Identity;nominee:Identity;
  role:'administrator';permissions:string[];scope:{pipelineIds:string[];ownerIds:string[];teamIds:string[];regionCodes:string[]};canAccept:boolean;canReject:boolean};
type Setup={initialized:boolean;viewer:'requester'|'nominee'|'unavailable';canPropose:boolean;proposal:Proposal|null};
type Props={access:unknown;entitled:boolean;currentUser:{id:string;email:string};onAccessChanged:()=>Promise<void>};
const sameIdentity=(identity:Identity,user:{id:string;email:string})=>identity.userId===user.id&&identity.userEmail.toLowerCase()===user.email.toLowerCase();
const knownPair=(value:Proposal)=>value.status==='pending'&&value.role==='administrator'&&Array.isArray(value.permissions)&&value.permissions.length===0
  &&value.scope&&['pipelineIds','ownerIds','teamIds','regionCodes'].every(key=>Array.isArray(value.scope[key as keyof Proposal['scope']])&&value.scope[key as keyof Proposal['scope']].length===0)
  &&/^[1-9]\d{0,29}$/.test(value.requester?.userId)&&/^[1-9]\d{0,29}$/.test(value.nominee?.userId)
  &&typeof value.requester?.userEmail==='string'&&typeof value.nominee?.userEmail==='string'
  &&value.requester.userId!==value.nominee.userId&&value.requester.userEmail.toLowerCase()!==value.nominee.userEmail.toLowerCase()
  &&typeof value.id==='string'&&typeof value.payloadHash==='string'&&/^[a-f0-9]{64}$/i.test(value.payloadHash);

/** Bootstrap is a distinct, fixed two-person setup. Proposal never grants access. */
export function InitialAdministratorSetupPanel({access,entitled,currentUser,onAccessChanged}:Props) {
  const [setup,setSetup]=useState<Setup|null>(null),[nomineeId,setNomineeId]=useState(''),[nomineeEmail,setNomineeEmail]=useState('');
  const [confirmation,setConfirmation]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[notice,setNotice]=useState<string|null>(null);
  const epoch=useRef(0),inFlight=useRef(false),allowed=useRef(entitled);allowed.current=entitled;
  const boundary=useRef({access,id:currentUser.id,email:currentUser.email});boundary.current={access,id:currentUser.id,email:currentUser.email};
  const active=()=>allowed.current&&boundary.current.access===access&&boundary.current.id===currentUser.id&&boundary.current.email===currentUser.email;
  useEffect(()=>{allowed.current=entitled;setSetup(null);setConfirmation('');setBusy(false);setError(null);setNotice(null);inFlight.current=false;
    return()=>{epoch.current++;inFlight.current=false;allowed.current=false;};},[access,entitled,currentUser.id,currentUser.email]);
  useEffect(()=>{setConfirmation('');},[nomineeId,nomineeEmail]);
  const call=async(body?:Record<string,unknown>)=>{
    const response=await hubspot.fetch(ENDPOINT,{method:body?'POST':'GET',timeout:20000,...(body?{body}:{})});
    const result=await response.json();if(!response.ok)throw new Error(safeProductError(result?.error?.message));return result;
  };
  const load=async()=>{
    if(!active()||inFlight.current)return;
    const version=++epoch.current;inFlight.current=true;setBusy(true);setError(null);setNotice(null);setSetup(null);setConfirmation('');
    try {const result=await call();if(version===epoch.current)setSetup(result as Setup);}
    catch(problem){if(version===epoch.current)setError(safeProductError(problem instanceof Error?problem.message:undefined));}
    finally{if(version===epoch.current){inFlight.current=false;setBusy(false);}}
  };
  const proposal=setup?.proposal;
  const validProposal=Boolean(proposal&&knownPair(proposal));
  const fresh=Boolean(proposal&&Number.isFinite(Date.parse(proposal.expiresAt))&&Date.parse(proposal.expiresAt)>Date.now());
  const canAccept=Boolean(validProposal&&fresh&&proposal?.canAccept&&sameIdentity(proposal.nominee,currentUser));
  const canReject=Boolean(validProposal&&fresh&&proposal?.canReject&&(sameIdentity(proposal.nominee,currentUser)||sameIdentity(proposal.requester,currentUser)));
  const validNominee=/^[1-9]\d{0,29}$/.test(nomineeId.trim())&&nomineeId.trim()!==currentUser.id
    &&nomineeEmail.trim().length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nomineeEmail.trim())&&nomineeEmail.trim().toLowerCase()!==currentUser.email.toLowerCase();
  const mutate=async(action:'propose'|'accept'|'reject')=>{
    if(!active()||inFlight.current||!setup||setup.initialized)return;
    const phrase=action==='propose'?'PROPOSE_INITIAL_ADMINISTRATORS':action==='accept'?'ACCEPT_INITIAL_ADMINISTRATORS':'REJECT_INITIAL_ADMINISTRATORS';
    if(confirmation!==phrase|| (action==='propose'?(!setup.canPropose||!validNominee):action==='accept'?!canAccept:!canReject))return;
    const body=action==='propose'?{action,nomineeUserId:nomineeId.trim(),nomineeEmail:nomineeEmail.trim().toLowerCase(),confirmation:phrase}:
      {action,proposalId:proposal!.id,payloadHash:proposal!.payloadHash,confirmation:phrase};
    const version=++epoch.current;inFlight.current=true;setBusy(true);setError(null);setNotice(null);
    try {
      const result=await call(body);if(version!==epoch.current)return;
      setConfirmation('');
      if(result.outcome==='applied') {setSetup(null);await onAccessChanged();return;}
      const updated=await call();if(version!==epoch.current)return;setSetup(updated as Setup);
      setNotice(result.outcome==='proposed'?'Setup is pending the named nominee’s independent acceptance. No administrator role has been granted. Ask the nominee to open DealGuard Home and check initial administrator setup.':'The setup proposal was rejected or withdrawn. No administrator role was granted.');
    } catch(problem){if(version===epoch.current)setError(safeProductError(problem instanceof Error?problem.message:undefined));}
    finally{if(version===epoch.current){inFlight.current=false;setBusy(false);}}
  };
  if(!entitled)return null;
  return <Card><Flex direction="column" gap="small">
    <Heading>Initial enterprise administrator setup</Heading>
    <Text>Use this two-person setup for a new workspace or a supported migration from legacy governance. An eligible setup requester proposes a named second person. Both receive portal-wide administrator access only after that person independently accepts the exact proposal. Existing enterprise workspaces use role change requests below.</Text>
    <Text>Your signed HubSpot identity: user {currentUser.id} · {currentUser.email}. The setup requester needs the nominee's exact ID and email; share your own identity with them through your usual workplace channel.</Text>
    <Button disabled={busy} onClick={()=>void load()}>Check initial administrator setup</Button>
    {busy?<LoadingSpinner label="Checking two-person administrator setup"/>:null}
    {error?<Alert title="Administrator setup unavailable" variant="warning">{error}</Alert>:null}
    {notice?<Alert title="Administrator setup updated" variant="info">{notice}</Alert>:null}
    {setup?.initialized?<Text>Initial administrator setup is complete. Refresh Home to load your current assigned access. Further role changes require independent approval in Two-person role changes.</Text>:null}
    {setup&&!setup.initialized&&setup.viewer==='unavailable'?<Text>No initial setup action is available to your current identity. Only an eligible setup requester or the exact named nominee can view a pending proposal.</Text>:null}
    {setup&&!setup.initialized&&setup.canPropose&&!proposal?<>
      <Text>Verify the second person's numeric HubSpot user ID and email in HubSpot. This request grants nothing until that exact person signs in and accepts; it expires after one hour.</Text>
      <Input name="initial-admin-nominee-id" label="Second administrator HubSpot user ID" value={nomineeId} readOnly={busy} onChange={setNomineeId}/>
      <Input name="initial-admin-nominee-email" label="Second administrator HubSpot email" value={nomineeEmail} readOnly={busy} onChange={setNomineeEmail}/>
      <Input name="initial-admin-propose-confirm" label="Type PROPOSE_INITIAL_ADMINISTRATORS" value={confirmation} readOnly={busy} onChange={setConfirmation}/>
      <Button disabled={busy||!validNominee||confirmation!=='PROPOSE_INITIAL_ADMINISTRATORS'} onClick={()=>void mutate('propose')}>Propose initial administrators</Button>
    </>:null}
    {proposal?<>
      <Heading>Exact pending administrator pair</Heading>
      <Text>Setup requester: user {proposal.requester?.userId??'Unavailable'} · {proposal.requester?.userEmail??'Unavailable'}.</Text>
      <Text>Named nominee: user {proposal.nominee?.userId??'Unavailable'} · {proposal.nominee?.userEmail??'Unavailable'}.</Text>
      <Text>Both assignments: administrator · all records in this portal · administrator role permissions. No optional additional grants.</Text>
      <Text>Proposal {proposal.id}. Evidence fingerprint: {proposal.payloadHash}. Expires {Number.isFinite(Date.parse(proposal.expiresAt))?new Date(proposal.expiresAt).toLocaleString():'unavailable'}.</Text>
      {!validProposal||!fresh?<Alert title="Proposal unavailable" variant="warning">This proposal is expired or does not match the fixed setup contract. Reload setup before proceeding.</Alert>:null}
      {canAccept?<><Text>Accept only after checking both identities. This action creates both administrator assignments together.</Text>
        <Input name="initial-admin-accept-confirm" label="Type ACCEPT_INITIAL_ADMINISTRATORS" value={confirmation} readOnly={busy} onChange={setConfirmation}/>
        <Button disabled={busy||confirmation!=='ACCEPT_INITIAL_ADMINISTRATORS'} onClick={()=>void mutate('accept')}>Accept initial administrator pair</Button></>:null}
      {validProposal&&fresh&&!canAccept?<Text>The named nominee must independently open this panel and accept. The setup requester cannot accept their own proposal.</Text>:null}
      {canReject?<><Input name="initial-admin-reject-confirm" label="Type REJECT_INITIAL_ADMINISTRATORS to decline or withdraw" value={confirmation} readOnly={busy} onChange={setConfirmation}/>
        <Button variant="secondary" disabled={busy||confirmation!=='REJECT_INITIAL_ADMINISTRATORS'} onClick={()=>void mutate('reject')}>Reject or withdraw administrator setup</Button></>:null}
    </>:null}
  </Flex></Card>;
}
