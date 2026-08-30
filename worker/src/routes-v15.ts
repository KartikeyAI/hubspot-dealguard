import { requireCommercialTier } from './billing.js';
import { requireEnterprisePermission } from './enterprise-access.js';
import { json, methodNotAllowed, readJson } from './http.js';
import { listRecommendationFollowupCandidates } from './recommendation-followup-candidates.js';
import {
  deleteRecommendationRoutingPolicy,
  listRecommendationRoutingPolicies,
  previewRecommendationRoutingPolicy,
  saveRecommendationRoutingPolicy,
} from './recommendation-routing-policies.js';
import { evaluateRecommendationRoutingPolicies } from './recommendation-routing-policy-runner.js';
import { route as routeV14 } from './routes-v14.js';
import { validateHubSpotRequest } from './signature.js';
import type { Env } from './types.js';

const POLICY_ROOT = '/api/v1/enterprise/recommendation-routing-policies';
const FOLLOWUP_CANDIDATES = '/api/v1/enterprise/recommendation-followups/candidates';

export async function route(
  request: Request,
  env: Env,
  ctx: { waitUntil(promise: Promise<unknown>): void },
): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === FOLLOWUP_CANDIDATES) {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const identity = await validateHubSpotRequest(request, env);
    await requireCommercialTier(env, identity.portalId, 'enterprise');
    return json(await listRecommendationFollowupCandidates(env, identity, url));
  }

  if (url.pathname === `${POLICY_ROOT}/preview`) {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    const identity = await validateHubSpotRequest(request, env);
    await requireCommercialTier(env, identity.portalId, 'enterprise');
    return json(await previewRecommendationRoutingPolicy(env, identity, await readJson<unknown>(request)));
  }

  if (url.pathname === `${POLICY_ROOT}/evaluate`) {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    const identity = await validateHubSpotRequest(request, env);
    await requireCommercialTier(env, identity.portalId, 'enterprise');
    await requireEnterprisePermission(env, identity, 'alert.manage');
    return json(await evaluateRecommendationRoutingPolicies(env, identity.portalId), 202);
  }

  if (url.pathname === POLICY_ROOT) {
    const identity = await validateHubSpotRequest(request, env);
    await requireCommercialTier(env, identity.portalId, 'enterprise');
    if (request.method === 'GET') return json(await listRecommendationRoutingPolicies(env, identity));
    if (request.method === 'POST') {
      return json(await saveRecommendationRoutingPolicy(env, identity, await readJson<unknown>(request)), 201);
    }
    return methodNotAllowed(['GET', 'POST']);
  }

  const item = url.pathname.match(/^\/api\/v1\/enterprise\/recommendation-routing-policies\/([^/]+)$/);
  if (item) {
    const identity = await validateHubSpotRequest(request, env);
    await requireCommercialTier(env, identity.portalId, 'enterprise');
    const policyId = decodeURIComponent(item[1]!);
    if (request.method === 'PUT') {
      return json(await saveRecommendationRoutingPolicy(env, identity, await readJson<unknown>(request), policyId));
    }
    if (request.method === 'DELETE') {
      await deleteRecommendationRoutingPolicy(env, identity, policyId);
      return json({ ok: true });
    }
    return methodNotAllowed(['PUT', 'DELETE']);
  }

  return routeV14(request, env, ctx);
}
