PRAGMA foreign_keys = ON;

ALTER TABLE tenants ADD COLUMN commercial_tier TEXT NOT NULL DEFAULT 'free';
ALTER TABLE tenants ADD COLUMN trial_ends_at TEXT;

UPDATE tenants
SET commercial_tier = CASE
  WHEN plan = 'beta_growth' THEN 'enterprise'
  WHEN plan = 'growth' THEN 'growth'
  ELSE 'free'
END;

CREATE TABLE IF NOT EXISTS subscriptions (
  portal_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'stripe' CHECK(provider IN ('stripe', 'manual')),
  provider_customer_id TEXT,
  provider_subscription_id TEXT,
  tier TEXT NOT NULL CHECK(tier IN ('free', 'growth', 'enterprise')),
  status TEXT NOT NULL CHECK(status IN ('trialing', 'active', 'past_due', 'unpaid', 'canceled', 'incomplete', 'paused', 'manual')),
  billing_interval TEXT CHECK(billing_interval IN ('month', 'year')),
  current_period_end TEXT,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  trial_ends_at TEXT,
  grace_ends_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_customer ON subscriptions(provider, provider_customer_id) WHERE provider_customer_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_subscription ON subscriptions(provider, provider_subscription_id) WHERE provider_subscription_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS billing_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('received', 'processed', 'failed', 'ignored')),
  payload_hash TEXT NOT NULL,
  error_message TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  UNIQUE(provider, provider_event_id)
);
CREATE INDEX IF NOT EXISTS idx_billing_events_status ON billing_events(status, received_at);

CREATE TABLE IF NOT EXISTS remediation_cases (
  id TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL,
  deal_id TEXT NOT NULL,
  issue_code TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('info', 'warning', 'critical')),
  status TEXT NOT NULL CHECK(status IN ('open', 'acknowledged', 'in_progress', 'resolved', 'waived', 'overdue', 'closed')),
  priority TEXT NOT NULL CHECK(priority IN ('low', 'medium', 'high', 'urgent')),
  owner_id TEXT,
  owner_email TEXT,
  due_at TEXT,
  source TEXT NOT NULL CHECK(source IN ('manual', 'assessment', 'workflow', 'escalation')),
  hubspot_task_id TEXT,
  resolution_note TEXT,
  created_by_user_id TEXT,
  created_by_email TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  acknowledged_at TEXT,
  resolved_at TEXT,
  last_escalated_at TEXT,
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_remediation_cases_queue ON remediation_cases(portal_id, status, due_at, severity);
CREATE INDEX IF NOT EXISTS idx_remediation_cases_deal ON remediation_cases(portal_id, deal_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_remediation_open_issue ON remediation_cases(portal_id, deal_id, issue_code) WHERE status IN ('open', 'acknowledged', 'in_progress', 'overdue');

CREATE TABLE IF NOT EXISTS remediation_events (
  id TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_user_id TEXT,
  actor_email TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE,
  FOREIGN KEY (case_id) REFERENCES remediation_cases(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_remediation_events_case ON remediation_events(case_id, created_at DESC);

CREATE TABLE IF NOT EXISTS notification_destinations (
  id TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('teams_workflow', 'webhook', 'email')),
  name TEXT NOT NULL,
  endpoint_cipher TEXT,
  endpoint_iv TEXT,
  signing_secret_cipher TEXT,
  signing_secret_iv TEXT,
  config_json TEXT NOT NULL DEFAULT '{}',
  event_types_json TEXT NOT NULL DEFAULT '[]',
  minimum_severity TEXT NOT NULL DEFAULT 'info' CHECK(minimum_severity IN ('info', 'warning', 'critical')),
  pipeline_ids_json TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by_user_id TEXT,
  created_by_email TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_notification_destinations_portal ON notification_destinations(portal_id, enabled, type);

CREATE TABLE IF NOT EXISTS outbox_events (
  id TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info' CHECK(severity IN ('info', 'warning', 'critical')),
  pipeline_id TEXT,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'delivered', 'failed', 'dead_letter')),
  available_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_outbox_dispatch ON outbox_events(status, available_at, created_at);
CREATE INDEX IF NOT EXISTS idx_outbox_portal ON outbox_events(portal_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS outbox_deliveries (
  id TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL,
  outbox_event_id TEXT NOT NULL,
  destination_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('delivered', 'failed', 'skipped')),
  http_status INTEGER,
  error_message TEXT,
  attempted_at TEXT NOT NULL,
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE,
  FOREIGN KEY (outbox_event_id) REFERENCES outbox_events(id) ON DELETE CASCADE,
  FOREIGN KEY (destination_id) REFERENCES notification_destinations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_outbox_deliveries_event ON outbox_deliveries(outbox_event_id, attempted_at DESC);

CREATE TABLE IF NOT EXISTS service_health (
  portal_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'healthy' CHECK(status IN ('healthy', 'degraded', 'failing')),
  last_scan_success_at TEXT,
  last_webhook_success_at TEXT,
  last_delivery_success_at TEXT,
  last_failure_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE
);
