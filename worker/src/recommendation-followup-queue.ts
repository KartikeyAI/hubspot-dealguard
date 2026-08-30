import { deliverRecommendationFollowupBatch } from './recommendation-followup-delivery.js';
import type { Env } from './types.js';

export async function dispatchQueuedRecommendationFollowups(
  env: Env,
  limit = 1,
): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT id, portal_id
     FROM recommendation_followup_batches
     WHERE status = 'queued'
     ORDER BY confirmed_at ASC NULLS LAST, created_at ASC
     LIMIT ?`,
  ).bind(Math.min(10, Math.max(1, limit))).all<{ id: string; portal_id: string }>();
  for (const row of rows.results ?? []) {
    await deliverRecommendationFollowupBatch(env, row.portal_id, row.id);
  }
}
