SET search_path TO dealguard, public;

-- Forecast approval deliberately requires assigned stable identities. Installer
-- bootstrap and an email-only fallback are not independent model approval.
CREATE FUNCTION dealguard.forecast_actor_authorized(p_portal TEXT,p_actor TEXT,p_review BOOLEAN DEFAULT FALSE)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SET search_path=pg_catalog,dealguard AS $$
DECLARE r dealguard.enterprise_role_assignments%ROWTYPE;
BEGIN
 IF p_actor IS NULL OR p_actor !~ '^[0-9]{1,32}$' THEN RETURN FALSE; END IF;
 SELECT * INTO r FROM dealguard.enterprise_role_assignments WHERE portal_id=p_portal AND user_id=p_actor;
 IF NOT FOUND OR r.pipeline_ids_json::jsonb<>'[]'::jsonb OR r.owner_ids_json::jsonb<>'[]'::jsonb
   OR r.team_ids_json::jsonb<>'[]'::jsonb OR r.region_codes_json::jsonb<>'[]'::jsonb THEN RETURN FALSE; END IF;
 IF r.role='administrator' THEN RETURN TRUE; END IF;
 RETURN p_review AND r.role IN ('reviewer','compliance_auditor') AND
   (r.permissions_json::jsonb ? 'forecast.approve' OR r.permissions_json::jsonb ? 'forecast.*' OR r.permissions_json::jsonb ? '*');
EXCEPTION WHEN invalid_text_representation THEN RETURN FALSE;
END; $$;

CREATE TABLE outcome_evaluation_jobs (
 portal_id TEXT NOT NULL REFERENCES tenants(portal_id) ON DELETE CASCADE,id TEXT NOT NULL,
 actor_id TEXT NOT NULL,consent_revision INTEGER NOT NULL,train_id TEXT NOT NULL,calibration_id TEXT NOT NULL,holdout_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('queued','running','completed','failed','cancelled')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
 lease_token TEXT,lease_expires_at TIMESTAMPTZ,not_before TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 evaluation_id TEXT,result_artifact JSONB,result_fingerprint TEXT,error_code TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(portal_id,id),UNIQUE(portal_id,consent_revision,train_id,calibration_id,holdout_id),
 FOREIGN KEY(portal_id,train_id) REFERENCES outcome_datasets(portal_id,id) ON DELETE CASCADE,
 FOREIGN KEY(portal_id,calibration_id) REFERENCES outcome_datasets(portal_id,id) ON DELETE CASCADE,
 FOREIGN KEY(portal_id,holdout_id) REFERENCES outcome_datasets(portal_id,id) ON DELETE CASCADE,
 FOREIGN KEY(portal_id,evaluation_id) REFERENCES outcome_evaluations(portal_id,id) ON DELETE CASCADE,
 CHECK(result_fingerprint IS NULL OR result_fingerprint ~ '^[a-f0-9]{64}$')
);
CREATE INDEX idx_outcome_evaluation_jobs_due ON outcome_evaluation_jobs(not_before,created_at,portal_id) WHERE state IN ('queued','running');
CREATE INDEX idx_outcome_evaluation_jobs_actor ON outcome_evaluation_jobs(portal_id,created_at);

CREATE TABLE forecast_controls (
 portal_id TEXT PRIMARY KEY REFERENCES tenants(portal_id) ON DELETE CASCADE,
 enabled BOOLEAN NOT NULL DEFAULT FALSE,revision INTEGER NOT NULL DEFAULT 0,changed_by TEXT NOT NULL,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE forecast_models (
 portal_id TEXT NOT NULL REFERENCES tenants(portal_id) ON DELETE CASCADE,id TEXT NOT NULL,
 evaluation_id TEXT NOT NULL,pipeline_id TEXT NOT NULL,policy_id TEXT NOT NULL,consent_revision INTEGER NOT NULL,
 artifact JSONB NOT NULL,artifact_fingerprint TEXT NOT NULL CHECK(artifact_fingerprint ~ '^[a-f0-9]{64}$'),
 state TEXT NOT NULL CHECK(state IN ('pending','active','rejected','suspended')),
 requested_by TEXT NOT NULL,evaluation_requested_by TEXT NOT NULL,reviewed_by TEXT,review_evidence_sha256 TEXT,
 requested_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),reviewed_at TIMESTAMPTZ,
 expires_at TIMESTAMPTZ NOT NULL,monitor_lease TEXT,monitor_lease_expires_at TIMESTAMPTZ,
 monitor_checked_at TIMESTAMPTZ,suspension_reason TEXT,
 PRIMARY KEY(portal_id,id),FOREIGN KEY(portal_id,evaluation_id) REFERENCES outcome_evaluations(portal_id,id) ON DELETE CASCADE,
 CHECK(review_evidence_sha256 IS NULL OR review_evidence_sha256 ~ '^[a-f0-9]{64}$'),
 CHECK(reviewed_by IS NULL OR (reviewed_by<>requested_by AND reviewed_by<>evaluation_requested_by))
);
CREATE UNIQUE INDEX idx_forecast_active_cohort ON forecast_models(portal_id,pipeline_id,policy_id) WHERE state='active';
CREATE INDEX idx_forecast_models_monitor ON forecast_models(monitor_checked_at,requested_at,portal_id) WHERE state IN ('pending','active');
CREATE INDEX idx_forecast_models_evaluation ON forecast_models(portal_id,evaluation_id);

CREATE TABLE forecast_monitors (
 portal_id TEXT NOT NULL,model_id TEXT NOT NULL,quarter TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('eligible','insufficient_evidence','drifted','unavailable')),
 report JSONB NOT NULL,checked_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),expires_at TIMESTAMPTZ NOT NULL,
 PRIMARY KEY(portal_id,model_id,quarter),FOREIGN KEY(portal_id,model_id) REFERENCES forecast_models(portal_id,id) ON DELETE CASCADE
);
CREATE TABLE forecast_predictions (
 portal_id TEXT NOT NULL,model_id TEXT NOT NULL,deal_id TEXT NOT NULL,quarter TEXT NOT NULL,
 anchor_at TIMESTAMPTZ NOT NULL,horizon_at TIMESTAMPTZ NOT NULL,evidence_at TEXT NOT NULL,
 source_fingerprint TEXT NOT NULL,probability DOUBLE PRECISION NOT NULL CHECK(probability>=0 AND probability<=1),
 consent_revision INTEGER NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(portal_id,model_id,deal_id,quarter),FOREIGN KEY(portal_id,model_id) REFERENCES forecast_models(portal_id,id) ON DELETE CASCADE
);
CREATE INDEX idx_forecast_predictions_outcomes ON forecast_predictions(horizon_at,portal_id,model_id);
CREATE TABLE forecast_cache (
 portal_id TEXT NOT NULL,model_id TEXT NOT NULL,deal_id TEXT NOT NULL,quarter TEXT NOT NULL,
 source_fingerprint TEXT NOT NULL,controls_revision INTEGER NOT NULL,consent_revision INTEGER NOT NULL,
 probability DOUBLE PRECISION NOT NULL CHECK(probability>=0 AND probability<=1),expires_at TIMESTAMPTZ NOT NULL,
 PRIMARY KEY(portal_id,model_id,deal_id,quarter),FOREIGN KEY(portal_id,model_id,deal_id,quarter)
 REFERENCES forecast_predictions(portal_id,model_id,deal_id,quarter) ON DELETE CASCADE
);
CREATE INDEX idx_forecast_cache_expiry ON forecast_cache(expires_at);
CREATE TABLE forecast_outcome_reports (
 portal_id TEXT NOT NULL,model_id TEXT NOT NULL,quarter TEXT NOT NULL,report JSONB NOT NULL,
 observed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(portal_id,model_id,quarter),FOREIGN KEY(portal_id,model_id) REFERENCES forecast_models(portal_id,id) ON DELETE CASCADE
);
CREATE TRIGGER immutable_forecast_prediction BEFORE UPDATE ON forecast_predictions FOR EACH ROW EXECUTE FUNCTION dealguard.reject_intelligence_record_update();
CREATE TRIGGER immutable_forecast_outcome_report BEFORE UPDATE ON forecast_outcome_reports FOR EACH ROW EXECUTE FUNCTION dealguard.reject_intelligence_record_update();
CREATE FUNCTION dealguard.guard_forecast_artifact() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.portal_id,NEW.id,NEW.evaluation_id,NEW.pipeline_id,NEW.policy_id,NEW.consent_revision,NEW.artifact,NEW.artifact_fingerprint,
     NEW.requested_by,NEW.evaluation_requested_by,NEW.requested_at,NEW.expires_at) IS DISTINCT FROM
    (OLD.portal_id,OLD.id,OLD.evaluation_id,OLD.pipeline_id,OLD.policy_id,OLD.consent_revision,OLD.artifact,OLD.artifact_fingerprint,
     OLD.requested_by,OLD.evaluation_requested_by,OLD.requested_at,OLD.expires_at) THEN
 RAISE EXCEPTION 'Forecast artifacts are immutable; register a new candidate' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER immutable_forecast_artifact BEFORE UPDATE ON forecast_models FOR EACH ROW EXECUTE FUNCTION dealguard.guard_forecast_artifact();

CREATE FUNCTION dealguard.enqueue_outcome_evaluation(p_portal TEXT,p_revision INTEGER,p_actor TEXT,p_id TEXT,p_train TEXT,p_calibration TEXT,p_holdout TEXT)
RETURNS JSONB LANGUAGE plpgsql SET search_path=pg_catalog,dealguard AS $$
DECLARE c dealguard.intelligence_consents%ROWTYPE;j dealguard.outcome_evaluation_jobs%ROWTYPE;
BEGIN
 SELECT * INTO c FROM dealguard.intelligence_consents WHERE portal_id=p_portal AND capability='outcomes' FOR UPDATE;
 IF NOT FOUND OR NOT c.enabled OR c.revision<>p_revision OR NOT dealguard.forecast_actor_authorized(p_portal,p_actor)
   OR NOT EXISTS(SELECT 1 FROM dealguard.tenants WHERE portal_id=p_portal AND status='active') THEN RETURN NULL; END IF;
 IF (SELECT COUNT(*) FROM dealguard.outcome_datasets WHERE portal_id=p_portal AND id IN(p_train,p_calibration,p_holdout)
     AND consent_revision=p_revision AND expires_at>clock_timestamp())<>3 THEN RETURN NULL; END IF;
 SELECT * INTO j FROM dealguard.outcome_evaluation_jobs WHERE portal_id=p_portal AND consent_revision=p_revision
   AND train_id=p_train AND calibration_id=p_calibration AND holdout_id=p_holdout;
 IF FOUND THEN
   IF j.state='failed' AND j.error_code='evaluation_failed' AND j.attempts<3 THEN
     UPDATE dealguard.outcome_evaluation_jobs SET state='queued',not_before=clock_timestamp()+INTERVAL '30 seconds',error_code=NULL,updated_at=clock_timestamp()
       WHERE portal_id=p_portal AND id=j.id;
     RETURN jsonb_build_object('id',j.id,'state','queued');
   END IF;
   RETURN jsonb_build_object('id',j.id,'state',j.state);
 END IF;
 IF (SELECT COUNT(*) FROM dealguard.outcome_evaluation_jobs WHERE portal_id=p_portal AND created_at>clock_timestamp()-INTERVAL '1 day')>=10 THEN
   RETURN jsonb_build_object('error','daily_capacity'); END IF;
 INSERT INTO dealguard.outcome_evaluation_jobs(portal_id,id,actor_id,consent_revision,train_id,calibration_id,holdout_id,state)
 VALUES(p_portal,p_id,p_actor,p_revision,p_train,p_calibration,p_holdout,'queued');
 RETURN jsonb_build_object('id',p_id,'state','queued');
END; $$;

CREATE FUNCTION dealguard.finish_outcome_evaluation(p_portal TEXT,p_id TEXT,p_token TEXT,p_evaluation TEXT,p_report JSONB,p_parameters JSONB,p_artifact JSONB,p_fingerprint TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SET search_path=pg_catalog,dealguard AS $$
DECLARE c dealguard.intelligence_consents%ROWTYPE;j dealguard.outcome_evaluation_jobs%ROWTYPE;
BEGIN
 SELECT * INTO c FROM dealguard.intelligence_consents WHERE portal_id=p_portal AND capability='outcomes' FOR UPDATE;
 SELECT * INTO j FROM dealguard.outcome_evaluation_jobs WHERE portal_id=p_portal AND id=p_id FOR UPDATE;
 IF NOT FOUND OR j.state<>'running' OR j.lease_token<>p_token OR j.lease_expires_at<=clock_timestamp() THEN RETURN FALSE; END IF;
 IF NOT c.enabled OR c.revision<>j.consent_revision OR NOT dealguard.forecast_actor_authorized(p_portal,j.actor_id)
   OR NOT EXISTS(SELECT 1 FROM dealguard.tenants WHERE portal_id=p_portal AND status='active') THEN
   UPDATE dealguard.outcome_evaluation_jobs SET state='cancelled',error_code='authorization_changed',updated_at=clock_timestamp() WHERE portal_id=p_portal AND id=p_id; RETURN FALSE; END IF;
 IF (SELECT COUNT(*) FROM dealguard.outcome_datasets WHERE portal_id=p_portal AND id IN(j.train_id,j.calibration_id,j.holdout_id)
   AND consent_revision=c.revision AND expires_at>clock_timestamp())<>3 THEN RETURN FALSE; END IF;
 INSERT INTO dealguard.outcome_evaluations(portal_id,id,consent_revision,train_id,calibration_id,holdout_id,report,parameters)
 VALUES(p_portal,p_evaluation,c.revision,j.train_id,j.calibration_id,j.holdout_id,p_report,p_parameters);
 UPDATE dealguard.outcome_evaluation_jobs SET state='completed',evaluation_id=p_evaluation,result_artifact=p_artifact,result_fingerprint=p_fingerprint,
   lease_token=NULL,lease_expires_at=NULL,error_code=NULL,updated_at=clock_timestamp() WHERE portal_id=p_portal AND id=p_id;
 RETURN TRUE;
END; $$;

CREATE FUNCTION dealguard.change_forecast_controls(p_portal TEXT,p_actor TEXT,p_revision INTEGER,p_enabled BOOLEAN)
RETURNS JSONB LANGUAGE plpgsql SET search_path=pg_catalog,dealguard AS $$
DECLARE c dealguard.intelligence_consents%ROWTYPE;r dealguard.forecast_controls%ROWTYPE;
BEGIN
 SELECT * INTO c FROM dealguard.intelligence_consents WHERE portal_id=p_portal AND capability='outcomes' FOR UPDATE;
 IF NOT dealguard.forecast_actor_authorized(p_portal,p_actor) OR (p_enabled AND NOT COALESCE(c.enabled,FALSE)) THEN RETURN NULL; END IF;
 INSERT INTO dealguard.forecast_controls(portal_id,changed_by)VALUES(p_portal,p_actor)ON CONFLICT DO NOTHING;
 SELECT * INTO r FROM dealguard.forecast_controls WHERE portal_id=p_portal FOR UPDATE;
 IF r.revision<>p_revision THEN RETURN NULL; END IF;
 UPDATE dealguard.forecast_controls SET enabled=p_enabled,revision=revision+1,changed_by=p_actor,updated_at=clock_timestamp()
 WHERE portal_id=p_portal RETURNING * INTO r;
 IF NOT p_enabled THEN
   UPDATE dealguard.forecast_models SET state='suspended',suspension_reason='administrator_kill_switch' WHERE portal_id=p_portal AND state IN ('pending','active');
   DELETE FROM dealguard.forecast_cache WHERE portal_id=p_portal AND NOT EXISTS(SELECT 1 FROM dealguard.legal_holds WHERE portal_id=p_portal AND status='active');
 END IF;
 INSERT INTO dealguard.audit_events(id,portal_id,user_id,action,metadata_json,created_at)VALUES(gen_random_uuid()::text,p_portal,p_actor,'forecast.controls_changed',
   jsonb_build_object('enabled',p_enabled,'revision',r.revision)::text,to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
 RETURN jsonb_build_object('enabled',r.enabled,'revision',r.revision);
END; $$;

CREATE FUNCTION dealguard.register_forecast_model(p_portal TEXT,p_actor TEXT,p_id TEXT,p_evaluation TEXT,p_artifact JSONB,p_fingerprint TEXT,p_expires TIMESTAMPTZ)
RETURNS BOOLEAN LANGUAGE plpgsql SET search_path=pg_catalog,dealguard AS $$
DECLARE c dealguard.intelligence_consents%ROWTYPE;j dealguard.outcome_evaluation_jobs%ROWTYPE;
BEGIN
 SELECT * INTO c FROM dealguard.intelligence_consents WHERE portal_id=p_portal AND capability='outcomes' FOR UPDATE;
 IF NOT FOUND OR NOT c.enabled OR NOT dealguard.forecast_actor_authorized(p_portal,p_actor)
   OR NOT EXISTS(SELECT 1 FROM dealguard.tenants WHERE portal_id=p_portal AND status='active') THEN RETURN FALSE; END IF;
 SELECT * INTO j FROM dealguard.outcome_evaluation_jobs WHERE portal_id=p_portal AND evaluation_id=p_evaluation AND state='completed';
 IF NOT FOUND OR j.consent_revision<>c.revision OR j.updated_at<clock_timestamp()-INTERVAL '7 days'
   OR p_expires<=clock_timestamp() OR p_expires>clock_timestamp()+INTERVAL '30 days'
   OR p_artifact<>j.result_artifact OR p_fingerprint<>j.result_fingerprint OR p_artifact->'report'->>'status'<>'qualified_candidate'
   OR (SELECT COUNT(*) FROM dealguard.outcome_datasets WHERE portal_id=p_portal AND id IN(j.train_id,j.calibration_id,j.holdout_id)
     AND consent_revision=c.revision AND expires_at>p_expires)<>3 THEN RETURN FALSE; END IF;
 IF (SELECT COUNT(*) FROM dealguard.forecast_models WHERE portal_id=p_portal AND requested_at>clock_timestamp()-INTERVAL '1 day')>=20
   OR EXISTS(SELECT 1 FROM dealguard.forecast_models WHERE portal_id=p_portal AND artifact_fingerprint=p_fingerprint AND state='pending') THEN RETURN FALSE; END IF;
 INSERT INTO dealguard.forecast_models(portal_id,id,evaluation_id,pipeline_id,policy_id,consent_revision,artifact,artifact_fingerprint,state,
   requested_by,evaluation_requested_by,expires_at)
 VALUES(p_portal,p_id,p_evaluation,p_artifact->>'pipelineId',p_artifact->>'policyId',c.revision,p_artifact,p_fingerprint,'pending',p_actor,j.actor_id,p_expires);
 INSERT INTO dealguard.audit_events(id,portal_id,user_id,action,metadata_json,created_at)VALUES(gen_random_uuid()::text,p_portal,p_actor,'forecast.candidate_registered',
   jsonb_build_object('modelId',p_id,'evaluationId',p_evaluation,'fingerprint',p_fingerprint)::text,to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
 RETURN TRUE;
END; $$;

CREATE FUNCTION dealguard.review_forecast_model(p_portal TEXT,p_actor TEXT,p_id TEXT,p_fingerprint TEXT,p_approve BOOLEAN,p_evidence TEXT,p_quarter TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SET search_path=pg_catalog,dealguard AS $$
DECLARE c dealguard.intelligence_consents%ROWTYPE;m dealguard.forecast_models%ROWTYPE;
BEGIN
 SELECT * INTO c FROM dealguard.intelligence_consents WHERE portal_id=p_portal AND capability='outcomes' FOR UPDATE;
 IF NOT FOUND OR NOT c.enabled OR NOT dealguard.forecast_actor_authorized(p_portal,p_actor,TRUE) THEN RETURN FALSE; END IF;
 SELECT * INTO m FROM dealguard.forecast_models WHERE portal_id=p_portal AND id=p_id FOR UPDATE;
 IF NOT FOUND OR m.state<>'pending' OR m.consent_revision<>c.revision OR m.artifact_fingerprint<>p_fingerprint
   OR m.expires_at<=clock_timestamp() OR p_actor=m.requested_by OR p_actor=m.evaluation_requested_by
   OR p_evidence IS NULL OR p_evidence !~ '^[a-f0-9]{64}$' THEN RETURN FALSE; END IF;
 IF p_approve AND NOT EXISTS(SELECT 1 FROM dealguard.forecast_monitors WHERE portal_id=p_portal AND model_id=p_id
    AND quarter=p_quarter AND status='eligible' AND expires_at>clock_timestamp()) THEN RETURN FALSE; END IF;
 IF p_approve THEN
   UPDATE dealguard.forecast_models SET state='suspended',suspension_reason='replaced' WHERE portal_id=p_portal AND pipeline_id=m.pipeline_id AND policy_id=m.policy_id AND state='active';
 END IF;
 UPDATE dealguard.forecast_models SET state=CASE WHEN p_approve THEN 'active' ELSE 'rejected' END,reviewed_by=p_actor,
   review_evidence_sha256=p_evidence,reviewed_at=clock_timestamp() WHERE portal_id=p_portal AND id=p_id;
 INSERT INTO dealguard.audit_events(id,portal_id,user_id,action,metadata_json,created_at)VALUES(gen_random_uuid()::text,p_portal,p_actor,'forecast.independent_review',
   jsonb_build_object('modelId',p_id,'approved',p_approve,'artifactFingerprint',p_fingerprint,'reviewEvidenceSha256',p_evidence)::text,
   to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
 RETURN TRUE;
END; $$;

CREATE FUNCTION dealguard.store_forecast_prediction(p_portal TEXT,p_model TEXT,p_deal TEXT,p_quarter TEXT,p_controls INTEGER,p_consent INTEGER,
 p_assessment TEXT,p_source TEXT,p_probability DOUBLE PRECISION,p_anchor TIMESTAMPTZ,p_horizon TIMESTAMPTZ,p_evidence TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SET search_path=pg_catalog,dealguard AS $$
DECLARE c dealguard.intelligence_consents%ROWTYPE;ctl dealguard.forecast_controls%ROWTYPE;m dealguard.forecast_models%ROWTYPE;expiry TIMESTAMPTZ;
BEGIN
 SELECT * INTO c FROM dealguard.intelligence_consents WHERE portal_id=p_portal AND capability='outcomes' FOR UPDATE;
 IF NOT FOUND OR NOT c.enabled OR c.revision<>p_consent THEN RETURN FALSE; END IF;
 SELECT * INTO ctl FROM dealguard.forecast_controls WHERE portal_id=p_portal FOR UPDATE;
 IF NOT FOUND OR NOT ctl.enabled OR ctl.revision<>p_controls THEN RETURN FALSE; END IF;
 SELECT * INTO m FROM dealguard.forecast_models WHERE portal_id=p_portal AND id=p_model FOR UPDATE;
 IF NOT FOUND OR m.state<>'active' OR m.consent_revision<>c.revision OR m.expires_at<=clock_timestamp()
   OR NOT dealguard.forecast_actor_authorized(p_portal,m.reviewed_by,TRUE) THEN RETURN FALSE; END IF;
 SELECT LEAST(expires_at,m.expires_at,p_horizon,clock_timestamp()+INTERVAL '15 minutes') INTO expiry
 FROM dealguard.forecast_monitors WHERE portal_id=p_portal AND model_id=p_model AND quarter=p_quarter AND status='eligible' AND expires_at>clock_timestamp();
 IF expiry IS NULL OR NOT dealguard.lock_current_work_record(p_portal,p_deal,p_assessment)
   OR NOT EXISTS(SELECT 1 FROM dealguard.deal_assessments WHERE portal_id=p_portal AND deal_id=p_deal AND is_closed=0) THEN RETURN FALSE; END IF;
 INSERT INTO dealguard.forecast_predictions(portal_id,model_id,deal_id,quarter,anchor_at,horizon_at,evidence_at,source_fingerprint,probability,consent_revision)
 VALUES(p_portal,p_model,p_deal,p_quarter,p_anchor,p_horizon,p_evidence,p_source,p_probability,p_consent) ON CONFLICT DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM dealguard.forecast_predictions WHERE portal_id=p_portal AND model_id=p_model AND deal_id=p_deal AND quarter=p_quarter
   AND source_fingerprint=p_source AND probability=p_probability) THEN RETURN FALSE; END IF;
 INSERT INTO dealguard.forecast_cache(portal_id,model_id,deal_id,quarter,source_fingerprint,controls_revision,consent_revision,probability,expires_at)
 VALUES(p_portal,p_model,p_deal,p_quarter,p_source,p_controls,p_consent,p_probability,expiry)
 ON CONFLICT(portal_id,model_id,deal_id,quarter)DO UPDATE SET source_fingerprint=excluded.source_fingerprint,controls_revision=excluded.controls_revision,
   consent_revision=excluded.consent_revision,probability=excluded.probability,expires_at=excluded.expires_at;
 RETURN TRUE;
END; $$;

CREATE FUNCTION dealguard.invalidate_forecasts_on_consent() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,dealguard AS $$
BEGIN
 IF NEW.capability='outcomes' AND NEW.revision<>OLD.revision THEN
   UPDATE dealguard.forecast_controls SET enabled=FALSE,revision=revision+1,updated_at=clock_timestamp() WHERE portal_id=NEW.portal_id;
   UPDATE dealguard.forecast_models SET state='suspended',suspension_reason='consent_changed' WHERE portal_id=NEW.portal_id AND state IN ('active','pending');
   UPDATE dealguard.outcome_evaluation_jobs SET state='cancelled',error_code='consent_changed',updated_at=clock_timestamp()
     WHERE portal_id=NEW.portal_id AND state IN ('queued','running');
   IF NOT EXISTS(SELECT 1 FROM dealguard.legal_holds WHERE portal_id=NEW.portal_id AND status='active') THEN
     DELETE FROM dealguard.forecast_cache WHERE portal_id=NEW.portal_id;
   END IF;
 END IF; RETURN NEW;
END; $$;
CREATE TRIGGER invalidate_forecasts AFTER UPDATE ON intelligence_consents FOR EACH ROW EXECUTE FUNCTION dealguard.invalidate_forecasts_on_consent();
