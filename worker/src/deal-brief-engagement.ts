import type { DealBrief, DealBriefIntelligence, DealBriefItem } from './deal-brief-types.js';
import type { DecisionAction } from './deal-momentum-types.js';
import type { EngagementMetadataIntelligence } from './engagement-metadata-types.js';
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

function engagementItems(
  engagement: EngagementMetadataIntelligence | null,
): { risks: DealBriefItem[]; positives: DealBriefItem[] } {
  if (!engagement) return { risks: [], positives: [] };
  const risks: DealBriefItem[] = [];
  const positives: DealBriefItem[] = [];
  for (const signal of engagement.engagement.signals) {
    if (signal.direction === 'neutral') continue;
    const item: DealBriefItem = {
      code: `engagement_${signal.code}`,
      label: signal.label,
      dimension: 'engagement',
      direction: signal.direction,
      severity: signal.severity,
      detail: signal.detail,
      observedAt: signal.observedAt,
      evidenceCodes: signal.evidenceCodes,
    };
    if (signal.direction === 'positive') positives.push(item);
    else risks.push(item);
  }
  if (engagement.engagement.status === 'active') {
    positives.push({
      code: 'engagement_active',
      label: 'Engagement metadata is active',
      dimension: 'engagement',
      direction: 'positive',
      severity: 'info',
      detail: engagement.engagement.summary,
      observedAt: engagement.engagement.lastBuyerActivityAt ?? engagement.engagement.fetchedAt,
      evidenceCodes: ['engagement_score'],
    });
  }
  return { risks, positives };
}

function coverage(
  current: DealBrief['coverage'],
  engagement: EngagementMetadataIntelligence | null,
): DealBrief['coverage'] {
  const engagementAvailable = Boolean(engagement);
  const engagementContribution = engagement
    ? Math.round(20 * engagement.engagement.coverage.percent / 100)
    : 0;
  const percent = Math.round(clamp(current.percent * .8 + engagementContribution));
  const missing: DealBrief['coverage']['missingDimensions'] = current.missingDimensions.filter((item) => item !== 'engagement');
  if (!engagementAvailable) missing.push('engagement');
  return {
    ...current,
    engagement: engagementAvailable,
    percent,
    missingDimensions: [...new Set(missing)],
    truncated: current.truncated || Boolean(engagement?.engagement.coverage.truncated),
  };
}

function attention(current: number, engagement: EngagementMetadataIntelligence | null): number {
  let contribution = 5;
  if (engagement?.engagement.score !== null && engagement?.engagement.score !== undefined) {
    contribution = (100 - clamp(engagement.engagement.score)) * .2;
  } else if (engagement?.engagement.status === 'disengaged') contribution = 20;
  else if (engagement?.engagement.status === 'watch') contribution = 10;
  return Math.round(clamp(current * .8 + contribution));
}

function status(
  current: DealBrief['status'],
  engagement: EngagementMetadataIntelligence | null,
  coveragePercent: number,
  attentionScore: number,
  actions: DecisionAction[],
): DealBrief['status'] {
  if (current === 'intervention_required') return current;
  const highEngagementAction = actions.some((item) => item.priority === 'high' && engagement?.engagementActions.some((candidate) => candidate.code === item.code));
  if (engagement?.engagement.status === 'disengaged' && (attentionScore >= 50 || highEngagementAction)) return 'intervention_required';
  if (coveragePercent < 60) return 'insufficient_evidence';
  if (current === 'watch' || engagement?.engagement.status === 'watch' || engagement?.engagement.status === 'insufficient_data' || !engagement) return 'watch';
  return current;
}

function confidence(
  current: DealBrief['confidence'],
  engagement: EngagementMetadataIntelligence | null,
  coveragePercent: number,
  truncated: boolean,
  freshness: DealBrief['freshness']['status'],
): DealBrief['confidence'] {
  if (coveragePercent < 60 || freshness === 'stale' || freshness === 'unavailable') return 'low';
  if (!engagement || engagement.engagement.confidence === 'low' || truncated) return current === 'low' ? 'low' : 'medium';
  if (coveragePercent >= 85 && current === 'high' && engagement.engagement.confidence === 'high') return 'high';
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
    return `Only ${coveragePercent}% of the Deal Brief evidence model is available. Refresh the record and verify structured CRM and activity metadata before relying on the brief.`;
  }
  return current;
}

export function augmentDealBriefWithEngagement(
  base: DealBriefIntelligence,
  engagement: EngagementMetadataIntelligence | null,
  decisionActions: DecisionAction[],
): DealBriefIntelligence {
  const items = engagementItems(engagement);
  const current = base.dealBrief;
  const nextAction = decisionActions[0] ?? current.nextAction;
  const nextCoverage = coverage(current.coverage, engagement);
  const nextAttention = attention(current.attentionScore, engagement);
  const nextStatus = status(current.status, engagement, nextCoverage.percent, nextAttention, decisionActions);
  const risks = uniqueSorted([...current.risks, ...items.risks], 8);
  const positives = uniqueSorted([...current.positiveSignals, ...items.positives], 10);
  const limitations = [
    ...current.limitations,
    'Engagement intelligence uses activity metadata only; email subjects, bodies, headers, addresses, meeting descriptions, notes, and call recordings are excluded.',
    ...(engagement?.engagement.limitations ?? []),
  ];
  return {
    dealBrief: {
      ...current,
      status: nextStatus,
      attentionScore: nextAttention,
      confidence: confidence(current.confidence, engagement, nextCoverage.percent, nextCoverage.truncated, current.freshness.status),
      summary: summary(current.summary, nextStatus, risks, positives, nextAction, nextCoverage.percent),
      risks,
      positiveSignals: positives,
      nextAction,
      coverage: nextCoverage,
      limitations: [...new Set(limitations)].slice(0, 12),
    },
  };
}
