import { operationalPermissionsForRole } from './authorization.js';
import { buildDealIntelligence, previousDealHistory } from './deal-intelligence.js';
import { AppError } from './errors.js';
import { governanceContext } from './governance.js';
import { HubSpotClient } from './hubspot.js';
import { json } from './http.js';
import { policyDimensionPropertyNames } from './policy-dimensions.js';
import { resolveSegmentedRulesForDeal } from './policy-runtime.js';
import { Repository } from './repository.js';
import { route as routeV9 } from './routes-v9.js';
import { validateHubSpotRequest } from './signature.js';
import type { Env } from './types.js';

const REDACTED_READS: Record<string, Record<string, unknown>> = {
  '/api/v1/enterprise/overview': { activePolicy: null, health: { status: 'restricted', deadLetters: 0 } },
  '/api/v1/enterprise/analytics': { current: {}, trend: [], stageAgingHeatmap: [], failurePatterns: [] },
  '/api/v1/enterprise/roles': { roles: [] },
  '/api/v1/enterprise/change-approvals': { approvals: [] },
  '/api/v1/enterprise/policy-templates': { templates: [] },
  '/api/v1/enterprise/alerts': { channels: [], routes: [], calendars: [], escalations: [], suppressions: [], alerts: [] },
  '/api/v1/enterprise/compliance': { settings: null, legalHolds: [], siemDestinations: [], exports: [] },
  '/api/v1/enterprise/reliability': { summary: { status: 'restricted' }, slos: [], synthetics: [], incidents: [], backups: [], restoreTests: [] },
  '/api/v1/billing/usage': { usage: [] },
  '/api/v1/enterprise/policy-dimensions': { teamProperty: null, regionProperty: null, dealTypeProperty: null },
};

function redactedPayload(pathname: string): Record<string, unknown> | null {
  const base = REDACTED_READS[pathname];
  return base ? { ...base, redacted: true, reason: 'permission_denied' } : null;
}

async function commercialAccessFallback(request: Request, env: Env): Promise<Record<string, unknown>> {
  const identity = await validateHubSpotRequest(request, env);
  const governance = await governanceContext(env, identity);
  const operational = operationalPermissionsForRole(governance.role);
  return {
    role: governance.role,
    permissions: ['billing.view', ...(operational.includes('billing.manage') ? ['billing.manage'] : [])],
    scope: { pipelineIds: [], teamIds: [], ownerIds: [], regionCodes: [] },
    bootstrap: governance.installerBootstrap,
    entitled: false,
    redacted: true,
    reason: 'enterprise_subscription_required',
  };
}

async function enrichedCachedAssessment(request: Request, env: Env, dealId: string): Promise<Response | null> {
  const identity = await validateHubSpotRequest(request, env);
  const repository = new Repository(env);
  const cached = await repository.getAssessment(identity.portalId, dealId);
  if (!cached || Date.now() - Date.parse(cached.assessedAt) >= 15 * 60_000) return null;
  const client = await HubSpotClient.forPortal(env, identity.portalId);
  const dimensionProperties = await policyDimensionPropertyNames(env, identity.portalId);
  const deal = await client.getDeal(dealId, undefined, dimensionProperties);
  const policy = await resolveSegmentedRulesForDeal(env, identity.portalId, client.settings.rules, deal);
  const previous = await previousDealHistory(env, identity.portalId, dealId, cached.assessedAt);
  return json({
    ...cached,
    intelligence: buildDealIntelligence(deal, policy.rules, cached, previous),
    policy: { id: policy.policyId, segmentIds: policy.segmentIds },
  });
}

export async function route(request: Request, env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  if (request.method === 'GET') {
    const assessmentMatch = pathname.match(/^\/api\/v1\/deals\/(\d+)\/assessment$/);
    if (assessmentMatch) {
      const enriched = await enrichedCachedAssessment(request, env, assessmentMatch[1]!);
      if (enriched) return enriched;
    }
  }
  if (request.method !== 'GET') return routeV9(request, env, ctx);
  const fallback = redactedPayload(pathname);
  const isAccessRequest = pathname === '/api/v1/enterprise/access';
  if (!fallback && !isAccessRequest) return routeV9(request, env, ctx);
  try {
    return await routeV9(request, env, ctx);
  } catch (error) {
    if (error instanceof AppError && error.status === 403) {
      if (isAccessRequest) return json(await commercialAccessFallback(request, env));
      return json(fallback!);
    }
    throw error;
  }
}
