import { AppError } from './errors.js';
import { createRemediationCase } from './remediation.js';
import type { Env, IssueSeverity, RequestIdentity } from './types.js';

interface WorkflowPayload {
  callbackId?: string;
  portalId?: number | string;
  objectId?: number | string;
  origin?: { portalId?: number | string; objectId?: number | string };
  inputFields?: Record<string, unknown>;
}

export interface RemediationWorkflowInput {
  portalId: string;
  dealId: string;
  callbackId: string | null;
  issueCode: string;
  title: string;
  description: string;
  severity: IssueSeverity;
  dueHours: number;
  createHubSpotTask: boolean;
}

export function parseRemediationWorkflowPayload(value: unknown): RemediationWorkflowInput {
  const payload = value && typeof value === 'object' ? value as WorkflowPayload : {};
  const portalId = String(payload.origin?.portalId ?? payload.portalId ?? '');
  const dealId = String(payload.origin?.objectId ?? payload.objectId ?? '');
  if (!/^\d+$/.test(portalId) || !/^\d+$/.test(dealId)) throw new AppError(400, 'workflow_payload_invalid', 'Workflow execution is missing a valid HubSpot portal or deal ID.');
  const fields = payload.inputFields ?? {};
  const severity: IssueSeverity = fields.severity === 'critical' || fields.severity === 'info' ? fields.severity : 'warning';
  const rawHours = Number(fields.dueHours ?? (severity === 'critical' ? 24 : 72));
  const dueHours = Number.isFinite(rawHours) ? Math.min(720, Math.max(1, Math.round(rawHours))) : 72;
  return {
    portalId,
    dealId,
    callbackId: payload.callbackId ? String(payload.callbackId) : null,
    issueCode: typeof fields.issueCode === 'string' && fields.issueCode.trim() ? fields.issueCode.trim().slice(0, 128) : 'workflow_follow_up',
    title: typeof fields.title === 'string' && fields.title.trim() ? fields.title.trim().slice(0, 255) : 'DealGuard workflow remediation',
    description: typeof fields.description === 'string' && fields.description.trim() ? fields.description.trim().slice(0, 4000) : 'Resolve the issue identified by this HubSpot workflow.',
    severity,
    dueHours,
    createHubSpotTask: fields.createHubSpotTask !== 'no' && fields.createHubSpotTask !== false,
  };
}

export async function executeRemediationWorkflow(env: Env, value: unknown): Promise<Record<string, unknown>> {
  const parsed = parseRemediationWorkflowPayload(value);
  const identity: RequestIdentity = { portalId: parsed.portalId, userId: null, userEmail: null, appId: null };
  const remediation = await createRemediationCase(env, identity, {
    dealId: parsed.dealId,
    issueCode: parsed.issueCode,
    title: parsed.title,
    description: parsed.description,
    severity: parsed.severity,
    dueAt: new Date(Date.now() + parsed.dueHours * 60 * 60_000).toISOString(),
    createHubSpotTask: parsed.createHubSpotTask,
  }, 'workflow');
  return {
    ok: true,
    callbackId: parsed.callbackId,
    outputFields: {
      remediationCaseId: remediation.id,
      remediationStatus: remediation.status,
      remediationDueAt: remediation.dueAt ?? '',
      hubSpotTaskId: remediation.hubSpotTaskId ?? '',
    },
  };
}
