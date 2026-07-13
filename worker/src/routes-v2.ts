import { saveAssessmentContext } from './assessment-context.js';
import { assessDealForPortal } from './assessment-service.js';
import { exportAuditCsv, searchAuditEvents } from './audit.js';
import { requireOperationalPermission } from './authorization.js';
import {
  createCheckoutSession,
  createCustomerPortalSession,
  getBillingStatus,
  processDodoWebhook,
  requireCommercialTier,
  setManualSubscription,
  verifyDodoWebhook,
  type CommercialTier,
  type UsageMode,
} from './billing.js';
import { PLAN_LIMITS, REQUIRED_HUBSPOT_SCOPES } from './config.js';
import { randomToken, sha256Hex } from './crypto.js';
import { dashboardForPortal } from './dashboard.js';
import { finalizePortalDeletion } from './data-deletion.js';
import { sendEmail } from './email.js';
import { enterpriseOverview } from './enterprise-analytics.js';
import { routeEnterpriseApi } from './enterprise-routes.js';
import { resolveSegmentedRules } from './enterprise-policy.js';
import { recordAssessmentHistory } from './enterprise-analytics-v2.js';
import { AppError } from './errors.js';
import {
  assignRole,
  createPolicyDraft,
  createPolicySimulation,
  decidePolicy,
  enableGovernance,
  getPolicy,
  governanceContext,
  listPolicies,
  listRoles,
  publishPolicy,
  runPolicySimulation,
  submitPolicy,
  updatePolicyDraft,
} from './governance.js';
import { serviceHealth } from './health.js';
import { normalizeHubSpotWebhookEvents, processHubSpotWebhookEvents } from './hubspot-events.js';
import { HubSpotClient } from './hubspot.js';
import { html, json, methodNotAllowed, readJson, redirect } from './http.js';
import { backfillNativeSync, getNativeSyncStatus, provisionNativeSync, syncAssessmentIfEnabled } from './native-sync.js';
import {
  createDestination,
  deleteDestination,
  listDestinations,
  listOutbox,
  replayOutboxEvent,
  updateDestination,
} from './outbox.js';
import {
  billingCanceledPage,
  billingSuccessPage,
  docsPage,
  installSuccessPage,
  landingPage,
  privacyPage,
  slackSuccessPage,
  supportPage,
  termsPage,
} from './pages.js';
import {
  createRemediationCase,
  listRemediationCases,
  remediationSummary,
} from './remediation.js';
import { transitionEnterpriseRemediation } from './remediation-enterprise.js';
import { executeRemediationWorkflow } from './remediation-workflow.js';
import { publicStatus } from './reliability.js';
import { Repository } from './repository.js';
import { assessDeal } from './scoring.js';
import { scanPortal } from './scanner.js';
import { completeSlackAuthorization, createSlackAuthorization, disconnectSlack, getSlackStatus, notifyHandoffConfirmed, sendSlackTest } from './slack.js';
import { validateHubSpotRequest, validateHubSpotSignature } from './signature.js';
import type { Env, PlanId } from './types.js';
import { parseSettings } from './validation.js';
import { executeWorkflowAction } from './workflow-action.js';

function dealIdFromPath(pathname: string): string | null {
  return pathname.match(/^\/api\/v1\/deals\/(\d+)\/(assessment|review|handoff)$/)?.[1] ?? null;
}

function routeAction(pathname: string): string | null {
  return pathname.match(/^\/api\/v1\/deals\/\d+\/(assessment|review|handoff)$/)?.[1] ?? null;
}

function policyPath(pathname: string): { id: string; action: string | null } | null {
  const match = pathname.match(/^\/api\/v1\/governance\/policies\/([^/]+)(?:\/(submit|approve|reject|publish|rollback|simulate))?$/);
  return match ? { id: match[1]!, action: match[2] ?? null } : null;
}

function remediationPath(pathname: string): { id: string; action: string } | null {
  const match = pathname.match(/^\/api\/v1\/remediations\/([^/]+)\/(acknowledge|start|resolve|waive|close|reopen|assign)$/);
  return match ? { id: match[1]!, action: match[2]! } : null;
}

function destinationId(pathname: string): string | null {
  return pathname.match(/^\/api\/v1\/operations\/destinations\/([^/]+)$/)?.[1] ?? null;
}

function replayId(pathname: string): string | null {
  return pathname.match(/^\/api\/v1\/operations\/outbox\/([^/]+)\/replay$/)?.[1] ?? null;
}

export async function route(request: Request, env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<Response> {
  const url = new URL(request.url);
  const repository = new Repository(env);

  if (url.pathname === '/' && request.method === 'GET') return html(landingPage(env));
  if (url.pathname === '/health' && request.method === 'GET') return json({ status: 'ok', service: 'dealguard-api', version: '2.0.0-rc.1' });
  if (url.pathname === '/status' && request.method === 'GET') return json(await publicStatus(env));
  if (url.pathname === '/docs' && request.method === 'GET') return html(docsPage(env));
  if (url.pathname === '/privacy' && request.method === 'GET') return html(privacyPage(env));
  if (url.pathname === '/terms' && request.method === 'GET') return html(termsPage(env));
  if (url.pathname === '/support' && request.method === 'GET') return html(supportPage(env));
  if (url.pathname === '/install/success' && request.method === 'GET') return html(installSuccessPage(env));
  if (url.pathname === '/integrations/slack/success' && request.method === 'GET') return html(slackSuccessPage(env));
  if (url.pathname === '/billing/success' && request.method === 'GET') return html(billingSuccessPage(env));
  if (url.pathname === '/billing/canceled' && request.method === 'GET') return html(billingCanceledPage(env));

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

  if (url.pathname === '/webhooks/dodo') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    const verified = await verifyDodoWebhook(request, env);
    // Process before returning success so Dodo retries transient failures.
    await processDodoWebhook(env, verified.rawBody, verified.webhookId);
    return json({ accepted: true });
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

  if (url.pathname === '/integrations/hubspot/workflow-actions/create-remediation') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    await validateHubSpotSignature(request, env);
    return json(await executeRemediationWorkflow(env, await readJson<unknown>(request)));
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
    const subscriptionMatch = url.pathname.match(/^\/internal\/portals\/(\d+)\/subscription$/);
    if (subscriptionMatch) {
      if (request.method !== 'PUT') return methodNotAllowed(['PUT']);
      const body = await readJson<{
        tier?: CommercialTier; currentPeriodEnd?: string | null; contractReference?: string | null;
        purchaseOrderReference?: string | null; currency?: string; usageMode?: UsageMode; overageEnabled?: boolean;
      }>(request);
      if (!body.tier) throw new AppError(400, 'subscription_tier_required', 'A commercial tier is required.');
      await setManualSubscription(env, subscriptionMatch[1]!, body.tier, body.currentPeriodEnd ?? null, {
        ...(body.contractReference !== undefined ? { contractReference: body.contractReference } : {}),
        ...(body.purchaseOrderReference !== undefined ? { purchaseOrderReference: body.purchaseOrderReference } : {}),
        ...(body.currency !== undefined ? { currency: body.currency } : {}),
        ...(body.usageMode !== undefined ? { usageMode: body.usageMode } : {}),
        ...(body.overageEnabled !== undefined ? { overageEnabled: body.overageEnabled } : {}),
      });
      return json({ ok: true, portalId: subscriptionMatch[1], tier: body.tier });
    }
    throw new AppError(404, 'not_found', 'Endpoint not found.');
  }

  if (!url.pathname.startsWith('/api/v1/')) throw new AppError(404, 'not_found', 'Endpoint not found.');
  const identity = await validateHubSpotRequest(request, env);

  const enterpriseResponse = await routeEnterpriseApi(request, env, identity, ctx);
  if (enterpriseResponse) return enterpriseResponse;

  if (url.pathname === '/api/v1/billing') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    return json(await getBillingStatus(env, identity.portalId));
  }
  if (url.pathname === '/api/v1/billing/checkout') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    await requireOperationalPermission(env, identity, 'billing.manage');
    const body = await readJson<{ tier?: CommercialTier; interval?: 'month' | 'year'; usageMode?: UsageMode; overageEnabled?: boolean }>(request);
    return json(await createCheckoutSession(
      env,
      identity,
      body.tier ?? 'growth',
      body.interval === 'year' ? 'year' : 'month',
      {
        ...(body.usageMode !== undefined ? { usageMode: body.usageMode } : {}),
        ...(body.overageEnabled !== undefined ? { overageEnabled: body.overageEnabled } : {}),
      },
    ));
  }
  if (url.pathname === '/api/v1/billing/portal') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    await requireOperationalPermission(env, identity, 'billing.manage');
    return json(await createCustomerPortalSession(env, identity));
  }

  if (url.pathname === '/api/v1/enterprise/overview') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    return json(await enterpriseOverview(env, identity));
  }

  if (url.pathname === '/api/v1/governance/me') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    return json(await governanceContext(env, identity));
  }
  if (url.pathname === '/api/v1/governance/enable') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    await requireCommercialTier(env, identity.portalId, 'enterprise');
    return json(await enableGovernance(env, identity));
  }
  if (url.pathname === '/api/v1/governance/policies') {
    if (request.method === 'GET') return json({ policies: await listPolicies(env, identity.portalId) });
    if (request.method === 'POST') {
      await requireCommercialTier(env, identity.portalId, 'enterprise');
      return json(await createPolicyDraft(env, identity, await readJson<unknown>(request)), 201);
    }
    return methodNotAllowed(['GET', 'POST']);
  }

  const policyRoute = policyPath(url.pathname);
  if (policyRoute) {
    if (!policyRoute.action) {
      if (request.method === 'GET') {
        const policy = await getPolicy(env, identity.portalId, policyRoute.id);
        if (!policy) throw new AppError(404, 'policy_not_found', 'The requested policy does not exist.');
        return json(policy);
      }
      if (request.method === 'PUT') {
        await requireCommercialTier(env, identity.portalId, 'enterprise');
        return json(await updatePolicyDraft(env, identity, policyRoute.id, await readJson<unknown>(request)));
      }
      return methodNotAllowed(['GET', 'PUT']);
    }
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    await requireCommercialTier(env, identity.portalId, 'enterprise');
    if (policyRoute.action === 'submit') return json(await submitPolicy(env, identity, policyRoute.id));
    if (policyRoute.action === 'approve' || policyRoute.action === 'reject') {
      const body = await readJson<{ comment?: string }>(request);
      return json(await decidePolicy(env, identity, policyRoute.id, policyRoute.action === 'approve' ? 'approved' : 'rejected', body.comment ?? ''));
    }
    if (policyRoute.action === 'publish') return json(await publishPolicy(env, identity, policyRoute.id));
    if (policyRoute.action === 'rollback') return json(await createPolicyDraft(env, identity, await readJson<unknown>(request), policyRoute.id), 201);
    if (policyRoute.action === 'simulate') {
      const simulation = await createPolicySimulation(env, identity, policyRoute.id);
      ctx.waitUntil(runPolicySimulation(env, identity.portalId, policyRoute.id, simulation.id));
      return json(simulation, 202);
    }
  }

  if (url.pathname === '/api/v1/governance/roles') {
    if (request.method === 'GET') return json({ roles: await listRoles(env, identity) });
    if (request.method === 'PUT') {
      await requireCommercialTier(env, identity.portalId, 'enterprise');
      await assignRole(env, identity, await readJson<unknown>(request));
      return json({ ok: true });
    }
    return methodNotAllowed(['GET', 'PUT']);
  }
  if (url.pathname === '/api/v1/governance/audit') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    return json({ events: await searchAuditEvents(env, identity, url) });
  }
  if (url.pathname === '/api/v1/governance/audit/export') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    return exportAuditCsv(env, identity);
  }

  if (url.pathname === '/api/v1/remediations') {
    if (request.method === 'GET') return json({ cases: await listRemediationCases(env, identity.portalId, url) });
    if (request.method === 'POST') {
      await requireCommercialTier(env, identity.portalId, 'enterprise');
      await requireOperationalPermission(env, identity, 'remediation.manage');
      return json(await createRemediationCase(env, identity, await readJson<unknown>(request)), 201);
    }
    return methodNotAllowed(['GET', 'POST']);
  }
  if (url.pathname === '/api/v1/remediations/summary') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    return json(await remediationSummary(env, identity.portalId));
  }
  const remediationRoute = remediationPath(url.pathname);
  if (remediationRoute) {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    await requireCommercialTier(env, identity.portalId, 'enterprise');
    return json(await transitionEnterpriseRemediation(env, identity, remediationRoute.id, remediationRoute.action, await readJson<unknown>(request)));
  }

  if (url.pathname === '/api/v1/operations/health') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    return json(await serviceHealth(env, identity.portalId));
  }
  if (url.pathname === '/api/v1/operations/destinations') {
    if (request.method === 'GET') return json({ destinations: await listDestinations(env, identity.portalId) });
    if (request.method === 'POST') {
      await requireCommercialTier(env, identity.portalId, 'enterprise');
      await requireOperationalPermission(env, identity, 'delivery.manage');
      return json(await createDestination(env, identity, await readJson<unknown>(request)), 201);
    }
    return methodNotAllowed(['GET', 'POST']);
  }
  const destinationRoute = destinationId(url.pathname);
  if (destinationRoute) {
    await requireCommercialTier(env, identity.portalId, 'enterprise');
    await requireOperationalPermission(env, identity, 'delivery.manage');
    if (request.method === 'PUT') return json(await updateDestination(env, identity, destinationRoute, await readJson<unknown>(request)));
    if (request.method === 'DELETE') {
      await deleteDestination(env, identity, destinationRoute);
      return json({ ok: true });
    }
    return methodNotAllowed(['PUT', 'DELETE']);
  }
  if (url.pathname === '/api/v1/operations/outbox') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    return json({ events: await listOutbox(env, identity.portalId, url.searchParams.get('status'), Number(url.searchParams.get('limit') ?? 100)) });
  }
  const outboxReplay = replayId(url.pathname);
  if (outboxReplay) {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    await requireCommercialTier(env, identity.portalId, 'enterprise');
    await requireOperationalPermission(env, identity, 'outbox.replay');
    await replayOutboxEvent(env, identity, outboxReplay);
    return json({ ok: true });
  }

  if (url.pathname === '/api/v1/integrations/slack') {
    if (request.method === 'GET') return json(await getSlackStatus(env, identity.portalId));
    if (request.method === 'DELETE') {
      await requireOperationalPermission(env, identity, 'integration.manage');
      await disconnectSlack(env, identity);
      return json({ ok: true });
    }
    return methodNotAllowed(['GET', 'DELETE']);
  }
  if (url.pathname === '/api/v1/integrations/slack/connect') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    await requireOperationalPermission(env, identity, 'integration.manage');
    return json({ authorizeUrl: await createSlackAuthorization(env, identity) });
  }
  if (url.pathname === '/api/v1/integrations/slack/test') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    await requireOperationalPermission(env, identity, 'integration.manage');
    await sendSlackTest(env, identity);
    return json({ ok: true });
  }

  if (url.pathname === '/api/v1/native-sync') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    return json(await getNativeSyncStatus(env, identity.portalId));
  }
  if (url.pathname === '/api/v1/native-sync/provision') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    await requireOperationalPermission(env, identity, 'native_sync.manage');
    return json(await provisionNativeSync(env, identity));
  }
  if (url.pathname === '/api/v1/native-sync/backfill') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    await requireOperationalPermission(env, identity, 'native_sync.manage');
    const status = await getNativeSyncStatus(env, identity.portalId);
    if (!status.entitled || !status.enabled || status.status !== 'ready') throw new AppError(409, 'native_sync_not_ready', 'Provision and enable native HubSpot property sync before starting a backfill.');
    ctx.waitUntil(backfillNativeSync(env, identity.portalId).catch((error) => {
      console.error(JSON.stringify({ level: 'error', task: 'native_sync_backfill', portalId: identity.portalId, error: error instanceof Error ? error.message : String(error) }));
    }));
    return json({ ok: true, status: 'backfilling' }, 202);
  }

  if (url.pathname === '/api/v1/metadata') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const client = await HubSpotClient.forPortal(env, identity.portalId);
    const [pipelines, properties] = await Promise.all([client.getPipelines(), client.getDealProperties()]);
    return json({
      pipelines: pipelines.map((pipeline) => ({ id: pipeline.id, label: pipeline.label, stages: pipeline.stages.map((stage) => ({ id: stage.id, label: stage.label })) })),
      properties: properties.map((property) => ({ name: property.name, label: property.label, groupName: property.groupName, type: property.type, fieldType: property.fieldType })),
    });
  }
  if (url.pathname === '/api/v1/dashboard') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    return json(await dashboardForPortal(env, identity.portalId));
  }
  if (url.pathname === '/api/v1/settings') {
    if (request.method === 'GET') {
      const credentials = await repository.getCredentials(identity.portalId);
      return json({ plan: credentials.tenant.plan, settings: credentials.settings });
    }
    if (request.method === 'PUT') {
      await requireOperationalPermission(env, identity, 'settings.manage');
      const credentials = await repository.getCredentials(identity.portalId);
      const raw = await readJson<unknown>(request);
      const parsed = parseSettings(raw, credentials.tenant.plan);
      if (credentials.settings.governance.enabled) {
        if (JSON.stringify(parsed.governance) !== JSON.stringify(credentials.settings.governance)) throw new AppError(409, 'governance_settings_locked', 'Governance approval controls cannot be changed through general settings.');
        if (JSON.stringify(parsed.rules) !== JSON.stringify(credentials.settings.rules)) throw new AppError(409, 'published_policy_required', 'Scoring rules are governed. Create, approve, and publish a policy version instead of editing live rules directly.');
      }
      return json({ ok: true, settings: await repository.saveSettings(identity, raw) });
    }
    return methodNotAllowed(['GET', 'PUT']);
  }

  if (url.pathname === '/api/v1/scans') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    await requireOperationalPermission(env, identity, 'scan.run');
    const tenant = await repository.getTenant(identity.portalId);
    const minimumIntervalMs = PLAN_LIMITS[tenant.plan].minScanIntervalMinutes * 60_000;
    if (tenant.last_scan_at && Date.now() - Date.parse(tenant.last_scan_at) < minimumIntervalMs) {
      const retryAfterSeconds = Math.max(1, Math.ceil((Date.parse(tenant.last_scan_at) + minimumIntervalMs - Date.now()) / 1000));
      return json({ error: { code: 'scan_too_frequent', message: `Your plan allows a portal scan every ${PLAN_LIMITS[tenant.plan].minScanIntervalMinutes} minutes.`, retryAfterSeconds } }, 429, { 'retry-after': String(retryAfterSeconds) });
    }
    const scanId = await repository.startScan(identity.portalId, 'manual');
    ctx.waitUntil(scanPortal(env, identity.portalId, 'manual', scanId).catch((error) => {
      console.error(JSON.stringify({ level: 'error', task: 'manual_scan', portalId: identity.portalId, scanId, error: error instanceof Error ? error.message : String(error) }));
    }));
    return json({ ok: true, scanId, status: 'running' }, 202);
  }

  if (url.pathname === '/api/v1/digest/test') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    await requireOperationalPermission(env, identity, 'digest.test');
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
    await requireOperationalPermission(env, identity, 'data.delete');
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
      if (request.method === 'GET') {
        const cached = await repository.getAssessment(identity.portalId, dealId);
        if (cached && Date.now() - Date.parse(cached.assessedAt) < 15 * 60_000) return json(cached);
      }
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
      const deal = await client.getDeal(dealId);
      const resolved = await resolveSegmentedRules(env, identity.portalId, client.settings.rules, deal);
      const assessment = assessDeal(deal, resolved.rules);
      await repository.saveAssessment(identity.portalId, assessment);
      await saveAssessmentContext(env, identity.portalId, assessment);
      await recordAssessmentHistory(env, identity.portalId, assessment, { trigger: 'handoff', properties: deal.properties, policyId: resolved.policyId });
      await repository.confirmHandoff(identity, dealId, assessment);
      ctx.waitUntil(notifyHandoffConfirmed(env, identity.portalId, assessment, client.settings, client.plan).catch((error) => {
        console.error(JSON.stringify({ level: 'error', task: 'slack_handoff_confirmation', portalId: identity.portalId, dealId, error: error instanceof Error ? error.message : String(error) }));
      }));
      ctx.waitUntil(syncAssessmentIfEnabled(env, client, assessment, 'confirmed').catch((error) => {
        console.error(JSON.stringify({ level: 'error', task: 'native_handoff_sync', portalId: identity.portalId, dealId, error: error instanceof Error ? error.message : String(error) }));
      }));
      return json({ ok: true, handoffStatus: 'confirmed', confirmedAt: new Date().toISOString() });
    }
  }

  throw new AppError(404, 'not_found', 'Endpoint not found.');
}
