SET search_path TO dealguard, public;

-- Preserve 0033 cost accounting and idempotency while binding a draft to its
-- actual lifecycle. An open-deal explanation and a closed-won handover differ.
ALTER TABLE ai_runs ADD COLUMN handoff_cycle INTEGER;
ALTER TABLE ai_runs ADD COLUMN handoff_version TEXT;
ALTER TABLE ai_runs ADD CONSTRAINT ai_handoff_binding CHECK (
  (handoff_cycle IS NULL AND handoff_version IS NULL)
  OR (purpose='handover' AND handoff_cycle>0 AND handoff_version IS NOT NULL AND length(handoff_version)<=1000)
);

CREATE FUNCTION dealguard.lock_ai_source(
  p_portal TEXT,p_deal TEXT,p_assessment TEXT,p_purpose TEXT,p_cycle INTEGER,p_handoff_version TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql SET search_path=pg_catalog,dealguard AS $$
DECLARE a dealguard.deal_assessments%ROWTYPE; h dealguard.handoffs%ROWTYPE;
BEGIN
  IF NOT dealguard.lock_current_work_record(p_portal,p_deal,p_assessment) THEN RETURN FALSE; END IF;
  SELECT * INTO a FROM dealguard.deal_assessments WHERE portal_id=p_portal AND deal_id=p_deal;
  IF p_purpose<>'handover' THEN
    RETURN p_purpose IN ('risk','manager_review','next_action') AND a.is_closed=0 AND p_cycle IS NULL AND p_handoff_version IS NULL;
  END IF;
  IF a.is_closed<>1 OR a.is_won<>1 OR p_cycle IS NULL OR p_handoff_version IS NULL THEN RETURN FALSE; END IF;
  -- Match the assessment -> handoff lock order of confirm_handoff_cycle.
  SELECT * INTO h FROM dealguard.handoffs WHERE portal_id=p_portal AND deal_id=p_deal FOR UPDATE;
  RETURN FOUND AND h.active=1 AND h.cycle_number=p_cycle AND h.last_observed_at=a.assessed_at
    AND h.status IN ('pending','confirmed')
    AND jsonb_build_array(h.cycle_number,h.status,h.confirmed_at,h.last_observed_at)::text=p_handoff_version
    AND EXISTS(SELECT 1 FROM dealguard.handoff_cycles c WHERE c.portal_id=p_portal AND c.deal_id=p_deal
      AND c.cycle_number=p_cycle AND c.status=h.status AND c.ended_at IS NULL);
END; $$;

ALTER FUNCTION dealguard.reserve_ai_run(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,INTEGER,TEXT,TEXT,BIGINT,TEXT)
  RENAME TO reserve_ai_run_accounted;

CREATE FUNCTION dealguard.reserve_ai_run_v3(
  p_portal TEXT,p_key TEXT,p_actor TEXT,p_deal TEXT,p_purpose TEXT,p_fingerprint TEXT,
  p_model TEXT,p_revision INTEGER,p_assessment TEXT,p_snapshot TEXT,p_reservation BIGINT,p_token TEXT,
  p_cycle INTEGER,p_handoff_version TEXT
) RETURNS JSONB LANGUAGE plpgsql SET search_path=pg_catalog,dealguard AS $$
DECLARE c dealguard.intelligence_consents%ROWTYPE; result JSONB;
BEGIN
  -- All AI admission/settlement paths take consent before the record or run.
  SELECT * INTO c FROM dealguard.intelligence_consents WHERE portal_id=p_portal AND capability='ai' FOR UPDATE;
  IF NOT FOUND OR NOT c.enabled OR c.revision<>p_revision THEN RETURN jsonb_build_object('error','consent'); END IF;
  IF NOT dealguard.lock_ai_source(p_portal,p_deal,p_assessment,p_purpose,p_cycle,p_handoff_version)
    THEN RETURN jsonb_build_object('error','source'); END IF;
  result:=dealguard.reserve_ai_run_accounted(p_portal,p_key,p_actor,p_deal,p_purpose,p_fingerprint,p_model,p_revision,
    p_assessment,p_snapshot,p_reservation,p_token);
  IF result->>'admitted'='true' THEN
    UPDATE dealguard.ai_runs SET handoff_cycle=p_cycle,handoff_version=p_handoff_version
      WHERE portal_id=p_portal AND request_key=p_key AND state='reserved' AND lease_token=p_token;
  END IF;
  RETURN result;
END; $$;

-- Previous callers keep open-deal behavior but cannot request an unbound handover.
CREATE FUNCTION dealguard.reserve_ai_run(
  p_portal TEXT,p_key TEXT,p_actor TEXT,p_deal TEXT,p_purpose TEXT,p_fingerprint TEXT,
  p_model TEXT,p_revision INTEGER,p_assessment TEXT,p_snapshot TEXT,p_reservation BIGINT,p_token TEXT
) RETURNS JSONB LANGUAGE sql SET search_path=pg_catalog,dealguard AS $$
  SELECT dealguard.reserve_ai_run_v3(p_portal,p_key,p_actor,p_deal,p_purpose,p_fingerprint,p_model,p_revision,
    p_assessment,p_snapshot,p_reservation,p_token,NULL,NULL);
$$;

ALTER FUNCTION dealguard.finish_ai_run(TEXT,TEXT,TEXT,BOOLEAN,BIGINT,TEXT,TEXT) RENAME TO finish_ai_run_accounted;
CREATE FUNCTION dealguard.finish_ai_run(p_portal TEXT,p_key TEXT,p_token TEXT,p_success BOOLEAN,p_cost BIGINT,p_cipher TEXT,p_iv TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SET search_path=pg_catalog,dealguard AS $$
DECLARE r dealguard.ai_runs%ROWTYPE; permitted BOOLEAN:=FALSE;
BEGIN
  PERFORM 1 FROM dealguard.intelligence_consents WHERE portal_id=p_portal AND capability='ai' FOR UPDATE;
  SELECT * INTO r FROM dealguard.ai_runs WHERE portal_id=p_portal AND request_key=p_key FOR UPDATE;
  IF NOT FOUND OR r.state<>'reserved' OR r.lease_token<>p_token THEN RETURN FALSE; END IF;
  IF p_success THEN
    permitted:=dealguard.lock_ai_source(p_portal,r.deal_id,r.assessment_at,r.purpose,r.handoff_cycle,r.handoff_version);
  END IF;
  -- Even a superseded handoff accounts actual/unknown usage exactly once.
  RETURN dealguard.finish_ai_run_accounted(p_portal,p_key,p_token,permitted,p_cost,p_cipher,p_iv);
END; $$;
