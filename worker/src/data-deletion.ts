import { sha256Hex } from './crypto.js';
import type { Env, RequestIdentity } from './types.js';

export async function finalizePortalDeletion(env: Env, identity: RequestIdentity): Promise<void> {
  const now = new Date().toISOString();
  const deletionReference = await sha256Hex(`dealguard-deleted:${identity.portalId}`);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM slack_connections WHERE portal_id = ?`).bind(identity.portalId),
    env.DB.prepare(`DELETE FROM integration_oauth_states WHERE portal_id = ?`).bind(identity.portalId),
    env.DB.prepare(`DELETE FROM notification_events WHERE portal_id = ?`).bind(identity.portalId),
    env.DB.prepare(`DELETE FROM inbound_events WHERE portal_id = ?`).bind(identity.portalId),
    env.DB.prepare(`DELETE FROM audit_events WHERE portal_id = ?`).bind(identity.portalId),
    env.DB.prepare(`DELETE FROM tenants WHERE portal_id = ?`).bind(identity.portalId),
    env.DB.prepare(
      `INSERT INTO audit_events (id, portal_id, user_id, user_email, action, metadata_json, created_at)
       VALUES (?, ?, NULL, NULL, 'data.deleted', '{}', ?)`
    ).bind(crypto.randomUUID(), deletionReference, now),
  ]);
}
