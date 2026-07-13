import { HubSpotClient } from './hubspot.js';
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
  const repository = new Repository(env);
  const previous = await repository.getAssessment(portalId, dealId);
  const client = await HubSpotClient.forPortal(env, portalId);
  const assessment = assessDeal(await client.getDeal(dealId), client.settings.rules);
  await repository.saveAssessment(portalId, assessment);
  try {
    await notifyAssessmentTransition(env, portalId, previous, assessment, client.settings, client.plan, trigger, forceSlack);
  } catch (error) {
    if (forceSlack) throw error;
    console.error(JSON.stringify({ level: 'error', task: 'slack_assessment_notification', portalId, dealId, trigger, error: error instanceof Error ? error.message : String(error) }));
  }
  return repository.getAssessment(portalId, dealId);
}
