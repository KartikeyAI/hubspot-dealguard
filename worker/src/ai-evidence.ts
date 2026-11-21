import { canonicalAuditValue } from './audit-chain.js';
import { requireCommercialTier } from './billing.js';
import { commercialAuthorizationFromScopes } from './commercial-assessment.js';
import { sha256Hex } from './crypto.js';
import { permissionMatches } from './enterprise-access.js';
import { AppError } from './errors.js';
import { assessmentFreshness, evidenceInstant, snapshotFreshness } from './evidence-freshness.js';
import { assertRecordScope, authorizeRecordedDeal, type RecordResource } from './record-access.js';
import { readSourceEvidence, sourceBoundSnapshotFreshness } from './source-evidence.js';
import type { AiPurpose } from './ai-provider.js';
import type { Env, RequestIdentity } from './types.js';

export interface AiFact { id: string; kind: string; value: string | number | boolean; sourceAt?: string }
export interface AiEvidence {
  assessmentAt: string;
  snapshotAt: string | null;
  purpose: AiPurpose;
  handoffCycle: number | null;
  handoffVersion: string | null;
  facts: AiFact[];
  fingerprint: string;
}
function parsed(value: unknown): unknown {
  try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; }
}
const code = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,120}$/.test(value);

/** Reads recorded, scoped facts only. Text bodies and customer names never enter the provider packet. */
export async function loadAiEvidence(
  env: Env, identity: RequestIdentity, dealId: string, permission = 'ai.use', purpose: AiPurpose = 'risk',
): Promise<AiEvidence> {
  if (!identity.userId || !/^\d{1,32}$/.test(dealId)) {
    throw new AppError(400, 'ai_record_required', 'An identified user and a valid deal ID are required.');
  }
  await requireCommercialTier(env, identity.portalId, 'enterprise');
  const access = await authorizeRecordedDeal(env, identity, dealId);
  if (!permissionMatches(access.context.permissions, permission)) {
    throw new AppError(403, 'ai_permission_denied', 'Your role cannot use this intelligence capability.');
  }
  const row = await env.DB.prepare(`SELECT a.assessed_at,a.score,a.issues_json,a.is_closed,a.is_won,a.handoff_eligible,t.scopes_json,
    s.generated_at,s.assessment_at AS snapshot_assessment_at,s.freshness_status,s.dimensions_json,s.risk_summary_json,s.next_action_code,
    h.active AS handoff_active,h.cycle_number,h.status AS handoff_status,h.started_at,h.start_basis,h.confirmed_at,
    h.last_observed_at AS handoff_observed_at,hc.status AS cycle_status,hc.ended_at,
    jsonb_build_array(h.cycle_number,h.status,h.confirmed_at,h.last_observed_at)::text AS handoff_version
    FROM deal_assessments a
    JOIN tenants t ON t.portal_id=a.portal_id
    LEFT JOIN deal_decision_snapshots s ON s.portal_id=a.portal_id AND s.deal_id=a.deal_id
    LEFT JOIN handoffs h ON h.portal_id=a.portal_id AND h.deal_id=a.deal_id
    LEFT JOIN dealguard.handoff_cycles hc ON hc.portal_id=h.portal_id AND hc.deal_id=h.deal_id AND hc.cycle_number=h.cycle_number
    WHERE a.portal_id=? AND a.deal_id=? AND dealguard.record_is_available(a.portal_id,a.deal_id)`)
    .bind(identity.portalId, dealId).first<Record<string, unknown>>();
  const age = assessmentFreshness(row?.assessed_at, Date.now());
  if (!row || row.assessed_at !== access.assessmentAt || !['fresh', 'aging'].includes(age.status)
    || typeof row.score !== 'number' || row.score < 0 || row.score > 100) {
    throw new AppError(422, 'ai_evidence_unavailable', 'Refresh a recorded deal with valid readiness evidence first.');
  }
  const handover = purpose === 'handover';
  if (handover ? row.is_closed !== 1 || row.is_won !== 1 || row.handoff_active !== 1
    || !Number.isSafeInteger(row.cycle_number) || Number(row.cycle_number) < 1
    || row.handoff_observed_at !== row.assessed_at || row.ended_at !== null
    || !['pending', 'confirmed'].includes(String(row.cycle_status)) || row.cycle_status !== row.handoff_status
    : row.is_closed !== 0) {
    throw new AppError(422, 'ai_evidence_unavailable', handover
      ? 'Handover requires a current recorded closed-won cycle. Refresh this deal first.'
      : 'This assistance purpose requires a recorded open deal. Use handover for a closed-won deal.');
  }
  const issues = parsed(row.issues_json);
  if (!Array.isArray(issues) || issues.length > 200 || issues.some(i => !i || typeof i !== 'object' || typeof i.code !== 'string')) {
    throw new AppError(422, 'ai_evidence_unavailable', 'Recorded issue evidence is invalid.');
  }
  const observedAt = String(row.assessed_at);
  const facts: AiFact[] = [];
  let comparisonResource: RecordResource | null = null;
  const add = (id: string, kind: string, value: string | number | boolean, sourceAt = observedAt) => facts.push({ id, kind, value, sourceAt });
  add('readiness_score', 'readiness_score', row.score);
  add('issue_count', 'issue_count', issues.length);
  add('observed_at', 'observation_time', observedAt);
  add('record_state', 'record_lifecycle', handover ? 'closed_won' : 'open');
  for (const [index, issue] of issues.slice(0, 30).entries()) {
    if (code(issue.code)) add(`issue_${index}`, 'recorded_issue_code', issue.code);
  }
  if (issues.length > 30) add('issues_truncated', 'evidence_limit', true);
  const dimensions = parsed(row.dimensions_json) as Record<string, unknown> | null;
  const freshness = sourceBoundSnapshotFreshness(snapshotFreshness({ assessmentAt: row.assessed_at,
    snapshotAssessmentAt: row.snapshot_assessment_at, generatedAt: row.generated_at, recordedStatus: row.freshness_status }, Date.now()),
  dimensions, Date.now());
  const scopes = parsed(row.scopes_json);
  const commercialGrantCurrent = !dimensions?.commercial || Array.isArray(scopes)
    && scopes.every(value => typeof value === 'string') && commercialAuthorizationFromScopes(scopes).status === 'full';
  const snapshotAt = !handover && freshness.usable && commercialGrantCurrent ? String(row.generated_at) : null;
  add('optional_evidence_available', 'evidence_availability', snapshotAt !== null);
  if (snapshotAt) {
    // Conservative provenance for a combined risk: never renew source age when a snapshot is regenerated.
    const receipt = readSourceEvidence(dimensions?.sourceEvidence);
    const sourceAt = Object.values(receipt?.sources ?? {}).filter(source => source.usable && source.observedAt)
      .map(source => source.observedAt!).sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? observedAt;
    const risks = parsed(row.risk_summary_json);
    if (Array.isArray(risks)) for (const [index, risk] of risks.slice(0, 8).entries()) {
      if (risk && code(risk.code)) add(`risk_${index}`, 'deterministic_risk_code', risk.code, sourceAt);
    }
    if (code(row.next_action_code)) add('next_action', 'recorded_action_code', row.next_action_code, sourceAt);
  }
  if (handover) {
    add('handoff_cycle', 'handoff_cycle', Number(row.cycle_number));
    add('handoff_status', 'handoff_status', String(row.handoff_status));
    add('handoff_ready', 'handoff_eligibility', row.handoff_eligible === 1);
    add('handoff_start_basis', 'handoff_start_basis', String(row.start_basis));
    if (typeof row.started_at === 'string') add('handoff_started_at', 'handoff_observation_time', row.started_at);
    if (typeof row.confirmed_at === 'string') add('handoff_confirmed_at', 'handoff_confirmation_time', row.confirmed_at);
    // DealGuard has no evidence of external document collection or delivery assignments.
    add('delivery_assignment_recorded', 'handoff_limitation', false);
    add('documents_verified', 'handoff_limitation', false);
  } else {
    // Changes are comparable only under the same known policy and lifecycle. No fabricated baseline.
    const previous = await env.DB.prepare(`SELECT p.score,p.issue_count,p.assessed_at,p.is_closed,p.policy_id,
      p.pipeline_id,p.owner_id,p.team_id,p.region_code,current.policy_id AS current_policy_id,
      current.pipeline_id AS current_pipeline_id,current.score AS current_score,current.is_closed AS current_is_closed
      FROM (SELECT * FROM assessment_history WHERE portal_id=? AND deal_id=? AND assessed_at=?
        ORDER BY id DESC LIMIT 1) current
      JOIN LATERAL (SELECT h.* FROM assessment_history h
        CROSS JOIN LATERAL (SELECT CASE WHEN pg_input_is_valid(h.assessed_at,'timestamp with time zone')
          THEN h.assessed_at::timestamptz ELSE NULL END AS observed_at) valid
        WHERE h.portal_id=current.portal_id AND h.deal_id=current.deal_id
        AND valid.observed_at<current.assessed_at::timestamptz
        AND valid.observed_at>=current.assessed_at::timestamptz-INTERVAL '7 days'
        ORDER BY valid.observed_at DESC,h.id DESC LIMIT 1) p ON true`)
      .bind(identity.portalId, dealId, observedAt).first<{ score: number; issue_count: number; assessed_at: string;
        is_closed: number; policy_id: string | null; pipeline_id: string | null; owner_id: string | null;
        team_id: string | null; region_code: string | null; current_policy_id: string | null;
        current_pipeline_id: string | null; current_score: number; current_is_closed: number }>();
    let comparable = Boolean(previous && Number.isInteger(previous.score) && previous.score >= 0 && previous.score <= 100
      && Number.isInteger(previous.issue_count) && previous.issue_count >= 0
      && evidenceInstant(previous.assessed_at)
      && previous.current_score === row.score && previous.current_is_closed === 0 && previous.is_closed === 0
      && previous.policy_id && previous.policy_id === previous.current_policy_id
      && previous.pipeline_id && previous.pipeline_id === previous.current_pipeline_id);
    if (comparable && previous) {
      const resource = { pipelineId: previous.pipeline_id, ownerId: previous.owner_id, teamId: previous.team_id, regionCode: previous.region_code };
      try { assertRecordScope(access.context, resource); comparisonResource = resource; }
      catch (error) { if (error instanceof AppError && error.code === 'record_scope_denied') comparable = false; else throw error; }
    }
    add('comparison_available', 'evidence_availability', Boolean(comparable));
    if (comparable && previous) {
      add('previous_readiness_score', 'previous_readiness_score', previous.score, previous.assessed_at);
      add('previous_observed_at', 'previous_observation_time', previous.assessed_at, previous.assessed_at);
      add('readiness_change', 'readiness_change', row.score - previous.score);
      add('issue_count_change', 'issue_count_change', issues.length - previous.issue_count);
    }
  }
  const input = { assessmentAt: observedAt, snapshotAt, purpose,
    handoffCycle: handover ? Number(row.cycle_number) : null,
    handoffVersion: handover ? String(row.handoff_version) : null, facts };
  const finalAccess = await authorizeRecordedDeal(env, identity, dealId);
  if (finalAccess.assessmentAt !== row.assessed_at || !permissionMatches(finalAccess.context.permissions, permission)) {
    throw new AppError(409, 'ai_evidence_changed', 'Permissions or record evidence changed. Reload before retrying.');
  }
  if (comparisonResource) assertRecordScope(finalAccess.context, comparisonResource);
  if (snapshotAt && dimensions?.commercial) {
    const current = await env.DB.prepare('SELECT scopes_json FROM tenants WHERE portal_id=? AND status=\'active\'')
      .bind(identity.portalId).first<{ scopes_json: string }>();
    if (current?.scopes_json !== row.scopes_json) {
      throw new AppError(409, 'ai_evidence_changed', 'The optional evidence authorization changed. Reload before retrying.');
    }
  }
  return { ...input, fingerprint: await sha256Hex(canonicalAuditValue(input)) };
}
