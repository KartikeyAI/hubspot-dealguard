import { observeRecommendationDeliveryControls } from './recommendation-delivery-observer.js';
import { evaluateRecommendationDeliverySlos } from './recommendation-delivery-slo-evaluator.js';
import { evaluateRecommendationRoutingPolicies } from './recommendation-routing-policy-runner.js';
import type { Env } from './types.js';

function receiptRetentionAllowed(alias: 'e'): string {
  return `NOT EXISTS (SELECT 1 FROM compliance_settings c WHERE c.portal_id=${alias}.portal_id AND c.legal_hold_enabled=1)
    AND NOT EXISTS (SELECT 1 FROM legal_holds h WHERE h.portal_id=${alias}.portal_id AND h.status='active')`;
}

export async function purgeOperationalReceipts(env: Env): Promise<void> {
  const now = new Date();
  const inboundCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60_000).toISOString();
  const notificationCutoff = new Date(now.getTime() - 365 * 24 * 60 * 60_000).toISOString();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM oauth_states WHERE expires_at < ?`).bind(now.toISOString()),
    env.DB.prepare(`DELETE FROM integration_oauth_states WHERE expires_at < ?`).bind(now.toISOString()),
    env.DB.prepare(`DELETE FROM inbound_events e WHERE created_at < ? AND status = 'processed' AND ${receiptRetentionAllowed('e')}`).bind(inboundCutoff),
    env.DB.prepare(`DELETE FROM hubspot_webhook_inbox e WHERE created_at < ?::timestamptz AND status = 'processed' AND ${receiptRetentionAllowed('e')}`).bind(inboundCutoff),
    env.DB.prepare(`DELETE FROM notification_events e WHERE created_at < ? AND ${receiptRetentionAllowed('e')}`).bind(notificationCutoff),
  ]);
}

export async function runMaintenance(env: Env): Promise<void> {
  await purgeOperationalReceipts(env);
  await evaluateRecommendationRoutingPolicies(env);
  await observeRecommendationDeliveryControls(env);
  await evaluateRecommendationDeliverySlos(env);
}
