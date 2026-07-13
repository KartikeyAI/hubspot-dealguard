import { promoteLegacyAuditEvents } from './audit-chain.js';
import { applyManualScheduledPlanChanges } from './billing-scheduler.js';
import { retryAtomicUsageReports } from './billing-usage.js';
import { applyComplianceRetention, dispatchSiemEvents } from './compliance.js';
import { sendDueDigests } from './email.js';
import { expirePolicyExceptions } from './enterprise-policy.js';
import { errorResponse, requestId } from './http.js';
import { runMaintenance } from './maintenance.js';
import { dispatchOutbox } from './outbox.js';
import { dispatchEnterpriseAlerts, escalateUnacknowledgedAlerts } from './alerting-enterprise.js';
import { escalateOverdueRemediations } from './remediation.js';
import { runDueSyntheticChecks } from './reliability.js';
import { Repository } from './repository.js';
import { route } from './routes-v7.js';
import { scanPortal } from './scanner.js';
import { deleteExpiredSecureDownloads } from './secure-downloads.js';
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
      ctx.waitUntil(scanPortal(env, tenant.portal_id, 'scheduled').catch((error) => {
        console.error(JSON.stringify({ level: 'error', task: 'scheduled_scan', portalId: tenant.portal_id, error: error instanceof Error ? error.message : String(error) }));
      }));
    }
    ctx.waitUntil(escalateOverdueRemediations(env));
    ctx.waitUntil(dispatchEnterpriseAlerts(env));
    ctx.waitUntil(escalateUnacknowledgedAlerts(env));
    ctx.waitUntil(dispatchOutbox(env));
    ctx.waitUntil(dispatchSiemEvents(env));
    ctx.waitUntil(runDueSyntheticChecks(env));
    ctx.waitUntil(retryAtomicUsageReports(env));
    ctx.waitUntil(applyManualScheduledPlanChanges(env));
    ctx.waitUntil(expirePolicyExceptions(env));
    ctx.waitUntil(sendDueDigests(env));
    ctx.waitUntil(applyComplianceRetention(env));
    ctx.waitUntil(promoteLegacyAuditEvents(env));
    ctx.waitUntil(deleteExpiredSecureDownloads(env));
    ctx.waitUntil(runMaintenance(env));
  },
};
