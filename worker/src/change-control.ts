import { assertChangeApprovalResult, createChangeApproval, normalizeEnterpriseRoleAssignment } from './enterprise-access.js';
import { AppError } from './errors.js';
import type { Env, RequestIdentity } from './types.js';

interface ApprovalRow { id: string; status: string; expires_at: string | null }
interface ExpectedChange { changeType: string; resourceType: string; resourceId: string; payload: unknown }

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonicalValue(item)]));
  return value;
}
export function canonicalChangePayload(value: unknown): string { return JSON.stringify(canonicalValue(value ?? {})); }
export function withoutApprovalFields(value: unknown): Record<string, unknown> {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? { ...value as Record<string, unknown> } : {};
  delete input.approvalId; delete input.approval_id;
  return input;
}

/** Discovery is advisory. The locked database operation repeats every check. */
async function approvedRequestId(env: Env, identity: RequestIdentity, approvalId: string, expected: ExpectedChange): Promise<string> {
  const authority = await env.DB.prepare("SELECT dealguard.controlled_change_actor(?,?,?,'apply',?) AS allowed")
    .bind(identity.portalId, identity.userId, identity.userEmail, expected.changeType).first<{allowed: boolean}>();
  if (!authority?.allowed) throw new AppError(403, 'change_apply_forbidden', 'Your current role cannot apply this high-impact change.');
  if (approvalId) return approvalId;
  const rows = await env.DB.prepare(`SELECT id,status,expires_at FROM change_approval_requests
    WHERE portal_id=? AND change_type=? AND resource_type=? AND resource_id=? AND requested_payload_json::jsonb=?::jsonb
      AND status IN ('approved','pending')
      AND CASE WHEN pg_input_is_valid(expires_at,'timestamp with time zone') THEN expires_at::timestamptz>clock_timestamp() ELSE FALSE END
      AND (change_type NOT IN ('role.assign','role.remove') OR target_state_json IS NOT NULL AND
        target_state_json=dealguard.controlled_role_target(portal_id,change_type,resource_id,requested_payload_json::jsonb))
    ORDER BY CASE WHEN status='approved' THEN 0 ELSE 1 END,requested_at DESC LIMIT 1`)
    .bind(identity.portalId, expected.changeType, expected.resourceType, expected.resourceId, canonicalChangePayload(expected.payload))
    .first<ApprovalRow>();
  if (rows?.status === 'approved') return rows.id;
  if (rows) throw new AppError(409, 'change_approval_pending', 'This exact change is awaiting independent approval.', {
    approvalId: rows.id, status: rows.status, expiresAt: rows.expires_at,
  });
  const created = await createChangeApproval(env, identity, expected);
  if (created.status === 'approved') return String(created.id);
  throw new AppError(409, created.created ? 'change_approval_created' : 'change_approval_pending',
    'This high-impact change requires a second administrator. Review it in Enterprise App Home, then apply the exact approved change.', {
      approvalId: created.id, status: created.status, expiresAt: created.expiresAt,
    });
}

export async function beginApprovedChange(env: Env, identity: RequestIdentity, approvalId: string, expected: ExpectedChange)
  : Promise<{approvalId: string; idempotencyKey: string; leaseToken: string; startedAt: string}> {
  const id = await approvedRequestId(env, identity, approvalId, expected);
  const result = await env.DB.prepare('SELECT dealguard.claim_controlled_change(?,?,?,?,?,?,?,?::jsonb,?) AS result')
    .bind(identity.portalId, identity.userId, identity.userEmail, id, expected.changeType, expected.resourceType,
      expected.resourceId, canonicalChangePayload(expected.payload), crypto.randomUUID())
    .first<{result: {error?: string; approvalId: string; leaseToken: string; startedAt: string}}>();
  const claimed = assertChangeApprovalResult(result?.result);
  return {...claimed, idempotencyKey: `dealguard-change-${id}`};
}

/** Approval, role mutation and both audit receipts commit together. */
export async function applyApprovedEnterpriseRoleChange(env: Env, identity: RequestIdentity, approvalId: string, expected: ExpectedChange)
  : Promise<{ok: boolean; approvalId: string; assignmentId?: string}> {
  const normalized = expected.changeType === 'role.assign' ? normalizeEnterpriseRoleAssignment(expected.payload) : {};
  const id = await approvedRequestId(env, identity, approvalId, expected);
  const result = await env.DB.prepare('SELECT dealguard.apply_approved_enterprise_role(?,?,?,?,?,?,?::jsonb,?::jsonb,?) AS result')
    .bind(identity.portalId, identity.userId, identity.userEmail, id, expected.changeType, expected.resourceId,
      canonicalChangePayload(expected.payload), JSON.stringify(normalized), crypto.randomUUID())
    .first<{result: {error?: string; ok: boolean; approvalId: string; assignmentId?: string}}>();
  return assertChangeApprovalResult(result?.result);
}

export async function completeApprovedChange(env: Env, identity: RequestIdentity, approvalId: string, leaseToken: string): Promise<void> {
  const result = await env.DB.prepare('SELECT dealguard.finish_controlled_change(?,?,?,?,?,TRUE,NULL) AS completed')
    .bind(identity.portalId, identity.userId, identity.userEmail, approvalId, leaseToken).first<{completed: boolean}>();
  if (!result?.completed) assertChangeApprovalResult({error: 'change_completion_conflict'});
}

export async function failApprovedChange(env: Env, identity: RequestIdentity, approvalId: string, leaseToken: string, error: unknown): Promise<void> {
  const code = error instanceof AppError ? error.code : 'change_application_failed';
  // A stale execution must never overwrite a newer lease or a completed action.
  await env.DB.prepare('SELECT dealguard.finish_controlled_change(?,?,?,?,?,FALSE,?) AS completed')
    .bind(identity.portalId, identity.userId, identity.userEmail, approvalId, leaseToken, code).first();
}
