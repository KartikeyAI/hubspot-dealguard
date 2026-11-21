SET search_path TO dealguard,public;

-- Reinstallation must not inherit a prior install's optional data-use consent.
-- Revocation triggers preserve legally held ciphertext but make it inaccessible.
CREATE FUNCTION dealguard.revoke_intelligence_on_deactivation() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,dealguard AS $$
BEGIN
  IF OLD.status='active' AND NEW.status<>'active' THEN
    UPDATE dealguard.intelligence_consents
      SET enabled=FALSE,revision=revision+1,updated_at=clock_timestamp()
      WHERE portal_id=NEW.portal_id;
    UPDATE dealguard.breeze_settings
      SET enabled=FALSE,revision=revision+1,updated_at=clock_timestamp()
      WHERE portal_id=NEW.portal_id;
    IF NOT EXISTS(SELECT 1 FROM dealguard.legal_holds WHERE portal_id=NEW.portal_id AND status='active') THEN
      DELETE FROM dealguard.outcome_datasets WHERE portal_id=NEW.portal_id;
    END IF;
    INSERT INTO dealguard.audit_events(id,portal_id,action,metadata_json,created_at)
      VALUES(gen_random_uuid()::text,NEW.portal_id,'intelligence.installation_deactivated',
        jsonb_build_object('status',NEW.status,'optionalConsentRevoked',true)::text,
        to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER revoke_intelligence_on_deactivation AFTER UPDATE OF status ON tenants
  FOR EACH ROW EXECUTE FUNCTION dealguard.revoke_intelligence_on_deactivation();
