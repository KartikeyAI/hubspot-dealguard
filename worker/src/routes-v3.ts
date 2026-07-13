import { requireCommercialTier } from './billing.js';
import { createSecureDownload, consumeSecureDownload } from './secure-downloads.js';
import { json, methodNotAllowed, readJson } from './http.js';
import { route as routeV2 } from './routes-v2.js';
import { validateHubSpotRequest } from './signature.js';
import type { Env } from './types.js';

export async function route(request: Request, env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<Response> {
  const url = new URL(request.url);
  const publicDownload = url.pathname.match(/^\/downloads\/([^/]+)$/);
  if (publicDownload) {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    return consumeSecureDownload(env, decodeURIComponent(publicDownload[1]!));
  }

  if (url.pathname === '/api/v1/enterprise/downloads') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    const identity = await validateHubSpotRequest(request, env);
    await requireCommercialTier(env, identity.portalId, 'enterprise');
    return json(await createSecureDownload(env, identity, await readJson<unknown>(request)), 201);
  }

  return routeV2(request, env, ctx);
}
