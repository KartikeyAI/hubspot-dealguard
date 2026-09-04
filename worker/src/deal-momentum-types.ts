import type { IssueSeverity } from './types.js';

export interface MomentumSignal {
  code: string;
  label: string;
  direction: 'positive' | 'negative' | 'neutral';
  severity: IssueSeverity;
  observedAt: string | null;
  detail: string;
}

export interface DecisionAction {
  code: string;
  label: string;
  action: string;
  priority: 'high' | 'medium' | 'low';
  rationale: string;
  owner: 'deal_owner' | 'manager';
  dueAt: string | null;
  evidenceCodes: string[];
}

export interface CloseDateReason {
  code: string;
  label: string;
  impact: number;
  evidence: string;
}

export interface DealMomentumIntelligence {
  decisionActions: DecisionAction[];
  momentum: {
    methodology: 'crm_property_history_signal';
    windowDays: number;
    score: number | null;
    band: 'strong' | 'watch' | 'stalled' | 'insufficient_data';
    summary: string;
    evidenceCoveragePercent: number;
    daysSinceMaterialChange: number | null;
    lastMaterialChangeAt: string | null;
    signals: MomentumSignal[];
    events: {
      stageAdvances: number;
      stageRegressions: number;
      pipelineChanges: number;
      closeDatePushes: number;
      closeDatePullIns: number;
      ownerChanges: number;
      amountChanges: number;
      nextStepChanges: number;
    };
    limitations: string;
  };
  closeDateCredibility: {
    methodology: 'deterministic_close_date_credibility';
    score: number | null;
    status: 'credible' | 'watch' | 'weak' | 'unavailable';
    confidence: 'high' | 'medium' | 'low';
    summary: string;
    currentCloseDate: string | null;
    daysToClose: number | null;
    closeDatePushes90d: number;
    closeDatePullIns90d: number;
    lastCloseDateChangeAt: string | null;
    lastPushAt: string | null;
    reasons: CloseDateReason[];
    notWinProbability: true;
  };
}
