export type RecommendationStatus = 'presented' | 'accepted' | 'completed' | 'dismissed' | 'expired' | 'superseded';
export type RecommendationTransition = 'accept' | 'complete' | 'dismiss';
export type RecommendationEventType = 'presented' | 'accepted' | 'completed' | 'dismissed' | 'expired' | 'superseded' | 'outcome_observed' | 'followup_requested';
export type ObservedProgress = 'improved' | 'mixed' | 'unchanged' | 'worsened' | 'insufficient_evidence';
export type EvaluationStatus = 'pending' | 'observed' | 'insufficient_evidence';

export interface RecommendationBaseline {
  assessmentAt: string;
  generatedAt: string;
  readinessScore: number | null;
  readinessStatus: 'ready' | 'at_risk' | 'critical' | null;
  pipelineId: string | null;
  stageId: string | null;
  stageLabel: string | null;
  ownerId: string | null;
  teamId: string | null;
  regionCode: string | null;
  closeDate: string | null;
  attentionScore: number | null;
  briefStatus: 'on_track' | 'watch' | 'intervention_required' | 'insufficient_evidence' | null;
  dimensions: Record<string, unknown>;
}

export interface RecommendationInstance {
  id: string;
  dealId: string;
  recommendationCode: string;
  label: string;
  action: string;
  dimension: string;
  priority: 'high' | 'medium' | 'low';
  owner: 'deal_owner' | 'manager';
  dueAt: string | null;
  rationale: string;
  evidenceCodes: string[];
  methodology: string;
  status: RecommendationStatus;
  terminalReason: string | null;
  presentedAt: string;
  lastPresentedAt: string;
  acceptedAt: string | null;
  completedAt: string | null;
  dismissedAt: string | null;
  expiredAt: string | null;
  supersededAt: string | null;
  dismissalReason: string | null;
  overdue: boolean;
  current: boolean;
  baseline: RecommendationBaseline;
  outcome: RecommendationOutcome | null;
}

export interface RecommendationOutcome {
  evaluationStatus: EvaluationStatus;
  observedProgress: ObservedProgress | null;
  observationAssessmentAt: string | null;
  observationGeneratedAt: string | null;
  readinessDelta: number | null;
  attentionDelta: number | null;
  stageChanged: boolean | null;
  closeDateDeltaDays: number | null;
  dimensionDeltas: Record<string, number>;
  evidenceNoLongerObservedCodes: string[];
  recommendationStillCurrent: boolean | null;
  positiveSignalCount: number;
  negativeSignalCount: number;
  explanation: string | null;
  causalAttribution: false;
  firstObservedAt: string | null;
  lastObservedAt: string | null;
}

export interface RecommendationObservationInput {
  recommendationCode: string;
  baseline: RecommendationBaseline;
  baselineEvidenceCodes: string[];
  current: {
    assessmentAt: string | null;
    generatedAt: string;
    readinessScore: number | null;
    readinessStatus: RecommendationBaseline['readinessStatus'];
    stageId: string | null;
    closeDate: string | null;
    attentionScore: number | null;
    briefStatus: RecommendationBaseline['briefStatus'];
    dimensions: Record<string, unknown>;
    currentRecommendationCode: string | null;
    observedEvidenceCodes: string[];
  };
}

export interface RecommendationOutcomeEvaluation {
  evaluationStatus: EvaluationStatus;
  observedProgress: ObservedProgress;
  readinessDelta: number | null;
  attentionDelta: number | null;
  stageChanged: boolean | null;
  closeDateDeltaDays: number | null;
  dimensionDeltas: Record<string, number>;
  evidenceNoLongerObservedCodes: string[];
  recommendationStillCurrent: boolean;
  positiveSignalCount: number;
  negativeSignalCount: number;
  comparableSignalCount: number;
  explanation: string;
  causalAttribution: false;
}

export interface RecommendationAnalyticsResponse {
  generatedAt: string;
  window: { days: number; start: string; end: string };
  summary: {
    presented: number;
    accepted: number;
    completed: number;
    dismissed: number;
    expired: number;
    superseded: number;
    overdueAccepted: number;
    acceptanceRatePercent: number;
    completionRatePercent: number;
    medianHoursToAccept: number | null;
    medianHoursToComplete: number | null;
  };
  observedOutcomes: {
    total: number;
    improved: number;
    mixed: number;
    unchanged: number;
    worsened: number;
    insufficientEvidence: number;
    improvedSharePercent: number;
  };
  byRecommendation: Array<{
    code: string;
    label: string;
    presented: number;
    accepted: number;
    completed: number;
    dismissed: number;
    expired: number;
    observed: number;
    improved: number;
  }>;
  recent: RecommendationInstance[];
  semantics: {
    observationalOnly: true;
    causalAttribution: false;
    completionDoesNotProveImpact: true;
    missingEvidenceDoesNotMeanFailure: true;
  };
}
