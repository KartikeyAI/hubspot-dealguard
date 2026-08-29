SET search_path TO dealguard, public;

-- Keep native deal amounts only for per-deal or same-currency views. Cross-deal totals
-- must use HubSpot's amount_in_home_currency value so mixed currencies are never summed.
ALTER TABLE assessment_history
  ADD COLUMN deal_currency_code TEXT
  CHECK (deal_currency_code IS NULL OR deal_currency_code ~ '^[A-Z]{3}$');

ALTER TABLE assessment_history
  ADD COLUMN deal_amount_in_company_currency NUMERIC;

CREATE INDEX idx_assessment_history_portal_currency_time
  ON assessment_history(portal_id, deal_currency_code, assessed_at DESC);
