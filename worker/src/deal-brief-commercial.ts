import type { CommercialIntegrityIntelligence } from './commercial-integrity-types.js';
import type { DealBrief, DealBriefIntelligence, DealBriefItem } from './deal-brief-types.js';
import type { DecisionAction } from './deal-momentum-types.js';
import type { IssueSeverity } from './types.js';

const SEVERITY_ORDER: Record<IssueSeverity, number> = { critical: 0, warning: 1, info: 2 };

function clamp(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function uniqueSorted(items: DealBriefItem[], maximum: number): DealBriefItem[] {
  const seen = new Set<string>();
  return items
    .filter((item) => {
      if (seen.has(item.code)) return false;
      seen.add(item.code);
      return true;
    })
    .sort((left, right) => {
      const severity = SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity];
      if (severity !== 0) return severity;
      const leftTime = left.observedAt ? Date.parse(left.observedAt) : 0;
      const rightTime = right.observedAt ? Date.parse(right.observedAt) : 0;
      return rightTime - leftTime;
    })
    .slice(0, maximum);
}

function commercialItems(
  commercial: CommercialIntegrityIntelligence | null,
): { risks: DealBriefItem[]; positives: DealBriefItem[] } {
  if (!commercial) return { risks: [], positives: [] };
  const risks: DealBriefItem[] = [];
  const positives: DealBriefItem[] = [];
  for (const signal of commercial.commercialIntegrity.signals) {
    if (signal.direction === 'neutral') continue;
    const item: DealBriefItem = {
      code: `commercial_${signal.code}`,
      label: signal.label,
      dimension: 'commercial',
      direction: signal.direction,
      severity: signal.severity,
      detail: signal.detail,
      observedAt: signal.observedAt,
      evidenceCodes: signal.evidenceCodes,
    };
    if (signal.direction === 'positive') positives.push(item);
    else risks.push(item);
  }
  if (commercial.commercialIntegrity.status === 'ready') {
    positives.push({
      code: 'commercial_integrity_ready',
      label: 'Commercial metadata is ready',
      dimension: 'commercial',
      direction: 'positive',
      severity: 'info',
      detail: commercial.commercialIntegrity.summary,
      observedAt: commercial.commercialIntegrity.fetchedAt,
      evidenceCodes: ['commercial_integrity_score'],
    });
  }
  return { risks, positives };
}

function coverage(
  current: DealBrief['coverage'],
  commercial: CommercialIntegrityIntelligence | null,
): DealBrief['coverage'] {
  const available = Boolean(
    commercial
    && commercial.commercialIntegrity.authorization.status !== 'required'
    && commercial.commercialIntegrity.status !== 'unavailable',
  );
  const contribution = available
    ? Math.round(20 * commercial!.commercialIntegrity.coverage.percent / 100)
    : 0;
  const percent = Math.round(clamp(current.percent * .8 + contribution));
  const missing = current.missingDimensions.filter((item) => item !== 'commercial');
  if (!available) missing.push('commercial');
  return {
    ...current,
    commercial: available,
    percent,
    missingDimensions: [...new Set(missing)],
    truncated: current.truncated || Boolean(commercial?.commercialIntegrity.coverage.truncated),
  };
}

function attention(current: number, commercial: CommercialIntegrityIntelligence | null): number {
  if (
    !commercial
    || commercial.commercialIntegrity.authorization.status === 'required'
    || commercial.commercialIntegrity.status === 'unavailable'
  ) return current;
  let contribution = 5;
  if (commercial.commercialIntegrity.score !== null) {
    contribution = (100 - clamp(commercial.commercialIntegrity.score)) * .2;
  } else if (commercial.commercialIntegrity.status === 'weak') contribution = 20;
  else if (commercial.commercialIntegrity.status === 'watch') contribution = 10;
  return Math.round(clamp(current * .8 + contribution));
}

function status(
  current: DealBrief['status'],
  commercial: CommercialIntegrityIntelligence | null,
  coveragePercent: number,
  attentionScore: number,
  actions: DecisionAction[],
): DealBrief['status'] {
  if (current === 'intervention_required') return current;
  const highCommercialAction = actions.some(
    (item) => item.priority === 'high'
      && commercial?.commercialActions.some((candidate) => candidate.code === item.code),
  );
  if (commercial?.commercialIntegrity.status === 'weak' && (attentionScore >= 50 || highCommercialAction)) {
    return 'intervention_required';
  }
  if (coveragePercent < 60) return 'insufficient_evidence';
  if (current === 'watch' || commercial?.commercialIntegrity.status === 'watch') return 'watch';
  return current;
}

function confidence(
  current: DealBrief['confidence'],
  commercial: CommercialIntegrityIntelligence | null,
  coveragePercent: number,
  truncated: boolean,
  freshness: DealBrief['freshness']['status'],
): DealBrief['confidence'] {
  if (coveragePercent < 60 || freshness === 'stale' || freshness === 'unavailable') return 'low';
  const authorized = Boolean(
    commercial
    && commercial.commercialIntegrity.authorization.status !== 'required'
    && commercial.commercialIntegrity.status !== 'unavailable',
  );
  if (!authorized || commercial?.commercialIntegrity.confidence === 'low' || truncated) {
    return current === 'low' ? 'low' : 'medium';
  }
  if (coveragePercent >= 85 && current === 'high' && commercial?.commercialIntegrity.confidence === 'high') return 'high';
  return 'medium';
}

function summary(
  current: string,
  briefStatus: DealBrief['status'],
  risks: DealBriefItem[],
  positives: DealBriefItem[],
  nextAction: DecisionAction | null,
  coveragePercent: number,
): string {
  const risk = risks[0]?.label;
  const positive = positives[0]?.label;
  if (briefStatus === 'intervention_required') {
    return `Intervention is required${risk ? ` because ${risk.toLowerCase()}` : ''}.${nextAction ? ` Next: ${nextAction.action}` : ''}`;
  }
  if (briefStatus === 'watch') {
    return `This deal needs review${risk ? `: ${risk}` : ''}.${positive ? ` Positive evidence: ${positive}.` : ''}${nextAction ? ` Next: ${nextAction.action}` : ''}`;
  }
  if (briefStatus === 'insufficient_evidence') {
    return `Only ${coveragePercent}% of the Deal Brief evidence model is available. Refresh the record and verify structured CRM, relationship, activity, and commercial metadata before relying on the brief.`;
  }
  return current;
}

export function augmentDealBriefWithCommercialIntegrity(
  base: DealBriefIntelligence,
  commercial: CommercialIntegrityIntelligence | null,
  decisionActions: DecisionAction[],
): DealBriefIntelligence {
  const items = commercialItems(commercial);
  const current = base.dealBrief;
  const nextAction = decisionActions[0] ?? current.nextAction;
  const nextCoverage = coverage(current.coverage, commercial);
  const nextAttention = attention(current.attentionScore, commercial);
  const nextStatus = status(current.status, commercial, nextCoverage.percent, nextAttention, decisionActions);
  const risks = uniqueSorted([...current.risks, ...items.risks], 10);
  const positives = uniqueSorted([...current.positiveSignals, ...items.positives], 12);
  const limitations = [
    ...current.limitations,
    'Commercial integrity uses structured quote and line-item metadata only; proposal documents, terms text, payment details, attachments, and contract content are excluded.',
    ...(commercial?.commercialIntegrity.limitations ?? []),
  ];
  return {
    dealBrief: {
      ...current,
      status: nextStatus,
      attentionScore: nextAttention,
      confidence: confidence(
        current.confidence,
        commercial,
        nextCoverage.percent,
        nextCoverage.truncated,
        current.freshness.status,
      ),
      summary: summary(current.summary, nextStatus, risks, positives, nextAction, nextCoverage.percent),
      risks,
      positiveSignals: positives,
      nextAction,
      coverage: nextCoverage,
      limitations: [...new Set(limitations)].slice(0, 15),
    },
  };
}
