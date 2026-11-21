import { AppError } from './errors.js';
import { governanceContext } from './governance.js';
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
  /** A stored enterprise assignment bound to a stable numeric HubSpot user ID. */
  explicitAssignment: boolean;
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
  matching_emails?: number;
}

const ROLE_PERMISSIONS: Record<EnterpriseRole, string[]> = {
  administrator: ['*'],
  policy_administrator: [
    'policy.view', 'policy.manage', 'policy.submit', 'policy.simulate', 'policy.import', 'policy.export',
    'exception.request', 'exception.manage', 'analytics.view', 'analytics.export', 'audit.view',
    'reliability.view',
  ],
  revops_manager: [
    'deal.review', 'handoff.confirm',
    'policy.view', 'policy.simulate', 'exception.request', 'exception.manage',
    'analytics.view', 'analytics.export', 'remediation.view', 'remediation.manage',
    'alert.view', 'alert.manage', 'scan.run', 'audit.view',
    'reliability.view', 'reliability.manage',
  ],
  sales_manager: [
    'deal.review', 'handoff.confirm',
    'policy.view', 'exception.request', 'analytics.view', 'remediation.view', 'remediation.manage',
    'alert.view', 'alert.acknowledge', 'scan.run',
  ],
  reviewer: [
    'deal.review', 'handoff.confirm',
    'policy.view', 'policy.approve', 'exception.manage', 'analytics.view', 'remediation.view',
    'remediation.review', 'audit.view',
  ],
  remediation_manager: [
    'deal.review',
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

function mapRow(row: RoleRow): EnterpriseAccessContext {
  if (!Object.hasOwn(ROLE_PERMISSIONS,row.role)) throw new AppError(403, 'enterprise_role_invalid', 'The assigned role cannot be validated.');
  const scopeArray = (value: string): string[] => {
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { throw new AppError(403, 'enterprise_scope_invalid', 'The assigned data scope cannot be validated.'); }
    if (!Array.isArray(parsed) || parsed.length > 500 || parsed.some(item => typeof item !== 'string' || !item || item.trim() !== item || item.length > 128)) {
      throw new AppError(403, 'enterprise_scope_invalid', 'The assigned data scope cannot be validated.');
    }
    return parsed;
  };
  const explicit = array(row.permissions_json);
  return {
    role: row.role,
    permissions: [...new Set([...ROLE_PERMISSIONS[row.role], ...explicit])],
    scope: {
      pipelineIds: scopeArray(row.pipeline_ids_json),
      teamIds: scopeArray(row.team_ids_json),
      ownerIds: scopeArray(row.owner_ids_json),
      regionCodes: scopeArray(row.region_codes_json),
    },
    bootstrap: false,
    explicitAssignment: typeof row.user_id === 'string' && /^[0-9]{1,32}$/.test(row.user_id),
  };
}

/** Resolve only explicit assignments. A conflicting email is an authoritative
 * restricted result, so callers cannot use it to fall back to installer access. */
export async function assignedEnterpriseAccessContext(env: Env, identity: RequestIdentity): Promise<EnterpriseAccessContext | null> {
  const unassignedViewer = (): EnterpriseAccessContext => ({ role: 'viewer', permissions: ROLE_PERMISSIONS.viewer,
    scope: { pipelineIds: [], teamIds: [], ownerIds: [], regionCodes: [] }, bootstrap: false, explicitAssignment: false });
  const row = identity.userId
    ? await env.DB.prepare(`SELECT * FROM enterprise_role_assignments WHERE portal_id = ? AND user_id = ? LIMIT 1`)
        .bind(identity.portalId, identity.userId).first<RoleRow>()
    : null;
  const byEmail = !row && identity.userEmail
    ? await env.DB.prepare(`SELECT *, COUNT(*) OVER () AS matching_emails FROM enterprise_role_assignments WHERE portal_id = ? AND lower(user_email) = lower(?) LIMIT 1`)
        .bind(identity.portalId, identity.userEmail).first<RoleRow>()
    : null;
  if (byEmail && (Number(byEmail.matching_emails ?? 1) !== 1 || (byEmail.user_id !== null && byEmail.user_id !== identity.userId))) return unassignedViewer();
  if (row || byEmail) return mapRow((row ?? byEmail)!);
  return null;
}

export async function enterpriseAccessContext(env: Env, identity: RequestIdentity): Promise<EnterpriseAccessContext> {
  const assigned = await assignedEnterpriseAccessContext(env, identity);
  if (assigned) return assigned;
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
    explicitAssignment: false,
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
  assertEnterprisePermission(context, permission, resource);
  return context;
}

export function assertEnterprisePermission(
  context: EnterpriseAccessContext,
  permission: string,
  resource?: { pipelineId?: string | null; teamId?: string | null; ownerId?: string | null; regionCode?: string | null },
): void {
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
}

const ADDITIONAL_ROLE_PERMISSIONS = ['forecast.approve', 'ai.use', 'breeze.use'];
const ROLE_SCOPE_FIELDS = ['pipelineIds', 'teamIds', 'ownerIds', 'regionCodes'] as const;

async function requireRoleManager(env: Env, identity: RequestIdentity): Promise<EnterpriseAccessContext> {
  if ((!identity.userId && !identity.userEmail) || (identity.userId != null && !/^[0-9]{1,32}$/.test(identity.userId))) {
    throw new AppError(403, 'identified_user_required', 'An identified HubSpot user is required.');
  }
  const tenant = await env.DB.prepare('SELECT status FROM tenants WHERE portal_id=?').bind(identity.portalId).first<{status: string}>();
  if (tenant?.status !== 'active') throw new AppError(403, 'installation_inactive', 'This DealGuard installation is not active.');
  return requireEnterprisePermission(env, identity, 'role.manage');
}

function roleResultError(value: {error?: string} | null | undefined): void {
  if (value && !value.error) return;
  const errors: Record<string, [number, string]> = {
    installation_inactive: [403, 'This DealGuard installation is not active.'],
    identified_user_required: [403, 'An identified HubSpot user is required.'],
    enterprise_permission_denied: [403, 'You do not have permission to manage enterprise roles.'],
    enterprise_scope_denied: [403, 'Role administration requires portal-wide access.'],
    enterprise_role_not_found: [404, 'The role assignment does not exist.'],
    enterprise_role_input_invalid: [400, 'Provide a valid role, numeric HubSpot user ID, supported additional permissions and complete scope arrays.'],
    enterprise_role_binding_conflict: [409, 'The user ID and email identify different or ambiguous assignments. Resolve the existing binding before saving.'],
    enterprise_bootstrap_administrator_required: [409, 'Initial setup must establish a portal-wide administrator with a stable HubSpot user ID.'],
    enterprise_role_authorization_changed: [409, 'Your role administration access changed. Reload before retrying.'],
    last_administrator_protection: [409, 'Keep another portal-wide administrator with a stable HubSpot user ID before removing, demoting or restricting this administrator.'],
  };
  const code = value?.error ?? 'enterprise_role_change_failed';
  const [status, message] = errors[code] ?? [409, 'Role administration changed. Reload before retrying.'];
  throw new AppError(status, code, message);
}

export async function listEnterpriseRoles(env: Env, identity: RequestIdentity): Promise<Array<Record<string, unknown>>> {
  await requireRoleManager(env, identity);
  const result = await env.DB.prepare('SELECT dealguard.list_enterprise_roles(?,?,?) AS result')
    .bind(identity.portalId, identity.userId, identity.userEmail).first<{result: {error?: string; roles?: RoleRow[]}}>();
  roleResultError(result?.result);
  return (result?.result.roles ?? []).map((row) => ({
    id: row.id, userId: row.user_id, userEmail: row.user_email, role: row.role,
    permissions: array(row.permissions_json),
    scope: { pipelineIds: array(row.pipeline_ids_json), teamIds: array(row.team_ids_json),
      ownerIds: array(row.owner_ids_json), regionCodes: array(row.region_codes_json) },
    createdAt: row.created_at, updatedAt: row.updated_at,
  }));
}

export function normalizeEnterpriseRoleAssignment(value: unknown): Record<string, unknown> {
  const invalid = (): never => { throw new AppError(400, 'enterprise_role_input_invalid',
    'Provide a valid role, numeric HubSpot user ID, supported additional permissions and complete scope arrays.'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['userId','userEmail','role','permissions','scope'].includes(key))) invalid();
  const role = typeof input.role === 'string' && Object.hasOwn(ROLE_PERMISSIONS, input.role) ? input.role as EnterpriseRole : null;
  const userId = typeof input.userId === 'string' && /^[0-9]{1,32}$/.test(input.userId) ? input.userId : null;
  if (!role || !userId) invalid();
  if (input.userEmail != null && (typeof input.userEmail !== 'string' || input.userEmail.length > 254
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.userEmail.trim()))) invalid();
  const userEmail = typeof input.userEmail === 'string' ? input.userEmail.trim().toLowerCase() : null;
  const rawPermissions = input.permissions === undefined ? [] : input.permissions;
  if (!Array.isArray(rawPermissions) || rawPermissions.length > ADDITIONAL_ROLE_PERMISSIONS.length
    || rawPermissions.some(permission => typeof permission !== 'string' || !ADDITIONAL_ROLE_PERMISSIONS.includes(permission))) invalid();
  const permissions = [...new Set(rawPermissions as string[])];
  const scope = input.scope;
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)
    || Object.keys(scope).some(key => !ROLE_SCOPE_FIELDS.includes(key as typeof ROLE_SCOPE_FIELDS[number]))) invalid();
  const scopeInput = scope as Record<string, unknown>;
  const normalizedScope = Object.fromEntries(ROLE_SCOPE_FIELDS.map(key => {
    const values = scopeInput[key];
    if (!Array.isArray(values) || values.length > 500 || values.some(item => typeof item !== 'string'
      || !item || item.length > 128 || item.trim() !== item)) invalid();
    return [key, [...new Set(values as string[])]];
  }));
  return {userId, userEmail, role, permissions, scope: normalizedScope};
}

export async function assignEnterpriseRole(env: Env, identity: RequestIdentity, value: unknown): Promise<void> {
  const access = await requireRoleManager(env, identity);
  const normalized = normalizeEnterpriseRoleAssignment(value);
  const result = await env.DB.prepare('SELECT dealguard.mutate_enterprise_role(?,?,?,?,?,?::jsonb) AS result')
    .bind(identity.portalId, identity.userId, identity.userEmail, access.bootstrap, 'assign', JSON.stringify(normalized)).first<{result: {error?: string}}>();
  roleResultError(result?.result);
}

export async function removeEnterpriseRole(env: Env, identity: RequestIdentity, assignmentId: string): Promise<void> {
  const access = await requireRoleManager(env, identity);
  if (!assignmentId || assignmentId.length > 128 || assignmentId.trim() !== assignmentId) {
    throw new AppError(400, 'enterprise_role_input_invalid', 'Provide a valid role assignment ID.');
  }
  const result = await env.DB.prepare('SELECT dealguard.mutate_enterprise_role(?,?,?,?,?,?::jsonb) AS result')
    .bind(identity.portalId, identity.userId, identity.userEmail, access.bootstrap, 'remove',
      JSON.stringify({assignmentId})).first<{result: {error?: string}}>();
  roleResultError(result?.result);
}

/** Shared safe error mapping for the atomic approval operations. */
export function assertChangeApprovalResult<T extends {error?: string}>(value: T | null | undefined): T {
  if (value && !value.error) return value;
  const messages: Record<string, [number, string]> = {
    change_request_forbidden: [403, 'Your current role cannot request this change.'],
    change_review_forbidden: [403, 'An identified, authorized administrator with portal-wide access must review this change.'],
    change_apply_forbidden: [403, 'Your current role cannot apply this change.'],
    change_approval_not_found: [404, 'The change approval does not exist.'],
    change_approval_fields_required: [400, 'Provide a valid change, exact payload and expiry within seven days.'],
    change_approval_decided: [409, 'This change has already been decided.'],
    change_self_approval_forbidden: [409, 'The requester cannot approve their own high-impact change.'],
    change_approval_expired: [409, 'This approval has expired. Request a new review.'],
    change_requester_revoked: [409, 'The requester no longer has authority for this change.'],
    change_approval_authority_changed: [409, 'The requester or reviewer no longer has authority. Request a new review.'],
    change_approval_target_changed: [409, 'The role assignment changed after this request. Request a new review of its current state.'],
    change_approval_payload_mismatch: [409, 'This action differs from the exact change that was approved.'],
    change_not_approved: [409, 'This change has not been approved.'],
    change_already_applied: [409, 'This approved change has already been applied.'],
    change_application_in_progress: [409, 'This change is already being applied.'],
    change_completion_conflict: [409, 'This execution no longer holds the change lease. Reload its status.'],
  };
  const code = value?.error ?? 'change_execution_invalid';
  if (!messages[code] && (code.startsWith('enterprise_') || code === 'last_administrator_protection')) roleResultError(value);
  const [status, message] = messages[code] ?? [409, 'The change could not be completed. Reload its current status.'];
  throw new AppError(status, code, message);
}

export async function createChangeApproval(
  env: Env, identity: RequestIdentity,
  input: { changeType: string; resourceType: string; resourceId: string; payload: unknown; expiresAt?: string | null },
): Promise<Record<string, unknown>> {
  if (input.changeType === 'role.assign') normalizeEnterpriseRoleAssignment(input.payload);
  const expiresAt = input.expiresAt == null ? new Date(Date.now() + 24 * 60 * 60_000).toISOString() : input.expiresAt;
  if (!Number.isFinite(Date.parse(expiresAt))) throw new AppError(400, 'change_approval_fields_required', 'Provide a valid approval expiry.');
  const result = await env.DB.prepare('SELECT dealguard.request_controlled_change(?,?,?,?,?,?,?,?::jsonb,?::timestamptz) AS result')
    .bind(identity.portalId, identity.userId, identity.userEmail, crypto.randomUUID(), input.changeType,
      input.resourceType, input.resourceId, JSON.stringify(input.payload ?? {}), expiresAt)
    .first<{result: Record<string, unknown> & {error?: string}}>();
  return assertChangeApprovalResult(result?.result);
}

export async function decideChangeApproval(
  env: Env, identity: RequestIdentity, approvalId: string,
  decision: 'approved' | 'rejected', comment: string,
): Promise<Record<string, unknown>> {
  const result = await env.DB.prepare('SELECT dealguard.decide_controlled_change(?,?,?,?,?,?) AS result')
    .bind(identity.portalId, identity.userId, identity.userEmail, approvalId, decision, typeof comment === 'string' ? comment.slice(0, 2000) : '')
    .first<{result: Record<string, unknown> & {error?: string}}>();
  return assertChangeApprovalResult(result?.result);
}

export async function listChangeApprovals(env: Env, identity: RequestIdentity, status = ''): Promise<Array<Record<string, unknown>>> {
  await requireEnterprisePermission(env, identity, 'change.view');
  const tenant = await env.DB.prepare('SELECT status FROM tenants WHERE portal_id=?').bind(identity.portalId).first<{status: string}>();
  if (tenant?.status !== 'active') throw new AppError(403, 'installation_inactive', 'This DealGuard installation is not active.');
  const rows = await env.DB.prepare(
    `SELECT * FROM change_approval_requests WHERE portal_id = ? AND change_type NOT LIKE 'role.bootstrap%'
      AND (? = '' OR status = ?) ORDER BY requested_at DESC LIMIT 500`
  ).bind(identity.portalId, status, status).all<Record<string, unknown>>();
  return (rows.results ?? []).map((row) => ({
    id: row.id, changeType: row.change_type, resourceType: row.resource_type, resourceId: row.resource_id,
    payload: JSON.parse(String(row.requested_payload_json ?? '{}')), targetState: row.target_state_json,
    status: row.status, requestedByUserId: row.requested_by_user_id, requestedByEmail: row.requested_by_email,
    decidedByUserId: row.decided_by_user_id, decidedByEmail: row.decided_by_email,
    decisionComment: row.decision_comment, requestedAt: row.requested_at, decidedAt: row.decided_at, expiresAt: row.expires_at,
  }));
}
