SET search_path TO dealguard, public;

DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  FOR constraint_name IN
    SELECT constraint_info.conname
    FROM pg_constraint constraint_info
    JOIN pg_class relation ON relation.oid = constraint_info.conrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'dealguard'
      AND relation.relname = 'secure_download_tokens'
      AND constraint_info.contype = 'c'
      AND pg_get_constraintdef(constraint_info.oid) ILIKE '%kind%'
  LOOP
    EXECUTE format('ALTER TABLE dealguard.secure_download_tokens DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END;
$$;

ALTER TABLE secure_download_tokens
  ADD CONSTRAINT secure_download_tokens_kind_check
  CHECK (kind IN ('policy', 'analytics', 'audit', 'data_export', 'recommendation_evidence'));

DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  FOR constraint_name IN
    SELECT constraint_info.conname
    FROM pg_constraint constraint_info
    JOIN pg_class relation ON relation.oid = constraint_info.conrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'dealguard'
      AND relation.relname = 'recommendation_events'
      AND constraint_info.contype = 'c'
      AND pg_get_constraintdef(constraint_info.oid) ILIKE '%event_type%'
  LOOP
    EXECUTE format('ALTER TABLE dealguard.recommendation_events DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END;
$$;

ALTER TABLE recommendation_events
  ADD CONSTRAINT recommendation_events_event_type_check
  CHECK (event_type IN (
    'presented', 'accepted', 'completed', 'dismissed', 'expired', 'superseded',
    'outcome_observed', 'followup_requested'
  ));

CREATE TABLE IF NOT EXISTS recommendation_followup_batches (
  id TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('owner_reminder', 'manager_review')),
  severity TEXT NOT NULL CHECK (severity IN ('warning', 'critical')),
  manager_note TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('previewed', 'queued', 'delivering', 'completed', 'partially_failed', 'failed', 'expired')
  ),
  requested_count INTEGER NOT NULL DEFAULT 0 CHECK (requested_count >= 0),
  eligible_count INTEGER NOT NULL DEFAULT 0 CHECK (eligible_count >= 0),
  delivery_ready_count INTEGER NOT NULL DEFAULT 0 CHECK (delivery_ready_count >= 0),
  confirmed_count INTEGER NOT NULL DEFAULT 0 CHECK (confirmed_count >= 0),
  delivered_count INTEGER NOT NULL DEFAULT 0 CHECK (delivered_count >= 0),
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  routing_summary_json TEXT NOT NULL DEFAULT '{}',
  preview_expires_at TEXT NOT NULL,
  created_by_user_id TEXT,
  created_by_email TEXT,
  confirmed_by_user_id TEXT,
  confirmed_by_email TEXT,
  confirmed_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS recommendation_followup_items (
  id TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  recommendation_id TEXT NOT NULL,
  deal_id TEXT NOT NULL,
  recommendation_code TEXT NOT NULL,
  recommendation_label TEXT NOT NULL,
  recommendation_text TEXT NOT NULL,
  recommendation_status TEXT NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('high', 'medium', 'low')),
  due_at TEXT,
  pipeline_id TEXT,
  team_id TEXT,
  owner_id TEXT,
  region_code TEXT,
  matched_route_ids_json TEXT NOT NULL DEFAULT '[]',
  matched_channel_ids_json TEXT NOT NULL DEFAULT '[]',
  routing_fingerprint TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('previewed', 'unroutable', 'queued', 'delivering', 'delivered', 'partially_failed', 'failed', 'skipped')
  ),
  ineligibility_reason TEXT,
  delivery_summary_json TEXT NOT NULL DEFAULT '[]',
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (batch_id, recommendation_id),
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE,
  FOREIGN KEY (batch_id) REFERENCES recommendation_followup_batches(id) ON DELETE CASCADE,
  FOREIGN KEY (recommendation_id) REFERENCES recommendation_instances(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_recommendation_followup_batches_status
  ON recommendation_followup_batches(portal_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recommendation_followup_items_delivery
  ON recommendation_followup_items(portal_id, batch_id, status);
CREATE INDEX IF NOT EXISTS idx_recommendation_followup_items_recommendation
  ON recommendation_followup_items(portal_id, recommendation_id, created_at DESC);
