SET search_path TO dealguard, public;

CREATE TABLE IF NOT EXISTS executive_revenue_snapshots (
  portal_id TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,
  deal_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  pipeline_id TEXT,
  pipeline_label TEXT,
  stage_id TEXT,
  stage_label TEXT,
  owner_id TEXT,
  team_id TEXT,
  region_code TEXT,
  amount NUMERIC,
  currency_code TEXT CHECK (currency_code IS NULL OR currency_code ~ '^[A-Z]{3}$'),
  amount_in_company_currency NUMERIC,
  close_date TEXT,
  forecast_category TEXT,
  readiness_score INTEGER CHECK (readiness_score IS NULL OR readiness_score BETWEEN 0 AND 100),
  readiness_status TEXT CHECK (readiness_status IS NULL OR readiness_status IN ('ready', 'at_risk', 'critical')),
  assessment_at TEXT,
  decision_status TEXT CHECK (
    decision_status IS NULL OR decision_status IN ('on_track', 'watch', 'intervention_required', 'insufficient_evidence')
  ),
  decision_attention_score INTEGER CHECK (
    decision_attention_score IS NULL OR decision_attention_score BETWEEN 0 AND 100
  ),
  decision_confidence TEXT CHECK (
    decision_confidence IS NULL OR decision_confidence IN ('high', 'medium', 'low')
  ),
  decision_coverage_percent INTEGER CHECK (
    decision_coverage_percent IS NULL OR decision_coverage_percent BETWEEN 0 AND 100
  ),
  decision_generated_at TEXT,
  is_closed INTEGER NOT NULL DEFAULT 0,
  is_won INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (portal_id, snapshot_date, deal_id),
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_executive_revenue_snapshots_period
  ON executive_revenue_snapshots(portal_id, close_date, forecast_category, snapshot_date DESC);

CREATE INDEX IF NOT EXISTS idx_executive_revenue_snapshots_movement
  ON executive_revenue_snapshots(portal_id, deal_id, snapshot_date DESC, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_executive_revenue_snapshots_concentration
  ON executive_revenue_snapshots(portal_id, snapshot_date DESC, owner_id, pipeline_id, region_code);
