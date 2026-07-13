import {
  cancelScheduledDodoPlanChange,
  changeDodoPlan,
  previewDodoPlanChange,
} from './dodo-plan-change.js';
import { requireEnterprisePermission } from './enterprise-access.js';
import { json, methodNotAllowed, readJson } from './http.js';
import { route as routeV4 } from './routes-v4.js';
import { validateHubSpotRequest } from './signature.js';
import type { Env } from './types.js';

export async function route(request: Request, env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/api/v1/billing/plan-change/preview') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    const identity = await validateHubSpotRequest(request, env);
    await requireEnterprisePermission(env, identity, 'billing.manage');
    return json(await previewDodoPlanChange(env, identity, await readJson<unknown>(request)));
  }
  if (url.pathname === '/api/v1/billing/plan-change') {
    const identity = await validateHubSpotRequest(request, env);
    await requireEnterprisePermission(env, identity, 'billing.manage');
    if (request.method === 'POST') {
      return json(await changeDodoPlan(env, identity, await readJson<unknown>(request)), 202);
    }
    if (request.method === 'DELETE') {
      await cancelScheduledDodoPlanChange(env, identity);
      return json({ ok: true });
    }
    return methodNotAllowed(['POST', 'DELETE']);
  }
  return routeV4(request, env, ctx);
}
