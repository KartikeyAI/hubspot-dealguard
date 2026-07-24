import type { AssessmentIssue, DealAssessment, Env, NormalizedDeal, RuleSettings } from './types.js';

export interface DealHistorySnapshot {
  score: number;
  grade: DealAssessment['grade'];
  status: DealAssessment['status'];
  issueCodes: string[];
  dealAmount: number | null;
  stageAgeDays: number | null;
  stageLabel: string;
  assessedAt: string;
}

export interface DealIntelligence {
  risk: {
    lostPoints: number;
    potentialScore: number;
    afterCriticalFixes: number;
    contributors: Array<AssessmentIssue & { impact: number }>;
  };
  nextBestActions: Array<{
    code: string;
    label: string;
    action: string;
    impact: number;
    severity: AssessmentIssue['severity'];
    property?: string;
  }>;
  stageReadiness: {
    stageId: string | null;
    stageLabel: string;
    satisfied: number;
    total: number;
    percent: number;
    blockers: Array<{ code: string; label: string; severity: AssessmentIssue['severity']; impact: number }>;
    requirements: Array<{ code: string; label: string; satisfied: boolean; severity: AssessmentIssue['severity']; impact: number }>;
  };
  change: {
    previousAssessedAt: string | null;
    scoreDelta: number | null;
    gradeChanged: boolean;
    statusChanged: boolean;
    newIssueCodes: string[];
    resolvedIssueCodes: string[];
    amountDelta: number | null;
    stageAgeDeltaDays: number | null;
    stageChanged: boolean;
  };
}

function present(value: string | null | undefined): boolean {
  return value !== null && value !== undefined && value.trim() !== '';
}

function requirementRows(deal: NormalizedDeal, settings: RuleSettings, assessment: DealAssessment): DealIntelligence['stageReadiness']['requirements'] {
  const issueByCode = new Map(assessment.issues.map((item) => [item.code, item]));
  const rows: DealIntelligence['stageReadiness']['requirements'] = [];
  const add = (code: string, label: string, satisfied: boolean, severity: AssessmentIssue['severity'], impact: number) => {
    rows.push({ code, label, satisfied, severity, impact });
  };
  if (settings.requireOwner) add('owner_missing', 'Deal owner assigned', present(deal.properties.hubspot_owner_id), 'critical', 12);
  if (settings.requireAmount) add('amount_missing', 'Deal amount recorded', present(deal.properties.amount), 'warning', 8);
  if (settings.requireCloseDate) add('close_date_missing', 'Close date recorded', present(deal.properties.closedate), 'critical', 10);
  if (!assessment.isClosed && settings.requireNextStep) add('next_step_missing', 'Next step recorded', present(deal.properties.hs_next_step), 'warning', 10);
  if (settings.requireCompany) add('company_missing', 'Buying company associated', deal.companyCount > 0, 'warning', 7);
  if (settings.requireContact) add('contact_missing', 'Stakeholder associated', deal.contactCount > 0, 'warning', 10);
  for (const rule of settings.customRequiredProperties) {
    if (rule.stageIds.length > 0 && !rule.stageIds.includes(deal.properties.dealstage ?? '')) continue;
    add(`custom_${rule.property}`, rule.label, present(deal.properties[rule.property]), rule.severity, rule.weight);
  }
  // A requirement can fail for a richer reason (for example an overdue close date).
  // Preserve the requirement as satisfied when the field exists; the richer risk remains in contributors.
  return rows.map((row) => ({ ...row, severity: issueByCode.get(row.code)?.severity ?? row.severity }));
}

function actionText(issue: AssessmentIssue): string {
  switch (issue.code) {
    case 'owner_missing': return 'Assign a responsible deal owner.';
    case 'amount_missing': return 'Enter the expected deal value.';
    case 'close_date_missing': return 'Set an expected close date.';
    case 'close_date_overdue': return 'Update the close date or resolve the deal.';
    case 'next_step_missing': return 'Record the next committed sales action.';
    case 'company_missing': return 'Associate the buying company.';
    case 'contact_missing': return 'Associate at least one stakeholder.';
    case 'stale_activity': return 'Re-engage the opportunity and record the next sales activity.';
    case 'stage_age_exceeded': return 'Review why the deal is stalled and either progress, requalify, or close it.';
    default: return issue.description;
  }
}

export function buildDealIntelligence(
  deal: NormalizedDeal,
  settings: RuleSettings,
  assessment: DealAssessment,
  previous: DealHistorySnapshot | null,
): DealIntelligence {
  const contributors = assessment.issues
    .map((item) => ({ ...item, impact: item.weight }))
    .sort((a, b) => b.impact - a.impact || (a.severity === 'critical' ? -1 : 1));
  const criticalLost = contributors.filter((item) => item.severity === 'critical').reduce((sum, item) => sum + item.impact, 0);
  const requirements = requirementRows(deal, settings, assessment);
  const satisfied = requirements.filter((item) => item.satisfied).length;
  const currentCodes = new Set(assessment.issues.map((item) => item.code));
  const previousCodes = new Set(previous?.issueCodes ?? []);
  return {
    risk: {
      lostPoints: contributors.reduce((sum, item) => sum + item.impact, 0),
      potentialScore: Math.min(100, assessment.score + contributors.reduce((sum, item) => sum + item.impact, 0)),
      afterCriticalFixes: Math.min(100, assessment.score + criticalLost),
      contributors,
    },
    nextBestActions: contributors.slice(0, 5).map((item) => ({
      code: item.code,
      label: item.label,
      action: actionText(item),
      impact: item.impact,
      severity: item.severity,
      ...(item.property ? { property: item.property } : {}),
    })),
    stageReadiness: {
      stageId: deal.properties.dealstage ?? null,
      stageLabel: assessment.stageLabel,
      satisfied,
      total: requirements.length,
      percent: requirements.length ? Math.round((satisfied / requirements.length) * 100) : 100,
      blockers: contributors.filter((item) => requirements.some((row) => row.code === item.code && !row.satisfied)).map((item) => ({ code: item.code, label: item.label, severity: item.severity, impact: item.impact })),
      requirements,
    },
    change: {
      previousAssessedAt: previous?.assessedAt ?? null,
      scoreDelta: previous ? assessment.score - previous.score : null,
      gradeChanged: previous ? assessment.grade !== previous.grade : false,
      statusChanged: previous ? assessment.status !== previous.status : false,
      newIssueCodes: [...currentCodes].filter((code) => !previousCodes.has(code)),
      resolvedIssueCodes: [...previousCodes].filter((code) => !currentCodes.has(code)),
      amountDelta: previous && assessment.dealAmount !== null && assessment.dealAmount !== undefined && previous.dealAmount !== null ? assessment.dealAmount - previous.dealAmount : null,
      stageAgeDeltaDays: null,
      stageChanged: previous ? assessment.stageLabel !== previous.stageLabel : false,
    },
  };
}

export async function previousDealHistory(env: Env, portalId: string, dealId: string, currentAssessedAt: string): Promise<DealHistorySnapshot | null> {
  const row = await env.DB.prepare(
    `SELECT score, grade, status, issue_codes_json, deal_amount, stage_age_days, stage_label, assessed_at
     FROM assessment_history
     WHERE portal_id = ? AND deal_id = ? AND assessed_at < ?
     ORDER BY assessed_at DESC LIMIT 1`,
  ).bind(portalId, dealId, currentAssessedAt).first<Record<string, unknown>>();
  if (!row) return null;
  return {
    score: Number(row.score),
    grade: row.grade as DealAssessment['grade'],
    status: row.status as DealAssessment['status'],
    issueCodes: JSON.parse(String(row.issue_codes_json ?? '[]')) as string[],
    dealAmount: row.deal_amount === null || row.deal_amount === undefined ? null : Number(row.deal_amount),
    stageAgeDays: row.stage_age_days === null || row.stage_age_days === undefined ? null : Number(row.stage_age_days),
    stageLabel: String(row.stage_label ?? ''),
    assessedAt: String(row.assessed_at),
  };
}
