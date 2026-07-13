import type { Env } from './types.js';

export async function runMaintenance(env: Env): Promise<void> {
  const now = new Date();
  const inboundCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60_000).toISOString();
  const notificationCutoff = new Date(now.getTime() - 365 * 24 * 60 * 60_000).toISOString();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM oauth_states WHERE expires_at < ?`).bind(now.toISOString()),
    env.DB.prepare(`DELETE FROM integration_oauth_states WHERE expires_at < ?`).bind(now.toISOString()),
    env.DB.prepare(`DELETE FROM inbound_events WHERE created_at < ?`).bind(inboundCutoff),
    env.DB.prepare(`DELETE FROM notification_events WHERE created_at < ?`).bind(notificationCutoff),
  ]);
}
