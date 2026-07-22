CREATE SCHEMA IF NOT EXISTS dealguard;
SET search_path TO dealguard, public;

CREATE TABLE IF NOT EXISTS tenants (
  portal_id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  account_name TEXT,
  hub_domain TEXT,
  installer_email TEXT,
  access_token_cipher TEXT NOT NULL,
  access_token_iv TEXT NOT NULL,
  refresh_token_cipher TEXT NOT NULL,
  refresh_token_iv TEXT NOT NULL,
  token_expires_at TEXT NOT NULL,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  settings_json TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'growth', 'beta_growth')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disconnected', 'deleted')),
  installed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_scan_at TEXT,
  next_scan_at TEXT NOT NULL,
  last_digest_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_tenants_due_scan ON tenants(status, next_scan_at);

CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY,
  return_to TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oauth_states_expiry ON oauth_states(expires_at);

CREATE TABLE IF NOT EXISTS deal_assessments (
  portal_id TEXT NOT NULL,
  deal_id TEXT NOT NULL,
  deal_name TEXT NOT NULL,
  pipeline_label TEXT NOT NULL,
  stage_label TEXT NOT NULL,
  score INTEGER NOT NULL CHECK(score BETWEEN 0 AND 100),
  grade TEXT NOT NULL CHECK(grade IN ('A', 'B', 'C', 'D', 'F')),
  status TEXT NOT NULL CHECK(status IN ('ready', 'at_risk', 'critical')),
  issues_json TEXT NOT NULL,
  readiness_summary TEXT NOT NULL,
  is_closed INTEGER NOT NULL DEFAULT 0,
  is_won INTEGER NOT NULL DEFAULT 0,
  handoff_eligible INTEGER NOT NULL DEFAULT 0,
  assessed_at TEXT NOT NULL,
  PRIMARY KEY (portal_id, deal_id),
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_assessments_portal_status ON deal_assessments(portal_id, status);
CREATE INDEX IF NOT EXISTS idx_assessments_portal_assessed ON deal_assessments(portal_id, assessed_at);

CREATE TABLE IF NOT EXISTS deal_reviews (
  portal_id TEXT NOT NULL,
  deal_id TEXT NOT NULL,
  reviewed_at TEXT NOT NULL,
  reviewed_by_user_id TEXT,
  reviewed_by_email TEXT,
  PRIMARY KEY (portal_id, deal_id),
  FOREIGN KEY (portal_id, deal_id) REFERENCES deal_assessments(portal_id, deal_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS handoffs (
  portal_id TEXT NOT NULL,
  deal_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'confirmed', 'reopened')),
  confirmed_at TEXT,
  confirmed_by_user_id TEXT,
  confirmed_by_email TEXT,
  summary TEXT,
  PRIMARY KEY (portal_id, deal_id),
  FOREIGN KEY (portal_id, deal_id) REFERENCES deal_assessments(portal_id, deal_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS scan_runs (
  id TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL,
  trigger_type TEXT NOT NULL CHECK(trigger_type IN ('manual', 'scheduled', 'install')),
  status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  scanned_count INTEGER NOT NULL DEFAULT 0,
  ready_count INTEGER NOT NULL DEFAULT 0,
  at_risk_count INTEGER NOT NULL DEFAULT 0,
  critical_count INTEGER NOT NULL DEFAULT 0,
  incomplete_handoffs INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_scan_runs_portal_started ON scan_runs(portal_id, started_at DESC);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL,
  user_id TEXT,
  user_email TEXT,
  action TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_portal_created ON audit_events(portal_id, created_at DESC);
