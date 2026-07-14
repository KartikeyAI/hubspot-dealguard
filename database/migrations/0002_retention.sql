SET search_path TO dealguard, public;

CREATE INDEX IF NOT EXISTS idx_assessments_handoff ON deal_assessments(portal_id, is_won, handoff_eligible);
CREATE INDEX IF NOT EXISTS idx_handoffs_status ON handoffs(portal_id, status);
