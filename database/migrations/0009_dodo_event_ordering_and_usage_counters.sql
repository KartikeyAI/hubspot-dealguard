PRAGMA foreign_keys = ON;

ALTER TABLE subscriptions_v2 ADD COLUMN provider_event_at TEXT;
ALTER TABLE subscriptions_v2 ADD COLUMN last_provider_event_id TEXT;
ALTER TABLE subscriptions_v2 ADD COLUMN last_provider_event_type TEXT;
ALTER TABLE billing_events ADD COLUMN event_occurred_at TEXT;

CREATE TABLE IF NOT EXISTS billing_usage_counters (
  portal_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  period_start TEXT NOT NULL,
  consumed_quantity REAL NOT NULL DEFAULT 0 CHECK(consumed_quantity >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (portal_id, metric, period_start),
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_billing_usage_counters_portal
  ON billing_usage_counters(portal_id, period_start, metric);
