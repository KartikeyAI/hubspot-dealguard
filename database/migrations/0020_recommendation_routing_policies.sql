SET search_path TO dealguard, public;

CREATE TABLE recommendation_routing_policies (
  id TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL,
  name TEXT NOT NULL,
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('due_soon', 'overdue')),
  status_scope TEXT NOT NULL CHECK (status_scope IN ('presented', 'accepted', 'both')),
  minimum_priority TEXT NOT NULL CHECK (minimum_priority IN ('low', 'medium', 'high')),
  threshold_minutes INTEGER NOT NULL CHECK (threshold_minutes BETWEEN 0 AND 43200),
  cooldown_minutes INTEGER NOT NULL CHECK (cooldown_minutes BETWEEN 15 AND 43200),
  max_notifications INTEGER NOT NULL CHECK (max_notifications BETWEEN 1 AND 10),
  severity TEXT NOT NULL CHECK (severity IN ('warning', 'critical')),
  route_id TEXT NOT NULL,
  escalation_route_id TEXT,
  escalation_after_minutes INTEGER CHECK (
    escalation_after_minutes IS NULL OR escalation_after_minutes BETWEEN 15 AND 43200
  ),
  manager_note TEXT NOT NULL CHECK (char_length(manager_note) BETWEEN 10 AND 2000),
  pipeline_ids_json TEXT NOT NULL DEFAULT '[]',
  team_ids_json TEXT NOT NULL DEFAULT '[]',
  owner_ids_json TEXT NOT NULL DEFAULT '[]',
  region_codes_json TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  created_by_user_id TEXT,
  created_by_email TEXT,
  updated_by_user_id TEXT,
  updated_by_email TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_evaluated_at TEXT,
  last_match_count INTEGER NOT NULL DEFAULT 0 CHECK (last_match_count >= 0),
  last_queue_count INTEGER NOT NULL DEFAULT 0 CHECK (last_queue_count >= 0),
  last_error TEXT,
  UNIQUE (portal_id, id),
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE,
  FOREIGN KEY (portal_id, route_id)
    REFERENCES notification_routes(portal_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (portal_id, escalation_route_id)
    REFERENCES notification_routes(portal_id, id)
    ON DELETE RESTRICT
);

CREATE TABLE recommendation_policy_dispatches (
  id TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  recommendation_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'resolved')),
  first_matched_at TEXT NOT NULL,
  first_queued_at TEXT,
  last_queued_at TEXT,
  next_eligible_at TEXT,
  notification_count INTEGER NOT NULL DEFAULT 0 CHECK (notification_count BETWEEN 0 AND 10),
  escalation_count INTEGER NOT NULL DEFAULT 0 CHECK (escalation_count BETWEEN 0 AND 1),
  escalated_at TEXT,
  last_batch_id TEXT,
  last_delivery_status TEXT CHECK (
    last_delivery_status IS NULL OR last_delivery_status IN ('queued', 'completed', 'partially_failed', 'failed')
  ),
  resolved_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (portal_id, id),
  UNIQUE (portal_id, policy_id, recommendation_id),
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE,
  FOREIGN KEY (portal_id, policy_id)
    REFERENCES recommendation_routing_policies(portal_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (portal_id, recommendation_id)
    REFERENCES recommendation_instances(portal_id, id)
    ON DELETE CASCADE
);

ALTER TABLE recommendation_followup_batches
  ADD COLUMN authorization_mode TEXT NOT NULL DEFAULT 'human_confirmation'
    CHECK (authorization_mode IN ('human_confirmation', 'configured_policy')),
  ADD COLUMN automation_policy_id TEXT;

ALTER TABLE recommendation_followup_batches
  ADD CONSTRAINT fk_recommendation_followup_batch_policy
  FOREIGN KEY (automation_policy_id)
  REFERENCES recommendation_routing_policies(id)
  ON DELETE SET NULL;

ALTER TABLE recommendation_followup_items
  ADD COLUMN policy_dispatch_id TEXT;

ALTER TABLE recommendation_followup_items
  ADD CONSTRAINT fk_recommendation_followup_item_dispatch
  FOREIGN KEY (policy_dispatch_id)
  REFERENCES recommendation_policy_dispatches(id)
  ON DELETE SET NULL;

CREATE INDEX idx_recommendation_routing_policies_schedule
  ON recommendation_routing_policies(portal_id, enabled, trigger_kind, updated_at);
CREATE INDEX idx_recommendation_routing_policies_route
  ON recommendation_routing_policies(portal_id, route_id, escalation_route_id);
CREATE INDEX idx_recommendation_policy_dispatches_due
  ON recommendation_policy_dispatches(portal_id, policy_id, state, next_eligible_at);
CREATE INDEX idx_recommendation_policy_dispatches_recommendation
  ON recommendation_policy_dispatches(portal_id, recommendation_id, updated_at DESC);
CREATE INDEX idx_recommendation_policy_dispatches_delivery
  ON recommendation_policy_dispatches(portal_id, last_delivery_status, last_queued_at DESC);
CREATE INDEX idx_recommendation_followup_batches_policy
  ON recommendation_followup_batches(portal_id, automation_policy_id, created_at DESC);
CREATE INDEX idx_recommendation_followup_items_dispatch
  ON recommendation_followup_items(portal_id, policy_dispatch_id, updated_at DESC);
