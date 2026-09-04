SET search_path TO dealguard, public;

CREATE TABLE recommendation_delivery_events (
  id TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'policy_matched',
    'quiet_hours_deferred',
    'cooldown_suppressed',
    'notification_limit_suppressed',
    'route_unavailable',
    'dispatch_resolved'
  )),
  authorization_mode TEXT NOT NULL DEFAULT 'configured_policy'
    CHECK (authorization_mode IN ('human_confirmation', 'configured_policy')),
  policy_id TEXT,
  dispatch_id TEXT,
  batch_id TEXT,
  recommendation_id TEXT,
  route_id TEXT,
  stage TEXT CHECK (stage IS NULL OR stage IN ('initial', 'repeat', 'escalation')),
  reason_code TEXT,
  severity TEXT CHECK (severity IS NULL OR severity IN ('info', 'warning', 'critical')),
  event_at TEXT NOT NULL,
  recommendation_due_at TEXT,
  sla_due_at TEXT,
  pipeline_id TEXT,
  team_id TEXT,
  owner_id TEXT,
  region_code TEXT,
  dedupe_key TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE (portal_id, id),
  UNIQUE (portal_id, dedupe_key),
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE
);

CREATE INDEX idx_recommendation_delivery_events_time
  ON recommendation_delivery_events(portal_id, event_at DESC, event_type);
CREATE INDEX idx_recommendation_delivery_events_policy
  ON recommendation_delivery_events(portal_id, policy_id, event_at DESC);
CREATE INDEX idx_recommendation_delivery_events_route
  ON recommendation_delivery_events(portal_id, route_id, event_at DESC);
CREATE INDEX idx_recommendation_delivery_events_dispatch
  ON recommendation_delivery_events(portal_id, dispatch_id, event_at DESC);
CREATE INDEX idx_recommendation_delivery_events_recommendation
  ON recommendation_delivery_events(portal_id, recommendation_id, event_at DESC);
CREATE INDEX idx_recommendation_delivery_events_scope
  ON recommendation_delivery_events(portal_id, pipeline_id, team_id, owner_id, region_code, event_at DESC);
