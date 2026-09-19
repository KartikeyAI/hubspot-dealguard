SET search_path TO dealguard, public;

-- Archive is a CRM availability state, not a closed-lost outcome or data erasure.
CREATE TABLE deal_record_lifecycle (
  portal_id TEXT NOT NULL REFERENCES tenants(portal_id) ON DELETE CASCADE,
  deal_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active','archived')),
  verified_at TIMESTAMPTZ NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (portal_id, deal_id)
);
CREATE TABLE deal_record_lifecycle_events (
  id TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL,
  deal_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active','archived')),
  verified_at TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('webhook','record_read','background')),
  FOREIGN KEY (portal_id, deal_id) REFERENCES deal_record_lifecycle(portal_id, deal_id) ON DELETE CASCADE,
  UNIQUE (portal_id, deal_id, verified_at)
);
CREATE INDEX idx_record_lifecycle_portal_state ON deal_record_lifecycle(portal_id, state);
CREATE INDEX idx_record_lifecycle_events_portal_deal_time ON deal_record_lifecycle_events(portal_id, deal_id, verified_at DESC);

CREATE FUNCTION dealguard.record_is_available(p_portal TEXT, p_deal TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SET search_path = pg_catalog, dealguard AS $$
  SELECT NOT EXISTS (SELECT 1 FROM dealguard.deal_record_lifecycle
    WHERE portal_id = p_portal AND deal_id = p_deal AND state = 'archived');
$$;
CREATE FUNCTION dealguard.record_was_available(p_portal TEXT, p_deal TEXT, p_at TIMESTAMPTZ)
RETURNS BOOLEAN LANGUAGE sql STABLE SET search_path = pg_catalog, dealguard AS $$
  SELECT COALESCE((SELECT state = 'active' FROM dealguard.deal_record_lifecycle_events
    WHERE portal_id = p_portal AND deal_id = p_deal AND verified_at <= p_at
    ORDER BY verified_at DESC LIMIT 1), TRUE);
$$;

ALTER TABLE handoff_cycles DROP CONSTRAINT handoff_cycles_end_reason_check;
ALTER TABLE handoff_cycles ADD CONSTRAINT handoff_cycles_end_reason_check
  CHECK (end_reason IN ('deal_reopened','no_longer_won','legacy_inactive','deal_archived'));

CREATE FUNCTION dealguard.verify_deal_record_state(p_portal TEXT, p_deal TEXT, p_state TEXT, p_verified TIMESTAMPTZ, p_source TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SET search_path = pg_catalog, dealguard AS $$
DECLARE previous dealguard.deal_record_lifecycle%ROWTYPE; rec RECORD; stamp TEXT;
BEGIN
  IF p_state NOT IN ('active','archived') OR p_verified IS NULL OR p_verified > clock_timestamp()
    OR p_source NOT IN ('webhook','record_read','background') THEN
    RAISE EXCEPTION 'Invalid record state evidence' USING ERRCODE = '22023';
  END IF;
  -- The same lock is acquired before assessment INSERT / ON CONFLICT paths.
  PERFORM pg_advisory_xact_lock(hashtextextended(json_build_array(p_portal,p_deal)::text, 27));
  PERFORM 1 FROM dealguard.deal_assessments WHERE portal_id = p_portal AND deal_id = p_deal FOR UPDATE;
  SELECT * INTO previous FROM dealguard.deal_record_lifecycle WHERE portal_id = p_portal AND deal_id = p_deal FOR UPDATE;
  IF FOUND AND previous.verified_at >= p_verified THEN RETURN FALSE; END IF;
  INSERT INTO dealguard.deal_record_lifecycle(portal_id,deal_id,state,verified_at)
    VALUES(p_portal,p_deal,p_state,p_verified)
    ON CONFLICT(portal_id,deal_id) DO UPDATE SET state=excluded.state, verified_at=excluded.verified_at,
      version=deal_record_lifecycle.version + CASE WHEN deal_record_lifecycle.state <> excluded.state THEN 1 ELSE 0 END;
  IF previous.state IS NULL OR previous.state <> p_state THEN
    INSERT INTO dealguard.deal_record_lifecycle_events(id,portal_id,deal_id,state,verified_at,source)
      VALUES(gen_random_uuid()::text,p_portal,p_deal,p_state,p_verified,p_source);
  END IF;
  IF p_state = 'active' THEN RETURN TRUE; END IF;
  DELETE FROM dealguard.deal_decision_snapshots WHERE portal_id=p_portal AND deal_id=p_deal;
  stamp := to_char(p_verified AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  FOR rec IN UPDATE dealguard.recommendation_instances SET
    status=CASE WHEN status='accepted' THEN 'expired' ELSE 'superseded' END,
    terminal_reason='deal_archived',
    expired_at=CASE WHEN status='accepted' THEN stamp ELSE expired_at END,
    superseded_at=CASE WHEN status='presented' THEN stamp ELSE superseded_at END, updated_at=stamp
    WHERE portal_id=p_portal AND deal_id=p_deal AND status IN ('presented','accepted') RETURNING id,status
  LOOP
    INSERT INTO dealguard.recommendation_events(id,portal_id,recommendation_id,deal_id,event_type,metadata_json,occurred_at)
    VALUES(gen_random_uuid()::text,p_portal,rec.id,p_deal,rec.status,'{"reason":"deal_archived","source":"record_lifecycle"}',stamp);
  END LOOP;
  UPDATE dealguard.handoff_cycles SET status=CASE WHEN status='pending' THEN 'cancelled' ELSE status END,
    ended_at=stamp,end_reason='deal_archived' WHERE portal_id=p_portal AND deal_id=p_deal AND ended_at IS NULL;
  UPDATE dealguard.handoffs SET active=0,status='reopened',confirmed_at=NULL,confirmed_by_user_id=NULL,confirmed_by_email=NULL
    WHERE portal_id=p_portal AND deal_id=p_deal AND active=1;
  UPDATE dealguard.background_intelligence_jobs SET status='cancelled',lease_token=NULL,last_error_code='deal_archived'
    WHERE portal_id=p_portal AND deal_id=p_deal AND status IN ('queued','retry','processing');
  RETURN TRUE;
END;
$$;
CREATE FUNCTION dealguard.guard_record_assessment() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, dealguard AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(json_build_array(NEW.portal_id,NEW.deal_id)::text,27));
  IF NOT dealguard.record_is_available(NEW.portal_id,NEW.deal_id) THEN RETURN NULL; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER assessment_00_record_guard BEFORE INSERT OR UPDATE ON deal_assessments
FOR EACH ROW EXECUTE FUNCTION dealguard.guard_record_assessment();

CREATE OR REPLACE FUNCTION dealguard.guard_decision_snapshot_parent() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, dealguard AS $$
DECLARE a dealguard.deal_assessments%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.portal_id <> OLD.portal_id OR NEW.deal_id <> OLD.deal_id THEN RETURN NULL; END IF;
  END IF;
  IF NOT pg_input_is_valid(NEW.assessment_at, 'timestamp with time zone')
    OR NOT pg_input_is_valid(NEW.generated_at, 'timestamp with time zone') THEN RETURN NULL; END IF;
  SELECT * INTO a FROM dealguard.deal_assessments
    WHERE portal_id = NEW.portal_id AND deal_id = NEW.deal_id FOR UPDATE;
  IF NOT FOUND OR a.is_closed <> 0 OR NOT dealguard.record_is_available(NEW.portal_id,NEW.deal_id) THEN RETURN NULL; END IF;
  IF a.assessed_at::timestamptz <> NEW.assessment_at::timestamptz
    OR NEW.generated_at::timestamptz < NEW.assessment_at::timestamptz
    OR NEW.generated_at::timestamptz > clock_timestamp() THEN RETURN NULL; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION dealguard.guard_active_recommendation_parent() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, dealguard AS $$
DECLARE a dealguard.deal_assessments%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.portal_id <> OLD.portal_id OR NEW.deal_id <> OLD.deal_id OR NEW.id <> OLD.id THEN RETURN NULL; END IF;
  END IF;
  IF NEW.status NOT IN ('presented','accepted') THEN RETURN NEW; END IF;
  SELECT * INTO a FROM dealguard.deal_assessments
    WHERE portal_id = NEW.portal_id AND deal_id = NEW.deal_id FOR UPDATE;
  IF NOT FOUND OR a.is_closed <> 0 OR NOT dealguard.record_is_available(NEW.portal_id,NEW.deal_id) THEN RETURN NULL; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT pg_input_is_valid(NEW.baseline_assessment_at, 'timestamp with time zone')
      OR NOT pg_input_is_valid(NEW.baseline_snapshot_generated_at, 'timestamp with time zone') THEN RETURN NULL; END IF;
    IF a.assessed_at::timestamptz <> NEW.baseline_assessment_at::timestamptz THEN RETURN NULL; END IF;
    IF NOT EXISTS (SELECT 1 FROM dealguard.deal_decision_snapshots s
      WHERE s.portal_id = NEW.portal_id AND s.deal_id = NEW.deal_id
        AND s.assessment_at::timestamptz = NEW.baseline_assessment_at::timestamptz
        AND s.generated_at::timestamptz = NEW.baseline_snapshot_generated_at::timestamptz) THEN RETURN NULL; END IF;
  END IF;
  RETURN NEW;
END;
$$;
