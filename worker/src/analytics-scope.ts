import { AppError } from './errors.js';
import { enterpriseAccessContext, permissionMatches } from './enterprise-access.js';
import type { EnterpriseAccessContext } from './enterprise-access.js';
import type { Env, RequestIdentity } from './types.js';

export const ANALYTICS_DIMENSIONS = [
  ['pipelineId', 'pipeline_id', 'pipelineIds'],
  ['stageId', 'stage_id', null],
  ['ownerId', 'owner_id', 'ownerIds'],
  ['teamId', 'team_id', 'teamIds'],
  ['regionCode', 'region_code', 'regionCodes'],
] as const;

export type AnalyticsFilters = Record<string, string | readonly string[]>;

/** Collection access returns scope for SQL enforcement; never weaken record-level checks. */
export async function requireAnalyticsCollectionAccess(
  env: Env, identity: RequestIdentity, permission: 'analytics.view' | 'analytics.export',
): Promise<EnterpriseAccessContext> {
  if (!identity.userId?.trim() && !identity.userEmail?.trim()) {
    throw new AppError(403, 'analytics_identity_required', 'An identified user is required for analytics.');
  }
  const access = await enterpriseAccessContext(env, identity);
  if (!permissionMatches(access.permissions, permission)) {
    throw new AppError(403, 'enterprise_permission_denied', `You do not have the ${permission} permission.`);
  }
  return access;
}

export function analyticsFilters(
  scope: EnterpriseAccessContext['scope'], selected: Record<string, string>,
): { effective: AnalyticsFilters; authorization: AnalyticsFilters } {
  const authorization: AnalyticsFilters = {};
  for (const [key, , scopeKey] of ANALYTICS_DIMENSIONS) {
    if (scopeKey === null) continue;
    const allowed = scope[scopeKey];
    if (!Array.isArray(allowed) || allowed.length > 500
      || allowed.some((id) => typeof id !== 'string' || !id.trim() || id.length > 128)) {
      throw new AppError(403, 'analytics_scope_invalid', 'The analytics scope is invalid.');
    }
    if (allowed.length) authorization[key] = [...new Set(allowed)];
    if (allowed.length && selected[key] && !allowed.includes(selected[key]!)) {
      throw new AppError(403, 'analytics_scope_denied', 'The selected analytics filter is outside your assigned scope.');
    }
  }
  // AND across dimensions; IN within a dimension. Explicit filters can only narrow scope.
  return { authorization, effective: { ...authorization, ...selected } };
}

export function selectedAnalyticsFilters(params: URLSearchParams): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key] of ANALYTICS_DIMENSIONS) {
    const values = params.getAll(key);
    if (values.length > 1 || values.some((value) => value.length > 128 || value !== value.trim())) {
      throw new AppError(400, 'analytics_filter_invalid', 'Analytics filters must be single, bounded identifiers.');
    }
    if (values[0]) result[key] = values[0];
  }
  return result;
}

export function analyticsPredicate(alias: string, filters: AnalyticsFilters): { sql: string; params: string[] } {
  // Aliases are supplied by repository code, never by the request.
  if (!/^[a-z][a-z0-9_]*$/.test(alias)) throw new Error('Invalid analytics SQL alias.');
  const clauses: string[] = [];
  const params: string[] = [];
  for (const [key, column] of ANALYTICS_DIMENSIONS) {
    const value = filters[key];
    if (value === undefined) continue;
    const values = typeof value === 'string' ? [value] : value;
    if (!Array.isArray(values) || values.length > 500
      || values.some((id) => typeof id !== 'string' || !id.trim() || id.length > 128)) {
      throw new Error('Invalid analytics SQL filter.');
    }
    if (!values.length) { clauses.push('FALSE'); continue; }
    clauses.push(`${alias}.${column} IN (${values.map(() => '?').join(', ')})`);
    params.push(...values);
  }
  return { sql: clauses.join(' AND ') || 'TRUE', params };
}

/** Stored user ID is authoritative; email fallback is only for legacy email-owned views. */
export function analyticsViewOwner(identity: Pick<RequestIdentity, 'userId' | 'userEmail'>): {
  sql: string; params: Array<string | null>;
} {
  const userId = identity.userId?.trim() || null;
  const email = identity.userEmail?.trim() || null;
  if (!userId && !email) throw new AppError(403, 'analytics_identity_required', 'An identified user is required for saved views.');
  return {
    sql: `NULLIF(created_by_user_id, '') = ? OR (
      NULLIF(created_by_user_id, '') IS NULL AND ?::text IS NOT NULL
      AND lower(NULLIF(created_by_email, '')) = lower(?)
    )`,
    params: [userId, email, email],
  };
}

export function analyticsCsvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (typeof value === 'string' && (/^[\s]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text))) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
