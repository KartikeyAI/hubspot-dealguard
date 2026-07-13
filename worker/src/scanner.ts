import { PLAN_LIMITS } from './config.js';
import { HubSpotClient } from './hubspot.js';
import { syncAssessmentBatchIfEnabled } from './native-sync.js';
import { Repository } from './repository.js';
import { assessDeal } from './scoring.js';
import { notifyAssessmentTransition } from './slack.js';
import type { DealAssessment, Env } from './types.js';

export async function scanPortal(
  env: Env,
  portalId: string,
  trigger: 'manual' | 'scheduled' | 'install',
  existingScanId?: string,
) {
  const repository = new Repository(env);
  const client = await HubSpotClient.forPortal(env, portalId);
  const scanId = existingScanId ?? await repository.startScan(portalId, trigger);
  try {
    const deals = await client.listDeals(PLAN_LIMITS[client.plan].maxDealsPerScan);
    const nativeUpdates: Array<{ assessment: DealAssessment; handoffStatus?: string | null }> = [];
    let ready = 0;
    let atRisk = 0;
    let critical = 0;
    let incompleteHandoffs = 0;
    for (const deal of deals) {
      const previous = await repository.getAssessment(portalId, deal.id);
      const assessment = assessDeal(deal, client.settings.rules);
      await repository.saveAssessment(portalId, assessment);
      const stored = await repository.getAssessment(portalId, deal.id);
      nativeUpdates.push({ assessment, handoffStatus: stored?.handoffStatus });
      try {
        await notifyAssessmentTransition(env, portalId, previous, assessment, client.settings, client.plan, trigger);
      } catch (error) {
        console.error(JSON.stringify({ level: 'error', task: 'slack_scan_notification', portalId, dealId: deal.id, error: error instanceof Error ? error.message : String(error) }));
      }
      if (assessment.status === 'ready') ready += 1;
      if (assessment.status === 'at_risk') atRisk += 1;
      if (assessment.status === 'critical') critical += 1;
      if (assessment.isWon && stored?.handoffStatus !== 'confirmed') incompleteHandoffs += 1;
    }
    try {
      await syncAssessmentBatchIfEnabled(env, client, nativeUpdates);
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', task: 'native_scan_sync', portalId, scanId, error: error instanceof Error ? error.message : String(error) }));
    }
    const counts = { scanned: deals.length, ready, atRisk, critical, incompleteHandoffs };
    await repository.completeScan(scanId, portalId, client.plan, counts);
    await repository.audit(portalId, null, null, 'scan.completed', { scanId, trigger, ...counts });
    return { scanId, ...counts };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected scan failure';
    await repository.failScan(scanId, portalId, message);
    throw error;
  }
}
