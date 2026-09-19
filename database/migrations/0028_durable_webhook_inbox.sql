SET search_path TO dealguard, public;
CREATE TABLE hubspot_webhook_inbox (
  event_key TEXT PRIMARY KEY CHECK (event_key ~ '^[0-9a-f]{64}$'),
  portal_id TEXT NOT NULL REFERENCES tenants(portal_id) ON DELETE CASCADE,
  deal_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('creation','propertyChange','deletion','restore')),
  occurred_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','retry','processed','dead_letter')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 8),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_token TEXT,
  lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  error_code TEXT CHECK (length(error_code) <= 100)
);
CREATE INDEX idx_webhook_inbox_due ON hubspot_webhook_inbox(available_at, created_at)
  WHERE status IN ('queued','retry','processing');
CREATE INDEX idx_webhook_inbox_portal_status ON hubspot_webhook_inbox(portal_id,status,created_at);
