import { analyticsFilters, analyticsPredicate } from './analytics-scope.js';
import { requireCommercialTier } from './billing.js';
import { AppError } from './errors.js';
import { authorizeRecordedDeal, requireRecordActor, type RecordPermission } from './record-access.js';
import type { Env, RequestIdentity } from './types.js';

export async function requireRemediationRecord(env: Env, identity: RequestIdentity, dealId: string,
  permission: RecordPermission = 'remediation.manage') {
  await requireCommercialTier(env, identity.portalId, 'enterprise');
  const access = await authorizeRecordedDeal(env, identity, dealId, permission);
  if (!access.assessmentAt) throw new AppError(409, 'remediation_record_unavailable', 'Refresh the deal assessment before working on this remediation.');
  return access;
}

/** Access is the CRM deal's recorded assignment, not the remediation assignee. */
export async function remediationCollection(env: Env, identity: RequestIdentity) {
  await requireCommercialTier(env, identity.portalId, 'enterprise');
  const access = await requireRecordActor(env, identity, 'remediation.view');
  const predicate = analyticsPredicate('permitted', analyticsFilters(access.scope, {}).authorization);
  return { sql: `WITH permitted AS (
    SELECT a.portal_id,a.deal_id,a.assessed_at,
      COALESCE(h.pipeline_id,c.pipeline_id) AS pipeline_id,COALESCE(h.owner_id,c.owner_id) AS owner_id,h.team_id,h.region_code
    FROM deal_assessments a
    LEFT JOIN assessment_context c ON c.portal_id=a.portal_id AND c.deal_id=a.deal_id AND c.updated_at=a.assessed_at
    LEFT JOIN LATERAL (SELECT pipeline_id,owner_id,team_id,region_code FROM assessment_history
      WHERE portal_id=a.portal_id AND deal_id=a.deal_id AND assessed_at=a.assessed_at ORDER BY id DESC LIMIT 1) h ON true
    WHERE a.portal_id=? AND dealguard.record_is_available(a.portal_id,a.deal_id)
  ), scoped_cases AS (SELECT r.* FROM remediation_cases r JOIN permitted
    ON permitted.portal_id=r.portal_id AND permitted.deal_id=r.deal_id WHERE ${predicate.sql})`,
    params: [identity.portalId,...predicate.params] };
}
