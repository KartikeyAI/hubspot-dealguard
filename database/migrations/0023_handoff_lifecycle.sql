SET search_path TO dealguard, public;

-- Start clocks are first observed closed-won times, never fabricated CRM close dates.
ALTER TABLE handoffs ADD COLUMN cycle_number INTEGER NOT NULL DEFAULT 0;
ALTER TABLE handoffs ADD COLUMN active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1));
ALTER TABLE handoffs ADD COLUMN started_at TEXT;
ALTER TABLE handoffs ADD COLUMN start_basis TEXT NOT NULL DEFAULT 'legacy_unknown'
  CHECK (start_basis IN ('legacy_unknown', 'observed_closed_won'));
ALTER TABLE handoffs ADD COLUMN last_observed_at TEXT;

CREATE TABLE handoff_cycles (
  portal_id TEXT NOT NULL,
  deal_id TEXT NOT NULL,
  cycle_number INTEGER NOT NULL CHECK (cycle_number > 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'cancelled')),
  started_at TEXT,
  start_basis TEXT NOT NULL CHECK (start_basis IN ('legacy_unknown', 'observed_closed_won')),
  confirmed_at TEXT,
  confirmed_by_user_id TEXT,
  confirmed_by_email TEXT,
  ended_at TEXT,
  end_reason TEXT CHECK (end_reason IN ('deal_reopened', 'no_longer_won', 'legacy_inactive')),
  last_observed_at TEXT NOT NULL,
  PRIMARY KEY (portal_id, deal_id, cycle_number),
  FOREIGN KEY (portal_id, deal_id) REFERENCES deal_assessments(portal_id, deal_id) ON DELETE CASCADE,
  CHECK ((start_basis = 'legacy_unknown' AND started_at IS NULL)
    OR (start_basis = 'observed_closed_won' AND started_at IS NOT NULL)),
  CHECK (status <> 'confirmed' OR confirmed_at IS NOT NULL)
);
CREATE INDEX idx_handoff_cycles_portal_confirmed ON handoff_cycles(portal_id, confirmed_at)
  WHERE status = 'confirmed';

-- Establish a legacy baseline without guessing when an existing handoff started.
INSERT INTO handoffs (portal_id, deal_id, status)
  SELECT portal_id, deal_id, 'pending' FROM deal_assessments
  WHERE is_closed = 1 AND is_won = 1
ON CONFLICT (portal_id, deal_id) DO NOTHING;
UPDATE handoffs h SET cycle_number = 1,
  active = CASE WHEN a.is_closed = 1 AND a.is_won = 1 THEN 1 ELSE 0 END,
  last_observed_at = a.assessed_at
FROM deal_assessments a WHERE a.portal_id = h.portal_id AND a.deal_id = h.deal_id;
INSERT INTO handoff_cycles (portal_id, deal_id, cycle_number, status, start_basis,
  confirmed_at, confirmed_by_user_id, confirmed_by_email, end_reason, last_observed_at)
SELECT portal_id, deal_id, cycle_number,
  CASE WHEN status = 'confirmed' AND confirmed_at IS NOT NULL THEN 'confirmed'
    WHEN active = 1 THEN 'pending' ELSE 'cancelled' END,
  'legacy_unknown', confirmed_at, confirmed_by_user_id, confirmed_by_email,
  CASE WHEN active = 0 THEN 'legacy_inactive' ELSE NULL END, last_observed_at
FROM handoffs;
UPDATE handoffs SET status = 'pending'
WHERE active = 1 AND status = 'confirmed' AND confirmed_at IS NULL;
UPDATE handoffs SET status = 'reopened', confirmed_at = NULL,
  confirmed_by_user_id = NULL, confirmed_by_email = NULL WHERE active = 0;

CREATE FUNCTION dealguard.guard_assessment_order() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, dealguard AS $$
BEGIN
  IF NEW.assessed_at !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$'
     OR NOT pg_input_is_valid(NEW.assessed_at, 'timestamp with time zone')
     OR NEW.assessed_at::timestamptz > clock_timestamp() THEN
    RAISE EXCEPTION 'Invalid assessment observation time' USING ERRCODE = '22007';
  END IF;
  IF NEW.is_closed NOT IN (0,1) OR NEW.is_won NOT IN (0,1)
     OR (NEW.is_won = 1 AND NEW.is_closed <> 1) THEN
    RAISE EXCEPTION 'Invalid assessment lifecycle' USING ERRCODE = '22023';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NOT pg_input_is_valid(OLD.assessed_at, 'timestamp with time zone') THEN
      RAISE EXCEPTION 'Existing assessment time requires repair' USING ERRCODE = '22007';
    END IF;
    IF NEW.assessed_at::timestamptz <= OLD.assessed_at::timestamptz THEN RETURN NULL; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER assessment_monotonic_write BEFORE INSERT OR UPDATE ON deal_assessments
FOR EACH ROW EXECUTE FUNCTION dealguard.guard_assessment_order();

CREATE FUNCTION dealguard.advance_handoff_cycle() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, dealguard AS $$
DECLARE current_handoff dealguard.handoffs%ROWTYPE; next_cycle INTEGER;
BEGIN
  SELECT * INTO current_handoff FROM dealguard.handoffs
    WHERE portal_id = NEW.portal_id AND deal_id = NEW.deal_id FOR UPDATE;
  IF NEW.is_closed = 1 AND NEW.is_won = 1 THEN
    IF FOUND AND current_handoff.active = 1 THEN
      UPDATE dealguard.handoffs SET last_observed_at = NEW.assessed_at
        WHERE portal_id = NEW.portal_id AND deal_id = NEW.deal_id;
      UPDATE dealguard.handoff_cycles SET last_observed_at = NEW.assessed_at
        WHERE portal_id = NEW.portal_id AND deal_id = NEW.deal_id
          AND cycle_number = current_handoff.cycle_number;
    ELSE
      next_cycle := COALESCE(current_handoff.cycle_number, 0) + 1;
      INSERT INTO dealguard.handoff_cycles (portal_id, deal_id, cycle_number, status,
        started_at, start_basis, last_observed_at)
      VALUES (NEW.portal_id, NEW.deal_id, next_cycle, 'pending', NEW.assessed_at,
        'observed_closed_won', NEW.assessed_at);
      INSERT INTO dealguard.handoffs (portal_id, deal_id, status, cycle_number, active,
        started_at, start_basis, last_observed_at)
      VALUES (NEW.portal_id, NEW.deal_id, 'pending', next_cycle, 1,
        NEW.assessed_at, 'observed_closed_won', NEW.assessed_at)
      ON CONFLICT (portal_id, deal_id) DO UPDATE SET status = 'pending',
        cycle_number = excluded.cycle_number, active = 1, started_at = excluded.started_at,
        start_basis = excluded.start_basis, last_observed_at = excluded.last_observed_at,
        confirmed_at = NULL, confirmed_by_user_id = NULL, confirmed_by_email = NULL, summary = NULL;
    END IF;
  ELSIF FOUND AND current_handoff.active = 1 THEN
    UPDATE dealguard.handoff_cycles SET
      status = CASE WHEN status = 'confirmed' THEN 'confirmed' ELSE 'cancelled' END,
      ended_at = NEW.assessed_at,
      end_reason = CASE WHEN NEW.is_closed = 0 THEN 'deal_reopened' ELSE 'no_longer_won' END,
      last_observed_at = NEW.assessed_at
    WHERE portal_id = NEW.portal_id AND deal_id = NEW.deal_id
      AND cycle_number = current_handoff.cycle_number;
    UPDATE dealguard.handoffs SET active = 0, status = 'reopened',
      last_observed_at = NEW.assessed_at, confirmed_at = NULL,
      confirmed_by_user_id = NULL, confirmed_by_email = NULL, summary = NULL
    WHERE portal_id = NEW.portal_id AND deal_id = NEW.deal_id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER assessment_handoff_cycle AFTER INSERT OR UPDATE ON deal_assessments
FOR EACH ROW EXECUTE FUNCTION dealguard.advance_handoff_cycle();

-- Assessment row is locked first, the same lock order as the lifecycle trigger.
-- This closes the race between confirmation and an assessment recording reopening.
CREATE FUNCTION dealguard.confirm_handoff_cycle(p_portal TEXT, p_deal TEXT,
  p_assessed_at TEXT, p_user TEXT, p_email TEXT)
RETURNS TABLE(result TEXT, confirmation_time TEXT, cycle INTEGER)
LANGUAGE plpgsql SET search_path = pg_catalog, dealguard AS $$
DECLARE a dealguard.deal_assessments%ROWTYPE; h dealguard.handoffs%ROWTYPE; stamp TEXT;
BEGIN
  IF COALESCE(btrim(p_user), '') = '' AND COALESCE(btrim(p_email), '') = '' THEN
    RETURN QUERY SELECT 'identity_required'::TEXT, NULL::TEXT, NULL::INTEGER; RETURN;
  END IF;
  SELECT * INTO a FROM dealguard.deal_assessments WHERE portal_id = p_portal AND deal_id = p_deal FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::TEXT, NULL::TEXT, NULL::INTEGER; RETURN; END IF;
  IF p_assessed_at IS NULL OR NOT pg_input_is_valid(p_assessed_at, 'timestamp with time zone')
     OR a.assessed_at::timestamptz <> p_assessed_at::timestamptz THEN
    RETURN QUERY SELECT 'stale_assessment'::TEXT, NULL::TEXT, NULL::INTEGER; RETURN;
  END IF;
  IF a.is_closed <> 1 OR a.is_won <> 1 OR a.status = 'critical' THEN
    RETURN QUERY SELECT 'not_eligible'::TEXT, NULL::TEXT, NULL::INTEGER; RETURN;
  END IF;
  SELECT * INTO h FROM dealguard.handoffs WHERE portal_id = p_portal AND deal_id = p_deal FOR UPDATE;
  IF NOT FOUND OR h.active <> 1 THEN
    RETURN QUERY SELECT 'not_eligible'::TEXT, NULL::TEXT, NULL::INTEGER; RETURN;
  END IF;
  IF h.status = 'confirmed' THEN
    RETURN QUERY SELECT 'already_confirmed'::TEXT, h.confirmed_at, h.cycle_number; RETURN;
  END IF;
  stamp := to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  UPDATE dealguard.handoff_cycles SET status = 'confirmed', confirmed_at = stamp,
    confirmed_by_user_id = p_user, confirmed_by_email = p_email
  WHERE portal_id = p_portal AND deal_id = p_deal AND cycle_number = h.cycle_number AND status = 'pending';
  IF NOT FOUND THEN RETURN QUERY SELECT 'cycle_conflict'::TEXT, NULL::TEXT, NULL::INTEGER; RETURN; END IF;
  UPDATE dealguard.handoffs SET status = 'confirmed', confirmed_at = stamp,
    confirmed_by_user_id = p_user, confirmed_by_email = p_email, summary = a.readiness_summary
  WHERE portal_id = p_portal AND deal_id = p_deal;
  RETURN QUERY SELECT 'confirmed'::TEXT, stamp, h.cycle_number;
END;
$$;
