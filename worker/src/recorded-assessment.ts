import { currentDecision, type DecisionRow } from './executive-revenue.js';
import { commercialAuthorizationFromScopes } from './commercial-assessment.js';
import { permissionMatches } from './enterprise-access.js';
import { AppError } from './errors.js';
import { assessmentFreshness, evidenceInstant } from './evidence-freshness.js';
import { authorizeRecordedDeal } from './record-access.js';
import { assertRecordAvailable } from './record-lifecycle.js';
import { Repository } from './repository.js';
import { readSourceEvidence } from './source-evidence.js';
import type { Env, RequestIdentity } from './types.js';

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function parse(value: unknown): unknown {
  try { return typeof value === 'string' ? JSON.parse(value) : null; } catch { return null; }
}
function text(value: unknown, maximum: number): string | null {
  return typeof value === 'string' && value.trim() && value.length <= maximum ? value : null;
}

/** Read recorded observations only. Opening a card cannot refresh CRM evidence or create work. */
export async function recordedAssessment(env: Env, identity: RequestIdentity, dealId: string): Promise<Record<string, unknown>> {
  await assertRecordAvailable(env, identity.portalId, dealId);
  const access = await authorizeRecordedDeal(env, identity, dealId);
  const canRefresh = permissionMatches(access.context.permissions, 'deal.review');
  const repository = new Repository(env);
  const assessment = await repository.getAssessment(identity.portalId, dealId);
  if (!assessment) throw new AppError(404, 'assessment_unavailable',
    'No recorded assessment is available. An authorized reviewer can refresh this deal.', { canRefresh });
  const now = Date.now();
  const snapshot = await env.DB.prepare('SELECT * FROM deal_decision_snapshots WHERE portal_id=? AND deal_id=?')
    .bind(identity.portalId, dealId).first<DecisionRow>();
  const evidence = currentDecision(snapshot ?? undefined, assessment.assessedAt, now);
  const dimensions = object(parse(snapshot?.dimensions_json)) ?? {};
  let commercialGrantCurrent = true;
  let recordedScopes: string | null = null;
  if (object(dimensions.commercial)) {
    const tenant = await repository.getTenant(identity.portalId);
    recordedScopes = tenant.scopes_json;
    const scopes = parse(tenant.scopes_json);
    // Stored combined scores cannot be decomposed after an optional grant is
    // removed. Withhold that summary and retain the core readiness assessment.
    commercialGrantCurrent = Array.isArray(scopes) && scopes.every(value => typeof value === 'string')
      && commercialAuthorizationFromScopes(scopes).status === 'full';
  }
  let intelligence: Record<string, unknown> | undefined;
  if (!assessment.isClosed && commercialGrantCurrent && snapshot && evidence.freshness?.usable && evidence.status
    && evidence.attentionScore !== null && evidence.coveragePercent !== null && evidence.generatedAt) {
    const sourceEvidence = readSourceEvidence(dimensions.sourceEvidence, now);
    const sourceAt = Object.values(sourceEvidence?.sources ?? {}).filter(source => source.usable && source.observedAt)
      .map(source => source.observedAt!).sort((a,b) => Date.parse(a)-Date.parse(b))[0] ?? snapshot.assessment_at;
    const risksValue = parse(snapshot.risk_summary_json);
    const risks = Array.isArray(risksValue) ? risksValue.slice(0, 8).flatMap(value => {
      const item = object(value);
      if (!item || !text(item.code, 160) || !text(item.label, 240)
        || !['critical', 'warning', 'info'].includes(String(item.severity))) return [];
      const dimension = text(item.dimension, 80) ?? 'readiness';
      return [{ code: item.code, label: item.label, dimension, severity: item.severity,
        direction: 'negative', detail: item.label, observedAt: sourceAt, evidenceCodes: [item.code] }];
    }) : [];
    const actionValid = text(snapshot.next_action_code, 160) && text(snapshot.next_action_label, 240)
      && text(snapshot.next_action_text, 800) && ['high', 'medium', 'low'].includes(String(snapshot.next_action_priority))
      && ['deal_owner', 'manager'].includes(String(snapshot.next_action_owner));
    const codes = parse(snapshot.next_action_evidence_json);
    const action = actionValid ? { code: snapshot.next_action_code, label: snapshot.next_action_label,
      action: snapshot.next_action_text, priority: snapshot.next_action_priority, owner: snapshot.next_action_owner,
      dueAt: evidenceInstant(snapshot.next_action_due_at), rationale: text(snapshot.next_action_rationale, 800) ?? 'Recorded deterministic evidence.',
      evidenceCodes: Array.isArray(codes) ? codes.filter(v => typeof v === 'string' && v.length <= 160).slice(0, 20) : [] } : null;
    const mappings = [['momentum','momentum'],['close_date','closeDate'],['relationship','relationship'],
      ['engagement','engagement'],['commercial','commercial']] as const;
    intelligence = { sourceEvidence, dealBrief: {
      methodology: 'deterministic_evidence_synthesis', generatedAt: evidence.generatedAt,
      status: evidence.status, attentionScore: evidence.attentionScore, confidence: evidence.confidence,
      summary: 'Recorded Deal Brief. Review the observation age and supporting risks before acting.',
      risks, positiveSignals: [], changes: [], nextAction: action,
      coverage: { readiness: true, ...Object.fromEntries(mappings.map(([,key]) => [key, Boolean(object(dimensions[key]))])),
        percent: evidence.coveragePercent, missingDimensions: mappings.filter(([,key]) => !object(dimensions[key])).map(([key]) => key), truncated: false },
      freshness: evidence.freshness, limitations: ['This is the stored summary from the last authorized refresh. Opening it does not contact HubSpot.',
        'Detailed enrichment panels require an explicit refresh. Source observation clocks are preserved.',
        'Attention priority is deterministic prioritisation, not a win probability.'],
      notWinProbability: true, notBuyerIntent: true, notForecastCategory: true,
    } };
  }
  const latest = await authorizeRecordedDeal(env, identity, dealId);
  if (latest.assessmentAt !== assessment.assessedAt || JSON.stringify(latest.context) !== JSON.stringify(access.context)
    || JSON.stringify(latest.resource) !== JSON.stringify(access.resource)) {
    throw new AppError(409, 'assessment_changed', 'The record or your access changed. Reload the assessment.');
  }
  if (intelligence && recordedScopes !== null) {
    const grant = await env.DB.prepare("SELECT scopes_json FROM tenants WHERE portal_id=? AND status='active'")
      .bind(identity.portalId).first<{scopes_json: string}>();
    if (grant?.scopes_json !== recordedScopes) throw new AppError(409, 'assessment_changed', 'The optional evidence authorization changed. Reload the assessment.');
  }
  return { ...assessment, ...(intelligence ? { intelligence } : {}), source: 'recorded_assessment',
    evidence: assessmentFreshness(assessment.assessedAt, now),
    recordCapabilities: { canRefresh, canReview: canRefresh,
      canConfirmHandoff: permissionMatches(latest.context.permissions, 'handoff.confirm') } };
}
