import type { IssueSeverity } from './types.js';

export type ManagerDecisionBand = 'act_now' | 'review' | 'monitor';
export type DecisionEvidenceMode =
  | 'full_deal_brief'
  | 'aging_deal_brief'
  | 'stale_deal_brief'
  | 'readiness_only';
export type DecisionAmountBasis = 'company_currency' | 'deal_currency' | 'unavailable';

export interface DecisionQueueReason {
  code: string;
  label: string;
  severity: IssueSeverity;
  dimension: string;
}

export interface DecisionQueueAction {
  code: string;
  label: string;
  action: string;
  priority: 'high' | 'medium' | 'low';
  owner: 'deal_owner' | 'manager';
  dueAt: string | null;
  rationale: string;
  evidenceCodes: string[];
  source: 'deal_brief' | 'remediation' | 'readiness';
  overdue: boolean;
}

export interface DecisionQueueAmount {
  value: number | null;
  basis: DecisionAmountBasis;
  currencyCode: string | null;
  label: string;
  cohortPercentile: number | null;
  comparable: boolean;
}

export interface DecisionQueueItem {
  dealId: string;
  dealName: string;
  recordUrl: string;
  pipelineId: string | null;
  pipelineLabel: string | null;
  stageId: string | null;
  stageLabel: string | null;
  ownerId: string | null;
  teamId: string | null;
  regionCode: string | null;
  readinessScore: number;
  readinessStatus: 'ready' | 'at_risk' | 'critical';
  issueCount: number;
  stageAgeDays: number | null;
  assessedAt: string;
  priorityScore: number;
  band: ManagerDecisionBand;
  deterministicAttentionScore: number;
  actionUrgencyScore: number;
  commercialImportanceScore: number;
  evidenceReviewScore: number;
  evidenceMode: DecisionEvidenceMode;
  evidenceCoveragePercent: number;
  evidenceConfidence: 'high' | 'medium' | 'low';
  snapshotGeneratedAt: string | null;
  dealBriefStatus: 'on_track' | 'watch' | 'intervention_required' | 'insufficient_evidence' | null;
  amount: DecisionQueueAmount;
  nextAction: DecisionQueueAction | null;
  openRemediationCount: number;
  overdueRemediationCount: number;
  reasons: DecisionQueueReason[];
  dimensionStates: Record<string, unknown>;
  semantics: {
    priorityNotWinProbability: true;
    amountPercentileWithinComparableCurrencyCohort: true;
    missingEvidenceNotProofOfLoss: true;
  };
}

export interface DecisionQueueAmountCohort {
  basis: Exclude<DecisionAmountBasis, 'unavailable'>;
  currencyCode: string | null;
  label: string;
  deals: number;
  totalAmount: number;
}

export interface ManagerDecisionQueueResponse {
  generatedAt: string;
  methodology: 'deterministic_manager_decision_queue_v1';
  filters: Record<string, string | number | null>;
  summary: {
    totalOpenDeals: number;
    returnedDeals: number;
    actNow: number;
    review: number;
    monitor: number;
    overdueActions: number;
    fullDealBriefDeals: number;
    readinessOnlyDeals: number;
    staleDealBriefDeals: number;
    fullDealBriefCoveragePercent: number;
    amountComparableDeals: number;
  };
  amountCohorts: DecisionQueueAmountCohort[];
  items: DecisionQueueItem[];
  semantics: {
    currentState: 'latest_open_assessment_per_deal';
    priority: 'deterministic_management_priority_not_win_probability';
    amount: 'percentile_within_company_currency_or_same_deal_currency_cohort';
    evidence: 'current_record_enrichment_snapshot_when_available_else_readiness_fallback';
    actions: 'owned_due_dated_recommendation_or_remediation_fallback';
  };
}
