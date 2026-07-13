import type { AssessmentIssue, DealAssessment, NormalizedDeal, RuleSettings } from './types.js';

function blank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim() === '';
}

function timestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function daysSince(value: string | null | undefined, now: number): number | null {
  const parsed = timestamp(value);
  return parsed === null ? null : Math.max(0, (now - parsed) / 86_400_000);
}

function issue(
  issues: AssessmentIssue[],
  code: string,
  label: string,
  description: string,
  severity: AssessmentIssue['severity'],
  weight: number,
  property?: string,
): void {
  issues.push({ code, label, description, severity, weight, ...(property ? { property } : {}) });
}

function grade(score: number): DealAssessment['grade'] {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

export function assessDeal(deal: NormalizedDeal, settings: RuleSettings, now = Date.now()): DealAssessment {
  const properties = deal.properties;
  const issues: AssessmentIssue[] = [];
  const stage = deal.stage;
  const dealName = properties.dealname?.trim() || `Deal ${deal.id}`;
  const pipelineLabel = stage?.pipelineLabel ?? properties.pipeline ?? 'Unknown pipeline';
  const stageLabel = stage?.label ?? properties.dealstage ?? 'Unknown stage';
  const isClosed = stage?.isClosed ?? false;
  const isWon = stage?.isWon ?? false;

  if (settings.excludedPipelineIds.includes(properties.pipeline ?? '') || settings.excludedStageIds.includes(properties.dealstage ?? '')) {
    return {
      dealId: deal.id,
      dealName,
      pipelineLabel,
      stageLabel,
      score: 100,
      grade: 'A',
      status: 'ready',
      issues: [],
      readinessSummary: 'This deal is excluded from DealGuard scoring.',
      isClosed,
      isWon,
      handoffEligible: isWon,
      assessedAt: new Date(now).toISOString(),
    };
  }

  if (isClosed && !isWon) {
    return {
      dealId: deal.id,
      dealName,
      pipelineLabel,
      stageLabel,
      score: 100,
      grade: 'A',
      status: 'ready',
      issues: [],
      readinessSummary: 'Closed-lost deals are excluded from active pipeline readiness scoring.',
      isClosed,
      isWon,
      handoffEligible: false,
      assessedAt: new Date(now).toISOString(),
    };
  }

  if (settings.requireOwner && blank(properties.hubspot_owner_id)) {
    issue(issues, 'owner_missing', 'Deal owner missing', 'Assign a responsible deal owner.', 'critical', 12, 'hubspot_owner_id');
  }
  if (settings.requireAmount && blank(properties.amount)) {
    issue(issues, 'amount_missing', 'Deal amount missing', 'Enter the expected deal value.', 'warning', 8, 'amount');
  }
  if (settings.requireCloseDate && blank(properties.closedate)) {
    issue(issues, 'close_date_missing', 'Close date missing', 'Set an expected close date.', 'critical', 10, 'closedate');
  } else if (!isClosed) {
    const closeAt = timestamp(properties.closedate);
    if (closeAt !== null && closeAt < now - 86_400_000) {
      issue(issues, 'close_date_overdue', 'Close date is overdue', 'Update the close date or resolve the deal.', 'critical', 18, 'closedate');
    }
  }
  if (!isClosed && settings.requireNextStep && blank(properties.hs_next_step)) {
    issue(issues, 'next_step_missing', 'Next step missing', 'Record the next committed sales action.', 'warning', 10, 'hs_next_step');
  }
  if (settings.requireCompany && deal.companyCount === 0) {
    issue(issues, 'company_missing', 'Company association missing', 'Associate the buying company with this deal.', 'warning', 7);
  }
  if (settings.requireContact && deal.contactCount === 0) {
    issue(issues, 'contact_missing', 'Contact association missing', 'Associate at least one stakeholder with this deal.', 'warning', 10);
  }

  if (!isClosed) {
    const activityAge = daysSince(properties.hs_last_sales_activity_timestamp ?? properties.hs_lastmodifieddate, now);
    if (activityAge === null || activityAge > settings.staleDays) {
      const ageLabel = activityAge === null ? 'No sales activity is recorded.' : `No sales activity in ${Math.floor(activityAge)} days.`;
      issue(issues, 'stale_activity', 'Deal is stale', ageLabel, activityAge !== null && activityAge > settings.staleDays * 2 ? 'critical' : 'warning', 15);
    }

    const stageEnteredProperty = stage?.enteredAtProperty;
    const stageAge = stageEnteredProperty ? daysSince(properties[stageEnteredProperty], now) : null;
    if (stageAge !== null && stageAge > settings.maxStageAgeDays) {
      issue(
        issues,
        'stage_age_exceeded',
        'Deal is ageing in stage',
        `This deal has remained in ${stage?.label ?? 'its current stage'} for ${Math.floor(stageAge)} days.`,
        stageAge > settings.maxStageAgeDays * 2 ? 'critical' : 'warning',
        15,
        stageEnteredProperty,
      );
    }
  }

  for (const rule of settings.customRequiredProperties) {
    if (rule.stageIds.length > 0 && !rule.stageIds.includes(properties.dealstage ?? '')) continue;
    if (blank(properties[rule.property])) {
      issue(
        issues,
        `custom_${rule.property}`,
        `${rule.label} missing`,
        `Complete the required ${rule.label.toLowerCase()} field.`,
        rule.severity,
        rule.weight,
        rule.property,
      );
    }
  }

  const score = Math.max(0, 100 - issues.reduce((sum, item) => sum + item.weight, 0));
  const criticalCount = issues.filter((item) => item.severity === 'critical').length;
  const status = criticalCount > 0 || score < 50 ? 'critical' : score < 75 ? 'at_risk' : 'ready';
  const summary = issues.length === 0
    ? 'No readiness gaps were detected.'
    : `${issues.length} readiness gap${issues.length === 1 ? '' : 's'} detected, including ${criticalCount} critical issue${criticalCount === 1 ? '' : 's'}.`;

  return {
    dealId: deal.id,
    dealName,
    pipelineLabel,
    stageLabel,
    score,
    grade: grade(score),
    status,
    issues: issues.sort((a, b) => {
      const severityOrder = { critical: 0, warning: 1, info: 2 } as const;
      return severityOrder[a.severity] - severityOrder[b.severity] || b.weight - a.weight;
    }),
    readinessSummary: summary,
    isClosed,
    isWon,
    handoffEligible: isWon,
    assessedAt: new Date(now).toISOString(),
  };
}
