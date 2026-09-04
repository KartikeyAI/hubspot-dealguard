import { wakeDeliveryQueue } from './queue-publisher.js';
import { confirmRecommendationFollowup } from './recommendation-operations.js';
import type { RecommendationFollowupBatchView } from './recommendation-operations-types.js';
import type { Env, RequestIdentity } from './types.js';

export async function confirmQueuedRecommendationFollowup(
  env: Env,
  identity: RequestIdentity,
  batchId: string,
): Promise<RecommendationFollowupBatchView> {
  const result = await confirmRecommendationFollowup(env, identity, batchId, {
    waitUntil: () => undefined,
  });
  if (result.status === 'queued') {
    await wakeDeliveryQueue(env, 'outbox');
  }
  return result;
}
