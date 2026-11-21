import { AppError } from './errors.js';
import { governanceContext } from './governance.js';
import { assignedEnterpriseAccessContext, assertEnterprisePermission, requireEnterprisePermission } from './enterprise-access.js';
import type { Env, GovernanceRole, RequestIdentity } from './types.js';

export type OperationalPermission =
  | 'settings.manage'
  | 'integration.manage'
  | 'native_sync.manage'
  | 'scan.run'
  | 'digest.test'
  | 'data.delete'
  | 'remediation.manage'
  | 'delivery.manage'
  | 'outbox.replay'
  | 'billing.manage';

const OPERATIONAL_PERMISSIONS: Record<GovernanceRole, OperationalPermission[]> = {
  admin: [
    'settings.manage',
    'integration.manage',
    'native_sync.manage',
    'scan.run',
    'digest.test',
    'data.delete',
    'remediation.manage',
    'delivery.manage',
    'outbox.replay',
    'billing.manage',
  ],
  policy_admin: ['native_sync.manage', 'scan.run', 'digest.test', 'remediation.manage'],
  approver: [],
  manager: ['scan.run', 'remediation.manage'],
  viewer: [],
};

export function operationalPermissionsForRole(role: GovernanceRole): OperationalPermission[] {
  return [...OPERATIONAL_PERMISSIONS[role]];
}

export async function requireOperationalPermission(
  env: Env,
  identity: RequestIdentity,
  permission: OperationalPermission,
  resource?: Parameters<typeof requireEnterprisePermission>[3],
): Promise<void> {
  await requireActiveIdentity(env, identity);
  // An explicit enterprise assignment is authoritative, including its data scope.
  // The installer/legacy role is a fallback only for users without an assignment.
  const assigned = await assignedEnterpriseAccessContext(env, identity);
  if (assigned) {
    assertEnterprisePermission(assigned, permission, resource);
    return;
  }
  const context = await governanceContext(env, identity);
  if (!OPERATIONAL_PERMISSIONS[context.role].includes(permission)) {
    throw new AppError(403, 'operation_forbidden', 'You do not have permission to perform this DealGuard operation.');
  }
}

export async function requireActiveIdentity(env: Env, identity: RequestIdentity): Promise<void> {
  if (!identity.userId && !identity.userEmail) throw new AppError(403, 'identified_user_required', 'An identified HubSpot user is required.');
  const tenant = await env.DB.prepare('SELECT status FROM tenants WHERE portal_id=?').bind(identity.portalId).first<{status:string}>();
  if (tenant?.status !== 'active') throw new AppError(403, 'installation_inactive', 'This DealGuard installation is not active.');
}
