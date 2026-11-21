SET search_path TO dealguard,public;
CREATE TABLE breeze_settings (
 portal_id TEXT PRIMARY KEY REFERENCES tenants(portal_id) ON DELETE CASCADE,
 enabled BOOLEAN NOT NULL DEFAULT FALSE, revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
 daily_limit INTEGER NOT NULL DEFAULT 200 CHECK(daily_limit BETWEEN 1 AND 10000),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE breeze_daily_usage (
 portal_id TEXT NOT NULL REFERENCES tenants(portal_id) ON DELETE CASCADE,day DATE NOT NULL,requests INTEGER NOT NULL DEFAULT 0 CHECK(requests>=0),
 PRIMARY KEY(portal_id,day)
);
CREATE TABLE breeze_invocations (
 portal_id TEXT NOT NULL REFERENCES tenants(portal_id) ON DELETE CASCADE,callback_id TEXT NOT NULL,
 actor_id TEXT NOT NULL,tool TEXT NOT NULL,deal_id TEXT NOT NULL,request_hash TEXT NOT NULL CHECK(request_hash~'^[0-9a-f]{64}$'),
 consent_revision INTEGER NOT NULL,received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(portal_id,callback_id)
);
CREATE INDEX idx_breeze_invocations_retention ON breeze_invocations(received_at,portal_id);
CREATE FUNCTION dealguard.set_breeze_settings(p_portal TEXT,p_enabled BOOLEAN,p_revision INTEGER,p_limit INTEGER,p_actor TEXT)
RETURNS JSONB LANGUAGE plpgsql SET search_path=pg_catalog,dealguard AS $$
DECLARE s dealguard.breeze_settings%ROWTYPE;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM dealguard.tenants WHERE portal_id=p_portal AND status='active') THEN RETURN NULL;END IF;
 INSERT INTO dealguard.breeze_settings(portal_id)VALUES(p_portal)ON CONFLICT DO NOTHING;
 SELECT * INTO s FROM dealguard.breeze_settings WHERE portal_id=p_portal FOR UPDATE;
 IF s.revision<>p_revision THEN RETURN NULL;END IF;
 UPDATE dealguard.breeze_settings SET enabled=p_enabled,revision=revision+1,daily_limit=p_limit,updated_at=clock_timestamp() WHERE portal_id=p_portal RETURNING * INTO s;
 INSERT INTO dealguard.audit_events(id,portal_id,user_id,action,metadata_json,created_at)VALUES(gen_random_uuid()::text,p_portal,p_actor,'breeze.consent_changed',
  jsonb_build_object('enabled',p_enabled,'revision',s.revision,'dailyLimit',p_limit)::text,to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
 RETURN jsonb_build_object('enabled',s.enabled,'revision',s.revision,'dailyLimit',s.daily_limit);
END; $$;
CREATE FUNCTION dealguard.admit_breeze_read(p_portal TEXT,p_revision INTEGER,p_callback TEXT,p_actor TEXT,p_tool TEXT,p_deal TEXT,p_hash TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SET search_path=pg_catalog,dealguard AS $$
DECLARE s dealguard.breeze_settings%ROWTYPE;old dealguard.breeze_invocations%ROWTYPE;used INTEGER;
 d DATE:=(clock_timestamp() AT TIME ZONE 'UTC')::date;
BEGIN
 SELECT * INTO s FROM dealguard.breeze_settings WHERE portal_id=p_portal FOR UPDATE;
 IF NOT FOUND OR NOT s.enabled OR s.revision<>p_revision OR NOT EXISTS(SELECT 1 FROM dealguard.tenants WHERE portal_id=p_portal AND status='active') THEN RETURN FALSE;END IF;
 IF p_callback IS NULL OR length(p_callback) NOT BETWEEN 1 AND 200 OR p_hash !~ '^[0-9a-f]{64}$' OR p_actor IS NULL OR p_deal IS NULL THEN RETURN FALSE;END IF;
 SELECT * INTO old FROM dealguard.breeze_invocations WHERE portal_id=p_portal AND callback_id=p_callback;
 IF FOUND AND(old.actor_id<>p_actor OR old.tool<>p_tool OR old.deal_id<>p_deal OR old.request_hash<>p_hash OR old.consent_revision<>p_revision
   OR old.received_at<clock_timestamp()-INTERVAL '5 minutes')THEN RETURN FALSE;END IF;
 INSERT INTO dealguard.breeze_daily_usage(portal_id,day)VALUES(p_portal,d)ON CONFLICT DO NOTHING;
 SELECT requests INTO used FROM dealguard.breeze_daily_usage WHERE portal_id=p_portal AND day=d FOR UPDATE;
 IF used>=s.daily_limit THEN RETURN FALSE;END IF;
 UPDATE dealguard.breeze_daily_usage SET requests=requests+1 WHERE portal_id=p_portal AND day=d;
 INSERT INTO dealguard.breeze_invocations(portal_id,callback_id,actor_id,tool,deal_id,request_hash,consent_revision)
 VALUES(p_portal,p_callback,p_actor,p_tool,p_deal,p_hash,p_revision)ON CONFLICT DO NOTHING;
 RETURN TRUE;
END; $$;
