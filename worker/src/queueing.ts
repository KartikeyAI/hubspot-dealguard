import { promoteLegacyAuditEvents } from './audit-chain.js';
import { dispatchEnterpriseAlerts, escalateUnacknowledgedAlerts } from './alerting-enterprise.js';
import { applyManualScheduledPlanChanges } from './billing-scheduler.js';
import { retryAtomicUsageReports } from './billing-usage.js';
import { applyComplianceRetention, dispatchSiemEvents, processDataExport } from './compliance.js';
import { sendDueDigests } from './email.js';
import { expirePolicyExceptions } from './enterprise-policy.js';
import { runMaintenance } from './maintenance.js';
import { dispatchOutbox } from './outbox.js';
import { dispatchQueuedRecommendationFollowups } from './recommendation-followup-queue.js';
import { runDueSyntheticChecks } from './reliability.js';
import { escalateOverdueRemediations } from './remediation.js';
import { scanPortal } from './scanner.js';
import { deleteExpiredSecureDownloads } from './secure-downloads.js';
import type { DealGuardQueueMessage, Env, QueueBatch } from './types.js';

const MAX_QUEUE_ATTEMPTS = 8;

async function updateJob(env: Env, id: string, status: 'processing' | 'completed' | 'failed' | 'dead_letter', error: string | null = null): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE async_jobs SET status = ?, attempts = attempts + 1, last_error = ?, updated_at = ?, completed_at = CASE WHEN ? IN ('completed','dead_letter') THEN ? ELSE completed_at END WHERE id = ?`
  ).bind(status, error, now, status, now, id).run();
}

async function processMessage(env: Env, message: DealGuardQueueMessage): Promise<void> {
  if (message.version !== 1) throw new Error('Unsupported DealGuard queue message version.');
  if (message.kind === 'scan') {
    const jobId = `scan:${message.scanId}`;
    await updateJob(env, jobId, 'processing');
    await scanPortal(env, message.portalId, message.trigger, message.scanId);
    await updateJob(env, jobId, 'completed');
    return;
  }
  if (message.kind === 'delivery') {
    if (message.task === 'enterprise_alerts') await dispatchEnterpriseAlerts(env);
    else if (message.task === 'outbox') {
      await dispatchOutbox(env);
      await dispatchQueuedRecommendationFollowups(env, 1);
    }
    else if (message.task === 'siem') await dispatchSiemEvents(env);
    else if (message.task === 'billing_usage') await retryAtomicUsageReports(env);
    else if (message.task === 'digests') await sendDueDigests(env);
    else if (message.task === 'data_export') {
      if (!message.resourceId || !message.portalId) throw new Error('Data export queue message is incomplete.');
      await processDataExport(env, message.portalId, message.resourceId);
    }
    return;
  }
  if (message.task === 'remediation_escalation') await escalateOverdueRemediations(env);
  else if (message.task === 'alert_escalation') await escalateUnacknowledgedAlerts(env);
  else if (message.task === 'synthetics') await runDueSyntheticChecks(env);
  else if (message.task === 'billing_schedule') await applyManualScheduledPlanChanges(env);
  else if (message.task === 'policy_exceptions') await expirePolicyExceptions(env);
  else if (message.task === 'retention') await applyComplianceRetention(env);
  else if (message.task === 'audit_promotion') await promoteLegacyAuditEvents(env);
  else if (message.task === 'secure_download_cleanup') await deleteExpiredSecureDownloads(env);
  else if (message.task === 'maintenance') await runMaintenance(env);
}

export async function processQueueBatch(env: Env, batch: QueueBatch<DealGuardQueueMessage>): Promise<void> {
  for (const item of batch.messages) {
    try {
      await processMessage(env, item.body);
      item.ack();
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
      const body = item.body;
      const jobId = body.kind === 'scan' ? `scan:${body.scanId}` : body.kind === 'delivery' && body.task === 'data_export' && body.resourceId ? `export:${body.resourceId}` : null;
      if (jobId) await updateJob(env, jobId, item.attempts >= MAX_QUEUE_ATTEMPTS ? 'dead_letter' : 'failed', message).catch(() => undefined);
      console.error(JSON.stringify({ level: 'error', task: 'queue_consumer', queue: batch.queue, messageId: item.id, attempts: item.attempts, body, error: message }));
      if (item.attempts >= MAX_QUEUE_ATTEMPTS) item.ack();
      else item.retry({ delaySeconds: Math.min(900, 2 ** Math.min(8, item.attempts) * 5) });
    }
  }
}
