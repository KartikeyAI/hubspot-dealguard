import { requireCommercialTier } from './billing.js';
import { json, methodNotAllowed } from './http.js';
import { recommendationDeliveryAnalytics } from './recommendation-delivery-analytics.js';
import { route as routeV15 } from './routes-v15.js';
import { validateHubSpotRequest } from './signature.js';
import type { Env } from './types.js';

const DELIVERY_ANALYTICS_PATH = '/api/v1/enterprise/recommendation-delivery-analytics';

export async function route(
  request: Request,
  env: Env,
  ctx: { waitUntil(promise: Promise<unknown>): void },
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== DELIVERY_ANALYTICS_PATH) return routeV15(request, env, ctx);
  if (request.method !== 'GET') return methodNotAllowed(['GET']);

  const identity = await validateHubSpotRequest(request, env);
  await requireCommercialTier(env, identity.portalId, 'enterprise');
  return json(await recommendationDeliveryAnalytics(env, identity, url));
}
