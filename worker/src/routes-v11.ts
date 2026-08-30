import { requireOperationalPermission } from './authorization.js';
import {
  augmentAssessmentWithCommercialIntegrity,
  commercialAuthorizationForPortal,
} from './commercial-assessment.js';
import { OPTIONAL_COMMERCIAL_HUBSPOT_SCOPES, REQUIRED_HUBSPOT_SCOPES } from './config.js';
import { randomToken, sha256Hex } from './crypto.js';
import { json, methodNotAllowed } from './http.js';
import { Repository } from './repository.js';
import { route as routeV10 } from './routes-v10.js';
import { validateHubSpotRequest } from './signature.js';
import type { Env } from './types.js';

const COMMERCIAL_ACCESS_PATH = '/api/v1/integrations/hubspot/commercial-access';

function assessmentDealId(pathname: string): string | null {
  return pathname.match(/^\/api\/v1\/deals\/(\d+)\/assessment$/)?.[1] ?? null;
}

async function commercialAccess(request: Request, env: Env): Promise<Response> {
  if (!['GET', 'POST'].includes(request.method)) return methodNotAllowed(['GET', 'POST']);
  const identity = await validateHubSpotRequest(request, env);
  const authorization = await commercialAuthorizationForPortal(env, identity.portalId);
  if (request.method === 'GET') {
    return json({
      authorization,
      enabled: authorization.status !== 'required',
      optionalFeature: 'commercial_integrity',
    });
  }

  await requireOperationalPermission(env, identity, 'integration.manage');
  if (authorization.missingScopes.length === 0) {
    return json({ authorization, enabled: true, authorizeUrl: null });
  }

  const state = randomToken();
  await new Repository(env).createOAuthState(await sha256Hex(state), null);
  const authorize = new URL('https://app.hubspot.com/oauth/authorize');
  authorize.searchParams.set('client_id', env.HUBSPOT_CLIENT_ID);
  authorize.searchParams.set('redirect_uri', `${env.APP_BASE_URL}/oauth/callback`);
  authorize.searchParams.set('scope', REQUIRED_HUBSPOT_SCOPES.join(' '));
  authorize.searchParams.set('optional_scope', authorization.missingScopes.join(' '));
  authorize.searchParams.set('state', state);

  return json({
    authorization,
    enabled: authorization.status !== 'required',
    requestedOptionalScopes: OPTIONAL_COMMERCIAL_HUBSPOT_SCOPES,
    authorizeUrl: authorize.toString(),
  });
}

export async function route(
  request: Request,
  env: Env,
  ctx: { waitUntil(promise: Promise<unknown>): void },
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === COMMERCIAL_ACCESS_PATH) return commercialAccess(request, env);

  const dealId = assessmentDealId(url.pathname);
  if (!dealId || !['GET', 'POST'].includes(request.method)) return routeV10(request, env, ctx);

  const baseResponse = await routeV10(request, env, ctx);
  if (!baseResponse.ok) return baseResponse;
  const contentType = baseResponse.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return baseResponse;

  const payload = await baseResponse.clone().json<Record<string, unknown>>();
  const identity = await validateHubSpotRequest(request, env);
  const enriched = await augmentAssessmentWithCommercialIntegrity(
    env,
    identity.portalId,
    dealId,
    payload,
    request.method === 'POST',
  );
  return json(enriched, baseResponse.status);
}
