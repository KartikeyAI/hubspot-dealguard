SET search_path TO dealguard, public;

ALTER TABLE remediation_cases ADD COLUMN task_delivery_state TEXT NOT NULL DEFAULT 'not_requested'
  CHECK(task_delivery_state IN ('not_requested','pending','sending','created','held'));
ALTER TABLE remediation_cases ADD COLUMN task_delivery_error TEXT;
ALTER TABLE remediation_cases ADD COLUMN task_delivery_token TEXT;
ALTER TABLE remediation_cases ADD COLUMN task_started_at TIMESTAMPTZ;
UPDATE remediation_cases SET task_delivery_state='created' WHERE hubspot_task_id IS NOT NULL;
CREATE INDEX remediation_pending_tasks ON remediation_cases(task_delivery_state,created_at)
  WHERE task_delivery_state IN ('pending','sending');

-- Record mutation and its event, audit and notification intent share one transaction.
-- No function in this migration contacts HubSpot. Rights remain those of the caller.
CREATE FUNCTION dealguard.create_remediation_work(
  p_portal TEXT,p_deal TEXT,p_assessment TEXT,p_source TEXT,p_input JSONB,p_user TEXT,p_email TEXT
) RETURNS JSONB LANGUAGE plpgsql SET search_path=pg_catalog,dealguard AS $$
DECLARE a dealguard.deal_assessments%ROWTYPE; r dealguard.remediation_cases%ROWTYPE;
  stamp TEXT; created BOOLEAN; code TEXT;
BEGIN
  code:=p_input->>'issueCode';
  IF p_source NOT IN ('manual','assessment','workflow') OR jsonb_typeof(p_input)<>'object'
    OR code IS NULL OR code !~ '^[a-zA-Z0-9_.-]{1,128}$'
    OR p_input->>'severity' NOT IN ('info','warning','critical')
    OR p_input->>'priority' NOT IN ('low','medium','high','urgent')
    OR NULLIF(btrim(p_input->>'title'),'') IS NULL OR length(p_input->>'title')>255
    OR NULLIF(btrim(p_input->>'description'),'') IS NULL OR length(p_input->>'description')>4000
    OR (p_source='manual' AND NULLIF(p_user,'') IS NULL AND NULLIF(p_email,'') IS NULL)
    OR (p_input->>'dueAt' IS NOT NULL AND NOT pg_input_is_valid(p_input->>'dueAt','timestamp with time zone'))
    THEN RETURN jsonb_build_object('error','invalid_action'); END IF;
  IF p_assessment IS NOT NULL THEN
    IF NOT dealguard.lock_current_work_record(p_portal,p_deal,p_assessment) THEN RETURN jsonb_build_object('error','record_changed'); END IF;
  ELSE
    -- A signed workflow may intentionally create work before the first assessment.
    IF p_source<>'workflow' THEN RETURN jsonb_build_object('error','record_changed'); END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(json_build_array(p_portal,p_deal)::text,27));
    PERFORM 1 FROM dealguard.deal_assessments WHERE portal_id=p_portal AND deal_id=p_deal FOR UPDATE;
    IF NOT dealguard.record_is_available(p_portal,p_deal) OR NOT EXISTS
      (SELECT 1 FROM dealguard.tenants WHERE portal_id=p_portal AND status='active') THEN RETURN jsonb_build_object('error','record_changed'); END IF;
  END IF;
  IF p_source='assessment' THEN
    SELECT * INTO a FROM dealguard.deal_assessments WHERE portal_id=p_portal AND deal_id=p_deal;
    IF NOT FOUND OR a.is_closed<>0 OR a.assessed_at::timestamptz>clock_timestamp()
      OR a.assessed_at::timestamptz<clock_timestamp()-INTERVAL '72 hours'
      OR NOT pg_input_is_valid(a.issues_json,'jsonb') THEN RETURN jsonb_build_object('error','record_changed'); END IF;
    IF jsonb_typeof(a.issues_json::jsonb)<>'array' THEN RETURN jsonb_build_object('error','record_changed'); END IF;
    IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(a.issues_json::jsonb) i
      WHERE i->>'code'=code AND i->>'severity'='critical') THEN RETURN jsonb_build_object('error','record_changed'); END IF;
  END IF;
  stamp:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  INSERT INTO dealguard.remediation_cases(id,portal_id,deal_id,issue_code,title,description,severity,status,priority,
    owner_id,owner_email,due_at,source,created_by_user_id,created_by_email,created_at,updated_at,task_delivery_state)
    VALUES(gen_random_uuid()::text,p_portal,p_deal,code,p_input->>'title',p_input->>'description',p_input->>'severity','open',
      p_input->>'priority',p_input->>'ownerId',p_input->>'ownerEmail',p_input->>'dueAt',p_source,p_user,p_email,stamp,stamp,
      CASE WHEN p_input->'createTask'='true'::jsonb THEN 'pending' ELSE 'not_requested' END)
    ON CONFLICT(portal_id,deal_id,issue_code) WHERE status IN ('open','acknowledged','in_progress','overdue') DO NOTHING
    RETURNING * INTO r;
  created:=FOUND;
  IF NOT created THEN
    SELECT * INTO r FROM dealguard.remediation_cases WHERE portal_id=p_portal AND deal_id=p_deal AND issue_code=code
      AND status IN ('open','acknowledged','in_progress','overdue') FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Concurrent remediation changed; retry' USING ERRCODE='40001'; END IF;
    RETURN jsonb_build_object('caseId',r.id,'created',false);
  END IF;
  INSERT INTO dealguard.remediation_events(id,portal_id,case_id,action,actor_user_id,actor_email,metadata_json,created_at)
    VALUES(gen_random_uuid()::text,p_portal,r.id,'created',p_user,p_email,jsonb_build_object('source',p_source)::text,stamp);
  INSERT INTO dealguard.audit_events(id,portal_id,user_id,user_email,action,metadata_json,created_at)
    VALUES(gen_random_uuid()::text,p_portal,p_user,p_email,'remediation.created',
      jsonb_build_object('caseId',r.id,'dealId',p_deal,'issueCode',code,'taskRequested',r.task_delivery_state='pending')::text,stamp);
  INSERT INTO dealguard.outbox_events(id,portal_id,event_type,severity,aggregate_type,aggregate_id,payload_json,status,available_at,created_at)
    VALUES(gen_random_uuid()::text,p_portal,'remediation.created',r.severity,'remediation_case',r.id,
      jsonb_build_object('caseId',r.id,'dealId',p_deal,'issueCode',code,'title',r.title,'summary',r.description,
        'status',r.status,'priority',r.priority,'ownerId',r.owner_id,'ownerEmail',r.owner_email,'dueAt',r.due_at)::text,'pending',stamp,stamp);
  RETURN jsonb_build_object('caseId',r.id,'created',true);
END;
$$;

CREATE FUNCTION dealguard.escalate_remediation_work(p_portal TEXT,p_deal TEXT,p_case TEXT,p_source TEXT,p_revision TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SET search_path=pg_catalog,dealguard AS $$
DECLARE r dealguard.remediation_cases%ROWTYPE; stamp TEXT;
BEGIN
  IF NOT dealguard.lock_current_work_record(p_portal,p_deal,p_source) THEN RETURN FALSE; END IF;
  SELECT * INTO r FROM dealguard.remediation_cases WHERE portal_id=p_portal AND deal_id=p_deal AND id=p_case FOR UPDATE;
  IF NOT FOUND OR r.work_revision::text IS DISTINCT FROM p_revision OR r.status NOT IN ('open','acknowledged','in_progress')
    OR r.due_at IS NULL OR NOT pg_input_is_valid(r.due_at,'timestamp with time zone') THEN RETURN FALSE; END IF;
  IF r.due_at::timestamptz>=clock_timestamp() THEN RETURN FALSE; END IF;
  stamp:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  UPDATE dealguard.remediation_cases SET status='overdue',last_escalated_at=stamp,updated_at=stamp WHERE portal_id=p_portal AND id=p_case;
  INSERT INTO dealguard.remediation_events(id,portal_id,case_id,action,metadata_json,created_at)
    VALUES(gen_random_uuid()::text,p_portal,p_case,'overdue',jsonb_build_object('dueAt',r.due_at)::text,stamp);
  INSERT INTO dealguard.audit_events(id,portal_id,action,metadata_json,created_at)
    VALUES(gen_random_uuid()::text,p_portal,'remediation.overdue',jsonb_build_object('caseId',p_case,'dealId',p_deal)::text,stamp);
  INSERT INTO dealguard.outbox_events(id,portal_id,event_type,severity,aggregate_type,aggregate_id,payload_json,status,available_at,created_at)
    VALUES(gen_random_uuid()::text,p_portal,'remediation.overdue',r.severity,'remediation_case',p_case,
      jsonb_build_object('caseId',p_case,'dealId',p_deal,'issueCode',r.issue_code,'title',r.title,'summary',r.description,
        'status','overdue','priority',r.priority,'ownerId',r.owner_id,'ownerEmail',r.owner_email,'dueAt',r.due_at,'hubSpotTaskId',r.hubspot_task_id)::text,
      'pending',stamp,stamp);
  RETURN TRUE;
END;
$$;

CREATE FUNCTION dealguard.claim_remediation_task(p_portal TEXT,p_deal TEXT,p_case TEXT,p_source TEXT,p_token TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SET search_path=pg_catalog,dealguard AS $$
DECLARE r dealguard.remediation_cases%ROWTYPE; a dealguard.deal_assessments%ROWTYPE;
BEGIN
  IF p_token IS NULL OR length(p_token)<1 OR length(p_token)>128 THEN RETURN FALSE; END IF;
  IF p_source IS NOT NULL THEN
    IF NOT dealguard.lock_current_work_record(p_portal,p_deal,p_source) THEN RETURN FALSE; END IF;
  ELSE
    PERFORM pg_advisory_xact_lock(hashtextextended(json_build_array(p_portal,p_deal)::text,27));
    PERFORM 1 FROM dealguard.deal_assessments WHERE portal_id=p_portal AND deal_id=p_deal FOR UPDATE;
    IF NOT dealguard.record_is_available(p_portal,p_deal) OR NOT EXISTS
      (SELECT 1 FROM dealguard.tenants WHERE portal_id=p_portal AND status='active') THEN RETURN FALSE; END IF;
  END IF;
  SELECT * INTO r FROM dealguard.remediation_cases WHERE portal_id=p_portal AND deal_id=p_deal AND id=p_case FOR UPDATE;
  IF NOT FOUND OR r.task_delivery_state<>'pending' OR r.status NOT IN ('open','acknowledged','in_progress','overdue') THEN RETURN FALSE; END IF;
  IF p_source IS NULL AND r.source<>'workflow' THEN RETURN FALSE; END IF;
  IF r.source='assessment' THEN
    SELECT * INTO a FROM dealguard.deal_assessments WHERE portal_id=p_portal AND deal_id=p_deal;
    IF NOT FOUND OR a.is_closed<>0 OR a.assessed_at::timestamptz>clock_timestamp()
      OR a.assessed_at::timestamptz<clock_timestamp()-INTERVAL '72 hours'
      OR NOT pg_input_is_valid(a.issues_json,'jsonb') THEN RETURN FALSE; END IF;
    IF jsonb_typeof(a.issues_json::jsonb)<>'array' THEN RETURN FALSE; END IF;
    IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(a.issues_json::jsonb) i
      WHERE i->>'code'=r.issue_code AND i->>'severity'='critical') THEN
      UPDATE dealguard.remediation_cases SET task_delivery_state='held',task_delivery_error='task_source_changed'
        WHERE portal_id=p_portal AND id=p_case;
      RETURN FALSE;
    END IF;
  END IF;
  UPDATE dealguard.remediation_cases SET task_delivery_state='sending',task_delivery_token=p_token,
    task_started_at=clock_timestamp(),task_delivery_error=NULL WHERE portal_id=p_portal AND id=p_case;
  RETURN TRUE;
END;
$$;

CREATE FUNCTION dealguard.finish_remediation_task(p_portal TEXT,p_case TEXT,p_token TEXT,p_task TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SET search_path=pg_catalog,dealguard AS $$
DECLARE r dealguard.remediation_cases%ROWTYPE; stamp TEXT; action TEXT;
BEGIN
  IF p_task IS NOT NULL AND p_task !~ '^[0-9]{1,32}$' THEN RAISE EXCEPTION 'Invalid task receipt'; END IF;
  stamp:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  UPDATE dealguard.remediation_cases SET hubspot_task_id=p_task,updated_at=stamp,
    task_delivery_state=CASE WHEN p_task IS NULL THEN 'held' ELSE 'created' END,
    task_delivery_error=CASE WHEN p_task IS NULL THEN 'hubspot_task_delivery_unconfirmed' ELSE NULL END
    WHERE portal_id=p_portal AND id=p_case AND task_delivery_token=p_token
      AND task_delivery_state IN ('sending','held') AND hubspot_task_id IS NULL
      AND (p_task IS NOT NULL OR task_delivery_state='sending') RETURNING * INTO r;
  IF NOT FOUND THEN RETURN FALSE; END IF;
  action:=CASE WHEN p_task IS NULL THEN 'hubspot_task_unconfirmed' ELSE 'hubspot_task_created' END;
  INSERT INTO dealguard.remediation_events(id,portal_id,case_id,action,metadata_json,created_at)
    VALUES(gen_random_uuid()::text,p_portal,p_case,action,jsonb_build_object('taskId',p_task,'automaticReplayDisabled',p_task IS NULL)::text,stamp);
  INSERT INTO dealguard.audit_events(id,portal_id,action,metadata_json,created_at)
    VALUES(gen_random_uuid()::text,p_portal,'remediation.'||action,jsonb_build_object('caseId',p_case,'taskId',p_task)::text,stamp);
  RETURN TRUE;
END;
$$;
