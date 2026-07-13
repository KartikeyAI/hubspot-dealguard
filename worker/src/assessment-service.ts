import { saveAssessmentContext } from './assessment-context.js';
import { recordUsageAtomic } from './billing-usage.js';
import { recordAssessmentHistory } from './enterprise-analytics-v2.js';
import { HubSpotClient } from './hubspot.js';
import { syncAssessmentIfEnabled } from './native-sync.js';
import { policyDimensionPropertyNames } from './policy-dimensions.js';
import { resolveSegmentedRulesForDeal } from './policy-runtime.js';
import { syncAssessmentRemediations } from './remediation.js';
import { recordOperationalMetric } from './reliability.js';
import { Repository } from './repository.js';
import { assessDeal } from './scoring.js';
import { notifyAssessmentTransition } from './slack.js';
import type { Env } from './types.js';

export async function assessDealForPortal(
  env: Env,
  portalId: string,
  dealId: string,
  trigger: 'record' | 'webhook' | 'workflow',
  forceSlack = false,
) {
  const startedAt = Date.now();
  const repository = new Repository(env);
  const previous = await repository.getAssessment(portalId, dealId);
  const client = await HubSpotClient.forPortal(env, portalId);
  const dimensionProperties = await policyDimensionPropertyNames(env, portalId);
  const deal = await client.getDeal(dealId, undefined, dimensionProperties);
  const policy = await resolveSegmentedRulesForDeal(env, portalId, client.settings.rules, deal);
  const assessment = assessDeal(deal, policy.rules);
  await repository.saveAssessment(portalId, assessment);
  await saveAssessmentContext(env, portalId, assessment);
  await recordAssessmentHistory(env, portalId, assessment, {
    trigger,
    properties: deal.properties,
    policyId: policy.policyId,
  });
  const stored = await repository.getAssessment(portalId, dealId);
  try {
    await notifyAssessmentTransition(env, portalId, previous, assessment, client.settings, client.plan, trigger, forceSlack);
  } catch (error) {
    if (forceSlack) throw error;
    console.error(JSON.stringify({ level: 'error', task: 'slack_assessment_notification', portalId, dealId, trigger, error: error instanceof Error ? error.message : String(error) }));
  }
  try {
    await syncAssessmentIfEnabled(env, client, assessment, stored?.handoffStatus);
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', task: 'native_assessment_sync', portalId, dealId, trigger, error: error instanceof Error ? error.message : String(error) }));
  }
  try {
    await syncAssessmentRemediations(env, portalId, assessment);
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', task: 'remediation_assessment_sync', portalId, dealId, trigger, error: error instanceof Error ? error.message : String(error) }));
  }
  try {
    await recordUsageAtomic(env, portalId, 'event_overage', 1, `assessment:${trigger}:${dealId}:${assessment.assessedAt}`, {
      trigger,
      deal_id: dealId,
      policy_id: policy.policyId,
      segment_count: policy.segmentIds.length,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('allowance has been exhausted')) throw error;
    console.error(JSON.stringify({ level: 'error', task: 'assessment_usage', portalId, dealId, trigger, error: error instanceof Error ? error.message : String(error) }));
  }
  await recordOperationalMetric(env, { portalId, service: `assessment.${trigger}`, metric: 'success', value: 1 });
  await recordOperationalMetric(env, { portalId, service: `assessment.${trigger}`, metric: 'latency_ms', value: Date.now() - startedAt });
  return stored;
}
