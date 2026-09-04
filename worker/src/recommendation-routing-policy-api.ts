import { requireEnterprisePermission, type EnterpriseAccessContext } from './enterprise-access.js';
import { AppError } from './errors.js';
import { loadFollowupRoutingState } from './recommendation-followup-delivery.js';
import {
  deleteRecommendationRoutingPolicy,
  listRecommendationRoutingPolicies,
  previewRecommendationRoutingPolicy,
  saveRecommendationRoutingPolicy,
} from './recommendation-routing-policies.js';
import type { RecommendationRoutingScope } from './recommendation-routing-policy-types.js';
import type { Env, RequestIdentity } from './types.js';

interface PolicyAuthorizationRow extends Record<string, unknown> {
  pipeline_ids_json: string;
  team_ids_json: string;
  owner_ids_json: string;
  region_codes_json: string;
  route_id: string;
  escalation_route_id: string | null;
  enabled: number;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    .map((item) => item.trim().slice(0, 128)))];
}

function parseStrings(value: unknown): string[] {
  if (Array.isArray(value)) return asStrings(value);
  if (typeof value !== 'string') return [];
  try {
    return asStrings(JSON.parse(value));
  } catch {
    return [];
  }
}

function scopeAllowed(scope: RecommendationRoutingScope, access: EnterpriseAccessContext): boolean {
  const checks: Array<[string[], string[]]> = [
    [scope.pipelineIds, access.scope.pipelineIds],
    [scope.teamIds, access.scope.teamIds],
    [scope.ownerIds, access.scope.ownerIds],
    [scope.regionCodes, access.scope.regionCodes],
  ];
  return checks.every(([policyValues, allowed]) => {
    if (allowed.length === 0) return true;
    return policyValues.length > 0 && policyValues.every((value) => allowed.includes(value));
  });
}

function portalWideAccess(access: EnterpriseAccessContext): boolean {
  return access.permissions.includes('*') || (
    access.scope.pipelineIds.length === 0
    && access.scope.teamIds.length === 0
    && access.scope.ownerIds.length === 0
    && access.scope.regionCodes.length === 0
  );
}

async function constrainPolicyScope(
  env: Env,
  identity: RequestIdentity,
  value: unknown,
  permissionName: 'alert.view' | 'alert.manage',
  preserveMissingScope = false,
): Promise<{ input: Record<string, unknown>; access: EnterpriseAccessContext }> {
  const access = await requireEnterprisePermission(env, identity, permissionName);
  const input = { ...asObject(value) };
  const hasScope = Object.prototype.hasOwnProperty.call(input, 'scope');
  if (!hasScope && preserveMissingScope) return { input, access };
  const supplied = asObject(input.scope);
  const dimensions = [
    ['pipelineIds', access.scope.pipelineIds],
    ['teamIds', access.scope.teamIds],
    ['ownerIds', access.scope.ownerIds],
    ['regionCodes', access.scope.regionCodes],
  ] as const;
  const scope: Record<string, string[]> = {};
  for (const [key, allowed] of dimensions) {
    const requested = asStrings(supplied[key]);
    scope[key] = allowed.length > 0 && requested.length === 0 ? [...allowed] : requested;
  }
  input.scope = scope;
  return { input, access };
}

async function policyAuthorizationRow(
  env: Env,
  identity: RequestIdentity,
  policyId: string,
): Promise<PolicyAuthorizationRow> {
  const row = await env.DB.prepare(
    `SELECT pipeline_ids_json, team_ids_json, owner_ids_json, region_codes_json,
            route_id, escalation_route_id, enabled
     FROM recommendation_routing_policies WHERE portal_id = ? AND id = ?`,
  ).bind(identity.portalId, policyId).first<PolicyAuthorizationRow>();
  if (!row) throw new AppError(404, 'recommendation_policy_not_found', 'The recommendation routing policy does not exist.');
  return row;
}

async function requirePolicyScope(
  env: Env,
  identity: RequestIdentity,
  access: EnterpriseAccessContext,
  policyId: string,
): Promise<PolicyAuthorizationRow> {
  const row = await policyAuthorizationRow(env, identity, policyId);
  const scope: RecommendationRoutingScope = {
    pipelineIds: parseStrings(row.pipeline_ids_json),
    teamIds: parseStrings(row.team_ids_json),
    ownerIds: parseStrings(row.owner_ids_json),
    regionCodes: parseStrings(row.region_codes_json),
  };
  if (!scopeAllowed(scope, access)) {
    throw new AppError(403, 'recommendation_policy_scope_denied', 'The recommendation routing policy is outside your assigned data scope.');
  }
  return row;
}

async function requireConfiguredPolicyChannels(
  env: Env,
  identity: RequestIdentity,
  input: Record<string, unknown>,
  current: PolicyAuthorizationRow | null,
): Promise<void> {
  const enabled = input.enabled === undefined ? Boolean(current?.enabled) : input.enabled === true;
  if (!enabled) return;
  const routeId = typeof input.routeId === 'string' && input.routeId
    ? input.routeId
    : current?.route_id ?? null;
  const escalationRouteId = input.escalationRouteId === null
    ? null
    : typeof input.escalationRouteId === 'string' && input.escalationRouteId
      ? input.escalationRouteId
      : current?.escalation_route_id ?? null;
  const routeIds = [routeId, escalationRouteId].filter((value): value is string => Boolean(value));
  if (!routeId) throw new AppError(400, 'recommendation_policy_route_required', 'Select an initial notification route.');
  const state = await loadFollowupRoutingState(env, identity.portalId);
  const availableChannels = new Set(state.channelSummaries.map((channel) => channel.id));
  for (const selectedRouteId of routeIds) {
    const route = state.routes.find((candidate) => candidate.id === selectedRouteId);
    if (!route || !route.channelIds.some((channelId) => availableChannels.has(channelId))) {
      throw new AppError(409, 'recommendation_policy_channel_unavailable', 'Every enabled recommendation policy route must contain at least one enabled, configured notification channel.');
    }
  }
}

export async function listScopedRecommendationRoutingPolicies(
  env: Env,
  identity: RequestIdentity,
) {
  const access = await requireEnterprisePermission(env, identity, 'alert.view');
  const result = await listRecommendationRoutingPolicies(env, identity);
  return {
    ...result,
    policies: result.policies.filter((policy) => scopeAllowed(policy.scope, access)),
    permissions: {
      ...result.permissions,
      canRun: result.permissions.canRun && portalWideAccess(access),
    },
  };
}

export async function saveScopedRecommendationRoutingPolicy(
  env: Env,
  identity: RequestIdentity,
  value: unknown,
  policyId: string | null = null,
) {
  const { input, access } = await constrainPolicyScope(env, identity, value, 'alert.manage', Boolean(policyId));
  const current = policyId ? await requirePolicyScope(env, identity, access, policyId) : null;
  await requireConfiguredPolicyChannels(env, identity, input, current);
  return saveRecommendationRoutingPolicy(env, identity, input, policyId);
}

export async function deleteScopedRecommendationRoutingPolicy(
  env: Env,
  identity: RequestIdentity,
  policyId: string,
): Promise<void> {
  const access = await requireEnterprisePermission(env, identity, 'alert.manage');
  await requirePolicyScope(env, identity, access, policyId);
  await deleteRecommendationRoutingPolicy(env, identity, policyId);
}

export async function previewScopedRecommendationRoutingPolicy(
  env: Env,
  identity: RequestIdentity,
  value: unknown,
) {
  const raw = asObject(value);
  const preserve = typeof raw.id === 'string' && Boolean(raw.id.trim());
  const { input } = await constrainPolicyScope(env, identity, value, 'alert.view', preserve);
  return previewRecommendationRoutingPolicy(env, identity, input);
}

export async function authorizePortalWideRecommendationPolicyEvaluation(
  env: Env,
  identity: RequestIdentity,
): Promise<void> {
  const access = await requireEnterprisePermission(env, identity, 'alert.manage');
  if (!portalWideAccess(access)) {
    throw new AppError(403, 'recommendation_policy_run_scope_denied', 'Portal-wide policy evaluation requires an administrator or an unscoped alert manager. Scheduled maintenance continues to evaluate authorized policies independently.');
  }
}
