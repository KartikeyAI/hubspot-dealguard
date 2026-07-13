import { assessDealForPortal } from './assessment-service.js';
import { PLAN_LIMITS, REQUIRED_HUBSPOT_SCOPES } from './config.js';
import { randomToken, sha256Hex } from './crypto.js';
import { dashboardForPortal } from './dashboard.js';
import { finalizePortalDeletion } from './data-deletion.js';
import { sendEmail } from './email.js';
import { AppError } from './errors.js';
import { normalizeHubSpotWebhookEvents, processHubSpotWebhookEvents } from './hubspot-events.js';
import { HubSpotClient } from './hubspot.js';
import { html, json, methodNotAllowed, readJson, redirect } from './http.js';
import { backfillNativeSync, getNativeSyncStatus, provisionNativeSync, syncAssessmentIfEnabled } from './native-sync.js';
import { docsPage, installSuccessPage, landingPage, privacyPage, slackSuccessPage, supportPage, termsPage } from './pages.js';
import { Repository } from './repository.js';
import { assessDeal } from './scoring.js';
import { scanPortal } from './scanner.js';
import { completeSlackAuthorization, createSlackAuthorization, disconnectSlack, getSlackStatus, notifyHandoffConfirmed, sendSlackTest } from './slack.js';
import { validateHubSpotRequest, validateHubSpotSignature } from './signature.js';
import type { Env, PlanId } from './types.js';
import { executeWorkflowAction } from './workflow-action.js';

function dealIdFromPath(pathname: string): string | null {
  return pathname.match(/^\/api\/v1\/deals\/(\d+)\/(assessment|review|handoff)$/)?.[1] ?? null;
}
function routeAction(pathname: string): string | null {
  return pathname.match(/^\/api\/v1\/deals\/\d+\/(assessment|review|handoff)$/)?.[1] ?? null;
}

export async function route(request: Request, env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<Response> {
  const url = new URL(request.url);
  const repository = new Repository(env);
  if (url.pathname === '/' && request.method === 'GET') return html(landingPage(env));
  if (url.pathname === '/health' && request.method === 'GET') return json({ status: 'ok', service: 'dealguard-api' });
  if (url.pathname === '/docs' && request.method === 'GET') return html(docsPage(env));
  if (url.pathname === '/privacy' && request.method === 'GET') return html(privacyPage(env));
  if (url.pathname === '/terms' && request.method === 'GET') return html(termsPage(env));
  if (url.pathname === '/support' && request.method === 'GET') return html(supportPage(env));
  if (url.pathname === '/install/success' && request.method === 'GET') return html(installSuccessPage(env));
  if (url.pathname === '/integrations/slack/success' && request.method === 'GET') return html(slackSuccessPage(env));

  if (url.pathname === '/oauth/install') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const state = randomToken();
    await repository.createOAuthState(await sha256Hex(state), url.searchParams.get('returnTo'));
    const authorize = new URL('https://app.hubspot.com/oauth/authorize');
    authorize.searchParams.set('client_id', env.HUBSPOT_CLIENT_ID);
    authorize.searchParams.set('redirect_uri', `${env.APP_BASE_URL}/oauth/callback`);
    authorize.searchParams.set('scope', REQUIRED_HUBSPOT_SCOPES.join(' '));
    authorize.searchParams.set('state', state);
    return redirect(authorize.toString());
  }
  if (url.pathname === '/oauth/callback') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const error = url.searchParams.get('error');
    if (error) throw new AppError(400, 'oauth_denied', `HubSpot authorization was not completed: ${error}`);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state) throw new AppError(400, 'oauth_callback_invalid', 'OAuth callback is missing required parameters.');
    await repository.consumeOAuthState(await sha256Hex(state));
    const tokens = await HubSpotClient.exchangeCode(env, code);
    const info = await HubSpotClient.tokenInfo(tokens.access_token);
    if (env.HUBSPOT_APP_ID && env.HUBSPOT_APP_ID !== 'REPLACE_WITH_HUBSPOT_APP_ID' && String(info.app_id) !== env.HUBSPOT_APP_ID) throw new AppError(401, 'oauth_app_mismatch', 'OAuth token belongs to a different HubSpot app.');
    await repository.upsertTenant(tokens, info);
    ctx.waitUntil(scanPortal(env, String(info.hub_id), 'install'));
    return redirect(`${env.APP_BASE_URL}/install/success`);
  }
  if (url.pathname === '/oauth/slack/callback') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const error = url.searchParams.get('error');
    if (error) throw new AppError(400, 'slack_oauth_denied', `Slack authorization was not completed: ${error}`);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state) throw new AppError(400, 'slack_oauth_callback_invalid', 'Slack callback is missing required parameters.');
    await completeSlackAuthorization(env, code, state);
    return redirect(`${env.APP_BASE_URL}/integrations/slack/success`);
  }
  if (url.pathname === '/webhooks/hubspot') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    await validateHubSpotSignature(request, env);
    const events = normalizeHubSpotWebhookEvents(await readJson<unknown>(request, 1_000_000));
    if (events.length > 0) ctx.waitUntil(processHubSpotWebhookEvents(env, events));
    return json({ accepted: events.length }, 202);
  }
  if (url.pathname === '/integrations/hubspot/workflow-actions/assess-deal') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    await validateHubSpotSignature(request, env);
    return json(await executeWorkflowAction(env, await readJson<unknown>(request)));
  }

  if (url.pathname.startsWith('/internal/')) {
    const expected = env.ADMIN_API_KEY;
    const actual = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
    if (!expected || actual !== expected) throw new AppError(401, 'admin_unauthorized', 'Administrator authentication failed.');
    const planMatch = url.pathname.match(/^\/internal\/portals\/(\d+)\/plan$/);
    if (planMatch) {
      if (request.method !== 'PUT') return methodNotAllowed(['PUT']);
      const body = await readJson<{ plan?: PlanId }>(request);
      if (!body.plan) throw new AppError(400, 'plan_required', 'A plan is required.');
      await repository.setPlan(planMatch[1]!, body.plan);
      return json({ ok: true, portalId: planMatch[1], plan: body.plan });
    }
    throw new AppError(404, 'not_found', 'Endpoint not found.');
  }

  if (!url.pathname.startsWith('/api/v1/')) throw new AppError(404, 'not_found', 'Endpoint not found.');
  const identity = await validateHubSpotRequest(request, env);
  if (url.pathname === '/api/v1/integrations/slack') {
    if (request.method === 'GET') return json(await getSlackStatus(env, identity.portalId));
    if (request.method === 'DELETE') { await disconnectSlack(env, identity); return json({ ok: true }); }
    return methodNotAllowed(['GET', 'DELETE']);
  }
  if (url.pathname === '/api/v1/integrations/slack/connect') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    return json({ authorizeUrl: await createSlackAuthorization(env, identity) });
  }
  if (url.pathname === '/api/v1/integrations/slack/test') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    await sendSlackTest(env, identity);
    return json({ ok: true });
  }
  if (url.pathname === '/api/v1/native-sync') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    return json(await getNativeSyncStatus(env, identity.portalId));
  }
  if (url.pathname === '/api/v1/native-sync/provision') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    return json(await provisionNativeSync(env, identity));
  }
  if (url.pathname === '/api/v1/native-sync/backfill') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    const status = await getNativeSyncStatus(env, identity.portalId);
    if (!status.entitled || !status.enabled || status.status !== 'ready') {
      throw new AppError(409, 'native_sync_not_ready', 'Provision and enable native HubSpot property sync before starting a backfill.');
    }
    ctx.waitUntil(backfillNativeSync(env, identity.portalId).catch((error) => {
      console.error(JSON.stringify({ level: 'error', task: 'native_sync_backfill', portalId: identity.portalId, error: error instanceof Error ? error.message : String(error) }));
    }));
    return json({ ok: true, status: 'backfilling' }, 202);
  }
  if (url.pathname === '/api/v1/metadata') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const client = await HubSpotClient.forPortal(env, identity.portalId);
    const [pipelines, properties] = await Promise.all([client.getPipelines(), client.getDealProperties()]);
    return json({ pipelines: pipelines.map((pipeline) => ({ id: pipeline.id, label: pipeline.label, stages: pipeline.stages.map((stage) => ({ id: stage.id, label: stage.label })) })), properties: properties.map((property) => ({ name: property.name, label: property.label, groupName: property.groupName, type: property.type, fieldType: property.fieldType })) });
  }
  if (url.pathname === '/api/v1/dashboard') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    return json(await dashboardForPortal(env, identity.portalId));
  }
  if (url.pathname === '/api/v1/settings') {
    if (request.method === 'GET') { const credentials = await repository.getCredentials(identity.portalId); return json({ plan: credentials.tenant.plan, settings: credentials.settings }); }
    if (request.method === 'PUT') return json({ ok: true, settings: await repository.saveSettings(identity, await readJson(request)) });
    return methodNotAllowed(['GET', 'PUT']);
  }
  if (url.pathname === '/api/v1/scans') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    const tenant = await repository.getTenant(identity.portalId);
    const minimumIntervalMs = PLAN_LIMITS[tenant.plan].minScanIntervalMinutes * 60_000;
    if (tenant.last_scan_at && Date.now() - Date.parse(tenant.last_scan_at) < minimumIntervalMs) {
      const retryAfterSeconds = Math.max(1, Math.ceil((Date.parse(tenant.last_scan_at) + minimumIntervalMs - Date.now()) / 1000));
      return json({ error: { code: 'scan_too_frequent', message: `Your ${tenant.plan === 'free' ? 'Free' : 'Growth'} plan allows a portal scan every ${PLAN_LIMITS[tenant.plan].minScanIntervalMinutes} minutes.`, retryAfterSeconds } }, 429, { 'retry-after': String(retryAfterSeconds) });
    }
    const scanId = await repository.startScan(identity.portalId, 'manual');
    ctx.waitUntil(scanPortal(env, identity.portalId, 'manual', scanId).catch((error) => console.error(JSON.stringify({ level: 'error', task: 'manual_scan', portalId: identity.portalId, scanId, error: error instanceof Error ? error.message : String(error) }))));
    return json({ ok: true, scanId, status: 'running' }, 202);
  }
  if (url.pathname === '/api/v1/digest/test') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    const credentials = await repository.getCredentials(identity.portalId);
    const recipients = credentials.settings.digest.recipients;
    if (recipients.length === 0) throw new AppError(400, 'digest_recipient_required', 'Configure at least one digest recipient first.');
    const summary = await dashboardForPortal(env, identity.portalId);
    await sendEmail(env, recipients, 'DealGuard test digest', `<h1>DealGuard test digest</h1><p>${summary.totalDeals} deals assessed. Average readiness score: ${summary.averageScore}.</p>`);
    await repository.audit(identity.portalId, identity.userId, identity.userEmail, 'digest.test_sent', { recipients });
    return json({ ok: true });
  }
  if (url.pathname === '/api/v1/data') {
    if (request.method !== 'DELETE') return methodNotAllowed(['DELETE']);
    const body = await readJson<{ confirmation?: string }>(request);
    if (body.confirmation !== 'DELETE DEALGUARD DATA') throw new AppError(400, 'confirmation_required', 'Enter the exact deletion confirmation phrase.');
    await repository.softDeletePortal(identity);
    await finalizePortalDeletion(env, identity);
    return json({ ok: true });
  }

  const dealId = dealIdFromPath(url.pathname);
  const action = routeAction(url.pathname);
  if (dealId && action) {
    if (action === 'assessment') {
      if (!['GET', 'POST'].includes(request.method)) return methodNotAllowed(['GET', 'POST']);
      if (request.method === 'GET') { const cached = await repository.getAssessment(identity.portalId, dealId); if (cached && Date.now() - Date.parse(cached.assessedAt) < 15 * 60_000) return json(cached); }
      return json(await assessDealForPortal(env, identity.portalId, dealId, 'record'));
    }
    if (action === 'review') {
      if (request.method !== 'POST') return methodNotAllowed(['POST']);
      await repository.markReviewed(identity, dealId);
      return json({ ok: true, reviewedAt: new Date().toISOString() });
    }
    if (action === 'handoff') {
      if (request.method !== 'POST') return methodNotAllowed(['POST']);
      const client = await HubSpotClient.forPortal(env, identity.portalId);
      const assessment = assessDeal(await client.getDeal(dealId), client.settings.rules);
      await repository.saveAssessment(identity.portalId, assessment);
      await repository.confirmHandoff(identity, dealId, assessment);
      ctx.waitUntil(notifyHandoffConfirmed(env, identity.portalId, assessment, client.settings, client.plan).catch((error) => console.error(JSON.stringify({ level: 'error', task: 'slack_handoff_confirmation', portalId: identity.portalId, dealId, error: error instanceof Error ? error.message : String(error) }))));
      ctx.waitUntil(syncAssessmentIfEnabled(env, client, assessment, 'confirmed').catch((error) => console.error(JSON.stringify({ level: 'error', task: 'native_handoff_sync', portalId: identity.portalId, dealId, error: error instanceof Error ? error.message : String(error) }))));
      return json({ ok: true, handoffStatus: 'confirmed', confirmedAt: new Date().toISOString() });
    }
  }
  throw new AppError(404, 'not_found', 'Endpoint not found.');
}
