import { json, methodNotAllowed } from './http.js';
import {
  createEnterprisePolicySimulation,
  runEnterprisePolicySimulation,
} from './policy-simulation-enterprise.js';
import { route as routeV7 } from './routes-v7.js';
import { validateHubSpotRequest } from './signature.js';
import type { Env } from './types.js';

export async function route(request: Request, env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<Response> {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/v1\/governance\/policies\/([^/]+)\/simulate$/);
  if (match) {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    const identity = await validateHubSpotRequest(request, env);
    const simulation = await createEnterprisePolicySimulation(env, identity, match[1]!);
    ctx.waitUntil(runEnterprisePolicySimulation(env, identity.portalId, match[1]!, simulation.id));
    return json(simulation, 202);
  }
  return routeV7(request, env, ctx);
}
