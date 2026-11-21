SET search_path TO dealguard, public;

ALTER TABLE remediation_cases ADD COLUMN auto_resolution_after TEXT;

-- Reopening is a new review cycle: the same assessment cannot resolve it again.
CREATE FUNCTION dealguard.fence_reopened_auto_resolution() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,dealguard AS $$
DECLARE source_time TEXT;
BEGIN
  IF NEW.status='open' AND OLD.status IN ('resolved','waived','closed') THEN
    SELECT assessed_at INTO source_time FROM dealguard.deal_assessments
      WHERE portal_id=NEW.portal_id AND deal_id=NEW.deal_id;
    NEW.auto_resolution_after:=source_time;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER fence_reopened_auto_resolution BEFORE UPDATE ON remediation_cases
  FOR EACH ROW EXECUTE FUNCTION dealguard.fence_reopened_auto_resolution();

-- Invoker rights. Archive -> assessment -> case lock order matches manual work.
CREATE FUNCTION dealguard.resolve_assessment_cases(p_portal TEXT,p_deal TEXT,p_source TEXT)
RETURNS INTEGER LANGUAGE plpgsql SET search_path=pg_catalog,dealguard AS $$
DECLARE a dealguard.deal_assessments%ROWTYPE; r dealguard.remediation_cases%ROWTYPE;
  issues JSONB; stamp TEXT; changed INTEGER:=0;
BEGIN
  IF NOT dealguard.lock_current_work_record(p_portal,p_deal,p_source) THEN RETURN 0; END IF;
  SELECT * INTO a FROM dealguard.deal_assessments WHERE portal_id=p_portal AND deal_id=p_deal;
  IF a.is_closed<>0 OR a.assessed_at::timestamptz>clock_timestamp()
    OR a.assessed_at::timestamptz<clock_timestamp()-INTERVAL '72 hours'
    OR NOT pg_input_is_valid(a.issues_json,'jsonb') THEN RETURN 0; END IF;
  issues:=a.issues_json::jsonb;
  IF jsonb_typeof(issues)<>'array' THEN RETURN 0; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(issues) e
    WHERE jsonb_typeof(e)<>'object' OR jsonb_typeof(e->'code') IS DISTINCT FROM 'string'
      OR NULLIF(btrim(e->>'code'),'') IS NULL) THEN RETURN 0; END IF;
  stamp:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  FOR r IN SELECT * FROM dealguard.remediation_cases
    WHERE portal_id=p_portal AND deal_id=p_deal AND source='assessment'
      AND status IN ('open','acknowledged','in_progress','overdue') ORDER BY id FOR UPDATE
  LOOP
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(issues) e WHERE e->>'code'=r.issue_code)
      OR (r.evidence_required=1 AND r.evidence_status<>'accepted')
      OR (r.acknowledgement_required=1 AND r.acknowledged_at IS NULL) THEN CONTINUE; END IF;
    IF r.auto_resolution_after IS NOT NULL THEN
      IF NOT pg_input_is_valid(r.auto_resolution_after,'timestamp with time zone')
        OR a.assessed_at::timestamptz<=r.auto_resolution_after::timestamptz THEN CONTINUE; END IF;
    END IF;
    UPDATE dealguard.remediation_cases SET status='resolved',resolved_at=stamp,
      resolution_note='Issue no longer detected; configured evidence and acknowledgement checks passed.',
      auto_resolution_after=a.assessed_at,updated_at=stamp WHERE portal_id=p_portal AND id=r.id;
    INSERT INTO dealguard.remediation_events(id,portal_id,case_id,action,metadata_json,created_at)
      VALUES(gen_random_uuid()::text,p_portal,r.id,'auto_resolved',
        jsonb_build_object('assessmentAt',a.assessed_at,'evidenceChecksEnforced',true)::text,stamp);
    INSERT INTO dealguard.audit_events(id,portal_id,action,metadata_json,created_at)
      VALUES(gen_random_uuid()::text,p_portal,'remediation.auto_resolved',
        jsonb_build_object('caseId',r.id,'dealId',p_deal,'assessmentAt',a.assessed_at)::text,stamp);
    INSERT INTO dealguard.outbox_events(id,portal_id,event_type,severity,aggregate_type,aggregate_id,
      payload_json,status,available_at,created_at)
      VALUES(gen_random_uuid()::text,p_portal,'remediation.auto_resolved',r.severity,'remediation_case',r.id,
        jsonb_build_object('caseId',r.id,'dealId',p_deal,'issueCode',r.issue_code,'title',r.title,
          'summary',r.description,'status','resolved','priority',r.priority,'ownerId',r.owner_id,
          'ownerEmail',r.owner_email,'dueAt',r.due_at,'hubSpotTaskId',r.hubspot_task_id)::text,'pending',stamp,stamp);
    changed:=changed+1;
  END LOOP;
  RETURN changed;
END;
$$;
