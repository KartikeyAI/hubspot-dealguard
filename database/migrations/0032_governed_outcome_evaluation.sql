SET search_path TO dealguard, public;

CREATE TABLE intelligence_consents (
  portal_id TEXT NOT NULL REFERENCES tenants(portal_id) ON DELETE CASCADE,
  capability TEXT NOT NULL CHECK(capability IN ('outcomes','ai')),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
  changed_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(portal_id,capability)
);
CREATE TABLE outcome_datasets (
  portal_id TEXT NOT NULL REFERENCES tenants(portal_id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  consent_revision INTEGER NOT NULL,
  fingerprint TEXT NOT NULL CHECK(fingerprint ~ '^[0-9a-f]{64}$'),
  manifest JSONB NOT NULL CHECK(jsonb_typeof(manifest)='object'),
  samples JSONB NOT NULL CHECK(jsonb_typeof(samples)='array' AND jsonb_array_length(samples)<=10000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()+INTERVAL '180 days',
  PRIMARY KEY(portal_id,id), UNIQUE(portal_id,consent_revision,fingerprint)
);
CREATE INDEX idx_outcome_datasets_expiry ON outcome_datasets(expires_at,portal_id);
CREATE TABLE outcome_evaluations (
  portal_id TEXT NOT NULL REFERENCES tenants(portal_id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  consent_revision INTEGER NOT NULL,
  train_id TEXT NOT NULL, calibration_id TEXT NOT NULL, holdout_id TEXT NOT NULL,
  report JSONB NOT NULL CHECK(jsonb_typeof(report)='object'),
  parameters JSONB NOT NULL CHECK(jsonb_typeof(parameters) IN ('object','null')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(portal_id,id),
  FOREIGN KEY(portal_id,train_id) REFERENCES outcome_datasets(portal_id,id) ON DELETE CASCADE,
  FOREIGN KEY(portal_id,calibration_id) REFERENCES outcome_datasets(portal_id,id) ON DELETE CASCADE,
  FOREIGN KEY(portal_id,holdout_id) REFERENCES outcome_datasets(portal_id,id) ON DELETE CASCADE
);
CREATE FUNCTION dealguard.reject_intelligence_record_update() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Intelligence evidence is immutable; create a new record' USING ERRCODE='23514'; END; $$;
CREATE TRIGGER immutable_outcome_dataset BEFORE UPDATE ON outcome_datasets
  FOR EACH ROW EXECUTE FUNCTION dealguard.reject_intelligence_record_update();
CREATE TRIGGER immutable_outcome_evaluation BEFORE UPDATE ON outcome_evaluations
  FOR EACH ROW EXECUTE FUNCTION dealguard.reject_intelligence_record_update();

CREATE FUNCTION dealguard.set_intelligence_consent(p_portal TEXT,p_capability TEXT,p_enabled BOOLEAN,p_revision INTEGER,p_actor TEXT)
RETURNS JSONB LANGUAGE plpgsql SET search_path=pg_catalog,dealguard AS $$
DECLARE c dealguard.intelligence_consents%ROWTYPE;
BEGIN
  IF p_capability NOT IN ('outcomes','ai') OR p_actor IS NULL OR length(p_actor) NOT BETWEEN 1 AND 254 OR p_enabled IS NULL THEN
    RAISE EXCEPTION 'Invalid consent input' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM dealguard.tenants WHERE portal_id=p_portal AND status='active') THEN RETURN NULL; END IF;
  INSERT INTO dealguard.intelligence_consents(portal_id,capability,changed_by) VALUES(p_portal,p_capability,p_actor) ON CONFLICT DO NOTHING;
  SELECT * INTO c FROM dealguard.intelligence_consents WHERE portal_id=p_portal AND capability=p_capability FOR UPDATE;
  IF c.revision<>p_revision THEN RETURN NULL; END IF;
  UPDATE dealguard.intelligence_consents SET enabled=p_enabled,revision=revision+1,changed_by=p_actor,updated_at=clock_timestamp()
    WHERE portal_id=p_portal AND capability=p_capability RETURNING * INTO c;
  IF NOT p_enabled AND p_capability='outcomes' AND NOT EXISTS(SELECT 1 FROM dealguard.legal_holds WHERE portal_id=p_portal AND status='active') THEN
    DELETE FROM dealguard.outcome_datasets WHERE portal_id=p_portal;
  END IF;
  INSERT INTO dealguard.audit_events(id,portal_id,action,user_id,metadata_json,created_at)
    VALUES(gen_random_uuid()::text,p_portal,'intelligence.consent_changed',p_actor,
    jsonb_build_object('capability',p_capability,'enabled',p_enabled,'revision',c.revision)::text,
    to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  RETURN to_jsonb(c);
END; $$;

CREATE FUNCTION dealguard.store_outcome_dataset(p_portal TEXT,p_revision INTEGER,p_id TEXT,p_fingerprint TEXT,p_manifest JSONB,p_samples JSONB)
RETURNS TEXT LANGUAGE plpgsql SET search_path=pg_catalog,dealguard AS $$
DECLARE c dealguard.intelligence_consents%ROWTYPE; result_id TEXT;
BEGIN
  SELECT * INTO c FROM dealguard.intelligence_consents WHERE portal_id=p_portal AND capability='outcomes' FOR UPDATE;
  IF NOT FOUND OR NOT c.enabled OR c.revision<>p_revision OR NOT EXISTS(SELECT 1 FROM dealguard.tenants WHERE portal_id=p_portal AND status='active') THEN RETURN NULL; END IF;
  INSERT INTO dealguard.outcome_datasets(portal_id,id,consent_revision,fingerprint,manifest,samples)
    VALUES(p_portal,p_id,p_revision,p_fingerprint,p_manifest,p_samples) ON CONFLICT DO NOTHING RETURNING id INTO result_id;
  IF result_id IS NULL THEN SELECT id INTO result_id FROM dealguard.outcome_datasets
    WHERE portal_id=p_portal AND consent_revision=p_revision AND fingerprint=p_fingerprint AND expires_at>clock_timestamp(); END IF;
  RETURN result_id;
END; $$;

CREATE FUNCTION dealguard.store_outcome_evaluation(p_portal TEXT,p_revision INTEGER,p_id TEXT,p_train TEXT,p_calibration TEXT,p_holdout TEXT,p_report JSONB,p_parameters JSONB)
RETURNS TEXT LANGUAGE plpgsql SET search_path=pg_catalog,dealguard AS $$
DECLARE c dealguard.intelligence_consents%ROWTYPE;
BEGIN
  SELECT * INTO c FROM dealguard.intelligence_consents WHERE portal_id=p_portal AND capability='outcomes' FOR UPDATE;
  IF NOT FOUND OR NOT c.enabled OR c.revision<>p_revision OR NOT EXISTS(SELECT 1 FROM dealguard.tenants WHERE portal_id=p_portal AND status='active') THEN RETURN NULL; END IF;
  IF (SELECT COUNT(*) FROM dealguard.outcome_datasets WHERE portal_id=p_portal AND id IN(p_train,p_calibration,p_holdout)
    AND consent_revision=p_revision AND expires_at>clock_timestamp())<>3 THEN RETURN NULL; END IF;
  INSERT INTO dealguard.outcome_evaluations(portal_id,id,consent_revision,train_id,calibration_id,holdout_id,report,parameters)
    VALUES(p_portal,p_id,p_revision,p_train,p_calibration,p_holdout,p_report,p_parameters);
  RETURN p_id;
END; $$;
