import type { DecisionAction } from './deal-momentum-types.js';
import type { IssueSeverity } from './types.js';

export type DealBriefDimension =
  | 'readiness'
  | 'momentum'
  | 'close_date'
  | 'relationship'
  | 'engagement'
  | 'commercial'
  | 'change';

export interface DealBriefItem {
  code: string;
  label: string;
  dimension: DealBriefDimension;
  direction: 'positive' | 'negative';
  severity: IssueSeverity;
  detail: string;
  observedAt: string | null;
  evidenceCodes: string[];
}

export interface DealBriefChange {
  code: string;
  label: string;
  detail: string;
  observedAt: string | null;
}

export interface DealBriefCoverage {
  readiness: true;
  momentum: boolean;
  closeDate: boolean;
  relationship: boolean;
  engagement?: boolean;
  commercial?: boolean;
  percent: number;
  missingDimensions: Array<'momentum' | 'close_date' | 'relationship' | 'engagement' | 'commercial'>;
  truncated: boolean;
}

export interface DealBriefFreshness {
  assessedAt: string;
  ageHours: number | null;
  status: 'fresh' | 'aging' | 'stale' | 'unavailable';
}

export interface DealBrief {
  methodology: 'deterministic_evidence_synthesis';
  generatedAt: string;
  status: 'on_track' | 'watch' | 'intervention_required' | 'insufficient_evidence';
  attentionScore: number;
  confidence: 'high' | 'medium' | 'low';
  summary: string;
  risks: DealBriefItem[];
  positiveSignals: DealBriefItem[];
  changes: DealBriefChange[];
  nextAction: DecisionAction | null;
  coverage: DealBriefCoverage;
  freshness: DealBriefFreshness;
  limitations: string[];
  notWinProbability: true;
  notBuyerIntent: true;
  notForecastCategory: true;
}

export interface DealBriefIntelligence {
  dealBrief: DealBrief;
}
