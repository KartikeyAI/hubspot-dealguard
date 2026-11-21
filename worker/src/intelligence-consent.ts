import { requireCommercialTier } from './billing.js';
import { requireEnterprisePermission } from './enterprise-access.js';
import { AppError } from './errors.js';
import { requireRecordActor } from './record-access.js';
import type { Env, RequestIdentity } from './types.js';
export type Capability = 'outcomes' | 'ai';
export interface Consent { enabled: boolean; revision: number }
export async function requireIntelligenceAdministrator(env: Env, identity: RequestIdentity, entitlement = true): Promise<void> {
  if (!identity.userId) throw new AppError(403,'identified_administrator_required','A signed HubSpot user ID is required.');
  await requireRecordActor(env,identity,'analytics.view');
  const context = await requireEnterprisePermission(env,identity,'role.manage');
  if (context.role !== 'administrator') throw new AppError(403,'administrator_required','A portal-wide administrator is required.');
  if (entitlement) await requireCommercialTier(env,identity.portalId,'enterprise');
}
export async function getIntelligenceConsent(env: Env, portalId: string, capability: Capability): Promise<Consent> {
  return await env.DB.prepare('SELECT enabled,revision FROM dealguard.intelligence_consents WHERE portal_id=? AND capability=?')
    .bind(portalId,capability).first<Consent>() ?? {enabled:false,revision:0};
}
export async function requireIntelligenceConsent(env: Env, portalId: string, capability: Capability, revision?: number): Promise<Consent> {
  const c=await getIntelligenceConsent(env,portalId,capability);
  if (!c.enabled || (revision!==undefined && c.revision!==revision)) throw new AppError(403,'intelligence_consent_required','Current explicit consent is required for this capability.');
  return c;
}
export async function changeIntelligenceConsent(env: Env,identity:RequestIdentity,capability:Capability,value:unknown):Promise<Consent> {
  const input=value && typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
  if(typeof input.enabled!=='boolean'||!Number.isSafeInteger(input.revision)||Number(input.revision)<0
    ||input.confirmation!==(input.enabled?`ENABLE_${capability.toUpperCase()}`:`DISABLE_${capability.toUpperCase()}`))
    throw new AppError(400,'consent_confirmation_required','Use the current revision and exact enable or disable confirmation.');
  // Revocation is available even after a subscription expires.
  await requireIntelligenceAdministrator(env,identity,input.enabled);
  const result=await env.DB.prepare('SELECT dealguard.set_intelligence_consent(?,?,?,?,?) AS consent')
    .bind(identity.portalId,capability,input.enabled,input.revision,identity.userId).first<{consent:Consent|null}>();
  if(!result?.consent)throw new AppError(409,'consent_changed','Consent changed. Reload before trying again.');
  return {enabled:result.consent.enabled,revision:result.consent.revision};
}
export async function cleanupOutcomeEvidence(env:Env):Promise<void>{
  await env.DB.prepare(`DELETE FROM dealguard.outcome_datasets d WHERE
    NOT EXISTS(SELECT 1 FROM legal_holds h WHERE h.portal_id=d.portal_id AND h.status='active') AND
    (d.expires_at<NOW() OR NOT EXISTS(SELECT 1 FROM dealguard.intelligence_consents c WHERE c.portal_id=d.portal_id
    AND c.capability='outcomes' AND c.enabled AND c.revision=d.consent_revision))`).run();
}
