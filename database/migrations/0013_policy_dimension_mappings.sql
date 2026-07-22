PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS policy_dimension_mappings (
  portal_id TEXT PRIMARY KEY,
  team_property TEXT,
  region_property TEXT,
  deal_type_property TEXT,
  updated_by_user_id TEXT,
  updated_by_email TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (portal_id) REFERENCES tenants(portal_id) ON DELETE CASCADE
);
