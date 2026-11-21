SET search_path TO dealguard,public;
CREATE TABLE ai_limits (
 portal_id TEXT PRIMARY KEY REFERENCES tenants(portal_id) ON DELETE CASCADE,
 daily_requests INTEGER NOT NULL DEFAULT 25 CHECK(daily_requests BETWEEN 1 AND 1000),
 daily_budget_micro BIGINT NOT NULL DEFAULT 5000000 CHECK(daily_budget_micro BETWEEN 10000 AND 100000000),
 concurrent_requests INTEGER NOT NULL DEFAULT 2 CHECK(concurrent_requests BETWEEN 1 AND 4)
);
CREATE TABLE ai_daily_usage (
 portal_id TEXT NOT NULL REFERENCES tenants(portal_id) ON DELETE CASCADE, day DATE NOT NULL,
 requests INTEGER NOT NULL DEFAULT 0 CHECK(requests>=0),
 reserved_micro BIGINT NOT NULL DEFAULT 0 CHECK(reserved_micro>=0),
 accounted_micro BIGINT NOT NULL DEFAULT 0 CHECK(accounted_micro>=0),
 PRIMARY KEY(portal_id,day)
);
CREATE TABLE ai_runs (
 portal_id TEXT NOT NULL REFERENCES tenants(portal_id) ON DELETE CASCADE,
 request_key TEXT NOT NULL, actor_id TEXT NOT NULL, deal_id TEXT NOT NULL, purpose TEXT NOT NULL,
 fingerprint TEXT NOT NULL, model_key TEXT NOT NULL, consent_revision INTEGER NOT NULL,
 assessment_at TEXT NOT NULL, snapshot_at TEXT,
 state TEXT NOT NULL CHECK(state IN ('reserved','completed','failed','revoked')),
 lease_token TEXT NOT NULL, lease_expires_at TIMESTAMPTZ NOT NULL,
 request_day DATE NOT NULL, reserved_micro BIGINT NOT NULL CHECK(reserved_micro>0),
 accounted_micro BIGINT, cost_source TEXT CHECK(cost_source IN ('reported_usage','conservative_reservation')),
 response_cipher TEXT, response_iv TEXT, cache_expires_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(portal_id,request_key)
);
CREATE INDEX idx_ai_runs_pending ON ai_runs(portal_id,lease_expires_at) WHERE state='reserved';
CREATE INDEX idx_ai_runs_retention ON ai_runs(created_at,portal_id);

CREATE FUNCTION dealguard.set_ai_limits(p_portal TEXT,p_revision INTEGER,p_requests INTEGER,p_budget BIGINT,p_concurrent INTEGER,p_actor TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SET search_path=pg_catalog,dealguard AS $$
DECLARE c dealguard.intelligence_consents%ROWTYPE;
BEGIN
 SELECT * INTO c FROM dealguard.intelligence_consents WHERE portal_id=p_portal AND capability='ai' FOR UPDATE;
 IF NOT FOUND OR c.revision<>p_revision THEN RETURN FALSE; END IF;
 INSERT INTO dealguard.ai_limits(portal_id,daily_requests,daily_budget_micro,concurrent_requests)VALUES(p_portal,p_requests,p_budget,p_concurrent)
 ON CONFLICT(portal_id)DO UPDATE SET daily_requests=excluded.daily_requests,daily_budget_micro=excluded.daily_budget_micro,concurrent_requests=excluded.concurrent_requests;
 UPDATE dealguard.intelligence_consents SET revision=revision+1,updated_at=clock_timestamp() WHERE portal_id=p_portal AND capability='ai';
 INSERT INTO dealguard.audit_events(id,portal_id,user_id,action,metadata_json,created_at)VALUES(gen_random_uuid()::text,p_portal,p_actor,'ai.limits_changed',
 jsonb_build_object('dailyRequests',p_requests,'budgetMicroUsd',p_budget,'concurrentRequests',p_concurrent)::text,
 to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
 RETURN TRUE;
END; $$;

CREATE FUNCTION dealguard.reserve_ai_run(p_portal TEXT,p_key TEXT,p_actor TEXT,p_deal TEXT,p_purpose TEXT,p_fingerprint TEXT,
 p_model TEXT,p_revision INTEGER,p_assessment TEXT,p_snapshot TEXT,p_reservation BIGINT,p_token TEXT)
RETURNS JSONB LANGUAGE plpgsql SET search_path=pg_catalog,dealguard AS $$
DECLARE c dealguard.intelligence_consents%ROWTYPE; limits dealguard.ai_limits%ROWTYPE; old dealguard.ai_runs%ROWTYPE;
 day_value DATE:=(clock_timestamp() AT TIME ZONE 'UTC')::date; used dealguard.ai_daily_usage%ROWTYPE; expired RECORD;
BEGIN
 SELECT * INTO c FROM dealguard.intelligence_consents WHERE portal_id=p_portal AND capability='ai' FOR UPDATE;
 IF NOT FOUND OR NOT c.enabled OR c.revision<>p_revision THEN RETURN jsonb_build_object('error','consent');END IF;
 IF p_reservation NOT BETWEEN 1 AND 100000000 OR p_key !~ '^[A-Za-z0-9_-]{16,100}$' OR p_actor IS NULL OR length(p_actor)=0
   OR p_purpose NOT IN ('risk','manager_review','next_action','handover') OR p_fingerprint !~ '^[0-9a-f]{64}$' THEN
 RAISE EXCEPTION 'Invalid AI admission' USING ERRCODE='22023'; END IF;
 IF NOT dealguard.lock_current_work_record(p_portal,p_deal,p_assessment) THEN RETURN jsonb_build_object('error','source'); END IF;
 FOR expired IN SELECT * FROM dealguard.ai_runs WHERE portal_id=p_portal AND state='reserved' AND lease_expires_at<=clock_timestamp() FOR UPDATE LOOP
   UPDATE dealguard.ai_daily_usage SET reserved_micro=reserved_micro-expired.reserved_micro,accounted_micro=accounted_micro+expired.reserved_micro
     WHERE portal_id=p_portal AND day=expired.request_day;
   UPDATE dealguard.ai_runs SET state='failed',accounted_micro=reserved_micro,cost_source='conservative_reservation' WHERE portal_id=p_portal AND request_key=expired.request_key;
 END LOOP;
 SELECT * INTO old FROM dealguard.ai_runs WHERE portal_id=p_portal AND request_key=p_key;
 IF FOUND THEN
   IF old.actor_id<>p_actor OR old.deal_id<>p_deal OR old.purpose<>p_purpose OR old.fingerprint<>p_fingerprint OR old.model_key<>p_model
      OR old.consent_revision<>p_revision THEN RETURN jsonb_build_object('error','key_conflict');END IF;
   IF old.state='completed' AND old.cache_expires_at>clock_timestamp() AND old.response_cipher IS NOT NULL THEN
     RETURN jsonb_build_object('cached',true,'cipher',old.response_cipher,'iv',old.response_iv); END IF;
   RETURN jsonb_build_object('error',CASE WHEN old.state='reserved' THEN 'in_progress' ELSE 'key_used' END);
 END IF;
 INSERT INTO dealguard.ai_limits(portal_id)VALUES(p_portal)ON CONFLICT DO NOTHING;
 SELECT * INTO limits FROM dealguard.ai_limits WHERE portal_id=p_portal;
 IF (SELECT COUNT(*) FROM dealguard.ai_runs WHERE portal_id=p_portal AND state='reserved')>=limits.concurrent_requests THEN RETURN jsonb_build_object('error','concurrency'); END IF;
 INSERT INTO dealguard.ai_daily_usage(portal_id,day)VALUES(p_portal,day_value)ON CONFLICT DO NOTHING;
 SELECT * INTO used FROM dealguard.ai_daily_usage WHERE portal_id=p_portal AND day=day_value FOR UPDATE;
 IF used.requests>=limits.daily_requests OR used.reserved_micro+used.accounted_micro+p_reservation>limits.daily_budget_micro THEN RETURN jsonb_build_object('error','budget'); END IF;
 UPDATE dealguard.ai_daily_usage SET requests=requests+1,reserved_micro=reserved_micro+p_reservation WHERE portal_id=p_portal AND day=day_value;
 INSERT INTO dealguard.ai_runs(portal_id,request_key,actor_id,deal_id,purpose,fingerprint,model_key,consent_revision,assessment_at,snapshot_at,state,
  lease_token,lease_expires_at,request_day,reserved_micro)VALUES(p_portal,p_key,p_actor,p_deal,p_purpose,p_fingerprint,p_model,p_revision,p_assessment,p_snapshot,
  'reserved',p_token,clock_timestamp()+INTERVAL '45 seconds',day_value,p_reservation);
 RETURN jsonb_build_object('cached',false,'admitted',true);
END; $$;

CREATE FUNCTION dealguard.finish_ai_run(p_portal TEXT,p_key TEXT,p_token TEXT,p_success BOOLEAN,p_cost BIGINT,p_cipher TEXT,p_iv TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SET search_path=pg_catalog,dealguard AS $$
DECLARE c dealguard.intelligence_consents%ROWTYPE;r dealguard.ai_runs%ROWTYPE;permitted BOOLEAN:=FALSE;cost BIGINT;
BEGIN
 SELECT * INTO c FROM dealguard.intelligence_consents WHERE portal_id=p_portal AND capability='ai' FOR UPDATE;
 SELECT * INTO r FROM dealguard.ai_runs WHERE portal_id=p_portal AND request_key=p_key FOR UPDATE;
 IF NOT FOUND OR r.state<>'reserved' OR r.lease_token<>p_token THEN RETURN FALSE; END IF;
 cost:=CASE WHEN p_cost IS NOT NULL AND p_cost BETWEEN 0 AND 1000000000 THEN p_cost ELSE r.reserved_micro END;
 IF p_success AND c.enabled AND c.revision=r.consent_revision AND r.lease_expires_at>clock_timestamp()
   AND p_cipher IS NOT NULL AND length(p_cipher)<=64000 AND p_iv IS NOT NULL THEN
   permitted:=dealguard.lock_current_work_record(p_portal,r.deal_id,r.assessment_at);
   IF permitted AND r.snapshot_at IS NOT NULL THEN permitted:=EXISTS(SELECT 1 FROM dealguard.deal_decision_snapshots
     WHERE portal_id=p_portal AND deal_id=r.deal_id AND generated_at=r.snapshot_at); END IF;
 END IF;
 UPDATE dealguard.ai_daily_usage SET reserved_micro=reserved_micro-r.reserved_micro,accounted_micro=accounted_micro+cost WHERE portal_id=p_portal AND day=r.request_day;
 UPDATE dealguard.ai_runs SET state=CASE WHEN permitted THEN 'completed' ELSE 'failed' END,accounted_micro=cost,
   cost_source=CASE WHEN p_cost IS NOT NULL AND p_cost BETWEEN 0 AND 1000000000 THEN 'reported_usage' ELSE 'conservative_reservation' END,
   response_cipher=CASE WHEN permitted THEN p_cipher END,response_iv=CASE WHEN permitted THEN p_iv END,
   cache_expires_at=CASE WHEN permitted THEN clock_timestamp()+INTERVAL '15 minutes' END WHERE portal_id=p_portal AND request_key=p_key;
 INSERT INTO dealguard.audit_events(id,portal_id,user_id,action,metadata_json,created_at)VALUES(gen_random_uuid()::text,p_portal,r.actor_id,'ai.request_finished',
   jsonb_build_object('purpose',r.purpose,'accepted',permitted,'accountedMicroUsd',cost,'costIsEstimate',true)::text,
   to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
 RETURN permitted;
END; $$;

CREATE FUNCTION dealguard.revoke_ai_cached_content() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,dealguard AS $$
BEGIN
 IF NEW.capability='ai' AND NOT NEW.enabled AND NOT EXISTS(SELECT 1 FROM dealguard.legal_holds WHERE portal_id=NEW.portal_id AND status='active') THEN
   UPDATE dealguard.ai_runs SET response_cipher=NULL,response_iv=NULL,cache_expires_at=NULL,
     state=CASE WHEN state='completed' THEN 'revoked' ELSE state END WHERE portal_id=NEW.portal_id;
 END IF; RETURN NEW;
END; $$;
CREATE TRIGGER revoke_ai_content AFTER UPDATE ON intelligence_consents FOR EACH ROW EXECUTE FUNCTION dealguard.revoke_ai_cached_content();

-- A terminated Worker must not leave reservations or live caches indefinitely.
CREATE FUNCTION dealguard.expire_ai_reservations(p_limit INTEGER DEFAULT 100)
RETURNS INTEGER LANGUAGE plpgsql SET search_path=pg_catalog,dealguard AS $$
DECLARE c RECORD;r RECORD; n INTEGER:=0;
BEGIN
 FOR c IN SELECT portal_id FROM dealguard.intelligence_consents WHERE capability='ai'
   AND EXISTS(SELECT 1 FROM dealguard.ai_runs a WHERE a.portal_id=intelligence_consents.portal_id AND a.state='reserved'
     AND a.lease_expires_at<=clock_timestamp()) ORDER BY portal_id LIMIT LEAST(GREATEST(p_limit,1),100) FOR UPDATE SKIP LOCKED
 LOOP
   FOR r IN SELECT * FROM dealguard.ai_runs WHERE portal_id=c.portal_id AND state='reserved'
     AND lease_expires_at<=clock_timestamp() ORDER BY lease_expires_at LIMIT 100 FOR UPDATE
   LOOP
     UPDATE dealguard.ai_daily_usage SET reserved_micro=reserved_micro-r.reserved_micro,accounted_micro=accounted_micro+r.reserved_micro
       WHERE portal_id=r.portal_id AND day=r.request_day;
     UPDATE dealguard.ai_runs SET state='failed',accounted_micro=reserved_micro,cost_source='conservative_reservation'
       WHERE portal_id=r.portal_id AND request_key=r.request_key;
     n:=n+1;
   END LOOP;
 END LOOP; RETURN n;
END; $$;
