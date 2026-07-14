SET search_path TO dealguard, public;

-- Tenant ownership keys ensure a child record cannot reference a parent from another portal.
ALTER TABLE policy_versions ADD CONSTRAINT uq_policy_versions_portal_id UNIQUE (portal_id, id);
ALTER TABLE policy_exceptions ADD CONSTRAINT uq_policy_exceptions_portal_id UNIQUE (portal_id, id);
ALTER TABLE remediation_cases ADD CONSTRAINT uq_remediation_cases_portal_id UNIQUE (portal_id, id);
ALTER TABLE outbox_events ADD CONSTRAINT uq_outbox_events_portal_id UNIQUE (portal_id, id);
ALTER TABLE notification_routes ADD CONSTRAINT uq_notification_routes_portal_id UNIQUE (portal_id, id);
ALTER TABLE change_approval_requests ADD CONSTRAINT uq_change_approvals_portal_id UNIQUE (portal_id, id);

ALTER TABLE policy_approvals DROP CONSTRAINT IF EXISTS policy_approvals_policy_id_fkey;
ALTER TABLE policy_approvals ADD CONSTRAINT fk_policy_approvals_tenant_policy FOREIGN KEY (portal_id, policy_id) REFERENCES policy_versions(portal_id, id) ON DELETE CASCADE;
ALTER TABLE policy_simulations DROP CONSTRAINT IF EXISTS policy_simulations_policy_id_fkey;
ALTER TABLE policy_simulations ADD CONSTRAINT fk_policy_simulations_tenant_policy FOREIGN KEY (portal_id, policy_id) REFERENCES policy_versions(portal_id, id) ON DELETE CASCADE;
ALTER TABLE policy_segments DROP CONSTRAINT IF EXISTS policy_segments_policy_id_fkey;
ALTER TABLE policy_segments ADD CONSTRAINT fk_policy_segments_tenant_policy FOREIGN KEY (portal_id, policy_id) REFERENCES policy_versions(portal_id, id) ON DELETE CASCADE;
ALTER TABLE policy_diffs DROP CONSTRAINT IF EXISTS policy_diffs_policy_id_fkey;
ALTER TABLE policy_diffs ADD CONSTRAINT fk_policy_diffs_tenant_policy FOREIGN KEY (portal_id, policy_id) REFERENCES policy_versions(portal_id, id) ON DELETE CASCADE;
ALTER TABLE policy_exception_comments DROP CONSTRAINT IF EXISTS policy_exception_comments_exception_id_fkey;
ALTER TABLE policy_exception_comments ADD CONSTRAINT fk_policy_exception_comments_tenant FOREIGN KEY (portal_id, exception_id) REFERENCES policy_exceptions(portal_id, id) ON DELETE CASCADE;
ALTER TABLE policy_exception_evidence DROP CONSTRAINT IF EXISTS policy_exception_evidence_exception_id_fkey;
ALTER TABLE policy_exception_evidence ADD CONSTRAINT fk_policy_exception_evidence_tenant FOREIGN KEY (portal_id, exception_id) REFERENCES policy_exceptions(portal_id, id) ON DELETE CASCADE;
ALTER TABLE remediation_events DROP CONSTRAINT IF EXISTS remediation_events_case_id_fkey;
ALTER TABLE remediation_events ADD CONSTRAINT fk_remediation_events_tenant_case FOREIGN KEY (portal_id, case_id) REFERENCES remediation_cases(portal_id, id) ON DELETE CASCADE;
ALTER TABLE remediation_comments DROP CONSTRAINT IF EXISTS remediation_comments_case_id_fkey;
ALTER TABLE remediation_comments ADD CONSTRAINT fk_remediation_comments_tenant_case FOREIGN KEY (portal_id, case_id) REFERENCES remediation_cases(portal_id, id) ON DELETE CASCADE;
ALTER TABLE remediation_evidence DROP CONSTRAINT IF EXISTS remediation_evidence_case_id_fkey;
ALTER TABLE remediation_evidence ADD CONSTRAINT fk_remediation_evidence_tenant_case FOREIGN KEY (portal_id, case_id) REFERENCES remediation_cases(portal_id, id) ON DELETE CASCADE;
ALTER TABLE outbox_deliveries DROP CONSTRAINT IF EXISTS outbox_deliveries_outbox_event_id_fkey;
ALTER TABLE outbox_deliveries ADD CONSTRAINT fk_outbox_deliveries_tenant_event FOREIGN KEY (portal_id, outbox_event_id) REFERENCES outbox_events(portal_id, id) ON DELETE CASCADE;
ALTER TABLE alert_instances ADD CONSTRAINT fk_alert_instances_tenant_event FOREIGN KEY (portal_id, outbox_event_id) REFERENCES outbox_events(portal_id, id) ON DELETE CASCADE;
ALTER TABLE alert_instances ADD CONSTRAINT fk_alert_instances_tenant_route FOREIGN KEY (portal_id, route_id) REFERENCES notification_routes(portal_id, id) ON DELETE CASCADE;
ALTER TABLE change_approval_executions DROP CONSTRAINT IF EXISTS change_approval_executions_approval_id_fkey;
ALTER TABLE change_approval_executions ADD CONSTRAINT fk_change_execution_tenant_approval FOREIGN KEY (portal_id, approval_id) REFERENCES change_approval_requests(portal_id, id) ON DELETE CASCADE;

ALTER TABLE audit_events_v2 ADD CONSTRAINT fk_audit_events_v2_tenant FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE;

ALTER TABLE remediation_evidence DROP CONSTRAINT IF EXISTS remediation_evidence_evidence_type_check;
ALTER TABLE remediation_evidence ADD CONSTRAINT remediation_evidence_evidence_type_check CHECK (evidence_type IN ('url', 'text', 'hubspot_object', 'external_reference', 'object'));
ALTER TABLE policy_exception_evidence DROP CONSTRAINT IF EXISTS policy_exception_evidence_evidence_type_check;
ALTER TABLE policy_exception_evidence ADD CONSTRAINT policy_exception_evidence_evidence_type_check CHECK (evidence_type IN ('url', 'text', 'hubspot_object', 'external_reference', 'object'));

ALTER TABLE remediation_evidence ADD COLUMN object_upload_id TEXT;
ALTER TABLE remediation_evidence ADD COLUMN object_key TEXT;
ALTER TABLE remediation_evidence ADD COLUMN content_type TEXT;
ALTER TABLE remediation_evidence ADD COLUMN size_bytes BIGINT;
ALTER TABLE remediation_evidence ADD COLUMN object_etag TEXT;
ALTER TABLE policy_exception_evidence ADD COLUMN object_upload_id TEXT;
ALTER TABLE policy_exception_evidence ADD COLUMN object_key TEXT;
ALTER TABLE policy_exception_evidence ADD COLUMN content_type TEXT;
ALTER TABLE policy_exception_evidence ADD COLUMN size_bytes BIGINT;
ALTER TABLE policy_exception_evidence ADD COLUMN object_etag TEXT;
ALTER TABLE data_export_jobs ADD COLUMN size_bytes BIGINT;
ALTER TABLE data_export_jobs ADD COLUMN content_type TEXT;

CREATE TABLE object_uploads (
  id TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL REFERENCES tenants(portal_id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('remediation_evidence', 'policy_exception_evidence')),
  resource_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  expected_size_bytes BIGINT NOT NULL CHECK (expected_size_bytes BETWEEN 1 AND 26214400),
  expected_sha256 TEXT NOT NULL CHECK (expected_sha256 ~ '^[0-9a-f]{64}$'),
  object_etag TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'expired', 'failed')),
  requested_by_user_id TEXT,
  requested_by_email TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (portal_id, id),
  UNIQUE (portal_id, object_key)
);
CREATE INDEX idx_object_uploads_portal_status ON object_uploads(portal_id, status, created_at DESC);
ALTER TABLE remediation_evidence ADD CONSTRAINT fk_remediation_evidence_tenant_upload FOREIGN KEY (portal_id, object_upload_id) REFERENCES object_uploads(portal_id, id) ON DELETE RESTRICT;
ALTER TABLE policy_exception_evidence ADD CONSTRAINT fk_policy_exception_evidence_tenant_upload FOREIGN KEY (portal_id, object_upload_id) REFERENCES object_uploads(portal_id, id) ON DELETE RESTRICT;

CREATE TABLE async_jobs (
  id TEXT PRIMARY KEY,
  portal_id TEXT REFERENCES tenants(portal_id) ON DELETE CASCADE,
  job_type TEXT NOT NULL CHECK (job_type IN ('scan', 'data_export', 'delivery', 'maintenance')),
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'dead_letter')),
  payload_json TEXT NOT NULL DEFAULT '{}',
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at TEXT,
  available_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (job_type, idempotency_key)
);
CREATE INDEX idx_async_jobs_dispatch ON async_jobs(job_type, status, available_at, created_at);
CREATE INDEX idx_async_jobs_portal ON async_jobs(portal_id, job_type, status, created_at DESC);

CREATE INDEX idx_policy_approvals_tenant_policy ON policy_approvals(portal_id, policy_id, created_at DESC);
CREATE INDEX idx_policy_simulations_tenant_policy ON policy_simulations(portal_id, policy_id, started_at DESC);
CREATE INDEX idx_remediation_events_tenant_case ON remediation_events(portal_id, case_id, created_at DESC);
CREATE INDEX idx_remediation_comments_tenant_case ON remediation_comments(portal_id, case_id, created_at);
CREATE INDEX idx_remediation_evidence_tenant_case ON remediation_evidence(portal_id, case_id, created_at);
CREATE INDEX idx_outbox_deliveries_tenant_event ON outbox_deliveries(portal_id, outbox_event_id, attempted_at DESC);
