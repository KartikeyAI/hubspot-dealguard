SET search_path TO dealguard, public;

CREATE TABLE recommendation_delivery_slo_policies (
  id TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL,
  name TEXT NOT NULL,
  metric TEXT NOT NULL CHECK (metric IN (
    'delivery_success_percent',
    'failure_count',
    'route_unavailable_count',
    'escalation_sla_breach_count',
    'p95_completion_minutes'
  )),
  target_type TEXT NOT NULL CHECK (target_type IN ('portal', 'route', 'channel', 'routing_policy')),
  target_id TEXT,
  comparison TEXT NOT NULL CHECK (comparison IN ('minimum', 'maximum')),
  threshold_value NUMERIC NOT NULL,
  window_minutes INTEGER NOT NULL CHECK (window_minutes BETWEEN 60 AND 43200),
  minimum_samples INTEGER NOT NULL CHECK (minimum_samples BETWEEN 1 AND 10000),
  breach_evaluations INTEGER NOT NULL CHECK (breach_evaluations BETWEEN 1 AND 10),
  recovery_evaluations INTEGER NOT NULL CHECK (recovery_evaluations BETWEEN 1 AND 10),
  severity TEXT NOT NULL CHECK (severity IN ('warning', 'critical')),
  notification_route_id TEXT NOT NULL,
  alert_cooldown_minutes INTEGER NOT NULL CHECK (alert_cooldown_minutes BETWEEN 15 AND 43200),
  max_alerts_per_incident INTEGER NOT NULL CHECK (max_alerts_per_incident BETWEEN 1 AND 10),
  notify_recovery INTEGER NOT NULL DEFAULT 1 CHECK (notify_recovery IN (0, 1)),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  created_by_user_id TEXT,
  created_by_email TEXT,
  updated_by_user_id TEXT,
  updated_by_email TEXT,
  last_evaluated_at TEXT,
  last_value NUMERIC,
  last_sample_count INTEGER NOT NULL DEFAULT 0 CHECK (last_sample_count >= 0),
  last_status TEXT CHECK (
    last_status IS NULL OR last_status IN ('insufficient_data', 'meeting', 'breaching', 'breached', 'recovering')
  ),
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (portal_id, id),
  UNIQUE (portal_id, name),
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE,
  FOREIGN KEY (portal_id, notification_route_id)
    REFERENCES notification_routes(portal_id, id)
    ON DELETE NO ACTION
);

CREATE TABLE recommendation_delivery_slo_states (
  portal_id TEXT NOT NULL,
  slo_policy_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('insufficient_data', 'meeting', 'breaching', 'breached', 'recovering')),
  consecutive_breaches INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_breaches BETWEEN 0 AND 1000),
  consecutive_recoveries INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_recoveries BETWEEN 0 AND 1000),
  first_breached_at TEXT,
  last_breached_at TEXT,
  last_recovered_at TEXT,
  last_alert_at TEXT,
  next_alert_at TEXT,
  current_value NUMERIC,
  sample_count INTEGER NOT NULL DEFAULT 0 CHECK (sample_count >= 0),
  evidence_start_at TEXT,
  evidence_end_at TEXT,
  evidence_truncated INTEGER NOT NULL DEFAULT 0 CHECK (evidence_truncated IN (0, 1)),
  last_reason TEXT,
  evaluated_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (portal_id, slo_policy_id),
  FOREIGN KEY (portal_id, slo_policy_id)
    REFERENCES recommendation_delivery_slo_policies(portal_id, id)
    ON DELETE CASCADE
);

CREATE TABLE recommendation_delivery_slo_incidents (
  id TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL,
  slo_policy_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'acknowledged', 'resolved')),
  severity TEXT NOT NULL CHECK (severity IN ('warning', 'critical')),
  metric TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  comparison TEXT NOT NULL CHECK (comparison IN ('minimum', 'maximum')),
  threshold_value NUMERIC NOT NULL,
  first_value NUMERIC,
  worst_value NUMERIC,
  last_value NUMERIC,
  last_sample_count INTEGER NOT NULL DEFAULT 0 CHECK (last_sample_count >= 0),
  opened_at TEXT NOT NULL,
  last_observed_at TEXT NOT NULL,
  acknowledged_by_user_id TEXT,
  acknowledged_by_email TEXT,
  acknowledged_at TEXT,
  resolved_at TEXT,
  resolution_reason TEXT,
  alert_count INTEGER NOT NULL DEFAULT 0 CHECK (alert_count BETWEEN 0 AND 10),
  last_notification_id TEXT,
  last_notification_status TEXT CHECK (
    last_notification_status IS NULL OR last_notification_status IN (
      'queued', 'delivering', 'deferred', 'delivered', 'partially_failed', 'failed'
    )
  ),
  last_alert_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (portal_id, id),
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE,
  FOREIGN KEY (portal_id, slo_policy_id)
    REFERENCES recommendation_delivery_slo_policies(portal_id, id)
    ON DELETE NO ACTION
);

CREATE UNIQUE INDEX uq_recommendation_delivery_slo_open_incident
  ON recommendation_delivery_slo_incidents(portal_id, slo_policy_id)
  WHERE status IN ('open', 'acknowledged');

CREATE OR REPLACE FUNCTION protect_recommendation_delivery_slo_incident_semantics()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM dealguard.recommendation_delivery_slo_incidents incident
    WHERE incident.portal_id = OLD.portal_id
      AND incident.slo_policy_id = OLD.id
      AND incident.status IN ('open', 'acknowledged')
  ) AND (
    NEW.metric IS DISTINCT FROM OLD.metric
    OR NEW.target_type IS DISTINCT FROM OLD.target_type
    OR NEW.target_id IS DISTINCT FROM OLD.target_id
    OR NEW.comparison IS DISTINCT FROM OLD.comparison
    OR NEW.threshold_value IS DISTINCT FROM OLD.threshold_value
    OR NEW.window_minutes IS DISTINCT FROM OLD.window_minutes
    OR NEW.minimum_samples IS DISTINCT FROM OLD.minimum_samples
    OR NEW.breach_evaluations IS DISTINCT FROM OLD.breach_evaluations
    OR NEW.recovery_evaluations IS DISTINCT FROM OLD.recovery_evaluations
    OR NEW.severity IS DISTINCT FROM OLD.severity
    OR NEW.notification_route_id IS DISTINCT FROM OLD.notification_route_id
    OR NEW.alert_cooldown_minutes IS DISTINCT FROM OLD.alert_cooldown_minutes
    OR NEW.max_alerts_per_incident IS DISTINCT FROM OLD.max_alerts_per_incident
    OR NEW.notify_recovery IS DISTINCT FROM OLD.notify_recovery
  ) THEN
    RAISE EXCEPTION 'Recommendation delivery SLO semantics cannot change while an incident is active.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_protect_recommendation_delivery_slo_incident_semantics
  BEFORE UPDATE ON recommendation_delivery_slo_policies
  FOR EACH ROW
  EXECUTE FUNCTION protect_recommendation_delivery_slo_incident_semantics();

CREATE TABLE recommendation_delivery_slo_notifications (
  id TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL,
  slo_policy_id TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  route_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'recommendation.delivery.slo.breached',
    'recommendation.delivery.slo.reminder',
    'recommendation.delivery.slo.recovered'
  )),
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  status TEXT NOT NULL CHECK (status IN (
    'queued', 'delivering', 'deferred', 'delivered', 'partially_failed', 'failed'
  )),
  routing_fingerprint TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  delivery_summary_json TEXT NOT NULL DEFAULT '[]',
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  available_at TEXT NOT NULL,
  last_error TEXT,
  dedupe_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (portal_id, id),
  UNIQUE (portal_id, dedupe_key),
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE,
  FOREIGN KEY (portal_id, slo_policy_id)
    REFERENCES recommendation_delivery_slo_policies(portal_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (portal_id, incident_id)
    REFERENCES recommendation_delivery_slo_incidents(portal_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (portal_id, route_id)
    REFERENCES notification_routes(portal_id, id)
    ON DELETE NO ACTION
);

CREATE INDEX idx_recommendation_delivery_slo_policies_schedule
  ON recommendation_delivery_slo_policies(portal_id, enabled, updated_at);
CREATE INDEX idx_recommendation_delivery_slo_policies_target
  ON recommendation_delivery_slo_policies(portal_id, target_type, target_id, metric);
CREATE INDEX idx_recommendation_delivery_slo_states_status
  ON recommendation_delivery_slo_states(portal_id, status, evaluated_at DESC);
CREATE INDEX idx_recommendation_delivery_slo_incidents_status
  ON recommendation_delivery_slo_incidents(portal_id, status, opened_at DESC);
CREATE INDEX idx_recommendation_delivery_slo_incidents_policy
  ON recommendation_delivery_slo_incidents(portal_id, slo_policy_id, last_observed_at DESC);
CREATE INDEX idx_recommendation_delivery_slo_notifications_queue
  ON recommendation_delivery_slo_notifications(portal_id, status, available_at, created_at);
CREATE INDEX idx_recommendation_delivery_slo_notifications_incident
  ON recommendation_delivery_slo_notifications(portal_id, incident_id, created_at DESC);
CREATE INDEX idx_recommendation_delivery_slo_notifications_route
  ON recommendation_delivery_slo_notifications(portal_id, route_id, created_at DESC);
