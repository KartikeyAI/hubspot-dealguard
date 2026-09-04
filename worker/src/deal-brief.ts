import type { BuyerCommitteeIntelligence } from './buyer-committee-types.js';
import type { DealBrief, DealBriefChange, DealBriefIntelligence, DealBriefItem } from './deal-brief-types.js';
import type { DealIntelligence } from './deal-intelligence.js';
import type { DealMomentumIntelligence, DecisionAction } from './deal-momentum-types.js';
import type { DealAssessment, IssueSeverity } from './types.js';

interface BuildDealBriefInput {
  assessment: DealAssessment;
  readiness: DealIntelligence;
  momentum: DealMomentumIntelligence | null;
  relationship: BuyerCommitteeIntelligence | null;
  decisionActions: DecisionAction[];
}

const SEVERITY_ORDER: Record<IssueSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

function clamp(value: number, minimum = 0, maximum = 100): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number, digits = 0): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function freshness(assessedAt: string, now: number): DealBrief['freshness'] {
  const parsed = Date.parse(assessedAt);
  if (!Number.isFinite(parsed)) {
    return { assessedAt, ageHours: null, status: 'unavailable' };
  }
  const ageHours = round(Math.max(0, now - parsed) / 3_600_000, 1);
  return {
    assessedAt,
    ageHours,
    status: ageHours <= 24 ? 'fresh' : ageHours <= 72 ? 'aging' : 'stale',
  };
}

function uniqueItems(items: DealBriefItem[]): DealBriefItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.code)) return false;
    seen.add(item.code);
    return true;
  });
}

function sortedRisks(items: DealBriefItem[]): DealBriefItem[] {
  return uniqueItems(items)
    .sort((left, right) => SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity])
    .slice(0, 6);
}

function sortedPositiveSignals(items: DealBriefItem[]): DealBriefItem[] {
  return uniqueItems(items)
    .sort((left, right) => {
      const leftTime = left.observedAt ? Date.parse(left.observedAt) : 0;
      const rightTime = right.observedAt ? Date.parse(right.observedAt) : 0;
      return rightTime - leftTime;
    })
    .slice(0, 10);
}

function readinessFallbackAction(
  readiness: DealIntelligence,
  assessedAt: string,
  now: number,
): DecisionAction | null {
  const item = readiness.nextBestActions[0];
  if (!item) return null;
  return {
    code: `readiness_${item.code}`,
    label: item.label,
    action: item.action,
    priority: item.severity === 'critical' ? 'high' : item.severity === 'warning' ? 'medium' : 'low',
    rationale: `This deterministic readiness fix can restore up to ${item.impact} readiness points.`,
    owner: 'deal_owner',
    dueAt: new Date(Math.max(now, Date.parse(assessedAt) || now) + 24 * 3_600_000).toISOString(),
    evidenceCodes: [item.code],
  };
}

function readinessEvidence(
  assessment: DealAssessment,
  readiness: DealIntelligence,
): { risks: DealBriefItem[]; positives: DealBriefItem[]; changes: DealBriefChange[] } {
  const risks: DealBriefItem[] = readiness.risk.contributors.map((item) => ({
    code: `readiness_${item.code}`,
    label: item.label,
    dimension: 'readiness',
    direction: 'negative',
    severity: item.severity,
    detail: `${item.description} Readiness impact: ${item.impact} points.`,
    observedAt: assessment.assessedAt,
    evidenceCodes: [item.code],
  }));
  const positives: DealBriefItem[] = [];
  if (assessment.status === 'ready') {
    positives.push({
      code: 'readiness_ready',
      label: 'Readiness checks satisfied',
      dimension: 'readiness',
      direction: 'positive',
      severity: 'info',
      detail: `The current deterministic readiness score is ${assessment.score}/100.`,
      observedAt: assessment.assessedAt,
      evidenceCodes: ['readiness_score'],
    });
  }
  if (readiness.stageReadiness.percent >= 80) {
    positives.push({
      code: 'stage_requirements_covered',
      label: 'Stage requirements are substantially covered',
      dimension: 'readiness',
      direction: 'positive',
      severity: 'info',
      detail: `${readiness.stageReadiness.satisfied} of ${readiness.stageReadiness.total} configured requirements are satisfied.`,
      observedAt: assessment.assessedAt,
      evidenceCodes: ['stage_readiness'],
    });
  }

  const changes: DealBriefChange[] = [];
  const change = readiness.change;
  if (change.scoreDelta !== null && change.scoreDelta !== 0) {
    changes.push({
      code: 'readiness_score_changed',
      label: 'Readiness score changed',
      detail: `Readiness moved ${change.scoreDelta > 0 ? 'up' : 'down'} ${Math.abs(change.scoreDelta)} points since the previous assessment.`,
      observedAt: assessment.assessedAt,
    });
    if (change.scoreDelta > 0) {
      positives.push({
        code: 'readiness_improved',
        label: 'Readiness improved',
        dimension: 'change',
        direction: 'positive',
        severity: 'info',
        detail: `Readiness improved by ${change.scoreDelta} points.`,
        observedAt: assessment.assessedAt,
        evidenceCodes: ['readiness_score_changed'],
      });
    }
  }
  if (change.stageChanged) {
    changes.push({
      code: 'stage_changed',
      label: 'Deal stage changed',
      detail: `The recorded stage is now ${assessment.stageLabel}.`,
      observedAt: assessment.assessedAt,
    });
  }
  if (change.amountDelta !== null && change.amountDelta !== 0) {
    changes.push({
      code: 'amount_changed',
      label: 'Deal amount changed',
      detail: `The recorded amount moved ${change.amountDelta > 0 ? 'up' : 'down'} by ${Math.abs(change.amountDelta)}.`,
      observedAt: assessment.assessedAt,
    });
  }
  if (change.newIssueCodes.length > 0) {
    changes.push({
      code: 'new_readiness_issues',
      label: 'New readiness issues detected',
      detail: `${change.newIssueCodes.length} issue${change.newIssueCodes.length === 1 ? '' : 's'} appeared since the previous assessment.`,
      observedAt: assessment.assessedAt,
    });
  }
  if (change.resolvedIssueCodes.length > 0) {
    changes.push({
      code: 'readiness_issues_resolved',
      label: 'Readiness issues resolved',
      detail: `${change.resolvedIssueCodes.length} issue${change.resolvedIssueCodes.length === 1 ? '' : 's'} was resolved since the previous assessment.`,
      observedAt: assessment.assessedAt,
    });
    positives.push({
      code: 'issues_resolved',
      label: 'Readiness issues were resolved',
      dimension: 'change',
      direction: 'positive',
      severity: 'info',
      detail: `${change.resolvedIssueCodes.length} previously detected issue${change.resolvedIssueCodes.length === 1 ? '' : 's'} no longer applies.`,
      observedAt: assessment.assessedAt,
      evidenceCodes: change.resolvedIssueCodes,
    });
  }
  return { risks, positives, changes };
}

function momentumEvidence(
  momentum: DealMomentumIntelligence | null,
): { risks: DealBriefItem[]; positives: DealBriefItem[]; changes: DealBriefChange[] } {
  if (!momentum) return { risks: [], positives: [], changes: [] };
  const risks: DealBriefItem[] = [];
  const positives: DealBriefItem[] = [];
  for (const signal of momentum.momentum.signals) {
    const item: DealBriefItem = {
      code: `momentum_${signal.code}`,
      label: signal.label,
      dimension: 'momentum',
      direction: signal.direction === 'positive' ? 'positive' : 'negative',
      severity: signal.severity,
      detail: signal.detail,
      observedAt: signal.observedAt,
      evidenceCodes: [signal.code],
    };
    if (signal.direction === 'positive') positives.push(item);
    else if (signal.direction === 'negative') risks.push(item);
  }
  for (const reason of momentum.closeDateCredibility.reasons) {
    risks.push({
      code: `close_date_${reason.code}`,
      label: reason.label,
      dimension: 'close_date',
      direction: 'negative',
      severity: reason.impact >= 20 ? 'critical' : 'warning',
      detail: reason.evidence,
      observedAt: momentum.closeDateCredibility.lastCloseDateChangeAt,
      evidenceCodes: [reason.code],
    });
  }
  if (momentum.momentum.band === 'strong') {
    positives.push({
      code: 'momentum_strong',
      label: 'CRM process momentum is strong',
      dimension: 'momentum',
      direction: 'positive',
      severity: 'info',
      detail: momentum.momentum.summary,
      observedAt: momentum.momentum.lastMaterialChangeAt,
      evidenceCodes: ['momentum_score'],
    });
  }
  if (momentum.closeDateCredibility.status === 'credible') {
    positives.push({
      code: 'close_date_credible',
      label: 'Close date is operationally credible',
      dimension: 'close_date',
      direction: 'positive',
      severity: 'info',
      detail: momentum.closeDateCredibility.summary,
      observedAt: momentum.closeDateCredibility.lastCloseDateChangeAt,
      evidenceCodes: ['close_date_credibility'],
    });
  }

  const event = momentum.momentum.events;
  const changes: DealBriefChange[] = [];
  if (event.stageAdvances + event.stageRegressions > 0) {
    changes.push({
      code: 'stage_movement_90d',
      label: 'Stage movement recorded',
      detail: `${event.stageAdvances} forward and ${event.stageRegressions} backward stage movement${event.stageAdvances + event.stageRegressions === 1 ? '' : 's'} in 90 days.`,
      observedAt: momentum.momentum.lastMaterialChangeAt,
    });
  }
  if (event.closeDatePushes + event.closeDatePullIns > 0) {
    changes.push({
      code: 'close_date_movement_90d',
      label: 'Close date moved',
      detail: `${event.closeDatePushes} push${event.closeDatePushes === 1 ? '' : 'es'} and ${event.closeDatePullIns} pull-in${event.closeDatePullIns === 1 ? '' : 's'} in 90 days.`,
      observedAt: momentum.closeDateCredibility.lastCloseDateChangeAt,
    });
  }
  if (event.ownerChanges > 0) {
    changes.push({
      code: 'owner_movement_90d',
      label: 'Ownership changed',
      detail: `The deal owner changed ${event.ownerChanges} time${event.ownerChanges === 1 ? '' : 's'} in 90 days.`,
      observedAt: momentum.momentum.lastMaterialChangeAt,
    });
  }
  if (event.nextStepChanges > 0) {
    changes.push({
      code: 'next_step_movement_90d',
      label: 'Next step changed',
      detail: `The recorded next step changed ${event.nextStepChanges} time${event.nextStepChanges === 1 ? '' : 's'} in 90 days.`,
      observedAt: momentum.momentum.lastMaterialChangeAt,
    });
  }
  return { risks, positives, changes };
}

function relationshipEvidence(
  relationship: BuyerCommitteeIntelligence | null,
): { risks: DealBriefItem[]; positives: DealBriefItem[] } {
  if (!relationship) return { risks: [], positives: [] };
  const risks: DealBriefItem[] = [];
  const positives: DealBriefItem[] = [];
  for (const signal of relationship.relationshipCoverage.signals) {
    const item: DealBriefItem = {
      code: `relationship_${signal.code}`,
      label: signal.label,
      dimension: 'relationship',
      direction: signal.direction === 'positive' ? 'positive' : 'negative',
      severity: signal.severity,
      detail: signal.detail,
      observedAt: relationship.relationshipCoverage.fetchedAt,
      evidenceCodes: signal.evidenceCodes,
    };
    if (signal.direction === 'positive') positives.push(item);
    else if (signal.direction === 'negative') risks.push(item);
  }
  if (relationship.relationshipCoverage.status === 'strong') {
    positives.push({
      code: 'relationship_strong',
      label: 'Core buying roles are explicitly covered',
      dimension: 'relationship',
      direction: 'positive',
      severity: 'info',
      detail: relationship.relationshipCoverage.summary,
      observedAt: relationship.relationshipCoverage.fetchedAt,
      evidenceCodes: ['relationship_coverage'],
    });
  }
  if (relationship.relationshipCoverage.primaryCompany) {
    positives.push({
      code: 'primary_company_identified',
      label: 'Primary buying company is identified',
      dimension: 'relationship',
      direction: 'positive',
      severity: 'info',
      detail: `${relationship.relationshipCoverage.primaryCompany.name} is identified as the primary company for this deal.`,
      observedAt: relationship.relationshipCoverage.fetchedAt,
      evidenceCodes: ['primary_company'],
    });
  }
  return { risks, positives };
}

function evidenceCoverage(
  momentum: DealMomentumIntelligence | null,
  relationship: BuyerCommitteeIntelligence | null,
): DealBrief['coverage'] {
  const momentumAvailable = Boolean(momentum);
  const closeDateAvailable = Boolean(momentum && momentum.closeDateCredibility.status !== 'unavailable');
  const relationshipAvailable = Boolean(relationship);
  const truncated = Boolean(
    relationship?.relationshipCoverage.contactsTruncated
    || relationship?.relationshipCoverage.companiesTruncated,
  );
  const momentumContribution = momentum
    ? Math.round(25 * clamp(momentum.momentum.evidenceCoveragePercent) / 100)
    : 0;
  const relationshipContribution = relationship ? (truncated ? 15 : 20) : 0;
  const percent = clamp(40 + momentumContribution + (closeDateAvailable ? 15 : 0) + relationshipContribution);
  const missingDimensions: DealBrief['coverage']['missingDimensions'] = [];
  if (!momentumAvailable) missingDimensions.push('momentum');
  if (!closeDateAvailable) missingDimensions.push('close_date');
  if (!relationshipAvailable) missingDimensions.push('relationship');
  return {
    readiness: true,
    momentum: momentumAvailable,
    closeDate: closeDateAvailable,
    relationship: relationshipAvailable,
    percent,
    missingDimensions,
    truncated,
  };
}

function attentionScore(
  assessment: DealAssessment,
  momentum: DealMomentumIntelligence | null,
  relationship: BuyerCommitteeIntelligence | null,
  freshnessState: DealBrief['freshness'],
): number {
  let score = (100 - clamp(assessment.score)) * .45;
  if (momentum?.momentum.score !== null && momentum?.momentum.score !== undefined) {
    score += (100 - clamp(momentum.momentum.score)) * .2;
  } else if (momentum?.momentum.band === 'stalled') score += 20;
  else if (momentum?.momentum.band === 'watch') score += 10;
  else if (!momentum) score += 5;

  if (momentum?.closeDateCredibility.score !== null && momentum?.closeDateCredibility.score !== undefined) {
    score += (100 - clamp(momentum.closeDateCredibility.score)) * .2;
  } else if (momentum?.closeDateCredibility.status === 'weak') score += 20;
  else if (momentum?.closeDateCredibility.status === 'watch') score += 10;
  else if (!momentum) score += 5;

  if (relationship) score += (100 - clamp(relationship.relationshipCoverage.score)) * .15;
  else score += 5;
  if (assessment.status === 'critical') score += 8;
  else if (assessment.status === 'at_risk') score += 4;
  if (freshnessState.status === 'stale') score += 5;
  return Math.round(clamp(score));
}

function confidence(
  coverage: DealBrief['coverage'],
  freshnessState: DealBrief['freshness'],
  momentum: DealMomentumIntelligence | null,
  relationship: BuyerCommitteeIntelligence | null,
): DealBrief['confidence'] {
  const lowQualityMomentum = Boolean(momentum && momentum.momentum.evidenceCoveragePercent < 40);
  const lowQualityRelationship = relationship?.relationshipCoverage.confidence === 'low';
  if (
    coverage.percent >= 85
    && !coverage.truncated
    && freshnessState.status !== 'stale'
    && freshnessState.status !== 'unavailable'
    && !lowQualityMomentum
    && !lowQualityRelationship
  ) return 'high';
  if (coverage.percent >= 60 && freshnessState.status !== 'stale' && freshnessState.status !== 'unavailable') return 'medium';
  return 'low';
}

function briefStatus(
  assessment: DealAssessment,
  momentum: DealMomentumIntelligence | null,
  relationship: BuyerCommitteeIntelligence | null,
  actions: DecisionAction[],
  coverage: DealBrief['coverage'],
  score: number,
): DealBrief['status'] {
  const highPriorityAction = actions.some((item) => item.priority === 'high');
  const severeProcessSignal = momentum?.momentum.band === 'stalled'
    || momentum?.closeDateCredibility.status === 'weak';
  if (assessment.status === 'critical' || severeProcessSignal || (highPriorityAction && score >= 55)) {
    return 'intervention_required';
  }
  if (coverage.percent < 60) return 'insufficient_evidence';
  const relationshipNeedsReview = relationship?.relationshipCoverage.status !== 'strong';
  if (
    assessment.status === 'at_risk'
    || momentum?.momentum.band === 'watch'
    || momentum?.momentum.band === 'insufficient_data'
    || momentum?.closeDateCredibility.status === 'watch'
    || relationshipNeedsReview
    || score >= 35
  ) return 'watch';
  return 'on_track';
}

function summary(
  status: DealBrief['status'],
  assessment: DealAssessment,
  risks: DealBriefItem[],
  positives: DealBriefItem[],
  nextAction: DecisionAction | null,
  coverage: DealBrief['coverage'],
): string {
  const risk = risks[0]?.label;
  const positive = positives[0]?.label;
  const action = nextAction?.action;
  if (status === 'intervention_required') {
    return `Intervention is required${risk ? ` because ${risk.toLowerCase()}` : ''}.${action ? ` Next: ${action}` : ''}`;
  }
  if (status === 'watch') {
    return `This deal needs review${risk ? `: ${risk}` : ''}.${positive ? ` Positive evidence: ${positive}.` : ''}${action ? ` Next: ${action}` : ''}`;
  }
  if (status === 'insufficient_evidence') {
    return `The current readiness score is ${assessment.score}/100, but only ${coverage.percent}% of the Deal Brief evidence model is available. Refresh the record and complete structured CRM evidence before relying on the brief.`;
  }
  return `The deal is operationally on track across the available deterministic evidence.${positive ? ` Strongest positive: ${positive}.` : ''}${action ? ` Continue with: ${action}` : ''}`;
}

function limitations(
  coverage: DealBrief['coverage'],
  freshnessState: DealBrief['freshness'],
  momentum: DealMomentumIntelligence | null,
  relationship: BuyerCommitteeIntelligence | null,
): string[] {
  const result = [
    'The Deal Brief synthesises structured CRM evidence; it does not analyse communication content.',
    'Attention priority is deterministic prioritisation, not a win probability or expected-loss estimate.',
  ];
  if (coverage.missingDimensions.length > 0) {
    result.push(`Unavailable evidence dimensions: ${coverage.missingDimensions.join(', ').replaceAll('_', ' ')}.`);
  }
  if (coverage.truncated) result.push('Relationship evidence is truncated because the deal exceeds bounded on-demand association limits.');
  if (freshnessState.status === 'stale') result.push('The current readiness assessment is more than 72 hours old.');
  if (momentum?.momentum.limitations) result.push(momentum.momentum.limitations);
  for (const item of relationship?.relationshipCoverage.limitations ?? []) result.push(item);
  return [...new Set(result)].slice(0, 8);
}

export function buildDealBrief(
  input: BuildDealBriefInput,
  now = Date.now(),
): DealBriefIntelligence {
  const { assessment, readiness, momentum, relationship, decisionActions } = input;
  const readinessItems = readinessEvidence(assessment, readiness);
  const momentumItems = momentumEvidence(momentum);
  const relationshipItems = relationshipEvidence(relationship);
  const risks = sortedRisks([
    ...readinessItems.risks,
    ...momentumItems.risks,
    ...relationshipItems.risks,
  ]);
  const positiveSignals = sortedPositiveSignals([
    ...readinessItems.positives,
    ...momentumItems.positives,
    ...relationshipItems.positives,
  ]);
  const changes = [...readinessItems.changes, ...momentumItems.changes].slice(0, 6);
  const nextAction = decisionActions[0] ?? readinessFallbackAction(readiness, assessment.assessedAt, now);
  const coverage = evidenceCoverage(momentum, relationship);
  const freshnessState = freshness(assessment.assessedAt, now);
  const attention = attentionScore(assessment, momentum, relationship, freshnessState);
  const status = briefStatus(assessment, momentum, relationship, decisionActions, coverage, attention);
  return {
    dealBrief: {
      methodology: 'deterministic_evidence_synthesis',
      generatedAt: new Date(now).toISOString(),
      status,
      attentionScore: attention,
      confidence: confidence(coverage, freshnessState, momentum, relationship),
      summary: summary(status, assessment, risks, positiveSignals, nextAction, coverage),
      risks,
      positiveSignals,
      changes,
      nextAction,
      coverage,
      freshness: freshnessState,
      limitations: limitations(coverage, freshnessState, momentum, relationship),
      notWinProbability: true,
      notBuyerIntent: true,
      notForecastCategory: true,
    },
  };
}
