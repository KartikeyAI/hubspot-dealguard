PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS change_approval_executions (
  approval_id TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('applying', 'completed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 1,
  lease_expires_at TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  applied_by_user_id TEXT,
  applied_by_email TEXT,
  error_message TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (approval_id) REFERENCES change_approval_requests(id) ON DELETE CASCADE,
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_change_approval_executions_status
  ON change_approval_executions(portal_id, status, updated_at DESC);
