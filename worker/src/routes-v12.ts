import { requireCommercialTier } from './billing.js';
import { executiveRevenueView } from './executive-revenue.js';
import { json, methodNotAllowed } from './http.js';
import { route as routeV11 } from './routes-v11.js';
import { validateHubSpotRequest } from './signature.js';
import type { Env } from './types.js';

const EXECUTIVE_REVENUE_PATH = '/api/v1/enterprise/executive-revenue';

export async function route(
  request: Request,
  env: Env,
  ctx: { waitUntil(promise: Promise<unknown>): void },
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== EXECUTIVE_REVENUE_PATH) return routeV11(request, env, ctx);
  if (request.method !== 'GET') return methodNotAllowed(['GET']);

  const identity = await validateHubSpotRequest(request, env);
  await requireCommercialTier(env, identity.portalId, 'enterprise');
  const result = await executiveRevenueView(env, identity, url);
  ctx.waitUntil(result.persist().catch((error) => {
    console.error(JSON.stringify({
      level: 'warn',
      task: 'executive_revenue_snapshot_persist',
      portalId: identity.portalId,
      error: error instanceof Error ? error.message : String(error),
    }));
  }));
  return json(result.response);
}
