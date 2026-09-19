SET search_path TO dealguard, public;

ALTER TABLE remediation_cases ADD COLUMN work_revision BIGINT NOT NULL DEFAULT 0 CHECK(work_revision>=0);
ALTER TABLE recommendation_instances ADD COLUMN work_revision BIGINT NOT NULL DEFAULT 0 CHECK(work_revision>=0);
CREATE FUNCTION dealguard.advance_work_revision() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN NEW.work_revision:=OLD.work_revision+1;RETURN NEW;END;
$$;
CREATE TRIGGER remediation_work_revision BEFORE UPDATE ON remediation_cases FOR EACH ROW EXECUTE FUNCTION dealguard.advance_work_revision();
CREATE TRIGGER recommendation_work_revision BEFORE UPDATE ON recommendation_instances FOR EACH ROW EXECUTE FUNCTION dealguard.advance_work_revision();

-- Composite keys prevent links crossing either a portal or a deal.
ALTER TABLE recommendation_instances ADD CONSTRAINT recommendation_instance_deal_key UNIQUE (portal_id,id,deal_id);
ALTER TABLE remediation_cases ADD CONSTRAINT remediation_case_deal_key UNIQUE (portal_id,id,deal_id);
CREATE TABLE recommendation_remediation_links (
  portal_id TEXT NOT NULL,
  recommendation_id TEXT NOT NULL,
  deal_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  created_by_user_id TEXT,
  created_by_email TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (portal_id,recommendation_id),
  FOREIGN KEY (portal_id,recommendation_id,deal_id) REFERENCES recommendation_instances(portal_id,id,deal_id) ON DELETE CASCADE,
  FOREIGN KEY (portal_id,case_id,deal_id) REFERENCES remediation_cases(portal_id,id,deal_id) ON DELETE CASCADE
);
CREATE INDEX recommendation_remediation_case_index ON recommendation_remediation_links(portal_id,case_id);

-- All manual work functions use the archive -> assessment -> work-item lock order.
-- The application authorizes the identified actor before invoking these invoker-rights functions.
CREATE FUNCTION dealguard.lock_current_work_record(p_portal TEXT,p_deal TEXT,p_source TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SET search_path=pg_catalog,dealguard AS $$
DECLARE a dealguard.deal_assessments%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(p_portal,p_deal)::text,271826));
  SELECT * INTO a FROM dealguard.deal_assessments WHERE portal_id=p_portal AND deal_id=p_deal FOR UPDATE;
  IF NOT FOUND OR p_source IS NULL OR NOT pg_input_is_valid(p_source,'timestamp with time zone') THEN RETURN FALSE; END IF;
  RETURN a.assessed_at::timestamptz=p_source::timestamptz
    AND dealguard.record_is_available(p_portal,p_deal)
    AND EXISTS(SELECT 1 FROM dealguard.tenants WHERE portal_id=p_portal AND status='active');
END;
$$;

CREATE FUNCTION dealguard.transition_recommendation_work(
  p_portal TEXT,p_deal TEXT,p_id TEXT,p_source TEXT,p_action TEXT,p_user TEXT,p_email TEXT,p_reason TEXT
) RETURNS JSONB LANGUAGE plpgsql SET search_path=pg_catalog,dealguard AS $$
DECLARE r dealguard.recommendation_instances%ROWTYPE; stamp TEXT; target TEXT;
BEGIN
  IF p_action NOT IN ('accept','complete','dismiss') OR (NULLIF(p_user,'') IS NULL AND NULLIF(p_email,'') IS NULL)
    THEN RETURN jsonb_build_object('error','invalid_action'); END IF;
  IF NOT dealguard.lock_current_work_record(p_portal,p_deal,p_source) THEN RETURN jsonb_build_object('error','record_changed'); END IF;
  SELECT * INTO r FROM dealguard.recommendation_instances WHERE portal_id=p_portal AND deal_id=p_deal AND id=p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','not_found'); END IF;
  IF (p_action='accept' AND r.status IN ('accepted','completed')) OR (p_action='complete' AND r.status='completed')
    OR (p_action='dismiss' AND r.status='dismissed') THEN RETURN jsonb_build_object('changed',false,'status',r.status); END IF;
  IF r.status NOT IN ('presented','accepted') OR (p_action='accept' AND r.status<>'presented')
    THEN RETURN jsonb_build_object('error','not_actionable'); END IF;
  IF p_action='dismiss' AND (NULLIF(btrim(p_reason),'') IS NULL OR length(p_reason)>1000)
    THEN RETURN jsonb_build_object('error','reason_required'); END IF;
  stamp:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  IF r.status='presented' AND r.due_at IS NOT NULL THEN
    IF NOT pg_input_is_valid(r.due_at,'timestamp with time zone') THEN RETURN jsonb_build_object('error','invalid_deadline'); END IF;
    IF r.due_at::timestamptz<clock_timestamp() THEN
      UPDATE dealguard.recommendation_instances SET status='expired',expired_at=stamp,updated_at=stamp,
        terminal_reason='not_accepted_before_due' WHERE portal_id=p_portal AND id=p_id;
      INSERT INTO dealguard.recommendation_events(id,portal_id,recommendation_id,deal_id,event_type,metadata_json,occurred_at)
        VALUES(gen_random_uuid()::text,p_portal,p_id,p_deal,'expired','{"source":"manual_transition","reason":"not_accepted_before_due"}',stamp);
      INSERT INTO dealguard.audit_events(id,portal_id,user_id,user_email,action,metadata_json,created_at)
        VALUES(gen_random_uuid()::text,p_portal,p_user,p_email,'recommendation.expired',jsonb_build_object('recommendationId',p_id,'dealId',p_deal)::text,stamp);
      RETURN jsonb_build_object('error','not_actionable','status','expired');
    END IF;
  END IF;
  target:=CASE p_action WHEN 'accept' THEN 'accepted' WHEN 'complete' THEN 'completed' ELSE 'dismissed' END;
  UPDATE dealguard.recommendation_instances SET status=target,
    accepted_at=CASE WHEN p_action IN ('accept','complete') THEN COALESCE(accepted_at,stamp) ELSE accepted_at END,
    accepted_by_user_id=CASE WHEN p_action IN ('accept','complete') THEN COALESCE(accepted_by_user_id,p_user) ELSE accepted_by_user_id END,
    accepted_by_email=CASE WHEN p_action IN ('accept','complete') THEN COALESCE(accepted_by_email,p_email) ELSE accepted_by_email END,
    completed_at=CASE WHEN p_action='complete' THEN stamp ELSE completed_at END,
    completed_by_user_id=CASE WHEN p_action='complete' THEN p_user ELSE completed_by_user_id END,
    completed_by_email=CASE WHEN p_action='complete' THEN p_email ELSE completed_by_email END,
    dismissed_at=CASE WHEN p_action='dismiss' THEN stamp ELSE dismissed_at END,
    dismissed_by_user_id=CASE WHEN p_action='dismiss' THEN p_user ELSE dismissed_by_user_id END,
    dismissed_by_email=CASE WHEN p_action='dismiss' THEN p_email ELSE dismissed_by_email END,
    dismissal_reason=CASE WHEN p_action='dismiss' THEN p_reason ELSE dismissal_reason END,
    terminal_reason=CASE WHEN p_action='dismiss' THEN 'user_dismissed' ELSE terminal_reason END,updated_at=stamp
    WHERE portal_id=p_portal AND id=p_id;
  IF p_action='complete' THEN
    IF r.status='presented' THEN
      INSERT INTO dealguard.recommendation_events(id,portal_id,recommendation_id,deal_id,event_type,actor_user_id,actor_email,metadata_json,occurred_at)
        VALUES(gen_random_uuid()::text,p_portal,p_id,p_deal,'accepted',p_user,p_email,'{"automaticallyAcceptedOnCompletion":true}',stamp);
    END IF;
    INSERT INTO dealguard.recommendation_outcomes(recommendation_id,portal_id,deal_id,evaluation_status,created_at,updated_at)
      VALUES(p_id,p_portal,p_deal,'pending',stamp,stamp) ON CONFLICT(recommendation_id) DO NOTHING;
  END IF;
  INSERT INTO dealguard.recommendation_events(id,portal_id,recommendation_id,deal_id,event_type,actor_user_id,actor_email,metadata_json,occurred_at)
    VALUES(gen_random_uuid()::text,p_portal,p_id,p_deal,target,p_user,p_email,
      jsonb_build_object('reason',p_reason,'completionDoesNotProveImpact',true)::text,stamp);
  INSERT INTO dealguard.audit_events(id,portal_id,user_id,user_email,action,metadata_json,created_at)
    VALUES(gen_random_uuid()::text,p_portal,p_user,p_email,'recommendation.'||target,
      jsonb_build_object('recommendationId',p_id,'dealId',p_deal,'recommendationCode',r.recommendation_code)::text,stamp);
  RETURN jsonb_build_object('changed',true,'status',target);
END;
$$;

CREATE FUNCTION dealguard.link_recommendation_remediation(
  p_portal TEXT,p_deal TEXT,p_id TEXT,p_source TEXT,p_version TEXT,p_owner TEXT,p_due TEXT,
  p_fingerprint TEXT,p_user TEXT,p_email TEXT
) RETURNS JSONB LANGUAGE plpgsql SET search_path=pg_catalog,dealguard AS $$
DECLARE r dealguard.recommendation_instances%ROWTYPE; linked dealguard.recommendation_remediation_links%ROWTYPE;
  c dealguard.remediation_cases%ROWTYPE; stamp TEXT; code TEXT; created_case BOOLEAN:=false; result JSONB;
BEGIN
  IF NULLIF(p_user,'') IS NULL AND NULLIF(p_email,'') IS NULL THEN RETURN jsonb_build_object('error','invalid_action'); END IF;
  IF p_owner IS NULL OR p_owner !~ '^[0-9]{1,32}$' OR p_fingerprint IS NULL OR p_fingerprint !~ '^[a-f0-9]{64}$'
    OR p_due IS NULL OR NOT pg_input_is_valid(p_due,'timestamp with time zone') THEN RETURN jsonb_build_object('error','invalid_action'); END IF;
  IF NOT dealguard.lock_current_work_record(p_portal,p_deal,p_source) THEN RETURN jsonb_build_object('error','record_changed'); END IF;
  SELECT * INTO r FROM dealguard.recommendation_instances WHERE portal_id=p_portal AND id=p_id AND deal_id=p_deal FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','not_found'); END IF;
  SELECT * INTO linked FROM dealguard.recommendation_remediation_links WHERE portal_id=p_portal AND recommendation_id=p_id;
  IF FOUND THEN
    IF linked.request_fingerprint<>p_fingerprint THEN RETURN jsonb_build_object('error','request_changed'); END IF;
    RETURN jsonb_build_object('caseId',linked.case_id,'createdCase',false,'alreadyLinked',true);
  END IF;
  IF r.work_revision::text IS DISTINCT FROM p_version THEN RETURN jsonb_build_object('error','definition_changed'); END IF;
  IF r.status NOT IN ('presented','accepted') THEN RETURN jsonb_build_object('error','not_actionable'); END IF;
  -- Accept a presented recommendation first, within this transaction. Failure writes
  -- no case; successful acceptance rolls back with any later case/link/audit failure.
  IF r.status='presented' THEN
    result:=dealguard.transition_recommendation_work(p_portal,p_deal,p_id,p_source,'accept',p_user,p_email,NULL);
    IF result ? 'error' THEN RETURN result; END IF;
  END IF;
  stamp:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  code:=CASE WHEN r.recommendation_code LIKE 'readiness\_%' ESCAPE '\' THEN substring(r.recommendation_code FROM 11)
    ELSE 'recommendation_'||r.recommendation_code END;
  IF code !~ '^[a-zA-Z0-9_.-]{1,128}$' THEN code:='recommendation_'||md5(r.recommendation_code); END IF;
  -- The partial unique index also arbitrates concurrent automatic/manual creation.
  INSERT INTO dealguard.remediation_cases(id,portal_id,deal_id,issue_code,title,description,severity,status,priority,
    owner_id,due_at,source,created_by_user_id,created_by_email,created_at,updated_at)
    VALUES(gen_random_uuid()::text,p_portal,p_deal,code,left(r.recommendation_label,255),left(r.recommendation_text,4000),
      'warning','open',r.priority,p_owner,p_due,'manual',p_user,p_email,stamp,stamp)
    ON CONFLICT(portal_id,deal_id,issue_code) WHERE status IN ('open','acknowledged','in_progress','overdue') DO NOTHING
    RETURNING * INTO c;
  created_case:=FOUND;
  IF NOT created_case THEN
    SELECT * INTO c FROM dealguard.remediation_cases WHERE portal_id=p_portal AND deal_id=p_deal AND issue_code=code
      AND status IN ('open','acknowledged','in_progress','overdue') FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Concurrent remediation transition; retry'; END IF;
  END IF;
  INSERT INTO dealguard.recommendation_remediation_links(portal_id,recommendation_id,deal_id,case_id,request_fingerprint,
    created_by_user_id,created_by_email,created_at) VALUES(p_portal,p_id,p_deal,c.id,p_fingerprint,p_user,p_email,stamp);
  INSERT INTO dealguard.remediation_events(id,portal_id,case_id,action,actor_user_id,actor_email,metadata_json,created_at)
    VALUES(gen_random_uuid()::text,p_portal,c.id,'recommendation_linked',p_user,p_email,
      jsonb_build_object('recommendationId',p_id,'createdCase',created_case,'requestedOwnerId',p_owner,'requestedDueAt',p_due)::text,stamp);
  INSERT INTO dealguard.audit_events(id,portal_id,user_id,user_email,action,metadata_json,created_at)
    VALUES(gen_random_uuid()::text,p_portal,p_user,p_email,'recommendation.remediation_linked',
      jsonb_build_object('recommendationId',p_id,'dealId',p_deal,'caseId',c.id,'createdCase',created_case)::text,stamp);
  RETURN jsonb_build_object('caseId',c.id,'createdCase',created_case,'alreadyLinked',false);
END;
$$;

CREATE FUNCTION dealguard.assert_current_work_record(p_portal TEXT,p_deal TEXT,p_source TEXT,p_case TEXT,p_version TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SET search_path=pg_catalog,dealguard AS $$
DECLARE v TEXT;
BEGIN
  IF NOT dealguard.lock_current_work_record(p_portal,p_deal,p_source) THEN RAISE EXCEPTION 'Work record changed; refresh before retrying' USING ERRCODE='40001'; END IF;
  SELECT work_revision::text INTO v FROM dealguard.remediation_cases WHERE portal_id=p_portal AND deal_id=p_deal AND id=p_case FOR UPDATE;
  IF NOT FOUND OR v IS DISTINCT FROM p_version THEN RAISE EXCEPTION 'Remediation changed; refresh before retrying' USING ERRCODE='40001'; END IF;
  RETURN TRUE;
END;
$$;

CREATE FUNCTION dealguard.transition_remediation_work(
  p_portal TEXT,p_deal TEXT,p_id TEXT,p_source TEXT,p_version TEXT,p_action TEXT,p_input JSONB,p_user TEXT,p_email TEXT
) RETURNS JSONB LANGUAGE plpgsql SET search_path=pg_catalog,dealguard AS $$
DECLARE r dealguard.remediation_cases%ROWTYPE; target TEXT; stamp TEXT; note TEXT; changes INTEGER;
BEGIN
  IF p_action NOT IN ('acknowledge','start','resolve','waive','close','reopen','assign','set_due_date','set_priority')
    OR (NULLIF(p_user,'') IS NULL AND NULLIF(p_email,'') IS NULL) THEN RETURN jsonb_build_object('error','invalid_action'); END IF;
  IF NOT dealguard.lock_current_work_record(p_portal,p_deal,p_source) THEN RETURN jsonb_build_object('error','record_changed'); END IF;
  SELECT * INTO r FROM dealguard.remediation_cases WHERE portal_id=p_portal AND deal_id=p_deal AND id=p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','not_found'); END IF;
  IF r.work_revision::text IS DISTINCT FROM p_version THEN RETURN jsonb_build_object('error','definition_changed'); END IF;
  stamp:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  target:=CASE p_action WHEN 'acknowledge' THEN 'acknowledged' WHEN 'start' THEN 'in_progress' WHEN 'resolve' THEN 'resolved'
    WHEN 'waive' THEN 'waived' WHEN 'close' THEN 'closed' WHEN 'reopen' THEN 'open' ELSE r.status END;
  note:=NULLIF(btrim(p_input->>'note'),'');
  IF p_action IN ('waive','resolve') AND (note IS NULL OR length(note)>2000) THEN RETURN jsonb_build_object('error','note_required'); END IF;
  IF p_action IN ('resolve','close') THEN
    IF r.evidence_required=1 AND r.evidence_status<>'accepted' THEN RETURN jsonb_build_object('error','evidence_required'); END IF;
    IF r.acknowledgement_required=1 AND r.acknowledged_at IS NULL THEN RETURN jsonb_build_object('error','acknowledgement_required'); END IF;
  END IF;
  IF p_action NOT IN ('assign','set_due_date','set_priority') THEN
    IF r.status=target OR (p_action='acknowledge' AND r.acknowledged_at IS NOT NULL) THEN
      RETURN jsonb_build_object('changed',false,'status',r.status); END IF;
    IF (p_action IN ('acknowledge','start','resolve','waive') AND r.status NOT IN ('open','acknowledged','in_progress','overdue'))
      OR (p_action='close' AND r.status NOT IN ('resolved','waived'))
      OR (p_action='reopen' AND r.status NOT IN ('resolved','waived','closed')) THEN
      RETURN jsonb_build_object('error','not_actionable'); END IF;
  END IF;
  IF p_input ? 'dueAt' AND p_input->>'dueAt' IS NOT NULL AND NOT pg_input_is_valid(p_input->>'dueAt','timestamp with time zone')
    THEN RETURN jsonb_build_object('error','invalid_deadline'); END IF;
  IF p_input ? 'priority' AND (p_input->>'priority' IS NULL OR p_input->>'priority' NOT IN ('low','medium','high','urgent'))
    THEN RETURN jsonb_build_object('error','invalid_action'); END IF;
  IF p_input ? 'ownerId' AND p_input->>'ownerId' IS NOT NULL AND p_input->>'ownerId' !~ '^[0-9]{1,32}$'
    THEN RETURN jsonb_build_object('error','invalid_action'); END IF;
  UPDATE dealguard.remediation_cases SET status=target,
    owner_id=CASE WHEN p_action='assign' AND p_input ? 'ownerId' THEN p_input->>'ownerId' ELSE owner_id END,
    owner_email=CASE WHEN p_action='assign' AND p_input ? 'ownerEmail' THEN p_input->>'ownerEmail' ELSE owner_email END,
    priority=CASE WHEN p_action='set_priority' OR p_action='assign' THEN COALESCE(p_input->>'priority',priority) ELSE priority END,
    due_at=CASE WHEN p_action IN ('assign','set_due_date') AND p_input ? 'dueAt' THEN p_input->>'dueAt' ELSE due_at END,
    acknowledged_at=CASE WHEN p_action='acknowledge' THEN COALESCE(acknowledged_at,stamp) WHEN p_action='reopen' THEN NULL ELSE acknowledged_at END,
    resolved_at=CASE WHEN p_action='resolve' THEN stamp WHEN p_action='reopen' THEN NULL ELSE resolved_at END,
    resolution_note=CASE WHEN p_action IN ('resolve','waive') THEN note WHEN p_action='reopen' THEN NULL ELSE resolution_note END,
    evidence_status=CASE WHEN p_action='reopen' AND evidence_required=1 THEN 'missing' ELSE evidence_status END,
    updated_at=stamp WHERE portal_id=p_portal AND id=p_id;
  GET DIAGNOSTICS changes=ROW_COUNT;
  IF changes<>1 THEN RAISE EXCEPTION 'Remediation transition was not accepted'; END IF;
  INSERT INTO dealguard.remediation_events(id,portal_id,case_id,action,actor_user_id,actor_email,metadata_json,created_at)
    VALUES(gen_random_uuid()::text,p_portal,p_id,p_action,p_user,p_email,p_input::text,stamp);
  INSERT INTO dealguard.audit_events(id,portal_id,user_id,user_email,action,metadata_json,created_at)
    VALUES(gen_random_uuid()::text,p_portal,p_user,p_email,'remediation.'||p_action,
      jsonb_build_object('caseId',p_id,'dealId',p_deal,'parameters',p_input)::text,stamp);
  RETURN jsonb_build_object('changed',true,'status',target);
END;
$$;
