import { requireCommercialTier } from './billing.js';
import { confirmQueuedRecommendationFollowup } from './recommendation-followup-confirmation.js';
import { json, methodNotAllowed, readJson } from './http.js';
import {
  getRecommendationFollowupBatch,
  listRecommendationFollowupBatches,
  previewRecommendationFollowup,
} from './recommendation-operations.js';
import { route as routeV13 } from './routes-v13.js';
import { validateHubSpotRequest } from './signature.js';
import type { Env } from './types.js';

const FOLLOWUP_ROOT = '/api/v1/enterprise/recommendation-followups';

export async function route(
  request: Request,
  env: Env,
  ctx: { waitUntil(promise: Promise<unknown>): void },
): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === `${FOLLOWUP_ROOT}/preview`) {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    const identity = await validateHubSpotRequest(request, env);
    await requireCommercialTier(env, identity.portalId, 'enterprise');
    return json(await previewRecommendationFollowup(env, identity, await readJson<unknown>(request)), 201);
  }

  if (url.pathname === FOLLOWUP_ROOT) {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const identity = await validateHubSpotRequest(request, env);
    await requireCommercialTier(env, identity.portalId, 'enterprise');
    return json(await listRecommendationFollowupBatches(env, identity, url));
  }

  const confirm = url.pathname.match(/^\/api\/v1\/enterprise\/recommendation-followups\/([^/]+)\/confirm$/);
  if (confirm) {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    const identity = await validateHubSpotRequest(request, env);
    await requireCommercialTier(env, identity.portalId, 'enterprise');
    return json(await confirmQueuedRecommendationFollowup(
      env,
      identity,
      decodeURIComponent(confirm[1]!),
    ), 202);
  }

  const detail = url.pathname.match(/^\/api\/v1\/enterprise\/recommendation-followups\/([^/]+)$/);
  if (detail) {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const identity = await validateHubSpotRequest(request, env);
    await requireCommercialTier(env, identity.portalId, 'enterprise');
    return json(await getRecommendationFollowupBatch(env, identity, decodeURIComponent(detail[1]!)));
  }

  return routeV13(request, env, ctx);
}
