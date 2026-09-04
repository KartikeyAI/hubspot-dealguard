import type {
  ExecutiveCandidate,
  ExecutiveConfidence,
  ExecutiveReason,
  ExecutiveRevenuePeriod,
  ExecutiveRevenueResponse,
  MovementConfidence,
} from './executive-revenue-types.js';
import {
  clamp,
  FORECAST_LABELS,
  iso,
  percentage,
  timestamp,
  type WorkingExecutiveDeal,
} from './executive-revenue-model.js';

function addReason(
  reasons: ExecutiveReason[],
  code: string,
  label: string,
  severity: ExecutiveReason['severity'],
  dimension: ExecutiveReason['dimension'],
): void {
  if (!reasons.some((reason) => reason.code === code)) reasons.push({ code, label, severity, dimension });
}

function candidateAmount(item: WorkingExecutiveDeal): ExecutiveCandidate['amount'] {
  return {
    value: item.amount.value,
    basis: item.amount.basis,
    currencyCode: item.amount.currencyCode,
    label: item.amount.label,
    comparable: item.amount.comparable,
  };
}

function evidenceConfidence(item: WorkingExecutiveDeal): ExecutiveConfidence {
  if (item.current.decision.confidence) return item.current.decision.confidence;
  return item.current.assessmentAt && item.current.readinessScore !== null ? 'medium' : 'low';
}

export function slippageCandidate(item: WorkingExecutiveDeal): ExecutiveCandidate | null {
  const reasons: ExecutiveReason[] = [];
  let score = 0;
  if (item.overdue) {
    score += 40;
    addReason(reasons, 'overdue_close_date', 'Recorded close date is overdue while the deal remains open', 'critical', 'close_date');
  }
  if (item.periodExit) {
    score += 35;
    addReason(reasons, 'moved_out_of_period', 'Recorded close date moved out of the selected period', 'critical', 'close_date');
  }
  if ((item.closeDateDeltaDays ?? 0) >= 7) {
    score += Math.min(20, 8 + Math.round((item.closeDateDeltaDays ?? 0) / 7) * 3);
    addReason(reasons, 'close_date_pushed', `Recorded close date moved later by ${Math.round(item.closeDateDeltaDays ?? 0)} days`, 'warning', 'close_date');
  }
  if (item.forecastDowngraded) {
    score += 22;
    addReason(reasons, 'forecast_category_downgraded', 'Recorded forecast category moved to a lower category', 'warning', 'forecast_category');
  }
  if (reasons.length === 0) return null;
  if (item.current.readinessStatus === 'critical') {
    score += 18;
    addReason(reasons, 'critical_readiness', 'Deal readiness is critical', 'critical', 'readiness');
  } else if (item.current.readinessStatus === 'at_risk') {
    score += 8;
    addReason(reasons, 'readiness_at_risk', 'Deal readiness requires review', 'warning', 'readiness');
  }
  if (item.current.decision.status === 'intervention_required') {
    score += 15;
    addReason(reasons, 'deal_brief_intervention', 'Current Deal Brief requires intervention', 'critical', 'deal_brief');
  }
  score += Math.round((item.current.decision.attentionScore ?? 0) * .15);
  return {
    kind: 'slippage_review',
    dealId: item.current.dealId,
    dealName: item.current.dealName,
    recordUrl: item.current.recordUrl,
    pipelineLabel: item.current.pipelineLabel,
    stageLabel: item.current.stageLabel,
    ownerId: item.current.ownerId,
    priorityScore: Math.round(clamp(score)),
    readinessScore: item.current.readinessScore,
    readinessStatus: item.current.readinessStatus,
    attentionScore: item.current.decision.attentionScore,
    decisionStatus: item.current.decision.status,
    evidenceConfidence: evidenceConfidence(item),
    currentCloseDate: iso(item.current.closeDate),
    previousCloseDate: iso(item.previous?.closeDate),
    closeDateDeltaDays: item.closeDateDeltaDays,
    forecastCategory: item.forecast,
    previousForecastCategory: item.previousForecast,
    amount: candidateAmount(item),
    reasons: reasons.slice(0, 6),
  };
}

export function pullInCandidate(
  item: WorkingExecutiveDeal,
  period: ExecutiveRevenuePeriod,
  now: number,
): ExecutiveCandidate | null {
  if (item.closeDateMs === null) return null;
  const periodEnd = Date.parse(period.end);
  const horizonEnd = Date.parse(period.pullInHorizonEnd);
  if (item.closeDateMs <= periodEnd || item.closeDateMs > horizonEnd || item.closeDateMs < now) return null;
  if (item.current.readinessStatus === 'critical') return null;

  const readiness = item.current.readinessScore ?? 0;
  const attention = item.current.decision.attentionScore;
  const credibility = item.current.decision.closeDateCredibilityScore;
  const hasDecisionEvidence = item.current.decision.status !== null || attention !== null || credibility !== null;
  if (hasDecisionEvidence) {
    if (readiness < 75 || (attention !== null && attention > 55) || (credibility !== null && credibility < 60)) return null;
    if (item.current.decision.status === 'intervention_required') return null;
  } else if (readiness < 85) {
    return null;
  }
  const actionDueAt = timestamp(item.current.decision.nextActionDueAt);
  if (actionDueAt !== null && actionDueAt < now && item.current.decision.nextActionPriority === 'high') return null;

  const reasons: ExecutiveReason[] = [];
  addReason(reasons, 'near_period_boundary', 'Recorded close date falls within 30 days after the selected period', 'info', 'close_date');
  if (readiness >= 85) addReason(reasons, 'strong_readiness', 'Current deterministic readiness is strong', 'info', 'readiness');
  if (credibility !== null && credibility >= 70) {
    addReason(reasons, 'credible_close_plan', 'Close-date credibility evidence supports management review', 'info', 'deal_brief');
  }
  if (item.forecast === 'commit' || item.forecast === 'best_case') {
    addReason(reasons, 'recorded_forecast_support', `Recorded forecast category is ${FORECAST_LABELS[item.forecast]}`, 'info', 'forecast_category');
  }
  const score = Math.round(clamp(
    readiness * .45
    + (100 - (attention ?? 50)) * .25
    + (credibility ?? 50) * .25
    + (item.forecast === 'commit' ? 8 : item.forecast === 'best_case' ? 4 : 0),
  ));
  return {
    kind: 'pull_in_review',
    dealId: item.current.dealId,
    dealName: item.current.dealName,
    recordUrl: item.current.recordUrl,
    pipelineLabel: item.current.pipelineLabel,
    stageLabel: item.current.stageLabel,
    ownerId: item.current.ownerId,
    priorityScore: score,
    readinessScore: item.current.readinessScore,
    readinessStatus: item.current.readinessStatus,
    attentionScore: item.current.decision.attentionScore,
    decisionStatus: item.current.decision.status,
    evidenceConfidence: evidenceConfidence(item),
    currentCloseDate: iso(item.current.closeDate),
    previousCloseDate: iso(item.previous?.closeDate),
    closeDateDeltaDays: item.closeDateDeltaDays,
    forecastCategory: item.forecast,
    previousForecastCategory: item.previousForecast,
    amount: candidateAmount(item),
    reasons: reasons.slice(0, 6),
  };
}

export function executiveConfidence(
  items: WorkingExecutiveDeal[],
  comparisonDeals: number,
): ExecutiveRevenueResponse['confidence'] {
  const total = items.length;
  const comparisonPercent = percentage(comparisonDeals, total);
  const score = Math.round(
    percentage(items.filter((item) => item.current.amount !== null).length, total) * .10
    + percentage(items.filter((item) => item.amount.comparable).length, total) * .15
    + percentage(items.filter((item) => item.closeDateMs !== null).length, total) * .20
    + percentage(items.filter((item) => item.forecast !== 'unavailable').length, total) * .15
    + percentage(items.filter((item) => Boolean(item.current.ownerId)).length, total) * .10
    + percentage(items.filter((item) => item.current.readinessScore !== null && item.current.assessmentAt !== null).length, total) * .15
    + percentage(items.filter((item) => item.current.decision.status !== null).length, total) * .10
    + comparisonPercent * .05,
  );
  const movement: MovementConfidence = comparisonDeals === 0
    ? 'baseline_only'
    : comparisonPercent >= 60
      ? 'established'
      : 'directional';
  const level: ExecutiveConfidence = score >= 85 && movement !== 'baseline_only'
    ? 'high'
    : score >= 60
      ? 'medium'
      : 'low';
  const explanation = movement === 'baseline_only'
    ? 'Current-state evidence is available, but no earlier executive snapshot exists yet. This run establishes the movement baseline.'
    : level === 'high'
      ? 'Current-state and comparison evidence have strong coverage across amounts, close dates, ownership, assessments, and Deal Brief snapshots.'
      : level === 'medium'
        ? 'The view is directionally useful, but one or more evidence dimensions have incomplete coverage.'
        : 'Use the view cautiously because several current-state or comparison evidence dimensions are incomplete.';
  return { level, score, movement, explanation };
}
