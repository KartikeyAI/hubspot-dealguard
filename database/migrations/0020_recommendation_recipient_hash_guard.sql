SET search_path TO dealguard, public;

CREATE OR REPLACE FUNCTION hash_recommendation_follow_up_recipient()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.recipient_hash !~ '^[0-9a-f]{64}$' THEN
    NEW.recipient_hash := encode(
      sha256(convert_to(lower(NEW.recipient_hash), 'UTF8')),
      'hex'
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_hash_recommendation_follow_up_recipient
  ON recommendation_follow_up_deliveries;

CREATE TRIGGER trg_hash_recommendation_follow_up_recipient
  BEFORE INSERT OR UPDATE OF recipient_hash
  ON recommendation_follow_up_deliveries
  FOR EACH ROW
  EXECUTE FUNCTION hash_recommendation_follow_up_recipient();
