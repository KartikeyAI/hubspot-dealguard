import { sha256Hex } from './crypto.js';
import { requireEnterprisePermission } from './enterprise-access.js';
import { AppError } from './errors.js';
import { Repository } from './repository.js';
import type { Env, RequestIdentity } from './types.js';

interface ApprovalRow {
  id: string;
  portal_id: string;
  change_type: string;
  resource_type: string;
  resource_id: string;
  requested_payload_json: string;
  status: 'pending' | 'approved' | 'rejected' | 'applied' | 'cancelled' | 'expired';
  expires_at: string | null;
  requested_by_user_id: string | null;
  requested_by_email: string | null;
  decided_by_user_id: string | null;
  decided_by_email: string | null;
}

interface ExecutionRow {
  approval_id: string;
  status: 'applying' | 'completed' | 'failed';
  attempts: number;
  lease_expires_at: string | null;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  return value;
}

export function canonicalChangePayload(value: unknown): string {
  return JSON.stringify(canonicalValue(value ?? {}));
}

export function withoutApprovalFields(value: unknown): Record<string, unknown> {
  const input = value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
  delete input.approvalId;
  delete input.approval_id;
  return input;
}

async function approvedRequest(
  env: Env,
  identity: RequestIdentity,
  approvalId: string,
  expected: { changeType: string; resourceType: string; resourceId: string; payload: unknown },
): Promise<ApprovalRow> {
  await requireEnterprisePermission(env, identity, 'change.apply');
  if (!approvalId) throw new AppError(409, 'change_approval_required', 'An approved change request is required for this enterprise action.');
  const row = await env.DB.prepare(
    `SELECT * FROM change_approval_requests WHERE portal_id = ? AND id = ?`,
  ).bind(identity.portalId, approvalId).first<ApprovalRow>();
  if (!row) throw new AppError(404, 'change_approval_not_found', 'The requested change approval does not exist.');
  if (row.status !== 'approved') throw new AppError(409, 'change_not_approved', `The change request is ${row.status}, not approved.`);
  if (row.expires_at && Date.parse(row.expires_at) < Date.now()) {
    await env.DB.prepare(
      `UPDATE change_approval_requests SET status = 'expired' WHERE id = ? AND portal_id = ? AND status = 'approved'`,
    ).bind(row.id, identity.portalId).run();
    throw new AppError(409, 'change_approval_expired', 'The approved change request has expired.');
  }
  if (row.change_type !== expected.changeType
    || row.resource_type !== expected.resourceType
    || row.resource_id !== expected.resourceId) {
    throw new AppError(409, 'change_approval_scope_mismatch', 'The approved request does not authorize this resource or change type.');
  }
  const expectedHash = await sha256Hex(canonicalChangePayload(expected.payload));
  const approvedHash = await sha256Hex(canonicalChangePayload(JSON.parse(row.requested_payload_json || '{}')));
  if (expectedHash !== approvedHash) {
    throw new AppError(409, 'change_approval_payload_mismatch', 'The requested action differs from the payload that was approved.');
  }
  return row;
}

export async function beginApprovedChange(
  env: Env,
  identity: RequestIdentity,
  approvalId: string,
  expected: { changeType: string; resourceType: string; resourceId: string; payload: unknown },
): Promise<{ approvalId: string; idempotencyKey: string }> {
  const approval = await approvedRequest(env, identity, approvalId, expected);
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO change_approval_executions
     (approval_id, portal_id, status, attempts, lease_expires_at, started_at,
      applied_by_user_id, applied_by_email, updated_at)
     VALUES (?, ?, 'applying', 1, ?, ?, ?, ?, ?)`,
  ).bind(
    approval.id,
    identity.portalId,
    leaseExpiresAt,
    now.toISOString(),
    identity.userId,
    identity.userEmail,
    now.toISOString(),
  ).run();
  if (Number(inserted.meta?.changes ?? 0) === 0) {
    const execution = await env.DB.prepare(
      `SELECT approval_id, status, attempts, lease_expires_at
       FROM change_approval_executions WHERE approval_id = ? AND portal_id = ?`,
    ).bind(approval.id, identity.portalId).first<ExecutionRow>();
    if (!execution) throw new AppError(500, 'change_execution_missing', 'The approved change execution could not be loaded.');
    if (execution.status === 'completed') throw new AppError(409, 'change_already_applied', 'This approved change has already been applied.');
    if (execution.status === 'applying' && execution.lease_expires_at && Date.parse(execution.lease_expires_at) > Date.now()) {
      throw new AppError(409, 'change_application_in_progress', 'This approved change is already being applied.');
    }
    const claimed = await env.DB.prepare(
      `UPDATE change_approval_executions SET status = 'applying', attempts = attempts + 1,
       lease_expires_at = ?, applied_by_user_id = ?, applied_by_email = ?, error_message = NULL,
       updated_at = ? WHERE approval_id = ? AND portal_id = ?
       AND (status = 'failed' OR lease_expires_at IS NULL OR lease_expires_at <= ?)`,
    ).bind(
      leaseExpiresAt,
      identity.userId,
      identity.userEmail,
      now.toISOString(),
      approval.id,
      identity.portalId,
      now.toISOString(),
    ).run();
    if (Number(claimed.meta?.changes ?? 0) !== 1) {
      throw new AppError(409, 'change_application_in_progress', 'The approved change could not be claimed for execution.');
    }
  }
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'change.application_started', {
    approvalId: approval.id,
    changeType: expected.changeType,
    resourceType: expected.resourceType,
    resourceId: expected.resourceId,
  });
  return { approvalId: approval.id, idempotencyKey: `dealguard-change-${approval.id}` };
}

export async function completeApprovedChange(
  env: Env,
  identity: RequestIdentity,
  approvalId: string,
): Promise<void> {
  const now = new Date().toISOString();
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE change_approval_executions SET status = 'completed', completed_at = ?, lease_expires_at = NULL,
       error_message = NULL, updated_at = ? WHERE approval_id = ? AND portal_id = ? AND status = 'applying'`,
    ).bind(now, now, approvalId, identity.portalId),
    env.DB.prepare(
      `UPDATE change_approval_requests SET status = 'applied', applied_at = ?
       WHERE id = ? AND portal_id = ? AND status = 'approved'`,
    ).bind(now, approvalId, identity.portalId),
  ]);
  if (Number(results[0]?.meta?.changes ?? 0) !== 1 || Number(results[1]?.meta?.changes ?? 0) !== 1) {
    throw new AppError(409, 'change_completion_conflict', 'The approved change could not be finalized atomically.');
  }
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'change.applied', { approvalId });
}

export async function failApprovedChange(
  env: Env,
  identity: RequestIdentity,
  approvalId: string,
  error: unknown,
): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1500);
  await env.DB.prepare(
    `UPDATE change_approval_executions SET status = 'failed', lease_expires_at = NULL,
     error_message = ?, updated_at = ? WHERE approval_id = ? AND portal_id = ? AND status = 'applying'`,
  ).bind(message, new Date().toISOString(), approvalId, identity.portalId).run();
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'change.application_failed', {
    approvalId,
    error: message,
  });
}
