SET search_path TO dealguard, public;

-- Dispatch reservations are separate from execution leases: lost queue deliveries
-- recover without allowing two workers to spend one portal's budget concurrently.
ALTER TABLE background_intelligence_settings
  ADD COLUMN dispatch_token TEXT,
  ADD COLUMN dispatch_expires_at TIMESTAMPTZ,
  ADD COLUMN last_run_error TEXT CHECK (length(last_run_error) <= 100);
ALTER TABLE assessment_context ADD COLUMN close_date TIMESTAMPTZ;
CREATE INDEX idx_background_dispatch_due ON background_intelligence_settings(next_run_at, portal_id)
  WHERE enabled = 1;
