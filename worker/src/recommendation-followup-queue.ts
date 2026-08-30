import { deliverRecommendationFollowupBatch } from './recommendation-followup-delivery.js';
import type { Env } from './types.js';

const CONFIRMING_TIMEOUT_MS = 5 * 60_000;
const DELIVERING_TIMEOUT_MS = 20 * 60_000;

async function failStaleClaims(env: Env): Promise<void> {
  const now = new Date();
  const updatedAt = now.toISOString();
  const confirmingBefore = new Date(now.getTime() - CONFIRMING_TIMEOUT_MS).toISOString();
  const deliveringBefore = new Date(now.getTime() - DELIVERING_TIMEOUT_MS).toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE recommendation_followup_batches
       SET status = 'failed', failed_count = GREATEST(failed_count, confirmed_count),
           completed_at = ?, updated_at = ?
       WHERE status = 'confirming' AND updated_at::timestamptz < ?::timestamptz`,
    ).bind(updatedAt, updatedAt, confirmingBefore),
    env.DB.prepare(
      `UPDATE recommendation_followup_items item
       SET status = 'failed', last_error = 'Confirmation did not complete; create a new preview.', updated_at = ?
       FROM recommendation_followup_batches batch
       WHERE item.batch_id = batch.id AND item.portal_id = batch.portal_id
         AND batch.status = 'failed' AND batch.completed_at = ?
         AND item.status = 'previewed'`,
    ).bind(updatedAt, updatedAt),
    env.DB.prepare(
      `UPDATE recommendation_followup_batches
       SET status = 'failed', failed_count = GREATEST(failed_count, confirmed_count),
           completed_at = ?, updated_at = ?
       WHERE status = 'delivering' AND updated_at::timestamptz < ?::timestamptz`,
    ).bind(updatedAt, updatedAt, deliveringBefore),
    env.DB.prepare(
      `UPDATE recommendation_followup_items item
       SET status = 'failed', last_error = 'Delivery did not finish; review channel evidence before creating a new preview.', updated_at = ?
       FROM recommendation_followup_batches batch
       WHERE item.batch_id = batch.id AND item.portal_id = batch.portal_id
         AND batch.status = 'failed' AND batch.completed_at = ?
         AND item.status IN ('queued', 'delivering')`,
    ).bind(updatedAt, updatedAt),
  ]);
}

export async function dispatchQueuedRecommendationFollowups(
  env: Env,
  limit = 1,
): Promise<void> {
  await failStaleClaims(env);
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
