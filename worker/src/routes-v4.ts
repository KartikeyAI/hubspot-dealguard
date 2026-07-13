import { verifyDodoWebhook } from './billing.js';
import { processDodoWebhookOrdered } from './dodo-webhook.js';
import { json, methodNotAllowed } from './http.js';
import { route as routeV3 } from './routes-v3.js';
import type { Env } from './types.js';

export async function route(request: Request, env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/webhooks/dodo') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    const verified = await verifyDodoWebhook(request, env);
    await processDodoWebhookOrdered(env, verified.rawBody, verified.webhookId);
    return json({ accepted: true });
  }
  return routeV3(request, env, ctx);
}
