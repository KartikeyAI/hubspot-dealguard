SET search_path TO dealguard, public;

CREATE TABLE IF NOT EXISTS deal_decision_snapshots (
  portal_id TEXT NOT NULL,
  deal_id TEXT NOT NULL,
  assessment_at TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  methodology TEXT NOT NULL,
  brief_status TEXT NOT NULL
    CHECK (brief_status IN ('on_track', 'watch', 'intervention_required', 'insufficient_evidence')),
  attention_score INTEGER NOT NULL CHECK (attention_score >= 0 AND attention_score <= 100),
  confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  coverage_percent INTEGER NOT NULL CHECK (coverage_percent >= 0 AND coverage_percent <= 100),
  freshness_status TEXT NOT NULL CHECK (freshness_status IN ('fresh', 'aging', 'stale', 'unavailable')),
  next_action_code TEXT,
  next_action_label TEXT,
  next_action_text TEXT,
  next_action_priority TEXT CHECK (next_action_priority IS NULL OR next_action_priority IN ('high', 'medium', 'low')),
  next_action_owner TEXT CHECK (next_action_owner IS NULL OR next_action_owner IN ('deal_owner', 'manager')),
  next_action_due_at TEXT,
  next_action_rationale TEXT,
  next_action_evidence_json TEXT NOT NULL DEFAULT '[]',
  risk_summary_json TEXT NOT NULL DEFAULT '[]',
  dimensions_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (portal_id, deal_id),
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_deal_decision_snapshots_queue
  ON deal_decision_snapshots(portal_id, brief_status, attention_score DESC, next_action_due_at);

CREATE INDEX IF NOT EXISTS idx_deal_decision_snapshots_freshness
  ON deal_decision_snapshots(portal_id, assessment_at, generated_at DESC);
