import { attachmentDownloadUrl, completeAttachmentUpload, createAttachmentUpload } from './attachments.js';
import {
  createCustomerPortalSession,
  getBillingStatus,
  setScheduledPlanChange,
  updateBillingAllowance,
  type BillableMetric,
  type CommercialTier,
} from './billing.js';
import {
  acknowledgeAlert,
  createAlertSuppression,
  createNotificationChannel,
  deleteNotificationChannel,
  listAlertConfiguration,
  upsertBusinessCalendar,
  upsertEscalationPolicy,
  upsertNotificationRoute,
  updateNotificationChannel,
} from './alerting-enterprise.js';
import {
  assignEnterpriseRole,
  createChangeApproval,
  decideChangeApproval,
  enterpriseAccessContext,
  listChangeApprovals,
  listEnterpriseRoles,
  removeEnterpriseRole,
  requireEnterprisePermission,
} from './enterprise-access.js';
import {
  deleteAnalyticsView,
  enterpriseAnalyticsV2,
  exportAnalyticsCsv,
  listAnalyticsViews,
  saveAnalyticsView,
} from './enterprise-analytics-v2.js';
import {
  addPolicyExceptionEvidence,
  createPolicyException,
  createPolicyFromTemplate,
  createPolicyTemplate,
  decidePolicyException,
  deletePolicySegment,
  exportPolicyPackage,
  importPolicyPackage,
  listPolicySegments,
  listPolicyTemplates,
  policyDiff,
  upsertPolicySegment,
} from './enterprise-policy.js';
import {
  addRemediationComment,
  addRemediationEvidence,
  configureRemediationControls,
  createRemediationBulkJob,
  remediationDetail,
  reviewRemediationEvidence,
  runRemediationBulkJob,
} from './remediation-enterprise.js';
import {
  createDataExport,
  dataExportStatus,
  createLegalHold,
  createSiemDestination,
  downloadDataExport,
  exportImmutableAudit,
  getComplianceSettings,
  releaseLegalHold,
  searchImmutableAudit,
  updateComplianceSettings,
  verifyAuditChain,
} from './compliance.js';
import { AppError } from './errors.js';
import { json, methodNotAllowed, readJson } from './http.js';
import {
  createIncident,
  publicStatus,
  recordRestoreTest,
  registerBackupManifest,
  reliabilityDashboard,
  setServiceSlo,
  updateIncident,
  upsertSyntheticCheck,
} from './reliability.js';
import { requireCommercialTier } from './billing.js';
import type { Env, RequestIdentity } from './types.js';

interface RouteContext {
  waitUntil(promise: Promise<unknown>): void;
}

function idMatch(pathname: string, expression: RegExp): RegExpMatchArray | null {
  return pathname.match(expression);
}

async function requireEnterprise(env: Env, identity: RequestIdentity): Promise<void> {
  await requireCommercialTier(env, identity.portalId, 'enterprise');
}

export async function routeEnterpriseApi(
  request: Request,
  env: Env,
  identity: RequestIdentity,
  ctx: RouteContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/api/v1/enterprise/access') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    await requireEnterprise(env, identity);
    return json(await enterpriseAccessContext(env, identity));
  }
  if (path === '/api/v1/enterprise/roles') {
    await requireEnterprise(env, identity);
    if (request.method === 'GET') return json({ roles: await listEnterpriseRoles(env, identity) });
    if (request.method === 'PUT') {
      await assignEnterpriseRole(env, identity, await readJson<unknown>(request));
      return json({ ok: true });
    }
    return methodNotAllowed(['GET', 'PUT']);
  }
  const roleDelete = idMatch(path, /^\/api\/v1\/enterprise\/roles\/([^/]+)$/);
  if (roleDelete) {
    if (request.method !== 'DELETE') return methodNotAllowed(['DELETE']);
    await requireEnterprise(env, identity);
    await removeEnterpriseRole(env, identity, roleDelete[1]!);
    return json({ ok: true });
  }

  if (path === '/api/v1/enterprise/change-approvals') {
    await requireEnterprise(env, identity);
    if (request.method === 'GET') return json({ approvals: await listChangeApprovals(env, identity, url.searchParams.get('status') ?? '') });
    if (request.method === 'POST') {
      const body = await readJson<{ changeType?: string; resourceType?: string; resourceId?: string; payload?: unknown; expiresAt?: string | null }>(request);
      if (!body.changeType || !body.resourceType || !body.resourceId) throw new AppError(400, 'change_approval_fields_required', 'Change type, resource type and resource ID are required.');
      return json(await createChangeApproval(env, identity, {
        changeType: body.changeType,
        resourceType: body.resourceType,
        resourceId: body.resourceId,
        payload: body.payload,
        ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt } : {}),
      }), 201);
    }
    return methodNotAllowed(['GET', 'POST']);
  }
  const approvalDecision = idMatch(path, /^\/api\/v1\/enterprise\/change-approvals\/([^/]+)\/(approve|reject)$/);
  if (approvalDecision) {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    await requireEnterprise(env, identity);
    const body = await readJson<{ comment?: string }>(request);
    return json(await decideChangeApproval(env, identity, approvalDecision[1]!, approvalDecision[2] === 'approve' ? 'approved' : 'rejected', body.comment ?? ''));
  }

  if (path === '/api/v1/enterprise/policy-templates') {
    await requireEnterprise(env, identity);
    if (request.method === 'GET') return json({ templates: await listPolicyTemplates(env, identity.portalId) });
    if (request.method === 'POST') return json(await createPolicyTemplate(env, identity, await readJson<unknown>(request)), 201);
    return methodNotAllowed(['GET', 'POST']);
  }
  const templateApply = idMatch(path, /^\/api\/v1\/enterprise\/policy-templates\/([^/]+)\/apply$/);
  if (templateApply) {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    await requireEnterprise(env, identity);
    return json(await createPolicyFromTemplate(env, identity, decodeURIComponent(templateApply[1]!)), 201);
  }
  const segments = idMatch(path, /^\/api\/v1\/governance\/policies\/([^/]+)\/segments$/);
  if (segments) {
    await requireEnterprise(env, identity);
    if (request.method === 'GET') return json({ segments: await listPolicySegments(env, identity.portalId, segments[1]!) });
    if (request.method === 'POST') return json(await upsertPolicySegment(env, identity, segments[1]!, null, await readJson<unknown>(request)), 201);
    return methodNotAllowed(['GET', 'POST']);
  }
  const segmentItem = idMatch(path, /^\/api\/v1\/governance\/policies\/([^/]+)\/segments\/([^/]+)$/);
  if (segmentItem) {
    await requireEnterprise(env, identity);
    if (request.method === 'PUT') return json(await upsertPolicySegment(env, identity, segmentItem[1]!, segmentItem[2]!, await readJson<unknown>(request)));
    if (request.method === 'DELETE') {
      await deletePolicySegment(env, identity, segmentItem[1]!, segmentItem[2]!);
      return json({ ok: true });
    }
    return methodNotAllowed(['PUT', 'DELETE']);
  }
  const policyDiffRoute = idMatch(path, /^\/api\/v1\/governance\/policies\/([^/]+)\/diff$/);
  if (policyDiffRoute) {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    await requireEnterprise(env, identity);
    return json({ diff: await policyDiff(env, identity.portalId, policyDiffRoute[1]!) });
  }
  const policyExport = idMatch(path, /^\/api\/v1\/governance\/policies\/([^/]+)\/export$/);
  if (policyExport) {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    await requireEnterprise(env, identity);
    return exportPolicyPackage(env, identity, policyExport[1]!);
  }
  if (path === '/api/v1/governance/policies/import') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    await requireEnterprise(env, identity);
    return json(await importPolicyPackage(env, identity, await readJson<unknown>(request, 2_000_000)), 201);
  }
  if (path === '/api/v1/governance/exceptions') {
    if (request.method !== 'POST') return null;
    await requireEnterprise(env, identity);
    return json(await createPolicyException(env, identity, await readJson<unknown>(request)), 201);
  }
  const exceptionDecision = idMatch(path, /^\/api\/v1\/governance\/exceptions\/([^/]+)\/(approve|reject|revoke)$/);
  if (exceptionDecision) {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    await requireEnterprise(env, identity);
    const body = await readJson<{ comment?: string }>(request);
    await decidePolicyException(env, identity, exceptionDecision[1]!, exceptionDecision[2] === 'approve' ? 'approved' : exceptionDecision[2] === 'reject' ? 'rejected' : 'revoked', body.comment ?? '');
    return json({ ok: true });
  }
  const exceptionEvidence = idMatch(path, /^\/api\/v1\/governance\/exceptions\/([^/]+)\/evidence$/);
  if (exceptionEvidence) {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    await requireEnterprise(env, identity);
    return json(await addPolicyExceptionEvidence(env, identity, exceptionEvidence[1]!, await readJson<unknown>(request)), 201);
  }

  if (path === '/api/v1/enterprise/analytics') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    await requireEnterprise(env, identity);
    return json(await enterpriseAnalyticsV2(env, identity, url));
  }
  if (path === '/api/v1/enterprise/analytics/export') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    await requireEnterprise(env, identity);
    return exportAnalyticsCsv(env, identity, url);
  }
  if (path === '/api/v1/enterprise/analytics/views') {
    await requireEnterprise(env, identity);
    if (request.method === 'GET') return json({ views: await listAnalyticsViews(env, identity) });
    if (request.method === 'POST') return json(await saveAnalyticsView(env, identity, await readJson<unknown>(request)), 201);
    return methodNotAllowed(['GET', 'POST']);
  }
  const analyticsView = idMatch(path, /^\/api\/v1\/enterprise\/analytics\/views\/([^/]+)$/);
  if (analyticsView) {
    await requireEnterprise(env, identity);
    if (request.method === 'PUT') return json(await saveAnalyticsView(env, identity, await readJson<unknown>(request), analyticsView[1]!));
    if (request.method === 'DELETE') {
      await deleteAnalyticsView(env, identity, analyticsView[1]!);
      return json({ ok: true });
    }
    return methodNotAllowed(['PUT', 'DELETE']);
  }

  const remediationDetailRoute = idMatch(path, /^\/api\/v1\/remediations\/([^/]+)\/detail$/);
  if (remediationDetailRoute) {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    await requireEnterprise(env, identity);
    return json(await remediationDetail(env, identity, remediationDetailRoute[1]!));
  }
  const remediationControls = idMatch(path, /^\/api\/v1\/remediations\/([^/]+)\/controls$/);
  if (remediationControls) {
    if (request.method !== 'PUT') return methodNotAllowed(['PUT']);
    await requireEnterprise(env, identity);
    await configureRemediationControls(env, identity, remediationControls[1]!, await readJson<unknown>(request) as Parameters<typeof configureRemediationControls>[3]);
    return json({ ok: true });
  }
  const remediationComment = idMatch(path, /^\/api\/v1\/remediations\/([^/]+)\/comments$/);
  if (remediationComment) {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    await requireEnterprise(env, identity);
    const body = await readJson<{ body?: string }>(request);
    return json(await addRemediationComment(env, identity, remediationComment[1]!, body.body), 201);
  }
  const remediationEvidence = idMatch(path, /^\/api\/v1\/remediations\/([^/]+)\/evidence$/);
  if (remediationEvidence) {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    await requireEnterprise(env, identity);
    return json(await addRemediationEvidence(env, identity, remediationEvidence[1]!, await readJson<unknown>(request)), 201);
  }
  const remediationEvidenceReview = idMatch(path, /^\/api\/v1\/remediations\/([^/]+)\/evidence\/(accept|reject)$/);
  if (remediationEvidenceReview) {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    await requireEnterprise(env, identity);
    const body = await readJson<{ comment?: string }>(request);
    await reviewRemediationEvidence(env, identity, remediationEvidenceReview[1]!, remediationEvidenceReview[2] === 'accept' ? 'accepted' : 'rejected', body.comment ?? '');
    return json({ ok: true });
  }
  if (path === '/api/v1/remediations/bulk') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    await requireEnterprise(env, identity);
    return json(await createRemediationBulkJob(env, identity, await readJson<unknown>(request)), 202);
  }
  const bulkRun = idMatch(path, /^\/api\/v1\/remediations\/bulk\/([^/]+)\/run$/);
  if (bulkRun) {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    await requireEnterprise(env, identity);
    return json(await runRemediationBulkJob(env, identity, bulkRun[1]!));
  }

  if (path === '/api/v1/enterprise/alerts') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    await requireEnterprise(env, identity);
    return json(await listAlertConfiguration(env, identity));
  }
  if (path === '/api/v1/enterprise/alerts/channels') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    await requireEnterprise(env, identity);
    return json(await createNotificationChannel(env, identity, await readJson<unknown>(request)), 201);
  }
  const channelItem = idMatch(path, /^\/api\/v1\/enterprise\/alerts\/channels\/([^/]+)$/);
  if (channelItem) {
    await requireEnterprise(env, identity);
    if (request.method === 'PUT') {
      await updateNotificationChannel(env, identity, channelItem[1]!, await readJson<unknown>(request));
      return json({ ok: true });
    }
    if (request.method === 'DELETE') {
      await deleteNotificationChannel(env, identity, channelItem[1]!);
      return json({ ok: true });
    }
    return methodNotAllowed(['PUT', 'DELETE']);
  }
  if (path === '/api/v1/enterprise/alerts/routes') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    await requireEnterprise(env, identity);
    return json(await upsertNotificationRoute(env, identity, await readJson<unknown>(request)), 201);
  }
  const routeItem = idMatch(path, /^\/api\/v1\/enterprise\/alerts\/routes\/([^/]+)$/);
  if (routeItem) {
    if (request.method !== 'PUT') return methodNotAllowed(['PUT']);
    await requireEnterprise(env, identity);
    return json(await upsertNotificationRoute(env, identity, await readJson<unknown>(request), routeItem[1]!));
  }
  if (path === '/api/v1/enterprise/alerts/calendars') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    await requireEnterprise(env, identity);
    return json(await upsertBusinessCalendar(env, identity, await readJson<unknown>(request)), 201);
  }
  const calendarItem = idMatch(path, /^\/api\/v1\/enterprise\/alerts\/calendars\/([^/]+)$/);
  if (calendarItem) {
    if (request.method !== 'PUT') return methodNotAllowed(['PUT']);
    await requireEnterprise(env, identity);
    return json(await upsertBusinessCalendar(env, identity, await readJson<unknown>(request), calendarItem[1]!));
  }
  if (path === '/api/v1/enterprise/alerts/escalations') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    await requireEnterprise(env, identity);
    return json(await upsertEscalationPolicy(env, identity, await readJson<unknown>(request)), 201);
  }
  const escalationItem = idMatch(path, /^\/api\/v1\/enterprise\/alerts\/escalations\/([^/]+)$/);
  if (escalationItem) {
    if (request.method !== 'PUT') return methodNotAllowed(['PUT']);
    await requireEnterprise(env, identity);
    return json(await upsertEscalationPolicy(env, identity, await readJson<unknown>(request), escalationItem[1]!));
  }
  if (path === '/api/v1/enterprise/alerts/suppressions') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    await requireEnterprise(env, identity);
    return json(await createAlertSuppression(env, identity, await readJson<unknown>(request)), 201);
  }
  const acknowledgeRoute = idMatch(path, /^\/api\/v1\/enterprise\/alerts\/([^/]+)\/acknowledge$/);
  if (acknowledgeRoute) {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    await requireEnterprise(env, identity);
    await acknowledgeAlert(env, identity, acknowledgeRoute[1]!);
    return json({ ok: true });
  }

  if (path === '/api/v1/enterprise/storage/uploads') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    await requireEnterprise(env, identity);
    return json(await createAttachmentUpload(env, identity, await readJson<unknown>(request)), 201);
  }
  const uploadComplete = idMatch(path, /^\/api\/v1\/enterprise\/storage\/uploads\/([^/]+)\/complete$/);
  if (uploadComplete) {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    await requireEnterprise(env, identity);
    return json(await completeAttachmentUpload(env, identity, uploadComplete[1]!));
  }
  const uploadDownload = idMatch(path, /^\/api\/v1\/enterprise\/storage\/uploads\/([^/]+)\/download$/);
  if (uploadDownload) {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    await requireEnterprise(env, identity);
    return json(await attachmentDownloadUrl(env, identity, uploadDownload[1]!));
  }

  if (path === '/api/v1/enterprise/compliance') {
    await requireEnterprise(env, identity);
    if (request.method === 'GET') return json(await getComplianceSettings(env, identity));
    if (request.method === 'PUT') {
      await updateComplianceSettings(env, identity, await readJson<unknown>(request));
      return json({ ok: true });
    }
    return methodNotAllowed(['GET', 'PUT']);
  }
  if (path === '/api/v1/enterprise/compliance/audit') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    await requireEnterprise(env, identity);
    return json({ events: await searchImmutableAudit(env, identity, url) });
  }
  if (path === '/api/v1/enterprise/compliance/audit/export') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    await requireEnterprise(env, identity);
    return exportImmutableAudit(env, identity, url);
  }
  if (path === '/api/v1/enterprise/compliance/audit/verify') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    await requireEnterprise(env, identity);
    return json(await verifyAuditChain(env, identity));
  }
  if (path === '/api/v1/enterprise/compliance/legal-holds') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    await requireEnterprise(env, identity);
    return json(await createLegalHold(env, identity, await readJson<unknown>(request)), 201);
  }
  const legalHoldRelease = idMatch(path, /^\/api\/v1\/enterprise\/compliance\/legal-holds\/([^/]+)\/release$/);
  if (legalHoldRelease) {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    await requireEnterprise(env, identity);
    await releaseLegalHold(env, identity, legalHoldRelease[1]!);
    return json({ ok: true });
  }
  if (path === '/api/v1/enterprise/compliance/siem') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    await requireEnterprise(env, identity);
    return json(await createSiemDestination(env, identity, await readJson<unknown>(request)), 201);
  }
  if (path === '/api/v1/enterprise/compliance/exports') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    await requireEnterprise(env, identity);
    return json(await createDataExport(env, identity, await readJson<unknown>(request)), 201);
  }
  const exportStatus = idMatch(path, /^\/api\/v1\/enterprise\/compliance\/exports\/([^/]+)$/);
  if (exportStatus) {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    await requireEnterprise(env, identity);
    return json(await dataExportStatus(env, identity, exportStatus[1]!));
  }
  const exportDownload = idMatch(path, /^\/api\/v1\/enterprise\/compliance\/exports\/([^/]+)\/download$/);
  if (exportDownload) {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    await requireEnterprise(env, identity);
    return downloadDataExport(env, identity, exportDownload[1]!);
  }

  if (path === '/api/v1/enterprise/reliability') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    await requireEnterprise(env, identity);
    return json(await reliabilityDashboard(env, identity));
  }
  if (path === '/api/v1/enterprise/reliability/slos') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    await requireEnterprise(env, identity);
    await setServiceSlo(env, identity, await readJson<unknown>(request));
    return json({ ok: true });
  }
  if (path === '/api/v1/enterprise/reliability/synthetics') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    await requireEnterprise(env, identity);
    return json(await upsertSyntheticCheck(env, identity, await readJson<unknown>(request)), 201);
  }
  const syntheticItem = idMatch(path, /^\/api\/v1\/enterprise\/reliability\/synthetics\/([^/]+)$/);
  if (syntheticItem) {
    if (request.method !== 'PUT') return methodNotAllowed(['PUT']);
    await requireEnterprise(env, identity);
    return json(await upsertSyntheticCheck(env, identity, await readJson<unknown>(request), syntheticItem[1]!));
  }
  if (path === '/api/v1/enterprise/reliability/incidents') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    await requireEnterprise(env, identity);
    return json(await createIncident(env, identity, await readJson<unknown>(request)), 201);
  }
  const incidentItem = idMatch(path, /^\/api\/v1\/enterprise\/reliability\/incidents\/([^/]+)$/);
  if (incidentItem) {
    if (request.method !== 'PUT') return methodNotAllowed(['PUT']);
    await requireEnterprise(env, identity);
    await updateIncident(env, identity, incidentItem[1]!, await readJson<unknown>(request));
    return json({ ok: true });
  }
  if (path === '/api/v1/enterprise/reliability/backups') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    await requireEnterprise(env, identity);
    return json(await registerBackupManifest(env, identity, await readJson<unknown>(request)), 201);
  }
  if (path === '/api/v1/enterprise/reliability/restore-tests') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    await requireEnterprise(env, identity);
    return json(await recordRestoreTest(env, identity, await readJson<unknown>(request)), 201);
  }

  if (path === '/api/v1/billing/allowances') {
    if (request.method !== 'PUT') return methodNotAllowed(['PUT']);
    await requireEnterprisePermission(env, identity, 'billing.allowance.manage');
    const body = await readJson<{ metric?: BillableMetric; includedQuantity?: number; hardLimit?: number | null; overageEnabled?: boolean }>(request);
    const metrics: BillableMetric[] = ['ai_credit', 'active_deal_overage', 'event_overage', 'retention_gb_month'];
    if (!body.metric || !metrics.includes(body.metric)) throw new AppError(400, 'billing_metric_invalid', 'Choose a supported billing metric.');
    await updateBillingAllowance(env, identity, body.metric, {
      includedQuantity: Number(body.includedQuantity ?? 0),
      hardLimit: body.hardLimit === null ? null : Number(body.hardLimit ?? 0),
      overageEnabled: body.overageEnabled === true,
    });
    return json({ ok: true });
  }
  if (path === '/api/v1/billing/plan-change') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    await requireEnterprisePermission(env, identity, 'billing.manage');
    const body = await readJson<{ tier?: CommercialTier; effectiveAt?: string }>(request);
    if (!body.tier || !body.effectiveAt) throw new AppError(400, 'billing_plan_change_fields_required', 'Tier and effective date are required.');
    await setScheduledPlanChange(env, identity, body.tier, body.effectiveAt);
    return json({ ok: true });
  }
  if (path === '/api/v1/billing/usage') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    await requireEnterprisePermission(env, identity, 'billing.usage.view');
    const status = await getBillingStatus(env, identity.portalId);
    const rows = await env.DB.prepare(`SELECT event_name, SUM(quantity) AS quantity, COUNT(*) AS events, MIN(occurred_at) AS first_at, MAX(occurred_at) AS last_at FROM billing_usage_events WHERE portal_id = ? AND occurred_at >= ? GROUP BY event_name`)
      .bind(identity.portalId, status.currentPeriodStart ?? new Date(Date.now() - 31 * 86400000).toISOString()).all<Record<string, unknown>>();
    return json({ allowances: status.allowances, usage: rows.results ?? [], periodStart: status.currentPeriodStart, periodEnd: status.currentPeriodEnd });
  }

  // Kept here so callers can embed the public status JSON in an authenticated view.
  if (path === '/api/v1/enterprise/public-status') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    return json(await publicStatus(env));
  }

  void ctx;
  return null;
}
