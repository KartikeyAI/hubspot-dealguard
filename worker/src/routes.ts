import { PLAN_LIMITS, REQUIRED_HUBSPOT_SCOPES } from './config.js';
import { randomToken, sha256Hex } from './crypto.js';
import { sendEmail } from './email.js';
import { AppError } from './errors.js';
import { HubSpotClient } from './hubspot.js';
import { html, json, methodNotAllowed, readJson, redirect } from './http.js';
import { docsPage, installSuccessPage, landingPage, privacyPage, supportPage, termsPage } from './pages.js';
import { Repository } from './repository.js';
import { assessDeal } from './scoring.js';
import { scanPortal } from './scanner.js';
import { validateHubSpotRequest } from './signature.js';
import type { Env, PlanId } from './types.js';

function dealIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/api\/v1\/deals\/(\d+)\/(assessment|review|handoff)$/);
  return match?.[1] ?? null;
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
    if (env.HUBSPOT_APP_ID && env.HUBSPOT_APP_ID !== 'REPLACE_WITH_HUBSPOT_APP_ID' && String(info.app_id) !== env.HUBSPOT_APP_ID) {
      throw new AppError(401, 'oauth_app_mismatch', 'OAuth token belongs to a different HubSpot app.');
    }
    await repository.upsertTenant(tokens, info);
    ctx.waitUntil(scanPortal(env, String(info.hub_id), 'install'));
    return redirect(`${env.APP_BASE_URL}/install/success`);
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

  if (url.pathname === '/api/v1/metadata') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const client = await HubSpotClient.forPortal(env, identity.portalId);
    const [pipelines, properties] = await Promise.all([client.getPipelines(), client.getDealProperties()]);
    return json({
      pipelines: pipelines.map((pipeline) => ({
        id: pipeline.id,
        label: pipeline.label,
        stages: pipeline.stages.map((stage) => ({ id: stage.id, label: stage.label })),
      })),
      properties: properties.map((property) => ({
        name: property.name,
        label: property.label,
        groupName: property.groupName,
        type: property.type,
        fieldType: property.fieldType,
      })),
    });
  }

  if (url.pathname === '/api/v1/dashboard') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    return json(await repository.dashboard(identity.portalId));
  }

  if (url.pathname === '/api/v1/settings') {
    if (request.method === 'GET') {
      const credentials = await repository.getCredentials(identity.portalId);
      return json({ plan: credentials.tenant.plan, settings: credentials.settings });
    }
    if (request.method === 'PUT') {
      const settings = await repository.saveSettings(identity, await readJson(request));
      return json({ ok: true, settings });
    }
    return methodNotAllowed(['GET', 'PUT']);
  }

  if (url.pathname === '/api/v1/scans') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    const tenant = await repository.getTenant(identity.portalId);
    const minimumIntervalMs = PLAN_LIMITS[tenant.plan].minScanIntervalMinutes * 60_000;
    if (tenant.last_scan_at && Date.now() - Date.parse(tenant.last_scan_at) < minimumIntervalMs) {
      const retryAfterSeconds = Math.max(1, Math.ceil((Date.parse(tenant.last_scan_at) + minimumIntervalMs - Date.now()) / 1000));
      return json(
        {
          error: {
            code: 'scan_too_frequent',
            message: `Your ${tenant.plan === 'free' ? 'Free' : 'Growth'} plan allows a portal scan every ${PLAN_LIMITS[tenant.plan].minScanIntervalMinutes} minutes.`,
            retryAfterSeconds,
          },
        },
        429,
        { 'retry-after': String(retryAfterSeconds) },
      );
    }
    const scanId = await repository.startScan(identity.portalId, 'manual');
    ctx.waitUntil(scanPortal(env, identity.portalId, 'manual', scanId).catch((error) => {
      console.error(JSON.stringify({ level: 'error', task: 'manual_scan', portalId: identity.portalId, scanId, error: error instanceof Error ? error.message : String(error) }));
    }));
    return json({ ok: true, scanId, status: 'running' }, 202);
  }

  if (url.pathname === '/api/v1/digest/test') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    const credentials = await repository.getCredentials(identity.portalId);
    const recipients = credentials.settings.digest.recipients;
    if (recipients.length === 0) throw new AppError(400, 'digest_recipient_required', 'Configure at least one digest recipient first.');
    const summary = await repository.dashboard(identity.portalId);
    await sendEmail(env, recipients, 'DealGuard test digest', `<h1>DealGuard test digest</h1><p>${summary.totalDeals} deals assessed. Average readiness score: ${summary.averageScore}.</p>`);
    await repository.audit(identity.portalId, identity.userId, identity.userEmail, 'digest.test_sent', { recipients });
    return json({ ok: true });
  }

  if (url.pathname === '/api/v1/data') {
    if (request.method !== 'DELETE') return methodNotAllowed(['DELETE']);
    const body = await readJson<{ confirmation?: string }>(request);
    if (body.confirmation !== 'DELETE DEALGUARD DATA') {
      throw new AppError(400, 'confirmation_required', 'Enter the exact deletion confirmation phrase.');
    }
    await repository.softDeletePortal(identity);
    return json({ ok: true });
  }

  const dealId = dealIdFromPath(url.pathname);
  const action = routeAction(url.pathname);
  if (dealId && action) {
    if (action === 'assessment') {
      if (!['GET', 'POST'].includes(request.method)) return methodNotAllowed(['GET', 'POST']);
      if (request.method === 'GET') {
        const cached = await repository.getAssessment(identity.portalId, dealId);
        if (cached && Date.now() - Date.parse(cached.assessedAt) < 15 * 60_000) return json(cached);
      }
      const client = await HubSpotClient.forPortal(env, identity.portalId);
      const assessment = assessDeal(await client.getDeal(dealId), client.settings.rules);
      await repository.saveAssessment(identity.portalId, assessment);
      return json(await repository.getAssessment(identity.portalId, dealId));
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
      return json({ ok: true, handoffStatus: 'confirmed', confirmedAt: new Date().toISOString() });
    }
  }

  throw new AppError(404, 'not_found', 'Endpoint not found.');
}
