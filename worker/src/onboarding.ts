import { getBillingStatus } from './billing.js';
import { PLAN_LIMITS, REQUIRED_HUBSPOT_SCOPES, OPTIONAL_COMMERCIAL_HUBSPOT_SCOPES } from './config.js';
import { assessmentFreshness } from './evidence-freshness.js';
import { requireIntelligenceAdministrator } from './intelligence-consent.js';
import { parseSettings } from './validation.js';
import type { Env, PlanId, RequestIdentity } from './types.js';

type Check = {code:string;state:'complete'|'action_required'|'optional'|'unverified';title:string;detail:string};
/** Read-only, administrator-scoped setup guidance. Never calls a provider or changes consent. */
export async function onboardingStatus(env: Env, identity: RequestIdentity) {
  await requireIntelligenceAdministrator(env,identity,false);
  const tenant = await env.DB.prepare('SELECT plan,scopes_json,settings_json,last_scan_at FROM tenants WHERE portal_id=?')
    .bind(identity.portalId).first<{plan:PlanId;scopes_json:string;settings_json:string;last_scan_at:string|null}>();
  const billing = await getBillingStatus(env,identity.portalId);
  const checks: Check[] = [];
  let scopes: string[] | null = null;
  try { const raw:unknown = JSON.parse(tenant?.scopes_json ?? 'null'); if(Array.isArray(raw)&&raw.every(v=>typeof v==='string'))scopes=raw; } catch {/* Explicit unavailable state below. */}
  const missing = scopes === null ? [...REQUIRED_HUBSPOT_SCOPES] : REQUIRED_HUBSPOT_SCOPES.filter(s=>!scopes!.includes(s));
  checks.push({code:'installation_grant',state:missing.length?'action_required':'complete',title:'Recorded installation permissions',
    detail:missing.length?'Reconnect through the approved installation flow to restore missing CRM permissions.':'Required permissions are present in the recorded grant; live renewal and access still require account acceptance.'});
  let settingsValid=false;
  try {
    const settings:unknown=JSON.parse(tenant?.settings_json ?? 'null');
    if(settings && typeof settings==='object' && !Array.isArray(settings) && tenant && Object.hasOwn(PLAN_LIMITS,tenant.plan)) {
      parseSettings(settings,tenant.plan);settingsValid=true;
    }
  } catch {/* No raw customer configuration in errors or output. */}
  checks.push({code:'configuration',state:settingsValid?'complete':'action_required',title:'Stored product configuration',
    detail:settingsValid?'Stored settings can be parsed. Confirm pipeline exclusions and required properties in the connected-project settings.':'Review connected-project settings before running a scan. Stored settings could not be validated.'});
  const stats=await env.DB.prepare(`SELECT COUNT(*)::int AS recorded,
    COUNT(*) FILTER(WHERE is_closed=0)::int AS open,
    to_char(MAX(CASE WHEN is_closed=0 AND pg_input_is_valid(assessed_at,'timestamp with time zone') THEN assessed_at::timestamptz END) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS latest
    FROM deal_assessments WHERE portal_id=? AND dealguard.record_is_available(portal_id,deal_id)`)
    .bind(identity.portalId).first<{recorded:number;open:number;latest:string|null}>();
  const latestScan=await env.DB.prepare('SELECT status,scanned_count,started_at,completed_at FROM scan_runs WHERE portal_id=? ORDER BY started_at DESC,id DESC LIMIT 1')
    .bind(identity.portalId).first<{status:string;scanned_count:number;started_at:string;completed_at:string|null}>();
  checks.push({code:'first_scan',state:latestScan?.status==='completed'?'complete':'action_required',title:'Initial portal scan',
    detail:latestScan?.status==='running'?'A scan is recorded as running. Refresh this checklist to inspect its result.':latestScan?.status==='completed'?
      'A completed scan is recorded. Zero matching deals is a valid result, not proof of pipeline health.':'Run a scan from DealGuard Home using the existing scan controls. This checklist never starts one automatically.'});
  const age=assessmentFreshness(stats?.latest,Date.now());
  checks.push({code:'first_review',state:(stats?.open??0)>0 && ['fresh','aging'].includes(age.status)?'complete':(stats?.recorded??0)===0?'unverified':'action_required',
    title:'A recorded deal to review',detail:(stats?.open??0)>0?'Open an eligible deal record, inspect its evidence and confirm its next action. Latest assessment age: '+age.status+'.':'No recorded open deal is available. Add or select an eligible test deal; do not fabricate sample CRM records.'});
  const consents=(await env.DB.prepare('SELECT capability,enabled,revision FROM intelligence_consents WHERE portal_id=?').bind(identity.portalId).all<{capability:string;enabled:boolean;revision:number}>()).results??[];
  const breeze=await env.DB.prepare('SELECT enabled,revision FROM breeze_settings WHERE portal_id=?').bind(identity.portalId).first<{enabled:boolean;revision:number}>();
  checks.push({code:'optional_intelligence',state:'optional',title:'Optional intelligence is separately controlled',
    detail:'AI, outcome evaluation and Breeze each require explicit consent. They are not needed for the deterministic product. Historical evaluation does not activate forecasts.'});
  checks.push({code:'provider_acceptance',state:'unverified',title:'Live account acceptance',detail:'This read-only checklist does not verify HubSpot edition capabilities, OAuth renewal, billing checkout, message delivery, or Marketplace approval.'});
  const effectiveTier=billing.entitled?billing.tier:'free';
  const internalPlan:PlanId=effectiveTier==='enterprise'?'beta_growth':effectiveTier==='growth'?'growth':'free';
  await requireIntelligenceAdministrator(env,identity,false);
  return {generatedAt:new Date().toISOString(),noActionsExecuted:true,liveAcceptanceVerified:false,checks,
    missingRequiredScopes:missing,scopeProvenance:scopes===null?'unavailable':'recorded_oauth_grant',
    optionalCommercial:{lineItemsAuthorized:scopes?.includes(OPTIONAL_COMMERCIAL_HUBSPOT_SCOPES[0])??false,quotesAuthorized:scopes?.includes(OPTIONAL_COMMERCIAL_HUBSPOT_SCOPES[1])??false},
    billing:{recordedTier:billing.tier,effectiveTier,status:billing.status,entitled:billing.entitled,interval:billing.billingInterval,usageMode:billing.usageMode,
      checkoutConfigured:billing.checkoutConfigured,portalConfigured:billing.portalConfigured},
    limits:{dealsPerScan:PLAN_LIMITS[internalPlan].maxDealsPerScan,minimumScanIntervalMinutes:PLAN_LIMITS[internalPlan].minScanIntervalMinutes,historyDays:PLAN_LIMITS[internalPlan].historyDays},
    recordedEvidence:{deals:stats?.recorded??0,openDeals:stats?.open??0,latestAssessment:stats?.latest??null,latestAssessmentAge:age.status},
    latestScan,optionalConsent:{ai:consents.find(c=>c.capability==='ai')??{enabled:false,revision:0},outcomes:consents.find(c=>c.capability==='outcomes')??{enabled:false,revision:0},breeze:breeze??{enabled:false,revision:0}},
    nextStep:checks.find(c=>c.state==='action_required')?.code??'review_live_acceptance',
    dataBoundary:'Portal-wide administrator only. No CRM mutations, subscriptions, messages or AI-provider calls are made by this report.'};
}
