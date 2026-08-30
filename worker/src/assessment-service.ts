import { saveAssessmentContext } from './assessment-context.js';
import { recordUsageAtomic } from './billing-usage.js';
import { loadBuyerCommitteeData } from './buyer-committee-data.js';
import { buildBuyerCommittee } from './buyer-committee.js';
import type { BuyerCommitteeIntelligence } from './buyer-committee-types.js';
import { buildDealBrief } from './deal-brief.js';
import type { DealBriefIntelligence } from './deal-brief-types.js';
import { loadDealHistory } from './deal-history.js';
import { buildDealIntelligence, previousDealHistory, type DealIntelligence } from './deal-intelligence.js';
import { buildDealMomentum, type DealMomentumIntelligence } from './deal-momentum.js';
import type { DecisionAction } from './deal-momentum-types.js';
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
import type { DealAssessment, Env, NormalizedDeal, RuleSettings } from './types.js';

const ENRICHMENT_CACHE_TTL_MS = 60_000;
const ENRICHMENT_CACHE_MAX = 500;
const enrichmentCache = new Map<string, { expiresAt: number; value: Record<string, unknown> }>();
const enrichmentInFlight = new Map<string, Promise<Record<string, unknown> | null>>();

type CompleteIntelligence = DealIntelligence
  & Partial<DealMomentumIntelligence>
  & Partial<BuyerCommitteeIntelligence>
  & DealBriefIntelligence;

function cacheKey(portalId: string, dealId: string): string {
  return `${portalId}:${dealId}`;
}

function putCache(key: string, value: Record<string, unknown>): void {
  if (enrichmentCache.size >= ENRICHMENT_CACHE_MAX) {
    const oldest = enrichmentCache.keys().next().value as string | undefined;
    if (oldest) enrichmentCache.delete(oldest);
  }
  enrichmentCache.set(key, { expiresAt: Date.now() + ENRICHMENT_CACHE_TTL_MS, value });
}

async function recordOptionalMetric(
  env: Env,
  portalId: string,
  service: 'deal_history_enrichment' | 'buyer_committee_enrichment',
  metric: string,
  value: number,
): Promise<void> {
  await recordOperationalMetric(env, {
    portalId,
    service,
    metric,
    value,
  }).catch(() => undefined);
}

async function optionalMomentumIntelligence(
  env: Env,
  portalId: string,
  dealId: string,
  client: HubSpotClient,
  deal: NormalizedDeal,
  settings: RuleSettings,
  assessment: DealAssessment,
): Promise<DealMomentumIntelligence | null> {
  const startedAt = Date.now();
  try {
    const history = await loadDealHistory(client, dealId);
    const intelligence = buildDealMomentum(deal, settings, assessment, history);
    await recordOptionalMetric(env, portalId, 'deal_history_enrichment', 'success', 1);
    await recordOptionalMetric(env, portalId, 'deal_history_enrichment', 'latency_ms', Date.now() - startedAt);
    return intelligence;
  } catch (error) {
    console.error(JSON.stringify({
      level: 'warn',
      task: 'deal_history_enrichment',
      portalId,
      dealId,
      error: error instanceof Error ? error.message : String(error),
    }));
    await recordOptionalMetric(env, portalId, 'deal_history_enrichment', 'success', 0);
    await recordOptionalMetric(env, portalId, 'deal_history_enrichment', 'latency_ms', Date.now() - startedAt);
    return null;
  }
}

async function optionalBuyerCommitteeIntelligence(
  env: Env,
  portalId: string,
  dealId: string,
  client: HubSpotClient,
): Promise<BuyerCommitteeIntelligence | null> {
  const startedAt = Date.now();
  try {
    const evidence = await loadBuyerCommitteeData(client, dealId);
    const intelligence = buildBuyerCommittee(evidence);
    await recordOptionalMetric(env, portalId, 'buyer_committee_enrichment', 'success', 1);
    await recordOptionalMetric(env, portalId, 'buyer_committee_enrichment', 'latency_ms', Date.now() - startedAt);
    return intelligence;
  } catch (error) {
    console.error(JSON.stringify({
      level: 'warn',
      task: 'buyer_committee_enrichment',
      portalId,
      dealId,
      error: error instanceof Error ? error.message : String(error),
    }));
    await recordOptionalMetric(env, portalId, 'buyer_committee_enrichment', 'success', 0);
    await recordOptionalMetric(env, portalId, 'buyer_committee_enrichment', 'latency_ms', Date.now() - startedAt);
    return null;
  }
}

function combineDecisionActions(
  momentum: DealMomentumIntelligence | null,
  relationship: BuyerCommitteeIntelligence | null,
): DecisionAction[] {
  const order = { high: 0, medium: 1, low: 2 } as const;
  const combined: DecisionAction[] = [
    ...(relationship?.relationshipActions ?? []),
    ...(momentum?.decisionActions ?? []),
  ];
  const seen = new Set<string>();
  return combined
    .filter((item) => {
      if (seen.has(item.code)) return false;
      seen.add(item.code);
      return true;
    })
    .sort((left, right) => order[left.priority] - order[right.priority])
    .slice(0, 8);
}

function completeIntelligence(
  assessment: DealAssessment,
  readiness: DealIntelligence,
  momentum: DealMomentumIntelligence | null,
  relationship: BuyerCommitteeIntelligence | null,
): CompleteIntelligence {
  const decisionActions = combineDecisionActions(momentum, relationship);
  return {
    ...readiness,
    ...(momentum ?? {}),
    ...(relationship ?? {}),
    decisionActions,
    ...buildDealBrief({
      assessment,
      readiness,
      momentum,
      relationship,
      decisionActions,
    }),
  };
}

async function readinessIntelligence(
  env: Env,
  portalId: string,
  dealId: string,
  deal: NormalizedDeal,
  settings: RuleSettings,
  assessment: DealAssessment,
): Promise<DealIntelligence> {
  const history = await previousDealHistory(env, portalId, dealId, assessment.assessedAt);
  const intelligence = buildDealIntelligence(deal, settings, assessment, history);
  if (history?.stageAgeDays !== null && history?.stageAgeDays !== undefined) {
    const current = await env.DB.prepare(
      `SELECT stage_age_days FROM assessment_history
       WHERE portal_id = ? AND deal_id = ? AND assessed_at = ? LIMIT 1`,
    ).bind(portalId, dealId, assessment.assessedAt).first<{ stage_age_days: number | null }>();
    if (current?.stage_age_days !== null && current?.stage_age_days !== undefined) {
      intelligence.change.stageAgeDeltaDays = Number(current.stage_age_days) - history.stageAgeDays;
    }
  }
  return intelligence;
}

async function buildStoredAssessmentEnrichment(
  env: Env,
  portalId: string,
  dealId: string,
  key: string,
): Promise<Record<string, unknown> | null> {
  const repository = new Repository(env);
  const stored = await repository.getAssessment(portalId, dealId);
  if (!stored) return null;
  const assessedAt = Date.parse(stored.assessedAt);
  if (!Number.isFinite(assessedAt) || Date.now() - assessedAt >= 15 * 60_000) return null;

  const client = await HubSpotClient.forPortal(env, portalId);
  const dimensionProperties = await policyDimensionPropertyNames(env, portalId);
  const deal = await client.getDeal(dealId, undefined, dimensionProperties);
  const policy = await resolveSegmentedRulesForDeal(env, portalId, client.settings.rules, deal);
  const readiness = await readinessIntelligence(env, portalId, dealId, deal, policy.rules, stored);
  const [momentum, relationship] = await Promise.all([
    optionalMomentumIntelligence(env, portalId, dealId, client, deal, policy.rules, stored),
    optionalBuyerCommitteeIntelligence(env, portalId, dealId, client),
  ]);
  const intelligence = completeIntelligence(stored, readiness, momentum, relationship);
  const value = {
    ...(stored as unknown as Record<string, unknown>),
    intelligence,
    policy: { id: policy.policyId, segmentIds: policy.segmentIds },
  };
  putCache(key, value);
  return value;
}

export async function enrichStoredAssessmentForPortal(
  env: Env,
  portalId: string,
  dealId: string,
): Promise<Record<string, unknown> | null> {
  const key = cacheKey(portalId, dealId);
  const cachedResult = enrichmentCache.get(key);
  if (cachedResult && cachedResult.expiresAt > Date.now()) return cachedResult.value;
  if (cachedResult) enrichmentCache.delete(key);
  const pending = enrichmentInFlight.get(key);
  if (pending) return pending;

  const task = buildStoredAssessmentEnrichment(env, portalId, dealId, key);
  enrichmentInFlight.set(key, task);
  try {
    return await task;
  } finally {
    if (enrichmentInFlight.get(key) === task) enrichmentInFlight.delete(key);
  }
}

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
  const readiness = await readinessIntelligence(env, portalId, dealId, deal, policy.rules, assessment);
  let momentum: DealMomentumIntelligence | null = null;
  let relationship: BuyerCommitteeIntelligence | null = null;
  if (trigger === 'record') {
    [momentum, relationship] = await Promise.all([
      optionalMomentumIntelligence(env, portalId, dealId, client, deal, policy.rules, assessment),
      optionalBuyerCommitteeIntelligence(env, portalId, dealId, client),
    ]);
  }
  const intelligence = completeIntelligence(assessment, readiness, momentum, relationship);

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
  if (!stored) return null;
  const value = {
    ...(stored as unknown as Record<string, unknown>),
    intelligence,
    policy: { id: policy.policyId, segmentIds: policy.segmentIds },
  };
  putCache(cacheKey(portalId, dealId), value);
  return value;
}
