import { assessDealForPortal } from './assessment-service.js';
import { AppError } from './errors.js';
import { Repository } from './repository.js';
import type { DealAssessment, Env } from './types.js';

interface WorkflowPayload {
  callbackId?: string;
  portalId?: number | string;
  objectId?: number | string;
  origin?: { portalId?: number | string; objectId?: number | string };
  inputFields?: Record<string, unknown>;
}

export function parseWorkflowActionPayload(value: unknown): { portalId: string; dealId: string; notifySlack: boolean; callbackId: string | null } {
  const payload = value && typeof value === 'object' ? value as WorkflowPayload : {};
  const portalId = String(payload.origin?.portalId ?? payload.portalId ?? '');
  const dealId = String(payload.origin?.objectId ?? payload.objectId ?? '');
  if (!/^\d+$/.test(portalId) || !/^\d+$/.test(dealId)) {
    throw new AppError(400, 'workflow_payload_invalid', 'Workflow execution is missing a valid HubSpot portal or deal ID.');
  }
  const rawNotify = payload.inputFields?.notifySlack;
  const notifySlack = rawNotify === true || rawNotify === 'true' || rawNotify === 'yes';
  return { portalId, dealId, notifySlack, callbackId: payload.callbackId ? String(payload.callbackId) : null };
}

export function workflowOutputFields(
  assessment: DealAssessment & { handoffStatus?: string | null },
): Record<string, string | number> {
  return {
    readinessScore: assessment.score,
    readinessStatus: assessment.status,
    readinessGrade: assessment.grade,
    issueCount: assessment.issues.length,
    handoffStatus: assessment.isWon
      ? assessment.handoffStatus === 'confirmed' ? 'confirmed' : 'required'
      : 'not_applicable',
    readinessSummary: assessment.readinessSummary,
    assessedAt: assessment.assessedAt,
  };
}

export async function executeWorkflowAction(env: Env, value: unknown): Promise<Record<string, unknown>> {
  const parsed = parseWorkflowActionPayload(value);
  const repository = new Repository(env);
  const tenant = await repository.getTenant(parsed.portalId);
  if (tenant.plan === 'free') throw new AppError(403, 'growth_plan_required', 'The DealGuard workflow action requires DealGuard Growth.');
  const assessmentResult = await assessDealForPortal(env, parsed.portalId, parsed.dealId, 'workflow', parsed.notifySlack);
  if (!assessmentResult) throw new AppError(500, 'assessment_not_saved', 'DealGuard could not persist the workflow assessment.');
  const assessment = assessmentResult as unknown as DealAssessment & { handoffStatus?: string | null };
  const outputFields = workflowOutputFields(assessment);
  await repository.audit(parsed.portalId, null, null, 'workflow.assessment_completed', {
    dealId: parsed.dealId,
    callbackId: parsed.callbackId,
    score: assessment.score,
    status: assessment.status,
    notifySlack: parsed.notifySlack,
  });
  return { ok: true, callbackId: parsed.callbackId, outputFields };
}
