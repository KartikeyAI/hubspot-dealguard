import { saveAssessmentContext } from './assessment-context.js';
import { recordUsage } from './billing.js';
import { PLAN_LIMITS } from './config.js';
import { captureAnalyticsSnapshot } from './enterprise-analytics.js';
import { recordAssessmentHistory } from './enterprise-analytics-v2.js';
import { resolveSegmentedRules } from './enterprise-policy.js';
import { recordServiceFailure, recordServiceSuccess } from './health.js';
import { HubSpotClient } from './hubspot.js';
import { syncAssessmentBatchIfEnabled } from './native-sync.js';
import { syncAssessmentRemediations } from './remediation.js';
import { getScanCheckpoint, recordOperationalMetric, saveScanCheckpoint } from './reliability.js';
import { Repository } from './repository.js';
import { assessDeal } from './scoring.js';
import { notifyAssessmentTransition } from './slack.js';
import type { DealAssessment, Env } from './types.js';

interface ScanCheckpointState {
  ready?: number;
  atRisk?: number;
  critical?: number;
  incompleteHandoffs?: number;
  processedDealIds?: string[];
}

export async function scanPortal(
  env: Env,
  portalId: string,
  trigger: 'manual' | 'scheduled' | 'install',
  existingScanId?: string,
) {
  const startedAt = Date.now();
  const repository = new Repository(env);
  const client = await HubSpotClient.forPortal(env, portalId);
  const scanId = existingScanId ?? await repository.startScan(portalId, trigger);
  const leaseOwner = crypto.randomUUID();
  try {
    const deals = await client.listDeals(PLAN_LIMITS[client.plan].maxDealsPerScan);
    const checkpoint = await getScanCheckpoint(env, scanId, portalId);
    const state = checkpoint?.state && typeof checkpoint.state === 'object'
      ? checkpoint.state as ScanCheckpointState
      : {};
    const processedDealIds = new Set((state.processedDealIds ?? []).filter((id) => typeof id === 'string'));
    const nativeUpdates: Array<{ assessment: DealAssessment; handoffStatus?: string | null }> = [];
    let ready = Number(state.ready ?? 0);
    let atRisk = Number(state.atRisk ?? 0);
    let critical = Number(state.critical ?? 0);
    let incompleteHandoffs = Number(state.incompleteHandoffs ?? 0);
    let processedSinceCheckpoint = 0;
    await saveScanCheckpoint(env, scanId, portalId, {
      processedCount: processedDealIds.size,
      lastDealId: checkpoint?.lastDealId ? String(checkpoint.lastDealId) : null,
      state: { ready, atRisk, critical, incompleteHandoffs, processedDealIds: [...processedDealIds] },
      leaseOwner,
      leaseSeconds: 600,
    });

    for (const deal of deals) {
      if (processedDealIds.has(deal.id)) continue;
      const previous = await repository.getAssessment(portalId, deal.id);
      const policy = await resolveSegmentedRules(env, portalId, client.settings.rules, deal);
      const assessment = assessDeal(deal, policy.rules);
      await repository.saveAssessment(portalId, assessment);
      await saveAssessmentContext(env, portalId, assessment);
      await recordAssessmentHistory(env, portalId, assessment, {
        trigger,
        properties: deal.properties,
        policyId: policy.policyId,
      });
      const stored = await repository.getAssessment(portalId, deal.id);
      nativeUpdates.push({ assessment, ...(stored ? { handoffStatus: stored.handoffStatus } : {}) });
      try {
        await notifyAssessmentTransition(env, portalId, previous, assessment, client.settings, client.plan, trigger);
      } catch (error) {
        console.error(JSON.stringify({ level: 'error', task: 'slack_scan_notification', portalId, dealId: deal.id, error: error instanceof Error ? error.message : String(error) }));
      }
      try {
        await syncAssessmentRemediations(env, portalId, assessment);
      } catch (error) {
        console.error(JSON.stringify({ level: 'error', task: 'remediation_scan_sync', portalId, dealId: deal.id, error: error instanceof Error ? error.message : String(error) }));
      }
      if (assessment.status === 'ready') ready += 1;
      if (assessment.status === 'at_risk') atRisk += 1;
      if (assessment.status === 'critical') critical += 1;
      if (assessment.isWon && stored?.handoffStatus !== 'confirmed') incompleteHandoffs += 1;
      processedDealIds.add(deal.id);
      processedSinceCheckpoint += 1;
      if (processedSinceCheckpoint >= 25 || processedDealIds.size === deals.length) {
        await saveScanCheckpoint(env, scanId, portalId, {
          processedCount: processedDealIds.size,
          lastDealId: deal.id,
          state: { ready, atRisk, critical, incompleteHandoffs, processedDealIds: [...processedDealIds] },
          leaseOwner,
          leaseSeconds: 600,
        });
        processedSinceCheckpoint = 0;
      }
    }
    try {
      await syncAssessmentBatchIfEnabled(env, client, nativeUpdates);
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', task: 'native_scan_sync', portalId, scanId, error: error instanceof Error ? error.message : String(error) }));
    }
    const counts = { scanned: processedDealIds.size, ready, atRisk, critical, incompleteHandoffs };
    await repository.completeScan(scanId, portalId, client.plan, counts);
    await env.DB.prepare(`DELETE FROM scan_checkpoints WHERE scan_id = ? AND portal_id = ?`).bind(scanId, portalId).run();
    await captureAnalyticsSnapshot(env, portalId);
    await recordServiceSuccess(env, portalId, 'scan');
    await recordOperationalMetric(env, { portalId, service: 'scan', metric: 'success', value: 1, dimensions: { trigger } });
    await recordOperationalMetric(env, { portalId, service: 'scan', metric: 'latency_ms', value: Date.now() - startedAt, dimensions: { trigger, scanned: processedDealIds.size } });
    try {
      await recordUsage(env, portalId, 'active_deal_overage', processedDealIds.size, `scan-deals:${scanId}`, { trigger, scan_id: scanId });
      await recordUsage(env, portalId, 'event_overage', processedDealIds.size, `scan-events:${scanId}`, { trigger, scan_id: scanId });
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', task: 'scan_usage', portalId, scanId, error: error instanceof Error ? error.message : String(error) }));
    }
    await repository.audit(portalId, null, null, 'scan.completed', { scanId, trigger, ...counts });
    return { scanId, ...counts };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected scan failure';
    await repository.failScan(scanId, portalId, message);
    await recordServiceFailure(env, portalId, error);
    await recordOperationalMetric(env, { portalId, service: 'scan', metric: 'success', value: 0, dimensions: { trigger, error: message.slice(0, 500) } });
    await recordOperationalMetric(env, { portalId, service: 'scan', metric: 'latency_ms', value: Date.now() - startedAt, dimensions: { trigger } });
    throw error;
  }
}
