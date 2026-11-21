SET search_path TO dealguard, public;

-- The provider preservation trigger must not restore a manually applied change.
-- Manual changes already commit subscription, tenant plan and audit together.
CREATE OR REPLACE FUNCTION preserve_dodo_scheduled_plan_state_fn()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.provider <> 'dodo' THEN
    IF OLD.provider = 'dodo' THEN
      NEW.scheduled_tier := NULL;
      NEW.scheduled_interval := NULL;
      NEW.scheduled_product_id := NULL;
      NEW.scheduled_change_at := NULL;
      NEW.scheduled_change_provider_state := NULL;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.last_provider_event_type = 'subscription.plan_changed' THEN
    NEW.scheduled_tier := NULL;
    NEW.scheduled_interval := NULL;
    NEW.scheduled_product_id := NULL;
    NEW.scheduled_change_at := NULL;
    NEW.scheduled_change_provider_state := 'applied';
  ELSIF OLD.provider = 'dodo' AND OLD.scheduled_tier IS NOT NULL
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
