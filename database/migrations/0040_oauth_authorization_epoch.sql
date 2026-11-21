SET search_path TO dealguard, public;

-- Invalidate authorization flows already outstanding when this fence is deployed.
-- Routine scans/settings/token rotation do not advance the installation epoch.
ALTER TABLE tenants ADD COLUMN authorization_epoch_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp();
ALTER TABLE tenants ADD COLUMN deletion_requested_at TIMESTAMPTZ;
ALTER TABLE tenants ADD COLUMN deletion_source_epoch TIMESTAMPTZ;
ALTER TABLE tenants ADD COLUMN deletion_attempts INTEGER NOT NULL DEFAULT 0 CHECK(deletion_attempts>=0);
ALTER TABLE tenants ADD COLUMN deletion_next_attempt_at TIMESTAMPTZ;
ALTER TABLE tenants ADD COLUMN deletion_lease_token TEXT;
ALTER TABLE tenants ADD COLUMN deletion_lease_expires_at TIMESTAMPTZ;
ALTER TABLE tenants ADD COLUMN deletion_last_error TEXT CHECK(deletion_last_error IS NULL OR length(deletion_last_error)<=80);
CREATE INDEX idx_tenant_deletions_due ON tenants(deletion_next_attempt_at,portal_id)
  WHERE status='deleted' AND deletion_requested_at IS NOT NULL;

CREATE FUNCTION dealguard.advance_authorization_epoch() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,dealguard AS $$
BEGIN
  IF NEW.status<>'active' AND NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.authorization_epoch_at:=GREATEST(OLD.authorization_epoch_at,clock_timestamp());
  ELSIF NEW.authorization_epoch_at<OLD.authorization_epoch_at THEN
    RAISE EXCEPTION 'Installation authorization cannot move backwards' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER tenant_authorization_epoch BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION dealguard.advance_authorization_epoch();

-- A tenant row disappears after permanent erasure. Reuse the existing hashed
-- data.deleted audit receipt so an older OAuth state cannot recreate that row.
-- Both functions take the same transaction lock before a fresh read. Keeping
-- this in a volatile PL/pgSQL function matters: a pre-lock SQL snapshot alone
-- could miss a deletion that committed while the callback waited.
CREATE FUNCTION dealguard.lock_oauth_install_authorization(p_portal TEXT,p_issued TIMESTAMPTZ)
RETURNS BOOLEAN LANGUAGE plpgsql SET search_path=pg_catalog,dealguard AS $$
DECLARE t dealguard.tenants%ROWTYPE; deletion_reference TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('dealguard-installation:'||p_portal,40));
  IF p_issued IS NULL OR p_issued>clock_timestamp() OR p_issued<clock_timestamp()-INTERVAL '10 minutes' THEN RETURN FALSE; END IF;
  SELECT * INTO t FROM dealguard.tenants WHERE portal_id=p_portal FOR UPDATE;
  IF FOUND AND (t.status='deleted' OR t.authorization_epoch_at>p_issued) THEN RETURN FALSE; END IF;
  deletion_reference:=encode(sha256(convert_to('dealguard-deleted:'||p_portal,'UTF8')),'hex');
  RETURN NOT EXISTS(SELECT 1 FROM dealguard.audit_events WHERE portal_id=deletion_reference AND action='data.deleted'
    AND CASE WHEN pg_input_is_valid(created_at,'timestamp with time zone') THEN created_at::timestamptz>=p_issued ELSE TRUE END);
END; $$;

CREATE FUNCTION dealguard.portal_deletion_held(p_portal TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SET search_path=pg_catalog,dealguard AS $$
  SELECT EXISTS(SELECT 1 FROM dealguard.compliance_settings WHERE portal_id=p_portal AND legal_hold_enabled<>0)
    OR EXISTS(SELECT 1 FROM dealguard.legal_holds WHERE portal_id=p_portal AND status='active');
$$;

-- The already-authorized request becomes a durable intent before any remote
-- erasure. Existing observations remain until finalization; optional consent is
-- revoked by the existing deactivation triggers. Legal holds block admission.
CREATE FUNCTION dealguard.request_portal_deletion(p_portal TEXT,p_user TEXT,p_email TEXT)
RETURNS JSONB LANGUAGE plpgsql SET search_path=pg_catalog,dealguard AS $$
DECLARE t dealguard.tenants%ROWTYPE; stamp TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('dealguard-installation:'||p_portal,40));
  SELECT * INTO t FROM dealguard.tenants WHERE portal_id=p_portal FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','installation_inactive'); END IF;
  IF p_user IS NULL AND p_email IS NULL THEN RETURN jsonb_build_object('error','identified_user_required'); END IF;
  IF t.status='deleted' AND t.deletion_requested_at IS NOT NULL AND t.deletion_source_epoch=t.authorization_epoch_at THEN
    RETURN jsonb_build_object('status','pending','epoch',t.deletion_source_epoch,'requestedAt',t.deletion_requested_at);
  END IF;
  IF t.status<>'active' THEN RETURN jsonb_build_object('error','installation_inactive'); END IF;
  PERFORM 1 FROM dealguard.compliance_settings WHERE portal_id=p_portal FOR SHARE;
  PERFORM 1 FROM dealguard.legal_holds WHERE portal_id=p_portal FOR SHARE;
  IF dealguard.portal_deletion_held(p_portal) THEN RETURN jsonb_build_object('error','deletion_legal_hold'); END IF;
  stamp:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  UPDATE dealguard.tenants SET status='deleted',access_token_cipher='',access_token_iv='',refresh_token_cipher='',refresh_token_iv='',
    updated_at=stamp,deletion_requested_at=clock_timestamp(),deletion_attempts=0,deletion_next_attempt_at=clock_timestamp(),
    deletion_lease_token=NULL,deletion_lease_expires_at=NULL,deletion_last_error=NULL
    WHERE portal_id=p_portal RETURNING * INTO t;
  UPDATE dealguard.tenants SET deletion_source_epoch=t.authorization_epoch_at WHERE portal_id=p_portal;
  INSERT INTO dealguard.audit_events(id,portal_id,user_id,user_email,action,metadata_json,created_at)
    VALUES(gen_random_uuid()::text,p_portal,p_user,p_email,'data.deletion_requested',
      jsonb_build_object('authorizationEpoch',t.authorization_epoch_at,'automaticRetry',TRUE)::text,stamp);
  RETURN jsonb_build_object('status','pending','epoch',t.authorization_epoch_at,'requestedAt',t.deletion_requested_at);
END; $$;

CREATE FUNCTION dealguard.claim_portal_deletion(p_portal TEXT,p_token TEXT)
RETURNS JSONB LANGUAGE plpgsql SET search_path=pg_catalog,dealguard AS $$
DECLARE t dealguard.tenants%ROWTYPE;
BEGIN
  IF p_token IS NULL OR length(p_token) NOT BETWEEN 1 AND 128 THEN RETURN NULL; END IF;
  SELECT * INTO t FROM dealguard.tenants WHERE status='deleted' AND deletion_requested_at IS NOT NULL
    AND deletion_source_epoch=authorization_epoch_at AND (p_portal IS NULL OR portal_id=p_portal)
    AND deletion_next_attempt_at<=clock_timestamp() AND (deletion_lease_expires_at IS NULL OR deletion_lease_expires_at<=clock_timestamp())
    ORDER BY deletion_next_attempt_at,portal_id LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF dealguard.portal_deletion_held(t.portal_id) THEN
    UPDATE dealguard.tenants SET deletion_next_attempt_at=clock_timestamp()+INTERVAL '1 hour',deletion_last_error='legal_hold',
      deletion_lease_token=NULL,deletion_lease_expires_at=NULL WHERE portal_id=t.portal_id;
    RETURN NULL;
  END IF;
  UPDATE dealguard.tenants SET deletion_lease_token=p_token,deletion_lease_expires_at=clock_timestamp()+INTERVAL '2 minutes',
    deletion_attempts=LEAST(1000000,deletion_attempts+1),deletion_last_error=NULL WHERE portal_id=t.portal_id RETURNING * INTO t;
  RETURN jsonb_build_object('portalId',t.portal_id,'epoch',t.deletion_source_epoch,'token',p_token,'requestedAt',t.deletion_requested_at,
    'uploadWindowEndsAt',t.deletion_requested_at+INTERVAL '16 minutes');
END; $$;

CREATE FUNCTION dealguard.portal_deletion_guard(p_portal TEXT,p_epoch TIMESTAMPTZ,p_token TEXT)
RETURNS TEXT LANGUAGE plpgsql SET search_path=pg_catalog,dealguard AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM dealguard.tenants WHERE portal_id=p_portal AND status='deleted' AND deletion_requested_at IS NOT NULL
    AND authorization_epoch_at=p_epoch AND deletion_source_epoch=p_epoch AND deletion_lease_token=p_token
    AND deletion_lease_expires_at>clock_timestamp()) THEN RETURN 'source_changed'; END IF;
  IF dealguard.portal_deletion_held(p_portal) THEN RETURN 'legal_hold'; END IF;
  RETURN 'ready';
END; $$;

CREATE FUNCTION dealguard.defer_portal_deletion(p_portal TEXT,p_epoch TIMESTAMPTZ,p_token TEXT,p_error TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SET search_path=pg_catalog,dealguard AS $$
DECLARE changed INTEGER;
BEGIN
  IF p_error NOT IN ('storage_retryable','storage_invalid_response','legal_hold','more_objects','upload_window','source_changed') THEN
    RAISE EXCEPTION 'Invalid deletion failure category' USING ERRCODE='22023';
  END IF;
  UPDATE dealguard.tenants SET deletion_last_error=p_error,deletion_lease_token=NULL,deletion_lease_expires_at=NULL,
    deletion_next_attempt_at=CASE WHEN p_error='upload_window' THEN GREATEST(clock_timestamp()+INTERVAL '5 seconds',deletion_requested_at+INTERVAL '16 minutes')
      WHEN p_error='more_objects' THEN clock_timestamp()+INTERVAL '5 seconds'
      WHEN p_error='legal_hold' THEN clock_timestamp()+INTERVAL '1 hour'
      ELSE clock_timestamp()+make_interval(secs=>LEAST(3600,30*power(2,LEAST(7,GREATEST(0,deletion_attempts-1))))::double precision) END
    WHERE portal_id=p_portal AND status='deleted' AND authorization_epoch_at=p_epoch AND deletion_source_epoch=p_epoch AND deletion_lease_token=p_token;
  GET DIAGNOSTICS changed=ROW_COUNT; RETURN changed=1;
END; $$;

CREATE FUNCTION dealguard.finalize_portal_deletion(p_portal TEXT,p_epoch TIMESTAMPTZ,p_token TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SET search_path=pg_catalog,dealguard AS $$
DECLARE t dealguard.tenants%ROWTYPE; deletion_reference TEXT; stamp TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('dealguard-installation:'||p_portal,40));
  SELECT * INTO t FROM dealguard.tenants WHERE portal_id=p_portal FOR UPDATE;
  deletion_reference:=encode(sha256(convert_to('dealguard-deleted:'||p_portal,'UTF8')),'hex');
  IF NOT FOUND THEN RETURN EXISTS(SELECT 1 FROM dealguard.audit_events WHERE portal_id=deletion_reference AND action='data.deleted'); END IF;
  IF t.status<>'deleted' OR t.authorization_epoch_at IS DISTINCT FROM p_epoch OR t.deletion_source_epoch IS DISTINCT FROM p_epoch
    OR t.deletion_requested_at IS NULL OR t.deletion_requested_at+INTERVAL '16 minutes'>clock_timestamp()
    OR p_token IS NULL OR t.deletion_lease_token IS DISTINCT FROM p_token OR t.deletion_lease_expires_at IS NULL
    OR t.deletion_lease_expires_at<=clock_timestamp() THEN RETURN FALSE; END IF;
  PERFORM 1 FROM dealguard.compliance_settings WHERE portal_id=p_portal FOR SHARE;
  PERFORM 1 FROM dealguard.legal_holds WHERE portal_id=p_portal FOR SHARE;
  IF dealguard.portal_deletion_held(p_portal) THEN RETURN FALSE; END IF;
  DELETE FROM dealguard.slack_connections WHERE portal_id=p_portal;
  DELETE FROM dealguard.integration_oauth_states WHERE portal_id=p_portal;
  DELETE FROM dealguard.notification_events WHERE portal_id=p_portal;
  DELETE FROM dealguard.inbound_events WHERE portal_id=p_portal;
  DELETE FROM dealguard.audit_events WHERE portal_id=p_portal;
  DELETE FROM dealguard.tenants WHERE portal_id=p_portal;
  stamp:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  INSERT INTO dealguard.audit_events(id,portal_id,user_id,user_email,action,metadata_json,created_at)
    VALUES(gen_random_uuid()::text,deletion_reference,NULL,NULL,'data.deleted','{}',stamp);
  RETURN TRUE;
END; $$;
