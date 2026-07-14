SET search_path TO dealguard, public;

CREATE OR REPLACE FUNCTION preserve_dodo_scheduled_plan_state_fn()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.last_provider_event_type = 'subscription.plan_changed' THEN
    NEW.scheduled_tier := NULL;
    NEW.scheduled_interval := NULL;
    NEW.scheduled_product_id := NULL;
    NEW.scheduled_change_at := NULL;
    NEW.scheduled_change_provider_state := 'applied';
  ELSIF OLD.scheduled_tier IS NOT NULL
    AND NEW.scheduled_tier IS NULL
    AND COALESCE(NEW.scheduled_change_provider_state, '') NOT IN ('cancelled', 'awaiting_webhook') THEN
    NEW.scheduled_tier := OLD.scheduled_tier;
    NEW.scheduled_interval := OLD.scheduled_interval;
    NEW.scheduled_product_id := OLD.scheduled_product_id;
    NEW.scheduled_change_at := OLD.scheduled_change_at;
    NEW.scheduled_change_provider_state := OLD.scheduled_change_provider_state;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS preserve_dodo_scheduled_plan_state ON subscriptions_v2;
CREATE TRIGGER preserve_dodo_scheduled_plan_state
BEFORE UPDATE ON subscriptions_v2
FOR EACH ROW
EXECUTE FUNCTION preserve_dodo_scheduled_plan_state_fn();
