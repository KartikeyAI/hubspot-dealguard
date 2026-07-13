import { sendDueDigests } from './email.js';
import { errorResponse, requestId } from './http.js';
import { Repository } from './repository.js';
import { route } from './routes.js';
import { scanPortal } from './scanner.js';
import type { Env, ExecutionContext, ScheduledEvent } from './types.js';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const id = requestId(request);
    try {
      return await route(request, env, ctx);
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', requestId: id, path: new URL(request.url).pathname, error: error instanceof Error ? error.message : String(error) }));
      return errorResponse(error, id);
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const repository = new Repository(env);
    const tenants = await repository.listDueTenants();
    for (const tenant of tenants) {
      ctx.waitUntil(
        scanPortal(env, tenant.portal_id, 'scheduled').catch((error) => {
          console.error(JSON.stringify({ level: 'error', task: 'scheduled_scan', portalId: tenant.portal_id, error: error instanceof Error ? error.message : String(error) }));
        }),
      );
    }
    ctx.waitUntil(sendDueDigests(env));
  },
};
