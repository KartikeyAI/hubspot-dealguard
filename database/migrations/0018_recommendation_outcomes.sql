SET search_path TO dealguard, public;

CREATE TABLE IF NOT EXISTS recommendation_instances (
  id TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL,
  deal_id TEXT NOT NULL,
  recommendation_fingerprint TEXT NOT NULL,
  recommendation_code TEXT NOT NULL,
  recommendation_label TEXT NOT NULL,
  recommendation_text TEXT NOT NULL,
  recommendation_dimension TEXT NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('high', 'medium', 'low')),
  owner_role TEXT NOT NULL CHECK (owner_role IN ('deal_owner', 'manager')),
  due_at TEXT,
  rationale TEXT NOT NULL,
  evidence_codes_json TEXT NOT NULL DEFAULT '[]',
  methodology TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('presented', 'accepted', 'completed', 'dismissed', 'expired', 'superseded')),
  terminal_reason TEXT,
  presented_at TEXT NOT NULL,
  last_presented_at TEXT NOT NULL,
  accepted_at TEXT,
  completed_at TEXT,
  dismissed_at TEXT,
  expired_at TEXT,
  superseded_at TEXT,
  accepted_by_user_id TEXT,
  accepted_by_email TEXT,
  completed_by_user_id TEXT,
  completed_by_email TEXT,
  dismissed_by_user_id TEXT,
  dismissed_by_email TEXT,
  dismissal_reason TEXT,
  baseline_assessment_at TEXT NOT NULL,
  baseline_snapshot_generated_at TEXT NOT NULL,
  baseline_readiness_score INTEGER CHECK (baseline_readiness_score IS NULL OR baseline_readiness_score BETWEEN 0 AND 100),
  baseline_readiness_status TEXT CHECK (baseline_readiness_status IS NULL OR baseline_readiness_status IN ('ready', 'at_risk', 'critical')),
  baseline_pipeline_id TEXT,
  baseline_stage_id TEXT,
  baseline_stage_label TEXT,
  baseline_owner_id TEXT,
  baseline_team_id TEXT,
  baseline_region_code TEXT,
  baseline_close_date TEXT,
  baseline_attention_score INTEGER CHECK (baseline_attention_score IS NULL OR baseline_attention_score BETWEEN 0 AND 100),
  baseline_brief_status TEXT CHECK (
    baseline_brief_status IS NULL OR baseline_brief_status IN ('on_track', 'watch', 'intervention_required', 'insufficient_evidence')
  ),
  baseline_dimensions_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (portal_id, deal_id, recommendation_fingerprint, baseline_assessment_at),
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE
);

CREATE OR REPLACE FUNCTION preserve_accepted_recommendation_definition()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'accepted' AND NEW.status = 'accepted' THEN
    NEW.recommendation_label := OLD.recommendation_label;
    NEW.recommendation_text := OLD.recommendation_text;
    NEW.recommendation_dimension := OLD.recommendation_dimension;
    NEW.priority := OLD.priority;
    NEW.owner_role := OLD.owner_role;
    NEW.due_at := OLD.due_at;
    NEW.rationale := OLD.rationale;
    NEW.evidence_codes_json := OLD.evidence_codes_json;
    NEW.methodology := OLD.methodology;
    NEW.last_presented_at := OLD.last_presented_at;
    NEW.updated_at := OLD.updated_at;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_preserve_accepted_recommendation_definition ON recommendation_instances;
CREATE TRIGGER trg_preserve_accepted_recommendation_definition
  BEFORE UPDATE ON recommendation_instances
  FOR EACH ROW EXECUTE FUNCTION preserve_accepted_recommendation_definition();

CREATE INDEX IF NOT EXISTS idx_recommendation_instances_queue
  ON recommendation_instances(portal_id, deal_id, status, due_at, presented_at DESC);
CREATE INDEX IF NOT EXISTS idx_recommendation_instances_analytics
  ON recommendation_instances(portal_id, presented_at DESC, recommendation_code, status);
CREATE INDEX IF NOT EXISTS idx_recommendation_instances_completed
  ON recommendation_instances(portal_id, completed_at, deal_id)
  WHERE completed_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS recommendation_events (
  id TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL,
  recommendation_id TEXT NOT NULL,
  deal_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (
    event_type IN ('presented', 'accepted', 'completed', 'dismissed', 'expired', 'superseded', 'outcome_observed')
  ),
  actor_user_id TEXT,
  actor_email TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL,
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE,
  FOREIGN KEY (recommendation_id) REFERENCES recommendation_instances(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_recommendation_events_portal_time
  ON recommendation_events(portal_id, occurred_at DESC, event_type);
CREATE INDEX IF NOT EXISTS idx_recommendation_events_instance
  ON recommendation_events(recommendation_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS recommendation_outcomes (
  recommendation_id TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL,
  deal_id TEXT NOT NULL,
  evaluation_status TEXT NOT NULL CHECK (evaluation_status IN ('pending', 'observed', 'insufficient_evidence')),
  observed_progress TEXT CHECK (
    observed_progress IS NULL OR observed_progress IN ('improved', 'mixed', 'unchanged', 'worsened', 'insufficient_evidence')
  ),
  observation_assessment_at TEXT,
  observation_generated_at TEXT,
  readiness_delta INTEGER,
  attention_delta INTEGER,
  stage_changed INTEGER,
  close_date_delta_days REAL,
  dimension_deltas_json TEXT NOT NULL DEFAULT '{}',
  evidence_no_longer_observed_json TEXT NOT NULL DEFAULT '[]',
  recommendation_still_current INTEGER,
  positive_signal_count INTEGER NOT NULL DEFAULT 0,
  negative_signal_count INTEGER NOT NULL DEFAULT 0,
  explanation TEXT,
  causal_attribution INTEGER NOT NULL DEFAULT 0 CHECK (causal_attribution = 0),
  first_observed_at TEXT,
  last_observed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE,
  FOREIGN KEY (recommendation_id) REFERENCES recommendation_instances(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_recommendation_outcomes_portal_progress
  ON recommendation_outcomes(portal_id, observed_progress, last_observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_recommendation_outcomes_deal
  ON recommendation_outcomes(portal_id, deal_id, last_observed_at DESC);
