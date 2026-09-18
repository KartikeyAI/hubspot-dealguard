SET search_path TO dealguard, public;

CREATE TABLE portfolio_snapshot_runs (
  id TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL REFERENCES tenants(portal_id) ON DELETE CASCADE,
  snapshot_date DATE NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL,
  deal_count INTEGER NOT NULL CHECK (deal_count BETWEEN 1 AND 10000),
  source_fingerprint TEXT NOT NULL CHECK (source_fingerprint ~ '^[0-9a-f]{64}$'),
  methodology TEXT NOT NULL DEFAULT 'first_successful_daily_capture_v1',
  UNIQUE (portal_id, id),
  UNIQUE (portal_id, snapshot_date),
  CHECK (snapshot_date = (captured_at AT TIME ZONE 'UTC')::date)
);
CREATE INDEX idx_portfolio_snapshot_runs_portal_capture ON portfolio_snapshot_runs(portal_id, captured_at);

CREATE TABLE portfolio_snapshot_items (
  portal_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  deal_id TEXT NOT NULL,
  source_assessment_id TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  pipeline_id TEXT,
  stage_id TEXT,
  owner_id TEXT,
  team_id TEXT,
  region_code TEXT,
  score INTEGER,
  status TEXT NOT NULL,
  is_closed INTEGER NOT NULL CHECK (is_closed IN (0,1)),
  deal_amount DOUBLE PRECISION,
  deal_currency_code TEXT,
  deal_amount_in_company_currency DOUBLE PRECISION,
  PRIMARY KEY (portal_id, run_id, deal_id),
  FOREIGN KEY (portal_id, run_id) REFERENCES portfolio_snapshot_runs(portal_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_portfolio_snapshot_items_portal_deal ON portfolio_snapshot_items(portal_id, deal_id);

-- Immutable through normal UPDATE paths. Explicit retention and erasure may DELETE.
-- This is not a claim of immutability against the database owner/administrator.
CREATE FUNCTION dealguard.reject_snapshot_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, dealguard AS $$
BEGIN
  RAISE EXCEPTION 'Captured portfolio evidence cannot be overwritten' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER portfolio_snapshot_run_sealed BEFORE UPDATE ON portfolio_snapshot_runs
FOR EACH ROW EXECUTE FUNCTION dealguard.reject_snapshot_revision();
CREATE TRIGGER portfolio_snapshot_item_sealed BEFORE UPDATE ON portfolio_snapshot_items
FOR EACH ROW EXECUTE FUNCTION dealguard.reject_snapshot_revision();

CREATE TABLE portfolio_snapshot_schedule (
  portal_id TEXT PRIMARY KEY REFERENCES tenants(portal_id) ON DELETE CASCADE,
  next_attempt_at TIMESTAMPTZ NOT NULL,
  last_attempt_at TIMESTAMPTZ NOT NULL,
  last_result TEXT NOT NULL,
  lease_token TEXT,
  last_capture_at TIMESTAMPTZ
);
CREATE INDEX idx_portfolio_snapshot_schedule_due ON portfolio_snapshot_schedule(next_attempt_at, portal_id);
