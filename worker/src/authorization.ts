import { AppError } from './errors.js';
import { governanceContext } from './governance.js';
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
): Promise<void> {
  const context = await governanceContext(env, identity);
  if (!OPERATIONAL_PERMISSIONS[context.role].includes(permission)) {
    throw new AppError(403, 'operation_forbidden', 'You do not have permission to perform this DealGuard operation.');
  }
}
