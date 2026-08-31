import { requireCommercialTier } from './billing.js';
import { json, methodNotAllowed, readJson } from './http.js';
import { evaluateRecommendationDeliverySlos } from './recommendation-delivery-slo-evaluator.js';
import { enableRecommendationDeliverySloRouteEvents } from './recommendation-delivery-slo-route-setup.js';
import {
  acknowledgeRecommendationDeliverySloIncident,
  deleteRecommendationDeliverySlo,
  listRecommendationDeliverySlos,
  requirePortalWideDeliverySloAccess,
  saveRecommendationDeliverySlo,
} from './recommendation-delivery-slos.js';
import { Repository } from './repository.js';
import { route as routeV16 } from './routes-v16.js';
import { validateHubSpotRequest } from './signature.js';
import type { Env } from './types.js';

const SLO_ROOT = '/api/v1/enterprise/recommendation-delivery-slos';

export async function route(
  request: Request,
  env: Env,
  ctx: { waitUntil(promise: Promise<unknown>): void },
): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === `${SLO_ROOT}/evaluate`) {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    const identity = await validateHubSpotRequest(request, env);
    await requireCommercialTier(env, identity.portalId, 'enterprise');
    await requirePortalWideDeliverySloAccess(env, identity, 'reliability.manage');
    await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'recommendation.delivery_slo_evaluation_requested', {
      source: 'app_home', noCrmMutation: true,
    });
    ctx.waitUntil(evaluateRecommendationDeliverySlos(env, identity.portalId).catch((error) => {
      console.error(JSON.stringify({
        level: 'error', task: 'recommendation_delivery_slo_manual_evaluation',
        portalId: identity.portalId,
        error: error instanceof Error ? error.message : String(error),
      }));
    }));
    return json({ accepted: true, evaluationQueued: true }, 202);
  }

  const routeOptIn = url.pathname.match(/^\/api\/v1\/enterprise\/recommendation-delivery-slos\/routes\/([^/]+)\/enable-events$/);
  if (routeOptIn) {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    const identity = await validateHubSpotRequest(request, env);
    await requireCommercialTier(env, identity.portalId, 'enterprise');
    return json(await enableRecommendationDeliverySloRouteEvents(
      env, identity, decodeURIComponent(routeOptIn[1]!),
    ));
  }

  const acknowledge = url.pathname.match(/^\/api\/v1\/enterprise\/recommendation-delivery-slos\/incidents\/([^/]+)\/acknowledge$/);
  if (acknowledge) {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    const identity = await validateHubSpotRequest(request, env);
    await requireCommercialTier(env, identity.portalId, 'enterprise');
    return json(await acknowledgeRecommendationDeliverySloIncident(
      env, identity, decodeURIComponent(acknowledge[1]!),
    ));
  }

  if (url.pathname === SLO_ROOT) {
    const identity = await validateHubSpotRequest(request, env);
    await requireCommercialTier(env, identity.portalId, 'enterprise');
    if (request.method === 'GET') return json(await listRecommendationDeliverySlos(env, identity));
    if (request.method === 'POST') {
      return json(await saveRecommendationDeliverySlo(env, identity, await readJson<unknown>(request)), 201);
    }
    return methodNotAllowed(['GET', 'POST']);
  }

  const item = url.pathname.match(/^\/api\/v1\/enterprise\/recommendation-delivery-slos\/([^/]+)$/);
  if (item) {
    const identity = await validateHubSpotRequest(request, env);
    await requireCommercialTier(env, identity.portalId, 'enterprise');
    const policyId = decodeURIComponent(item[1]!);
    if (request.method === 'PUT') {
      return json(await saveRecommendationDeliverySlo(env, identity, await readJson<unknown>(request), policyId));
    }
    if (request.method === 'DELETE') {
      await deleteRecommendationDeliverySlo(env, identity, policyId);
      return json({ ok: true });
    }
    return methodNotAllowed(['PUT', 'DELETE']);
  }

  return routeV16(request, env, ctx);
}
