import { PLAN_LIMITS } from './config.js';
import { AppError } from './errors.js';
import { HubSpotClient } from './hubspot.js';
import { Repository } from './repository.js';
import type { DealAssessment, Env, HubSpotPropertyDefinition, RequestIdentity } from './types.js';

export const NATIVE_PROPERTY_VERSION = 1;

export const DEALGUARD_PROPERTY_DEFINITIONS: HubSpotPropertyDefinition[] = [
  {
    groupName: 'dealinformation',
    name: 'dealguard_readiness_score',
    label: 'DealGuard readiness score',
    description: 'Latest deterministic DealGuard readiness score from 0 to 100.',
    type: 'number',
    fieldType: 'number',
  },
  {
    groupName: 'dealinformation',
    name: 'dealguard_readiness_status',
    label: 'DealGuard readiness status',
    description: 'Latest DealGuard readiness classification.',
    type: 'enumeration',
    fieldType: 'select',
    options: [
      { label: 'Ready', value: 'ready', displayOrder: 0, hidden: false },
      { label: 'At risk', value: 'at_risk', displayOrder: 1, hidden: false },
      { label: 'Critical', value: 'critical', displayOrder: 2, hidden: false },
    ],
  },
  {
    groupName: 'dealinformation',
    name: 'dealguard_readiness_grade',
    label: 'DealGuard readiness grade',
    description: 'Latest DealGuard letter grade.',
    type: 'enumeration',
    fieldType: 'select',
    options: ['A', 'B', 'C', 'D', 'F'].map((value, displayOrder) => ({ label: value, value, displayOrder, hidden: false })),
  },
  {
    groupName: 'dealinformation',
    name: 'dealguard_issue_count',
    label: 'DealGuard issue count',
    description: 'Number of readiness issues in the latest assessment.',
    type: 'number',
    fieldType: 'number',
  },
  {
    groupName: 'dealinformation',
    name: 'dealguard_handoff_status',
    label: 'DealGuard handoff status',
    description: 'Current DealGuard sales-to-delivery handoff status.',
    type: 'enumeration',
    fieldType: 'select',
    options: [
      { label: 'Not applicable', value: 'not_applicable', displayOrder: 0, hidden: false },
      { label: 'Required', value: 'required', displayOrder: 1, hidden: false },
      { label: 'Confirmed', value: 'confirmed', displayOrder: 2, hidden: false },
    ],
  },
  {
    groupName: 'dealinformation',
    name: 'dealguard_last_assessed_at',
    label: 'DealGuard last assessed at',
    description: 'Timestamp of the latest DealGuard readiness assessment.',
    type: 'datetime',
    fieldType: 'date',
  },
  {
    groupName: 'dealinformation',
    name: 'dealguard_readiness_summary',
    label: 'DealGuard readiness summary',
    description: 'Human-readable summary of the latest DealGuard readiness assessment.',
    type: 'string',
    fieldType: 'textarea',
  },
];

export type DealGuardHandoffStatus = 'not_applicable' | 'required' | 'confirmed';
export type NativeSyncStatus = {
  entitled: boolean;
  enabled: boolean;
  status: 'not_provisioned' | 'provisioning' | 'ready' | 'backfilling' | 'error';
  propertyVersion: number;
  provisionedAt: string | null;
  lastBackfillAt: string | null;
  lastBackfillCount: number;
  lastError: string | null;
};

type NativeSyncStateRow = {
  status: NativeSyncStatus['status'];
  property_version: number;
  provisioned_at: string | null;
  last_backfill_at: string | null;
  last_backfill_count: number;
  last_error: string | null;
};

function handoffStatus(assessment: DealAssessment, persistedStatus?: string | null): DealGuardHandoffStatus {
  if (!assessment.isWon) return 'not_applicable';
  return persistedStatus === 'confirmed' ? 'confirmed' : 'required';
}

export function nativePropertyValues(
  assessment: DealAssessment,
  persistedHandoffStatus?: string | null,
  includeSummary = true,
): Record<string, string> {
  const values: Record<string, string> = {
    dealguard_readiness_score: String(assessment.score),
    dealguard_readiness_status: assessment.status,
    dealguard_readiness_grade: assessment.grade,
    dealguard_issue_count: String(assessment.issues.length),
    dealguard_handoff_status: handoffStatus(assessment, persistedHandoffStatus),
    dealguard_last_assessed_at: String(new Date(assessment.assessedAt).getTime()),
  };
  if (includeSummary) values.dealguard_readiness_summary = assessment.readinessSummary.slice(0, 5000);
  return values;
}

async function stateForPortal(env: Env, portalId: string): Promise<NativeSyncStateRow | null> {
  return env.DB.prepare(
    `SELECT status, property_version, provisioned_at, last_backfill_at, last_backfill_count, last_error
     FROM native_sync_state WHERE portal_id = ?`,
  ).bind(portalId).first<NativeSyncStateRow>();
}

async function setState(
  env: Env,
  portalId: string,
  patch: {
    status: NativeSyncStateRow['status'];
    propertyVersion?: number;
    provisionedAt?: string | null;
    lastBackfillAt?: string | null;
    lastBackfillCount?: number;
    lastError?: string | null;
  },
): Promise<void> {
  const existing = await stateForPortal(env, portalId);
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO native_sync_state (portal_id, status, property_version, provisioned_at, last_backfill_at, last_backfill_count, last_error, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(portal_id) DO UPDATE SET status = excluded.status, property_version = excluded.property_version,
       provisioned_at = excluded.provisioned_at, last_backfill_at = excluded.last_backfill_at,
       last_backfill_count = excluded.last_backfill_count, last_error = excluded.last_error, updated_at = excluded.updated_at`,
  ).bind(
    portalId,
    patch.status,
    patch.propertyVersion ?? existing?.property_version ?? 0,
    patch.provisionedAt !== undefined ? patch.provisionedAt : existing?.provisioned_at ?? null,
    patch.lastBackfillAt !== undefined ? patch.lastBackfillAt : existing?.last_backfill_at ?? null,
    patch.lastBackfillCount ?? existing?.last_backfill_count ?? 0,
    patch.lastError !== undefined ? patch.lastError : existing?.last_error ?? null,
    now,
  ).run();
}

export async function getNativeSyncStatus(env: Env, portalId: string): Promise<NativeSyncStatus> {
  const credentials = await new Repository(env).getCredentials(portalId);
  const row = await stateForPortal(env, portalId);
  return {
    entitled: PLAN_LIMITS[credentials.tenant.plan].nativeSync,
    enabled: credentials.settings.nativeSync.enabled,
    status: row?.status ?? 'not_provisioned',
    propertyVersion: row?.property_version ?? 0,
    provisionedAt: row?.provisioned_at ?? null,
    lastBackfillAt: row?.last_backfill_at ?? null,
    lastBackfillCount: row?.last_backfill_count ?? 0,
    lastError: row?.last_error ?? null,
  };
}

export async function provisionNativeSync(env: Env, identity: RequestIdentity): Promise<NativeSyncStatus> {
  const repository = new Repository(env);
  const credentials = await repository.getCredentials(identity.portalId);
  if (!PLAN_LIMITS[credentials.tenant.plan].nativeSync) {
    throw new AppError(403, 'growth_plan_required', 'Native HubSpot property sync requires DealGuard Growth.');
  }
  await setState(env, identity.portalId, { status: 'provisioning', lastError: null });
  try {
    const client = await HubSpotClient.forPortal(env, identity.portalId);
    await client.ensureDealProperties(DEALGUARD_PROPERTY_DEFINITIONS);
    const now = new Date().toISOString();
    await setState(env, identity.portalId, {
      status: 'ready',
      propertyVersion: NATIVE_PROPERTY_VERSION,
      provisionedAt: now,
      lastError: null,
    });
    await repository.audit(identity.portalId, identity.userId, identity.userEmail, 'native_sync.provisioned', {
      propertyVersion: NATIVE_PROPERTY_VERSION,
      properties: DEALGUARD_PROPERTY_DEFINITIONS.map((property) => property.name),
    });
  } catch (error) {
    await setState(env, identity.portalId, {
      status: 'error',
      lastError: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
    });
    throw error;
  }
  return getNativeSyncStatus(env, identity.portalId);
}

export async function syncAssessmentIfEnabled(
  env: Env,
  client: HubSpotClient,
  assessment: DealAssessment,
  persistedHandoffStatus?: string | null,
): Promise<boolean> {
  if (!PLAN_LIMITS[client.plan].nativeSync || !client.settings.nativeSync.enabled) return false;
  const state = await stateForPortal(env, client.portalId);
  if (state?.status !== 'ready' || state.property_version !== NATIVE_PROPERTY_VERSION) return false;
  await client.updateDealProperties(
    assessment.dealId,
    nativePropertyValues(assessment, persistedHandoffStatus, client.settings.nativeSync.includeSummary),
  );
  return true;
}

export async function syncAssessmentBatchIfEnabled(
  env: Env,
  client: HubSpotClient,
  assessments: Array<{ assessment: DealAssessment; handoffStatus?: string | null }>,
): Promise<number> {
  if (!PLAN_LIMITS[client.plan].nativeSync || !client.settings.nativeSync.enabled || assessments.length === 0) return 0;
  const state = await stateForPortal(env, client.portalId);
  if (state?.status !== 'ready' || state.property_version !== NATIVE_PROPERTY_VERSION) return 0;
  await client.batchUpdateDeals(assessments.map(({ assessment, handoffStatus: status }) => ({
    id: assessment.dealId,
    properties: nativePropertyValues(assessment, status, client.settings.nativeSync.includeSummary),
  })));
  return assessments.length;
}

export async function backfillNativeSync(env: Env, portalId: string): Promise<number> {
  const repository = new Repository(env);
  const credentials = await repository.getCredentials(portalId);
  if (!PLAN_LIMITS[credentials.tenant.plan].nativeSync || !credentials.settings.nativeSync.enabled) {
    throw new AppError(403, 'native_sync_not_enabled', 'Enable native HubSpot property sync on a Growth plan before starting a backfill.');
  }
  const state = await stateForPortal(env, portalId);
  if (state?.status !== 'ready' || state.property_version !== NATIVE_PROPERTY_VERSION) {
    throw new AppError(409, 'native_sync_not_provisioned', 'Provision DealGuard properties before starting a backfill.');
  }
  await setState(env, portalId, { status: 'backfilling', lastError: null });
  try {
    const rows = await env.DB.prepare(
      `SELECT a.deal_id, a.deal_name, a.pipeline_label, a.stage_label, a.score, a.grade, a.status,
       a.issues_json, a.readiness_summary, a.is_closed, a.is_won, a.handoff_eligible, a.assessed_at,
       h.status AS handoff_status
       FROM deal_assessments a
       LEFT JOIN handoffs h ON h.portal_id = a.portal_id AND h.deal_id = a.deal_id
       WHERE a.portal_id = ? ORDER BY a.assessed_at DESC LIMIT ?`,
    ).bind(portalId, PLAN_LIMITS[credentials.tenant.plan].maxDealsPerScan).all<Record<string, unknown>>();
    const assessments = (rows.results ?? []).map((row) => ({
      assessment: {
        dealId: String(row.deal_id),
        dealName: String(row.deal_name),
        pipelineLabel: String(row.pipeline_label),
        stageLabel: String(row.stage_label),
        score: Number(row.score),
        grade: String(row.grade) as DealAssessment['grade'],
        status: String(row.status) as DealAssessment['status'],
        issues: JSON.parse(String(row.issues_json)) as DealAssessment['issues'],
        readinessSummary: String(row.readiness_summary),
        isClosed: Number(row.is_closed) === 1,
        isWon: Number(row.is_won) === 1,
        handoffEligible: Number(row.handoff_eligible) === 1,
        assessedAt: String(row.assessed_at),
      },
      handoffStatus: row.handoff_status ? String(row.handoff_status) : null,
    }));
    const client = await HubSpotClient.forPortal(env, portalId);
    await client.batchUpdateDeals(assessments.map(({ assessment, handoffStatus: status }) => ({
      id: assessment.dealId,
      properties: nativePropertyValues(assessment, status, credentials.settings.nativeSync.includeSummary),
    })));
    const now = new Date().toISOString();
    await setState(env, portalId, {
      status: 'ready',
      lastBackfillAt: now,
      lastBackfillCount: assessments.length,
      lastError: null,
    });
    await repository.audit(portalId, null, null, 'native_sync.backfill_completed', { count: assessments.length });
    return assessments.length;
  } catch (error) {
    await setState(env, portalId, {
      status: 'error',
      lastError: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
    });
    throw error;
  }
}
