SET search_path TO dealguard, public;

-- All application role changes use the tenant row as their serialization point.
-- The helpers use invoker rights and never infer an identity from an email that
-- is already attached to another stable HubSpot user ID.
CREATE FUNCTION dealguard.enterprise_role_scope_valid(p_value TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,dealguard AS $$
DECLARE j JSONB;
BEGIN
  j:=p_value::jsonb;
  IF j IS NULL OR jsonb_typeof(j)<>'array' THEN RETURN FALSE; END IF;
  IF jsonb_array_length(j)>500 THEN RETURN FALSE; END IF;
  RETURN NOT EXISTS(SELECT 1 FROM jsonb_array_elements(j) v WHERE jsonb_typeof(v)<>'string'
    OR length(v#>>'{}') NOT BETWEEN 1 AND 128 OR btrim(v#>>'{}')<>v#>>'{}');
EXCEPTION WHEN invalid_text_representation THEN RETURN FALSE;
END; $$;

CREATE FUNCTION dealguard.enterprise_role_portal_admin(p_role TEXT,p_user TEXT,p_pipeline TEXT,p_team TEXT,p_owner TEXT,p_region TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,dealguard AS $$
BEGIN
  IF p_role IS DISTINCT FROM 'administrator' OR p_user IS NULL OR p_user !~ '^[0-9]{1,32}$' THEN RETURN FALSE; END IF;
  RETURN COALESCE(p_pipeline::jsonb='[]'::jsonb AND p_team::jsonb='[]'::jsonb
    AND p_owner::jsonb='[]'::jsonb AND p_region::jsonb='[]'::jsonb,FALSE);
EXCEPTION WHEN invalid_text_representation THEN RETURN FALSE;
END; $$;

CREATE FUNCTION dealguard.enterprise_role_manager_state(p_portal TEXT,p_user TEXT,p_email TEXT)
RETURNS JSONB LANGUAGE plpgsql SET search_path=pg_catalog,dealguard AS $$
DECLARE t dealguard.tenants%ROWTYPE; r dealguard.enterprise_role_assignments%ROWTYPE;
  g dealguard.governance_roles%ROWTYPE; matches INTEGER; permissions JSONB;
BEGIN
  IF (p_user IS NULL AND p_email IS NULL) OR (p_user IS NOT NULL AND p_user !~ '^[0-9]{1,32}$')
    OR (p_email IS NOT NULL AND (length(p_email)>254 OR p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')) THEN
    RETURN jsonb_build_object('error','identified_user_required');
  END IF;
  SELECT * INTO t FROM dealguard.tenants WHERE portal_id=p_portal;
  IF NOT FOUND OR t.status<>'active' THEN RETURN jsonb_build_object('error','installation_inactive'); END IF;
  SELECT * INTO r FROM dealguard.enterprise_role_assignments WHERE portal_id=p_portal AND user_id=p_user FOR SHARE;
  IF NOT FOUND AND p_email IS NOT NULL THEN
    SELECT count(*) INTO matches FROM dealguard.enterprise_role_assignments WHERE portal_id=p_portal AND lower(user_email)=lower(p_email);
    IF matches>1 THEN RETURN jsonb_build_object('error','enterprise_permission_denied'); END IF;
    SELECT * INTO r FROM dealguard.enterprise_role_assignments WHERE portal_id=p_portal AND lower(user_email)=lower(p_email) FOR SHARE;
    IF FOUND AND r.user_id IS NOT NULL AND r.user_id IS DISTINCT FROM p_user THEN RETURN jsonb_build_object('error','enterprise_permission_denied'); END IF;
  END IF;
  IF r.id IS NOT NULL THEN
    IF NOT dealguard.enterprise_role_scope_valid(r.pipeline_ids_json) OR NOT dealguard.enterprise_role_scope_valid(r.team_ids_json)
      OR NOT dealguard.enterprise_role_scope_valid(r.owner_ids_json) OR NOT dealguard.enterprise_role_scope_valid(r.region_codes_json) THEN
      RETURN jsonb_build_object('error','enterprise_scope_denied');
    END IF;
    IF r.pipeline_ids_json::jsonb<>'[]'::jsonb OR r.team_ids_json::jsonb<>'[]'::jsonb
      OR r.owner_ids_json::jsonb<>'[]'::jsonb OR r.region_codes_json::jsonb<>'[]'::jsonb THEN
      RETURN jsonb_build_object('error','enterprise_scope_denied');
    END IF;
    IF NOT pg_input_is_valid(r.permissions_json,'jsonb') THEN RETURN jsonb_build_object('error','enterprise_permission_denied'); END IF;
    permissions:=r.permissions_json::jsonb;
    IF jsonb_typeof(permissions)<>'array' THEN RETURN jsonb_build_object('error','enterprise_permission_denied'); END IF;
    IF jsonb_array_length(permissions)>250 OR EXISTS(SELECT 1 FROM jsonb_array_elements(permissions) v WHERE jsonb_typeof(v)<>'string') THEN
      RETURN jsonb_build_object('error','enterprise_permission_denied');
    END IF;
    IF r.role='administrator' OR permissions ?| ARRAY['*','role.*','role.manage'] THEN
      RETURN jsonb_build_object('bootstrap',FALSE,'explicitAssignment',TRUE);
    END IF;
    RETURN jsonb_build_object('error','enterprise_permission_denied');
  END IF;
  SELECT * INTO g FROM dealguard.governance_roles WHERE portal_id=p_portal AND user_id=p_user FOR SHARE;
  IF NOT FOUND AND p_email IS NOT NULL THEN
    SELECT count(*) INTO matches FROM dealguard.governance_roles WHERE portal_id=p_portal AND lower(user_email)=lower(p_email);
    IF matches>1 THEN RETURN jsonb_build_object('error','enterprise_permission_denied'); END IF;
    SELECT * INTO g FROM dealguard.governance_roles WHERE portal_id=p_portal AND lower(user_email)=lower(p_email) FOR SHARE;
    IF FOUND AND g.user_id IS NOT NULL AND g.user_id IS DISTINCT FROM p_user THEN RETURN jsonb_build_object('error','enterprise_permission_denied'); END IF;
  END IF;
  IF g.id IS NOT NULL THEN
    IF g.role='admin' THEN RETURN jsonb_build_object('bootstrap',FALSE,'explicitAssignment',FALSE); END IF;
    RETURN jsonb_build_object('error','enterprise_permission_denied');
  END IF;
  IF p_email IS NOT NULL AND lower(t.installer_email)=lower(p_email) AND NOT EXISTS(
    SELECT 1 FROM dealguard.enterprise_role_assignments a WHERE a.portal_id=p_portal AND
      dealguard.enterprise_role_portal_admin(a.role,a.user_id,a.pipeline_ids_json,a.team_ids_json,a.owner_ids_json,a.region_codes_json)) THEN
    RETURN jsonb_build_object('bootstrap',TRUE,'explicitAssignment',FALSE);
  END IF;
  RETURN jsonb_build_object('error','enterprise_permission_denied');
END; $$;

CREATE FUNCTION dealguard.list_enterprise_roles(p_portal TEXT,p_user TEXT,p_email TEXT)
RETURNS JSONB LANGUAGE plpgsql SET search_path=pg_catalog,dealguard AS $$
DECLARE actor JSONB; assignments JSONB;
BEGIN
  PERFORM 1 FROM dealguard.tenants WHERE portal_id=p_portal FOR SHARE;
  actor:=dealguard.enterprise_role_manager_state(p_portal,p_user,p_email);
  IF actor ? 'error' THEN RETURN actor; END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.role,lower(COALESCE(r.user_email,'')),r.id),'[]'::jsonb)
    INTO assignments FROM dealguard.enterprise_role_assignments r WHERE portal_id=p_portal;
  RETURN jsonb_build_object('roles',assignments);
END; $$;

CREATE FUNCTION dealguard.mutate_enterprise_role(p_portal TEXT,p_user TEXT,p_email TEXT,p_bootstrap BOOLEAN,p_action TEXT,p_input JSONB)
RETURNS JSONB LANGUAGE plpgsql SET search_path=pg_catalog,dealguard AS $$
DECLARE actor JSONB; old_row dealguard.enterprise_role_assignments%ROWTYPE;
  by_id dealguard.enterprise_role_assignments%ROWTYPE; by_email dealguard.enterprise_role_assignments%ROWTYPE;
  new_row dealguard.enterprise_role_assignments%ROWTYPE; matches INTEGER; stamp TEXT;
  target_user TEXT; target_email TEXT; target_role TEXT; target_scope JSONB; target_permissions JSONB;
  scope_key TEXT; target_id TEXT; audit_action TEXT;
BEGIN
  PERFORM 1 FROM dealguard.tenants WHERE portal_id=p_portal FOR UPDATE;
  actor:=dealguard.enterprise_role_manager_state(p_portal,p_user,p_email);
  IF actor ? 'error' THEN RETURN actor; END IF;
  IF (actor->>'bootstrap')::boolean IS DISTINCT FROM p_bootstrap THEN RETURN jsonb_build_object('error','enterprise_role_authorization_changed'); END IF;
  IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' THEN RETURN jsonb_build_object('error','enterprise_role_input_invalid'); END IF;
  IF p_action='assign' THEN
    IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k NOT IN ('userId','userEmail','role','permissions','scope')) THEN
      RETURN jsonb_build_object('error','enterprise_role_input_invalid');
    END IF;
    target_user:=p_input->>'userId'; target_email:=lower(p_input->>'userEmail'); target_role:=p_input->>'role';
    target_scope:=p_input->'scope'; target_permissions:=p_input->'permissions';
    IF jsonb_typeof(p_input->'userId') IS DISTINCT FROM 'string' OR target_user !~ '^[0-9]{1,32}$'
      OR target_role IS NULL OR target_role NOT IN ('administrator','policy_administrator','revops_manager','sales_manager','reviewer','remediation_manager','compliance_auditor','billing_administrator','viewer')
      OR (target_email IS NOT NULL AND (jsonb_typeof(p_input->'userEmail')<>'string' OR length(target_email)>254
        OR target_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'))
      OR jsonb_typeof(target_scope) IS DISTINCT FROM 'object' OR jsonb_typeof(target_permissions) IS DISTINCT FROM 'array' THEN
      RETURN jsonb_build_object('error','enterprise_role_input_invalid');
    END IF;
    IF jsonb_array_length(target_permissions)>3 OR EXISTS(SELECT 1 FROM jsonb_array_elements(target_permissions) v
      WHERE jsonb_typeof(v)<>'string' OR v#>>'{}' NOT IN ('forecast.approve','ai.use','breeze.use'))
      OR EXISTS(SELECT 1 FROM jsonb_object_keys(target_scope) k WHERE k NOT IN ('pipelineIds','teamIds','ownerIds','regionCodes')) THEN
      RETURN jsonb_build_object('error','enterprise_role_input_invalid');
    END IF;
    FOREACH scope_key IN ARRAY ARRAY['pipelineIds','teamIds','ownerIds','regionCodes'] LOOP
      IF NOT dealguard.enterprise_role_scope_valid((target_scope->scope_key)::text) THEN RETURN jsonb_build_object('error','enterprise_role_input_invalid'); END IF;
    END LOOP;
    IF p_bootstrap AND NOT dealguard.enterprise_role_portal_admin(target_role,target_user,(target_scope->'pipelineIds')::text,
      (target_scope->'teamIds')::text,(target_scope->'ownerIds')::text,(target_scope->'regionCodes')::text) THEN
      RETURN jsonb_build_object('error','enterprise_bootstrap_administrator_required');
    END IF;
    SELECT * INTO by_id FROM dealguard.enterprise_role_assignments WHERE portal_id=p_portal AND user_id=target_user FOR UPDATE;
    IF target_email IS NOT NULL THEN
      SELECT count(*) INTO matches FROM dealguard.enterprise_role_assignments WHERE portal_id=p_portal AND lower(user_email)=target_email;
      IF matches>1 THEN RETURN jsonb_build_object('error','enterprise_role_binding_conflict'); END IF;
      SELECT * INTO by_email FROM dealguard.enterprise_role_assignments WHERE portal_id=p_portal AND lower(user_email)=target_email FOR UPDATE;
      IF by_email.id IS NOT NULL AND (by_email.user_id IS NOT NULL AND by_email.user_id IS DISTINCT FROM target_user
        OR by_id.id IS NOT NULL AND by_id.id IS DISTINCT FROM by_email.id) THEN
        RETURN jsonb_build_object('error','enterprise_role_binding_conflict');
      END IF;
    END IF;
    IF by_id.id IS NOT NULL THEN old_row:=by_id; ELSE old_row:=by_email; END IF;
    target_id:=COALESCE(old_row.id,gen_random_uuid()::text);
    IF old_row.role='administrator' AND NOT dealguard.enterprise_role_portal_admin(target_role,target_user,(target_scope->'pipelineIds')::text,
      (target_scope->'teamIds')::text,(target_scope->'ownerIds')::text,(target_scope->'regionCodes')::text)
      AND NOT EXISTS(SELECT 1 FROM dealguard.enterprise_role_assignments a WHERE a.portal_id=p_portal AND a.id<>target_id
        AND dealguard.enterprise_role_portal_admin(a.role,a.user_id,a.pipeline_ids_json,a.team_ids_json,a.owner_ids_json,a.region_codes_json)) THEN
      RETURN jsonb_build_object('error','last_administrator_protection');
    END IF;
  ELSIF p_action='remove' THEN
    IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k<>'assignmentId')
      OR jsonb_typeof(p_input->'assignmentId') IS DISTINCT FROM 'string' OR length(p_input->>'assignmentId') NOT BETWEEN 1 AND 128 THEN
      RETURN jsonb_build_object('error','enterprise_role_input_invalid');
    END IF;
    IF p_bootstrap THEN RETURN jsonb_build_object('error','enterprise_bootstrap_administrator_required'); END IF;
    target_id:=p_input->>'assignmentId';
    SELECT * INTO old_row FROM dealguard.enterprise_role_assignments WHERE portal_id=p_portal AND id=target_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('error','enterprise_role_not_found'); END IF;
    IF old_row.role='administrator' AND NOT EXISTS(SELECT 1 FROM dealguard.enterprise_role_assignments a WHERE a.portal_id=p_portal AND a.id<>target_id
      AND dealguard.enterprise_role_portal_admin(a.role,a.user_id,a.pipeline_ids_json,a.team_ids_json,a.owner_ids_json,a.region_codes_json)) THEN
      RETURN jsonb_build_object('error','last_administrator_protection');
    END IF;
  ELSE RETURN jsonb_build_object('error','enterprise_role_input_invalid');
  END IF;
  stamp:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  IF p_action='assign' THEN
    IF old_row.id IS NULL THEN
      INSERT INTO dealguard.enterprise_role_assignments(id,portal_id,user_id,user_email,role,permissions_json,pipeline_ids_json,team_ids_json,owner_ids_json,region_codes_json,
        created_by_user_id,created_by_email,created_at,updated_at)
      VALUES(target_id,p_portal,target_user,target_email,target_role,target_permissions::text,(target_scope->'pipelineIds')::text,(target_scope->'teamIds')::text,
        (target_scope->'ownerIds')::text,(target_scope->'regionCodes')::text,p_user,p_email,stamp,stamp) RETURNING * INTO new_row;
    ELSE
      UPDATE dealguard.enterprise_role_assignments SET user_id=target_user,user_email=target_email,role=target_role,permissions_json=target_permissions::text,
        pipeline_ids_json=(target_scope->'pipelineIds')::text,team_ids_json=(target_scope->'teamIds')::text,
        owner_ids_json=(target_scope->'ownerIds')::text,region_codes_json=(target_scope->'regionCodes')::text,updated_at=stamp
        WHERE portal_id=p_portal AND id=target_id RETURNING * INTO new_row;
    END IF;
    audit_action:='enterprise_role.assigned';
  ELSE
    DELETE FROM dealguard.enterprise_role_assignments WHERE portal_id=p_portal AND id=target_id;
    audit_action:='enterprise_role.removed';
  END IF;
  INSERT INTO dealguard.audit_events(id,portal_id,user_id,user_email,action,metadata_json,created_at)
    VALUES(gen_random_uuid()::text,p_portal,p_user,p_email,audit_action,
      jsonb_build_object('assignmentId',target_id,'bootstrap',p_bootstrap,
        'before',CASE WHEN old_row.id IS NULL THEN NULL ELSE to_jsonb(old_row) END,
        'after',CASE WHEN p_action='remove' THEN NULL ELSE to_jsonb(new_row) END)::text,stamp);
  RETURN jsonb_build_object('assignmentId',target_id,'created',old_row.id IS NULL);
EXCEPTION WHEN unique_violation THEN RETURN jsonb_build_object('error','enterprise_role_binding_conflict');
END; $$;
