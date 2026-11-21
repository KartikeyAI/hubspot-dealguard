import { canonicalAuditValue } from './audit-chain.js';
import { loadAiEvidence } from './ai-evidence.js';
import { sha256Hex } from './crypto.js';
import { AppError } from './errors.js';
import { json,methodNotAllowed,readJson } from './http.js';
import { requireIntelligenceAdministrator } from './intelligence-consent.js';
import { validateHubSpotRequest,validateHubSpotSignature } from './signature.js';
import type { Env,RequestIdentity } from './types.js';
export const BREEZE_TOOLS=['evidence','risk','next-action','handover','remediation-preview'] as const;
export type BreezeTool=typeof BREEZE_TOOLS[number];
function object(v:unknown):Record<string,unknown>|null{return v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:null;}
function numericIdentity(v:unknown):string|null{
  if(typeof v==='number'&&!Number.isSafeInteger(v))return null;
  const s=typeof v==='number'||typeof v==='string'?String(v):'';return /^[1-9]\d{0,29}$/.test(s)?s:null;
}
export function breezeActionBindings(env:Env):Record<string,string>{
  if(env.DEALGUARD_BREEZE_ENABLED!=='true')throw new AppError(503,'breeze_disabled','Optional agent tools are disabled.');
  let raw:Record<string,unknown>|null=null;try{raw=object(JSON.parse(env.DEALGUARD_BREEZE_ACTION_IDS??''));}catch{/* Fail closed. */}
  if(!raw||Object.keys(raw).some(k=>!BREEZE_TOOLS.includes(k as BreezeTool))||!Object.keys(raw).length)
    throw new AppError(503,'breeze_bindings_unavailable','Approved action-definition bindings must be configured.');
  const result:Record<string,string>={};for(const [key,value]of Object.entries(raw)){const id=numericIdentity(value);if(!id||Object.values(result).includes(id))throw new AppError(503,'breeze_bindings_unavailable','Approved action-definition bindings are invalid.');result[key]=id;}
  return result;
}
export async function parseBreezeInvocation(request:Request,env:Env,tool:BreezeTool):Promise<{identity:RequestIdentity;dealId:string;callbackId:string;requestHash:string}>{
  const bindings=breezeActionBindings(env);
  if(!bindings[tool])throw new AppError(503,'breeze_tool_unapproved','This tool is not enabled in the approved action bindings.');
  if(new URL(request.url).search)throw new AppError(400,'breeze_identity_ambiguous','Agent identities must come from the signed invocation body, not query parameters.');
  // Read a bounded clone before signature verification to reject oversized inputs.
  const body=object(await readJson(request.clone(),16000));
  await validateHubSpotSignature(request,env,true);
  const origin=object(body?.origin),context=object(body?.context),portalId=numericIdentity(origin?.portalId),userId=numericIdentity(origin?.userId);
  if(!portalId||!userId||context?.source!=='AGENTS'||!numericIdentity(context?.agentId)||numericIdentity(origin?.actionDefinitionId)!==bindings[tool]
    ||typeof body?.callbackId!=='string'||!body.callbackId||body.callbackId.length>200||/[\x00-\x1f]/.test(body.callbackId))
    throw new AppError(401,'breeze_origin_invalid','A valid, identified and bound agent invocation is required.');
  const a=object(body.inputFields),b=object(body.fields),fields=a??b;
  if(!fields||Object.keys(fields).some(k=>k!=='dealId')||(a&&b&&canonicalAuditValue(a)!==canonicalAuditValue(b))
    ||typeof fields.dealId!=='string'||!numericIdentity(fields.dealId))throw new AppError(400,'breeze_input_invalid','Only an explicit HubSpot deal ID is accepted.');
  // Stable user ID is authoritative; no input can supply or override the actor.
  const identity:RequestIdentity={portalId,userId,userEmail:null,appId:env.HUBSPOT_APP_ID??null};
  return {identity,dealId:fields.dealId,callbackId:body.callbackId,requestHash:await sha256Hex(canonicalAuditValue(body))};
}
async function breezeSettings(env:Env,portalId:string):Promise<{enabled:boolean;revision:number;dailyLimit:number}>{
  const row=await env.DB.prepare('SELECT enabled,revision,daily_limit FROM dealguard.breeze_settings WHERE portal_id=?').bind(portalId)
    .first<{enabled:boolean;revision:number;daily_limit:number}>();return {enabled:row?.enabled??false,revision:row?.revision??0,dailyLimit:row?.daily_limit??200};
}
export async function breezeAdministration(env:Env,identity:RequestIdentity):Promise<Record<string,unknown>>{
  await requireIntelligenceAdministrator(env,identity,false);let approvedTools:string[]=[];try{approvedTools=Object.keys(breezeActionBindings(env));}catch{/* Status is available while disabled. */}
  const settings=await breezeSettings(env,identity.portalId);return {...settings,approvedTools,
    disclosure:'These tools return curated CRM evidence to HubSpot agents. They do not call the native AI provider, approve work, or change CRM records.'};
}
export async function setBreezeAdministration(env:Env,identity:RequestIdentity,value:unknown):Promise<Record<string,unknown>>{
  const i=object(value);if(!i||typeof i.enabled!=='boolean'||!Number.isSafeInteger(i.revision)||Number(i.revision)<0
    ||!Number.isSafeInteger(i.dailyLimit)||Number(i.dailyLimit)<1||Number(i.dailyLimit)>10000||i.confirmation!==(i.enabled?'ENABLE_BREEZE':'DISABLE_BREEZE'))
    throw new AppError(400,'breeze_confirmation_required','Provide the current revision, bounded daily limit and exact enable/disable confirmation.');
  await requireIntelligenceAdministrator(env,identity,i.enabled);
  const row=await env.DB.prepare('SELECT dealguard.set_breeze_settings(?,?,?,?,?) AS settings')
    .bind(identity.portalId,i.enabled,i.revision,i.dailyLimit,identity.userId).first<{settings:Record<string,unknown>|null}>();
  if(!row?.settings)throw new AppError(409,'breeze_consent_changed','Agent-tool consent changed. Reload before retrying.');
  return breezeAdministration(env,identity);
}
export async function invokeBreezeTool(request:Request,env:Env,tool:BreezeTool):Promise<Response>{
  const invocation=await parseBreezeInvocation(request,env,tool),{identity,dealId}=invocation;
  const settings=await breezeSettings(env,identity.portalId);if(!settings.enabled)throw new AppError(403,'breeze_consent_required','Separate explicit consent for agent tools is required.');
  const purpose=tool==='handover'?'handover':tool==='next-action'?'next_action':'risk';
  const evidence=await loadAiEvidence(env,identity,dealId,'breeze.use',purpose);
  const admitted=await env.DB.prepare('SELECT dealguard.admit_breeze_read(?,?,?,?,?,?,?) AS accepted')
    .bind(identity.portalId,settings.revision,invocation.callbackId,identity.userId,tool,dealId,invocation.requestHash).first<{accepted:boolean}>();
  if(!admitted?.accepted)throw new AppError(429,'breeze_admission_denied','Invocation is outside the allowed retry, consent or request budget.');
  const current=await loadAiEvidence(env,identity,dealId,'breeze.use',purpose),consent=await breezeSettings(env,identity.portalId);
  breezeActionBindings(env);
  if(!consent.enabled||consent.revision!==settings.revision||current.fingerprint!==evidence.fingerprint)
    throw new AppError(409,'breeze_evidence_changed','Evidence or agent-tool consent changed during this request.');
  const facts=tool==='risk'?evidence.facts.filter(f=>['readiness_score','issue_count','deterministic_risk_code','observation_time'].includes(f.kind)):
    tool==='next-action'?evidence.facts.filter(f=>['recorded_action_code','observation_time'].includes(f.kind)):evidence.facts;
  const response={dealId,tool,assessmentAt:evidence.assessmentAt,snapshotAt:evidence.snapshotAt,handoffCycle:evidence.handoffCycle,facts,sourceFingerprint:evidence.fingerprint,
    actionsExecuted:false,approved:false,requiresHumanReview:true,
    ...(tool==='remediation-preview'?{previewOnly:true,missingInputs:['assignee','deadline','explicit authenticated approval'],message:'Review the recorded next action in DealGuard before creating or linking remediation.'}:{}),
    limitations:'Recorded evidence only. Missing evidence is unknown. No buyer-intent inference, causal claim, current win probability, or authorization to execute work.'};
  return json({outputFields:{hs_execution_state:'SUCCESS',evidence:JSON.stringify(response)}});
}
export async function routeBreeze(request:Request,env:Env):Promise<Response|null>{
  const path=new URL(request.url).pathname;
  if(path==='/api/v1/enterprise/breeze'){
    if(!['GET','PUT'].includes(request.method))return methodNotAllowed(['GET','PUT']);const identity=await validateHubSpotRequest(request,env,4096);
    return json(request.method==='GET'?await breezeAdministration(env,identity):await setBreezeAdministration(env,identity,await readJson(request,4096)));
  }
  const tool=path.startsWith('/api/v1/breeze/')?path.slice('/api/v1/breeze/'.length):'';
  if(!BREEZE_TOOLS.includes(tool as BreezeTool))return null;
  if(request.method!=='POST')return methodNotAllowed(['POST']);return invokeBreezeTool(request,env,tool as BreezeTool);
}
export async function cleanupBreezeMetadata(env:Env):Promise<void>{
  for(const [table,where]of [['breeze_invocations',"received_at<NOW()-INTERVAL '30 days'"],['breeze_daily_usage',"day<(NOW() AT TIME ZONE 'UTC')::date-30"]])
    await env.DB.prepare(`DELETE FROM dealguard.${table} b WHERE ${where} AND NOT EXISTS(SELECT 1 FROM legal_holds WHERE portal_id=b.portal_id AND status='active')`).run();
}
