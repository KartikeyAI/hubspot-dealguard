import { requireEnterprisePermission } from './enterprise-access.js';
import { json, methodNotAllowed, readJson } from './http.js';
import { getPolicyDimensionMappings, updatePolicyDimensionMappings } from './policy-dimensions.js';
import { route as routeV6 } from './routes-v6.js';
import { validateHubSpotRequest } from './signature.js';
import type { Env } from './types.js';

export async function route(request: Request, env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/api/v1/enterprise/policy-dimensions') {
    const identity = await validateHubSpotRequest(request, env);
    if (request.method === 'GET') {
      await requireEnterprisePermission(env, identity, 'policy.view');
      return json(await getPolicyDimensionMappings(env, identity.portalId));
    }
    if (request.method === 'PUT') {
      await requireEnterprisePermission(env, identity, 'policy.manage');
      return json(await updatePolicyDimensionMappings(env, identity, await readJson<unknown>(request)));
    }
    return methodNotAllowed(['GET', 'PUT']);
  }
  return routeV6(request, env, ctx);
}
