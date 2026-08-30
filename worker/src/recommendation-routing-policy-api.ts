import { requireEnterprisePermission } from './enterprise-access.js';
import { previewRecommendationRoutingPolicy, saveRecommendationRoutingPolicy } from './recommendation-routing-policies.js';
import type { Env, RequestIdentity } from './types.js';

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

async function constrainPolicyScope(
  env: Env,
  identity: RequestIdentity,
  value: unknown,
  permissionName: 'alert.view' | 'alert.manage',
): Promise<Record<string, unknown>> {
  const access = await requireEnterprisePermission(env, identity, permissionName);
  const input = { ...asObject(value) };
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
  return input;
}

export async function saveScopedRecommendationRoutingPolicy(
  env: Env,
  identity: RequestIdentity,
  value: unknown,
  policyId: string | null = null,
) {
  const scoped = await constrainPolicyScope(env, identity, value, 'alert.manage');
  return saveRecommendationRoutingPolicy(env, identity, scoped, policyId);
}

export async function previewScopedRecommendationRoutingPolicy(
  env: Env,
  identity: RequestIdentity,
  value: unknown,
) {
  const scoped = await constrainPolicyScope(env, identity, value, 'alert.view');
  return previewRecommendationRoutingPolicy(env, identity, scoped);
}
