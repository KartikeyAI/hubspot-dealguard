SET search_path TO dealguard, public;

ALTER TABLE change_approval_requests ADD COLUMN target_state_json JSONB;
ALTER TABLE change_approval_executions ADD COLUMN lease_token TEXT;

-- Role changes and approval transitions serialize on the same tenant row.
-- Stable IDs are mandatory for high-impact decisions; email never overrides a
-- different bound identity. Existing legacy administrators remain compatible.
CREATE FUNCTION dealguard.controlled_change_actor(p_portal TEXT,p_user TEXT,p_email TEXT,p_action TEXT,p_type TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SET search_path=pg_catalog,dealguard AS $$
DECLARE t dealguard.tenants%ROWTYPE; r dealguard.enterprise_role_assignments%ROWTYPE;
  g dealguard.governance_roles%ROWTYPE; role_name TEXT; permissions JSONB:='[]'::jsonb; matches INTEGER;
BEGIN
 IF p_user IS NULL OR p_user !~ '^[0-9]{1,32}$' OR p_type IS NULL OR p_type LIKE 'role.bootstrap%' THEN RETURN FALSE; END IF;
 SELECT * INTO t FROM dealguard.tenants WHERE portal_id=p_portal;
 IF NOT FOUND OR t.status<>'active' THEN RETURN FALSE; END IF;
 SELECT * INTO r FROM dealguard.enterprise_role_assignments WHERE portal_id=p_portal AND user_id=p_user;
 IF NOT FOUND AND p_email IS NOT NULL THEN
   SELECT count(*) INTO matches FROM dealguard.enterprise_role_assignments WHERE portal_id=p_portal AND lower(user_email)=lower(p_email);
   IF matches>1 THEN RETURN FALSE; END IF;
   SELECT * INTO r FROM dealguard.enterprise_role_assignments WHERE portal_id=p_portal AND lower(user_email)=lower(p_email);
   IF FOUND AND r.user_id IS NOT NULL AND r.user_id IS DISTINCT FROM p_user THEN RETURN FALSE; END IF;
 END IF;
 IF r.id IS NOT NULL THEN
   IF r.user_id IS DISTINCT FROM p_user THEN RETURN FALSE; END IF;
   IF NOT dealguard.enterprise_role_scope_valid(r.pipeline_ids_json) OR NOT dealguard.enterprise_role_scope_valid(r.owner_ids_json)
     OR NOT dealguard.enterprise_role_scope_valid(r.team_ids_json) OR NOT dealguard.enterprise_role_scope_valid(r.region_codes_json)
     OR r.pipeline_ids_json::jsonb<>'[]'::jsonb OR r.owner_ids_json::jsonb<>'[]'::jsonb
     OR r.team_ids_json::jsonb<>'[]'::jsonb OR r.region_codes_json::jsonb<>'[]'::jsonb THEN RETURN FALSE; END IF;
   role_name:=r.role; permissions:=r.permissions_json::jsonb;
   IF jsonb_typeof(permissions)<>'array' OR EXISTS(SELECT 1 FROM jsonb_array_elements(permissions) v WHERE jsonb_typeof(v)<>'string') THEN RETURN FALSE; END IF;
 ELSE
   SELECT * INTO g FROM dealguard.governance_roles WHERE portal_id=p_portal AND user_id=p_user;
   IF NOT FOUND AND p_email IS NOT NULL THEN
     SELECT count(*) INTO matches FROM dealguard.governance_roles WHERE portal_id=p_portal AND lower(user_email)=lower(p_email);
     IF matches>1 THEN RETURN FALSE; END IF;
     SELECT * INTO g FROM dealguard.governance_roles WHERE portal_id=p_portal AND lower(user_email)=lower(p_email);
     IF FOUND AND g.user_id IS NOT NULL AND g.user_id IS DISTINCT FROM p_user THEN RETURN FALSE; END IF;
   END IF;
   IF g.id IS NOT NULL THEN
     IF g.user_id IS DISTINCT FROM p_user THEN RETURN FALSE; END IF;
     IF NOT pg_input_is_valid(g.scope_json,'jsonb') THEN RETURN FALSE; END IF;
     IF g.scope_json::jsonb IS DISTINCT FROM '{}'::jsonb THEN RETURN FALSE; END IF;
     role_name:=CASE g.role WHEN 'admin' THEN 'administrator' WHEN 'policy_admin' THEN 'policy_administrator' ELSE g.role END;
   ELSIF p_action='request' AND p_email IS NOT NULL AND lower(t.installer_email)=lower(p_email)
     AND NOT EXISTS(SELECT 1 FROM dealguard.enterprise_role_assignments a WHERE a.portal_id=p_portal
       AND dealguard.enterprise_role_portal_admin(a.role,a.user_id,a.pipeline_ids_json,a.team_ids_json,a.owner_ids_json,a.region_codes_json)) THEN
     role_name:='administrator';
   ELSE RETURN FALSE; END IF;
 END IF;
 IF p_action='review' THEN RETURN role_name='administrator' OR permissions ?| ARRAY['*','change.*','change.approve']; END IF;
 IF p_action NOT IN ('request','apply') THEN RETURN FALSE; END IF;
 RETURN role_name='administrator' OR role_name='billing_administrator' AND p_type LIKE 'billing.%'
   OR role_name='compliance_auditor' AND (p_type LIKE 'compliance.%' OR p_type LIKE 'legal_hold.%' OR p_type LIKE 'siem.%')
   OR p_action='request' AND role_name='policy_administrator' AND p_type LIKE 'policy.%';
EXCEPTION WHEN invalid_text_representation THEN RETURN FALSE;
END; $$;

CREATE FUNCTION dealguard.controlled_role_target(p_portal TEXT,p_type TEXT,p_resource TEXT,p_payload JSONB)
RETURNS JSONB LANGUAGE plpgsql STABLE SET search_path=pg_catalog,dealguard AS $$
DECLARE result JSONB;
BEGIN
 IF p_type='role.remove' THEN
   SELECT to_jsonb(r) INTO result FROM dealguard.enterprise_role_assignments r WHERE portal_id=p_portal AND id=p_resource;
 ELSIF p_type='role.assign' THEN
   SELECT to_jsonb(r) INTO result FROM dealguard.enterprise_role_assignments r WHERE portal_id=p_portal
     AND (user_id=p_payload->>'userId' OR user_id IS NULL AND lower(user_email)=lower(p_payload->>'userEmail'))
     ORDER BY CASE WHEN user_id=p_payload->>'userId' THEN 0 ELSE 1 END,id LIMIT 1;
 ELSE RETURN NULL; END IF;
 RETURN COALESCE(result,'null'::jsonb);
END; $$;

CREATE FUNCTION dealguard.request_controlled_change(p_portal TEXT,p_actor TEXT,p_email TEXT,p_id TEXT,p_type TEXT,
 p_resource_type TEXT,p_resource TEXT,p_payload JSONB,p_expires TIMESTAMPTZ)
RETURNS JSONB LANGUAGE plpgsql SET search_path=pg_catalog,dealguard AS $$
DECLARE target JSONB; existing dealguard.change_approval_requests%ROWTYPE; stamp TEXT;
BEGIN
 PERFORM 1 FROM dealguard.tenants WHERE portal_id=p_portal FOR UPDATE;
 IF NOT dealguard.controlled_change_actor(p_portal,p_actor,p_email,'request',p_type) THEN RETURN jsonb_build_object('error','change_request_forbidden'); END IF;
 IF p_type IS NULL OR length(p_type) NOT BETWEEN 1 AND 100 OR p_resource_type IS NULL OR length(p_resource_type) NOT BETWEEN 1 AND 100
   OR p_resource IS NULL OR length(p_resource) NOT BETWEEN 1 AND 255 OR p_payload IS NULL
   OR p_expires IS NULL OR p_expires<=clock_timestamp() OR p_expires>clock_timestamp()+INTERVAL '7 days' THEN
   RETURN jsonb_build_object('error','change_approval_fields_required'); END IF;
 IF p_type IN ('role.assign','role.remove') THEN
   IF p_resource_type<>'enterprise_role' OR (p_type='role.assign' AND p_payload->>'userId' IS DISTINCT FROM p_resource) THEN
     RETURN jsonb_build_object('error','change_approval_fields_required'); END IF;
   target:=dealguard.controlled_role_target(p_portal,p_type,p_resource,p_payload);
   IF p_type='role.remove' AND target='null'::jsonb THEN RETURN jsonb_build_object('error','enterprise_role_not_found'); END IF;
 END IF;
 SELECT * INTO existing FROM dealguard.change_approval_requests WHERE portal_id=p_portal AND change_type=p_type
   AND resource_type=p_resource_type AND resource_id=p_resource AND requested_by_user_id=p_actor
   AND requested_payload_json::jsonb=p_payload AND target_state_json IS NOT DISTINCT FROM target
   AND status IN ('pending','approved') AND CASE WHEN pg_input_is_valid(expires_at,'timestamp with time zone')
     THEN expires_at::timestamptz>clock_timestamp() ELSE FALSE END ORDER BY requested_at DESC LIMIT 1;
 IF FOUND THEN RETURN jsonb_build_object('id',existing.id,'status',existing.status,'created',FALSE,'expiresAt',existing.expires_at); END IF;
 stamp:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 INSERT INTO dealguard.change_approval_requests(id,portal_id,change_type,resource_type,resource_id,requested_payload_json,
   status,requested_by_user_id,requested_by_email,requested_at,expires_at,target_state_json)
 VALUES(p_id,p_portal,p_type,p_resource_type,p_resource,p_payload::text,'pending',p_actor,p_email,stamp,
   to_char(p_expires AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),target);
 INSERT INTO dealguard.audit_events(id,portal_id,user_id,user_email,action,metadata_json,created_at)
 VALUES(gen_random_uuid()::text,p_portal,p_actor,p_email,'change.requested',
   jsonb_build_object('approvalId',p_id,'changeType',p_type,'resourceId',p_resource,'targetState',target)::text,stamp);
 RETURN jsonb_build_object('id',p_id,'status','pending','created',TRUE,'requestedAt',stamp,'expiresAt',p_expires);
END; $$;

CREATE FUNCTION dealguard.decide_controlled_change(p_portal TEXT,p_actor TEXT,p_email TEXT,p_id TEXT,p_decision TEXT,p_comment TEXT)
RETURNS JSONB LANGUAGE plpgsql SET search_path=pg_catalog,dealguard AS $$
DECLARE r dealguard.change_approval_requests%ROWTYPE; stamp TEXT;
BEGIN
 PERFORM 1 FROM dealguard.tenants WHERE portal_id=p_portal FOR UPDATE;
 SELECT * INTO r FROM dealguard.change_approval_requests WHERE portal_id=p_portal AND id=p_id FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('error','change_approval_not_found'); END IF;
 IF NOT dealguard.controlled_change_actor(p_portal,p_actor,p_email,'review',r.change_type) THEN RETURN jsonb_build_object('error','change_review_forbidden'); END IF;
 IF p_decision NOT IN ('approved','rejected') THEN RETURN jsonb_build_object('error','change_approval_fields_required'); END IF;
 IF r.status<>'pending' THEN RETURN jsonb_build_object('error','change_approval_decided'); END IF;
 IF r.requested_by_user_id IS NULL OR r.requested_by_user_id=p_actor
   OR p_email IS NOT NULL AND lower(r.requested_by_email)=lower(p_email) THEN RETURN jsonb_build_object('error','change_self_approval_forbidden'); END IF;
 IF r.expires_at IS NULL OR NOT pg_input_is_valid(r.expires_at,'timestamp with time zone') THEN RETURN jsonb_build_object('error','change_approval_expired'); END IF;
 IF r.expires_at::timestamptz<=clock_timestamp() THEN RETURN jsonb_build_object('error','change_approval_expired'); END IF;
 IF NOT dealguard.controlled_change_actor(p_portal,r.requested_by_user_id,r.requested_by_email,'request',r.change_type) THEN
   RETURN jsonb_build_object('error','change_requester_revoked'); END IF;
 IF r.change_type IN ('role.assign','role.remove') AND (r.target_state_json IS NULL
   OR r.target_state_json IS DISTINCT FROM dealguard.controlled_role_target(p_portal,r.change_type,r.resource_id,r.requested_payload_json::jsonb)) THEN
   RETURN jsonb_build_object('error','change_approval_target_changed'); END IF;
 stamp:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 UPDATE dealguard.change_approval_requests SET status=p_decision,decided_by_user_id=p_actor,decided_by_email=p_email,
   decision_comment=left(COALESCE(p_comment,''),2000),decided_at=stamp WHERE portal_id=p_portal AND id=p_id;
 INSERT INTO dealguard.audit_events(id,portal_id,user_id,user_email,action,metadata_json,created_at)
 VALUES(gen_random_uuid()::text,p_portal,p_actor,p_email,'change_approval.'||p_decision,
   jsonb_build_object('approvalId',p_id,'comment',left(COALESCE(p_comment,''),2000))::text,stamp);
 RETURN jsonb_build_object('id',p_id,'status',p_decision,'decidedAt',stamp);
END; $$;

CREATE FUNCTION dealguard.claim_controlled_change(p_portal TEXT,p_actor TEXT,p_email TEXT,p_id TEXT,p_type TEXT,
 p_resource_type TEXT,p_resource TEXT,p_payload JSONB,p_token TEXT)
RETURNS JSONB LANGUAGE plpgsql SET search_path=pg_catalog,dealguard AS $$
DECLARE r dealguard.change_approval_requests%ROWTYPE; e dealguard.change_approval_executions%ROWTYPE; stamp TEXT; expiry TEXT;
BEGIN
 PERFORM 1 FROM dealguard.tenants WHERE portal_id=p_portal FOR UPDATE;
 IF NOT dealguard.controlled_change_actor(p_portal,p_actor,p_email,'apply',p_type) THEN RETURN jsonb_build_object('error','change_apply_forbidden'); END IF;
 SELECT * INTO r FROM dealguard.change_approval_requests WHERE portal_id=p_portal AND id=p_id FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('error','change_approval_not_found'); END IF;
 IF r.status='applied' THEN RETURN jsonb_build_object('error','change_already_applied'); END IF;
 IF r.status<>'approved' THEN RETURN jsonb_build_object('error','change_not_approved'); END IF;
 IF r.change_type<>p_type OR r.resource_type<>p_resource_type OR r.resource_id<>p_resource
   OR r.requested_payload_json::jsonb IS DISTINCT FROM p_payload THEN RETURN jsonb_build_object('error','change_approval_payload_mismatch'); END IF;
 IF r.expires_at IS NULL OR NOT pg_input_is_valid(r.expires_at,'timestamp with time zone') THEN RETURN jsonb_build_object('error','change_approval_expired'); END IF;
 IF r.expires_at::timestamptz<=clock_timestamp() THEN RETURN jsonb_build_object('error','change_approval_expired'); END IF;
 IF r.requested_by_user_id IS NULL OR r.decided_by_user_id IS NULL OR r.requested_by_user_id=r.decided_by_user_id
   OR r.requested_by_email IS NOT NULL AND lower(r.requested_by_email)=lower(r.decided_by_email)
   OR NOT dealguard.controlled_change_actor(p_portal,r.requested_by_user_id,r.requested_by_email,'request',r.change_type)
   OR NOT dealguard.controlled_change_actor(p_portal,r.decided_by_user_id,r.decided_by_email,'review',r.change_type) THEN
   RETURN jsonb_build_object('error','change_approval_authority_changed'); END IF;
 IF r.change_type IN ('role.assign','role.remove') AND (r.target_state_json IS NULL
   OR r.target_state_json IS DISTINCT FROM dealguard.controlled_role_target(p_portal,r.change_type,r.resource_id,p_payload)) THEN
   RETURN jsonb_build_object('error','change_approval_target_changed'); END IF;
 SELECT * INTO e FROM dealguard.change_approval_executions WHERE portal_id=p_portal AND approval_id=p_id FOR UPDATE;
 IF FOUND AND e.status='completed' THEN RETURN jsonb_build_object('error','change_already_applied'); END IF;
 IF FOUND AND e.status='applying' AND (CASE WHEN pg_input_is_valid(e.lease_expires_at,'timestamp with time zone')
   THEN e.lease_expires_at::timestamptz>clock_timestamp() ELSE FALSE END) THEN
   RETURN jsonb_build_object('error','change_application_in_progress'); END IF;
 IF p_token IS NULL OR length(p_token) NOT BETWEEN 1 AND 128 THEN RETURN jsonb_build_object('error','change_execution_invalid'); END IF;
 stamp:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 expiry:=to_char((clock_timestamp()+INTERVAL '10 minutes') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 INSERT INTO dealguard.change_approval_executions(approval_id,portal_id,status,attempts,lease_expires_at,started_at,applied_by_user_id,applied_by_email,updated_at,lease_token)
 VALUES(p_id,p_portal,'applying',1,expiry,stamp,p_actor,p_email,stamp,p_token)
 ON CONFLICT(approval_id)DO UPDATE SET status='applying',attempts=change_approval_executions.attempts+1,lease_expires_at=expiry,
   applied_by_user_id=p_actor,applied_by_email=p_email,updated_at=stamp,lease_token=p_token,error_message=NULL;
 INSERT INTO dealguard.audit_events(id,portal_id,user_id,user_email,action,metadata_json,created_at)
 VALUES(gen_random_uuid()::text,p_portal,p_actor,p_email,'change.application_started',jsonb_build_object('approvalId',p_id,'changeType',p_type)::text,stamp);
 RETURN jsonb_build_object('approvalId',p_id,'leaseToken',p_token,'startedAt',stamp);
END; $$;

CREATE FUNCTION dealguard.finish_controlled_change(p_portal TEXT,p_actor TEXT,p_email TEXT,p_id TEXT,p_token TEXT,p_success BOOLEAN,p_error TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SET search_path=pg_catalog,dealguard AS $$
DECLARE e dealguard.change_approval_executions%ROWTYPE; stamp TEXT;
BEGIN
 IF p_actor IS NULL OR p_actor !~ '^[0-9]{1,32}$' OR p_token IS NULL OR length(p_token) NOT BETWEEN 1 AND 128 OR p_success IS NULL THEN RETURN FALSE; END IF;
 PERFORM 1 FROM dealguard.tenants WHERE portal_id=p_portal FOR UPDATE;
 SELECT * INTO e FROM dealguard.change_approval_executions WHERE portal_id=p_portal AND approval_id=p_id FOR UPDATE;
 IF NOT FOUND OR e.status<>'applying' OR e.lease_token IS DISTINCT FROM p_token OR e.applied_by_user_id IS DISTINCT FROM p_actor THEN RETURN FALSE; END IF;
 IF NOT EXISTS(SELECT 1 FROM dealguard.change_approval_requests WHERE portal_id=p_portal AND id=p_id AND status='approved') THEN RETURN FALSE; END IF;
 stamp:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 UPDATE dealguard.change_approval_executions SET status=CASE WHEN p_success THEN 'completed' ELSE 'failed' END,
   completed_at=CASE WHEN p_success THEN stamp ELSE NULL END,lease_expires_at=NULL,updated_at=stamp,
   error_message=CASE WHEN p_success THEN NULL ELSE left(COALESCE(p_error,'change_application_failed'),128) END
 WHERE portal_id=p_portal AND approval_id=p_id;
 IF p_success THEN UPDATE dealguard.change_approval_requests SET status='applied',applied_at=stamp WHERE portal_id=p_portal AND id=p_id; END IF;
 INSERT INTO dealguard.audit_events(id,portal_id,user_id,user_email,action,metadata_json,created_at)
 VALUES(gen_random_uuid()::text,p_portal,p_actor,p_email,CASE WHEN p_success THEN 'change.applied' ELSE 'change.application_failed' END,
   jsonb_build_object('approvalId',p_id,'errorCode',CASE WHEN p_success THEN NULL ELSE left(p_error,128) END)::text,stamp);
 RETURN TRUE;
END; $$;

-- Bind the mutation's normalized values to the approved raw payload inside the
-- same database boundary. A future caller must not approve one role/subject and
-- supply a different normalized role, identity, permission or data scope.
CREATE FUNCTION dealguard.normalize_controlled_role_assignment(p_payload JSONB)
RETURNS JSONB LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,dealguard AS $$
DECLARE permissions JSONB; scopes JSONB:='{}'::jsonb; values_json JSONB; scope_key TEXT; normalized_values JSONB;
BEGIN
 IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object'
   OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_payload) k WHERE k NOT IN ('userId','userEmail','role','permissions','scope'))
   OR jsonb_typeof(p_payload->'userId') IS DISTINCT FROM 'string' OR jsonb_typeof(p_payload->'role') IS DISTINCT FROM 'string'
   OR (p_payload ? 'userEmail' AND jsonb_typeof(p_payload->'userEmail') NOT IN ('string','null'))
   OR jsonb_typeof(p_payload->'scope') IS DISTINCT FROM 'object'
   OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_payload->'scope') k WHERE k NOT IN ('pipelineIds','teamIds','ownerIds','regionCodes')) THEN RETURN NULL; END IF;
 values_json:=COALESCE(p_payload->'permissions','[]'::jsonb);
 IF jsonb_typeof(values_json)<>'array' OR jsonb_array_length(values_json)>3 THEN RETURN NULL; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(values_json) v WHERE jsonb_typeof(v)<>'string') THEN RETURN NULL; END IF;
 SELECT COALESCE(jsonb_agg(value ORDER BY first_seen),'[]'::jsonb) INTO permissions
   FROM (SELECT value,min(ordinality) AS first_seen FROM jsonb_array_elements(values_json) WITH ORDINALITY GROUP BY value) d;
 FOREACH scope_key IN ARRAY ARRAY['pipelineIds','teamIds','ownerIds','regionCodes'] LOOP
   values_json:=p_payload->'scope'->scope_key;
   IF jsonb_typeof(values_json) IS DISTINCT FROM 'array' OR jsonb_array_length(values_json)>500 THEN RETURN NULL; END IF;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(values_json) v WHERE jsonb_typeof(v)<>'string') THEN RETURN NULL; END IF;
   SELECT COALESCE(jsonb_agg(value ORDER BY first_seen),'[]'::jsonb) INTO normalized_values
     FROM (SELECT value,min(ordinality) AS first_seen FROM jsonb_array_elements(values_json) WITH ORDINALITY GROUP BY value) d;
   scopes:=scopes||jsonb_build_object(scope_key,normalized_values);
 END LOOP;
 RETURN jsonb_build_object('userId',p_payload->'userId','role',p_payload->'role',
   'userEmail',lower(btrim(p_payload->>'userEmail')),'permissions',permissions,'scope',scopes);
END; $$;

CREATE FUNCTION dealguard.apply_approved_enterprise_role(p_portal TEXT,p_actor TEXT,p_email TEXT,p_id TEXT,p_type TEXT,
 p_resource TEXT,p_expected JSONB,p_normalized JSONB,p_token TEXT)
RETURNS JSONB LANGUAGE plpgsql SET search_path=pg_catalog,dealguard AS $$
DECLARE claimed JSONB; mutation JSONB; error_code TEXT; approved_normalized JSONB;
BEGIN
 IF p_type IS NULL OR p_type NOT IN ('role.assign','role.remove') THEN RETURN jsonb_build_object('error','change_approval_fields_required'); END IF;
 approved_normalized:=CASE WHEN p_type='role.assign' THEN dealguard.normalize_controlled_role_assignment(p_expected) ELSE '{}'::jsonb END;
 IF approved_normalized IS NULL OR p_normalized IS DISTINCT FROM approved_normalized THEN
   RETURN jsonb_build_object('error','change_approval_payload_mismatch'); END IF;
 claimed:=dealguard.claim_controlled_change(p_portal,p_actor,p_email,p_id,p_type,'enterprise_role',p_resource,p_expected,p_token);
 IF claimed ? 'error' THEN RETURN claimed; END IF;
 mutation:=dealguard.mutate_enterprise_role(p_portal,p_actor,p_email,FALSE,
   CASE WHEN p_type='role.assign' THEN 'assign' ELSE 'remove' END,
   CASE WHEN p_type='role.assign' THEN p_normalized ELSE jsonb_build_object('assignmentId',p_resource) END);
 IF mutation ? 'error' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE=mutation->>'error'; END IF;
 IF NOT dealguard.finish_controlled_change(p_portal,p_actor,p_email,p_id,p_token,TRUE,NULL) THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='change_completion_conflict'; END IF;
 RETURN jsonb_build_object('ok',TRUE,'approvalId',p_id,'assignmentId',mutation->>'assignmentId');
EXCEPTION WHEN raise_exception THEN
 GET STACKED DIAGNOSTICS error_code=MESSAGE_TEXT;
 IF error_code IN ('last_administrator_protection','enterprise_role_binding_conflict','enterprise_role_input_invalid',
   'enterprise_permission_denied','enterprise_scope_denied','enterprise_role_authorization_changed','change_completion_conflict') THEN
   RETURN jsonb_build_object('error',error_code);
 END IF;
 RAISE;
END; $$;
