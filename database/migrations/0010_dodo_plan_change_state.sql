PRAGMA foreign_keys = ON;

ALTER TABLE subscriptions_v2 ADD COLUMN scheduled_interval TEXT CHECK(scheduled_interval IN ('month', 'year'));
ALTER TABLE subscriptions_v2 ADD COLUMN scheduled_product_id TEXT;
ALTER TABLE subscriptions_v2 ADD COLUMN scheduled_change_provider_state TEXT;
