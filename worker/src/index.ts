import { errorResponse, json, requestId } from './http.js';
import { enqueueScan, wakeDeliveryQueue, wakeMaintenanceQueue } from './queue-publisher.js';
import { processQueueBatch } from './queueing.js';
import { Repository } from './repository.js';
import { route } from './routes-v10.js';
import { createRuntimeEnv } from './runtime.js';
import type { DealGuardQueueMessage, ExecutionContext, QueueBatch, ScheduledEvent, WorkerBindings } from './types.js';
import { DEALGUARD_VERSION } from './version.js';

const deliveryTasks = ['enterprise_alerts', 'outbox', 'siem', 'billing_usage', 'digests'] as const;
const maintenanceTasks = ['remediation_escalation', 'alert_escalation', 'synthetics', 'billing_schedule', 'policy_exceptions', 'retention', 'audit_promotion', 'secure_download_cleanup', 'maintenance'] as const;

export default {
  async fetch(request: Request, bindings: WorkerBindings, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ status: 'ok', service: 'dealguard-api', version: DEALGUARD_VERSION });
    }

    const env = createRuntimeEnv(bindings);
    const id = requestId(request);
    try {
      return await route(request, env, ctx);
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', requestId: id, path: url.pathname, error: error instanceof Error ? error.message : String(error) }));
      return errorResponse(error, id);
    }
  },

  async scheduled(_event: ScheduledEvent, bindings: WorkerBindings, ctx: ExecutionContext): Promise<void> {
    const env = createRuntimeEnv(bindings);
    const repository = new Repository(env);
    const tenants = await repository.listDueTenants();
    for (const tenant of tenants) {
      ctx.waitUntil((async () => {
        let scanId: string | null = null;
        try {
          scanId = await repository.startScan(tenant.portal_id, 'scheduled');
          await enqueueScan(env, { portalId: tenant.portal_id, trigger: 'scheduled', scanId });
        } catch (error) {
          if (scanId) await repository.failScan(scanId, tenant.portal_id, error instanceof Error ? error.message : String(error)).catch(() => undefined);
          console.error(JSON.stringify({ level: 'error', task: 'scheduled_scan_enqueue', portalId: tenant.portal_id, error: error instanceof Error ? error.message : String(error) }));
        }
      })());
    }
    for (const task of deliveryTasks) ctx.waitUntil(wakeDeliveryQueue(env, task));
    for (const task of maintenanceTasks) ctx.waitUntil(wakeMaintenanceQueue(env, task));
  },

  async queue(batch: QueueBatch<DealGuardQueueMessage>, bindings: WorkerBindings, _ctx: ExecutionContext): Promise<void> {
    await processQueueBatch(createRuntimeEnv(bindings), batch);
  },
};
