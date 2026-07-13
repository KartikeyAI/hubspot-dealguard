import type { Env, RequestIdentity } from './types.js';

export async function finalizePortalDeletion(env: Env, identity: RequestIdentity): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM audit_events WHERE portal_id = ?`).bind(identity.portalId),
    env.DB.prepare(
      `UPDATE tenants SET account_name = NULL, hub_domain = NULL, installer_email = NULL,
       access_token_cipher = '', access_token_iv = '', refresh_token_cipher = '', refresh_token_iv = '',
       token_expires_at = '1970-01-01T00:00:00.000Z', scopes_json = '[]', settings_json = '{}',
       last_scan_at = NULL, last_digest_at = NULL, updated_at = ? WHERE portal_id = ?`
    ).bind(now, identity.portalId),
    env.DB.prepare(
      `INSERT INTO audit_events (id, portal_id, user_id, user_email, action, metadata_json, created_at)
       VALUES (?, ?, NULL, NULL, 'data.deleted', '{}', ?)`
    ).bind(crypto.randomUUID(), identity.portalId, now),
  ]);
}
