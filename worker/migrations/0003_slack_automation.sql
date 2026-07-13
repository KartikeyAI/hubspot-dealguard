PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS integration_oauth_states (
  state_hash TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK(provider IN ('slack')),
  portal_id TEXT NOT NULL,
  user_id TEXT,
  user_email TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_integration_oauth_states_expiry ON integration_oauth_states(expires_at);

CREATE TABLE IF NOT EXISTS slack_connections (
  portal_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  team_name TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  channel_name TEXT NOT NULL,
  webhook_cipher TEXT NOT NULL,
  webhook_iv TEXT NOT NULL,
  access_token_cipher TEXT NOT NULL,
  access_token_iv TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'revoked', 'error')),
  connected_at TEXT NOT NULL,
  connected_by_user_id TEXT,
  connected_by_email TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notification_events (
  id TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL,
  deal_id TEXT,
  kind TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'sent', 'failed', 'suppressed')),
  error_message TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  UNIQUE(portal_id, fingerprint),
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_notification_events_lookup ON notification_events(portal_id, deal_id, kind, created_at DESC);

CREATE TABLE IF NOT EXISTS inbound_events (
  event_key TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('accepted', 'processed', 'failed')),
  occurred_at TEXT NOT NULL,
  processed_at TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_inbound_events_portal_created ON inbound_events(portal_id, created_at DESC);
