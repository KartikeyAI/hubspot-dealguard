export type ExecutiveConfidence = 'high' | 'medium' | 'low';
export type MovementConfidence = 'established' | 'directional' | 'baseline_only';
export type ForecastCategory = 'commit' | 'best_case' | 'pipeline' | 'not_forecasted' | 'closed_won' | 'custom' | 'unavailable';
export type RevenueAmountBasis = 'company_currency' | 'deal_currency' | 'unavailable';

export interface ExecutiveRevenuePeriod {
  start: string;
  end: string;
  basis: 'calendar_quarter' | 'custom';
  pullInHorizonEnd: string;
}

export interface ExecutiveDecisionEvidence {
  status: 'on_track' | 'watch' | 'intervention_required' | 'insufficient_evidence' | null;
  attentionScore: number | null;
  confidence: ExecutiveConfidence | null;
  coveragePercent: number | null;
  generatedAt: string | null;
  closeDateCredibilityScore: number | null;
  closeDateCredibilityStatus: string | null;
  nextActionDueAt: string | null;
  nextActionPriority: 'high' | 'medium' | 'low' | null;
}

export interface ExecutiveRevenueDeal {
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
  amount: number | null;
  amountInCompanyCurrency: number | null;
  currencyCode: string | null;
  closeDate: string | null;
  forecastCategoryRaw: string | null;
  readinessScore: number | null;
  readinessStatus: 'ready' | 'at_risk' | 'critical' | null;
  assessmentAt: string | null;
  decision: ExecutiveDecisionEvidence;
  isClosed: boolean;
  isWon: boolean;
}

export interface ExecutiveRevenueSnapshot {
  dealId: string;
  snapshotDate: string;
  capturedAt: string;
  pipelineId: string | null;
  stageId: string | null;
  ownerId: string | null;
  teamId: string | null;
  regionCode: string | null;
  amount: number | null;
  amountInCompanyCurrency: number | null;
  currencyCode: string | null;
  closeDate: string | null;
  forecastCategoryRaw: string | null;
  readinessScore: number | null;
  readinessStatus: ExecutiveRevenueDeal['readinessStatus'];
  assessmentAt: string | null;
  decisionStatus: ExecutiveDecisionEvidence['status'];
  decisionAttentionScore: number | null;
  decisionConfidence: ExecutiveConfidence | null;
  decisionCoveragePercent: number | null;
  decisionGeneratedAt: string | null;
}

export interface RevenueAmountContext {
  value: number | null;
  basis: RevenueAmountBasis;
  currencyCode: string | null;
  label: string;
  cohortKey: string | null;
  comparable: boolean;
}

export interface RevenueAmountCohort {
  key: string;
  basis: Exclude<RevenueAmountBasis, 'unavailable'>;
  currencyCode: string | null;
  label: string;
  deals: number;
  dealsWithAmount: number;
  openAmount: number;
  periodAmount: number;
  overdueAmount: number;
  undatedAmount: number;
  periodPipelineCoveragePercent: number;
  categories: Array<{ category: ForecastCategory; label: string; deals: number; amount: number }>;
}

export interface RevenueMovementCohort {
  key: string;
  basis: Exclude<RevenueAmountBasis, 'unavailable'>;
  currencyCode: string | null;
  label: string;
  periodExitAmount: number;
  periodEntryAmount: number;
  closeDatePushAmount: number;
  closeDatePullInAmount: number;
}

export interface ExecutiveReason {
  code: string;
  label: string;
  severity: 'critical' | 'warning' | 'info';
  dimension: 'close_date' | 'forecast_category' | 'readiness' | 'deal_brief' | 'commercial';
}

export interface ExecutiveCandidate {
  kind: 'slippage_review' | 'pull_in_review';
  dealId: string;
  dealName: string;
  recordUrl: string;
  pipelineLabel: string | null;
  stageLabel: string | null;
  ownerId: string | null;
  priorityScore: number;
  readinessScore: number | null;
  readinessStatus: ExecutiveRevenueDeal['readinessStatus'];
  attentionScore: number | null;
  decisionStatus: ExecutiveDecisionEvidence['status'];
  evidenceConfidence: ExecutiveConfidence;
  currentCloseDate: string | null;
  previousCloseDate: string | null;
  closeDateDeltaDays: number | null;
  forecastCategory: ForecastCategory;
  previousForecastCategory: ForecastCategory;
  amount: { value: number | null; basis: RevenueAmountBasis; currencyCode: string | null; label: string; comparable: boolean };
  reasons: ExecutiveReason[];
}

export interface ConcentrationDimension {
  dimension: 'owner' | 'pipeline' | 'region';
  topEntityId: string | null;
  topEntityLabel: string;
  topSharePercent: number;
  hhi: number;
  status: 'concentrated' | 'watch' | 'diversified' | 'unavailable';
  entities: Array<{ id: string | null; label: string; deals: number; amount: number; sharePercent: number }>;
}

export interface ConcentrationCohort {
  key: string;
  basis: Exclude<RevenueAmountBasis, 'unavailable'>;
  currencyCode: string | null;
  label: string;
  totalAmount: number;
  dimensions: ConcentrationDimension[];
}

export interface ExecutiveRevenueResponse {
  generatedAt: string;
  methodology: 'deterministic_executive_revenue_view_v1';
  period: ExecutiveRevenuePeriod;
  source: {
    fetchedAt: string;
    maxDeals: number;
    loadedDeals: number;
    scopedOpenDeals: number;
    truncated: boolean;
    comparisonSnapshotDate: string | null;
  };
  summary: {
    totalOpenDeals: number;
    periodDeals: number;
    overdueCloseDeals: number;
    undatedDeals: number;
    recordedCommitDeals: number;
    recordedBestCaseDeals: number;
    actNowDeals: number;
    slippageReviewDeals: number;
    pullInReviewDeals: number;
  };
  coverage: {
    amountPercent: number;
    comparableAmountPercent: number;
    closeDatePercent: number;
    forecastCategoryPercent: number;
    ownerPercent: number;
    currentAssessmentPercent: number;
    currentDealBriefPercent: number;
    comparisonSnapshotPercent: number;
  };
  confidence: {
    level: ExecutiveConfidence;
    score: number;
    movement: MovementConfidence;
    explanation: string;
  };
  amountCohorts: RevenueAmountCohort[];
  movement: {
    status: MovementConfidence;
    comparisonDeals: number;
    closeDatePushedDeals: number;
    closeDatePulledInDeals: number;
    closeDateAddedDeals: number;
    closeDateRemovedDeals: number;
    stageChangedDeals: number;
    amountIncreasedDeals: number;
    amountDecreasedDeals: number;
    forecastUpgradedDeals: number;
    forecastDowngradedDeals: number;
    periodExitDeals: number;
    periodEntryDeals: number;
    amountCohorts: RevenueMovementCohort[];
  };
  concentration: ConcentrationCohort[];
  slippageReviewCandidates: ExecutiveCandidate[];
  pullInReviewCandidates: ExecutiveCandidate[];
  limitations: string[];
  semantics: {
    recordedForecastOnly: true;
    notWinProbability: true;
    notExpectedRevenue: true;
    notExpectedLoss: true;
    amountNeverCombinedAcrossCurrencies: true;
    pullInCandidateIsReviewPrompt: true;
    slippageCandidateIsReviewPrompt: true;
  };
}
