SET search_path TO dealguard, public;

CREATE TABLE IF NOT EXISTS governance_roles (
  id TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL,
  user_id TEXT,
  user_email TEXT,
  role TEXT NOT NULL CHECK(role IN ('admin', 'policy_admin', 'approver', 'manager', 'viewer')),
  scope_json TEXT NOT NULL DEFAULT '{}',
  created_by_user_id TEXT,
  created_by_email TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(portal_id, user_id),
  UNIQUE(portal_id, user_email),
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_governance_roles_portal ON governance_roles(portal_id, role);

CREATE TABLE IF NOT EXISTS policy_versions (
  id TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('draft', 'pending_approval', 'approved', 'published', 'superseded', 'rejected')),
  rules_json TEXT NOT NULL,
  checksum TEXT NOT NULL,
  change_summary TEXT NOT NULL DEFAULT '',
  based_on_policy_id TEXT,
  created_by_user_id TEXT,
  created_by_email TEXT,
  submitted_at TEXT,
  approved_at TEXT,
  approved_by_user_id TEXT,
  approved_by_email TEXT,
  published_at TEXT,
  published_by_user_id TEXT,
  published_by_email TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(portal_id, version_number),
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE,
  FOREIGN KEY (based_on_policy_id) REFERENCES policy_versions(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_policy_versions_portal_status ON policy_versions(portal_id, status, version_number DESC);

CREATE TABLE IF NOT EXISTS policy_approvals (
  id TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('approved', 'rejected')),
  comment TEXT NOT NULL DEFAULT '',
  actor_user_id TEXT,
  actor_email TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE,
  FOREIGN KEY (policy_id) REFERENCES policy_versions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_policy_approvals_policy ON policy_approvals(policy_id, created_at DESC);

CREATE TABLE IF NOT EXISTS policy_simulations (
  id TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed')),
  total_deals INTEGER NOT NULL DEFAULT 0,
  changed_deals INTEGER NOT NULL DEFAULT 0,
  ready_deals INTEGER NOT NULL DEFAULT 0,
  at_risk_deals INTEGER NOT NULL DEFAULT 0,
  critical_deals INTEGER NOT NULL DEFAULT 0,
  average_score INTEGER NOT NULL DEFAULT 0,
  previous_average_score INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  requested_by_user_id TEXT,
  requested_by_email TEXT,
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE,
  FOREIGN KEY (policy_id) REFERENCES policy_versions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_policy_simulations_policy ON policy_simulations(policy_id, started_at DESC);

CREATE TABLE IF NOT EXISTS policy_exceptions (
  id TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL,
  deal_id TEXT NOT NULL,
  issue_code TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected', 'expired', 'revoked')),
  expires_at TEXT,
  requested_by_user_id TEXT,
  requested_by_email TEXT,
  decided_by_user_id TEXT,
  decided_by_email TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(portal_id, deal_id, issue_code, status),
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_policy_exceptions_portal_status ON policy_exceptions(portal_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS assessment_context (
  portal_id TEXT NOT NULL,
  deal_id TEXT NOT NULL,
  deal_amount DOUBLE PRECISION,
  owner_id TEXT,
  pipeline_id TEXT NOT NULL DEFAULT '',
  stage_id TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (portal_id, deal_id),
  FOREIGN KEY (portal_id, deal_id) REFERENCES deal_assessments(portal_id, deal_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_assessment_context_owner ON assessment_context(portal_id, owner_id);
CREATE INDEX IF NOT EXISTS idx_assessment_context_pipeline ON assessment_context(portal_id, pipeline_id);

CREATE TABLE IF NOT EXISTS analytics_snapshots (
  portal_id TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,
  total_deals INTEGER NOT NULL,
  ready_deals INTEGER NOT NULL,
  at_risk_deals INTEGER NOT NULL,
  critical_deals INTEGER NOT NULL,
  average_score INTEGER NOT NULL,
  total_pipeline_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
  amount_at_risk DOUBLE PRECISION NOT NULL DEFAULT 0,
  incomplete_handoffs INTEGER NOT NULL DEFAULT 0,
  policy_id TEXT,
  captured_at TEXT NOT NULL,
  PRIMARY KEY (portal_id, snapshot_date),
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE,
  FOREIGN KEY (policy_id) REFERENCES policy_versions(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_analytics_snapshots_portal_date ON analytics_snapshots(portal_id, snapshot_date DESC);
