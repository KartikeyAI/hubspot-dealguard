import { upsertBusinessCalendar, upsertNotificationRoute } from './alerting-enterprise.js';
import { requireCommercialTier } from './billing.js';
import { observeRecommendationDeliveryControls } from './recommendation-delivery-observer.js';
import { requireEnterprisePermission } from './enterprise-access.js';
import { AppError } from './errors.js';
import { json, methodNotAllowed, readJson } from './http.js';
import { listRecommendationFollowupCandidates } from './recommendation-followup-candidates.js';
import {
  authorizePortalWideRecommendationPolicyEvaluation,
  deleteScopedRecommendationRoutingPolicy,
  listScopedRecommendationRoutingPolicies,
  previewScopedRecommendationRoutingPolicy,
  saveScopedRecommendationRoutingPolicy,
} from './recommendation-routing-policy-api.js';
import { evaluateRecommendationRoutingPolicies } from './recommendation-routing-policy-runner.js';
import { Repository } from './repository.js';
import { route as routeV14 } from './routes-v14.js';
import { validateHubSpotRequest } from './signature.js';
import type { Env, RequestIdentity } from './types.js';

const POLICY_ROOT = '/api/v1/enterprise/recommendation-routing-policies';
const FOLLOWUP_CANDIDATES = '/api/v1/enterprise/recommendation-followups/candidates';

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown, maximum = 128): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maximum) : null;
}

async function requireOwnedResource(
  env: Env,
  identity: RequestIdentity,
  table: 'notification_routes' | 'business_calendars' | 'escalation_policies',
  id: string,
): Promise<void> {
  const row = await env.DB.prepare(`SELECT id FROM ${table} WHERE portal_id = ? AND id = ?`)
    .bind(identity.portalId, id).first<{ id: string }>();
  if (!row) throw new AppError(404, 'notification_resource_not_found', 'The notification configuration resource does not exist in this portal.');
}

async function validateRouteReferences(
  env: Env,
  identity: RequestIdentity,
  value: unknown,
): Promise<Record<string, unknown>> {
  await requireEnterprisePermission(env, identity, 'alert.manage');
  const input = object(value);
  const calendarId = text(input.quietHoursCalendarId);
  const escalationPolicyId = text(input.escalationPolicyId);
  if (calendarId) await requireOwnedResource(env, identity, 'business_calendars', calendarId);
  if (escalationPolicyId) await requireOwnedResource(env, identity, 'escalation_policies', escalationPolicyId);
  return input;
}

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
    return json(await previewScopedRecommendationRoutingPolicy(env, identity, await readJson<unknown>(request)));
  }

  if (url.pathname === `${POLICY_ROOT}/evaluate`) {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    const identity = await validateHubSpotRequest(request, env);
    await requireCommercialTier(env, identity.portalId, 'enterprise');
    await authorizePortalWideRecommendationPolicyEvaluation(env, identity);
    await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'recommendation.policy_evaluation_requested', {
      source: 'app_home',
      noCrmMutation: true,
    });
    ctx.waitUntil((async () => {
      await evaluateRecommendationRoutingPolicies(env, identity.portalId);
      await observeRecommendationDeliveryControls(env, identity.portalId);
    })().catch((error) => {
      console.error(JSON.stringify({
        level: 'error',
        task: 'recommendation_policy_manual_evaluation',
        portalId: identity.portalId,
        error: error instanceof Error ? error.message : String(error),
      }));
    }));
    return json({ accepted: true, evaluationQueued: true, deliveryObservationQueued: true }, 202);
  }

  if (url.pathname === POLICY_ROOT) {
    const identity = await validateHubSpotRequest(request, env);
    await requireCommercialTier(env, identity.portalId, 'enterprise');
    if (request.method === 'GET') return json(await listScopedRecommendationRoutingPolicies(env, identity));
    if (request.method === 'POST') return json(await saveScopedRecommendationRoutingPolicy(env, identity, await readJson<unknown>(request)), 201);
    return methodNotAllowed(['GET', 'POST']);
  }

  const policyItem = url.pathname.match(/^\/api\/v1\/enterprise\/recommendation-routing-policies\/([^/]+)$/);
  if (policyItem) {
    const identity = await validateHubSpotRequest(request, env);
    await requireCommercialTier(env, identity.portalId, 'enterprise');
    const policyId = decodeURIComponent(policyItem[1]!);
    if (request.method === 'PUT') return json(await saveScopedRecommendationRoutingPolicy(env, identity, await readJson<unknown>(request), policyId));
    if (request.method === 'DELETE') {
      await deleteScopedRecommendationRoutingPolicy(env, identity, policyId);
      return json({ ok: true });
    }
    return methodNotAllowed(['PUT', 'DELETE']);
  }

  if (url.pathname === '/api/v1/enterprise/alerts/routes') {
    if (request.method !== 'POST') return routeV14(request, env, ctx);
    const identity = await validateHubSpotRequest(request, env);
    await requireCommercialTier(env, identity.portalId, 'enterprise');
    const input = await validateRouteReferences(env, identity, await readJson<unknown>(request));
    return json(await upsertNotificationRoute(env, identity, input), 201);
  }

  const routeItem = url.pathname.match(/^\/api\/v1\/enterprise\/alerts\/routes\/([^/]+)$/);
  if (routeItem && request.method === 'PUT') {
    const identity = await validateHubSpotRequest(request, env);
    await requireCommercialTier(env, identity.portalId, 'enterprise');
    const routeId = decodeURIComponent(routeItem[1]!);
    await requireEnterprisePermission(env, identity, 'alert.manage');
    await requireOwnedResource(env, identity, 'notification_routes', routeId);
    const input = await validateRouteReferences(env, identity, await readJson<unknown>(request));
    return json(await upsertNotificationRoute(env, identity, input, routeId));
  }

  if (url.pathname === '/api/v1/enterprise/alerts/calendars') {
    if (request.method !== 'POST') return routeV14(request, env, ctx);
    const identity = await validateHubSpotRequest(request, env);
    await requireCommercialTier(env, identity.portalId, 'enterprise');
    return json(await upsertBusinessCalendar(env, identity, await readJson<unknown>(request)), 201);
  }

  const calendarItem = url.pathname.match(/^\/api\/v1\/enterprise\/alerts\/calendars\/([^/]+)$/);
  if (calendarItem && request.method === 'PUT') {
    const identity = await validateHubSpotRequest(request, env);
    await requireCommercialTier(env, identity.portalId, 'enterprise');
    const calendarId = decodeURIComponent(calendarItem[1]!);
    await requireEnterprisePermission(env, identity, 'alert.manage');
    await requireOwnedResource(env, identity, 'business_calendars', calendarId);
    return json(await upsertBusinessCalendar(env, identity, await readJson<unknown>(request), calendarId));
  }

  return routeV14(request, env, ctx);
}
