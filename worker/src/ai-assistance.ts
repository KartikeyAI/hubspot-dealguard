import { canonicalAuditValue } from './audit-chain.js';
import { loadAiEvidence, type AiEvidence } from './ai-evidence.js';
import { AI_PURPOSES, AiProviderFailure, aiConfiguration, generateAiExplanation, validateAiOutput, type AiPurpose } from './ai-provider.js';
import { decryptSecret, encryptSecret, randomToken, sha256Hex } from './crypto.js';
import { AppError } from './errors.js';
import { getIntelligenceConsent, requireIntelligenceAdministrator, requireIntelligenceConsent } from './intelligence-consent.js';
import type { Env, RequestIdentity } from './types.js';

function inputObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError(400,'ai_input_invalid','Use a JSON object.');
  return value as Record<string,unknown>;
}
async function assertUnchanged(env:Env, identity:RequestIdentity, dealId:string, revision:number, evidence:AiEvidence, modelKey:string):Promise<void>{
  if(await sha256Hex(aiConfiguration(env).revision)!==modelKey)throw new AppError(409,'ai_configuration_changed','The approved AI configuration changed.');
  await requireIntelligenceConsent(env,identity.portalId,'ai',revision);
  const current=await loadAiEvidence(env,identity,dealId,'ai.use',evidence.purpose);
  if(current.fingerprint!==evidence.fingerprint)throw new AppError(409,'ai_evidence_changed','The deal evidence changed. Refresh before requesting another draft.');
}
export async function aiAssistance(env:Env,identity:RequestIdentity,value:unknown,signal?:AbortSignal):Promise<Record<string,unknown>>{
  const input=inputObject(value);
  if(Object.keys(input).some(k=>!['dealId','purpose','requestKey'].includes(k))
    ||typeof input.dealId!=='string'||typeof input.requestKey!=='string'||!/^[A-Za-z0-9_-]{16,100}$/.test(input.requestKey)
    ||!AI_PURPOSES.includes(input.purpose as AiPurpose))throw new AppError(400,'ai_input_invalid','Provide a deal ID, supported purpose and a unique request key.');
  const config=aiConfiguration(env),c=await requireIntelligenceConsent(env,identity.portalId,'ai');
  const evidence=await loadAiEvidence(env,identity,input.dealId,'ai.use',input.purpose as AiPurpose),modelKey=await sha256Hex(config.revision);
  // Validate encryption configuration before admitting a request that may incur cost.
  await encryptSecret('configuration-check',env.TOKEN_ENCRYPTION_KEY);
  if(signal?.aborted)throw new AppError(409,'ai_request_cancelled','The request was cancelled before admission.');
  const token=randomToken();
  const result=await env.DB.prepare('SELECT dealguard.reserve_ai_run_v3(?,?,?,?,?,?,?,?,?,?,?,?,?,?) AS result')
    .bind(identity.portalId,input.requestKey,identity.userId,input.dealId,input.purpose,evidence.fingerprint,modelKey,c.revision,
      evidence.assessmentAt,evidence.snapshotAt,config.reservationMicro,token,evidence.handoffCycle,evidence.handoffVersion).first<{result:Record<string,unknown>}>();
  const admission=result?.result;
  if(!admission||admission.error){
    const code=String(admission?.error??'unavailable');
    throw new AppError(['budget','concurrency'].includes(code)?429:409,'ai_'+code,
      code==='budget'?'The daily request or estimated-cost allowance is exhausted.':code==='concurrency'?'Another AI request is running. Try again after it completes.':'This request cannot be admitted. Refresh consent and evidence; use a new key for a new request.');
  }
  const metadata={facts:evidence.facts,assessmentAt:evidence.assessmentAt,snapshotAt:evidence.snapshotAt,
    purpose:input.purpose,handoffCycle:evidence.handoffCycle,model:config.model,sourceFingerprint:evidence.fingerprint,requiresHumanReview:true,actionsExecuted:false};
  if(admission.cached===true){
    const text=await decryptSecret(String(admission.cipher),String(admission.iv),env.TOKEN_ENCRYPTION_KEY);
    const decoded=JSON.parse(text) as Record<string,unknown>;
    if(decoded.binding!==await sha256Hex(canonicalAuditValue({portalId:identity.portalId,userId:identity.userId,key:input.requestKey,
      fingerprint:evidence.fingerprint,modelKey,revision:c.revision})))throw new AppError(409,'ai_cache_invalid','Cached evidence cannot be verified.');
    const draft=validateAiOutput(decoded.output,evidence.facts,evidence.purpose);
    await assertUnchanged(env,identity,input.dealId,c.revision,evidence,modelKey);
    if(signal?.aborted)throw new AppError(409,'ai_request_cancelled','The request was cancelled.');
    return {...metadata,draft,cached:true};
  }
  if(admission.admitted!==true)throw new AppError(503,'ai_admission_unavailable','AI admission could not be verified.');
  let accounted:number|null=null,settled=false;
  try{
    await assertUnchanged(env,identity,input.dealId,c.revision,evidence,modelKey);
    const generated=await generateAiExplanation(config,input.purpose as AiPurpose,evidence.facts,signal);
    accounted=generated.accountedMicro;
    await assertUnchanged(env,identity,input.dealId,c.revision,evidence,modelKey);
    if(signal?.aborted)throw new AppError(409,'ai_request_cancelled','The request was cancelled.');
    const binding=await sha256Hex(canonicalAuditValue({portalId:identity.portalId,userId:identity.userId,key:input.requestKey,
      fingerprint:evidence.fingerprint,modelKey,revision:c.revision}));
    const encrypted=await encryptSecret(JSON.stringify({binding,output:generated.output}),env.TOKEN_ENCRYPTION_KEY);
    const finished=await env.DB.prepare('SELECT dealguard.finish_ai_run(?,?,?,?,?,?,?) AS accepted')
      .bind(identity.portalId,input.requestKey,token,true,accounted,encrypted.cipher,encrypted.iv).first<{accepted:boolean}>();
    settled=true;
    if(!finished?.accepted)throw new AppError(409,'ai_request_superseded','Consent or evidence changed before the draft was accepted.');
    await assertUnchanged(env,identity,input.dealId,c.revision,evidence,modelKey);
    if(signal?.aborted)throw new AppError(409,'ai_request_cancelled','The request was cancelled.');
    return {...metadata,draft:generated.output,cached:false};
  }catch(error){
    if(error instanceof AiProviderFailure)accounted=error.accountedMicro;
    if(!settled){
      // Unknown provider usage conservatively accounts the entire reservation, including failures.
      await env.DB.prepare('SELECT dealguard.finish_ai_run(?,?,?,?,?,?,?) AS accepted')
        .bind(identity.portalId,input.requestKey,token,false,accounted,null,null).first().catch(()=>undefined);
      // A failed settlement remains a live reservation until the bounded retention/retry sweep.
    }
    if(error instanceof AppError)throw error;
    throw new AppError(502,'ai_request_failed','Optional AI could not finish safely. The deterministic product remains available.');
  }
}
export async function aiAdministration(env:Env,identity:RequestIdentity):Promise<Record<string,unknown>>{
  await requireIntelligenceAdministrator(env,identity,false);
  const consent=await getIntelligenceConsent(env,identity.portalId,'ai');
  const limits=await env.DB.prepare('SELECT daily_requests,daily_budget_micro,concurrent_requests FROM dealguard.ai_limits WHERE portal_id=?')
    .bind(identity.portalId).first<Record<string,unknown>>();
  const usage=await env.DB.prepare("SELECT requests,reserved_micro,accounted_micro FROM dealguard.ai_daily_usage WHERE portal_id=? AND day=(NOW() AT TIME ZONE 'UTC')::date")
    .bind(identity.portalId).first<Record<string,unknown>>();
  let configurationReady=false,model:string|null=null;
  try{model=aiConfiguration(env).model;configurationReady=true;}catch{/* Do not disclose provider credentials or raw configuration. */}
  return {consent,configurationReady,model,limits:{dailyRequests:Number(limits?.daily_requests??25),dailyBudgetMicroUsd:Number(limits?.daily_budget_micro??5000000),
    concurrentRequests:Number(limits?.concurrent_requests??2)},usage:{day:new Date().toISOString().slice(0,10),requests:Number(usage?.requests??0),
      reservedMicroUsd:Number(usage?.reserved_micro??0),accountedMicroUsd:Number(usage?.accounted_micro??0)},
    costAccounting:'Estimated provider cost from configured rates; not a provider invoice or a Dodo charge.',
    retention:'Encrypted drafts expire after fifteen minutes; legal holds may retain inaccessible data.',
    dataUse:'Only curated readiness facts, comparable recorded changes, deterministic issue/risk/action codes and current handoff-cycle facts are sent. Names, communications and document bodies are excluded. Provider processing policies still apply.'};
}
export async function changeAiLimits(env:Env,identity:RequestIdentity,value:unknown):Promise<Record<string,unknown>>{
  await requireIntelligenceAdministrator(env,identity);const i=inputObject(value);
  if(!Number.isSafeInteger(i.revision)||Number(i.revision)<0||!Number.isSafeInteger(i.dailyRequests)||Number(i.dailyRequests)<1||Number(i.dailyRequests)>1000
    ||!Number.isSafeInteger(i.dailyBudgetMicroUsd)||Number(i.dailyBudgetMicroUsd)<10000||Number(i.dailyBudgetMicroUsd)>100000000
    ||!Number.isSafeInteger(i.concurrentRequests)||Number(i.concurrentRequests)<1||Number(i.concurrentRequests)>4)
    throw new AppError(400,'ai_limits_invalid','Use a current revision, one to one thousand daily requests, a bounded micro-USD budget, and one to four concurrent requests.');
  const r=await env.DB.prepare('SELECT dealguard.set_ai_limits(?,?,?,?,?,?) AS accepted')
    .bind(identity.portalId,i.revision,i.dailyRequests,i.dailyBudgetMicroUsd,i.concurrentRequests,identity.userId).first<{accepted:boolean}>();
  if(!r?.accepted)throw new AppError(409,'ai_limits_changed','Consent changed. Reload before changing limits.');
  return aiAdministration(env,identity);
}
export async function cleanupAiEvidence(env:Env):Promise<void>{
  await env.DB.prepare('SELECT dealguard.expire_ai_reservations(100)').first();
  await env.DB.prepare(`UPDATE dealguard.ai_runs r SET response_cipher=NULL,response_iv=NULL,cache_expires_at=NULL,
    state=CASE WHEN state='completed' THEN 'revoked' ELSE state END
    WHERE response_cipher IS NOT NULL AND NOT EXISTS(SELECT 1 FROM legal_holds WHERE portal_id=r.portal_id AND status='active')
    AND (cache_expires_at<=NOW() OR NOT EXISTS(SELECT 1 FROM dealguard.intelligence_consents c WHERE c.portal_id=r.portal_id AND c.capability='ai' AND c.enabled AND c.revision=r.consent_revision))`).run();
  await env.DB.prepare(`DELETE FROM dealguard.ai_runs r WHERE state<>'reserved' AND created_at<NOW()-INTERVAL '7 days'
    AND NOT EXISTS(SELECT 1 FROM legal_holds WHERE portal_id=r.portal_id AND status='active')`).run();
  await env.DB.prepare(`DELETE FROM dealguard.ai_daily_usage u WHERE day<(NOW() AT TIME ZONE 'UTC')::date-30
    AND NOT EXISTS(SELECT 1 FROM dealguard.ai_runs r WHERE r.portal_id=u.portal_id AND r.request_day=u.day AND r.state='reserved')
    AND NOT EXISTS(SELECT 1 FROM legal_holds WHERE portal_id=u.portal_id AND status='active')`).run();
}
