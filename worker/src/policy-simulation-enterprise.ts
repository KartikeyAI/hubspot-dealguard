import { PLAN_LIMITS } from './config.js';
import { AppError } from './errors.js';
import { createPolicySimulation, getPolicy } from './governance.js';
import { HubSpotClient } from './hubspot.js';
import { policyDimensionPropertyNames } from './policy-dimensions.js';
import { resolvePolicyRulesForDeal, resolveSegmentedRulesForDeal } from './policy-runtime.js';
import { assessDeal } from './scoring.js';
import type { Env, RequestIdentity } from './types.js';

export async function createEnterprisePolicySimulation(
  env: Env,
  identity: RequestIdentity,
  policyId: string,
) {
  return createPolicySimulation(env, identity, policyId);
}

export async function runEnterprisePolicySimulation(
  env: Env,
  portalId: string,
  policyId: string,
  simulationId: string,
): Promise<void> {
  try {
    const policy = await getPolicy(env, portalId, policyId);
    if (!policy) throw new AppError(404, 'policy_not_found', 'The requested policy does not exist.');
    const client = await HubSpotClient.forPortal(env, portalId);
    const limit = PLAN_LIMITS[client.plan].maxPolicySimulationDeals;
    if (limit <= 0) throw new AppError(403, 'enterprise_plan_required', 'Policy simulation requires DealGuard Enterprise.');
    const dimensionProperties = await policyDimensionPropertyNames(env, portalId);
    const deals = await client.listDeals(limit, dimensionProperties);
    let changedDeals = 0;
    let scoreTotal = 0;
    let previousScoreTotal = 0;
    let readyDeals = 0;
    let atRiskDeals = 0;
    let criticalDeals = 0;
    for (const deal of deals) {
      const [previousPolicy, candidatePolicy] = await Promise.all([
        resolveSegmentedRulesForDeal(env, portalId, client.settings.rules, deal),
        resolvePolicyRulesForDeal(env, portalId, policy, deal),
      ]);
      const previous = assessDeal(deal, previousPolicy.rules);
      const projected = assessDeal(deal, candidatePolicy.rules);
      if (previous.score !== projected.score || previous.status !== projected.status) changedDeals += 1;
      scoreTotal += projected.score;
      previousScoreTotal += previous.score;
      if (projected.status === 'ready') readyDeals += 1;
      if (projected.status === 'at_risk') atRiskDeals += 1;
      if (projected.status === 'critical') criticalDeals += 1;
    }
    const completedAt = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE policy_simulations SET status = 'completed', total_deals = ?, changed_deals = ?,
       ready_deals = ?, at_risk_deals = ?, critical_deals = ?, average_score = ?,
       previous_average_score = ?, completed_at = ?, error_message = NULL WHERE id = ? AND portal_id = ?`,
    ).bind(
      deals.length,
      changedDeals,
      readyDeals,
      atRiskDeals,
      criticalDeals,
      deals.length ? Math.round(scoreTotal / deals.length) : 0,
      deals.length ? Math.round(previousScoreTotal / deals.length) : 0,
      completedAt,
      simulationId,
      portalId,
    ).run();
  } catch (error) {
    await env.DB.prepare(
      `UPDATE policy_simulations SET status = 'failed', error_message = ?, completed_at = ?
       WHERE id = ? AND portal_id = ?`,
    ).bind(
      (error instanceof Error ? error.message : String(error)).slice(0, 1000),
      new Date().toISOString(),
      simulationId,
      portalId,
    ).run();
  }
}
