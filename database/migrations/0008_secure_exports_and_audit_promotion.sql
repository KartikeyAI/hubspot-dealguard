PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS secure_download_tokens (
  token_hash TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('policy', 'analytics', 'audit', 'data_export')),
  resource_id TEXT,
  format TEXT,
  params_json TEXT NOT NULL DEFAULT '{}',
  requested_by_user_id TEXT,
  requested_by_email TEXT,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_secure_download_expiry ON secure_download_tokens(expires_at, used_at);

CREATE TABLE IF NOT EXISTS legacy_audit_promotions (
  legacy_event_id TEXT PRIMARY KEY,
  immutable_event_id TEXT NOT NULL,
  promoted_at TEXT NOT NULL
);
