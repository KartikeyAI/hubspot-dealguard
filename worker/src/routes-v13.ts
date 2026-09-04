import { requireCommercialTier } from './billing.js';
import { json, methodNotAllowed, readJson } from './http.js';
import {
  listDealRecommendations,
  recommendationOutcomeAnalytics,
  transitionRecommendation,
} from './recommendation-outcomes.js';
import { route as routeV12 } from './routes-v12.js';
import { validateHubSpotRequest } from './signature.js';
import type { Env } from './types.js';

const OUTCOME_ANALYTICS_PATH = '/api/v1/enterprise/recommendation-outcomes';

function dealRecommendationsPath(pathname: string): string | null {
  return pathname.match(/^\/api\/v1\/deals\/([^/]+)\/recommendations$/)?.[1] ?? null;
}

function recommendationTransitionPath(pathname: string): { id: string; action: 'accept' | 'complete' | 'dismiss' } | null {
  const match = pathname.match(/^\/api\/v1\/recommendations\/([^/]+)\/(accept|complete|dismiss)$/);
  return match ? { id: match[1]!, action: match[2]! as 'accept' | 'complete' | 'dismiss' } : null;
}

export async function route(
  request: Request,
  env: Env,
  ctx: { waitUntil(promise: Promise<unknown>): void },
): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === OUTCOME_ANALYTICS_PATH) {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const identity = await validateHubSpotRequest(request, env);
    await requireCommercialTier(env, identity.portalId, 'enterprise');
    return json(await recommendationOutcomeAnalytics(env, identity, url));
  }

  const dealId = dealRecommendationsPath(url.pathname);
  if (dealId) {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const identity = await validateHubSpotRequest(request, env);
    await requireCommercialTier(env, identity.portalId, 'enterprise');
    return json(await listDealRecommendations(env, identity, decodeURIComponent(dealId), url));
  }

  const transition = recommendationTransitionPath(url.pathname);
  if (transition) {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    const identity = await validateHubSpotRequest(request, env);
    await requireCommercialTier(env, identity.portalId, 'enterprise');
    return json(await transitionRecommendation(
      env,
      identity,
      decodeURIComponent(transition.id),
      transition.action,
      await readJson<unknown>(request),
    ));
  }

  return routeV12(request, env, ctx);
}
