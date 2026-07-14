PRAGMA foreign_keys = ON;

-- Commercial subscriptions and metering are provider-neutral. The legacy
-- Stripe table remains intact for rollback/audit; subscriptions_v2 is authoritative.
CREATE TABLE IF NOT EXISTS subscriptions_v2 (
  portal_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK(provider IN ('dodo', 'manual')),
  provider_customer_id TEXT,
  provider_subscription_id TEXT,
  provider_product_id TEXT,
  tier TEXT NOT NULL CHECK(tier IN ('free', 'growth', 'enterprise')),
  status TEXT NOT NULL CHECK(status IN ('pending', 'trialing', 'active', 'on_hold', 'past_due', 'failed', 'expired', 'cancelled', 'manual')),
  billing_interval TEXT CHECK(billing_interval IN ('month', 'year', 'contract')),
  usage_mode TEXT NOT NULL DEFAULT 'capped' CHECK(usage_mode IN ('capped', 'metered')),
  overage_enabled INTEGER NOT NULL DEFAULT 0,
  currency TEXT,
  current_period_start TEXT,
  current_period_end TEXT,
  trial_ends_at TEXT,
  grace_ends_at TEXT,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  contract_reference TEXT,
  purchase_order_reference TEXT,
  scheduled_tier TEXT CHECK(scheduled_tier IN ('free', 'growth', 'enterprise')),
  scheduled_change_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_v2_customer ON subscriptions_v2(provider, provider_customer_id) WHERE provider_customer_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_v2_subscription ON subscriptions_v2(provider, provider_subscription_id) WHERE provider_subscription_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS billing_usage_events (
  id TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL,
  event_name TEXT NOT NULL,
  quantity REAL NOT NULL CHECK(quantity >= 0),
  idempotency_key TEXT NOT NULL,
  provider_event_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending', 'reported', 'failed', 'ignored')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL,
  reported_at TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(portal_id, idempotency_key),
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_billing_usage_pending ON billing_usage_events(status, occurred_at);
CREATE INDEX IF NOT EXISTS idx_billing_usage_portal ON billing_usage_events(portal_id, event_name, occurred_at);

CREATE TABLE IF NOT EXISTS billing_allowances (
  portal_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  included_quantity REAL NOT NULL DEFAULT 0,
  hard_limit REAL,
  overage_enabled INTEGER NOT NULL DEFAULT 0,
  reset_period TEXT NOT NULL DEFAULT 'month' CHECK(reset_period IN ('month', 'year', 'contract')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (portal_id, metric),
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS billing_contracts (
  id TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL,
  contract_reference TEXT NOT NULL,
  purchase_order_reference TEXT,
  tier TEXT NOT NULL CHECK(tier IN ('growth', 'enterprise')),
  starts_at TEXT NOT NULL,
  ends_at TEXT,
  renewal_mode TEXT NOT NULL CHECK(renewal_mode IN ('manual', 'automatic')),
  currency TEXT NOT NULL,
  committed_amount_minor INTEGER NOT NULL DEFAULT 0,
  invoice_status TEXT NOT NULL DEFAULT 'pending' CHECK(invoice_status IN ('pending', 'issued', 'paid', 'overdue', 'void')),
  terms_json TEXT NOT NULL DEFAULT '{}',
  created_by_user_id TEXT,
  created_by_email TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(portal_id, contract_reference),
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE
);

-- Fine-grained enterprise access roles and data scopes.
CREATE TABLE IF NOT EXISTS enterprise_role_assignments (
  id TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL,
  user_id TEXT,
  user_email TEXT,
  role TEXT NOT NULL CHECK(role IN ('administrator', 'policy_administrator', 'revops_manager', 'sales_manager', 'reviewer', 'remediation_manager', 'compliance_auditor', 'billing_administrator', 'viewer')),
  permissions_json TEXT NOT NULL DEFAULT '[]',
  pipeline_ids_json TEXT NOT NULL DEFAULT '[]',
  team_ids_json TEXT NOT NULL DEFAULT '[]',
  owner_ids_json TEXT NOT NULL DEFAULT '[]',
  region_codes_json TEXT NOT NULL DEFAULT '[]',
  created_by_user_id TEXT,
  created_by_email TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(portal_id, user_id),
  UNIQUE(portal_id, user_email),
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_enterprise_roles_portal ON enterprise_role_assignments(portal_id, role);

CREATE TABLE IF NOT EXISTS change_approval_requests (
  id TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL,
  change_type TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  requested_payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected', 'applied', 'cancelled', 'expired')),
  requested_by_user_id TEXT,
  requested_by_email TEXT,
  decided_by_user_id TEXT,
  decided_by_email TEXT,
  decision_comment TEXT,
  requested_at TEXT NOT NULL,
  decided_at TEXT,
  applied_at TEXT,
  expires_at TEXT,
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_change_approval_queue ON change_approval_requests(portal_id, status, requested_at DESC);

-- Policy templates, segmentation, portability, diffs, and exceptions.
CREATE TABLE IF NOT EXISTS policy_templates (
  id TEXT PRIMARY KEY,
  owner_portal_id TEXT,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  industry TEXT,
  rules_json TEXT NOT NULL,
  segments_json TEXT NOT NULL DEFAULT '[]',
  is_system INTEGER NOT NULL DEFAULT 0,
  created_by_user_id TEXT,
  created_by_email TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_portal_id, key),
  FOREIGN KEY (owner_portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS policy_segments (
  id TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  name TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  enabled INTEGER NOT NULL DEFAULT 1,
  conditions_json TEXT NOT NULL,
  rules_override_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE,
  FOREIGN KEY (policy_id) REFERENCES policy_versions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_policy_segments_policy ON policy_segments(policy_id, enabled, priority);

CREATE TABLE IF NOT EXISTS policy_diffs (
  policy_id TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL,
  base_policy_id TEXT,
  diff_json TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE,
  FOREIGN KEY (policy_id) REFERENCES policy_versions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS policy_import_exports (
  id TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('import', 'export')),
  checksum TEXT NOT NULL,
  format_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('completed', 'failed')),
  actor_user_id TEXT,
  actor_email TEXT,
  created_at TEXT NOT NULL,
  error_message TEXT,
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS policy_exception_comments (
  id TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL,
  exception_id TEXT NOT NULL,
  body TEXT NOT NULL,
  actor_user_id TEXT,
  actor_email TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE,
  FOREIGN KEY (exception_id) REFERENCES policy_exceptions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS policy_exception_evidence (
  id TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL,
  exception_id TEXT NOT NULL,
  evidence_type TEXT NOT NULL CHECK(evidence_type IN ('url', 'text', 'hubspot_object', 'external_reference')),
  label TEXT NOT NULL,
  value TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_by_user_id TEXT,
  created_by_email TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE,
  FOREIGN KEY (exception_id) REFERENCES policy_exceptions(id) ON DELETE CASCADE
);

-- Historical assessment data powers trends, heat maps, and policy impact.
CREATE TABLE IF NOT EXISTS assessment_history (
  id TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL,
  deal_id TEXT NOT NULL,
  score INTEGER NOT NULL,
  grade TEXT NOT NULL,
  status TEXT NOT NULL,
  issue_codes_json TEXT NOT NULL,
  issue_count INTEGER NOT NULL,
  pipeline_id TEXT,
  pipeline_label TEXT NOT NULL,
  stage_id TEXT,
  stage_label TEXT NOT NULL,
  owner_id TEXT,
  team_id TEXT,
  region_code TEXT,
  deal_type TEXT,
  deal_amount REAL,
  stage_age_days INTEGER,
  is_closed INTEGER NOT NULL,
  is_won INTEGER NOT NULL,
  policy_id TEXT,
  trigger_type TEXT NOT NULL,
  assessed_at TEXT NOT NULL,
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE,
  FOREIGN KEY (policy_id) REFERENCES policy_versions(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_assessment_history_portal_time ON assessment_history(portal_id, assessed_at DESC);
CREATE INDEX IF NOT EXISTS idx_assessment_history_breakdowns ON assessment_history(portal_id, pipeline_id, stage_id, owner_id, team_id, region_code);

CREATE TABLE IF NOT EXISTS analytics_saved_views (
  id TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL,
  name TEXT NOT NULL,
  audience TEXT NOT NULL CHECK(audience IN ('executive', 'revops', 'sales_manager', 'representative', 'custom')),
  filters_json TEXT NOT NULL DEFAULT '{}',
  columns_json TEXT NOT NULL DEFAULT '[]',
  created_by_user_id TEXT,
  created_by_email TEXT,
  is_shared INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_analytics_views_portal ON analytics_saved_views(portal_id, audience, created_at);

-- Evidence-based remediation and bulk operations.
ALTER TABLE remediation_cases ADD COLUMN evidence_required INTEGER NOT NULL DEFAULT 0;
ALTER TABLE remediation_cases ADD COLUMN evidence_status TEXT NOT NULL DEFAULT 'not_required';
ALTER TABLE remediation_cases ADD COLUMN acknowledgement_required INTEGER NOT NULL DEFAULT 0;
ALTER TABLE remediation_cases ADD COLUMN escalation_level INTEGER NOT NULL DEFAULT 0;
ALTER TABLE remediation_cases ADD COLUMN manager_owner_id TEXT;
ALTER TABLE remediation_cases ADD COLUMN manager_owner_email TEXT;

CREATE TABLE IF NOT EXISTS remediation_comments (
  id TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  body TEXT NOT NULL,
  actor_user_id TEXT,
  actor_email TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE,
  FOREIGN KEY (case_id) REFERENCES remediation_cases(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS remediation_evidence (
  id TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  evidence_type TEXT NOT NULL CHECK(evidence_type IN ('url', 'text', 'hubspot_object', 'external_reference')),
  label TEXT NOT NULL,
  value TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  submitted_by_user_id TEXT,
  submitted_by_email TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE,
  FOREIGN KEY (case_id) REFERENCES remediation_cases(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS remediation_bulk_jobs (
  id TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  input_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'completed', 'partially_failed', 'failed')),
  total_count INTEGER NOT NULL DEFAULT 0,
  succeeded_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  result_json TEXT NOT NULL DEFAULT '{}',
  requested_by_user_id TEXT,
  requested_by_email TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE
);

-- Multi-channel routing, quiet hours, escalation and acknowledgements.
CREATE TABLE IF NOT EXISTS notification_channels (
  id TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('slack_webhook', 'teams_workflow', 'email', 'webhook')),
  name TEXT NOT NULL,
  endpoint_cipher TEXT,
  endpoint_iv TEXT,
  signing_secret_cipher TEXT,
  signing_secret_iv TEXT,
  config_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by_user_id TEXT,
  created_by_email TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notification_routes (
  id TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL,
  name TEXT NOT NULL,
  event_types_json TEXT NOT NULL DEFAULT '[]',
  minimum_severity TEXT NOT NULL DEFAULT 'info' CHECK(minimum_severity IN ('info', 'warning', 'critical')),
  pipeline_ids_json TEXT NOT NULL DEFAULT '[]',
  team_ids_json TEXT NOT NULL DEFAULT '[]',
  owner_ids_json TEXT NOT NULL DEFAULT '[]',
  region_codes_json TEXT NOT NULL DEFAULT '[]',
  channel_ids_json TEXT NOT NULL DEFAULT '[]',
  direct_owner INTEGER NOT NULL DEFAULT 0,
  direct_manager INTEGER NOT NULL DEFAULT 0,
  quiet_hours_calendar_id TEXT,
  escalation_policy_id TEXT,
  suppression_window_minutes INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_notification_routes_portal ON notification_routes(portal_id, enabled);

CREATE TABLE IF NOT EXISTS business_calendars (
  id TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL,
  weekly_schedule_json TEXT NOT NULL,
  holidays_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS escalation_policies (
  id TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL,
  name TEXT NOT NULL,
  steps_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS alert_instances (
  id TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL,
  outbox_event_id TEXT,
  route_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('queued', 'sent', 'acknowledged', 'suppressed', 'escalated', 'failed')),
  acknowledged_by_user_id TEXT,
  acknowledged_by_email TEXT,
  acknowledged_at TEXT,
  suppression_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_alert_instances_queue ON alert_instances(portal_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS alert_suppressions (
  id TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL,
  suppression_key TEXT NOT NULL,
  reason TEXT NOT NULL,
  expires_at TEXT,
  created_by_user_id TEXT,
  created_by_email TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(portal_id, suppression_key),
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE
);

-- Immutable audit chain, compliance exports, SIEM, retention, and legal hold.
CREATE TABLE IF NOT EXISTS audit_events_v2 (
  id TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL,
  sequence_number INTEGER NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  actor_user_id TEXT,
  actor_email TEXT,
  source TEXT NOT NULL,
  request_id TEXT,
  ip_hash TEXT,
  user_agent_hash TEXT,
  before_json TEXT,
  after_json TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  previous_hash TEXT,
  event_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(portal_id, sequence_number),
  UNIQUE(portal_id, event_hash)
);
CREATE INDEX IF NOT EXISTS idx_audit_v2_search ON audit_events_v2(portal_id, action, resource_type, created_at DESC);

CREATE TABLE IF NOT EXISTS compliance_settings (
  portal_id TEXT PRIMARY KEY,
  audit_retention_days INTEGER NOT NULL DEFAULT 2555,
  operational_retention_days INTEGER NOT NULL DEFAULT 365,
  legal_hold_enabled INTEGER NOT NULL DEFAULT 0,
  legal_hold_reason TEXT,
  data_region TEXT NOT NULL DEFAULT 'global',
  updated_by_user_id TEXT,
  updated_by_email TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS siem_destinations (
  id TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL,
  name TEXT NOT NULL,
  endpoint_cipher TEXT NOT NULL,
  endpoint_iv TEXT NOT NULL,
  signing_secret_cipher TEXT NOT NULL,
  signing_secret_iv TEXT NOT NULL,
  event_filters_json TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_success_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS data_export_jobs (
  id TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL,
  format TEXT NOT NULL CHECK(format IN ('json', 'csv', 'jsonl')),
  scope TEXT NOT NULL CHECK(scope IN ('audit', 'configuration', 'operational', 'complete')),
  status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'completed', 'failed', 'expired')),
  object_key TEXT,
  checksum TEXT,
  requested_by_user_id TEXT,
  requested_by_email TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  expires_at TEXT,
  error_message TEXT,
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS legal_holds (
  id TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL,
  name TEXT NOT NULL,
  reason TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active', 'released')),
  created_by_user_id TEXT,
  created_by_email TEXT,
  created_at TEXT NOT NULL,
  released_at TEXT,
  released_by_user_id TEXT,
  released_by_email TEXT,
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE
);

-- SLOs, telemetry, incident handling, resumable scans, backup/restore evidence.
CREATE TABLE IF NOT EXISTS service_slos (
  portal_id TEXT NOT NULL,
  service TEXT NOT NULL,
  availability_target REAL NOT NULL,
  latency_p95_ms_target INTEGER,
  success_rate_target REAL,
  window_days INTEGER NOT NULL DEFAULT 30,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (portal_id, service),
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS operational_metrics (
  id TEXT PRIMARY KEY,
  portal_id TEXT,
  service TEXT NOT NULL,
  metric TEXT NOT NULL,
  value REAL NOT NULL,
  dimensions_json TEXT NOT NULL DEFAULT '{}',
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_operational_metrics_query ON operational_metrics(portal_id, service, metric, recorded_at DESC);

CREATE TABLE IF NOT EXISTS synthetic_checks (
  id TEXT PRIMARY KEY,
  portal_id TEXT,
  name TEXT NOT NULL,
  check_type TEXT NOT NULL CHECK(check_type IN ('health', 'oauth', 'hubspot_api', 'webhook', 'delivery', 'billing')),
  target TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  interval_minutes INTEGER NOT NULL,
  last_status TEXT CHECK(last_status IN ('passing', 'failing', 'unknown')),
  last_checked_at TEXT,
  last_latency_ms INTEGER,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  portal_id TEXT,
  title TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('minor', 'major', 'critical')),
  status TEXT NOT NULL CHECK(status IN ('investigating', 'identified', 'monitoring', 'resolved')),
  affected_services_json TEXT NOT NULL,
  public_message TEXT NOT NULL DEFAULT '',
  internal_notes TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL,
  identified_at TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scan_checkpoints (
  scan_id TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL,
  cursor TEXT,
  processed_count INTEGER NOT NULL DEFAULT 0,
  last_deal_id TEXT,
  state_json TEXT NOT NULL DEFAULT '{}',
  lease_owner TEXT,
  lease_expires_at TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE,
  FOREIGN KEY (scan_id) REFERENCES scan_runs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS job_leases (
  job_key TEXT PRIMARY KEY,
  lease_owner TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS backup_manifests (
  id TEXT PRIMARY KEY,
  backup_type TEXT NOT NULL CHECK(backup_type IN ('scheduled', 'manual', 'pre_migration')),
  status TEXT NOT NULL CHECK(status IN ('started', 'completed', 'failed')),
  object_key TEXT,
  checksum TEXT,
  database_version TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS restore_tests (
  id TEXT PRIMARY KEY,
  backup_manifest_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('started', 'passed', 'failed')),
  validation_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error_message TEXT,
  FOREIGN KEY (backup_manifest_id) REFERENCES backup_manifests(id) ON DELETE CASCADE
);
