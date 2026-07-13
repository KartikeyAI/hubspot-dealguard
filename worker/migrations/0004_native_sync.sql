PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS native_sync_state (
  portal_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'not_provisioned' CHECK(status IN ('not_provisioned', 'provisioning', 'ready', 'backfilling', 'error')),
  property_version INTEGER NOT NULL DEFAULT 0,
  provisioned_at TEXT,
  last_backfill_at TEXT,
  last_backfill_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_native_sync_status ON native_sync_state(status, updated_at);
