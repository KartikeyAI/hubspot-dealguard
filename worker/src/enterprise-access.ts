import { AppError } from './errors.js';
import { governanceContext } from './governance.js';
import { Repository } from './repository.js';
import type { Env, RequestIdentity } from './types.js';

export type EnterpriseRole =
  | 'administrator'
  | 'policy_administrator'
  | 'revops_manager'
  | 'sales_manager'
  | 'reviewer'
  | 'remediation_manager'
  | 'compliance_auditor'
  | 'billing_administrator'
  | 'viewer';

export interface EnterpriseScope {
  pipelineIds: string[];
  teamIds: string[];
  ownerIds: string[];
  regionCodes: string[];
}

export interface EnterpriseAccessContext {
  role: EnterpriseRole;
  permissions: string[];
  scope: EnterpriseScope;
  bootstrap: boolean;
}

interface RoleRow {
  id: string;
  user_id: string | null;
  user_email: string | null;
  role: EnterpriseRole;
  permissions_json: string;
  pipeline_ids_json: string;
  team_ids_json: string;
  owner_ids_json: string;
  region_codes_json: string;
  created_at: string;
  updated_at: string;
}

const ROLE_PERMISSIONS: Record<EnterpriseRole, string[]> = {
  administrator: ['*'],
  policy_administrator: [
    'policy.view', 'policy.manage', 'policy.submit', 'policy.simulate', 'policy.import', 'policy.export',
    'exception.request', 'exception.manage', 'analytics.view', 'analytics.export', 'audit.view',
    'reliability.view',
  ],
  revops_manager: [
    'policy.view', 'policy.simulate', 'exception.request', 'exception.manage',
    'analytics.view', 'analytics.export', 'remediation.view', 'remediation.manage',
    'alert.view', 'alert.manage', 'scan.run', 'audit.view',
    'reliability.view', 'reliability.manage',
  ],
  sales_manager: [
    'policy.view', 'exception.request', 'analytics.view', 'remediation.view', 'remediation.manage',
    'alert.view', 'alert.acknowledge', 'scan.run',
  ],
  reviewer: [
    'policy.view', 'policy.approve', 'exception.manage', 'analytics.view', 'remediation.view',
    'remediation.review', 'audit.view',
  ],
  remediation_manager: [
    'analytics.view', 'remediation.view', 'remediation.manage', 'remediation.bulk',
    'remediation.evidence', 'alert.view', 'alert.acknowledge', 'reliability.view',
  ],
  compliance_auditor: [
    'policy.view', 'analytics.view', 'audit.view', 'audit.export', 'compliance.view',
    'compliance.manage', 'legal_hold.manage', 'data_export.manage', 'siem.manage',
    'reliability.view',
  ],
  billing_administrator: [
    'billing.view', 'billing.manage', 'billing.allowance.manage', 'billing.contract.manage',
    'billing.usage.view', 'audit.view',
  ],
  viewer: ['policy.view', 'analytics.view', 'remediation.view', 'alert.view', 'billing.view'],
};

function array(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function uniqueStrings(value: unknown, max = 500): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim().slice(0, 128)))].slice(0, max);
}

function mapRow(row: RoleRow): EnterpriseAccessContext {
  const explicit = array(row.permissions_json);
  return {
    role: row.role,
    permissions: [...new Set([...ROLE_PERMISSIONS[row.role], ...explicit])],
    scope: {
      pipelineIds: array(row.pipeline_ids_json),
      teamIds: array(row.team_ids_json),
      ownerIds: array(row.owner_ids_json),
      regionCodes: array(row.region_codes_json),
    },
    bootstrap: false,
  };
}

export async function enterpriseAccessContext(env: Env, identity: RequestIdentity): Promise<EnterpriseAccessContext> {
  const row = identity.userId
    ? await env.DB.prepare(`SELECT * FROM enterprise_role_assignments WHERE portal_id = ? AND user_id = ? LIMIT 1`)
        .bind(identity.portalId, identity.userId).first<RoleRow>()
    : null;
  const byEmail = !row && identity.userEmail
    ? await env.DB.prepare(`SELECT * FROM enterprise_role_assignments WHERE portal_id = ? AND lower(user_email) = lower(?) LIMIT 1`)
        .bind(identity.portalId, identity.userEmail).first<RoleRow>()
    : null;
  if (row || byEmail) return mapRow((row ?? byEmail)!);

  const legacy = await governanceContext(env, identity);
  const roleMap: Record<string, EnterpriseRole> = {
    admin: 'administrator',
    policy_admin: 'policy_administrator',
    approver: 'reviewer',
    manager: 'revops_manager',
    viewer: 'viewer',
  };
  const role = roleMap[legacy.role] ?? 'viewer';
  return {
    role,
    permissions: ROLE_PERMISSIONS[role],
    scope: { pipelineIds: [], teamIds: [], ownerIds: [], regionCodes: [] },
    bootstrap: legacy.installerBootstrap,
  };
}

export function permissionMatches(granted: string[], required: string): boolean {
  return granted.includes('*') || granted.includes(required) || granted.some((item) => item.endsWith('.*') && required.startsWith(item.slice(0, -1)));
}

export async function requireEnterprisePermission(
  env: Env,
  identity: RequestIdentity,
  permission: string,
  resource?: { pipelineId?: string | null; teamId?: string | null; ownerId?: string | null; regionCode?: string | null },
): Promise<EnterpriseAccessContext> {
  const context = await enterpriseAccessContext(env, identity);
  if (!permissionMatches(context.permissions, permission)) {
    throw new AppError(403, 'enterprise_permission_denied', `You do not have the ${permission} permission.`);
  }
  const checks: Array<[string[], string | null | undefined, string]> = [
    [context.scope.pipelineIds, resource?.pipelineId, 'pipeline'],
    [context.scope.teamIds, resource?.teamId, 'team'],
    [context.scope.ownerIds, resource?.ownerId, 'owner'],
    [context.scope.regionCodes, resource?.regionCode, 'region'],
  ];
  for (const [allowed, actual, label] of checks) {
    if (allowed.length > 0 && (!actual || !allowed.includes(actual))) {
      throw new AppError(403, 'enterprise_scope_denied', `This action is outside your assigned ${label} scope.`);
    }
  }
  return context;
}

export async function listEnterpriseRoles(env: Env, identity: RequestIdentity): Promise<Array<Record<string, unknown>>> {
  await requireEnterprisePermission(env, identity, 'role.manage');
  const rows = await env.DB.prepare(`SELECT * FROM enterprise_role_assignments WHERE portal_id = ? ORDER BY role, lower(COALESCE(user_email, ''))`)
    .bind(identity.portalId).all<RoleRow>();
  return (rows.results ?? []).map((row) => ({
    id: row.id,
    userId: row.user_id,
    userEmail: row.user_email,
    role: row.role,
    permissions: array(row.permissions_json),
    scope: {
      pipelineIds: array(row.pipeline_ids_json),
      teamIds: array(row.team_ids_json),
      ownerIds: array(row.owner_ids_json),
      regionCodes: array(row.region_codes_json),
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function assignEnterpriseRole(env: Env, identity: RequestIdentity, value: unknown): Promise<void> {
  await requireEnterprisePermission(env, identity, 'role.manage');
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const roles = Object.keys(ROLE_PERMISSIONS) as EnterpriseRole[];
  const role = roles.includes(input.role as EnterpriseRole) ? input.role as EnterpriseRole : null;
  const userId = typeof input.userId === 'string' && input.userId.trim() ? input.userId.trim().slice(0, 128) : null;
  const userEmail = typeof input.userEmail === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.userEmail.trim())
    ? input.userEmail.trim().toLowerCase().slice(0, 254)
    : null;
  if (!role || (!userId && !userEmail)) throw new AppError(400, 'enterprise_role_fields_required', 'A valid role and HubSpot user ID or email are required.');
  if (role === 'administrator' && identity.userEmail && userEmail && identity.userEmail.toLowerCase() === userEmail) {
    const count = await env.DB.prepare(`SELECT COUNT(*) AS count FROM enterprise_role_assignments WHERE portal_id = ? AND role = 'administrator' AND lower(COALESCE(user_email, '')) != lower(?)`)
      .bind(identity.portalId, userEmail).first<{ count: number }>();
    if (Number(count?.count ?? 0) === 0) throw new AppError(409, 'last_administrator_protection', 'Assign another administrator before replacing your own administrator assignment.');
  }
  const permissions = uniqueStrings(input.permissions, 250);
  const scopeInput = input.scope && typeof input.scope === 'object' ? input.scope as Record<string, unknown> : {};
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO enterprise_role_assignments (
      id, portal_id, user_id, user_email, role, permissions_json, pipeline_ids_json, team_ids_json,
      owner_ids_json, region_codes_json, created_by_user_id, created_by_email, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(portal_id, user_id) DO UPDATE SET user_email = excluded.user_email, role = excluded.role,
      permissions_json = excluded.permissions_json, pipeline_ids_json = excluded.pipeline_ids_json,
      team_ids_json = excluded.team_ids_json, owner_ids_json = excluded.owner_ids_json,
      region_codes_json = excluded.region_codes_json, updated_at = excluded.updated_at`
  ).bind(
    id, identity.portalId, userId, userEmail, role, JSON.stringify(permissions),
    JSON.stringify(uniqueStrings(scopeInput.pipelineIds)), JSON.stringify(uniqueStrings(scopeInput.teamIds)),
    JSON.stringify(uniqueStrings(scopeInput.ownerIds)), JSON.stringify(uniqueStrings(scopeInput.regionCodes)),
    identity.userId, identity.userEmail, now, now,
  ).run();
  if (!userId && userEmail) {
    await env.DB.prepare(
      `UPDATE enterprise_role_assignments SET role = ?, permissions_json = ?, pipeline_ids_json = ?, team_ids_json = ?,
       owner_ids_json = ?, region_codes_json = ?, updated_at = ? WHERE portal_id = ? AND lower(user_email) = lower(?)`
    ).bind(role, JSON.stringify(permissions), JSON.stringify(uniqueStrings(scopeInput.pipelineIds)), JSON.stringify(uniqueStrings(scopeInput.teamIds)), JSON.stringify(uniqueStrings(scopeInput.ownerIds)), JSON.stringify(uniqueStrings(scopeInput.regionCodes)), now, identity.portalId, userEmail).run();
  }
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'enterprise_role.assigned', { userId, userEmail, role, permissions, scope: scopeInput });
}

export async function removeEnterpriseRole(env: Env, identity: RequestIdentity, assignmentId: string): Promise<void> {
  await requireEnterprisePermission(env, identity, 'role.manage');
  const row = await env.DB.prepare(`SELECT role, user_id, user_email FROM enterprise_role_assignments WHERE portal_id = ? AND id = ?`)
    .bind(identity.portalId, assignmentId).first<{ role: EnterpriseRole; user_id: string | null; user_email: string | null }>();
  if (!row) throw new AppError(404, 'enterprise_role_not_found', 'The role assignment does not exist.');
  if (row.role === 'administrator') {
    const count = await env.DB.prepare(`SELECT COUNT(*) AS count FROM enterprise_role_assignments WHERE portal_id = ? AND role = 'administrator'`)
      .bind(identity.portalId).first<{ count: number }>();
    if (Number(count?.count ?? 0) <= 1) throw new AppError(409, 'last_administrator_protection', 'The final enterprise administrator cannot be removed.');
  }
  await env.DB.prepare(`DELETE FROM enterprise_role_assignments WHERE portal_id = ? AND id = ?`).bind(identity.portalId, assignmentId).run();
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'enterprise_role.removed', { assignmentId, ...row });
}

export async function createChangeApproval(
  env: Env,
  identity: RequestIdentity,
  input: { changeType: string; resourceType: string; resourceId: string; payload: unknown; expiresAt?: string | null },
): Promise<Record<string, unknown>> {
  await requireEnterprisePermission(env, identity, 'change.request');
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const expiresAt = input.expiresAt && Number.isFinite(Date.parse(input.expiresAt))
    ? new Date(input.expiresAt).toISOString()
    : new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString();
  await env.DB.prepare(
    `INSERT INTO change_approval_requests (
      id, portal_id, change_type, resource_type, resource_id, requested_payload_json, status,
      requested_by_user_id, requested_by_email, requested_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`
  ).bind(id, identity.portalId, input.changeType.slice(0, 100), input.resourceType.slice(0, 100), input.resourceId.slice(0, 255), JSON.stringify(input.payload ?? {}), identity.userId, identity.userEmail, now, expiresAt).run();
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'change_approval.requested', { approvalId: id, changeType: input.changeType, resourceType: input.resourceType, resourceId: input.resourceId });
  return { id, status: 'pending', requestedAt: now, expiresAt };
}

export async function decideChangeApproval(
  env: Env,
  identity: RequestIdentity,
  approvalId: string,
  decision: 'approved' | 'rejected',
  comment: string,
): Promise<Record<string, unknown>> {
  await requireEnterprisePermission(env, identity, 'change.approve');
  const row = await env.DB.prepare(`SELECT * FROM change_approval_requests WHERE portal_id = ? AND id = ?`)
    .bind(identity.portalId, approvalId).first<Record<string, unknown>>();
  if (!row) throw new AppError(404, 'change_approval_not_found', 'The approval request does not exist.');
  if (String(row.status) !== 'pending') throw new AppError(409, 'change_approval_decided', 'The approval request has already been decided.');
  if ((identity.userId && String(row.requested_by_user_id ?? '') === identity.userId) ||
      (identity.userEmail && String(row.requested_by_email ?? '').toLowerCase() === identity.userEmail.toLowerCase())) {
    throw new AppError(409, 'change_self_approval_forbidden', 'The requester cannot approve their own high-impact change.');
  }
  if (row.expires_at && Date.parse(String(row.expires_at)) <= Date.now()) {
    await env.DB.prepare(`UPDATE change_approval_requests SET status = 'expired' WHERE portal_id = ? AND id = ?`).bind(identity.portalId, approvalId).run();
    throw new AppError(409, 'change_approval_expired', 'The approval request has expired.');
  }
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE change_approval_requests SET status = ?, decided_by_user_id = ?, decided_by_email = ?,
     decision_comment = ?, decided_at = ? WHERE portal_id = ? AND id = ?`
  ).bind(decision, identity.userId, identity.userEmail, comment.slice(0, 2000), now, identity.portalId, approvalId).run();
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, `change_approval.${decision}`, { approvalId, comment });
  return { id: approvalId, status: decision, decidedAt: now };
}

export async function listChangeApprovals(env: Env, identity: RequestIdentity, status = ''): Promise<Array<Record<string, unknown>>> {
  await requireEnterprisePermission(env, identity, 'change.view');
  const rows = await env.DB.prepare(
    `SELECT * FROM change_approval_requests WHERE portal_id = ? AND (? = '' OR status = ?) ORDER BY requested_at DESC LIMIT 500`
  ).bind(identity.portalId, status, status).all<Record<string, unknown>>();
  return (rows.results ?? []).map((row) => ({
    id: row.id,
    changeType: row.change_type,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    payload: JSON.parse(String(row.requested_payload_json ?? '{}')),
    status: row.status,
    requestedByEmail: row.requested_by_email,
    decidedByEmail: row.decided_by_email,
    decisionComment: row.decision_comment,
    requestedAt: row.requested_at,
    decidedAt: row.decided_at,
    expiresAt: row.expires_at,
  }));
}
