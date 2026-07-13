import {
  beginApprovedChange,
  completeApprovedChange,
  failApprovedChange,
  withoutApprovalFields,
} from './change-control.js';
import { readJson } from './http.js';
import { route as routeV5 } from './routes-v5.js';
import { validateHubSpotRequest } from './signature.js';
import type { Env, RequestIdentity } from './types.js';

interface SensitiveChange {
  approvalId: string;
  changeType: string;
  resourceType: string;
  resourceId: string;
  payload: Record<string, unknown>;
}

async function body(request: Request): Promise<Record<string, unknown>> {
  if (request.method === 'GET' || request.method === 'HEAD') return {};
  try {
    return await readJson<Record<string, unknown>>(request.clone(), 1_000_000);
  } catch {
    return {};
  }
}

function approvalId(input: Record<string, unknown>, url: URL): string {
  const value = input.approvalId ?? input.approval_id ?? url.searchParams.get('approvalId');
  return typeof value === 'string' ? value.trim() : '';
}

async function sensitiveChange(request: Request, identity: RequestIdentity): Promise<SensitiveChange | null> {
  const url = new URL(request.url);
  const input = await body(request);
  const approved = approvalId(input, url);
  const payload = withoutApprovalFields(input);

  if (url.pathname === '/api/v1/billing/plan-change' && request.method === 'POST') {
    return { approvalId: approved, changeType: 'billing.plan.change', resourceType: 'subscription', resourceId: identity.portalId, payload };
  }
  if (url.pathname === '/api/v1/billing/plan-change' && request.method === 'DELETE') {
    return { approvalId: approved, changeType: 'billing.plan.cancel', resourceType: 'subscription', resourceId: identity.portalId, payload };
  }
  if (url.pathname === '/api/v1/billing/allowances' && request.method === 'PUT') {
    const metric = typeof payload.metric === 'string' ? payload.metric : 'unknown';
    return { approvalId: approved, changeType: 'billing.allowance.update', resourceType: 'billing_allowance', resourceId: metric, payload };
  }
  if (url.pathname === '/api/v1/enterprise/compliance' && request.method === 'PUT') {
    return { approvalId: approved, changeType: 'compliance.settings.update', resourceType: 'compliance_settings', resourceId: identity.portalId, payload };
  }
  const holdRelease = url.pathname.match(/^\/api\/v1\/enterprise\/compliance\/legal-holds\/([^/]+)\/release$/);
  if (holdRelease && request.method === 'POST') {
    return { approvalId: approved, changeType: 'legal_hold.release', resourceType: 'legal_hold', resourceId: holdRelease[1]!, payload };
  }
  if (url.pathname === '/api/v1/enterprise/compliance/siem' && request.method === 'POST') {
    return { approvalId: approved, changeType: 'siem.destination.create', resourceType: 'siem_destination', resourceId: identity.portalId, payload };
  }
  if (url.pathname === '/api/v1/enterprise/roles' && request.method === 'PUT') {
    const subject = typeof payload.userId === 'string' && payload.userId
      ? payload.userId
      : typeof payload.userEmail === 'string' ? payload.userEmail.toLowerCase() : 'unknown';
    return { approvalId: approved, changeType: 'role.assign', resourceType: 'enterprise_role', resourceId: subject, payload };
  }
  const roleRemoval = url.pathname.match(/^\/api\/v1\/enterprise\/roles\/([^/]+)$/);
  if (roleRemoval && request.method === 'DELETE') {
    return { approvalId: approved, changeType: 'role.remove', resourceType: 'enterprise_role', resourceId: roleRemoval[1]!, payload };
  }
  if (url.pathname === '/api/v1/data' && request.method === 'DELETE') {
    return { approvalId: approved, changeType: 'data.delete', resourceType: 'tenant', resourceId: identity.portalId, payload };
  }
  return null;
}

export async function route(request: Request, env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<Response> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/v1/')) return routeV5(request, env, ctx);
  const identity = await validateHubSpotRequest(request, env);
  const change = await sensitiveChange(request, identity);
  if (!change) return routeV5(request, env, ctx);

  const execution = await beginApprovedChange(env, identity, change.approvalId, {
    changeType: change.changeType,
    resourceType: change.resourceType,
    resourceId: change.resourceId,
    payload: change.payload,
  });
  try {
    const response = await routeV5(request, env, ctx);
    if (!response.ok) {
      await failApprovedChange(env, identity, execution.approvalId, `Downstream action returned HTTP ${response.status}.`);
      return response;
    }
    await completeApprovedChange(env, identity, execution.approvalId);
    return response;
  } catch (error) {
    await failApprovedChange(env, identity, execution.approvalId, error);
    throw error;
  }
}
