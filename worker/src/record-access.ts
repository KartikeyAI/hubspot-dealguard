import { AppError } from './errors.js';
import { enterpriseAccessContext, permissionMatches, type EnterpriseAccessContext } from './enterprise-access.js';
import { dimensionValues, getPolicyDimensionMappings } from './policy-dimensions.js';
import type { Env, NormalizedDeal, RequestIdentity } from './types.js';

export type RecordPermission = 'analytics.view' | 'deal.review' | 'handoff.confirm' | 'remediation.view' | 'remediation.manage' | 'remediation.bulk' | 'remediation.review' | 'remediation.evidence';
export interface RecordResource { pipelineId: string | null; ownerId: string | null; teamId: string | null; regionCode: string | null }
export interface RecordAccess { context: EnterpriseAccessContext; resource: RecordResource; assessmentAt: string | null }

export function assertRecordScope(context: EnterpriseAccessContext, resource: RecordResource): void {
  const dimensions = [[context.scope.pipelineIds,resource.pipelineId], [context.scope.ownerIds,resource.ownerId],
    [context.scope.teamIds,resource.teamId], [context.scope.regionCodes,resource.regionCode]] as const;
  if (dimensions.some(([allowed,value]) => allowed.length > 0 && (!value || !allowed.includes(value)))) {
    throw new AppError(403, 'record_scope_denied', 'This record is outside your assigned DealGuard data scope.');
  }
}

export async function requireRecordActor(env: Env, identity: RequestIdentity, permission: RecordPermission): Promise<EnterpriseAccessContext> {
  if (!identity.userId && !identity.userEmail) throw new AppError(403, 'record_user_required', 'An identified HubSpot user is required.');
  const tenant = await env.DB.prepare("SELECT status FROM tenants WHERE portal_id = ?").bind(identity.portalId).first<{status: string}>();
  if (tenant?.status !== 'active') throw new AppError(403, 'installation_inactive', 'This DealGuard installation is not active.');
  const context = await enterpriseAccessContext(env, identity);
  if (!permissionMatches(context.permissions, permission)) throw new AppError(403, 'record_permission_denied', 'You do not have permission to perform this record operation.');
  return context;
}

/** Current recorded dimensions and selected observation must agree before a cached record is exposed. */
export async function authorizeRecordedDeal(env: Env, identity: RequestIdentity, dealId: string,
  permission: RecordPermission = 'analytics.view'): Promise<RecordAccess> {
  const context = await requireRecordActor(env, identity, permission);
  const row = await env.DB.prepare(`SELECT a.assessed_at,
    COALESCE(h.pipeline_id,c.pipeline_id) AS pipeline_id, COALESCE(h.owner_id,c.owner_id) AS owner_id,
    h.team_id, h.region_code
    FROM deal_assessments a
    LEFT JOIN assessment_context c ON c.portal_id=a.portal_id AND c.deal_id=a.deal_id AND c.updated_at=a.assessed_at
    LEFT JOIN LATERAL (SELECT pipeline_id,owner_id,team_id,region_code FROM assessment_history
      WHERE portal_id=a.portal_id AND deal_id=a.deal_id AND assessed_at=a.assessed_at ORDER BY id DESC LIMIT 1) h ON true
    WHERE a.portal_id=? AND a.deal_id=? AND dealguard.record_is_available(a.portal_id,a.deal_id)`)
    .bind(identity.portalId,dealId).first<{assessed_at: string;pipeline_id: string|null;owner_id: string|null;team_id: string|null;region_code: string|null}>();
  const resource: RecordResource = {pipelineId:row?.pipeline_id ?? null,ownerId:row?.owner_id ?? null,
    teamId:row?.team_id ?? null,regionCode:row?.region_code ?? null};
  assertRecordScope(context,resource);
  return {context,resource,assessmentAt:row?.assessed_at ?? null};
}

/** A live response is checked before it can be persisted, enriched or used for an action. */
export async function authorizeFreshDeal(env: Env, identity: RequestIdentity, deal: NormalizedDeal,
  permission: RecordPermission = 'analytics.view'): Promise<RecordResource> {
  const context = await requireRecordActor(env,identity,permission);
  const mappings = await getPolicyDimensionMappings(env,identity.portalId);
  const values = dimensionValues(deal.properties,mappings);
  const resource = {pipelineId:deal.properties.pipeline ?? null,ownerId:deal.properties.hubspot_owner_id ?? null,
    teamId:values.teamId || null,regionCode:values.regionCode || null};
  assertRecordScope(context,resource);
  return resource;
}
