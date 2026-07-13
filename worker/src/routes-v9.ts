import { saveAssessmentContext } from './assessment-context.js';
import { recordAssessmentHistory } from './enterprise-analytics-v2.js';
import { HubSpotClient } from './hubspot.js';
import { json, methodNotAllowed } from './http.js';
import { syncAssessmentIfEnabled } from './native-sync.js';
import { policyDimensionPropertyNames } from './policy-dimensions.js';
import { resolveSegmentedRulesForDeal } from './policy-runtime.js';
import { Repository } from './repository.js';
import { route as routeV8 } from './routes-v8.js';
import { assessDeal } from './scoring.js';
import { notifyHandoffConfirmed } from './slack.js';
import { validateHubSpotRequest } from './signature.js';
import type { Env } from './types.js';

export async function route(request: Request, env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<Response> {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/v1\/deals\/(\d+)\/handoff$/);
  if (match) {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    const identity = await validateHubSpotRequest(request, env);
    const dealId = match[1]!;
    const repository = new Repository(env);
    const client = await HubSpotClient.forPortal(env, identity.portalId);
    const dimensionProperties = await policyDimensionPropertyNames(env, identity.portalId);
    const deal = await client.getDeal(dealId, undefined, dimensionProperties);
    const resolved = await resolveSegmentedRulesForDeal(env, identity.portalId, client.settings.rules, deal);
    const assessment = assessDeal(deal, resolved.rules);
    await repository.saveAssessment(identity.portalId, assessment);
    await saveAssessmentContext(env, identity.portalId, assessment);
    await recordAssessmentHistory(env, identity.portalId, assessment, {
      trigger: 'handoff',
      properties: deal.properties,
      policyId: resolved.policyId,
    });
    await repository.confirmHandoff(identity, dealId, assessment);
    ctx.waitUntil(notifyHandoffConfirmed(env, identity.portalId, assessment, client.settings, client.plan).catch((error) => {
      console.error(JSON.stringify({ level: 'error', task: 'slack_handoff_confirmation', portalId: identity.portalId, dealId, error: error instanceof Error ? error.message : String(error) }));
    }));
    ctx.waitUntil(syncAssessmentIfEnabled(env, client, assessment, 'confirmed').catch((error) => {
      console.error(JSON.stringify({ level: 'error', task: 'native_handoff_sync', portalId: identity.portalId, dealId, error: error instanceof Error ? error.message : String(error) }));
    }));
    return json({ ok: true, handoffStatus: 'confirmed', confirmedAt: new Date().toISOString() });
  }
  return routeV8(request, env, ctx);
}
