SET search_path TO dealguard, public;

CREATE TABLE background_intelligence_settings (
  portal_id TEXT PRIMARY KEY REFERENCES tenants(portal_id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  refresh_hours INTEGER NOT NULL DEFAULT 24 CHECK (refresh_hours BETWEEN 1 AND 72),
  daily_request_limit INTEGER NOT NULL DEFAULT 1000 CHECK (daily_request_limit BETWEEN 100 AND 10000),
  version INTEGER NOT NULL DEFAULT 1,
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_run_at TIMESTAMPTZ,
  lease_token TEXT,
  lease_expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by_user_id TEXT,
  updated_by_email TEXT
);
CREATE INDEX idx_background_intelligence_due ON background_intelligence_settings(next_run_at, portal_id)
  WHERE enabled = 1;

CREATE TABLE background_intelligence_jobs (
  portal_id TEXT NOT NULL,
  deal_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','processing','completed','retry','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  last_error_code TEXT,
  assessment_at TEXT,
  snapshot_generated_at TEXT,
  request_count INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  PRIMARY KEY (portal_id, deal_id),
  FOREIGN KEY (portal_id, deal_id) REFERENCES deal_assessments(portal_id, deal_id) ON DELETE CASCADE
);
CREATE INDEX idx_background_intelligence_jobs_due ON background_intelligence_jobs(portal_id, status, available_at);

CREATE TABLE background_intelligence_usage (
  portal_id TEXT NOT NULL REFERENCES tenants(portal_id) ON DELETE CASCADE,
  usage_date DATE NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count BETWEEN 1 AND 10000),
  PRIMARY KEY (portal_id, usage_date)
);
