PRAGMA foreign_keys = ON;

CREATE TRIGGER IF NOT EXISTS preserve_dodo_scheduled_plan_state
AFTER UPDATE ON subscriptions_v2
WHEN OLD.scheduled_tier IS NOT NULL
  AND NEW.scheduled_tier IS NULL
  AND COALESCE(NEW.last_provider_event_type, '') != 'subscription.plan_changed'
  AND COALESCE(NEW.scheduled_change_provider_state, '') NOT IN ('cancelled', 'awaiting_webhook')
BEGIN
  UPDATE subscriptions_v2
  SET scheduled_tier = OLD.scheduled_tier,
      scheduled_interval = OLD.scheduled_interval,
      scheduled_product_id = OLD.scheduled_product_id,
      scheduled_change_at = OLD.scheduled_change_at,
      scheduled_change_provider_state = OLD.scheduled_change_provider_state
  WHERE portal_id = NEW.portal_id;
END;

CREATE TRIGGER IF NOT EXISTS complete_dodo_scheduled_plan_change
AFTER UPDATE OF last_provider_event_type ON subscriptions_v2
WHEN NEW.last_provider_event_type = 'subscription.plan_changed'
BEGIN
  UPDATE subscriptions_v2
  SET scheduled_tier = NULL,
      scheduled_interval = NULL,
      scheduled_product_id = NULL,
      scheduled_change_at = NULL,
      scheduled_change_provider_state = 'applied'
  WHERE portal_id = NEW.portal_id;
END;
