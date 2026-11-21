import type { Env } from './types.js';
import { evidenceInstant } from './evidence-freshness.js';

/** The database reads issues from the locked, current assessment, not caller data. */
export async function resolveAssessmentCases(env: Env, portalId: string, dealId: string, assessedAt: string): Promise<number> {
  if (!evidenceInstant(assessedAt)) return 0;
  const result = await env.DB.prepare('SELECT dealguard.resolve_assessment_cases(?, ?, ?) AS changed')
    .bind(portalId, dealId, assessedAt).first<{ changed: number }>();
  return Number(result?.changed ?? 0);
}
