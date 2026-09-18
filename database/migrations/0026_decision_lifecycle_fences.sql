SET search_path TO dealguard, public;

-- Application snapshot upserts take the parent assessment lock before the conflict
-- path. A close/reopen transaction therefore cannot leave a late active snapshot.
CREATE FUNCTION dealguard.guard_decision_snapshot_parent() RETURNS trigger
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
  IF NOT FOUND OR a.is_closed <> 0 THEN RETURN NULL; END IF;
  IF a.assessed_at::timestamptz <> NEW.assessment_at::timestamptz
    OR NEW.generated_at::timestamptz < NEW.assessment_at::timestamptz
    OR NEW.generated_at::timestamptz > clock_timestamp() THEN RETURN NULL; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER decision_snapshot_parent_guard BEFORE INSERT OR UPDATE ON deal_decision_snapshots
FOR EACH ROW EXECUTE FUNCTION dealguard.guard_decision_snapshot_parent();

CREATE FUNCTION dealguard.guard_active_recommendation_parent() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, dealguard AS $$
DECLARE a dealguard.deal_assessments%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.portal_id <> OLD.portal_id OR NEW.deal_id <> OLD.deal_id OR NEW.id <> OLD.id THEN RETURN NULL; END IF;
  END IF;
  IF NEW.status NOT IN ('presented','accepted') THEN RETURN NEW; END IF;
  SELECT * INTO a FROM dealguard.deal_assessments
    WHERE portal_id = NEW.portal_id AND deal_id = NEW.deal_id FOR UPDATE;
  IF NOT FOUND OR a.is_closed <> 0 THEN RETURN NULL; END IF;
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
CREATE TRIGGER active_recommendation_parent_guard BEFORE INSERT OR UPDATE ON recommendation_instances
FOR EACH ROW EXECUTE FUNCTION dealguard.guard_active_recommendation_parent();

-- This function is idempotent and owns deletion + lifecycle events in one database
-- transaction. The supplied source version must still describe a closed deal.
CREATE FUNCTION dealguard.reconcile_closed_deal_evidence(p_portal TEXT, p_deal TEXT, p_assessed_at TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SET search_path = pg_catalog, dealguard AS $$
DECLARE a dealguard.deal_assessments%ROWTYPE; rec RECORD; stamp TEXT;
BEGIN
  IF p_assessed_at IS NULL OR NOT pg_input_is_valid(p_assessed_at, 'timestamp with time zone') THEN RETURN FALSE; END IF;
  SELECT * INTO a FROM dealguard.deal_assessments WHERE portal_id = p_portal AND deal_id = p_deal FOR UPDATE;
  IF NOT FOUND OR a.is_closed <> 1 THEN RETURN FALSE; END IF;
  IF a.assessed_at::timestamptz <> p_assessed_at::timestamptz THEN RETURN FALSE; END IF;
  DELETE FROM dealguard.deal_decision_snapshots WHERE portal_id = p_portal AND deal_id = p_deal;
  stamp := to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  FOR rec IN UPDATE dealguard.recommendation_instances SET
    status = CASE WHEN status = 'accepted' THEN 'expired' ELSE 'superseded' END,
    terminal_reason = 'deal_closed',
    expired_at = CASE WHEN status = 'accepted' THEN stamp ELSE expired_at END,
    superseded_at = CASE WHEN status = 'presented' THEN stamp ELSE superseded_at END,
    updated_at = stamp
    WHERE portal_id = p_portal AND deal_id = p_deal AND status IN ('presented','accepted')
    RETURNING id, status
  LOOP
    INSERT INTO dealguard.recommendation_events
      (id,portal_id,recommendation_id,deal_id,event_type,metadata_json,occurred_at)
    VALUES (gen_random_uuid()::text,p_portal,rec.id,p_deal,rec.status,
      json_build_object('reason','deal_closed','source','assessment_lifecycle','assessmentAt',p_assessed_at)::text,stamp);
  END LOOP;
  RETURN TRUE;
END;
$$;

CREATE FUNCTION dealguard.reconcile_assessment_decision_evidence() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, dealguard AS $$
BEGIN
  IF NEW.is_closed = 1 THEN
    PERFORM dealguard.reconcile_closed_deal_evidence(NEW.portal_id, NEW.deal_id, NEW.assessed_at);
  ELSE
    DELETE FROM dealguard.deal_decision_snapshots
      WHERE portal_id = NEW.portal_id AND deal_id = NEW.deal_id
        AND assessment_at::timestamptz <> NEW.assessed_at::timestamptz;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER assessment_decision_reconciliation AFTER INSERT OR UPDATE ON deal_assessments
FOR EACH ROW EXECUTE FUNCTION dealguard.reconcile_assessment_decision_evidence();
