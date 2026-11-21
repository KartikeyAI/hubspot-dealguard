import { sha256Hex } from './crypto.js';
import { AppError } from './errors.js';
import { evidenceInstant } from './evidence-freshness.js';
import { deleteTenantObjects } from './object-storage.js';
import type { Env, RequestIdentity } from './types.js';

interface DeletionClaim {
  portalId: string;
  epoch: string;
  token: string;
  requestedAt: string;
  uploadWindowEndsAt: string;
}
export interface PortalDeletionStatus {
  status: 'pending' | 'held' | 'completed';
  completedAt?: string;
  retryAt?: string | null;
  reason?: string | null;
}

/** Completion must name a receipt from this request window and have no current
 * tenant. An older deletion receipt cannot prove erasure of a newer install. */
export async function verifiedPortalDeletionReceipt(env: Env, portalId: string, notBefore?: string): Promise<{completedAt: string} | null> {
  const reference = await sha256Hex(`dealguard-deleted:${portalId}`);
  const row = await env.DB.prepare(`SELECT created_at,metadata_json FROM audit_events WHERE portal_id=? AND action='data.deleted'
    AND user_id IS NULL AND user_email IS NULL AND NOT EXISTS(SELECT 1 FROM tenants WHERE portal_id=?) ORDER BY created_at DESC LIMIT 1`)
    .bind(reference,portalId).first<{created_at: string; metadata_json: string}>();
  const completedAt = evidenceInstant(row?.created_at);
  if (!row || !completedAt || Date.parse(completedAt)>Date.now()) return null;
  if (notBefore !== undefined && (!evidenceInstant(notBefore) || Date.parse(completedAt)<Date.parse(notBefore))) return null;
  try { if (JSON.stringify(JSON.parse(row.metadata_json))!=='{}') return null; } catch { return null; }
  return {completedAt};
}

async function deletionStatus(env: Env, portalId: string): Promise<PortalDeletionStatus> {
  const row = await env.DB.prepare(`SELECT status,deletion_last_error,
    to_char(deletion_next_attempt_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS retry_at,
    deletion_requested_at IS NOT NULL AND deletion_source_epoch=authorization_epoch_at AS authorized
    FROM tenants WHERE portal_id=?`).bind(portalId).first<{status: string;deletion_last_error: string|null;retry_at: string|null;authorized: boolean}>();
  if (!row) {
    const receipt = await verifiedPortalDeletionReceipt(env,portalId);
    if (receipt) return {status:'completed',...receipt};
  }
  if (!row?.authorized || row.status!=='deleted') throw new AppError(409,'deletion_state_changed','No current authorized deletion is pending for this installation.');
  return {status:row.deletion_last_error==='legal_hold'?'held':'pending',retryAt:row.retry_at,reason:row.deletion_last_error};
}

async function claimDeletion(env: Env, portalId: string|null): Promise<DeletionClaim|null> {
  const row = await env.DB.prepare('SELECT dealguard.claim_portal_deletion(?,?) AS claim')
    .bind(portalId,crypto.randomUUID()).first<{claim: DeletionClaim|null}>();
  return row?.claim??null;
}

async function checkClaim(env: Env, claim: DeletionClaim): Promise<void> {
  const row = await env.DB.prepare('SELECT dealguard.portal_deletion_guard(?,?::timestamptz,?) AS state')
    .bind(claim.portalId,claim.epoch,claim.token).first<{state: string}>();
  if (row?.state==='legal_hold') throw new AppError(409,'deletion_legal_hold','A legal hold pauses this deletion.');
  if (row?.state!=='ready') throw new AppError(409,'deletion_state_changed','This deletion attempt no longer owns its installation lease.');
}

async function deferDeletion(env: Env, claim: DeletionClaim, reason: string): Promise<void> {
  await env.DB.prepare('SELECT dealguard.defer_portal_deletion(?,?::timestamptz,?,?) AS deferred')
    .bind(claim.portalId,claim.epoch,claim.token,reason).first();
}

async function executeDeletion(env: Env, claim: DeletionClaim): Promise<PortalDeletionStatus> {
  try {
    const objects = await deleteTenantObjects(env,claim.portalId,{beforeRequest:()=>checkClaim(env,claim),maxPasses:3});
    await checkClaim(env,claim);
    if (!objects.complete) await deferDeletion(env,claim,'more_objects');
    else if (Date.now()<Date.parse(claim.uploadWindowEndsAt)) await deferDeletion(env,claim,'upload_window');
    else {
      const result = await env.DB.prepare('SELECT dealguard.finalize_portal_deletion(?,?::timestamptz,?) AS deleted')
        .bind(claim.portalId,claim.epoch,claim.token).first<{deleted: boolean}>();
      if (!result?.deleted) {
        await checkClaim(env,claim);
        await deferDeletion(env,claim,'source_changed');
      }
    }
  } catch (error) {
    const reason = error instanceof AppError && error.code==='deletion_legal_hold' ? 'legal_hold'
      : error instanceof AppError && error.code==='deletion_state_changed' ? 'source_changed'
        : error instanceof AppError && error.code==='object_storage_deletion_response_invalid' ? 'storage_invalid_response' : 'storage_retryable';
    // Only the current source/lease may record a retry. Provider bodies, object
    // names and credential material are never persisted as failure text.
    await deferDeletion(env,claim,reason);
  }
  return deletionStatus(env,claim.portalId);
}

/** The signed request already committed authorization as an epoch-bound intent.
 * Transient storage failures return accepted/pending and are resumed by maintenance. */
export async function finalizePortalDeletion(env: Env, identity: RequestIdentity): Promise<PortalDeletionStatus> {
  const claim = await claimDeletion(env,identity.portalId);
  return claim ? executeDeletion(env,claim) : deletionStatus(env,identity.portalId);
}

export async function resumePendingPortalDeletions(env: Env, limit=1, portalId?: string): Promise<{attempted: number;completed: number}> {
  const maximum=Number.isSafeInteger(limit)?Math.max(1,Math.min(5,limit)):1;
  let attempted=0,completed=0;
  for(let i=0;i<maximum;i++) {
    const claim=await claimDeletion(env,portalId??null);
    if(!claim) break;
    attempted++;
    const result=await executeDeletion(env,claim);
    if(result.status==='completed') completed++;
  }
  return {attempted,completed};
}
