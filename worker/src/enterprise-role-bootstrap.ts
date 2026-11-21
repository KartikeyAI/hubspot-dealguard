import { requireCommercialTier } from './billing.js';
import { AppError } from './errors.js';
import { json, methodNotAllowed, readJson } from './http.js';
import { validateHubSpotRequest } from './signature.js';
import type { Env, RequestIdentity } from './types.js';

const ROOT = '/api/v1/enterprise/roles/bootstrap';
const confirmations = { propose: 'PROPOSE_INITIAL_ADMINISTRATORS', accept: 'ACCEPT_INITIAL_ADMINISTRATORS', reject: 'REJECT_INITIAL_ADMINISTRATORS' } as const;

function identified(identity: RequestIdentity): void {
  if (!identity.userId || !/^[1-9]\d{0,29}$/.test(identity.userId) || !identity.userEmail
    || identity.userEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identity.userEmail)) {
    throw new AppError(403, 'enterprise_bootstrap_identity_required', 'Initial administrator setup requires your signed HubSpot user ID and email.');
  }
}

function result(value: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (value && !value.error) return value;
  const errors: Record<string, [number, string]> = {
    installation_inactive: [403, 'This DealGuard installation is not active.'],
    enterprise_bootstrap_identity_required: [403, 'Initial administrator setup requires your signed HubSpot user ID and email.'],
    enterprise_bootstrap_initialized: [409, 'Enterprise administration is already initialized. Use the normal role approval process.'],
    enterprise_bootstrap_requester_required: [403, 'Setup requires the unassigned current installer or the sole stable-ID legacy administrator with portal-wide access.'],
    enterprise_bootstrap_distinct_identity_required: [400, 'Choose another person with a distinct HubSpot user ID and email.'],
    enterprise_bootstrap_binding_conflict: [409, 'The nominee has a conflicting or ambiguous role or email binding. Resolve the existing assignment before setup.'],
    enterprise_bootstrap_pending: [409, 'An initial administrator proposal is already pending. Review, withdraw or wait for it to expire before proposing another.'],
    enterprise_bootstrap_unavailable: [409, 'The proposal is unavailable, expired, or no longer matches this installation and its role assignments. Reload setup.'],
    enterprise_bootstrap_nominee_required: [403, 'Only the addressed nominee can accept this proposal. Its requester or nominee may reject it.'],
    enterprise_bootstrap_payload_changed: [409, 'The proposal fingerprint changed. Reload and review the exact administrator pair.'],
    enterprise_bootstrap_input_invalid: [400, 'Provide the exact initial administrator setup fields and confirmation.'],
  };
  const code = typeof value?.error === 'string' ? value.error : 'enterprise_bootstrap_unavailable';
  const [status, message] = errors[code] ?? errors.enterprise_bootstrap_unavailable!;
  throw new AppError(status, code, message);
}

export async function enterpriseRoleBootstrapStatus(env: Env, identity: RequestIdentity): Promise<Record<string, unknown>> {
  identified(identity);
  await requireCommercialTier(env, identity.portalId, 'enterprise');
  const row = await env.DB.prepare('SELECT dealguard.enterprise_role_bootstrap_status(?,?,?) AS result')
    .bind(identity.portalId, identity.userId, identity.userEmail).first<{result: Record<string, unknown>}>();
  return result(row?.result);
}

export async function mutateEnterpriseRoleBootstrap(env: Env, identity: RequestIdentity, value: unknown): Promise<Record<string, unknown>> {
  identified(identity);
  const invalid = (): never => { throw new AppError(400, 'enterprise_bootstrap_input_invalid', 'Provide the exact initial administrator setup fields and confirmation.'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const input = value as Record<string, unknown>;
  const action = input.action;
  if (typeof action !== 'string' || !Object.hasOwn(confirmations, action)
    || input.confirmation !== confirmations[action as keyof typeof confirmations]) invalid();
  let payload: Record<string, unknown>;
  if (action === 'propose') {
    if (Object.keys(input).some(key => !['action','nomineeUserId','nomineeEmail','confirmation'].includes(key))
      || typeof input.nomineeUserId !== 'string' || !/^[1-9]\d{0,29}$/.test(input.nomineeUserId)
      || typeof input.nomineeEmail !== 'string' || input.nomineeEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.nomineeEmail)) invalid();
    payload = { nomineeUserId: input.nomineeUserId, nomineeEmail: (input.nomineeEmail as string).toLowerCase() };
  } else {
    if (Object.keys(input).some(key => !['action','proposalId','payloadHash','confirmation'].includes(key))
      || typeof input.proposalId !== 'string' || input.proposalId.length < 1 || input.proposalId.length > 128
      || input.proposalId.trim() !== input.proposalId || typeof input.payloadHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.payloadHash)) invalid();
    payload = { proposalId: input.proposalId, payloadHash: input.payloadHash };
  }
  await requireCommercialTier(env, identity.portalId, 'enterprise');
  const row = await env.DB.prepare('SELECT dealguard.mutate_enterprise_role_bootstrap(?,?,?,?,?::jsonb) AS result')
    .bind(identity.portalId, identity.userId, identity.userEmail, action, JSON.stringify(payload)).first<{result: Record<string, unknown>}>();
  return result(row?.result);
}

export async function routeEnterpriseRoleBootstrap(request: Request, env: Env): Promise<Response | null> {
  if (new URL(request.url).pathname !== ROOT) return null;
  if (!['GET','POST'].includes(request.method)) return methodNotAllowed(['GET','POST']);
  const identity = await validateHubSpotRequest(request, env, 16000);
  if (request.method === 'GET') return json(await enterpriseRoleBootstrapStatus(env, identity));
  const value = await mutateEnterpriseRoleBootstrap(env, identity, await readJson(request, 16000));
  return json(value, value.outcome === 'proposed' ? 201 : 200);
}
