import { listPolicySegments, type PolicySegment } from './enterprise-policy.js';
import { activePolicy } from './governance.js';
import { dimensionValues, getPolicyDimensionMappings } from './policy-dimensions.js';
import type { Env, NormalizedDeal, RuleSettings } from './types.js';

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function patchRules(base: RuleSettings, override: Partial<RuleSettings>): RuleSettings {
  return {
    ...base,
    ...override,
    excludedPipelineIds: override.excludedPipelineIds ?? base.excludedPipelineIds,
    excludedStageIds: override.excludedStageIds ?? base.excludedStageIds,
    customRequiredProperties: override.customRequiredProperties ?? base.customRequiredProperties,
  };
}

function segmentMatches(
  segment: PolicySegment,
  deal: NormalizedDeal,
  dimensions: { teamId: string; regionCode: string; dealType: string },
): boolean {
  if (!segment.enabled) return false;
  const conditions = segment.conditions;
  const pipelineId = deal.stage?.pipelineId ?? deal.properties.pipeline ?? '';
  const stageId = deal.stage?.id ?? deal.properties.dealstage ?? '';
  const ownerId = deal.properties.hubspot_owner_id ?? '';
  const amount = finite(deal.properties.amount);
  if (conditions.pipelineIds.length > 0 && !conditions.pipelineIds.includes(pipelineId)) return false;
  if (conditions.stageIds.length > 0 && !conditions.stageIds.includes(stageId)) return false;
  if (conditions.ownerIds.length > 0 && !conditions.ownerIds.includes(ownerId)) return false;
  if (conditions.teamIds.length > 0 && !conditions.teamIds.includes(dimensions.teamId)) return false;
  if (conditions.regionCodes.length > 0 && !conditions.regionCodes.includes(dimensions.regionCode)) return false;
  if (conditions.dealTypes.length > 0 && !conditions.dealTypes.includes(dimensions.dealType)) return false;
  if (conditions.minAmount !== null && (amount === null || amount < conditions.minAmount)) return false;
  if (conditions.maxAmount !== null && (amount === null || amount > conditions.maxAmount)) return false;
  return true;
}

export async function resolveSegmentedRulesForDeal(
  env: Env,
  portalId: string,
  base: RuleSettings,
  deal: NormalizedDeal,
): Promise<{ rules: RuleSettings; segmentIds: string[]; policyId: string | null }> {
  const policy = await activePolicy(env, portalId);
  if (!policy) return { rules: base, segmentIds: [], policyId: null };
  const [segments, mappings] = await Promise.all([
    listPolicySegments(env, portalId, policy.id),
    getPolicyDimensionMappings(env, portalId),
  ]);
  const dimensions = dimensionValues(deal.properties, mappings);
  let rules = policy.rules;
  const segmentIds: string[] = [];
  for (const segment of segments) {
    if (!segmentMatches(segment, deal, dimensions)) continue;
    rules = patchRules(rules, segment.rulesOverride);
    segmentIds.push(segment.id);
  }
  return { rules, segmentIds, policyId: policy.id };
}
