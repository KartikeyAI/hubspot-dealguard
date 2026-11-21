SET search_path TO dealguard, public;

-- Initial enterprise administration needs two signed people before either gains
-- an enterprise role. This dedicated approval cannot grant arbitrary permissions.
CREATE UNIQUE INDEX idx_enterprise_bootstrap_pending ON change_approval_requests(portal_id)
  WHERE change_type='role.bootstrap' AND status='pending';

CREATE FUNCTION dealguard.enterprise_bootstrap_identity_valid(p_user TEXT,p_email TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(p_user ~ '^[1-9][0-9]{0,29}$' AND length(p_email)<=254
    AND p_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$',FALSE);
$$;

CREATE FUNCTION dealguard.enterprise_bootstrap_initialized(p_portal TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SET search_path=pg_catalog,dealguard AS $$
  SELECT EXISTS(SELECT 1 FROM dealguard.enterprise_role_assignments r WHERE r.portal_id=p_portal
    AND dealguard.enterprise_role_portal_admin(r.role,r.user_id,r.pipeline_ids_json,r.team_ids_json,r.owner_ids_json,r.region_codes_json));
$$;

CREATE FUNCTION dealguard.enterprise_bootstrap_nominee_available(p_portal TEXT,p_user TEXT,p_email TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SET search_path=pg_catalog,dealguard AS $$
DECLARE g dealguard.governance_roles%ROWTYPE; matches INTEGER;
BEGIN
  IF NOT dealguard.enterprise_bootstrap_identity_valid(p_user,p_email) THEN RETURN FALSE; END IF;
  IF EXISTS(SELECT 1 FROM dealguard.enterprise_role_assignments WHERE portal_id=p_portal
      AND (user_id=p_user OR lower(user_email)=lower(p_email))) THEN RETURN FALSE; END IF;
  SELECT count(*) INTO matches FROM dealguard.governance_roles WHERE portal_id=p_portal
    AND (user_id=p_user OR lower(user_email)=lower(p_email));
  IF matches=0 THEN RETURN TRUE; END IF;
  IF matches<>1 THEN RETURN FALSE; END IF;
  SELECT * INTO g FROM dealguard.governance_roles WHERE portal_id=p_portal
    AND (user_id=p_user OR lower(user_email)=lower(p_email));
  RETURN COALESCE(g.user_id=p_user AND (g.user_email IS NULL OR lower(g.user_email)=lower(p_email)) AND g.role<>'admin',FALSE);
END; $$;

CREATE FUNCTION dealguard.enterprise_bootstrap_requester_allowed(p_portal TEXT,p_user TEXT,p_email TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SET search_path=pg_catalog,dealguard AS $$
DECLARE t dealguard.tenants%ROWTYPE; g dealguard.governance_roles%ROWTYPE; matches INTEGER; admins INTEGER;
BEGIN
  IF NOT dealguard.enterprise_bootstrap_identity_valid(p_user,p_email) OR dealguard.enterprise_bootstrap_initialized(p_portal) THEN RETURN FALSE; END IF;
  SELECT * INTO t FROM dealguard.tenants WHERE portal_id=p_portal;
  IF NOT FOUND OR t.status<>'active' THEN RETURN FALSE; END IF;
  IF EXISTS(SELECT 1 FROM dealguard.enterprise_role_assignments WHERE portal_id=p_portal
      AND (user_id=p_user OR lower(user_email)=lower(p_email))) THEN RETURN FALSE; END IF;
  SELECT count(*) INTO matches FROM dealguard.governance_roles WHERE portal_id=p_portal
    AND (user_id=p_user OR lower(user_email)=lower(p_email));
  SELECT count(*) INTO admins FROM dealguard.governance_roles WHERE portal_id=p_portal AND role='admin';
  IF matches=0 THEN RETURN COALESCE(admins=0 AND lower(t.installer_email)=lower(p_email),FALSE); END IF;
  IF matches<>1 OR admins<>1 THEN RETURN FALSE; END IF;
  SELECT * INTO g FROM dealguard.governance_roles WHERE portal_id=p_portal
    AND (user_id=p_user OR lower(user_email)=lower(p_email));
  -- A sole, stable legacy administrator can migrate with a second signed person.
  -- Recorded legacy scope restrictions and email-only/ambiguous bindings fail shut.
  IF g.user_id IS DISTINCT FROM p_user OR (g.user_email IS NOT NULL AND lower(g.user_email)<>lower(p_email))
    OR g.role<>'admin' OR NOT pg_input_is_valid(g.scope_json,'jsonb') THEN RETURN FALSE; END IF;
  RETURN g.scope_json::jsonb='{}'::jsonb;
END; $$;

CREATE FUNCTION dealguard.enterprise_bootstrap_payload(p_portal TEXT,p_epoch TIMESTAMPTZ,p_installer TEXT,
  p_requester TEXT,p_requester_email TEXT,p_nominee TEXT,p_nominee_email TEXT,p_requested TEXT,p_expires TEXT)
RETURNS JSONB LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('schema','dealguard-enterprise-role-bootstrap-v1','portalId',p_portal,
    'authorizationEpoch',to_char(p_epoch AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'installationInstallerEmail',lower(p_installer),
    'requester',jsonb_build_object('userId',p_requester,'userEmail',lower(p_requester_email)),
    'nominee',jsonb_build_object('userId',p_nominee,'userEmail',lower(p_nominee_email)),
    'role','administrator','permissions','[]'::jsonb,
    'scope',jsonb_build_object('pipelineIds','[]'::jsonb,'teamIds','[]'::jsonb,'ownerIds','[]'::jsonb,'regionCodes','[]'::jsonb),
    'requestedAt',p_requested,'expiresAt',p_expires);
$$;

CREATE FUNCTION dealguard.enterprise_bootstrap_proposal_valid(t dealguard.tenants,r dealguard.change_approval_requests)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SET search_path=pg_catalog,dealguard AS $$
DECLARE payload JSONB; expected JSONB; fingerprint TEXT; nominee TEXT; nominee_email TEXT;
BEGIN
  IF t.status<>'active' OR r.portal_id IS DISTINCT FROM t.portal_id OR r.change_type<>'role.bootstrap'
    OR r.resource_type<>'enterprise_role_pair' OR r.resource_id IS DISTINCT FROM t.portal_id OR r.status<>'pending'
    OR r.expires_at IS NULL OR NOT pg_input_is_valid(r.expires_at,'timestamptz')
    OR NOT pg_input_is_valid(r.requested_at,'timestamptz') OR NOT pg_input_is_valid(r.requested_payload_json,'jsonb') THEN RETURN FALSE; END IF;
  IF r.expires_at::timestamptz<=clock_timestamp() OR r.requested_at::timestamptz>clock_timestamp()
    OR r.requested_at::timestamptz<t.authorization_epoch_at
    OR r.expires_at::timestamptz<=r.requested_at::timestamptz
    OR r.expires_at::timestamptz>r.requested_at::timestamptz+INTERVAL '1 hour' THEN RETURN FALSE; END IF;
  payload:=r.requested_payload_json::jsonb;
  IF jsonb_typeof(payload)<>'object' THEN RETURN FALSE; END IF;
  fingerprint:=payload->>'payloadHash'; payload:=payload-'payloadHash';
  IF fingerprint IS NULL OR fingerprint !~ '^[a-f0-9]{64}$'
    OR fingerprint<>encode(sha256(convert_to(payload::text,'UTF8')),'hex') THEN RETURN FALSE; END IF;
  nominee:=payload->'nominee'->>'userId'; nominee_email:=payload->'nominee'->>'userEmail';
  IF NOT dealguard.enterprise_bootstrap_identity_valid(r.requested_by_user_id,r.requested_by_email)
    OR NOT dealguard.enterprise_bootstrap_identity_valid(nominee,nominee_email)
    OR r.requested_by_user_id=nominee OR lower(r.requested_by_email)=lower(nominee_email) THEN RETURN FALSE; END IF;
  expected:=dealguard.enterprise_bootstrap_payload(t.portal_id,t.authorization_epoch_at,t.installer_email,
    r.requested_by_user_id,r.requested_by_email,nominee,nominee_email,r.requested_at,r.expires_at);
  IF payload IS DISTINCT FROM expected THEN RETURN FALSE; END IF;
  RETURN dealguard.enterprise_bootstrap_requester_allowed(t.portal_id,r.requested_by_user_id,r.requested_by_email)
    AND dealguard.enterprise_bootstrap_nominee_available(t.portal_id,nominee,nominee_email);
END; $$;

CREATE FUNCTION dealguard.enterprise_bootstrap_public_proposal(r dealguard.change_approval_requests,p_user TEXT,p_email TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE payload JSONB:=r.requested_payload_json::jsonb; requester BOOLEAN; nominee BOOLEAN;
BEGIN
  requester:=r.requested_by_user_id=p_user AND lower(r.requested_by_email)=lower(p_email);
  nominee:=payload->'nominee'->>'userId'=p_user AND lower(payload->'nominee'->>'userEmail')=lower(p_email);
  IF NOT COALESCE(requester OR nominee,FALSE) THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('id',r.id,'payloadHash',payload->>'payloadHash','status',r.status,'expiresAt',r.expires_at,
    'requester',payload->'requester','nominee',payload->'nominee','role','administrator','permissions','[]'::jsonb,
    'scope',payload->'scope','canAccept',COALESCE(nominee,FALSE),'canReject',TRUE);
END; $$;

CREATE FUNCTION dealguard.enterprise_role_bootstrap_status(p_portal TEXT,p_user TEXT,p_email TEXT)
RETURNS JSONB LANGUAGE plpgsql SET search_path=pg_catalog,dealguard AS $$
DECLARE t dealguard.tenants%ROWTYPE; r dealguard.change_approval_requests%ROWTYPE; proposal JSONB; can_request BOOLEAN;
BEGIN
  SELECT * INTO t FROM dealguard.tenants WHERE portal_id=p_portal FOR SHARE;
  IF NOT FOUND OR t.status<>'active' THEN RETURN jsonb_build_object('error','installation_inactive'); END IF;
  IF NOT dealguard.enterprise_bootstrap_identity_valid(p_user,p_email) THEN RETURN jsonb_build_object('error','enterprise_bootstrap_identity_required'); END IF;
  IF dealguard.enterprise_bootstrap_initialized(p_portal) THEN
    RETURN jsonb_build_object('initialized',TRUE,'viewer','unavailable','canPropose',FALSE,'proposal',NULL); END IF;
  can_request:=dealguard.enterprise_bootstrap_requester_allowed(p_portal,p_user,p_email);
  SELECT * INTO r FROM dealguard.change_approval_requests WHERE portal_id=p_portal AND change_type='role.bootstrap' AND status='pending';
  IF FOUND AND dealguard.enterprise_bootstrap_proposal_valid(t,r) THEN
    proposal:=dealguard.enterprise_bootstrap_public_proposal(r,p_user,p_email);
    IF proposal IS NOT NULL THEN
      RETURN jsonb_build_object('initialized',FALSE,'viewer',CASE WHEN proposal->>'canAccept'='true' THEN 'nominee' ELSE 'requester' END,
        'canPropose',FALSE,'proposal',proposal);
    END IF;
    -- An unauthorized observer learns no requester, nominee, digest or timing.
    RETURN jsonb_build_object('initialized',FALSE,'viewer','unavailable','canPropose',FALSE,'proposal',NULL);
  END IF;
  RETURN jsonb_build_object('initialized',FALSE,'viewer',CASE WHEN can_request THEN 'requester' ELSE 'unavailable' END,
    'canPropose',can_request,'proposal',NULL);
END; $$;

CREATE FUNCTION dealguard.mutate_enterprise_role_bootstrap(p_portal TEXT,p_user TEXT,p_email TEXT,p_action TEXT,p_input JSONB)
RETURNS JSONB LANGUAGE plpgsql SET search_path=pg_catalog,dealguard AS $$
DECLARE t dealguard.tenants%ROWTYPE; r dealguard.change_approval_requests%ROWTYPE; payload JSONB;
  nominee TEXT; nominee_email TEXT; fingerprint TEXT; stamp TEXT; expires TEXT; approval_id TEXT; requester BOOLEAN; addressed BOOLEAN;
BEGIN
  SELECT * INTO t FROM dealguard.tenants WHERE portal_id=p_portal FOR UPDATE;
  IF NOT FOUND OR t.status<>'active' THEN RETURN jsonb_build_object('error','installation_inactive'); END IF;
  IF NOT dealguard.enterprise_bootstrap_identity_valid(p_user,p_email) THEN RETURN jsonb_build_object('error','enterprise_bootstrap_identity_required'); END IF;
  IF dealguard.enterprise_bootstrap_initialized(p_portal) THEN RETURN jsonb_build_object('error','enterprise_bootstrap_initialized'); END IF;
  IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' THEN RETURN jsonb_build_object('error','enterprise_bootstrap_input_invalid'); END IF;
  stamp:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
  IF p_action='propose' THEN
    IF NOT dealguard.enterprise_bootstrap_requester_allowed(p_portal,p_user,p_email) THEN RETURN jsonb_build_object('error','enterprise_bootstrap_requester_required'); END IF;
    IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k NOT IN ('nomineeUserId','nomineeEmail')) THEN RETURN jsonb_build_object('error','enterprise_bootstrap_input_invalid'); END IF;
    nominee:=p_input->>'nomineeUserId'; nominee_email:=lower(p_input->>'nomineeEmail');
    IF jsonb_typeof(p_input->'nomineeUserId') IS DISTINCT FROM 'string' OR jsonb_typeof(p_input->'nomineeEmail') IS DISTINCT FROM 'string'
      OR NOT dealguard.enterprise_bootstrap_identity_valid(nominee,nominee_email) THEN RETURN jsonb_build_object('error','enterprise_bootstrap_input_invalid'); END IF;
    IF p_user=nominee OR lower(p_email)=nominee_email THEN RETURN jsonb_build_object('error','enterprise_bootstrap_distinct_identity_required'); END IF;
    IF NOT dealguard.enterprise_bootstrap_nominee_available(p_portal,nominee,nominee_email) THEN RETURN jsonb_build_object('error','enterprise_bootstrap_binding_conflict'); END IF;
    UPDATE dealguard.change_approval_requests old SET status='cancelled'
      WHERE old.portal_id=p_portal AND old.change_type='role.bootstrap' AND old.status='pending'
      AND NOT dealguard.enterprise_bootstrap_proposal_valid(t,old);
    IF EXISTS(SELECT 1 FROM dealguard.change_approval_requests WHERE portal_id=p_portal AND change_type='role.bootstrap' AND status='pending') THEN
      RETURN jsonb_build_object('error','enterprise_bootstrap_pending'); END IF;
    expires:=to_char((stamp::timestamptz+INTERVAL '1 hour') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
    payload:=dealguard.enterprise_bootstrap_payload(p_portal,t.authorization_epoch_at,t.installer_email,p_user,p_email,nominee,nominee_email,stamp,expires);
    fingerprint:=encode(sha256(convert_to(payload::text,'UTF8')),'hex'); approval_id:=gen_random_uuid()::text;
    INSERT INTO dealguard.change_approval_requests(id,portal_id,change_type,resource_type,resource_id,requested_payload_json,status,
      requested_by_user_id,requested_by_email,requested_at,expires_at)
      VALUES(approval_id,p_portal,'role.bootstrap','enterprise_role_pair',p_portal,(payload||jsonb_build_object('payloadHash',fingerprint))::text,
        'pending',p_user,lower(p_email),stamp,expires) RETURNING * INTO r;
    INSERT INTO dealguard.audit_events(id,portal_id,user_id,user_email,action,metadata_json,created_at)
      VALUES(gen_random_uuid()::text,p_portal,p_user,lower(p_email),'enterprise_role.bootstrap_requested',
        jsonb_build_object('approvalId',approval_id,'payloadHash',fingerprint,'requesterUserId',p_user,'nomineeUserId',nominee)::text,stamp);
    RETURN jsonb_build_object('outcome','proposed','proposal',dealguard.enterprise_bootstrap_public_proposal(r,p_user,p_email));
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('accept','reject') OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k NOT IN ('proposalId','payloadHash'))
    OR jsonb_typeof(p_input->'proposalId') IS DISTINCT FROM 'string' OR jsonb_typeof(p_input->'payloadHash') IS DISTINCT FROM 'string'
    OR length(p_input->>'proposalId') NOT BETWEEN 1 AND 128 OR (p_input->>'payloadHash') !~ '^[a-f0-9]{64}$' THEN
    RETURN jsonb_build_object('error','enterprise_bootstrap_input_invalid'); END IF;
  SELECT * INTO r FROM dealguard.change_approval_requests WHERE portal_id=p_portal AND id=p_input->>'proposalId' AND change_type='role.bootstrap' FOR UPDATE;
  IF NOT FOUND OR NOT dealguard.enterprise_bootstrap_proposal_valid(t,r) THEN RETURN jsonb_build_object('error','enterprise_bootstrap_unavailable'); END IF;
  payload:=r.requested_payload_json::jsonb; fingerprint:=payload->>'payloadHash';
  requester:=r.requested_by_user_id=p_user AND lower(r.requested_by_email)=lower(p_email);
  addressed:=payload->'nominee'->>'userId'=p_user AND lower(payload->'nominee'->>'userEmail')=lower(p_email);
  IF NOT COALESCE(addressed OR (p_action='reject' AND requester),FALSE) THEN RETURN jsonb_build_object('error','enterprise_bootstrap_nominee_required'); END IF;
  IF fingerprint IS DISTINCT FROM p_input->>'payloadHash' THEN RETURN jsonb_build_object('error','enterprise_bootstrap_payload_changed'); END IF;
  IF p_action='reject' THEN
    UPDATE dealguard.change_approval_requests SET status='rejected',decided_by_user_id=p_user,decided_by_email=lower(p_email),decided_at=stamp,
      decision_comment=CASE WHEN requester THEN 'Setup requester withdrew the fixed administrator pair.' ELSE 'Addressed nominee rejected the fixed administrator pair.' END WHERE id=r.id;
  ELSE
    -- Exactly this pair and these fixed grants; the caller cannot choose roles,
    -- extra permissions, scope or a different installation in the accept body.
    INSERT INTO dealguard.enterprise_role_assignments(id,portal_id,user_id,user_email,role,permissions_json,pipeline_ids_json,team_ids_json,
      owner_ids_json,region_codes_json,created_by_user_id,created_by_email,created_at,updated_at)
      VALUES(gen_random_uuid()::text,p_portal,r.requested_by_user_id,lower(r.requested_by_email),'administrator','[]','[]','[]','[]','[]',p_user,lower(p_email),stamp,stamp),
        (gen_random_uuid()::text,p_portal,p_user,lower(p_email),'administrator','[]','[]','[]','[]','[]',p_user,lower(p_email),stamp,stamp);
    UPDATE dealguard.change_approval_requests SET status='applied',decided_by_user_id=p_user,decided_by_email=lower(p_email),decided_at=stamp,
      applied_at=stamp,decision_comment='Addressed nominee accepted the exact initial administrator pair and payload fingerprint.' WHERE id=r.id;
    INSERT INTO dealguard.change_approval_executions(approval_id,portal_id,status,attempts,started_at,completed_at,applied_by_user_id,applied_by_email,updated_at)
      VALUES(r.id,p_portal,'completed',1,stamp,stamp,p_user,lower(p_email),stamp);
  END IF;
  INSERT INTO dealguard.audit_events(id,portal_id,user_id,user_email,action,metadata_json,created_at)
    VALUES(gen_random_uuid()::text,p_portal,p_user,lower(p_email),CASE WHEN p_action='accept' THEN 'enterprise_role.bootstrap_applied' ELSE 'enterprise_role.bootstrap_rejected' END,
      jsonb_build_object('approvalId',r.id,'payloadHash',fingerprint,'requesterUserId',r.requested_by_user_id,
        'nomineeUserId',payload->'nominee'->>'userId','role','administrator','permissions','[]'::jsonb,'scope',payload->'scope')::text,stamp);
  RETURN jsonb_build_object('outcome',CASE WHEN p_action='accept' THEN 'applied' ELSE 'rejected' END,'approvalId',r.id);
END; $$;
