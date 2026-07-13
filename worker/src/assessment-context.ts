import type { DealAssessment, Env } from './types.js';

export async function saveAssessmentContext(env: Env, portalId: string, assessment: DealAssessment): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO assessment_context (portal_id, deal_id, deal_amount, owner_id, pipeline_id, stage_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(portal_id, deal_id) DO UPDATE SET
       deal_amount = excluded.deal_amount,
       owner_id = excluded.owner_id,
       pipeline_id = excluded.pipeline_id,
       stage_id = excluded.stage_id,
       updated_at = excluded.updated_at`
  ).bind(
    portalId,
    assessment.dealId,
    assessment.dealAmount ?? null,
    assessment.ownerId ?? null,
    assessment.pipelineId ?? '',
    assessment.stageId ?? '',
    assessment.assessedAt,
  ).run();
}
